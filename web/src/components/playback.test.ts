import { describe, expect, it } from 'vitest';
import { ballAt, ballKeyframes } from './PhasePlayer';
import type { PhaseEventRow } from '../duck/types';

/**
 * Fixture taken verbatim from `phase_events/3788764.parquet`, phase
 * `3788764-0034` — Portugal's turnover-to-Ronaldo goal against Germany, Euro
 * 2020. Ten events, one of them Germany's, timings as recorded.
 */
const event = (
  idx: number,
  t: number,
  type: string,
  x: number | null,
  y: number | null,
  endX: number | null = null,
  endY: number | null = null,
  side = 'in_possession',
): PhaseEventRow => ({
  phase_id: '3788764-0034',
  idx,
  event_uuid: `e${idx}`,
  t_offset_s: t,
  type_name: type,
  player_name: null,
  position_name: null,
  team_side: side,
  team_name: side === 'in_possession' ? 'Portugal' : 'Germany',
  x,
  y,
  end_x: endX,
  end_y: endY,
  outcome_name: null,
  under_pressure: null,
  counterpress: null,
  xg: null,
  has_frame: true,
});

const RONALDO: PhaseEventRow[] = [
  event(0, 0.0, 'Ball Recovery', 30.5, 63.8),
  event(1, 0.0, 'Carry', 30.5, 63.8, 77.7, 61.4),
  event(2, 6.55, 'Pass', 77.7, 61.4, 107.5, 33.8),
  event(3, 8.66, 'Ball Receipt*', 107.5, 33.8),
  event(4, 8.66, 'Carry', 107.5, 33.8, 112.4, 34.7),
  event(5, 9.038, 'Pressure', 104.5, 33.8, null, null, 'opponent'),
  event(6, 9.697, 'Pass', 112.4, 34.7, 116.8, 41.8),
  event(7, 10.36, 'Ball Receipt*', 116.8, 41.8),
  event(8, 10.574, 'Shot', 115.9, 43.0, 120.0, 42.1),
  event(9, 11.084, 'Goal Keeper', 114.3, 36.9, null, null, 'opponent'),
];

describe('ballKeyframes', () => {
  const keys = ballKeyframes(RONALDO);

  it('starts where the phase started', () => {
    expect(keys[0]).toMatchObject({ t: 0, x: 30.5, y: 63.8 });
  });

  it('excludes the opponent’s events — they say where a defender was, not the ball', () => {
    // Germany's pressure at (104.5, 33.8) and Neuer at (114.3, 36.9) must not
    // appear as ball positions.
    expect(keys.some((k) => k.x === 104.5)).toBe(false);
    expect(keys.some((k) => k.x === 114.3)).toBe(false);
  });

  it('excludes Pressure events even when the possession team logs one', () => {
    const withOwnPressure = [...RONALDO, event(10, 5, 'Pressure', 50, 50)];
    expect(ballKeyframes(withOwnPressure).some((k) => k.x === 50 && k.y === 50)).toBe(false);
  });

  it('lands a pass’s end location at the time of the next event, not instantly', () => {
    // The pass leaves at 6.55 s; the receipt is logged at 8.66 s. The ball is
    // in flight for 2.11 s and the animation has to show that.
    const arrival = keys.find((k) => k.x === 107.5 && k.y === 33.8);
    expect(arrival?.t).toBeCloseTo(8.66, 3);
  });

  it('collapses consecutive duplicate points', () => {
    for (let i = 1; i < keys.length; i++) {
      expect([keys[i].x, keys[i].y]).not.toEqual([keys[i - 1].x, keys[i - 1].y]);
    }
  });

  it('is monotonic in time', () => {
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i].t).toBeGreaterThanOrEqual(keys[i - 1].t);
    }
  });

  it('ends in the goal', () => {
    expect(keys[keys.length - 1]).toMatchObject({ x: 120, y: 42.1 });
  });

  it('handles an empty phase', () => {
    expect(ballKeyframes([])).toEqual([]);
  });
});

describe('ballAt', () => {
  const keys = ballKeyframes(RONALDO);

  it('clamps before the start and after the end', () => {
    expect(ballAt(keys, -5)).toMatchObject({ x: 30.5, y: 63.8 });
    expect(ballAt(keys, 999)).toMatchObject({ x: 120, y: 42.1 });
  });

  it('interpolates linearly between two keyframes', () => {
    // Halfway through the 2.11 s pass from (77.7, 61.4) to (107.5, 33.8).
    const midpoint = ballAt(keys, (6.55 + 8.66) / 2)!;
    expect(midpoint.x).toBeCloseTo((77.7 + 107.5) / 2, 2);
    expect(midpoint.y).toBeCloseTo((61.4 + 33.8) / 2, 2);
  });

  it('sits exactly on a keyframe at its own time', () => {
    expect(ballAt(keys, 6.55)).toMatchObject({ x: 77.7, y: 61.4 });
  });

  it('returns null when there is nothing to draw', () => {
    expect(ballAt([], 1)).toBeNull();
  });

  it('never divides by a zero interval', () => {
    const stacked = ballKeyframes([
      event(0, 1, 'Pass', 10, 10, 20, 20),
      event(1, 1, 'Ball Receipt*', 20, 20),
    ]);
    expect(Number.isFinite(ballAt(stacked, 1)!.x)).toBe(true);
  });
});
