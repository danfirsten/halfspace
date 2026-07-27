import { describe, expect, it } from 'vitest';
import { readHashParam, writeHashParam } from './hash';

describe('fragment parameters', () => {
  it('reads a single key, with or without the leading #', () => {
    expect(readHashParam('#phase=3788764-0034', 'phase')).toBe('3788764-0034');
    expect(readHashParam('phase=3788764-0034', 'phase')).toBe('3788764-0034');
    expect(readHashParam('', 'phase')).toBeNull();
    expect(readHashParam('#', 'phase')).toBeNull();
    expect(readHashParam('#report=abc', 'phase')).toBeNull();
  });

  it('reads one key out of several', () => {
    const hash = '#report=r123&phase=3788764-0034';
    expect(readHashParam(hash, 'report')).toBe('r123');
    expect(readHashParam(hash, 'phase')).toBe('3788764-0034');
  });

  it('keeps the other keys when one is written', () => {
    expect(writeHashParam('#report=r1', 'phase', '3788764-0034')).toBe(
      '#report=r1&phase=3788764-0034',
    );
    expect(writeHashParam('#report=r1&phase=a', 'phase', 'b')).toBe('#report=r1&phase=b');
    expect(writeHashParam('#report=r1&phase=a', 'phase', null)).toBe('#report=r1');
    expect(writeHashParam('#phase=a', 'phase', null)).toBe('');
  });

  it('leaves a share payload readable in the address bar', () => {
    const payload = 'z:eNqrVkrLz1eyUvJNLC5JLVKqBQAxRAQx';
    const hash = writeHashParam('', 'report', payload);
    expect(hash).toBe(`#report=${payload}`);
    expect(hash).not.toContain('%3A');
    expect(readHashParam(hash, 'report')).toBe(payload);
  });

  it('round-trips values that need escaping', () => {
    for (const value of ['a b', 'a&b', 'a=b', 'a#b', 'Ünïcödé ⚽', '100%']) {
      const hash = writeHashParam('#report=r1', 'phase', value);
      expect(readHashParam(hash, 'phase'), value).toBe(value);
      expect(readHashParam(hash, 'report'), value).toBe('r1');
    }
  });

  it('does not confuse a key with a prefix of another', () => {
    expect(readHashParam('#reporting=x', 'report')).toBeNull();
    expect(writeHashParam('#reporting=x', 'report', 'r1')).toBe('#reporting=x&report=r1');
  });

  it('returns a damaged escape as-is rather than throwing', () => {
    expect(readHashParam('#phase=%E0%A4%A', 'phase')).toBe('%E0%A4%A');
  });
});
