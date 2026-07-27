import { describe, expect, it } from 'vitest';
import {
  decodeReport,
  DEFLATE_PREFIX,
  encodeReport,
  fromBase64Url,
  fromCompact,
  PLAIN_PREFIX,
  SHARE_WARN_CHARS,
  shareUrl,
  toBase64Url,
  toCompact,
} from './share';
import { addPhase, countPhases, createReport, setNotes, setTitle, updateSection } from './model';
import { PRESETS } from '../dsl/presets';
import type { Report } from './model';

const QUERY_A = PRESETS[0].query;
const QUERY_B = PRESETS[3].query;

const id = (match: number, seq: number) => `${match}-${String(seq).padStart(4, '0')}`;

function sample(): Report {
  let report = createReport('Spain — build-up under pressure');
  report = setNotes(report, 'Press the left centre-back; they always come back inside.');
  for (let i = 1; i <= 4; i++) report = addPhase(report, id(3788764, i), QUERY_A);
  for (let i = 1; i <= 3; i++) report = addPhase(report, id(3930162, i), QUERY_B);
  report = updateSection(report, report.sections[0].id, {
    heading: 'Goal kicks',
    note: 'Two of these end in a turnover in their own third.',
  });
  return report;
}

/** What must survive a trip through a URL. Ids and timestamps deliberately do not. */
const essence = (report: Report) => ({
  title: report.title,
  notes: report.notes,
  sections: report.sections.map((s) => ({
    heading: s.heading,
    note: s.note,
    query: s.query,
    phase_ids: s.phase_ids,
  })),
});

describe('share serialization — round trip', () => {
  it('round-trips a real report exactly', async () => {
    const report = sample();
    const { fragment, compressed } = await encodeReport(report);
    expect(compressed).toBe(true);
    expect(fragment.startsWith(DEFLATE_PREFIX)).toBe(true);

    const decoded = await decodeReport(fragment);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(essence(decoded.report)).toEqual(essence(report));
    expect(countPhases(decoded.report)).toBe(countPhases(report));
  });

  it('mints new ids on import — a shared report is not the same object', async () => {
    const report = sample();
    const { fragment } = await encodeReport(report);
    const decoded = await decodeReport(fragment);
    if (!decoded.ok) throw new Error('expected a decode');
    expect(decoded.report.id).not.toBe(report.id);
    expect(decoded.report.sections[0].id).not.toBe(report.sections[0].id);
  });

  it('carries unicode notes through byte for byte', async () => {
    const prose = [
      'Álvaro Morata drops off — Küssen die Halbräume, 中场逼抢, «пресс», 🇪🇸 → 🇩🇪',
      'Second line\twith a tab and a "quote" and an emoji ⚽️🥅',
      'Ω≈ç√∫˜µ≤≥÷ — and a trailing space ',
    ].join('\n');
    let report = setNotes(createReport('Ünïcödé — отчёт ⚽'), prose);
    report = addPhase(report, id(3788764, 1), QUERY_A);
    report = updateSection(report, report.sections[0].id, { heading: '半空间 / halvrum', note: prose });

    const { fragment } = await encodeReport(report);
    const decoded = await decodeReport(fragment);
    if (!decoded.ok) throw new Error(decoded.error);
    expect(decoded.report.notes).toBe(prose);
    expect(decoded.report.title).toBe('Ünïcödé — отчёт ⚽');
    expect(decoded.report.sections[0].heading).toBe('半空间 / halvrum');
    expect(decoded.report.sections[0].note).toBe(prose);
  });

  it('round-trips an empty report', async () => {
    const report = createReport('');
    const { fragment } = await encodeReport(report);
    const decoded = await decodeReport(fragment);
    if (!decoded.ok) throw new Error(decoded.error);
    expect(decoded.report.sections).toEqual([]);
    expect(decoded.report.title).toBe('');
  });

  it('decodes the uncompressed fallback too, so links are portable', async () => {
    const report = sample();
    const json = JSON.stringify(toCompact(report));
    const fragment = PLAIN_PREFIX + toBase64Url(new TextEncoder().encode(json));
    const decoded = await decodeReport(fragment);
    if (!decoded.ok) throw new Error(decoded.error);
    expect(essence(decoded.report)).toEqual(essence(report));
  });

  it('emits a fragment that is URL-safe', async () => {
    const { fragment } = await encodeReport(sample());
    expect(fragment.slice(2)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fragment).not.toMatch(/[+/=]/);
    expect(encodeURIComponent(fragment.slice(2))).toBe(fragment.slice(2));
  });
});

