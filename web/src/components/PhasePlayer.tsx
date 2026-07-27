/**
 * The phase player.
 *
 * Two things are animated and they are animated differently on purpose.
 *
 * The **ball** moves on the real match clock. Its keyframes are the possession
 * team's event locations and end-locations at their `t_offset_s`, so a 40-second
 * build-up takes 40 seconds and a 4-second break takes 4. (The thumbnail's
 * `path_xy` is arc-length resampled and would be a lie here.)
 *
 * The **players** do not move between frames at all. A StatsBomb 360 freeze
 * frame is a photograph at one event; there is no information about where
 * anybody was in between. So one frame cross-fades into the next over 250 ms
 * and nothing is interpolated — and when the next frame is far away, the dots
 * dim rather than pretending to be current. CONTRACT §5: "never fabricate
 * positions between frames beyond a short tween; if coverage is sparse, dots
 * hold-and-fade honestly."
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PhaseEventRow, PhaseFrameRow, PhaseRow } from '../duck/types';
import { FLAG_ACTOR, FLAG_KEEPER, FLAG_POSSESSION } from '../duck/types';
import { clampX, clampY, Pitch } from '../pitch/Pitch';
import { usePrefersReducedMotion } from '../lib/reducedMotion';
import { clock, outcomeBadgeClass, outcomeLabel, percent, seconds, startTypeLabel, xg as fmtXg } from '../lib/format';

const CROSSFADE_MS = 250;
/** Beyond this, a frame is stale: it dims instead of implying it is live. */
const STALE_AFTER_S = 1.5;
const STALE_OPACITY = 0.32;

interface BallKey {
  t: number;
  x: number;
  y: number;
}

/**
 * Ball keyframes on the real clock.
 *
 * Mirrors the ingest's ball-path rule (phase-definitions §4): the possession
 * team's events only — opponent events say where a *defender* was — plus each
 * event's end_location where one exists. The end location is reached at the
 * time of the next kept event, which is exactly right: a pass at 6.55s whose
 * receipt is logged at 8.66s took 2.11 seconds to arrive.
 */
export function ballKeyframes(events: PhaseEventRow[]): BallKey[] {
  const kept = events.filter(
    (e) =>
      e.team_side === 'in_possession' &&
      e.type_name !== 'Pressure' &&
      e.x !== null &&
      e.y !== null,
  );
  const keys: BallKey[] = [];
  const push = (t: number, x: number, y: number) => {
    const last = keys[keys.length - 1];
    if (last && last.x === x && last.y === y) {
      last.t = Math.min(last.t, t); // collapse duplicate points, keep the earlier time
      return;
    }
    keys.push({ t, x, y });
  };

  for (let i = 0; i < kept.length; i++) {
    const e = kept[i];
    push(e.t_offset_s, e.x!, e.y!);
    if (e.end_x !== null && e.end_y !== null) {
      const next = kept[i + 1];
      const arrival = next && next.t_offset_s > e.t_offset_s ? next.t_offset_s : e.t_offset_s + 0.5;
      push(arrival, e.end_x, e.end_y);
    }
  }
  // Monotonic time, so interpolation never divides by a negative interval.
  for (let i = 1; i < keys.length; i++) {
    if (keys[i].t < keys[i - 1].t) keys[i].t = keys[i - 1].t;
  }
  return keys;
}

