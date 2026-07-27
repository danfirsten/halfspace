/**
 * Offline natural-language → PhaseQuery.
 *
 * CONTRACT §8 lets the browser fall back to a deterministic keyword parser when
 * `api/` is unreachable. The GitHub Pages build has no API at all, so in
 * practice this *is* the natural-language path, and its keyword table mirrors
 * the few-shot examples in `api/prompt.py` constant for constant. If you change
 * a threshold here, change it there.
 *
 * Two rules make it honest rather than clever:
 *   1. Nothing is guessed. A term that cannot be expressed in the DSL — a
 *      player, an opponent, a date, a scoreline — is *dropped and reported*,
 *      never approximated with a filter that happens to be nearby.
 *   2. The result is rendered back as removable chips, identical to a preset or
 *      a builder query. The user always sees what was understood.
 */
import {
  LIMIT_DEFAULT,
  LIMIT_MAX,
  LIMIT_MIN,
  SHOT_OUTCOMES,
  DSL_VERSION,
  type Filter,
  type PhaseFieldName,
  type PhaseQuery,
} from './schema';
import { zonesInThird, type Third } from './zones';

export interface HeuristicResult {
  query: PhaseQuery;
  /** One sentence describing what was matched, for the "what it understood" line. */
  explanation: string;
  /** Terms recognised as un-expressible; surfaced to the user verbatim. */
  dropped: string[];
}

export interface HeuristicContext {
  /** Canonical team names, from matches.parquet. Matching is case-insensitive. */
  teams?: readonly string[];
  competitions?: readonly string[];
}

const DEFAULT_TEAMS: readonly string[] = [];

/** Lower-cased, punctuation-normalized, with typographic dashes flattened. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function has(text: string, ...needles: string[]): boolean {
  return needles.some((n) => text.includes(n));
}

/** Word-boundary test, so "corner" does not fire inside "cornerstone". */
function hasWord(text: string, ...words: string[]): boolean {
  return words.some((w) =>
    new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(text),
  );
}

/**
 * Terms the index simply cannot answer. Reported rather than silently ignored,
 * because a query that quietly loses half its meaning is worse than one that
 * says so: "against Germany" is not a filter, it is a missing column.
 */
const UNSUPPORTED: Array<{ test: RegExp; label: string }> = [
  { test: /\bagainst\b|\bvs\.?\b|\bversus\b|\bopponent/, label: 'opponent (the index filters the team in possession only)' },
  { test: /\b(19|20)\d{2}-\d{2}-\d{2}\b|\bjune\b|\bjuly\b|\bmatch ?day\b|\bthe final\b|\bsemi-?final\b|\bquarter-?final\b|\bgroup stage\b|\bround of 16\b/, label: 'date or round (not a DSL field)' },
  { test: /\b\d\s*[-–]\s*\d\b|\bscoreline\b|\bwinning\b|\blosing\b|\bdrawing\b|\bleading\b|\bbehind\b/, label: 'scoreline or game state (not a DSL field)' },
  { test: /\bassist|\bdribble|\bbeat (two|three|a|the) defender|\bheader|\bnutmeg|\bcross(es|ed)?\b|\btackle/, label: 'event-level action (phases are searched by their summary features)' },
  { test: /\bkeeper\b|\bgoalkeeper\b|\bmanager\b|\bcoach\b/, label: 'role (no player or role columns in the index)' },
];

/** A capitalised multi-word token that is not a team we know: probably a player. */
const PLAYER_HINT = /\b(?:by|from|for)\s+([A-Z][a-zà-ÿ'’-]+(?:\s+[A-Z][a-zà-ÿ'’-]+)+)/;

function detectDropped(raw: string, normalized: string, teams: readonly string[]): string[] {
  const dropped: string[] = [];
  for (const { test, label } of UNSUPPORTED) {
    if (test.test(normalized) && !dropped.includes(label)) dropped.push(label);
  }
  const player = PLAYER_HINT.exec(raw);
  if (player) {
    const candidate = player[1];
    const isTeam = teams.some((t) => t.toLowerCase() === candidate.toLowerCase());
    if (!isTeam) dropped.push(`"${candidate}" (no player names in the phase index)`);
  }
  return dropped;
}

/** First number after one of the given cue words, e.g. "under 15 seconds" → 15. */
function numberAfter(text: string, cues: string[]): number | null {
  for (const cue of cues) {
    const m = new RegExp(`${cue}\\s+(\\d+(?:\\.\\d+)?)`).exec(text);
    if (m) return Number(m[1]);
  }
  return null;
}

function push(filters: Filter[], field: PhaseFieldName, op: Filter['op'], value: Filter['value']) {
  // Later, more specific matches win: a query saying both "under 10 seconds"
  // and "long possession" should not produce two contradictory duration terms.
  const existing = filters.findIndex((f) => f.field === field && f.op === op);
  if (existing >= 0) filters[existing] = { field, op, value };
  else filters.push({ field, op, value });
}

