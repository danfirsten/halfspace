/**
 * Sharing a report without a backend, and without pretending.
 *
 * There is no server, so the URL *is* the document. A report is squeezed into
 * a compact JSON shape, deflated, and base64url-encoded into the fragment:
 *
 *     #report=z:<deflate-raw, base64url>
 *
 * What travels is ids, queries and your prose — never a byte of StatsBomb data
 * (the licence forbids redistribution, CONTRACT §0) and never anything the
 * recipient's own copy of the site cannot resolve for itself. What that costs
 * is honesty about two things, both stated in the UI:
 *
 *   1. Your notes are in the link. Anyone with the link reads them, and the
 *      link may sit in someone's browser history or a proxy log.
 *   2. There is no access control and no revocation, because there is nothing
 *      to revoke — nothing was uploaded.
 *
 * The fragment is never sent to a server by the browser, which is the reason
 * this is the fragment and not a query string.
 *
 * `z:` is deflate-raw; `j:` is the plain-JSON fallback for an engine without
 * CompressionStream. Both decode, so a link made in one browser opens in
 * another.
 */
import { parseQuery, type PhaseQuery } from '../dsl/schema';
import { newId, parseReport, type Report, type ReportSection } from './model';

export const DEFLATE_PREFIX = 'z:';
export const PLAIN_PREFIX = 'j:';

/**
 * Where a shared URL stops being comfortable. Not a hard browser limit —
 * Chrome and Firefox take far more — but the point past which links break in
 * chat clients, email and QR codes. Over it the UI warns; it never truncates.
 */
export const SHARE_WARN_CHARS = 2000;

/** Keys are one letter because every one of them is paid for in URL length. */
interface CompactSection {
  h?: string;
  q?: PhaseQuery;
  p: string[];
  n?: string;
}

interface CompactReport {
  v: number;
  t: string;
  n?: string;
  s: CompactSection[];
}

export function toCompact(report: Report): CompactReport {
  const compact: CompactReport = {
    v: 1,
    t: report.title,
    s: report.sections.map((section) => {
      const out: CompactSection = { p: [...section.phase_ids] };
      if (section.heading?.trim()) out.h = section.heading;
      if (section.note?.trim()) out.n = section.note;
      if (section.query) out.q = section.query;
      return out;
    }),
  };
  if (report.notes) compact.n = report.notes;
  return compact;
}

/**
 * Rebuild a report from the compact form. Ids and timestamps are minted fresh:
 * they were never in the link, because two people editing "the same" report
 * from two links are not editing the same thing and the model should not imply
 * they are.
 */
export function fromCompact(compact: CompactReport): Report {
  const stamp = new Date().toISOString();
  const sections: ReportSection[] = (compact.s ?? []).map((s) => {
    const section: ReportSection = {
      id: newId('s'),
      query: null,
      phase_ids: Array.isArray(s.p) ? s.p.filter((id) => typeof id === 'string') : [],
    };
    if (s.h) section.heading = s.h;
    if (s.n) section.note = s.n;
    if (s.q) {
      // A query in a link is untrusted input like any other: it goes through
      // the same Zod schema the search bar does, and a bad one is dropped
      // rather than compiled.
      const parsed = parseQuery(s.q);
      if (parsed.ok) section.query = parsed.query;
    }
    return section;
  });
  return {
    id: newId('r'),
    title: typeof compact.t === 'string' ? compact.t : 'Shared report',
    notes: typeof compact.n === 'string' ? compact.n : '',
    sections,
    created_at: stamp,
    updated_at: stamp,
  };
}

// ------------------------------------------------------------- base64url ---

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Chunked so a long report never blows the argument limit of String.fromCharCode.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --------------------------------------------------------------- deflate ---

function hasCompression(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

async function pipe(bytes: Uint8Array, stream: TransformStream<Uint8Array, Uint8Array>) {
  const source = new Blob([bytes as BlobPart]).stream() as ReadableStream<Uint8Array>;
  const out = await new Response(source.pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream('deflate-raw') as TransformStream<Uint8Array, Uint8Array>);
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream('deflate-raw') as TransformStream<Uint8Array, Uint8Array>);
}

// ---------------------------------------------------------------- public ---

export interface EncodedShare {
  /** The fragment value, prefix included: `z:…` or `j:…`. */
  fragment: string;
  /** Characters in the whole URL the user will copy. */
  chars: number;
  /** True once the URL is long enough to break in the wild. */
  overCap: boolean;
  compressed: boolean;
}

/** Serialize a report into a fragment value. */
export async function encodeReport(report: Report, baseUrlLength = 0): Promise<EncodedShare> {
  const json = JSON.stringify(toCompact(report));
  const bytes = new TextEncoder().encode(json);
  let fragment: string;
  let compressed = false;
  if (hasCompression()) {
    try {
      fragment = DEFLATE_PREFIX + toBase64Url(await deflate(bytes));
      compressed = true;
    } catch {
      fragment = PLAIN_PREFIX + toBase64Url(bytes);
    }
  } else {
    fragment = PLAIN_PREFIX + toBase64Url(bytes);
  }
  const chars = baseUrlLength + fragment.length;
  return { fragment, chars, overCap: chars > SHARE_WARN_CHARS, compressed };
}

export type DecodedShare = { ok: true; report: Report } | { ok: false; error: string };

/** Parse a fragment value back into a report. Never throws. */
export async function decodeReport(fragment: string): Promise<DecodedShare> {
  const trimmed = (fragment ?? '').trim();
  if (!trimmed) return { ok: false, error: 'the link carries no report' };

  const compressed = trimmed.startsWith(DEFLATE_PREFIX);
  const plain = trimmed.startsWith(PLAIN_PREFIX);
  if (!compressed && !plain) {
    return { ok: false, error: `unknown share format (expected '${DEFLATE_PREFIX}' or '${PLAIN_PREFIX}')` };
  }
  const payload = trimmed.slice(2);
  if (!/^[A-Za-z0-9_-]*$/.test(payload)) {
    return { ok: false, error: 'the link is damaged (it contains characters this encoding never emits)' };
  }

  let json: string;
  try {
    const bytes = fromBase64Url(payload);
    const decoded = compressed ? await inflate(bytes) : bytes;
    json = new TextDecoder().decode(decoded);
  } catch {
    return { ok: false, error: 'the link is damaged and could not be decompressed' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'the link decoded to something that is not a report' };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as CompactReport).s)) {
    return { ok: false, error: 'the link decoded to something that is not a report' };
  }

  // Round-trip through the model's own schema so an imported report is exactly
  // as validated as one that was built here.
  const result = parseReport(fromCompact(parsed as CompactReport));
  return result.ok ? { ok: true, report: result.report } : { ok: false, error: result.error };
}

/** The URL to copy: everything before the hash, plus the report fragment. */
export function shareUrl(location: { origin: string; pathname: string; search: string }, fragment: string): string {
  return `${location.origin}${location.pathname}${location.search}#report=${fragment}`;
}
