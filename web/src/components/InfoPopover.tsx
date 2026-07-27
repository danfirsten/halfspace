/**
 * The "what does this actually mean" popover.
 *
 * Every feature control carries one. The text is lifted from
 * docs/phase-definitions.md verbatim, thresholds included: an analyst deciding
 * whether to trust "counterattack" needs to see 4.3 yd/s and where that number
 * came from, not a marketing sentence.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { DEFINITIONS } from '../dsl/definitions';
import { fieldSpec, type PhaseFieldName } from '../dsl/schema';

export function InfoPopover({ field }: { field: PhaseFieldName }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement | null>(null);
  const definition = DEFINITIONS[field];
  const spec = fieldSpec(field);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const body = definition?.rule ?? spec.doc;

  return (
    <span className="info" ref={ref}>
      <button
        type="button"
        className="info-btn"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`What "${spec.label}" means`}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
      >
        i
      </button>
      {open ? (
        <span className="info-pop" id={id} role="tooltip" onMouseLeave={() => setOpen(false)}>
          <strong>{spec.label}</strong>
          <div style={{ marginTop: 4 }}>{body}</div>
          {definition?.measured ? <div className="measured">{definition.measured}</div> : null}
          {definition?.provenance ? <div className="prov">{definition.provenance}</div> : null}
        </span>
      ) : null}
    </span>
  );
}
