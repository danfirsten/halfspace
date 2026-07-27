import { describe, expect, it } from 'vitest';
import {
  addPhase,
  allPhaseIds,
  copyReport,
  countPhases,
  createReport,
  hasPhase,
  MAX_PHASES_PER_REPORT,
  movePhase,
  moveSection,
  parseReport,
  queryKey,
  removePhase,
  removeSection,
  sectionHeading,
  sectionQuery,
  setNotes,
  setTitle,
  updateSection,
  type Report,
} from './model';
import { readState, ReportStore, STORAGE_KEY, writeState, type StorageLike } from './store';
import { PRESETS } from '../dsl/presets';
import type { PhaseQuery } from '../dsl/schema';

const QUERY_A = PRESETS[0].query;
const QUERY_B = PRESETS[1].query;

const id = (n: number) => `3788764-${String(n).padStart(4, '0')}`;

class FakeStorage implements StorageLike {
  map = new Map<string, string>();
  /** Bytes this fake will accept before it throws like a full browser. */
  limit = Number.POSITIVE_INFINITY;
  writes = 0;

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes += 1;
    if (value.length > this.limit) {
      const error = new Error('The quota has been exceeded.');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

describe('report model — pinning', () => {
  it('starts empty and records the query a phase was found with', () => {
    let report = createReport('Spain — set pieces');
    expect(countPhases(report)).toBe(0);

    report = addPhase(report, id(1), QUERY_A);
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0].phase_ids).toEqual([id(1)]);
    expect(report.sections[0].query).toEqual(QUERY_A);
    expect(hasPhase(report, id(1))).toBe(true);
  });

  it('groups phases found with the same query into one section', () => {
    let report = createReport();
    report = addPhase(report, id(1), QUERY_A);
    report = addPhase(report, id(2), QUERY_A);
    report = addPhase(report, id(3), QUERY_A);
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0].phase_ids).toEqual([id(1), id(2), id(3)]);
  });

  it('opens a second section for a different query', () => {
    let report = createReport();
    report = addPhase(report, id(1), QUERY_A);
    report = addPhase(report, id(2), QUERY_B);
    expect(report.sections).toHaveLength(2);
    expect(report.sections.map((s) => s.phase_ids)).toEqual([[id(1)], [id(2)]]);
    expect(countPhases(report)).toBe(2);
  });

  it('keeps ad-hoc pins (no query) apart from searched ones', () => {
    let report = createReport();
    report = addPhase(report, id(1), QUERY_A);
    report = addPhase(report, id(2), null);
    report = addPhase(report, id(3), null);
    expect(report.sections).toHaveLength(2);
    expect(report.sections[1].query).toBeNull();
    expect(report.sections[1].phase_ids).toEqual([id(2), id(3)]);
  });

  it('treats filter order and limit as not part of a query’s identity', () => {
    const a: PhaseQuery = {
      version: 1,
      filters: [
        { field: 'counterattack', op: 'eq', value: true },
        { field: 'reached_box', op: 'eq', value: true },
      ],
      order_by: null,
      limit: 48,
    };
    const b: PhaseQuery = { ...a, filters: [...a.filters].reverse(), limit: 12 };
    expect(queryKey(a)).toBe(queryKey(b));

    let report = addPhase(createReport(), id(1), a);
    report = addPhase(report, id(2), b);
    expect(report.sections).toHaveLength(1);
  });

  it('treats a different sort as a different question', () => {
    const a: PhaseQuery = { version: 1, filters: [], order_by: { field: 'xg', dir: 'desc' }, limit: 48 };
    const b: PhaseQuery = { ...a, order_by: { field: 'xg', dir: 'asc' } };
    expect(queryKey(a)).not.toBe(queryKey(b));
  });

  it('is idempotent — pinning the same phase twice does nothing', () => {
    let report = addPhase(createReport(), id(1), QUERY_A);
    const before = report;
    report = addPhase(report, id(1), QUERY_B);
    expect(report).toBe(before);
    expect(countPhases(report)).toBe(1);
  });

  it('refuses to grow past the cap', () => {
    let report = createReport();
    for (let i = 0; i < MAX_PHASES_PER_REPORT + 5; i++) report = addPhase(report, id(i), QUERY_A);
    expect(countPhases(report)).toBe(MAX_PHASES_PER_REPORT);
  });

  it('removes a phase from wherever it is, and drops the section it emptied', () => {
    let report = createReport();
    report = addPhase(report, id(1), QUERY_A);
    report = addPhase(report, id(2), QUERY_B);
    report = removePhase(report, id(2));
    expect(report.sections).toHaveLength(1);
    expect(hasPhase(report, id(2))).toBe(false);

    const unchanged = removePhase(report, 'not-pinned');
    expect(unchanged).toBe(report);
  });
});

