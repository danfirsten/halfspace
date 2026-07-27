import { describe, expect, it } from 'vitest';
import { parseHeuristic } from './heuristic';
import { parseQuery, type Filter } from './schema';

const TEAMS = [
  'Albania', 'Austria', 'Belgium', 'Croatia', 'Czech Republic', 'Denmark', 'England',
  'Finland', 'France', 'Georgia', 'Germany', 'Hungary', 'Italy', 'Netherlands',
  'North Macedonia', 'Poland', 'Portugal', 'Romania', 'Russia', 'Scotland', 'Serbia',
  'Slovakia', 'Slovenia', 'Spain', 'Sweden', 'Switzerland', 'Turkey', 'Ukraine', 'Wales',
];

const run = (text: string) => parseHeuristic(text, { teams: TEAMS });

/** Filters are order-independent; compare as a set of compact signatures. */
const sig = (filters: Filter[]) =>
  filters
    .map((f) => `${f.field} ${f.op} ${JSON.stringify(f.value)}`)
    .sort();

const expectFilters = (text: string, expected: string[]) => {
  const { query } = run(text);
  expect(parseQuery(query).ok, `"${text}" must produce valid DSL`).toBe(true);
  expect(sig(query.filters)).toEqual([...expected].sort());
};

describe('heuristic parser — football vocabulary', () => {
  it('high turnovers leading to a shot', () => {
    expectFilters('high turnovers leading to a shot', [
      'high_press_regain eq true',
      'outcome in ["goal","shot_on_target","shot_off_target"]',
    ]);
  });

  it('counterattacks that reached the box', () => {
    expectFilters('counterattacks that reached the box', [
      'counterattack eq true',
      'reached_box eq true',
    ]);
  });

  it('treats "on the break" and "transition" as counterattacks', () => {
    expect(sig(run('goals on the break').query.filters)).toContain('counterattack eq true');
    expect(sig(run('phases in transition').query.filters)).toContain('counterattack eq true');
  });

  it('switches of play that ended in a shot', () => {
    expectFilters('switches of play that ended in a shot', [
      'switch_of_play eq true',
      'outcome in ["goal","shot_on_target","shot_off_target"]',
    ]);
  });

  it('"changed the point of attack" is a switch', () => {
    expect(sig(run('phases where they changed the point of attack').query.filters)).toContain(
      'switch_of_play eq true',
    );
  });

  it('a bare "goals" is outcome = goal, not any shot', () => {
    expectFilters('goals', ['outcome eq "goal"']);
  });

  it('does not read "goal kick" as a goal outcome', () => {
    expectFilters('phases from a goal kick', ['start_type eq "goal_kick"']);
  });

  it('goal-kick build-ups reaching the final third', () => {
    expectFilters('goal-kick build-ups that reached the final third', [
      'start_type eq "goal_kick"',
      'reached_final_third eq true',
    ]);
  });

  it('"build-up from the back" means a goal kick', () => {
    expect(sig(run('build-up from the back').query.filters)).toContain('start_type eq "goal_kick"');
  });

  it('long, sustained possession sets both a duration and a pass floor', () => {
    expectFilters('long possessions ending in the box', [
      'duration_s gte 20',
      'n_passes gte 8',
      'reached_box eq true',
    ]);
  });

  it('quick / direct sets a speed floor', () => {
    expect(sig(run('quick vertical attacks').query.filters)).toContain('direct_speed_m_s gte 3');
  });

  it('"under N seconds" is an upper bound, "over N seconds" a lower one', () => {
    expect(sig(run('phases under 12 seconds').query.filters)).toEqual(['duration_s lte 12']);
    expect(sig(run('phases over 30 seconds').query.filters)).toEqual(['duration_s gte 30']);
  });

  it('"N+ passes" and "at least N passes" both set a pass floor', () => {
    expect(sig(run('phases with 10+ passes').query.filters)).toEqual(['n_passes gte 10']);
    expect(sig(run('possessions with at least 15 passes').query.filters)).toEqual([
      'n_passes gte 15',
    ]);
  });

  it('recognises every set-piece start type', () => {
    expect(sig(run('goals from corners').query.filters)).toContain('start_type eq "corner"');
    expect(sig(run('phases from a free kick').query.filters)).toContain('start_type eq "free_kick"');
    expect(sig(run('attacks from a throw-in').query.filters)).toContain('start_type eq "throw_in"');
    expect(sig(run('phases from a kick-off').query.filters)).toContain('start_type eq "kick_off"');
  });

  it('big chances become an xG floor', () => {
    expect(sig(run('big chances').query.filters)).toContain('xg gte 0.1');
  });

  it('"under pressure" becomes a pressure-event floor', () => {
    expect(sig(run('phases played under pressure').query.filters)).toContain(
      'pressure_events gte 1',
    );
  });

  it('"starting in the defensive third" expands to that third\'s three zones', () => {
    expectFilters('switches starting in the defensive third', [
      'switch_of_play eq true',
      'start_zone in ["def_third_left","def_third_centre","def_third_right"]',
    ]);
  });

  it('"wide" narrows a third to its two flank zones, "central" to its centre', () => {
    expect(sig(run('phases starting wide in the middle third').query.filters)).toEqual([
      'start_zone in ["mid_third_left","mid_third_right"]',
    ]);
    expect(sig(run('phases starting centrally in the final third').query.filters)).toEqual([
      'start_zone in ["final_third_centre"]',
    ]);
  });

  it('matches team names case-insensitively against the real vocabulary', () => {
    expect(sig(run('counterattacks by england').query.filters)).toContain('team_name eq "England"');
    expect(sig(run('SPAIN phases').query.filters)).toContain('team_name eq "Spain"');
    expect(sig(run('north macedonia phases').query.filters)).toContain(
      'team_name eq "North Macedonia"',
    );
  });

  it('maps competitions exactly and leaves a bare "the Euros" unfiltered', () => {
    expect(sig(run('counterattacks at Euro 2024').query.filters)).toContain(
      'competition eq "Euro 2024"',
    );
    expect(sig(run('switches in 2020').query.filters)).toContain('competition eq "Euro 2020"');
    expect(sig(run('the best chances of the Euros').query.filters)).not.toContain(
      'competition eq "Euro 2020"',
    );
  });

  it('reads ranking cues into order_by', () => {
    expect(run('the best chances').query.order_by).toEqual({ field: 'xg', dir: 'desc' });
    expect(run('the fastest counterattacks').query.order_by).toEqual({
      field: 'direct_speed_m_s',
      dir: 'desc',
    });
    expect(run('the longest possessions').query.order_by).toEqual({
      field: 'duration_s',
      dir: 'desc',
    });
    expect(run('counterattacks').query.order_by).toBeNull();
  });

  it('reads "top N" into the limit, clamped to 1..96', () => {
    expect(run('top 20 counterattacks').query.limit).toBe(20);
    expect(run('top 500 counterattacks').query.limit).toBe(96);
    expect(run('counterattacks').query.limit).toBe(48);
  });
});

