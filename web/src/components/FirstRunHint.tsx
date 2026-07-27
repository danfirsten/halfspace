/**
 * The first-run hint: one line, in the flow, once.
 *
 * It names the three steps of the demo path in the order they happen and marks
 * the ones already done, so a reviewer who has just clicked a preset can see
 * that the thing they did was step one. It is not a tour, there is no overlay
 * and there is no "next" — every step is a control that is already on screen.
 */
interface Props {
  /** Steps completed so far, in order. */
  done: { preset: boolean; opened: boolean; similar: boolean };
  onDismiss: () => void;
}

const STEPS = [
  { key: 'preset', text: 'Run a preset' },
  { key: 'opened', text: 'Open a phase' },
  { key: 'similar', text: 'Find similar' },
] as const;

export function FirstRunHint({ done, onDismiss }: Props) {
  return (
    <div className="first-run" role="note">
      <span className="first-run-label">Start here</span>
      <ol className="first-run-steps">
        {STEPS.map((step, i) => (
          <li key={step.key} className={done[step.key] ? 'is-done' : undefined}>
            <span className="first-run-n" aria-hidden="true">
              {done[step.key] ? '✓' : i + 1}
            </span>
            {step.text}
          </li>
        ))}
      </ol>
      <span className="first-run-tail">Everything runs in this browser — no server, no sign-in.</span>
      <button type="button" className="first-run-x" onClick={onDismiss} aria-label="Dismiss the hint">
        ✕
      </button>
    </div>
  );
}
