/**
 * Preset queries — real PhaseQuery instances, not shortcuts around the DSL.
 *
 * Each carries a `duration_s ≥ 2` floor. 477 phases in the dataset are shorter
 * than half a second: genuine one-event turnovers where the ball was won and
 * lost again immediately. They are real football, but a landing grid full of
 * them animates nothing, so the presets ask for passages of play.
 */
import { DSL_VERSION, LIMIT_DEFAULT, SHOT_OUTCOMES, type PhaseQuery } from './schema';

export interface Preset {
  id: string;
  label: string;
  /** Why an analyst would run this — shown on hover. */
  blurb: string;
  query: PhaseQuery;
}

const base = (
  filters: PhaseQuery['filters'],
  order_by: PhaseQuery['order_by'] = null,
): PhaseQuery => ({
  version: DSL_VERSION,
  filters,
  order_by,
  limit: LIMIT_DEFAULT,
});

export const PRESETS: Preset[] = [
  {
    id: 'high-turnover-shot',
    label: 'High turnovers → shot',
    blurb:
      'Won the ball in the final third with evidence of pressing, and got a shot away. 30% of high turnovers produce a shot against a 14% baseline.',
    query: base(
      [
        { field: 'high_press_regain', op: 'eq', value: true },
        { field: 'outcome', op: 'in', value: [...SHOT_OUTCOMES] },
        { field: 'duration_s', op: 'gte', value: 2 },
      ],
      { field: 'xg', dir: 'desc' },
    ),
  },
  {
    id: 'counter-box',
    label: 'Counterattacks reaching the box',
    blurb:
      'Fast, direct breaks from a turnover in the team’s own half that carried the ball into the penalty area.',
    query: base(
      [
        { field: 'counterattack', op: 'eq', value: true },
        { field: 'reached_box', op: 'eq', value: true },
        { field: 'duration_s', op: 'gte', value: 2 },
      ],
      { field: 'direct_speed_m_s', dir: 'desc' },
    ),
  },
  {
    id: 'goal-kick-final-third',
    label: 'Goal-kick build-ups to the final third',
    blurb: 'Playing out from the back: goal kicks whose possession reached the attacking third.',
    query: base(
      [
        { field: 'start_type', op: 'eq', value: 'goal_kick' },
        { field: 'reached_final_third', op: 'eq', value: true },
        { field: 'duration_s', op: 'gte', value: 2 },
      ],
      { field: 'n_passes', dir: 'desc' },
    ),
  },
  {
    id: 'switch-shot',
    label: 'Switches of play that ended in a shot',
    blurb:
      'Phases containing a 40+ yard lateral pass — StatsBomb’s own switch threshold — that finished with a shot.',
    query: base(
      [
        { field: 'switch_of_play', op: 'eq', value: true },
        { field: 'outcome', op: 'in', value: [...SHOT_OUTCOMES] },
        { field: 'duration_s', op: 'gte', value: 2 },
      ],
      { field: 'xg', dir: 'desc' },
    ),
  },
  {
    id: 'highest-xg',
    label: 'Highest-xG phases of the Euros',
    blurb: 'The best chances in both tournaments, ranked by the phase’s single best shot.',
    query: base(
      [
        { field: 'xg', op: 'gte', value: 0.1 },
        { field: 'duration_s', op: 'gte', value: 2 },
      ],
      { field: 'xg', dir: 'desc' },
    ),
  },
];

export const DEFAULT_PRESET = PRESETS[0];
