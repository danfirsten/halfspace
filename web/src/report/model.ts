/**
 * The report model: pure data and pure transitions.
 *
 * A report is what an analyst hands to a coach — a title, some notes, and
 * sections of pinned phases. The one structural decision worth stating is that
 * a **section is a search**, not a folder: pinning from a result set records
 * the `PhaseQuery` that found the phases alongside them, so the page can say
 * "found with: <chips>" and the reader can re-run it. Phases pinned from two
 * different queries land in two different sections automatically; nobody has to
 * create one.
 *
 * Everything here is a pure function over plain JSON. Persistence lives in
 * `store.ts`, serialization in `share.ts`, and neither of them can change the
 * shape of a report without coming through this file.
 */
import { z } from 'zod';
import { parseQuery, phaseQuerySchema, type PhaseQuery } from '../dsl/schema';

export const REPORT_VERSION = 1;

/** Reports are documents, not databases: a cap keeps localStorage honest. */
export const MAX_PHASES_PER_REPORT = 96;

export interface ReportSection {
  id: string;
  /** Analyst-supplied heading. Absent means "use the query, or a number". */
  heading?: string;
  /** The DSL that produced these phases, or null when pinned without one. */
  query: PhaseQuery | null;
  phase_ids: string[];
  note?: string;
}

export interface Report {
  id: string;
  title: string;
  notes: string;
  sections: ReportSection[];
  /** ISO strings. Only ever read for display and for ordering the picker. */
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------- schema ---

const sectionSchema = z
  .object({
    id: z.string().min(1),
    heading: z.string().optional(),
    query: phaseQuerySchema.nullish().transform((v) => v ?? null),
    phase_ids: z.array(z.string().min(1)).max(MAX_PHASES_PER_REPORT),
    note: z.string().optional(),
  })
  .strict();

export const reportSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    notes: z.string(),
    sections: z.array(sectionSchema),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export type ParsedReport = { ok: true; report: Report } | { ok: false; error: string };

/** Validate an untrusted report (localStorage, or a URL someone sent you). */
export function parseReport(input: unknown): ParsedReport {
  const result = reportSchema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    return {
      ok: false,
      error: first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid report',
    };
  }
  return { ok: true, report: result.data as Report };
}

// ------------------------------------------------------------------ ids ---

let counter = 0;

/** Short, sortable-enough, and unique within a session. Not a UUID on purpose. */
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

// ------------------------------------------------------------ transitions ---

const now = () => new Date().toISOString();

function touch(report: Report, sections: ReportSection[]): Report {
  return { ...report, sections, updated_at: now() };
}

export function createReport(title = 'Untitled report'): Report {
  const stamp = now();
  return {
    id: newId('r'),
    title,
    notes: '',
    sections: [],
    created_at: stamp,
    updated_at: stamp,
  };
}

/**
 * Identity of a search, for grouping. Filter order is not semantic (the
 * compiler ANDs them) so it is sorted away; `limit` is deliberately excluded —
 * how many results you happened to be looking at is not part of the question
 * you asked.
 */
export function queryKey(query: PhaseQuery | null): string {
  if (!query) return '';
  const filters = query.filters
    .map((f) => `${f.field}|${f.op}|${JSON.stringify(f.value)}`)
    .sort();
  const order = query.order_by ? `${query.order_by.field}|${query.order_by.dir}` : '';
  return JSON.stringify([filters, order]);
}

export function hasPhase(report: Report, phaseId: string): boolean {
  return report.sections.some((s) => s.phase_ids.includes(phaseId));
}

export function countPhases(report: Report): number {
  return allPhaseIds(report).length;
}

/** Every pinned id, in document order, de-duplicated. */
export function allPhaseIds(report: Report): string[] {
  const seen = new Set<string>();
  for (const section of report.sections) {
    for (const id of section.phase_ids) seen.add(id);
  }
  return [...seen];
}

