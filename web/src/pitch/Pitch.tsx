/**
 * The pitch. One SVG, one coordinate system, real geometry.
 *
 * Everything is drawn in StatsBomb's 120 × 80 frame, which is also the frame
 * every coordinate in the dataset is already in — so nothing is scaled, flipped
 * or fudged on the way in. The team in possession always attacks x=0 → x=120,
 * and the direction arrow says so on every single pitch we draw, because a
 * pitch without a stated direction is a chart without an axis.
 *
 * Dimensions (StatsBomb spec, in the same nominal yards as the coordinates):
 *   penalty area   18 yd deep, 44 yd wide  → x 0–18 / 102–120, y 18–62
 *   six-yard box    6 yd deep, 20 yd wide  → x 0–6  / 114–120, y 30–50
 *   goal            8 yd wide              → y 36–44
 *   penalty spot   12 yd from goal line    → x 12 / 108
 *   D / centre circle  10 yd radius
 *   corner arc       1 yd radius
 */
import type { ReactNode } from 'react';

export const PITCH_LENGTH = 120;
export const PITCH_WIDTH = 80;

/** Margin around the pitch so goal frames and the arrow are not clipped. */
const PAD = 4;

export interface PitchProps {
  children?: ReactNode;
  /**
   * Marking weight in PITCH UNITS, so it scales with the drawing. A thumbnail
   * renders ~3.5 device px per unit and the player ~7.5, which is why the two
   * pass different values to land on the same hairline on screen.
   */
  lineWidth?: number;
  /** Text size for the direction label, in pitch units. Same reasoning. */
  labelSize?: number;
  /** Draw the "attacking →" wording as well as the arrow. */
  labelled?: boolean;
  /** Render the 3 × 3 zone grid faintly behind the markings. */
  showZones?: boolean;
  className?: string;
  title?: string;
}

export function Pitch({
  children,
  lineWidth = 0.28,
  labelSize = 2.6,
  labelled = true,
  showZones = false,
  className,
  title,
}: PitchProps) {
  const line = 'var(--turf-line)';
  const common = {
    fill: 'none',
    stroke: line,
    strokeWidth: lineWidth,
  };

  return (
    <svg
      className={className}
      viewBox={`${-PAD} ${-PAD} ${PITCH_LENGTH + PAD * 2} ${PITCH_WIDTH + PAD * 2}`}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={title ?? 'Football pitch, the team in possession attacks left to right'}
      style={{ display: 'block' }}
    >
      {title ? <title>{title}</title> : null}

      {/* turf — flat, no gradient (CONTRACT §5) */}
      <rect
        x={-PAD}
        y={-PAD}
        width={PITCH_LENGTH + PAD * 2}
        height={PITCH_WIDTH + PAD * 2}
        fill="var(--turf)"
      />

      {showZones ? <ZoneGrid /> : null}

      {/* touchlines and halfway line */}
      <rect x={0} y={0} width={PITCH_LENGTH} height={PITCH_WIDTH} {...common} />
      <line x1={60} y1={0} x2={60} y2={PITCH_WIDTH} {...common} />

      {/* centre circle and spot */}
      <circle cx={60} cy={40} r={10} {...common} />
      <circle cx={60} cy={40} r={0.45} fill={line} />

      {/* penalty areas */}
      <rect x={0} y={18} width={18} height={44} {...common} />
      <rect x={102} y={18} width={18} height={44} {...common} />

      {/* six-yard boxes */}
      <rect x={0} y={30} width={6} height={20} {...common} />
      <rect x={114} y={30} width={6} height={20} {...common} />

      {/* penalty spots */}
      <circle cx={12} cy={40} r={0.45} fill={line} />
      <circle cx={108} cy={40} r={0.45} fill={line} />

      {/*
        The D: a 10 yd arc around the penalty spot, drawn only where it lies
        outside the box. The spot is 12 yd out and the box is 18 yd deep, so the
        arc meets the box edge 6 yd from the spot — 8 yd either side of centre.
      */}
      <path d="M 18 32 A 10 10 0 0 1 18 48" {...common} />
      <path d="M 102 32 A 10 10 0 0 0 102 48" {...common} />

      {/* corner arcs, 1 yd radius */}
      <path d="M 1 0 A 1 1 0 0 1 0 1" {...common} />
      <path d="M 0 79 A 1 1 0 0 1 1 80" {...common} />
      <path d="M 119 0 A 1 1 0 0 0 120 1" {...common} />
      <path d="M 120 79 A 1 1 0 0 0 119 80" {...common} />

      {/* goal frames, sitting outside the goal line */}
      <rect x={-2} y={36} width={2} height={8} {...common} />
      <rect x={120} y={36} width={2} height={8} {...common} />

      <AttackingArrow labelled={labelled} size={labelSize} weight={lineWidth} />

      {children}
    </svg>
  );
}

/**
 * Direction of play. CONTRACT §5 requires this on every pitch: the coordinates
 * are already normalized so the possession team attacks left → right, and the
 * only way that is not a silent assumption is to draw it.
 */
function AttackingArrow({
  labelled,
  size,
  weight,
}: {
  labelled: boolean;
  size: number;
  weight: number;
}) {
  const y = PITCH_WIDTH + PAD - size * 0.55;
  // The label sits left of the arrow when there is room for the word, and the
  // arrow alone leads on a thumbnail — the word "attacking" still follows it.
  const textX = 3;
  const arrowStart = textX + (labelled ? size * 5.2 : size * 4.4);
  const arrowEnd = arrowStart + size * 3.2;
  const head = size * 0.62;
  return (
    <g opacity={0.7} aria-hidden="true">
      {labelled ? (
        <text
          x={textX}
          y={y + size * 0.35}
          fill="var(--text-mute)"
          fontSize={size}
          letterSpacing={size * 0.03}
          fontFamily="var(--font)"
        >
          attacking
        </text>
      ) : null}
      <line
        x1={arrowStart}
        y1={y}
        x2={arrowEnd}
        y2={y}
        stroke="var(--text-dim)"
        strokeWidth={weight * 1.2}
      />
      <path d={`M ${arrowEnd} ${y} l ${-head * 1.5} ${-head} v ${head * 2} z`} fill="var(--text-dim)" />
    </g>
  );
}

/** The 3 × 3 search grid, drawn faintly so the builder's zone picker matches. */
function ZoneGrid() {
  return (
    <g opacity={0.5} aria-hidden="true">
      {[40, 80].map((x) => (
        <line
          key={`v${x}`}
          x1={x}
          y1={0}
          x2={x}
          y2={PITCH_WIDTH}
          stroke="var(--pitch-hash)"
          strokeWidth={0.5}
          strokeDasharray="1.5 1.5"
        />
      ))}
      {[80 / 3, 160 / 3].map((y) => (
        <line
          key={`h${y}`}
          x1={0}
          y1={y}
          x2={PITCH_LENGTH}
          y2={y}
          stroke="var(--pitch-hash)"
          strokeWidth={0.5}
          strokeDasharray="1.5 1.5"
        />
      ))}
    </g>
  );
}

/** Clamp a freeze-frame coordinate for rendering only — never for analysis.
 *  360 coordinates legitimately fall outside the pitch (observed x ∈ [−2.5,
 *  123.5]); the contract says clamp at render time, never assert. */
export function clampX(x: number): number {
  return Math.max(-PAD, Math.min(PITCH_LENGTH + PAD, x));
}

export function clampY(y: number): number {
  return Math.max(-PAD, Math.min(PITCH_WIDTH + PAD, y));
}