describe('heuristic parser — honesty about what it cannot do', () => {
  it('drops an opponent clause and says so', () => {
    const r = run('Spain phases against Germany');
    expect(sig(r.query.filters)).toEqual(['team_name eq "Spain"']);
    expect(r.dropped.join(' ')).toMatch(/opponent/i);
  });

  it('drops player names', () => {
    const r = parseHeuristic('shots by Cristiano Ronaldo', { teams: TEAMS });
    expect(r.dropped.join(' ')).toMatch(/Cristiano Ronaldo/);
  });

  it('drops rounds and dates', () => {
    expect(run('goals in the final').dropped.join(' ')).toMatch(/date or round/i);
    expect(run('phases on 2024-07-14').dropped.join(' ')).toMatch(/date or round/i);
  });

  it('drops scoreline and game-state clauses', () => {
    expect(run('counterattacks while winning').dropped.join(' ')).toMatch(/scoreline/i);
  });

  it('drops event-level actions the phase index does not carry', () => {
    expect(run('phases with a cross into the box').dropped.join(' ')).toMatch(/event-level/i);
  });

  it('returns an empty, valid query for gibberish and says nothing matched', () => {
    const r = run('qwertyuiop');
    expect(r.query.filters).toEqual([]);
    expect(parseQuery(r.query).ok).toBe(true);
    expect(r.explanation).toMatch(/No football terms recognised/);
  });

  it('always produces DSL that validates', () => {
    const phrases = [
      'high turnovers leading to a shot',
      'counterattacks reaching the box',
      'goal-kick build-ups to the final third',
      'switches of play that ended in a shot',
      'highest xG phases of the Euros',
      'long patient build-up under pressure from Spain at Euro 2024',
      'top 12 fastest counterattacks by Italy in 2020 against France',
      'quick switches of play starting in the defensive third',
      'phases with 10+ passes that reached the box under 30 seconds',
      '',
    ];
    for (const p of phrases) {
      const r = parseHeuristic(p, { teams: TEAMS });
      expect(parseQuery(r.query).ok, `"${p}"`).toBe(true);
    }
  });
});