/**
 * Pin one phase, recording the query that found it.
 *
 * Idempotent: a phase already in the report is left exactly where it is rather
 * than duplicated into a second section, because a scouting document that
 * shows the same clip twice reads as a mistake. The pin button is a toggle for
 * the same reason.
 */
export function addPhase(report: Report, phaseId: string, query: PhaseQuery | null): Report {
  if (hasPhase(report, phaseId)) return report;
  if (countPhases(report) >= MAX_PHASES_PER_REPORT) return report;

  const key = queryKey(query);
  const index = report.sections.findIndex((s) => queryKey(s.query) === key);
  if (index >= 0) {
    const sections = report.sections.map((s, i) =>
      i === index ? { ...s, phase_ids: [...s.phase_ids, phaseId] } : s,
    );
    return touch(report, sections);
  }
  const section: ReportSection = {
    id: newId('s'),
    query: query ? { ...query } : null,
    phase_ids: [phaseId],
  };
  return touch(report, [...report.sections, section]);
}

/** Unpin from wherever it is. A section emptied by this is removed with it. */
export function removePhase(report: Report, phaseId: string): Report {
  if (!hasPhase(report, phaseId)) return report;
  const sections = report.sections
    .map((s) => ({ ...s, phase_ids: s.phase_ids.filter((id) => id !== phaseId) }))
    .filter((s) => s.phase_ids.length > 0);
  return touch(report, sections);
}

function reorder<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length || to < 0 || to >= items.length) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function movePhase(
  report: Report,
  sectionId: string,
  from: number,
  to: number,
): Report {
  const index = report.sections.findIndex((s) => s.id === sectionId);
  if (index < 0) return report;
  const section = report.sections[index];
  const phase_ids = reorder(section.phase_ids, from, to);
  if (phase_ids === section.phase_ids) return report;
  return touch(
    report,
    report.sections.map((s, i) => (i === index ? { ...s, phase_ids } : s)),
  );
}

export function moveSection(report: Report, from: number, to: number): Report {
  const sections = reorder(report.sections, from, to);
  return sections === report.sections ? report : touch(report, sections);
}

export function removeSection(report: Report, sectionId: string): Report {
  const sections = report.sections.filter((s) => s.id !== sectionId);
  return sections.length === report.sections.length ? report : touch(report, sections);
}

export function updateSection(
  report: Report,
  sectionId: string,
  patch: Partial<Pick<ReportSection, 'heading' | 'note'>>,
): Report {
  const index = report.sections.findIndex((s) => s.id === sectionId);
  if (index < 0) return report;
  return touch(
    report,
    report.sections.map((s, i) => (i === index ? { ...s, ...patch } : s)),
  );
}

export function setTitle(report: Report, title: string): Report {
  return { ...report, title, updated_at: now() };
}

export function setNotes(report: Report, notes: string): Report {
  return { ...report, notes, updated_at: now() };
}

/**
 * A fresh copy with new ids — what "save a copy" of a shared report produces.
 * The originating queries survive the copy; the identity does not, so editing
 * the copy can never be confused with editing whatever the sender still has.
 */
export function copyReport(report: Report, title = report.title): Report {
  const stamp = now();
  return {
    id: newId('r'),
    title,
    notes: report.notes,
    sections: report.sections.map((s) => ({ ...s, id: newId('s'), phase_ids: [...s.phase_ids] })),
    created_at: stamp,
    updated_at: stamp,
  };
}

/**
 * A section's heading when the analyst has not written one. Sections are
 * searches, so the fallback names the search rather than inventing a title.
 */
export function sectionHeading(section: ReportSection, index: number): string {
  if (section.heading?.trim()) return section.heading.trim();
  if (!section.query || section.query.filters.length === 0) return `Section ${index + 1}`;
  return `Search ${index + 1}`;
}

/** Re-validate a section's stored query before it is re-run or compiled. */
export function sectionQuery(section: ReportSection): PhaseQuery | null {
  if (!section.query) return null;
  const parsed = parseQuery(section.query);
  return parsed.ok ? parsed.query : null;
}
