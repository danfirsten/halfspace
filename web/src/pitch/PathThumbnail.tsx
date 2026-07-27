/**
 * The small animated pitch on a result card.
 *
 * Everything it needs is already in the eagerly-loaded index: `path_xy` is 20
 * points of the phase's ball trajectory, so a card can animate without a single
 * extra request. That is the whole reason the column exists (§13 of the phase
 * definitions), and it is what makes 48 animated results paint inside the
 * 300 ms budget.
 */
import { useEffect, useRef } from 'react';
import { Pitch } from './Pitch';
import { subscribeThumbnail } from './thumbnailClock';

export function pathToD(pathXy: Float32Array | number[]): string {
  const n = Math.floor(pathXy.length / 2);
  if (n === 0) return '';
  let d = `M ${pathXy[0]} ${pathXy[1]}`;
  for (let i = 1; i < n; i++) d += ` L ${pathXy[i * 2]} ${pathXy[i * 2 + 1]}`;
  return d;
}

interface Props {
  pathXy: Float32Array;
  /** Stagger index, so the grid does not sweep in lockstep. */
  index: number;
  startZoneLabel?: string;
  /**
   * Draw the phase halfway through instead of animating it. Paper cannot
   * animate, so a printed report renders the ball at the mid-point of the
   * trajectory with the travelled half lit — and because `path_xy` is
   * resampled by arc length, "half the points" *is* half the distance, with no
   * layout measurement and nothing invented.
   */
  frozen?: boolean;
}

export function PathThumbnail({ pathXy, index, startZoneLabel, frozen }: Props) {
  const hostRef = useRef<SVGGElement | null>(null);
  const pathRef = useRef<SVGPathElement | null>(null);
  const trailRef = useRef<SVGPathElement | null>(null);
  const ballRef = useRef<SVGCircleElement | null>(null);

  const d = pathToD(pathXy);
  const startX = pathXy[0];
  const startY = pathXy[1];

  // Frozen: the trail is the first half of the resampled path and the ball
  // sits on its last point.
  const points = Math.floor(pathXy.length / 2);
  const half = Math.max(1, Math.ceil(points / 2));
  const trailD = frozen ? pathToD(pathXy.subarray(0, half * 2)) : d;
  const ballX = frozen ? pathXy[(half - 1) * 2] : startX;
  const ballY = frozen ? pathXy[(half - 1) * 2 + 1] : startY;

  useEffect(() => {
    const host = hostRef.current;
    const path = pathRef.current;
    const trail = trailRef.current;
    const ball = ballRef.current;
    if (!host || !path || !trail || !ball) return;

    if (frozen) {
      // The shared clock writes straight to the DOM, so freezing means undoing
      // its attributes by hand — React never knew about them.
      trail.removeAttribute('stroke-dasharray');
      trail.removeAttribute('stroke-dashoffset');
      trail.setAttribute('opacity', '0.9');
      ball.setAttribute('opacity', '1');
      ball.setAttribute('cx', String(ballX));
      ball.setAttribute('cy', String(ballY));
      return;
    }

    let unsubscribe: (() => void) | null = null;
    const attach = () => {
      if (!unsubscribe) unsubscribe = subscribeThumbnail(path, trail, ball, index);
    };
    const detach = () => {
      unsubscribe?.();
      unsubscribe = null;
    };

    // Offscreen cards cost nothing: the shared clock only ever sees what is
    // actually in the viewport.
    if (typeof IntersectionObserver === 'undefined') {
      attach();
      return detach;
    }
    const observer = new IntersectionObserver(
      ([entry]) => (entry.isIntersecting ? attach() : detach()),
      { rootMargin: '120px' },
    );
    observer.observe(host);
    return () => {
      observer.disconnect();
      detach();
    };
  }, [index, pathXy, frozen, ballX, ballY]);

  return (
    <Pitch lineWidth={0.34} labelSize={2.6} title={startZoneLabel}>
      <g ref={hostRef}>
        {/* the whole trajectory, faint — the shape is readable even paused */}
        <path
          ref={pathRef}
          d={d}
          fill="none"
          stroke="var(--path-line)"
          strokeWidth={0.55}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.55}
        />
        {/* the lit comet trail behind the ball */}
        <path
          ref={trailRef}
          d={trailD}
          fill="none"
          stroke="var(--ball)"
          strokeWidth={1.0}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.9}
        />
        {/* where the phase began */}
        <circle cx={startX} cy={startY} r={1.2} fill="none" stroke="var(--path-start)" strokeWidth={0.4} />
        <circle ref={ballRef} cx={ballX} cy={ballY} r={1.7} fill="var(--ball)" />
      </g>
    </Pitch>
  );
}
