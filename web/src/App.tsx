/**
 * Halfspace — the application shell.
 *
 * Order of operations matters here and is deliberate (CONTRACT §6):
 *   1. React renders the header, the preset chips and a skeleton grid of real
 *      pitches. That is first meaningful paint, and it happens before a single
 *      byte of DuckDB-WASM has been parsed.
 *   2. `HalfspaceData.boot()` fetches the WASM bundle, phases.parquet,
 *      matches.parquet and the manifest in parallel.
 *   3. The moment the index is registered, preset 1 runs automatically. The
 *      landing state is never empty.
 *
 * There is no state library. The whole app has one query, one result set and
 * one open phase; useState and a handful of effects express that honestly.
 * (Reports are the one exception — they are shared by four components at once
 * and live in a 60-line store; see report/store.ts.)
 *
 * Two routes, both in the fragment: `#phase=<id>` opens the player, and
 * `#report=<id|z:…>` swaps the search view for a report. The report module is
 * lazy: someone who never opens one never downloads it.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Insights } from './charts/Insights';
import { FilterBuilder } from './components/FilterBuilder';
import { FirstRunHint } from './components/FirstRunHint';
import { Footer } from './components/Footer';
import { PhasePlayer } from './components/PhasePlayer';
import { QueryChips } from './components/QueryChips';
import { ResultsGrid, SkeletonGrid } from './components/ResultsGrid';
import { parseText, SearchBar } from './components/SearchBar';
import { describeFilter } from './dsl/compile';
import { EMPTY_QUERY, parseQuery, type PhaseQuery } from './dsl/schema';
import { DEFAULT_PRESET, PRESETS } from './dsl/presets';
import { HalfspaceData, type SearchResult } from './duck/data';
import { dismissHint, shouldShowHint } from './lib/firstRun';
import { integer } from './lib/format';
import { removeFilter } from './lib/builderState';
import { readHashParam, writeHashParam } from './lib/hash';
import { usePhaseDetail } from './lib/usePhaseDetail';
import { countPhases, hasPhase, MAX_PHASES_PER_REPORT } from './report/model';
import { reportStore, useReports } from './report/store';

const ReportPage = lazy(() => import('./report/ReportPage'));

const API_CONFIGURED = Boolean(import.meta.env.VITE_API_URL);

interface SimilarPin {
  phaseId: string;
  label: string;
}

export default function App() {
  const [data, setData] = useState<HalfspaceData | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootMs, setBootMs] = useState<number | null>(null);

  const [query, setQuery] = useState<PhaseQuery>(DEFAULT_PRESET.query);
  const [activePreset, setActivePreset] = useState<string | null>(DEFAULT_PRESET.id);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(true);
  const [issues, setIssues] = useState<string[]>([]);
  const [dropped, setDropped] = useState<string[]>([]);
  const [parseNote, setParseNote] = useState<string | null>(null);
  const [parseSource, setParseSource] = useState<'api' | 'offline' | null>(null);
  const [similarPin, setSimilarPin] = useState<SimilarPin | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [pinNote, setPinNote] = useState<string | null>(null);

  // Read synchronously so the hint is in the first render and never shifts the
  // grid down after paint. See lib/firstRun.ts.
  const [hintOpen, setHintOpen] = useState(shouldShowHint);
  const [hintDone, setHintDone] = useState({ preset: false, opened: false, similar: false });
  const closeHint = useCallback(() => {
    dismissHint();
    setHintOpen(false);
  }, []);

  const [hash, setHash] = useState<string>(() =>
    typeof window === 'undefined' ? '' : window.location.hash,
  );

  // ---- boot ------------------------------------------------------------------
  useEffect(() => {
    const t0 = performance.now();
    let cancelled = false;
    HalfspaceData.boot()
      .then((loaded) => {
        if (cancelled) return;
        setBootMs(performance.now() - t0);
        setData(loaded);
      })
      .catch((error: unknown) => {
        if (!cancelled) setBootError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- run the query whenever it changes ------------------------------------
  useEffect(() => {
    if (!data || similarPin) return;
    const validated = parseQuery(query);
    if (!validated.ok) {
      setIssues(validated.issues.map((i) => `${i.path}: ${i.message}`));
      setSearching(false);
      return;
    }
    setIssues([]);
    setSearching(true);
    let cancelled = false;
    data
      .search(validated.query)
      .then((r) => {
        if (!cancelled) {
          setResult(r);
          setSearching(false);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setIssues([error instanceof Error ? error.message : String(error)]);
          setSearching(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [data, query, similarPin]);

  // ---- routing (#phase=… , #report=…) ----------------------------------------
  useEffect(() => {
    const read = () => setHash(window.location.hash);
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  const setHashParam = useCallback((key: string, value: string | null) => {
    const next = writeHashParam(window.location.hash, key, value);
    if (next) window.location.hash = next;
    else {
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      setHash('');
    }
  }, []);

  const reportTarget = readHashParam(hash, 'report');
  // While a report is open it owns the player, so that prev/next walks the
  // report's phases rather than a search the reader may never have run.
  const openPhaseId = reportTarget ? null : readHashParam(hash, 'phase');

  const openPhaseById = useCallback(
    (phaseId: string | null) => {
      if (phaseId) setHintDone((d) => (d.opened ? d : { ...d, opened: true }));
      setHashParam('phase', phaseId);
    },
    [setHashParam],
  );

  // ---- load the open phase's events and frames -------------------------------
  const detail = usePhaseDetail(data, openPhaseId, (id) =>
    // The row is usually already on screen; only fall back to a query for a
    // cold deep link.
    result?.rows.find((r) => r.phase_id === id),
  );
  const openPhase = detail.phase;

  // ---- actions ---------------------------------------------------------------
  const applyQuery = useCallback((next: PhaseQuery, presetId: string | null = null) => {
    setSimilarPin(null);
    setActivePreset(presetId);
    setQuery(next);
  }, []);

  const runPreset = useCallback(
    (id: string) => {
      const preset = PRESETS.find((p) => p.id === id);
      if (!preset) return;
      setParseNote(null);
      setDropped([]);
      setParseSource(null);
      setHintDone((d) => (d.preset ? d : { ...d, preset: true }));
      applyQuery(preset.query, preset.id);
    },
    [applyQuery],
  );

  const runText = useCallback(
    async (text: string) => {
      if (!data) return;
      setSearching(true);
      const outcome = await parseText(text, {
        teams: data.teams,
        competitions: data.competitions,
      });
      setParseNote(outcome.explanation);
      setDropped(outcome.dropped);
      setParseSource(outcome.source);
      applyQuery(outcome.query, null);
    },
    [data, applyQuery],
  );

  const findSimilar = useCallback(
    async (phaseId: string) => {
      if (!data) return;
      const row =
        result?.rows.find((r) => r.phase_id === phaseId) ?? (await data.phaseById(phaseId));
      if (!row) return;
      setSearching(true);
      setActivePreset(null);
      // The taught path ends here, so the hint has done its job and retires
      // itself — a reviewer who followed it never has to close it.
      setHintDone((d) => ({ ...d, similar: true }));
      closeHint();
      setSimilarPin({
        phaseId,
        label: `${row.team_name} v ${row.opponent_name}, ${row.minute}'`,
      });
      openPhaseById(null);
      try {
        setResult(await data.similarTo(phaseId, 24));
      } catch (error) {
        setIssues([error instanceof Error ? error.message : String(error)]);
      } finally {
        setSearching(false);
      }
    },
    [data, result, openPhaseById, closeHint],
  );

  const clearSimilar = useCallback(() => {
    setSimilarPin(null);
    // The query state is untouched, so clearing the pin simply re-runs it.
    setQuery((q) => ({ ...q }));
  }, []);

  // ---- reports ---------------------------------------------------------------
  const { reports, activeId } = useReports();
  const activeReport = useMemo(
    () => reports.find((r) => r.id === activeId) ?? null,
    [reports, activeId],
  );
  const pinnedCount = activeReport ? countPhases(activeReport) : 0;

  const isPinned = useCallback(
    (phaseId: string) => (activeReport ? hasPhase(activeReport, phaseId) : false),
    [activeReport],
  );

  const togglePin = useCallback(
    (phaseId: string) => {
      // A similarity ranking was not produced by the filter query, so recording
      // that query with the phase would be a lie — the section is pinned
      // without one instead. Same reasoning as the chips (QueryChips.tsx).
      const outcome = reportStore.togglePin(phaseId, similarPin ? null : query);
      setPinNote(
        outcome === 'full'
          ? `This report already holds ${MAX_PHASES_PER_REPORT} phases — the most a shareable URL and a printed document can carry. Start a second report.`
          : null,
      );
    },
    [query, similarPin],
  );

  const openReport = useCallback(() => {
    setHashParam('report', reportStore.ensureActive().id);
  }, [setHashParam]);

  const backToSearch = useCallback(() => setHashParam('report', null), [setHashParam]);

  const runQueryFromReport = useCallback(
    (next: PhaseQuery) => {
      backToSearch();
      setParseNote(null);
      setDropped([]);
      applyQuery(next, null);
    },
    [backToSearch, applyQuery],
  );

  const similarFromReport = useCallback(
    (phaseId: string) => {
      backToSearch();
      void findSimilar(phaseId);
    },
    [backToSearch, findSimilar],
  );

  // ---- player navigation -----------------------------------------------------
  const rows = result?.rows ?? [];
  const openIndex = openPhaseId ? rows.findIndex((r) => r.phase_id === openPhaseId) : -1;
  const goTo = useCallback(
    (delta: number) => {
      const next = rows[openIndex + delta];
      if (next) openPhaseById(next.phase_id);
    },
    [rows, openIndex, openPhaseById],
  );

  /**
   * The filter to offer removing when nothing matched. The last one in the list
   * is the one the reader most recently added — through the builder, a chip or
   * a parse — so it is the honest guess, and the button names it rather than
   * claiming to know which predicate is "too narrow".
   */
  const lastFilter = useMemo(
    () =>
      query.filters.length
        ? { filter: query.filters[query.filters.length - 1], index: query.filters.length - 1 }
        : null,
    [query.filters],
  );

  const datasetLine = useMemo(() => {
    if (!data) return '16,782 phases · 102 matches · Euro 2020 + Euro 2024';
    const { phases, matches } = data.manifest.counts;
    return `${integer(phases)} phases · ${integer(matches)} matches · ${data.competitions.join(' + ')}`;
  }, [data]);

  const busy = !data || searching;

  return (
    <div className="app">
      <header className="header">
        <div className="shell header-inner">
          <div className="brand">
            <h1>
              Half<span className="mark">space</span>
            </h1>
            <span className="tag">phase search</span>
          </div>
          <SearchBar onSubmit={runText} busy={busy} offline={!API_CONFIGURED} />
          <span className="dataset-line">{datasetLine}</span>
          <button
            type="button"
            className="ghost-btn report-entry"
            aria-expanded={Boolean(reportTarget)}
            title={
              pinnedCount
                ? `Open the report — ${pinnedCount} phase${pinnedCount === 1 ? '' : 's'} pinned`
                : 'Start a report: pin phases from any search'
            }
            onClick={openReport}
          >
            Report
            <span className="pin-count num">{pinnedCount}</span>
          </button>
        </div>
      </header>

      {reportTarget ? (
        <Suspense
          fallback={
            <main className="shell">
              <div className="status-line" style={{ padding: '28px 0' }}>
                <span className="spinner" /> opening the report…
              </div>
            </main>
          }
        >
          <ReportPage
            data={data}
            target={reportTarget}
            onRunQuery={runQueryFromReport}
            onSimilar={similarFromReport}
            onBack={backToSearch}
          />
        </Suspense>
      ) : (
        <>
          <div className="controls">
            <div className="shell controls-inner">
              <div className="preset-row">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="preset"
                    aria-pressed={activePreset === preset.id}
                    title={preset.blurb}
                    onClick={() => runPreset(preset.id)}
                  >
                    {preset.label}
                  </button>
                ))}
                <span className="preset-sep" aria-hidden="true" />
                <button
                  type="button"
                  className="ghost-btn"
                  aria-expanded={builderOpen}
                  onClick={() => setBuilderOpen((v) => !v)}
                >
                  {builderOpen ? 'Hide filters' : 'Filters'}
                  {query.filters.length ? (
                    <span className="filter-count num">{query.filters.length}</span>
                  ) : null}
                </button>
              </div>

              <QueryChips
                query={query}
                onRemoveFilter={(i) => applyQuery(removeFilter(query, i), null)}
                onClearOrder={() => applyQuery({ ...query, order_by: null }, null)}
                similarTo={similarPin}
                onClearSimilar={clearSimilar}
                dropped={dropped}
              />

              {builderOpen && data ? (
                <FilterBuilder
                  query={query}
                  onChange={(next) => applyQuery(next, null)}
                  teams={data.teams}
                />
              ) : null}
            </div>
          </div>

          <main className="shell" style={{ flex: 1 }}>
            {hintOpen ? <FirstRunHint done={hintDone} onDismiss={closeHint} /> : null}

            {bootError ? (
              <div className="error-box">
                <strong>Could not load the phase index.</strong> {bootError}
              </div>
            ) : null}

            {issues.length ? (
              <div className="error-box">
                <strong>That query is not valid.</strong>
                <ul>
                  {issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* The dropped terms themselves are chips in the row above; what is
                left here is the one sentence that names which parser answered. */}
            {parseNote ? (
              <p className="parse-note">
                {parseSource === 'offline' ? (
                  <strong>Offline parser</strong>
                ) : (
                  <strong>Parsed by the API</strong>
                )}{' '}
                · {parseNote}
              </p>
            ) : null}

            <div className="results-head">
              <span className="results-count">
                {!data ? (
                  <span className="status-line">
                    <span className="spinner" /> Loading the phase index…
                  </span>
                ) : searching ? (
                  <span className="status-line">
                    <span className="spinner" /> Searching…
                  </span>
                ) : similarPin ? (
                  <>
                    <strong className="num">{rows.length}</strong> most similar phases
                  </>
                ) : (
                  <>
                    <strong className="num">{integer(result?.total ?? 0)}</strong>
                    <span>
                      phases match
                      {(result?.total ?? 0) > rows.length ? (
                        <>
                          {' '}
                          · showing the top <span className="num">{rows.length}</span>
                        </>
                      ) : null}
                    </span>
                  </>
                )}
              </span>
              {result && !searching ? (
                <span
                  className="results-ms num"
                  title="Wall time for the DuckDB query in your browser"
                >
                  {result.ms.toFixed(0)} ms
                </span>
              ) : null}
            </div>

            {!data && !bootError ? (
              <SkeletonGrid count={8} />
            ) : (
              <ResultsGrid
                rows={rows}
                loading={searching && rows.length === 0}
                onOpen={openPhaseById}
                onSimilar={findSimilar}
                pin={{ isPinned, onToggle: togglePin }}
                empty={{
                  lastFilter: lastFilter ? describeFilter(lastFilter.filter) : null,
                  onDropLast: () => {
                    if (lastFilter) applyQuery(removeFilter(query, lastFilter.index), null);
                  },
                  onClearAll: () => {
                    setParseNote(null);
                    setDropped([]);
                    applyQuery({ ...EMPTY_QUERY, limit: query.limit }, null);
                  },
                }}
              />
            )}
          </main>

          <Insights />
        </>
      )}

      {pinNote ? (
        <div className="shell">
          <div className="note-box">{pinNote}</div>
        </div>
      ) : null}

      <Footer
        lastQueryMs={result?.ms ?? null}
        bootMs={bootMs}
        datasetVersion={data?.manifest.dataset_version}
        builtAt={data?.manifest.built_at}
      />

      {openPhase ? (
        <PhasePlayer
          phase={openPhase}
          events={detail.events}
          frames={detail.frames}
          loading={detail.loading}
          error={detail.error}
          onClose={() => openPhaseById(null)}
          onPrev={openIndex > 0 ? () => goTo(-1) : null}
          onNext={openIndex >= 0 && openIndex < rows.length - 1 ? () => goTo(1) : null}
          onSimilar={findSimilar}
          onPin={togglePin}
          pinned={isPinned(openPhase.phase_id)}
        />
      ) : null}
    </div>
  );
}
