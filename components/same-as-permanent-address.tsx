'use client';

import { useEffect, useRef, useState } from 'react';
import { ADDRESS_COPY_PAIRS } from '@/lib/address-blocks';

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
 * The copied field suffixes; the page assigns id="perm-<suffix>" / id="corr-<suffix>" to each pair. The
 * seven address fields plus (bf953339) the Mobile/Home phone pair — the perm- side of the phones aliases
 * the main Contact & Address inputs (name="phone" / name="homePhone", which are not perm-* form names),
 * so ticking the box copies the full contact picture: address AND both phone numbers.
 *
 * ITEM da7463b4 MOVED THAT LIST OUT of this file and into lib/address-blocks.ts. It is no longer only a
 * list of DOM suffixes: the Create New Employee DRAFT offers the same tick, and a draft is a controlled
 * React form where this island's `.value =` writes would be fought and discarded — so it copies by FIELD
 * KEY instead. Two renderings of one pairing. Keeping a private copy here is how the two would come to
 * disagree, which is the drift da7463b4 was raised about.
 */
const FIELD_SUFFIXES = ADDRESS_COPY_PAIRS.map((p) => p.idSuffix);

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

/**
 * THE CONTROLLED TWIN — item da7463b4, for the Create New Employee draft.
 *
 * Same words, same table (lib/address-blocks.ts), a different mechanism and a DELIBERATELY DIFFERENT
 * PROMISE, and the difference is worth stating rather than hiding:
 *
 *   · On the ACTIVATED record the tick is transient browser state. It cannot be anything else without a
 *     `person` column to hold it, and it copies into inputs that stay editable, unticking itself the
 *     moment HR types into the Correspondence side.
 *   · On a DRAFT the tick is STORED, in the jsonb blob the draft already is — no migration, no new
 *     column. So it survives a Save, a reload and a tab switch, and the correspondence side is DERIVED
 *     from the permanent side for as long as it is ticked, on the client AND again at Activate. The
 *     Correspondence inputs are therefore DISABLED while ticked: there is nothing to type into a value
 *     that is a copy, and an editable copy is how the pair silently diverges.
 *
 * This is a divergence FROM the activated screen, chosen on purpose and recorded in the round entry: it
 * is stricter, and it is the only version of "same as" that survives the reporter's own scenario —
 * correct the permanent address later and the correspondence one follows.
 *
 * No `name`, no hidden provenance input: the draft posts JSON, not FormData (the r159 lesson — a guard
 * grepping for a form name must never be able to conclude that this copy submits anything).
 */
export function SameAsPermanentAddressControlled({
  label,
  checked,
  onChange,
  className,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}) {
  return (
    <label className={className ?? 'flex items-center gap-2 text-sm text-foreground'}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-input"
      />
      {label}
    </label>
  );
}
