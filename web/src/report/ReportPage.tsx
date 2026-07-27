/**
 * The report page — a scouting document, not a dashboard.
 *
 * It is a separate route (`#report=…`) rather than a panel because that is what
 * makes it shareable and printable: one URL, one page, nothing around it that
 * an analyst would have to explain away in a meeting. The whole module is
 * loaded lazily (App.tsx `React.lazy`), so nobody who never opens a report pays
 * for it on first paint.
 *
 * Three rules the page holds itself to:
 *
 *   1. Every number in the summary strip is queried from phases.parquet in the
 *      reader's browser when the page opens. Nothing is stored in the report,
 *      so nothing in it can go stale or be fabricated (CONTRACT §9).
 *   2. A pinned phase the index does not contain is shown as a missing card,
 *      never dropped.
 *   3. Printing produces the same document in ink: light-on-white, no
 *      animation, and every thumbnail frozen mid-trajectory.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeFilter, describeOrderBy } from '../dsl/compile';
import type { PhaseQuery } from '../dsl/schema';
import { asPhase, type HalfspaceData } from '../duck/data';
import type { PhaseRow } from '../duck/types';
import { PhasePlayer } from '../components/PhasePlayer';
import { MissingPhaseCard, PhaseCard } from '../components/ResultsGrid';
import { integer, seconds, xg as fmtXg } from '../lib/format';
import { readHashParam, writeHashParam } from '../lib/hash';
import { usePhaseDetail } from '../lib/usePhaseDetail';
import {
  allPhaseIds,
  countPhases,
  movePhase,
  removePhase,
  removeSection,
  sectionHeading,
  sectionQuery,
  setNotes,
  setTitle,
  updateSection,
  type Report,
  type ReportSection,
} from './model';
import { decodeReport, encodeReport, SHARE_WARN_CHARS, shareUrl } from './share';
import { compilePhaseLookup, compileSummary, type SummaryRow } from './summary';
import { reportStore, useReports } from './store';

const num = (value: unknown): number => (typeof value === 'bigint' ? Number(value) : Number(value ?? 0));

const isShareFragment = (target: string) => target.startsWith('z:') || target.startsWith('j:');

interface Props {
  data: HalfspaceData | null;
  /** The `#report=` value: a stored report id, or a `z:`/`j:` share payload. */
  target: string;
  /** Send a section's query back to the search view. */
  onRunQuery: (query: PhaseQuery) => void;
  /** Leave the report and rank the whole dataset against this phase. */
  onSimilar: (phaseId: string) => void;
  onBack: () => void;
}