describe('report model — ordering and sections', () => {
  const threePhases = () => {
    let report = createReport();
    for (const n of [1, 2, 3]) report = addPhase(report, id(n), QUERY_A);
    return report;
  };

  it('reorders phases inside a section', () => {
    const report = threePhases();
    const sectionId = report.sections[0].id;
    expect(movePhase(report, sectionId, 2, 0).sections[0].phase_ids).toEqual([id(3), id(1), id(2)]);
    expect(movePhase(report, sectionId, 0, 1).sections[0].phase_ids).toEqual([id(2), id(1), id(3)]);
  });

  it('ignores out-of-range and no-op moves rather than corrupting the list', () => {
    const report = threePhases();
    const sectionId = report.sections[0].id;
    expect(movePhase(report, sectionId, 0, -1)).toBe(report);
    expect(movePhase(report, sectionId, 2, 3)).toBe(report);
    expect(movePhase(report, sectionId, 1, 1)).toBe(report);
    expect(movePhase(report, 'no-such-section', 0, 1)).toBe(report);
  });

  it('reorders and removes sections', () => {
    let report = createReport();
    report = addPhase(report, id(1), QUERY_A);
    report = addPhase(report, id(2), QUERY_B);
    const [first, second] = report.sections;

    const swapped = moveSection(report, 1, 0);
    expect(swapped.sections.map((s) => s.id)).toEqual([second.id, first.id]);

    const pruned = removeSection(report, first.id);
    expect(pruned.sections.map((s) => s.id)).toEqual([second.id]);
    expect(countPhases(pruned)).toBe(1);
    expect(removeSection(report, 'nope')).toBe(report);
  });

  it('edits headings, notes, title and prose without touching the pins', () => {
    let report = addPhase(createReport(), id(1), QUERY_A);
    const sectionId = report.sections[0].id;
    report = updateSection(report, sectionId, { heading: 'Corners, near post' });
    report = updateSection(report, sectionId, { note: 'Two runners, blocker on the keeper.' });
    report = setTitle(report, 'Germany — restarts');
    report = setNotes(report, 'Watch the second ball.');

    expect(sectionHeading(report.sections[0], 0)).toBe('Corners, near post');
    expect(report.sections[0].note).toBe('Two runners, blocker on the keeper.');
    expect(report.title).toBe('Germany — restarts');
    expect(report.notes).toBe('Watch the second ball.');
    expect(allPhaseIds(report)).toEqual([id(1)]);
  });

  it('falls back to naming the search when there is no heading', () => {
    const report = addPhase(createReport(), id(1), QUERY_A);
    expect(sectionHeading(report.sections[0], 0)).toBe('Search 1');
    expect(sectionHeading({ ...report.sections[0], heading: '   ' }, 2)).toBe('Search 3');
    expect(sectionHeading({ ...report.sections[0], query: null }, 1)).toBe('Section 2');
  });

  it('re-validates a stored query before it can be re-run', () => {
    const report = addPhase(createReport(), id(1), QUERY_A);
    expect(sectionQuery(report.sections[0])).toEqual(QUERY_A);
    // A query that got into storage from an older build, with a field that no
    // longer exists, must not reach the SQL compiler.
    const poisoned = {
      ...report.sections[0],
      query: { version: 1, filters: [{ field: 'nonexistent', op: 'eq', value: 1 }], order_by: null, limit: 48 },
    } as unknown as Report['sections'][number];
    expect(sectionQuery(poisoned)).toBeNull();
  });

  it('copies a report with fresh identity and identical content', () => {
    let report = addPhase(createReport('Original'), id(1), QUERY_A);
    report = addPhase(report, id(2), QUERY_B);
    const copy = copyReport(report, 'Original (copy)');

    expect(copy.id).not.toBe(report.id);
    expect(copy.sections.map((s) => s.id)).not.toEqual(report.sections.map((s) => s.id));
    expect(copy.title).toBe('Original (copy)');
    expect(copy.sections.map((s) => s.phase_ids)).toEqual(report.sections.map((s) => s.phase_ids));
    expect(copy.sections.map((s) => s.query)).toEqual(report.sections.map((s) => s.query));
    // Deep copy: editing the copy must not reach into the original.
    expect(copy.sections[0].phase_ids).not.toBe(report.sections[0].phase_ids);
  });
});

