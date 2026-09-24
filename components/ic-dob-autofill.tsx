'use client';

import { useEffect, useRef, useState } from 'react';
import { clientCountryPacks } from '@/localization/registry.client';

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
 * dobFromIC arrives via the CLIENT-SAFE pack registry (ADR-0080 rung 5b, D4): each pack's
 * `identity.dobFromIC` is a pure leaf function (MY: localization/my/ic-dob, zero db deps), taken as a
 * union across registered packs — first non-null derivation wins. MY-only today, so this is identical
 * to the old direct leaf import; per-company narrowing is the second-country rung's decision.
 */
const dobFromIC = (ic: string): string | null => {
  for (const p of clientCountryPacks()) {
    const iso = p.identity.dobFromIC(ic);
    if (iso !== null) return iso;
  }
  return null;
};

/**
 * WHAT A TYPED IC NUMBER MEANS FOR THE DATE OF BIRTH — the three outcomes, named, item da7463b4.
 *
 * This was the body of `apply` below and nothing else could reach it. The Create New Employee DRAFT has
 * to reach exactly the same decision (feedback da7463b4 is a drift complaint: the draft screen and the
 * activated screen must not disagree about one person), and it cannot use `apply` itself because its Date
 * of Birth is React state in the same tree, not a DOM node in a sibling `<form>`. So the DECISION is here
 * and the two mechanisms — a `.value =` write on the record, a `setState` on the draft — are all that
 * differ.
 *
 *   'incomplete'  fewer than 12 digits. Nothing is filled and NOTHING IS SAID: nagging about an invalid
 *                 date after the fourth keystroke of a number that is still being typed is noise.
 *   'unreal'      twelve digits whose first six are not a real calendar date (month 13, 31 April,
 *                 29 Feb of a non-leap year). Nothing is filled, the note is shown, AND THE FORM IS NOT
 *                 BLOCKED — feedback b9fd8fd5's rule for the importer, stated for the screens: such an IC
 *                 "derives nothing (null) and is skipped, not failed".
 *   'derived'     a date. `dob` is an ISO yyyy-mm-dd.
 */
export type IcDobDerivation = { status: 'incomplete' | 'unreal' | 'derived'; dob: string | null };

export function deriveDobFromIcInput(raw: string): IcDobDerivation {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length < 12) return { status: 'incomplete', dob: null };
  const iso = dobFromIC(digits);
  if (iso === null) return { status: 'unreal', dob: null };
  return { status: 'derived', dob: iso };
}

/**
 * MAY THE DERIVED DATE BE WRITTEN OVER WHAT IS THERE? — the second half of the rule, also shared.
 *
 * YES when the Date of Birth is empty, and yes when it still holds the value WE derived last time, which
 * is what makes the field FOLLOW a corrected IC number rather than freezing on the first one typed. NO
 * once a human has touched it: a hand-typed date is a statement about a person and an IC number is a
 * guess about one.
 *
 * THAT IS DELIBERATELY NOT `dobOnlyIfEmpty`, and the difference is the one place this item diverges from
 * the rule core/import.ts states. `dobOnlyIfEmpty` guards a date already PERSISTED against a later
 * import or IC edit; this guards a date being TYPED against the field it is being typed beside. The
 * reporter asked for a Date of Birth that "updates when the NRIC changes" and this is what makes it do
 * so, without ever discarding something a person wrote. Both are pinned in
 * test/da7463b4-draft-ic-dob-address.test.ts.
 */
export function nextAutofilledDob(current: string, derived: string, lastAutofilled: string | null): string | null {
  return current === '' || current === lastAutofilled ? derived : null;
}

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
    // da7463b4 — the decision is `deriveDobFromIcInput`, shared with the draft screen; what is left here
    // is this screen's MECHANISM, the cross-form `.value =` write by DOM id.
    const { status, dob } = deriveDobFromIcInput(raw);
    setShowNote(status === 'unreal');
    if (dob === null) return;
    const dobEl = document.getElementById(dobInputId) as HTMLInputElement | null;
    if (!dobEl) return;
    const next = nextAutofilledDob(dobEl.value, dob, autofilledRef.current);
    if (next !== null) {
      dobEl.value = next;
      autofilledRef.current = next;
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
