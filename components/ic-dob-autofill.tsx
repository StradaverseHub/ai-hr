'use client';

import { useEffect, useRef, useState } from 'react';
import { dobFromIC } from '@/localization/my/ic-dob';

/**
 * Item 354a500d — IC → Date-of-Birth autofill (client convenience). Renders the IC-number input on the
 * Personnel Profile. The IC field and the Date-of-Birth field live in SEPARATE server-action forms on the
 * RSC detail page, so this 'use client' wrapper coordinates them by DOM id: on entry/change of a valid
 * MyKad IC it derives the DOB (first six digits YYMMDD → most-recent-non-future date) and writes it into
 * the DOB <input>. It fills the DOB ONLY while that field is empty or still holds the value we auto-filled,
 * so a DOB the admin typed or edited by hand is never clobbered. When the IC's first six digits are not a
 * real calendar date, a note is shown and the DOB is left untouched. The DOB stays fully editable — the
 * server (setIcAction → setPersonComplianceFields) persists the same derivation only when DOB is empty.
 *
 * dobFromIC comes from the leaf pure module (not statutory.ts) so this client bundle stays free of db deps.
 */
export function IcDobAutofill({
  name,
  defaultValue,
  dobInputId,
  className,
  placeholder,
  invalidDateNote,
  required,
}: {
  name: string;
  defaultValue: string;
  dobInputId: string;
  className?: string;
  placeholder?: string;
  invalidDateNote: string;
  required?: boolean;
}) {
  const [showNote, setShowNote] = useState(false);
  // The last DOB value we wrote — lets us recompute on a later IC change without overwriting a manual DOB.
  const autofilledRef = useRef<string | null>(null);

  const apply = (raw: string) => {
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 12) {
      // Not a full IC yet — don't populate, and don't nag with the invalid-date note mid-typing.
      setShowNote(false);
      return;
    }
    const iso = dobFromIC(digits);
    if (iso === null) {
      // 12 digits but YYMMDD is not a real calendar date — surface the note, leave the DOB alone.
      setShowNote(true);
      return;
    }
    setShowNote(false);
    const dobEl = document.getElementById(dobInputId) as HTMLInputElement | null;
    if (!dobEl) return;
    // Fill only when the DOB is empty or still equals our previous auto-fill (never clobber a manual DOB).
    if (dobEl.value === '' || dobEl.value === autofilledRef.current) {
      dobEl.value = iso;
      autofilledRef.current = iso;
    }
  };

  // On mount, if an IC is already present, derive the DOB for immediate display when the field is empty
  // (the server also persists this on the next IC save). Runs once.
  useEffect(() => {
    if (defaultValue) apply(defaultValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <input
        name={name}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className={className}
        onChange={(e) => apply(e.target.value)}
      />
      {showNote ? <span className="text-xs text-destructive">{invalidDateNote}</span> : null}
    </>
  );
}
