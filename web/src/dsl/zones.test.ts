import { describe, expect, it } from 'vitest';
import { channelOf, thirdOf, zoneOf, zoneRect, zonesInChannel, zonesInThird, splitZone } from './zones';
import { ZONES } from './schema';

describe('zone helper', () => {
  it('cuts thirds at x = 40 and x = 80, boundaries belonging upfield', () => {
    expect(thirdOf(0)).toBe('def_third');
    expect(thirdOf(39.99)).toBe('def_third');
    expect(thirdOf(40)).toBe('mid_third');
    expect(thirdOf(79.99)).toBe('mid_third');
    expect(thirdOf(80)).toBe('final_third');
    expect(thirdOf(120)).toBe('final_third');
  });

  it('cuts channels at y = 26.67 and y = 53.33, boundaries belonging to the higher y', () => {
    expect(channelOf(0)).toBe('left');
    expect(channelOf(80 / 3 - 0.01)).toBe('left');
    expect(channelOf(80 / 3)).toBe('centre');
    expect(channelOf(160 / 3 - 0.01)).toBe('centre');
    expect(channelOf(160 / 3)).toBe('right');
    expect(channelOf(80)).toBe('right');
  });

  it('agrees with the ingest on real phase endpoints', () => {
    // Ronaldo's goal against Germany: the chain starts at (30.5, 63.8) and the
    // shot leaves from deep in the box. Both are asserted in phases.parquet.
    expect(zoneOf(30.5, 63.8)).toBe('def_third_right');
    expect(zoneOf(115.9, 43.0)).toBe('final_third_centre');
  });

  it('partitions the whole pitch with no gaps and no overlaps', () => {
    const seen = new Set<string>();
    for (let x = 0; x <= 120; x += 0.5) {
      for (let y = 0; y <= 80; y += 0.5) {
        const zone = zoneOf(x, y);
        expect(ZONES).toContain(zone);
        seen.add(zone);
      }
    }
    expect(seen.size).toBe(9);
  });

  it('expands a third into its three channels and a channel into its three thirds', () => {
    expect(zonesInThird('final_third')).toEqual([
      'final_third_left',
      'final_third_centre',
      'final_third_right',
    ]);
    expect(zonesInChannel('centre')).toEqual([
      'def_third_centre',
      'mid_third_centre',
      'final_third_centre',
    ]);
  });

  it('splits a zone back into its parts', () => {
    expect(splitZone('mid_third_right')).toEqual(['mid_third', 'right']);
    expect(splitZone('def_third_centre')).toEqual(['def_third', 'centre']);
  });

  it('places zone rectangles so the nine tile the pitch exactly', () => {
    const rects = ZONES.map(zoneRect);
    expect(rects.reduce((a, r) => a + r.w * r.h, 0)).toBeCloseTo(120 * 80, 6);
    expect(zoneRect('def_third_left')).toEqual({ x: 0, y: 0, w: 40, h: 80 / 3 });
    expect(zoneRect('final_third_right')).toEqual({ x: 80, y: 160 / 3, w: 40, h: 80 / 3 });
  });
});