describe('report validation', () => {
  it('accepts a report it produced', () => {
    const report = addPhase(createReport(), id(1), QUERY_A);
    expect(parseReport(report)).toEqual({ ok: true, report });
  });

  it('rejects structurally wrong input with a path', () => {
    expect(parseReport(null).ok).toBe(false);
    expect(parseReport({}).ok).toBe(false);
    const bad = parseReport({ ...createReport(), sections: [{ id: 's1', phase_ids: 'nope', query: null }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/sections/);
  });

  it('rejects a section whose query is not valid DSL', () => {
    const report = createReport();
    const result = parseReport({
      ...report,
      sections: [
        {
          id: 's1',
          query: { version: 1, filters: [{ field: 'xg', op: 'gte', value: 'lots' }], order_by: null, limit: 48 },
          phase_ids: [id(1)],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });
});

describe('report store — persistence', () => {
  it('round-trips through storage', () => {
    const storage = new FakeStorage();
    const store = new ReportStore(storage);
    const report = store.create('Euro 2024 — Spain');
    store.update(report.id, (r) => addPhase(r, id(1), QUERY_A));

    const reloaded = new ReportStore(storage);
    expect(reloaded.getSnapshot().reports).toHaveLength(1);
    expect(reloaded.getSnapshot().activeId).toBe(report.id);
    expect(countPhases(reloaded.active()!)).toBe(1);
    expect(reloaded.getSnapshot().error).toBeNull();
  });

  it('creates the active report on the first pin', () => {
    const store = new ReportStore(new FakeStorage());
    expect(store.active()).toBeNull();
    expect(store.togglePin(id(1), QUERY_A)).toBe('added');
    expect(countPhases(store.active()!)).toBe(1);
    expect(store.togglePin(id(1), QUERY_A)).toBe('removed');
    expect(countPhases(store.active()!)).toBe(0);
    // Toggling off does not throw the report away — only its contents.
    expect(store.getSnapshot().reports).toHaveLength(1);
  });

  it('reports a full report instead of dropping the pin silently', () => {
    const store = new ReportStore(new FakeStorage());
    for (let i = 0; i < MAX_PHASES_PER_REPORT; i++) store.togglePin(id(i), QUERY_A);
    expect(store.togglePin(id(999), QUERY_A)).toBe('full');
    expect(countPhases(store.active()!)).toBe(MAX_PHASES_PER_REPORT);
  });

  it('notifies subscribers exactly once per mutation', () => {
    const store = new ReportStore(new FakeStorage());
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    const report = store.create();
    store.update(report.id, (r) => setTitle(r, 'x'));
    expect(calls).toBe(2);
    unsubscribe();
    store.update(report.id, (r) => setTitle(r, 'y'));
    expect(calls).toBe(2);
  });

  it('keeps snapshot identity stable between mutations (useSyncExternalStore)', () => {
    const store = new ReportStore(new FakeStorage());
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    store.create();
    expect(store.getSnapshot()).not.toBe(before);
  });

  it('switches and deletes reports', () => {
    const store = new ReportStore(new FakeStorage());
    const first = store.create('A');
    const second = store.create('B');
    expect(store.getSnapshot().activeId).toBe(second.id);
    store.setActive(first.id);
    expect(store.active()!.title).toBe('A');
    store.setActive('ghost');
    expect(store.active()!.title).toBe('A');
    store.remove(first.id);
    expect(store.getSnapshot().reports.map((r) => r.title)).toEqual(['B']);
    expect(store.getSnapshot().activeId).toBe(second.id);
  });

  it('saves an imported copy and makes it active', () => {
    const store = new ReportStore(new FakeStorage());
    const shared = addPhase(createReport('Shared'), id(1), QUERY_A);
    const newId = store.saveCopy(shared, 'Shared (copy)');
    expect(store.active()!.id).toBe(newId);
    expect(store.active()!.title).toBe('Shared (copy)');
    expect(newId).not.toBe(shared.id);
  });
});

describe('report store — storage that says no', () => {
  it('surfaces a quota failure and keeps the edit in memory', () => {
    const storage = new FakeStorage();
    storage.limit = 200;
    const store = new ReportStore(storage);
    store.create('A report with a title long enough to blow this tiny fake quota wide open');
    const snapshot = store.getSnapshot();

    expect(snapshot.error?.kind).toBe('quota');
    expect(snapshot.error?.message).toMatch(/storage is full/i);
    // The analyst's edit is still on screen — it just is not durable.
    expect(snapshot.reports).toHaveLength(1);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('survives having no storage at all', () => {
    const store = new ReportStore(null);
    expect(store.getSnapshot().error?.kind).toBe('unavailable');
    store.togglePin(id(1), QUERY_A);
    expect(countPhases(store.active()!)).toBe(1);
  });

  it('reports damaged JSON without deleting it', () => {
    const storage = new FakeStorage();
    storage.map.set(STORAGE_KEY, '{not json');
    const snapshot = readState(storage);
    expect(snapshot.error?.kind).toBe('corrupt');
    expect(snapshot.reports).toEqual([]);
    expect(storage.getItem(STORAGE_KEY)).toBe('{not json');
  });

  it('skips individual reports that no longer match the format', () => {
    const storage = new FakeStorage();
    const good = addPhase(createReport('Good'), id(1), QUERY_A);
    writeState(storage, { reports: [good, { id: 'x' } as unknown as Report], activeId: good.id });
    const snapshot = readState(storage);
    expect(snapshot.reports.map((r) => r.title)).toEqual(['Good']);
    expect(snapshot.error?.kind).toBe('corrupt');
    expect(snapshot.error?.message).toMatch(/1 saved report/);
  });

  it('falls back to the first report when the stored activeId is stale', () => {
    const storage = new FakeStorage();
    const report = createReport('Only');
    writeState(storage, { reports: [report], activeId: 'deleted-long-ago' });
    expect(readState(storage).activeId).toBe(report.id);
  });

  it('reads an empty store as empty, not as an error', () => {
    expect(readState(new FakeStorage())).toEqual({ reports: [], activeId: null, error: null });
  });
});
