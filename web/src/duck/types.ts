/**
 * Row shapes, mirroring the real parquet schemas (verified with DESCRIBE, never
 * guessed). All coordinates are StatsBomb 120 × 80 units in the phase's team's
 * attacking frame — the app never flips anything (CONTRACT §2 "Coordinates").
 */

export interface PhaseRow {
  phase_id: string;
  match_id: number;
  competition: string;
  match_label: string;
  team_name: string;
  opponent_name: string;
  period: number;
  minute: number;
  second: number;
  duration_s: number;
  n_events: number;
  n_passes: number;
  n_players: number;
  n_shots: number;
  start_type: string;
  outcome: string;
  start_zone: string;
  end_zone: string;
  progression_m: number;
  direct_speed_m_s: number;
  pressure_events: number;
  high_press_regain: boolean;
  counterattack: boolean;
  switch_of_play: boolean;
  reached_final_third: boolean;
  reached_box: boolean;
  xg: number;
  goal_conceded: boolean;
  has_360: boolean;
  frame_coverage: number;
  /** [x0,y0,…,x19,y19] — 20 points evenly spaced by ARC LENGTH, not by time. */
  path_xy: Float32Array;
}

export interface MatchRow {
  match_id: number;
  competition: string;
  match_date: string;
  stage: string;
  home_team_name: string;
  away_team_name: string;
  home_score: number;
  away_score: number;
  stadium: string;
  label: string;
}

/** One event of a phase, in real match time. The player animates off these. */
export interface PhaseEventRow {
  phase_id: string;
  idx: number;
  event_uuid: string;
  /** Seconds since the phase's first event — the only honest clock we have. */
  t_offset_s: number;
  type_name: string;
  player_name: string | null;
  position_name: string | null;
  /** 'in_possession' | 'opponent' */
  team_side: string;
  team_name: string;
  x: number | null;
  y: number | null;
  end_x: number | null;
  end_y: number | null;
  outcome_name: string | null;
  under_pressure: boolean | null;
  counterpress: boolean | null;
  xg: number | null;
  has_frame: boolean;
}

/**
 * One 360 freeze frame: parallel arrays, one entry per visible player.
 * `flags` is a bitmask — bit 0 possession team, bit 1 the actor, bit 2 keeper.
 */
export interface PhaseFrameRow {
  phase_id: string;
  idx: number;
  event_uuid: string;
  /** 'event' (94.3%) | 'mirrored' (2.5%) | 'unknown' (3.2%) — see below. */
  orientation: string;
  n_players: number;
  px: Float32Array;
  py: Float32Array;
  flags: Uint8Array;
  /** Flat [x0,y0,x1,y1,…] polygon of the broadcast camera's visible area. */
  visible_area: Float32Array;
}

export const FLAG_POSSESSION = 1;
export const FLAG_ACTOR = 2;
export const FLAG_KEEPER = 4;

/**
 * `unknown` orientation means the ingest could not tell which team a dot plays
 * for — the coordinates are fine, the colours are not. 3.2% of frames. The
 * player renders those neutral rather than asserting a side.
 */
export function orientationIsCertain(orientation: string): boolean {
  return orientation !== 'unknown';
}

export interface Manifest {
  dataset_version: string;
  built_at: string;
  attribution: string;
  counts: {
    matches: number;
    phases: number;
    phase_events: number;
    phase_frames: number;
  };
  frame_orientation: Record<string, number>;
  shards: { phase_events: string; phase_frames: string; match_ids: number[] };
}