export default function ReportPage({ data, target, onRunQuery, onSimilar, onBack }: Props) {
  const { reports, error: storeError } = useReports();
  const shared = isShareFragment(target);

  const [imported, setImported] = useState<Report | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // A shared link is decoded once, then held: it is read-only, so nothing can
  // change under it.
  useEffect(() => {
    if (!shared) {
      setImported(null);
      setImportError(null);
      return;
    }
    let cancelled = false;
    setImported(null);
    setImportError(null);
    decodeReport(target).then((result) => {
      if (cancelled) return;
      if (result.ok) setImported(result.report);
      else setImportError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [shared, target]);

  const stored = useMemo(() => reports.find((r) => r.id === target) ?? null, [reports, target]);
  const report = shared ? imported : stored;
  const readOnly = shared;

  const ids = useMemo(() => (report ? allPhaseIds(report) : []), [report]);
  const idKey = ids.join(',');

  // ---- the phases behind the pins, and the live summary ----------------------
  const [rows, setRows] = useState<Map<string, PhaseRow>>(new Map());
  const [summary, setSummary] = useState<SummaryRow | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!data || ids.length === 0) {
      setRows(new Map());
      setSummary(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setQueryError(null);
    Promise.all([
      data.db.query<Record<string, unknown>>(compilePhaseLookup(ids)),
      data.db.query<Record<string, unknown>>(compileSummary(ids)),
    ])
      .then(([phaseRows, summaryRows]) => {
        if (cancelled) return;
        const map = new Map<string, PhaseRow>();
        for (const row of phaseRows) map.set(String(row.phase_id), asPhase(row));
        setRows(map);
        const s = summaryRows[0];
        setSummary(
          s
            ? {
                n: num(s.n),
                goals: num(s.goals),
                shots: num(s.shots),
                matches: num(s.matches),
                teams: num(s.teams),
                avg_duration_s: s.avg_duration_s === null ? null : num(s.avg_duration_s),
                avg_xg: s.avg_xg === null ? null : num(s.avg_xg),
                n_with_xg: num(s.n_with_xg),
              }
            : null,
        );
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setQueryError(error instanceof Error ? error.message : String(error));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // idKey is the identity of the pin set; `ids` is a fresh array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, idKey]);

  // ---- the player, opened from inside the report -----------------------------
  const [openPhaseId, setOpenPhaseId] = useState<string | null>(() =>
    readHashParam(window.location.hash, 'phase'),
  );
  useEffect(() => {
    const read = () => setOpenPhaseId(readHashParam(window.location.hash, 'phase'));
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  const openPhase = useCallback((phaseId: string | null) => {
    const next = writeHashParam(window.location.hash, 'phase', phaseId);
    if (next) window.location.hash = next;
    else {
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      setOpenPhaseId(null);
    }
  }, []);

  const ordered = useMemo(() => ids.filter((id) => rows.has(id)), [ids, rows]);
  const openIndex = openPhaseId ? ordered.indexOf(openPhaseId) : -1;
  const detail = usePhaseDetail(data, openPhaseId, (id) => rows.get(id));

  // ---- printing --------------------------------------------------------------
  const printing = usePrinting();

  // ---- edits -----------------------------------------------------------------
  const mutate = useCallback(
    (fn: (r: Report) => Report) => {
      if (!report || readOnly) return;
      reportStore.update(report.id, fn);
    },
    [report, readOnly],
  );

  const [title, onTitle] = useDraft(report?.title ?? '', (value) =>
    mutate((r) => setTitle(r, value)),
  );
  const [notes, onNotes] = useDraft(report?.notes ?? '', (value) =>
    mutate((r) => setNotes(r, value)),
  );

  // ---- states before there is a document -------------------------------------
  if (shared && importError) {
    return (
      <main className="shell report">
        <div className="error-box">
          <strong>That shared report could not be opened.</strong> {importError}
        </div>
        <p className="report-empty-note">
          The whole report travels inside the link, so a link that was truncated in an email or a
          chat client cannot be recovered — ask whoever sent it for the full URL.
        </p>
        <button type="button" className="ghost-btn" onClick={onBack}>
          ← Back to search
        </button>
      </main>
    );
  }

  if (!report) {
    return (
      <main className="shell report">
        <div className="note-box" style={{ marginTop: 20 }}>
          {shared ? (
            <>
              <span className="spinner" /> opening the shared report…
            </>
          ) : (
            <>
              <strong>No such report on this device.</strong> Reports live in this browser's local
              storage, so a link to one of yours only opens on the machine you made it on. A{' '}
              <em>shared</em> link (<span className="num">#report=z:…</span>) carries the report
              itself and opens anywhere.
            </>
          )}
        </div>
        <button type="button" className="ghost-btn" style={{ marginTop: 14 }} onClick={onBack}>
          ← Back to search
        </button>
      </main>
    );
  }

  const phaseCount = countPhases(report);
  const found = summary?.n ?? 0;
  const missing = phaseCount - found;

  return (
    <main className="shell report">
      <Toolbar
        report={report}
        reports={reports}
        readOnly={readOnly}
        onBack={onBack}
        onOpenReport={(id) => {
          window.location.hash = writeHashParam(
            writeHashParam(window.location.hash, 'phase', null),
            'report',
            id,
          );
        }}
      />

      {storeError ? (
        <div className={storeError.kind === 'quota' ? 'error-box' : 'note-box'}>
          <strong>{storeError.kind === 'quota' ? 'Not saved.' : 'Storage note.'}</strong>{' '}
          {storeError.message}
        </div>
      ) : null}

      {readOnly ? (
        <div className="report-banner">
          <span>
            <strong>Shared report</strong> — read-only. Everything on this page was rebuilt from the
            link; the numbers below were queried against <em>your</em> copy of the index just now.
          </span>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              const id = reportStore.saveCopy(report, `${report.title} (copy)`);
              window.location.hash = writeHashParam(
                writeHashParam(window.location.hash, 'phase', null),
                'report',
                id,
              );
            }}
          >
            Save a copy
          </button>
        </div>
      ) : null}

      <article className="report-doc">
        <header className="report-head">
          {readOnly ? (
            <h1 className="report-title">{report.title}</h1>
          ) : (
            <input
              className="report-title report-title-input"
              value={title}
              aria-label="Report title"
              placeholder="Untitled report"
              onChange={(e) => onTitle(e.target.value)}
            />
          )}
          <p className="report-byline">
            Opposition scouting · <span className="num">{integer(phaseCount)}</span>{' '}
            {phaseCount === 1 ? 'phase' : 'phases'}
            {summary && summary.matches > 0 ? (
              <>
                {' '}
                from <span className="num">{integer(summary.matches)}</span>{' '}
                {summary.matches === 1 ? 'match' : 'matches'}
              </>
            ) : null}{' '}
            · {formatDate(report.updated_at)}
          </p>
        </header>

        <SummaryStrip summary={summary} loading={loading} error={queryError} missing={missing} />

        {readOnly ? (
          report.notes ? (
            <p className="report-notes-print">{report.notes}</p>
          ) : null
        ) : (
          <AutoTextarea
            className="report-notes"
            value={notes}
            onChange={onNotes}
            aria-label="Analyst notes"
            placeholder="Analyst notes — what the opposition does, what to look for, what to do about it. Plain text; it travels in the share link."
          />
        )}

        {report.sections.length === 0 ? (
          <EmptyReport onBack={onBack} />
        ) : (
          report.sections.map((section, i) => (
            <SectionBlock
              key={section.id}
              section={section}
              index={i}
              rows={rows}
              readOnly={readOnly}
              frozen={printing}
              onOpen={openPhase}
              onRunQuery={onRunQuery}
              onMutate={mutate}
            />
          ))
        )}

        <p className="report-provenance">
          Every figure above was computed in this browser from{' '}
          <span className="num">phases.parquet</span> when the page opened — the report stores phase
          ids and queries, never data. StatsBomb data is not redistributed by this link.
        </p>
      </article>

      {detail.phase ? (
        <PhasePlayer
          phase={detail.phase}
          events={detail.events}
          frames={detail.frames}
          loading={detail.loading}
          error={detail.error}
          onClose={() => openPhase(null)}
          onPrev={openIndex > 0 ? () => openPhase(ordered[openIndex - 1]) : null}
          onNext={
            openIndex >= 0 && openIndex < ordered.length - 1
              ? () => openPhase(ordered[openIndex + 1])
              : null
          }
          onSimilar={onSimilar}
          onPin={readOnly ? undefined : (id) => mutate((r) => removePhase(r, id))}
          pinned
        />
      ) : null}

      {openPhaseId && detail.error && !detail.phase ? (
        <div className="error-box">
          <strong>That phase could not be opened.</strong> {detail.error}
        </div>
      ) : null}
    </main>
  );
}

// ----------------------------------------------------------------- toolbar ---

function Toolbar({
  report,
  reports,
  readOnly,
  onBack,
  onOpenReport,
}: {
  report: Report;
  reports: Report[];
  readOnly: boolean;
  onBack: () => void;
  onOpenReport: (id: string) => void;
}) {
  return (
    <div className="report-toolbar">
      <button type="button" className="ghost-btn" onClick={onBack}>
        ← Search
      </button>

      {!readOnly && reports.length > 1 ? (
        <select
          className="report-select"
          value={report.id}
          aria-label="Open a different report"
          onChange={(e) => onOpenReport(e.target.value)}
        >
          {reports.map((r) => (
            <option key={r.id} value={r.id}>
              {r.title || 'Untitled report'} ({countPhases(r)})
            </option>
          ))}
        </select>
      ) : null}

      {!readOnly ? (
        <button
          type="button"
          className="ghost-btn"
          onClick={() => onOpenReport(reportStore.create().id)}
        >
          New report
        </button>
      ) : null}

      <span className="grow" />

      <SharePanel report={report} />

      <button type="button" className="ghost-btn" onClick={() => window.print()}>
        Print / PDF
      </button>

      {!readOnly ? (
        <button
          type="button"
          className="ghost-btn danger"
          onClick={() => {
            reportStore.remove(report.id);
            onBack();
          }}
        >
          Delete
        </button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------- share ---

function SharePanel({ report }: { report: Report }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [chars, setChars] = useState(0);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'manual'>('idle');
  const [explain, setExplain] = useState(false);

  // Re-encode while the panel is open, so the size indicator tracks typing.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const id = setTimeout(() => {
      const base = `${window.location.origin}${window.location.pathname}${window.location.search}#report=`;
      encodeReport(report, base.length).then((encoded) => {
        if (cancelled) return;
        setUrl(shareUrl(window.location, encoded.fragment));
        setChars(encoded.chars);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [open, report]);

  const over = chars > SHARE_WARN_CHARS;

  return (
    <span className="report-share">
      <button
        type="button"
        className="ghost-btn"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setCopied('idle');
        }}
      >
        Share link
      </button>

      {open ? (
        <div className="report-share-pop">
          <div className="report-share-row">
            <input
              readOnly
              className="report-share-url"
              value={url}
              aria-label="Shareable report URL"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="mini-btn"
              disabled={!url}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  setCopied('ok');
                } catch {
                  setCopied('manual');
                }
              }}
            >
              {copied === 'ok' ? 'Copied' : 'Copy'}
            </button>
          </div>

          <div className={`report-share-size${over ? ' over' : ''}`}>
            <span className="num">{integer(chars)}</span> characters
            {over ? (
              <>
                {' '}
                — over the <span className="num">{integer(SHARE_WARN_CHARS)}</span> comfortable
                limit. It will still open, but chat clients and email may cut it. Shorten the notes
                or split the report.
              </>
            ) : (
              <>
                {' '}
                of a comfortable <span className="num">{integer(SHARE_WARN_CHARS)}</span>.
              </>
            )}
          </div>

          {copied === 'manual' ? (
            <div className="report-share-size">
              Clipboard access was refused — the URL is selected above, copy it by hand.
            </div>
          ) : null}

          <div className="info" style={{ display: 'block', marginTop: 8 }}>
            <button
              type="button"
              className="link-btn"
              aria-expanded={explain}
              onClick={() => setExplain((v) => !v)}
            >
              How this link works, and what it does not do
            </button>
            {explain ? (
              <span className="info-pop" role="tooltip" style={{ position: 'static', display: 'block', marginTop: 8 }}>
                <strong>There is no server.</strong>
                <div style={{ marginTop: 4 }}>
                  The whole report — title, notes, section headings, the queries and the phase ids —
                  is compressed into the part of the URL after the <span className="num">#</span>.
                  Browsers never send that to a host, so nothing is uploaded and nothing is stored
                  anywhere but in the link itself.
                </div>
                <div className="measured">
                  Consequences, plainly: <strong>your notes are in the link</strong>, so anyone who
                  gets it can read them, and it may sit in a browser history or a chat log. There is
                  no access control and nothing to revoke. Editing your copy does not change a link
                  you already sent. The recipient needs access to this deployed site, and sees the
                  phases as their copy of the index has them.
                </div>
                <div className="prov">
                  No StatsBomb data travels in the link — only ids and your own words.
                </div>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </span>
  );
}

// ----------------------------------------------------------------- summary ---

function SummaryStrip({
  summary,
  loading,
  error,
  missing,
}: {
  summary: SummaryRow | null;
  loading: boolean;
  error: string | null;
  missing: number;
}) {
  if (error) {
    return (
      <div className="error-box">
        <strong>The summary could not be computed.</strong> {error}
      </div>
    );
  }
  if (!summary || loading) {
    return (
      <div className="report-summary" aria-busy="true">
        {['Phases', 'Goals', 'Avg duration', 'Avg xG'].map((k) => (
          <div className="rstat" key={k}>
            <span className="k">{k}</span>
            <span className="v num">
              <span className="shimmer" style={{ display: 'inline-block', width: 34, height: 14, borderRadius: 3 }} />
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="report-summary">
        <div className="rstat">
          <span className="k">Phases</span>
          <span className="v num">{integer(summary.n)}</span>
        </div>
        <div className="rstat">
          <span className="k">Goals</span>
          <span className="v num">{integer(summary.goals)}</span>
        </div>
        <div className="rstat">
          <span className="k">Phases with a shot</span>
          <span className="v num">{integer(summary.shots)}</span>
        </div>
        <div className="rstat">
          <span className="k">Avg duration</span>
          <span className="v num">
            {summary.avg_duration_s === null ? '—' : seconds(summary.avg_duration_s)}
          </span>
        </div>
        <div className="rstat" title="Mean of the best shot's xG, over the phases that produced one">
          <span className="k">Avg xG (when a shot)</span>
          <span className="v num">{summary.avg_xg === null ? '—' : fmtXg(summary.avg_xg)}</span>
        </div>
        <div className="rstat">
          <span className="k">Teams</span>
          <span className="v num">{integer(summary.teams)}</span>
        </div>
      </div>
      <p className="report-summary-note">
        {summary.n_with_xg > 0 ? (
          <>
            Average xG is taken over the <span className="num">{summary.n_with_xg}</span>{' '}
            {summary.n_with_xg === 1 ? 'phase' : 'phases'} that produced a shot — including the
            others would average in their zeroes and describe the padding rather than the chances.
          </>
        ) : (
          <>None of these phases produced a shot, so there is no xG to average.</>
        )}
        {missing > 0 ? (
          <>
            {' '}
            <strong>{missing}</strong> pinned{' '}
            {missing === 1 ? 'phase is' : 'phases are'} not in this index and{' '}
            {missing === 1 ? 'is' : 'are'} excluded from every figure above.
          </>
        ) : null}
      </p>
    </>
  );
}

// ---------------------------------------------------------------- sections ---

function SectionBlock({
  section,
  index,
  rows,
  readOnly,
  frozen,
  onOpen,
  onRunQuery,
  onMutate,
}: {
  section: ReportSection;
  index: number;
  rows: Map<string, PhaseRow>;
  readOnly: boolean;
  frozen: boolean;
  onOpen: (phaseId: string) => void;
  onRunQuery: (query: PhaseQuery) => void;
  onMutate: (fn: (r: Report) => Report) => void;
}) {
  const [heading, onHeading] = useDraft(section.heading ?? '', (value) =>
    onMutate((r) => updateSection(r, section.id, { heading: value })),
  );
  const [note, onNote] = useDraft(section.note ?? '', (value) =>
    onMutate((r) => updateSection(r, section.id, { note: value })),
  );
  const query = sectionQuery(section);

  return (
    <section className="report-section">
      <div className="report-section-head">
        {readOnly ? (
          <h2 className="report-section-title">{sectionHeading(section, index)}</h2>
        ) : (
          <input
            className="report-section-title report-title-input"
            value={heading}
            aria-label={`Heading for section ${index + 1}`}
            placeholder={sectionHeading(section, index)}
            onChange={(e) => onHeading(e.target.value)}
          />
        )}
        <span className="grow" />
        {!readOnly ? (
          <button
            type="button"
            className="mini-btn"
            title="Remove this section and its phases from the report"
            onClick={() => onMutate((r) => removeSection(r, section.id))}
          >
            Remove section
          </button>
        ) : null}
      </div>

      {query ? (
        <div className="chip-row report-found-with">
          <span className="chip-label">Found with</span>
          {query.filters.map((filter, i) => (
            <span className="chip" key={`${filter.field}-${i}`}>
              {describeFilter(filter)}
            </span>
          ))}
          <span className="chip chip-order">{describeOrderBy(query.order_by)}</span>
          <button
            type="button"
            className="link-btn no-print"
            onClick={() => onRunQuery(query)}
            title="Run this query in the search view"
          >
            re-run
          </button>
        </div>
      ) : (
        <div className="chip-row report-found-with">
          <span className="chip-label">Pinned</span>
          <span className="chip-empty">without a query — added one phase at a time</span>
        </div>
      )}

      {readOnly ? (
        note ? (
          <p className="report-notes-print">{note}</p>
        ) : null
      ) : (
        <AutoTextarea
          className="report-notes report-section-note"
          value={note}
          onChange={onNote}
          aria-label={`Note for section ${index + 1}`}
          placeholder="Note on this group (optional)"
        />
      )}

      <div className="grid report-grid">
        {section.phase_ids.map((id, i) => {
          const row = rows.get(id);
          if (!row) {
            return (
              <MissingPhaseCard
                key={id}
                phaseId={id}
                onRemove={readOnly ? undefined : () => onMutate((r) => removePhase(r, id))}
              />
            );
          }
          const actions = readOnly
            ? []
            : [
                {
                  label: '↑',
                  title: 'Move earlier',
                  onClick: () => onMutate((r) => movePhase(r, section.id, i, i - 1)),
                },
                {
                  label: '↓',
                  title: 'Move later',
                  onClick: () => onMutate((r) => movePhase(r, section.id, i, i + 1)),
                },
                {
                  label: 'Unpin',
                  title: 'Remove this phase from the report',
                  onClick: () => onMutate((r) => removePhase(r, id)),
                },
              ];
          return (
            <PhaseCard
              key={id}
              row={row}
              rank={i + 1}
              frozen={frozen}
              onOpen={onOpen}
              actions={actions}
            />
          );
        })}
      </div>
    </section>
  );
}

function EmptyReport({ onBack }: { onBack: () => void }) {
  return (
    <div className="report-empty">
      <h2>Nothing pinned yet</h2>
      <p>
        Run a search, then press <strong>Pin</strong> on any result card — or <strong>p</strong> in
        the phase player. Whatever query found the phase is saved with it, so this page can show the
        reader what you asked for, not just what you kept.
      </p>
      <p className="report-empty-note">
        Pins from two different searches become two sections automatically. Nothing here is uploaded
        anywhere: reports live in this browser, and a share link carries the report inside the URL.
      </p>
      <button type="button" className="ghost-btn" onClick={onBack}>
        ← Back to search
      </button>
    </div>
  );
}

// ------------------------------------------------------------------- bits ---

/**
 * A text field that keeps typing local and commits to the store after a pause.
 * Writing to localStorage on every keystroke would be both wasteful and a good
 * way to hit the quota in the middle of a sentence.
 */
function useDraft(value: string, commit: (value: string) => void, delay = 350) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);

  useEffect(() => {
    if (!dirty.current) return;
    const id = setTimeout(() => {
      dirty.current = false;
      commitRef.current(draft);
    }, delay);
    return () => clearTimeout(id);
  }, [draft, delay]);

  const onChange = useCallback((next: string) => {
    dirty.current = true;
    setDraft(next);
  }, []);

  return [draft, onChange] as const;
}

/** Grows with its content, so nothing is clipped when the page is printed. */
function AutoTextarea({
  value,
  onChange,
  className,
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  'aria-label': string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className={className}
      value={value}
      rows={2}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  );
}

/**
 * True while the page is being printed or print-previewed. Chrome fires
 * `beforeprint`/`afterprint`; a print *emulation* (and Safari) only flips the
 * media query, so both are watched. It exists so thumbnails can be frozen
 * mid-trajectory: an animation in a PDF is a blank pitch or a random frame.
 */
function usePrinting(): boolean {
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia?.('print');
    setPrinting(Boolean(mq?.matches));
    const onChange = (e: MediaQueryListEvent) => setPrinting(e.matches);
    mq?.addEventListener?.('change', onChange);
    const before = () => setPrinting(true);
    const after = () => setPrinting(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      mq?.removeEventListener?.('change', onChange);
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);

  return printing;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
