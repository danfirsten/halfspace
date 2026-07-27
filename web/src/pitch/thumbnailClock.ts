/**
 * One requestAnimationFrame loop for every thumbnail on the page.
 *
 * 48 cards each running their own rAF and their own React state would repaint
 * the whole grid 60 times a second and jank on a laptop. Instead there is a
 * single loop here that writes SVG attributes directly — no React render per
 * frame — and an IntersectionObserver unsubscribes anything scrolled offscreen,
 * so the cost is proportional to what you can actually see.
 *
 * The motion is honest about what it is: `path_xy` is resampled evenly by ARC
 * LENGTH, not by time, so a constant-speed sweep is the correct reading of it.
 * A thumbnail is a shape, not a replay — real timings live in the full player.
 */

const TRAVEL_MS = 2500;
const HOLD_MS = 650;
const CYCLE_MS = TRAVEL_MS + HOLD_MS;
/** Fraction of the path lit behind the ball. */
const TRAIL_FRACTION = 0.34;

interface Entry {
  path: SVGPathElement;
  trail: SVGPathElement;
  ball: SVGCircleElement;
  length: number;
  /** Milliseconds of stagger, so the grid does not pulse in lockstep. */
  offset: number;
}

const entries = new Map<number, Entry>();
let nextId = 1;
let raf = 0;
let reducedMotion = false;

if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  reducedMotion = mq.matches;
  mq.addEventListener?.('change', (e) => {
    reducedMotion = e.matches;
    if (reducedMotion) {
      for (const entry of entries.values()) paint(entry, 1);
      stop();
    } else if (entries.size) start();
  });
}

function paint(entry: Entry, t: number) {
  const { path, trail, ball, length } = entry;
  const point = path.getPointAtLength(t * length);
  ball.setAttribute('cx', String(point.x));
  ball.setAttribute('cy', String(point.y));

  // The comet trail is a dash window whose leading edge sits on the ball.
  const head = t * length;
  const tail = Math.max(0, head - length * TRAIL_FRACTION);
  trail.setAttribute('stroke-dasharray', `${head - tail} ${length}`);
  trail.setAttribute('stroke-dashoffset', String(-tail));
}

function tick(now: number) {
  for (const entry of entries.values()) {
    const phase = (now + entry.offset) % CYCLE_MS;
    // Hold at the end of the sweep, then fade the ball out before restarting.
    const t = Math.min(1, phase / TRAVEL_MS);
    paint(entry, t);
    const holding = phase > TRAVEL_MS;
    entry.ball.setAttribute(
      'opacity',
      holding ? String(1 - (phase - TRAVEL_MS) / HOLD_MS) : '1',
    );
    entry.trail.setAttribute(
      'opacity',
      holding ? String(0.9 * (1 - (phase - TRAVEL_MS) / HOLD_MS)) : '0.9',
    );
  }
  raf = requestAnimationFrame(tick);
}

function start() {
  if (!raf && !reducedMotion) raf = requestAnimationFrame(tick);
}

function stop() {
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}

/** Register a thumbnail. Returns an unsubscribe. */
export function subscribeThumbnail(
  path: SVGPathElement,
  trail: SVGPathElement,
  ball: SVGCircleElement,
  index: number,
): () => void {
  const length = path.getTotalLength();
  if (!Number.isFinite(length) || length <= 0) {
    // A phase whose ball never moved: park the dot on the single point.
    paintStatic(path, trail, ball);
    return () => {};
  }
  const id = nextId++;
  const entry: Entry = { path, trail, ball, length, offset: (index * 90) % CYCLE_MS };
  entries.set(id, entry);
  if (reducedMotion) paint(entry, 1);
  else start();
  return () => {
    entries.delete(id);
    if (!entries.size) stop();
  };
}

function paintStatic(path: SVGPathElement, trail: SVGPathElement, ball: SVGCircleElement) {
  const point = path.getPointAtLength(0);
  ball.setAttribute('cx', String(point.x));
  ball.setAttribute('cy', String(point.y));
  trail.setAttribute('opacity', '0');
}

export const THUMBNAIL_CYCLE_MS = CYCLE_MS;
