"use client";

import { useEffect, useRef, useState } from "react";

/**
 * "?" next to a "Leads no período" label. Opens on hover/keyboard focus and
 * on tap (iOS Safari neither hovers nor focuses a tapped button), closes on a
 * second tap, a tap outside or Escape.
 */
export function OverviewLeadsHint({
  id,
  label,
  text,
}: {
  id: string;
  label: string;
  text: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const closeOutside = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <span className="overview-leads-hint-wrap" ref={wrapper}>
      <button
        className="overview-leads-hint"
        type="button"
        aria-label={`O que é: ${label}`}
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        ?
      </button>
      <span className="overview-leads-hint-text" id={id} role="tooltip">
        {text}
      </span>
    </span>
  );
}