describe('share serialization — size', () => {
  it('compresses well below the plain encoding for repetitive ids', async () => {
    let report = createReport('Long');
    for (let i = 1; i <= 60; i++) report = addPhase(report, id(3788764, i), QUERY_A);
    const compressedShare = await encodeReport(report);
    const plain = toBase64Url(new TextEncoder().encode(JSON.stringify(toCompact(report))));
    expect(compressedShare.fragment.length).toBeLessThan(plain.length * 0.6);
  });

  it('stays under the comfortable cap for a normal report', async () => {
    const share = await encodeReport(sample(), 'https://example.github.io/halfspace/#report='.length);
    expect(share.overCap).toBe(false);
    expect(share.chars).toBeLessThan(SHARE_WARN_CHARS);
  });

  it('flags a report whose notes have outgrown a URL', async () => {
    // Deflate would squeeze 9,000 identical characters to nothing, so the note
    // is incompressible prose — which is what real notes are closer to.
    let seed = 7;
    const alphabet = 'abcdefghijklmnopqrstuvwxyz ,.—ÅÖ中';
    let prose = '';
    for (let i = 0; i < 9000; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      prose += alphabet[seed % alphabet.length];
    }
    const report = setNotes(sample(), prose);
    const share = await encodeReport(report);
    expect(share.overCap).toBe(true);
    expect(share.chars).toBeGreaterThan(SHARE_WARN_CHARS);
    // Warned, never truncated: a silently shortened report is a wrong report.
    const decoded = await decodeReport(share.fragment);
    if (!decoded.ok) throw new Error(decoded.error);
    expect(decoded.report.notes).toBe(prose);
  });

  it('counts the base URL against the cap, because the user copies the whole thing', async () => {
    const report = sample();
    const bare = await encodeReport(report);
    const withBase = await encodeReport(report, 120);
    expect(withBase.chars - bare.chars).toBe(120);
  });

  it('builds the share URL from the current location', () => {
    expect(
      shareUrl({ origin: 'https://u.github.io', pathname: '/halfspace/', search: '' }, 'z:abc'),
    ).toBe('https://u.github.io/halfspace/#report=z:abc');
  });
});

describe('share serialization — hostile input', () => {
  it('never throws, whatever it is handed', async () => {
    const junk = [
      '',
      '   ',
      'z:',
      'j:',
      'zz:abc',
      'report',
      'z:!!!!',
      'z:====',
      'j:{}',
      'z:' + 'A'.repeat(200),
      'j:' + toBase64Url(new TextEncoder().encode('not json at all')),
      'j:' + toBase64Url(new TextEncoder().encode('[1,2,3]')),
      'j:' + toBase64Url(new TextEncoder().encode('{"v":1,"t":"x"}')),
      'z:\u0000\u0001',
      'z:' + '💥',
    ];
    for (const input of junk) {
      const result = await decodeReport(input);
      expect(result.ok, input).toBe(false);
      if (!result.ok) expect(typeof result.error).toBe('string');
    }
  });

  it('rejects a truncated link rather than showing half a report', async () => {
    const { fragment } = await encodeReport(sample());
    for (const cut of [0.25, 0.5, 0.75, 0.95]) {
      const truncated = fragment.slice(0, Math.floor(fragment.length * cut));
      const result = await decodeReport(truncated);
      expect(result.ok, `cut at ${cut}`).toBe(false);
    }
  });

  it('survives random fuzz of the payload', async () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let seed = 20240714;
    const rand = () => {
      // xorshift: the fuzz has to be reproducible when a case fails.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return Math.abs(seed) / 2 ** 31;
    };
    for (let i = 0; i < 250; i++) {
      const length = 1 + Math.floor(rand() * 80);
      let payload = '';
      for (let j = 0; j < length; j++) payload += alphabet[Math.floor(rand() * alphabet.length)];
      const prefix = i % 2 === 0 ? DEFLATE_PREFIX : PLAIN_PREFIX;
      const result = await decodeReport(prefix + payload);
      // Practically always a decode failure; the contract is only that it is a
      // *result*, never an exception and never a half-built report.
      if (result.ok) {
        expect(Array.isArray(result.report.sections)).toBe(true);
        expect(typeof result.report.title).toBe('string');
      } else {
        expect(result.error.length).toBeGreaterThan(0);
      }
    }
  });

  it('drops a section query that is not valid DSL, keeping the phases', () => {
    const report = fromCompact({
      v: 1,
      t: 'From a stranger',
      s: [
        {
          p: [id(3788764, 1)],
          // `q` here claims a column that does not exist in phases.parquet.
          q: { version: 1, filters: [{ field: 'wing_span', op: 'gte', value: 2 }], order_by: null, limit: 48 } as never,
        },
      ],
    });
    expect(report.sections[0].query).toBeNull();
    expect(report.sections[0].phase_ids).toEqual([id(3788764, 1)]);
  });

  it('ignores non-string phase ids in a hand-edited link', () => {
    const report = fromCompact({ v: 1, t: 'x', s: [{ p: ['ok', 7, null] as never }] });
    expect(report.sections[0].phase_ids).toEqual(['ok']);
  });
});

describe('base64url', () => {
  it('round-trips arbitrary bytes, including lengths that need padding', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 37 + length) % 256;
      expect([...fromBase64Url(toBase64Url(bytes))], `length ${length}`).toEqual([...bytes]);
    }
  });

  it('handles a payload larger than one fromCharCode chunk', () => {
    const bytes = new Uint8Array(70_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });
});

describe('compact form', () => {
  it('omits every empty field, because each one costs URL characters', () => {
    const report = addPhase(createReport('T'), id(1, 1), null);
    const compact = toCompact(report);
    expect(compact).toEqual({ v: 1, t: 'T', s: [{ p: [id(1, 1)] }] });
    expect('n' in compact).toBe(false);
    expect('q' in compact.s[0]).toBe(false);
    expect('h' in compact.s[0]).toBe(false);
  });

  it('keeps the title even when it is the default', () => {
    expect(toCompact(setTitle(createReport(), 'Untitled report')).t).toBe('Untitled report');
  });
});