export function parseHeuristic(input: string, context: HeuristicContext = {}): HeuristicResult {
  const raw = input.trim();
  const t = normalize(raw);
  const teams = context.teams ?? DEFAULT_TEAMS;
  const filters: Filter[] = [];
  const matched: string[] = [];
  let orderBy: PhaseQuery['order_by'] = null;
  let limit = LIMIT_DEFAULT;

  const note = (s: string) => {
    if (!matched.includes(s)) matched.push(s);
  };

  // ---- boolean feature flags -------------------------------------------------
  if (has(t, 'high turnover', 'high press', 'high-press', 'won it high', 'winning it high', 'high regain', 'press high')) {
    push(filters, 'high_press_regain', 'eq', true);
    note('high turnovers');
  }
  if (has(t, 'counter', 'on the break', 'transition')) {
    push(filters, 'counterattack', 'eq', true);
    note('counterattacks');
  }
  if (has(t, 'switch', 'changed the point of attack', 'change the point of attack')) {
    push(filters, 'switch_of_play', 'eq', true);
    note('switches of play');
  }

  // ---- how the phase ended ---------------------------------------------------
  if (hasWord(t, 'goal', 'goals') && !has(t, 'goal kick', 'goal-kick')) {
    push(filters, 'outcome', 'eq', 'goal');
    note('ended in a goal');
  } else if (has(t, 'led to a shot', 'leading to a shot', 'ended in a shot', 'ending in a shot', 'resulted in a shot', 'produced a shot', 'led to shots', 'shot')) {
    push(filters, 'outcome', 'in', [...SHOT_OUTCOMES]);
    note('ended in a shot');
  }

  // ---- territory -------------------------------------------------------------
  if (has(t, 'box', 'penalty area', 'penalty box', 'eighteen-yard', '18-yard')) {
    push(filters, 'reached_box', 'eq', true);
    note('reached the box');
  }
  if (has(t, 'final third', 'attacking third', 'last third')) {
    // "starting in the final third" is a start_zone constraint, handled below;
    // the reached_* flag is the right reading of a bare "into the final third".
    if (!/\b(start(ing|s|ed)?|beginning|begin|from)\b[^.]{0,20}final third/.test(t)) {
      push(filters, 'reached_final_third', 'eq', true);
      note('reached the final third');
    }
  }

  // ---- tempo and shape -------------------------------------------------------
  if (has(t, 'long possession', 'sustained', 'patient', 'long build-up', 'long buildup', 'long possessions')) {
    push(filters, 'duration_s', 'gte', 20);
    push(filters, 'n_passes', 'gte', 8);
    note('long, pass-heavy possessions (≥20s, ≥8 passes)');
  }
  if (has(t, 'quick', 'fast', 'direct', 'vertical', 'rapid')) {
    push(filters, 'direct_speed_m_s', 'gte', 3);
    note('direct phases (≥3 m/s upfield)');
  }

  const under = numberAfter(t, ['under', 'less than', 'shorter than', 'within', 'inside']);
  if (under !== null && has(t, 'second')) {
    push(filters, 'duration_s', 'lte', under);
    note(`under ${under}s`);
  }
  const over = numberAfter(t, ['over', 'more than', 'longer than', 'at least', 'above']);
  if (over !== null && has(t, 'second')) {
    push(filters, 'duration_s', 'gte', over);
    note(`over ${over}s`);
  }

  const passes =
    numberAfter(t, ['at least', 'minimum of', 'more than']) ??
    (/(\d+)\s*\+\s*pass/.exec(t) ? Number(/(\d+)\s*\+\s*pass/.exec(t)![1]) : null);
  if (passes !== null && has(t, 'pass')) {
    push(filters, 'n_passes', 'gte', passes);
    note(`${passes}+ passes`);
  }

  // ---- how the phase started -------------------------------------------------
  const startTypes: Array<[string[], string, string]> = [
    [['corner'], 'corner', 'from a corner'],
    [['free kick', 'free-kick', 'freekick'], 'free_kick', 'from a free kick'],
    [['throw in', 'throw-in', 'throwin'], 'throw_in', 'from a throw-in'],
    [['goal kick', 'goal-kick', 'build-up from the back', 'build up from the back', 'from the back', 'playing out from the back'], 'goal_kick', 'from a goal kick'],
    [['kick off', 'kick-off', 'kickoff'], 'kick_off', 'from a kick-off'],
    [['turnover', 'won the ball back', 'regain'], 'turnover_open_play', 'from an open-play turnover'],
  ];
  for (const [needles, value, label] of startTypes) {
    if (has(t, ...needles)) {
      // A high turnover already implies an open-play start; don't double up.
      if (value === 'turnover_open_play' && filters.some((f) => f.field === 'high_press_regain')) continue;
      push(filters, 'start_type', 'eq', value);
      note(label);
      break;
    }
  }

  // ---- chance quality and pressure -------------------------------------------
  if (has(t, 'big chance', 'good chance', 'clear chance', 'great chance', 'best chances')) {
    push(filters, 'xg', 'gte', 0.1);
    note('big chances (xG ≥ 0.1)');
  }
  if (has(t, 'under pressure', 'pressed', 'pressing', 'while pressed')) {
    push(filters, 'pressure_events', 'gte', 1);
    note('under pressure');
  }
  if (has(t, '360', 'freeze frame', 'freeze-frame')) {
    push(filters, 'has_360', 'eq', true);
    note('has 360 data');
  }

  // ---- start zone ------------------------------------------------------------
  // Only fires on an explicit "starting in …" so it never steals a plain
  // "reached the final third".
  const zoneThird = /\b(?:start(?:ing|s|ed)?|beginning|begin|originating|from)\b[^.]{0,24}?\b(defensive|own|middle|final|attacking)\b[^.]{0,12}?third/.exec(t);
  if (zoneThird) {
    const third: Third =
      zoneThird[1] === 'defensive' || zoneThird[1] === 'own'
        ? 'def_third'
        : zoneThird[1] === 'middle'
          ? 'mid_third'
          : 'final_third';
    let zones = zonesInThird(third);
    let channelLabel = '';
    if (has(t, 'wide', 'from the flank', 'out wide')) {
      zones = zones.filter((z) => z.endsWith('_left') || z.endsWith('_right'));
      channelLabel = ' (wide)';
    } else if (has(t, 'central', 'centrally', 'through the middle')) {
      zones = zones.filter((z) => z.endsWith('_centre'));
      channelLabel = ' (central)';
    }
    push(filters, 'start_zone', 'in', zones);
    note(`starting in the ${third.replace('_third', '')} third${channelLabel}`.replace('def ', 'defensive ').replace('mid ', 'middle '));
  }

  // ---- team and competition --------------------------------------------------
  // `team_name` is the team *in possession*. Anything after "against" / "vs" is
  // the opponent, which the index cannot filter — so the search for a team name
  // stops at that marker, and the opponent is reported as dropped instead of
  // quietly becoming the subject of the query.
  const opponentMarker = /\b(against|vs\.?|versus)\b/.exec(t);
  const teamSearchSpace = opponentMarker ? t.slice(0, opponentMarker.index) : t;
  // Longest name first at equal position, so "North Macedonia" wins over a bare
  // "Macedonia" and "Czech Republic" is not shadowed by a partial.
  const byLength = [...teams].sort((a, b) => b.length - a.length);
  let bestTeam: { name: string; at: number } | null = null;
  for (const team of byLength) {
    const at = teamSearchSpace.indexOf(team.toLowerCase());
    if (at >= 0 && hasWord(teamSearchSpace, team.toLowerCase())) {
      if (!bestTeam || at < bestTeam.at) bestTeam = { name: team, at };
    }
  }
  if (bestTeam) {
    push(filters, 'team_name', 'eq', bestTeam.name);
    note(bestTeam.name);
  }

  if (has(t, 'euro 2024', 'euros 2024', '2024')) {
    push(filters, 'competition', 'eq', 'Euro 2024');
    note('Euro 2024');
  } else if (has(t, 'euro 2020', 'euros 2020', '2020', 'euro 2021')) {
    // Euro 2020 was played in 2021; the dataset labels it 2020 and so do we.
    push(filters, 'competition', 'eq', 'Euro 2020');
    note('Euro 2020');
  }
  // A bare "the Euros" spans both tournaments — deliberately no filter.

  // ---- ordering and limit ----------------------------------------------------
  if (has(t, 'best', 'highest xg', 'biggest chance', 'best chances', 'highest-xg')) {
    orderBy = { field: 'xg', dir: 'desc' };
  } else if (has(t, 'fastest', 'most direct', 'quickest')) {
    orderBy = { field: 'direct_speed_m_s', dir: 'desc' };
  } else if (has(t, 'longest', 'slowest')) {
    orderBy = { field: 'duration_s', dir: 'desc' };
  } else if (has(t, 'most progressive', 'furthest')) {
    orderBy = { field: 'progression_m', dir: 'desc' };
  }

  const topN = numberAfter(t, ['top', 'first', 'show me', 'give me']);
  if (topN !== null) limit = Math.min(Math.max(Math.trunc(topN), LIMIT_MIN), LIMIT_MAX);

  const dropped = detectDropped(raw, t, teams);

  const explanation = matched.length
    ? `Matched: ${matched.join(', ')}.`
    : 'No football terms recognised — showing every phase, best chance first.';

  return {
    query: { version: DSL_VERSION, filters, order_by: orderBy, limit },
    explanation,
    dropped,
  };
}
