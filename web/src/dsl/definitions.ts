/**
 * Plain-English feature definitions, lifted from `docs/phase-definitions.md`.
 *
 * Every threshold quoted here is the one the ingest actually applied, and every
 * count was measured on the built dataset — nothing is rounded for effect. The
 * builder shows these in an info popover so an analyst can see what a checkbox
 * really means before trusting a result.
 */
import type { PhaseFieldName } from './schema';

export interface Definition {
  /** The rule, stated precisely enough to be wrong. */
  rule: string;
  /** How often it fires, measured on all 16,782 phases. */
  measured?: string;
  /** Where the threshold came from, when it is not ours. */
  provenance?: string;
}

export const DEFINITIONS: Partial<Record<PhaseFieldName, Definition>> = {
  high_press_regain: {
    rule: 'The phase began with an open-play turnover, the ball was won in the final third (x ≥ 80), and the winning team was demonstrably pressing — the ball-winning event carries StatsBomb’s counterpress flag, or that team registered a Pressure event in the 5 seconds before the phase started.',
    measured: '263 phases (1.6%). They produce a shot 30.4% of the time against a 13.8% baseline.',
    provenance: 'The 5-second window is StatsBomb’s own counterpress horizon.',
  },
  counterattack: {
    rule: 'Either StatsBomb tagged the possession “From Counter”, or the phase began with an open-play turnover in the team’s own half (x ≤ 60), advanced at least 18 yards upfield at 4.3 yards per second or more, and reached the final third.',
    measured: '753 phases (4.5%), shot rate 27.1%, mean xG 0.032 — roughly twice the baseline on both.',
    provenance:
      '4.3 yd/s is the 10th percentile of the moves StatsBomb itself labels From Counter; the 18-yard floor is their published number. Deliberately wider than their 0.69% tag — filter counterattack AND duration_s < 10 for their reading.',
  },
  switch_of_play: {
    rule: 'The team in possession played at least one pass that moved the ball 40 or more yards across the pitch (|Δy| ≥ 40), or that StatsBomb flagged as a switch.',
    measured: '2,637 phases (15.7%).',
    provenance:
      'A 40-yard cut-off reproduces StatsBomb’s own flag exactly: over 20,469 passes, no unflagged pass reached 40 yards and no flagged pass fell below it.',
  },
  reached_final_third: {
    rule: 'Any point of the ball path has x ≥ 80.',
    measured: 'True for 65.0% of phases.',
  },
  reached_box: {
    rule: 'Any point of the ball path lies inside the penalty area: x ≥ 102 and 18 ≤ y ≤ 62. Real box geometry, not the zone grid.',
    measured: 'True for 36.4% of phases.',
  },
  xg: {
    rule: 'The maximum StatsBomb xG among shots by the team in possession; 0 when the phase had no shot. Max rather than sum, so a phase is ranked by its best chance rather than by shot count.',
    measured: 'Mean xG by outcome: goal 0.275, shot on target 0.105, shot off target 0.072.',
  },
  outcome: {
    rule: 'How the phase ended, by precedence: goal (including an opponent’s own goal) → shot on target (saved, or saved onto the post) → shot off target (blocked, off target, post, wayward) → lost ball → out of play → foul won → end of period.',
    measured:
      'lost_ball 71.0%, foul_won 10.5%, shot_off_target 9.0%, out_of_play 4.1%, shot_on_target 3.3%, goal 1.5%, end_of_period 0.7%.',
    provenance:
      'A blocked shot and a shot off the post are not saves, so both sit in shot_off_target. Six more goals were scored by the team that did not own the chain and carry a separate goal_conceded flag instead.',
  },
  start_type: {
    rule: 'How the phase began. StatsBomb’s possession-level play_pattern first; otherwise the first pass’s own set-piece type; otherwise, did the ball actually change hands — if the previous chain in the period belonged to the other team it is an open-play turnover, if it belonged to the same team it is a same-team restart.',
    measured:
      'turnover_open_play 41.2%, throw_in 21.6%, free_kick 15.6%, goal_kick 9.3%, corner 5.8%, regular 3.5%, kick_off 2.9%.',
    provenance:
      'One possession increment in three is a same-team restart, so the increment alone is not a turnover signal — asking who owned the previous chain is the only way to tell them apart.',
  },
  start_zone: {
    rule: 'The 3 × 3 zone containing the first point of the ball path. Thirds by x (< 40, < 80, ≥ 80), channels by y (< 26.67 left, < 53.33 centre, else right), in the attacking team’s frame.',
    provenance: 'Boundaries belong to the upfield third and the higher-y channel, so the nine zones partition the pitch exactly.',
  },
  end_zone: {
    rule: 'The same 3 × 3 grid, applied to the last point of the ball path.',
  },
  duration_s: {
    rule: 'First event to the last *ball* event of the chain. Trailing administrative events — substitutions, bookings, medical stoppages — are excluded.',
    measured: 'Mean 21.2 s, median 13.6 s.',
    provenance:
      'Scotland v Hungary 2024 contains a possession whose last three events are a six-minute medical stoppage; measured naively it is a 393-second possession, and it is really about 2 seconds.',
  },
  n_passes: {
    rule: 'Passes attempted by the team in possession. Not every event in a chain is theirs — opponent pressures, blocks and tackles sit inside it too.',
    measured: 'Mean 6.2 per phase.',
  },
  n_events: {
    rule: 'Every event in the chain, both teams. This is the chain’s density, not the possessing team’s activity.',
    measured: 'Mean 22.6 per phase.',
  },
  n_players: {
    rule: 'Distinct players of the team in possession who touched the phase. A proxy for how many people were involved, not a lineup count.',
    measured: 'Median 4.',
  },
  progression_m: {
    rule: 'Net upfield ball progression: last ball-path x minus first, in metres. Signed — a move that goes backwards is negative.',
    measured: 'Mean 31.8 m.',
    provenance: 'StatsBomb’s axes are nominal yards; converted at 0.9144 m/yard on x-axis deltas only.',
  },
  direct_speed_m_s: {
    rule: 'Upfield progression divided by duration, in metres per second. 0 when the phase is shorter than 0.05 s.',
    measured: 'Mean 2.93 m/s.',
  },
  pressure_events: {
    rule: 'Pressure events by the *opponent* during the chain — StatsBomb records a Pressure against the team on the ball, so this counts how hard the phase was contested.',
  },
  frame_coverage: {
    rule: 'Fraction of the phase’s events that carry a 360 freeze frame.',
    measured: 'Dataset mean 0.824; 96.6% of phases have at least one frame.',
  },
  has_360: {
    rule: 'At least one event in the chain carries a 360 freeze frame.',
    measured: 'True for 96.6% of phases.',
  },
  competition: {
    rule: 'Which tournament the phase was played in.',
    measured: 'Euro 2020: 8,792 phases. Euro 2024: 7,990.',
  },
  team_name: {
    rule: 'The team in possession for the phase. The index carries no opponent column in the DSL, so “Spain against Germany” filters to Spain only.',
  },
  minute: { rule: 'Match minute at the phase’s start.' },
  period: { rule: '1 first half, 2 second half, 3 and 4 extra time. Penalty shootouts are excluded from the dataset entirely.' },
};

/** One line for the dataset caption; every number measured, none estimated. */
export const DATASET_NOTE =
  'A phase is one StatsBomb possession chain — every event sharing a (match, period, possession) key. Consecutive chains by the same team are kept separate, so a throw-in starts a new phase.';
