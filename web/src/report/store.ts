/**
 * Report persistence.
 *
 * There is still no state library (App.tsx explains why), but reports are
 * shared by the header, the result cards, the player and the report page, and
 * threading one more `useState` through all of them would be worse than a
 * 60-line store. This is that store: an immutable snapshot, a subscriber set,
 * and `useSyncExternalStore` on top.
 *
 * localStorage is treated as a place that can refuse to write. Every mutation
 * reports its outcome into the snapshot rather than throwing, because the one
 * thing an analyst must never see is a report that looks saved and is not.
 */
import { useSyncExternalStore } from 'react';
import {
  addPhase,
  copyReport,
  countPhases,
  createReport,
  hasPhase,
  MAX_PHASES_PER_REPORT,
  parseReport,
  removePhase,
  type Report,
} from './model';
import type { PhaseQuery } from '../dsl/schema';

export const STORAGE_KEY = 'halfspace.reports.v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StoreError {
  kind: 'quota' | 'unavailable' | 'corrupt';
  message: string;
}

export interface ReportsSnapshot {
  reports: Report[];
  activeId: string | null;
  /** Set when the last read or write did not fully succeed. */
  error: StoreError | null;
}

const EMPTY: ReportsSnapshot = { reports: [], activeId: null, error: null };

/**
 * Was this a quota failure? Browsers disagree on the name and Safari's private
 * mode throws a plain error, so the check is deliberately loose — but it only
 * ever changes the wording of a message, never whether one is shown.
 */
function isQuotaError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22
    );
  }
  return /quota|storage is full|exceeded/i.test(String((error as Error)?.message ?? error));
}

/** Read and validate. A corrupt entry is reported, never silently dropped. */
export function readState(storage: StorageLike | null): ReportsSnapshot {
  if (!storage) {
    return { ...EMPTY, error: { kind: 'unavailable', message: 'This browser has no localStorage, so reports last only until you close the tab.' } };
  }
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { ...EMPTY, error: { kind: 'unavailable', message: 'This browser blocked localStorage, so reports last only until you close the tab.' } };
  }
  if (!raw) return EMPTY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY, error: { kind: 'corrupt', message: 'Saved reports could not be read (the stored JSON is damaged). Nothing was deleted — new reports will be saved over it.' } };
  }

  const envelope = parsed as { version?: number; reports?: unknown[]; activeId?: unknown };
  const reports: Report[] = [];
  let dropped = 0;
  for (const candidate of Array.isArray(envelope?.reports) ? envelope.reports : []) {
    const result = parseReport(candidate);
    if (result.ok) reports.push(result.report);
    else dropped += 1;
  }
  const activeId =
    typeof envelope?.activeId === 'string' && reports.some((r) => r.id === envelope.activeId)
      ? envelope.activeId
      : (reports[0]?.id ?? null);

  return {
    reports,
    activeId,
    error: dropped
      ? {
          kind: 'corrupt',
          message: `${dropped} saved report${dropped === 1 ? '' : 's'} did not match the current format and ${dropped === 1 ? 'was' : 'were'} skipped.`,
        }
      : null,
  };
}

/** Write. Returns the error to surface, or null. */
export function writeState(
  storage: StorageLike | null,
  state: Pick<ReportsSnapshot, 'reports' | 'activeId'>,
): StoreError | null {
  if (!storage) {
    return { kind: 'unavailable', message: 'This browser has no localStorage, so reports last only until you close the tab.' };
  }
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, reports: state.reports, activeId: state.activeId }),
    );
    return null;
  } catch (error) {
    if (isQuotaError(error)) {
      return {
        kind: 'quota',
        message:
          'Browser storage is full, so this change was not saved. Copy the share link to keep the report, then delete a report to free space.',
      };
    }
    return {
      kind: 'unavailable',
      message: `Could not save reports: ${(error as Error)?.message ?? String(error)}`,
    };
  }
}

export class ReportStore {
  private storage: StorageLike | null;
  private snapshot: ReportsSnapshot;
  private listeners = new Set<() => void>();

  constructor(storage: StorageLike | null) {
    this.storage = storage;
    this.snapshot = readState(storage);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ReportsSnapshot => this.snapshot;

  private commit(next: Pick<ReportsSnapshot, 'reports' | 'activeId'>) {
    const error = writeState(this.storage, next);
    // The in-memory state moves even when the write failed: the analyst's edit
    // is real, it just is not durable, and the banner says so.
    this.snapshot = { ...next, error };
    for (const listener of this.listeners) listener();
  }

  /** Replace one report by id. */
  update(reportId: string, fn: (report: Report) => Report): void {
    const reports = this.snapshot.reports.map((r) => (r.id === reportId ? fn(r) : r));
    this.commit({ reports, activeId: this.snapshot.activeId });
  }

  create(title?: string): Report {
    const report = createReport(title);
    this.commit({ reports: [...this.snapshot.reports, report], activeId: report.id });
    return report;
  }

  remove(reportId: string): void {
    const reports = this.snapshot.reports.filter((r) => r.id !== reportId);
    const activeId = this.snapshot.activeId === reportId ? (reports[0]?.id ?? null) : this.snapshot.activeId;
    this.commit({ reports, activeId });
  }

  setActive(reportId: string): void {
    if (!this.snapshot.reports.some((r) => r.id === reportId)) return;
    this.commit({ reports: this.snapshot.reports, activeId: reportId });
  }

  /** The report a pin goes into, created on the spot the first time. */
  ensureActive(): Report {
    const active = this.active();
    return active ?? this.create();
  }

  active(): Report | null {
    const { reports, activeId } = this.snapshot;
    return reports.find((r) => r.id === activeId) ?? null;
  }

  /**
   * Toggle a phase in the active report, recording the query that found it.
   * Returns what happened so the caller can say "report is full" out loud
   * instead of leaving a button that silently does nothing.
   */
  togglePin(phaseId: string, query: PhaseQuery | null): 'added' | 'removed' | 'full' {
    const report = this.ensureActive();
    if (hasPhase(report, phaseId)) {
      this.update(report.id, (r) => removePhase(r, phaseId));
      return 'removed';
    }
    if (countPhases(report) >= MAX_PHASES_PER_REPORT) return 'full';
    this.update(report.id, (r) => addPhase(r, phaseId, query));
    return 'added';
  }

  /** Import a shared report as a new, owned copy. Returns its new id. */
  saveCopy(report: Report, title?: string): string {
    const copy = copyReport(report, title);
    this.commit({ reports: [...this.snapshot.reports, copy], activeId: copy.id });
    return copy.id;
  }

  dismissError(): void {
    if (!this.snapshot.error) return;
    this.snapshot = { ...this.snapshot, error: null };
    for (const listener of this.listeners) listener();
  }
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export const reportStore = new ReportStore(browserStorage());

export function useReports(): ReportsSnapshot {
  return useSyncExternalStore(reportStore.subscribe, reportStore.getSnapshot, reportStore.getSnapshot);
}
