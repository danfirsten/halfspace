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
}

export function PathThumbnail({ pathXy, index, startZoneLabel }: Props) {
  const hostRef = useRef<SVGGElement | null>(null);
  const pathRef = useRef<SVGPathElement | null>(null);
  const trailRef = useRef<SVGPathElement | null>(null);
  const ballRef = useRef<SVGCircleElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const path = pathRef.current;
    const trail = trailRef.current;
    const ball = ballRef.current;
    if (!host || !path || !trail || !ball) return;

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
  }, [index, pathXy]);

  const d = pathToD(pathXy);
  const startX = pathXy[0];
  const startY = pathXy[1];

  return (
    <Pitch lineWidth={0.22} labelled={false} title={startZoneLabel}>
      <g ref={hostRef}>
        {/* the whole trajectory, faint — the shape is readable even paused */}
        <path
          ref={pathRef}
          d={d}
          fill="none"
          stroke="#4d5a66"
          strokeWidth={0.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.55}
        />
        {/* the lit comet trail behind the ball */}
        <path
          ref={trailRef}
          d={d}
          fill="none"
          stroke="var(--ball)"
          strokeWidth={1.1}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.9}
        />
        {/* where the phase began */}
        <circle cx={startX} cy={startY} r={1.2} fill="none" stroke="#7d8791" strokeWidth={0.4} />
        <circle ref={ballRef} cx={startX} cy={startY} r={1.7} fill="var(--ball)" />
      </g>
    </Pitch>
  );
}
