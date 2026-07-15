'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Item 3a25f5ee — "Same as Permanent Address" convenience for the Contact & Address card. The Permanent and
 * Correspondence address blocks are rendered by the RSC page inside ONE server-action <form>; this
 * 'use client' island (same coordinate-by-DOM-id pattern as components/ic-dob-autofill.tsx) only renders the
 * checkbox + a hidden provenance marker. When ticked it copies each Permanent field's value into the
 * matching Correspondence field (native <input> and <select> both expose `.value`), keeps the Correspondence
 * fields FULLY EDITABLE, and mirrors later Permanent edits while still ticked. The moment HR types into a
 * Correspondence field the box unticks so the two addresses can diverge. The hidden `addressCopyVia` input
 * carries 'copy-permanent' to the server action ONLY as an event marker — never any address value (PDPA).
 *
 * The seven address field suffixes; the page assigns id="perm-<suffix>" / id="corr-<suffix>" to each pair.
 */
const FIELD_SUFFIXES = [
  'addressLine1',
  'addressLine2',
  'addressLine3',
  'postcode',
  'city',
  'state',
  'country',
] as const;

export function SameAsPermanentAddress({
  label,
  viaInputName,
  className,
}: {
  label: string;
  viaInputName: string;
  className?: string;
}) {
  const [checked, setChecked] = useState(false);
  const checkedRef = useRef(false);
  const viaRef = useRef<HTMLInputElement | null>(null);

  const permEl = (s: string) => document.getElementById(`perm-${s}`) as (HTMLInputElement | HTMLSelectElement) | null;
  const corrEl = (s: string) => document.getElementById(`corr-${s}`) as (HTMLInputElement | HTMLSelectElement) | null;

  const copyAll = () => {
    for (const s of FIELD_SUFFIXES) {
      const p = permEl(s);
      const c = corrEl(s);
      if (p && c) c.value = p.value;
    }
  };

  const setVia = (on: boolean) => {
    if (viaRef.current) viaRef.current.value = on ? 'copy-permanent' : '';
  };

  const onToggle = (next: boolean) => {
    setChecked(next);
    checkedRef.current = next;
    setVia(next);
    if (next) copyAll();
  };

  // Mirror Permanent → Correspondence while ticked; untick when HR edits a Correspondence field so the two
  // addresses may differ. Programmatic `.value =` assignments do NOT emit 'input', so our own copy never
  // trips the diverge handler — only genuine user typing does. Listeners attached once.
  useEffect(() => {
    const permHandlers: { el: HTMLElement; fn: EventListener }[] = [];
    const corrHandlers: { el: HTMLElement; fn: EventListener }[] = [];
    for (const s of FIELD_SUFFIXES) {
      const p = permEl(s);
      const c = corrEl(s);
      if (p) {
        const fn: EventListener = () => {
          if (checkedRef.current) {
            const cc = corrEl(s);
            if (cc) cc.value = (p as HTMLInputElement).value;
          }
        };
        p.addEventListener('input', fn);
        p.addEventListener('change', fn);
        permHandlers.push({ el: p, fn });
      }
      if (c) {
        const fn: EventListener = () => {
          if (checkedRef.current) {
            checkedRef.current = false;
            setChecked(false);
            setVia(false);
          }
        };
        c.addEventListener('input', fn);
        c.addEventListener('change', fn);
        corrHandlers.push({ el: c, fn });
      }
    }
    return () => {
      for (const { el, fn } of permHandlers) {
        el.removeEventListener('input', fn);
        el.removeEventListener('change', fn);
      }
      for (const { el, fn } of corrHandlers) {
        el.removeEventListener('input', fn);
        el.removeEventListener('change', fn);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <label className={className ?? 'flex items-center gap-2 text-sm text-foreground'}>
      <input type="hidden" name={viaInputName} ref={viaRef} defaultValue="" />
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onToggle(e.target.checked)}
        className="h-4 w-4 rounded border-input"
      />
      {label}
    </label>
  );
}
