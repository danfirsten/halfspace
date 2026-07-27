/**
 * Pitch zones (CONTRACT §4, phase-definitions §3).
 *
 * The pitch is cut 3 × 3 in the attacking team's frame: thirds by x, channels
 * by y. Boundaries belong to the *upfield* third and the *higher-y* channel, so
 * the nine zones partition the pitch with no gaps and no overlaps — the same
 * rule the ingest used, restated here so the UI can answer "which zone did I
 * just click" without a round trip.
 */
import type { PhaseFieldName } from './schema';

export const THIRDS = ['def_third', 'mid_third', 'final_third'] as const;
export const CHANNELS = ['left', 'centre', 'right'] as const;

export type Third = (typeof THIRDS)[number];
export type Channel = (typeof CHANNELS)[number];
export type Zone = `${Third}_${Channel}`;

/** x < 40 defensive, 40 ≤ x < 80 middle, x ≥ 80 final. */
export function thirdOf(x: number): Third {
  if (x < 40) return 'def_third';
  if (x < 80) return 'mid_third';
  return 'final_third';
}

/** y < 26.67 left, 26.67 ≤ y < 53.33 centre, y ≥ 53.33 right. */
export function channelOf(y: number): Channel {
  if (y < 80 / 3) return 'left';
  if (y < 160 / 3) return 'centre';
  return 'right';
}

export function zoneOf(x: number, y: number): Zone {
  return `${thirdOf(x)}_${channelOf(y)}` as Zone;
}

export function zonesInThird(third: Third): Zone[] {
  return CHANNELS.map((c) => `${third}_${c}` as Zone);
}

export function zonesInChannel(channel: Channel): Zone[] {
  return THIRDS.map((t) => `${t}_${channel}` as Zone);
}

/** The rectangle a zone occupies, in StatsBomb 120 × 80 units. */
export function zoneRect(zone: Zone): { x: number; y: number; w: number; h: number } {
  const [third, channel] = splitZone(zone);
  const x = THIRDS.indexOf(third) * 40;
  const y = CHANNELS.indexOf(channel) * (80 / 3);
  return { x, y, w: 40, h: 80 / 3 };
}

export function splitZone(zone: Zone): [Third, Channel] {
  const cut = zone.lastIndexOf('_');
  return [zone.slice(0, cut) as Third, zone.slice(cut + 1) as Channel];
}

export const ZONE_FIELDS: PhaseFieldName[] = ['start_zone', 'end_zone'];
