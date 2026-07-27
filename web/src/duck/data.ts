/**
 * The data layer: what gets fetched eagerly, what gets fetched on demand, and
 * how Arrow rows become plain JS.
 *
 * Eager payload (CONTRACT §6): app JS + phases.parquet + matches.parquet +
 * manifest.json. Nothing else. similarity.parquet loads the first time someone
 * asks for similar phases; the per-match event and frame shards load the first
 * time someone opens a phase in that match, and are cached for the session.
 */
import { compile, compileCount, PHASES_TABLE } from '../dsl/compile';
import type { PhaseQuery } from '../dsl/schema';
import { Halfspace } from './db';
import type { Manifest, MatchRow, PhaseEventRow, PhaseFrameRow, PhaseRow } from './types';

/**
 * `import.meta.env.BASE_URL` is './' in this build, so every data URL is
 * relative to the page. That is what lets the same dist/ serve from
 * https://<user>.github.io/halfspace/ and from a local file server unchanged.
 */
export function publicUrl(path: string): string {
  const base = import.meta.env.BASE_URL || './';
  return `${base.endsWith('/') ? base : `${base}/`}${path}`;
}

function dataUrl(path: string): string {
  return publicUrl(`data/${path}`);
}

async function fetchBytes(path: string): Promise<Uint8Array> {
  const res = await fetch(dataUrl(path));
  if (!res.ok) throw new Error(`failed to fetch ${path}: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Arrow list columns arrive as Vectors, not typed arrays. Normalize once here
 * so nothing downstream has to know which representation it got.
 */
function toFloat32(value: unknown): Float32Array {
  if (value instanceof Float32Array) return value;
  if (value instanceof Float64Array) return new Float32Array(value);
  if (Array.isArray(value)) return Float32Array.from(value as number[]);
  if (value && typeof (value as { toArray?: unknown }).toArray === 'function') {
    return toFloat32((value as { toArray: () => unknown }).toArray());
  }
  return new Float32Array(0);
}

function toUint8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (value && typeof (value as { toArray?: unknown }).toArray === 'function') {
    return toUint8((value as { toArray: () => unknown }).toArray());
  }
  return new Uint8Array(0);
}

/** DuckDB returns BIGINT as BigInt; the UI wants numbers. */
function toNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}

function asPhase(row: Record<string, unknown>): PhaseRow {
  return {
    ...(row as unknown as PhaseRow),
    match_id: toNumber(row.match_id),
    minute: toNumber(row.minute),
    second: toNumber(row.second),
    n_events: toNumber(row.n_events),
    n_passes: toNumber(row.n_passes),
    n_players: toNumber(row.n_players),
    n_shots: toNumber(row.n_shots),
    period: toNumber(row.period),
    pressure_events: toNumber(row.pressure_events),
    path_xy: toFloat32(row.path_xy),
  };
}

export interface SearchResult {
  rows: PhaseRow[];
  /** Total matching phases, which is usually larger than `rows.length`. */
  total: number;
  /** Wall time for the search, milliseconds. Shown in the footer. */
  ms: number;
  sql: string;
}

export class HalfspaceData {
  readonly db: Halfspace;
  readonly manifest: Manifest;
  readonly matches: MatchRow[];
  readonly teams: string[];
  readonly competitions: string[];

  private similarityLoaded = false;
  private eventCache = new Map<number, PhaseEventRow[]>();
  private frameCache = new Map<number, PhaseFrameRow[]>();
  private inflight = new Map<string, Promise<unknown>>();

  private constructor(
    db: Halfspace,
    manifest: Manifest,
    matches: MatchRow[],
    teams: string[],
    competitions: string[],
  ) {
    this.db = db;
    this.manifest = manifest;
    this.matches = matches;
    this.teams = teams;
    this.competitions = competitions;
  }

  /**
   * Boot: fetch the eager artifacts and DuckDB in parallel, then register.
   * The manifest and both parquet files start downloading before the WASM
   * module has finished instantiating, so the two costs overlap.
   */
  static async boot(): Promise<HalfspaceData> {
    const manifestPromise = fetch(dataUrl('manifest.json')).then(
      (r) => r.json() as Promise<Manifest>,
    );
    const phasesPromise = fetchBytes('phases.parquet');
    const matchesPromise = fetchBytes('matches.parquet');
    const dbPromise = Halfspace.open();

    const [db, manifest, phaseBytes, matchBytes] = await Promise.all([
      dbPromise,
      manifestPromise,
      phasesPromise,
      matchesPromise,
    ]);

    await db.registerParquet(PHASES_TABLE, phaseBytes);
    await db.registerParquet('matches', matchBytes);

    const matches = (await db.query<Record<string, unknown>>('SELECT * FROM matches')).map(
      (m) =>
        ({
          ...(m as unknown as MatchRow),
          match_id: toNumber(m.match_id),
          home_score: toNumber(m.home_score),
          away_score: toNumber(m.away_score),
        }) as MatchRow,
    );

    // The team vocabulary the heuristic parser matches against comes from the
    // data, not a hard-coded list — a new tournament changes it for free.
    const teams = (
      await db.query<{ team_name: string }>(
        `SELECT DISTINCT team_name FROM ${PHASES_TABLE} ORDER BY team_name`,
      )
    ).map((r) => r.team_name);
    const competitions = (
      await db.query<{ competition: string }>(
        `SELECT DISTINCT competition FROM ${PHASES_TABLE} ORDER BY competition`,
      )
    ).map((r) => r.competition);

    return new HalfspaceData(db, manifest, matches, teams, competitions);
  }

  /** Run a DSL query. One statement for the page, one for the total. */
  async search(query: PhaseQuery): Promise<SearchResult> {
    const sql = compile(query);
    const t0 = performance.now();
    const [rows, counts] = await Promise.all([
      this.db.query<Record<string, unknown>>(sql),
      this.db.query<{ n: number | bigint }>(compileCount(query)),
    ]);
    const ms = performance.now() - t0;
    return { rows: rows.map(asPhase), total: toNumber(counts[0]?.n ?? 0), ms, sql };
  }

  async phaseById(phaseId: string): Promise<PhaseRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      compile(
        { version: 1, filters: [{ field: 'phase_id', op: 'eq', value: phaseId }], order_by: null, limit: 1 },
      ),
    );
    return rows.length ? asPhase(rows[0]) : null;
  }

  /** De-duplicate concurrent loads of the same shard (grid + player race). */
  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = work().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /** Events for one phase, in real time order. Loads that match's shard once. */
  async eventsFor(phase: PhaseRow): Promise<PhaseEventRow[]> {
    const cached = this.eventCache.get(phase.match_id);
    const all =
      cached ??
      (await this.once(`events:${phase.match_id}`, async () => {
        const name = `events_${phase.match_id}`;
        await this.db.registerParquet(name, await fetchBytes(`phase_events/${phase.match_id}.parquet`));
        const rows = await this.db.query<Record<string, unknown>>(
          `SELECT * FROM ${name} ORDER BY phase_id, idx`,
        );
        const parsed = rows.map(
          (r) =>
            ({
              ...(r as unknown as PhaseEventRow),
              idx: toNumber(r.idx),
            }) as PhaseEventRow,
        );
        this.eventCache.set(phase.match_id, parsed);
        return parsed;
      }));
    return all.filter((e) => e.phase_id === phase.phase_id);
  }

  /** 360 frames for one phase, joined to events by event_uuid. */
  async framesFor(phase: PhaseRow): Promise<PhaseFrameRow[]> {
    const cached = this.frameCache.get(phase.match_id);
    const all =
      cached ??
      (await this.once(`frames:${phase.match_id}`, async () => {
        const name = `frames_${phase.match_id}`;
        await this.db.registerParquet(name, await fetchBytes(`phase_frames/${phase.match_id}.parquet`));
        const rows = await this.db.query<Record<string, unknown>>(
          `SELECT * FROM ${name} ORDER BY phase_id, idx`,
        );
        const parsed = rows.map(
          (r) =>
            ({
              ...(r as unknown as PhaseFrameRow),
              idx: toNumber(r.idx),
              n_players: toNumber(r.n_players),
              px: toFloat32(r.px),
              py: toFloat32(r.py),
              flags: toUint8(r.flags),
              visible_area: toFloat32(r.visible_area),
            }) as PhaseFrameRow,
        );
        this.frameCache.set(phase.match_id, parsed);
        return parsed;
      }));
    return all.filter((f) => f.phase_id === phase.phase_id);
  }

  /**
   * Nearest phases by cosine similarity (CONTRACT §7).
   *
   * The vectors are L2-normalized offline, so cosine is a plain dot product and
   * DuckDB's `list_dot_product` over 16,782 × 74 floats is a single scan. The
   * 2.66 MB file is fetched the first time this is called and never again.
   */
  async similarTo(phaseId: string, limit = 24): Promise<SearchResult> {
    if (!this.similarityLoaded) {
      await this.once('similarity', async () => {
        await this.db.registerParquet('similarity', await fetchBytes('similarity.parquet'));
        this.similarityLoaded = true;
      });
    }
    const id = phaseId.replace(/'/g, "''");
    const sql = `
WITH target AS (SELECT vec FROM similarity WHERE phase_id = '${id}')
SELECT p.*, list_dot_product(s.vec, (SELECT vec FROM target)) AS score
FROM similarity s
JOIN ${PHASES_TABLE} p USING (phase_id)
WHERE s.phase_id <> '${id}'
ORDER BY score DESC, p.phase_id ASC
LIMIT ${Math.trunc(limit)}`;
    const t0 = performance.now();
    const rows = await this.db.query<Record<string, unknown>>(sql);
    const ms = performance.now() - t0;
    return { rows: rows.map(asPhase), total: rows.length, ms, sql };
  }

  get lastTiming() {
    return this.db.lastTiming;
  }
}

export { dataUrl };
