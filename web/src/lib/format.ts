/** Formatting helpers. Numbers are shown at the precision they were measured. */

export function clock(minute: number, second: number): string {
  return `${minute}'${String(second).padStart(2, '0')}`;
}

export function seconds(value: number): string {
  return value >= 10 ? `${value.toFixed(0)}s` : `${value.toFixed(1)}s`;
}

export function metres(value: number): string {
  return `${value >= 0 ? '' : '−'}${Math.abs(value).toFixed(0)}m`;
}

export function xg(value: number): string {
  return value.toFixed(2).replace(/^0/, '.');
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function integer(value: number): string {
  return value.toLocaleString('en-GB');
}

const OUTCOME_LABELS: Record<string, string> = {
  goal: 'Goal',
  shot_on_target: 'Shot on target',
  shot_off_target: 'Shot off target',
  lost_ball: 'Lost ball',
  out_of_play: 'Out of play',
  foul_won: 'Foul won',
  end_of_period: 'End of period',
};

export function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

const START_TYPE_LABELS: Record<string, string> = {
  kick_off: 'Kick-off',
  goal_kick: 'Goal kick',
  corner: 'Corner',
  free_kick: 'Free kick',
  throw_in: 'Throw-in',
  turnover_open_play: 'Turnover',
  regular: 'Restart',
};

export function startTypeLabel(startType: string): string {
  return START_TYPE_LABELS[startType] ?? startType;
}

/** Only shot outcomes get a coloured badge; everything else stays neutral. */
export function outcomeBadgeClass(outcome: string): string {
  return outcome === 'goal' || outcome === 'shot_on_target' || outcome === 'shot_off_target'
    ? `badge badge-${outcome}`
    : 'badge badge-neutral';
}

/** "Spain 2–1 England · Euro 2024 Final" → "Euro 2024 Final". */
export function matchStage(label: string): string {
  const cut = label.indexOf('·');
  return cut >= 0 ? label.slice(cut + 1).trim() : label;
}