export function ballAt(keys: BallKey[], t: number): { x: number; y: number } | null {
  if (keys.length === 0) return null;
  if (t <= keys[0].t) return keys[0];
  const last = keys[keys.length - 1];
  if (t >= last.t) return last;
  let i = 1;
  while (i < keys.length && keys[i].t < t) i++;
  const a = keys[i - 1];
  const b = keys[i];
  const span = b.t - a.t;
  const u = span > 0 ? (t - a.t) / span : 1;
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

interface Props {
  phase: PhaseRow;
  events: PhaseEventRow[];
  frames: PhaseFrameRow[];
  loading: boolean;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onSimilar: (phaseId: string) => void;
  /** Toggle this phase in the active report. Absent hides the control. */
  onPin?: (phaseId: string) => void;
  pinned?: boolean;
  /** Set when the match shard behind this phase failed to load. */
  error?: string | null;
}

export function PhasePlayer({
  phase,
  events,
  frames,
  loading,
  onClose,
  onPrev,
  onNext,
  onSimilar,
  onPin,
  pinned,
  error,
}: Props) {
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [{ frameIndex, previousIndex }, setFrames] = useState({ frameIndex: -1, previousIndex: -1 });
  const frameIndexRef = useRef(-1);
  const [hovered, setHovered] = useState<number | null>(null);
  const [displayTime, setDisplayTime] = useState(0);
  const reducedMotion = usePrefersReducedMotion();

  const timeRef = useRef(0);
  const ballRef = useRef<SVGCircleElement | null>(null);
  const trailRef = useRef<SVGPolylineElement | null>(null);
  const sliderRef = useRef<HTMLInputElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const currentLayer = useRef<SVGGElement | null>(null);
  const previousLayer = useRef<SVGGElement | null>(null);
  const swapAt = useRef(0);

  const keys = useMemo(() => ballKeyframes(events), [events]);
  const duration = useMemo(
    () => Math.max(phase.duration_s, keys.length ? keys[keys.length - 1].t : 0, 0.5),
    [keys, phase.duration_s],
  );

  /** Frames in playback order, each stamped with its event's time. */
  const timedFrames = useMemo(() => {
    const timeByUuid = new Map(events.map((e) => [e.event_uuid, e.t_offset_s]));
    return frames
      .map((f) => ({ frame: f, t: timeByUuid.get(f.event_uuid) ?? 0 }))
      .sort((a, b) => a.t - b.t);
  }, [events, frames]);

  /** Events worth a tick on the timeline — the ones a human would scrub to. */
  const markers = useMemo(
    () =>
      events
        .filter((e) => e.type_name !== 'Pressure' && e.type_name !== 'Ball Receipt*')
        .map((e, i) => ({ ...e, key: `${e.event_uuid}-${i}` })),
    [events],
  );

  const seek = useCallback(
    (t: number) => {
      timeRef.current = Math.max(0, Math.min(duration, t));
      setDisplayTime(timeRef.current);
    },
    [duration],
  );

  // ---- the playback loop -----------------------------------------------------
  // Ball position, timeline and clock are written straight to the DOM; React
  // only re-renders when the active freeze frame changes, which is a handful of
  // times per phase rather than sixty times a second.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastDisplay = 0;

    const paint = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (playing) {
        timeRef.current += dt * speed;
        if (timeRef.current >= duration) timeRef.current = 0; // loop
      }
      const t = timeRef.current;

      const point = ballAt(keys, t);
      if (point && ballRef.current) {
        ballRef.current.setAttribute('cx', String(point.x));
        ballRef.current.setAttribute('cy', String(point.y));
      }
      if (trailRef.current) {
        // The trail is the path travelled so far — no future leaking backwards.
        const pts: string[] = [];
        for (const k of keys) {
          if (k.t <= t) pts.push(`${k.x},${k.y}`);
          else break;
        }
        if (point) pts.push(`${point.x},${point.y}`);
        trailRef.current.setAttribute('points', pts.join(' '));
      }
      if (sliderRef.current) sliderRef.current.value = String(t);
      if (fillRef.current) fillRef.current.style.width = `${(t / duration) * 100}%`;

      // Which freeze frame is current? The last one at or before now.
      let idx = -1;
      for (let i = 0; i < timedFrames.length; i++) {
        if (timedFrames[i].t <= t + 1e-6) idx = i;
        else break;
      }
      if (idx !== frameIndexRef.current) {
        setFrames({ frameIndex: idx, previousIndex: frameIndexRef.current });
        frameIndexRef.current = idx;
        swapAt.current = now;
      }

      // Cross-fade in, and dim when the frame has gone stale.
      const fade = Math.min(1, (now - swapAt.current) / CROSSFADE_MS);
      const active = timedFrames[idx];
      const age = active ? t - active.t : 0;
      const staleness =
        age <= STALE_AFTER_S ? 1 : Math.max(STALE_OPACITY, 1 - (age - STALE_AFTER_S) / 3);
      if (currentLayer.current) currentLayer.current.setAttribute('opacity', String(fade * staleness));
      if (previousLayer.current) {
        previousLayer.current.setAttribute('opacity', String(Math.max(0, 1 - fade) * 0.9));
      }

      if (now - lastDisplay > 80) {
        lastDisplay = now;
        setDisplayTime(t);
      }
      raf = requestAnimationFrame(paint);
    };

    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, duration, keys, timedFrames]);

  // ---- keyboard --------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === 'ArrowLeft' && onPrev) onPrev();
      else if (e.key === 'ArrowRight' && onNext) onNext();
      // `p` pins: an analyst going through twenty clips should never have to
      // reach for the mouse to keep one.
      else if ((e.key === 'p' || e.key === 'P') && onPin && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onPin(phase.phase_id);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, onPrev, onNext, onPin, phase.phase_id]);

  // Restart when the phase changes (prev/next navigation).
  useEffect(() => {
    timeRef.current = 0;
    frameIndexRef.current = -1;
    setFrames({ frameIndex: -1, previousIndex: -1 });
    setPlaying(true);
  }, [phase.phase_id]);

  const activeFrame = frameIndex >= 0 ? timedFrames[frameIndex] : undefined;
  const prevFrame = previousIndex >= 0 ? timedFrames[previousIndex] : undefined;
  const uncertain = activeFrame?.frame.orientation === 'unknown';

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Phase player" onClick={onClose}>
      <div className="player" onClick={(e) => e.stopPropagation()}>
        <header className="player-head">
          <div>
            <div className="player-title">
              {phase.team_name} <span className="opp">v {phase.opponent_name}</span>
              <span className={outcomeBadgeClass(phase.outcome)}>{outcomeLabel(phase.outcome)}</span>
              {phase.xg > 0 ? <span className="xg-pill num">{fmtXg(phase.xg)} xG</span> : null}
              {phase.goal_conceded ? (
                <span className="badge badge-neutral" title="The chain ended in a goal for the other team">
                  conceded
                </span>
              ) : null}
            </div>
            <div className="player-sub">
              {phase.match_label} · <span className="num">{clock(phase.minute, phase.second)}</span> ·{' '}
              {startTypeLabel(phase.start_type)}
            </div>
          </div>

          {/* Navigation only. The two things you can do with THIS phase live in
              the rail, next to the readings they act on. */}
          <div className="player-head-actions">
            <button
              type="button"
              className="icon-btn"
              onClick={onPrev ?? undefined}
              disabled={!onPrev}
              aria-label="Previous result"
              title="Previous result (←)"
            >
              <Chevron dir="left" />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={onNext ?? undefined}
              disabled={!onNext}
              aria-label="Next result"
              title="Next result (→)"
            >
              <Chevron dir="right" />
            </button>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close player" title="Close (Esc)">
              <Cross />
            </button>
          </div>
        </header>

        <div className="player-body">
          <div className="player-main">
            <div className="player-pitch">
            <Pitch lineWidth={0.17} labelSize={1.5} labelled title={`${phase.team_name} phase, attacking left to right`}>
              {/* visible camera area for the current frame — what the 360 saw */}
              {activeFrame && activeFrame.frame.visible_area.length >= 6 ? (
                <polygon
                  points={polygonPoints(activeFrame.frame.visible_area)}
                  fill="var(--vision-fill)"
                  stroke="var(--vision-line)"
                  strokeWidth={0.16}
                />
              ) : null}

              {/* the freeze-frame layers: previous fading out, current fading in */}
              <g ref={previousLayer} opacity={0}>
                {prevFrame ? <FrameDots frame={prevFrame.frame} /> : null}
              </g>
              <g ref={currentLayer} opacity={0}>
                {activeFrame ? <FrameDots frame={activeFrame.frame} /> : null}
              </g>

              {/* the ball */}
              <polyline
                ref={trailRef}
                points=""
                fill="none"
                stroke="var(--ball)"
                strokeWidth={0.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.75}
              />
              <circle ref={ballRef} cx={phase.path_xy[0] ?? 60} cy={phase.path_xy[1] ?? 40} r={1.15} fill="var(--ball)">
                {/* Decoration, not data — the ball's travel is the phase. */}
                {reducedMotion ? null : (
                  <animate attributeName="r" values="1.15;1.4;1.15" dur="1.4s" repeatCount="indefinite" />
                )}
              </circle>
            </Pitch>
          </div>

          {/* ---- transport ---- */}
          <div className="transport">
            <button
              type="button"
              className="play-btn"
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? 'Pause' : 'Play'}
              title={playing ? 'Pause (space)' : 'Play (space)'}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <span className="clock num">
              <strong>{displayTime.toFixed(1)}s</strong> / {duration.toFixed(1)}s
            </span>
            <div className="speeds" role="group" aria-label="Playback speed">
              {[0.5, 1, 2].map((s) => (
                <button
                  key={s}
                  type="button"
                  className="speed num"
                  aria-pressed={speed === s}
                  onClick={() => setSpeed(s)}
                >
                  {s}×
                </button>
              ))}
            </div>

            <div className="timeline">
              <div className="timeline-track" />
              <div className="timeline-fill" ref={fillRef} />
              {markers.map((m, i) => {
                const left = `${Math.min(100, (m.t_offset_s / duration) * 100)}%`;
                const isShot = m.type_name === 'Shot';
                return (
                  <span
                    key={m.key}
                    className={`marker${isShot ? ' marker-shot' : ''}${m.team_side === 'opponent' ? ' marker-opponent' : ''}`}
                    style={{ left }}
                    onMouseEnter={() => setHovered(i)}
                    onMouseLeave={() => setHovered((h) => (h === i ? null : h))}
                    onClick={() => seek(m.t_offset_s)}
                  />
                );
              })}
              {hovered !== null && markers[hovered] ? (
                <span
                  className="marker-tip"
                  // Clamped so a tick near either end does not push its label
                  // off the side of the dialog.
                  style={{
                    left: `clamp(88px, ${Math.min(100, (markers[hovered].t_offset_s / duration) * 100)}%, calc(100% - 88px))`,
                  }}
                >
                  <strong>{markers[hovered].type_name}</strong>
                  {markers[hovered].outcome_name ? ` (${markers[hovered].outcome_name})` : ''}{' '}
                  <span className="who">
                    {markers[hovered].player_name ?? 'unknown'} · {markers[hovered].t_offset_s.toFixed(1)}s
                  </span>
                </span>
              ) : null}
              <input
                ref={sliderRef}
                className="timeline-input"
                type="range"
                min={0}
                max={duration}
                step={0.01}
                defaultValue={0}
                aria-label="Scrub the phase"
                onChange={(e) => seek(Number(e.target.value))}
                onMouseDown={() => setPlaying(false)}
              />
            </div>
          </div>

          </div>

          {/* ---- the rail: what the phase measured, and what the picture is
                  allowed to claim ---- */}
          <aside className="player-rail">
            <div className="player-stats">
            <Stat k="Duration" v={seconds(phase.duration_s)} />
            <Stat k="Passes" v={String(phase.n_passes)} />
            <Stat k="Players" v={String(phase.n_players)} />
            <Stat k="Progression" v={`${phase.progression_m.toFixed(0)} m`} />
            <Stat k="Direct speed" v={`${phase.direct_speed_m_s.toFixed(1)} m/s`} />
            <Stat k="Pressure on ball" v={String(phase.pressure_events)} />
            <Stat
              k="360 coverage"
              v={percent(phase.frame_coverage)}
              title={`${frames.length} freeze frames over ${phase.n_events} events`}
            />
          </div>

            {/* A legend for marks that are not on the pitch is a small lie, so
                the player entries appear only when there are freeze frames to
                draw them from. */}
            <div className="legend">
              {frames.length ? (
                <>
                  <span>
                    <i style={{ background: 'var(--team-a)' }} /> {phase.team_name} (in possession)
                  </span>
                  <span>
                    <i style={{ background: 'var(--team-b)' }} /> {phase.opponent_name}
                  </span>
                  <span>
                    <i style={{ background: 'transparent', border: '1.5px solid var(--accent)' }} />{' '}
                    goalkeeper
                  </span>
                </>
              ) : null}
              <span>
                <i style={{ background: 'var(--ball)' }} /> ball
              </span>
            </div>

            <div className="player-rail-actions">
              {onPin ? (
                <button
                  type="button"
                  className="ghost-btn"
                  aria-pressed={pinned}
                  title={pinned ? 'Remove from the report (p)' : 'Add to the report (p)'}
                  onClick={() => onPin(phase.phase_id)}
                >
                  {pinned ? 'In report ✓' : 'Add to report'}
                </button>
              ) : null}
              <button type="button" className="ghost-btn" onClick={() => onSimilar(phase.phase_id)}>
                Find similar
              </button>
            </div>

            <p className="player-prov">
              <span className="num">{frames.length}</span> freeze frames over{' '}
              <span className="num">{phase.n_events}</span> events · phase{' '}
              <span className="num">{phase.phase_id}</span>
            </p>
          </aside>

          <div className="player-notes">
          {loading ? (
            <div className="status-line">
              <span className="spinner" /> loading events and 360 frames for this match…
            </div>
          ) : null}

          {error ? (
            <div className="error-box">
              <strong>Some of this phase could not be loaded.</strong> {error} The header and the
              summary come from the phase index, which did load; the replay needs the match shard,
              which did not.
            </div>
          ) : null}

          {uncertain ? (
            <div className="note-box">
              <strong>Orientation uncertain</strong> — for this freeze frame the ingest could not
              tell which team each dot plays for, so they are drawn neutral rather than guessed.
              3.2% of the dataset's frames are like this.
            </div>
          ) : null}

          {!loading && frames.length === 0 ? (
            <div className="note-box">
              No 360 freeze frames for this phase — the ball path is drawn from the event record
              alone. 3.4% of phases have no 360 coverage.
            </div>
          ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* Icons rather than text glyphs. `▶`, `❚❚`, `‹`, `›` and `✕` render at
   whatever weight and baseline the font decides, which on a 32px control reads
   as five different button vocabularies. */
function PlayIcon() {
  return (
    <svg width="12" height="13" viewBox="0 0 12 13" aria-hidden="true">
      <path d="M2 1.4 10.4 6.5 2 11.6z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true">
      <rect x="1" y="0.6" width="3.2" height="10.8" rx="1" fill="currentColor" />
      <rect x="6.8" y="0.6" width="3.2" height="10.8" rx="1" fill="currentColor" />
    </svg>
  );
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d={dir === 'left' ? 'M8.6 3.2 4.8 7l3.8 3.8' : 'M5.4 3.2 9.2 7l-3.8 3.8'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Cross() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
      <path
        d="M3 3l7 7M10 3l-7 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Stat({ k, v, title }: { k: string; v: string; title?: string }) {
  return (
    <div className="pstat" title={title}>
      <span className="k">{k}</span>
      <span className="v num">{v}</span>
    </div>
  );
}

/**
 * One freeze frame's dots.
 *
 * `flags` is a bitmask per player: bit 0 possession team, bit 1 the actor of
 * the event, bit 2 goalkeeper. Coordinates legitimately fall outside the pitch
 * (the ingest measured x ∈ [−2.5, 123.5]) so they are clamped for drawing only.
 * When `orientation` is 'unknown' the coordinates are still trustworthy but the
 * team labels are not, so every dot is drawn hollow and neutral.
 */
function FrameDots({ frame }: { frame: PhaseFrameRow }) {
  const uncertain = frame.orientation === 'unknown';
  const dots = [];
  for (let i = 0; i < frame.px.length; i++) {
    const flag = frame.flags[i] ?? 0;
    const possession = (flag & FLAG_POSSESSION) !== 0;
    const actor = (flag & FLAG_ACTOR) !== 0;
    const keeper = (flag & FLAG_KEEPER) !== 0;
    const fill = uncertain ? 'none' : possession ? 'var(--team-a)' : 'var(--team-b)';
    const stroke = uncertain ? 'var(--text-dim)' : keeper ? 'var(--accent)' : 'none';
    dots.push(
      <circle
        key={i}
        cx={clampX(frame.px[i])}
        cy={clampY(frame.py[i])}
        r={actor ? 1.25 : 1}
        fill={fill}
        stroke={stroke}
        strokeWidth={keeper ? 0.5 : uncertain ? 0.35 : 0}
        opacity={possession || uncertain ? 0.92 : 0.8}
      />,
    );
  }
  return <g>{dots}</g>;
}

function polygonPoints(flat: Float32Array): string {
  const parts: string[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    parts.push(`${clampX(flat[i])},${clampY(flat[i + 1])}`);
  }
  return parts.join(' ');
}
