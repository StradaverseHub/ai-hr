/**
 * THE PERMANENT → CORRESPONDENCE PAIRING, DECLARED ONCE — item da7463b4.
 *
 * "Same as permanent address" existed before this item, but only as a DOM-id island on the activated
 * employee's Contact & Address card (components/same-as-permanent-address.tsx, item 3a25f5ee), with its
 * own private list of field suffixes. The Create New Employee draft is a controlled React form and cannot
 * use that island at all — a programmatic `.value =` write is fought and discarded by a controlled input.
 * Writing a second pair list for the draft is precisely the drift this item was raised about, so the list
 * moved HERE and both screens read it:
 *
 *   · the island resolves `perm-<idSuffix>` / `corr-<idSuffix>` DOM nodes (activated record);
 *   · the draft copies `permanentKey` → `correspondenceKey` inside its own state (draft blob).
 *
 * One table, two renderings. test/address-block-parity.test.ts pins the id half against the markup that
 * actually assigns those ids, and the key half against the `person` columns `updatePerson` writes, so a
 * pair added on one screen cannot silently go missing on the other.
 *
 * CLIENT-SAFE BY CONSTRUCTION: no imports at all. Both consumers are `'use client'` components and the
 * third (core/employee-draft.ts, the activation path) is a server module — none of them may pull the
 * other's dependencies in.
 *
 * THE TWO PHONE PAIRS ARE NOT ADDRESS FIELDS AND ARE IN THE LIST ANYWAY. That is the behaviour item
 * bf953339 shipped on the activated record: the Correspondence block carries its OWN mobile/home pair so
 * the correspondence contact may differ, and ticking the box copies "the full contact picture: address
 * AND both phone numbers". The permanent side of those two is not `permanent*`-prefixed — it is the
 * person's `phone` (the Mobile Phone Number) and `homePhone` — which is exactly why the mapping has to be
 * a declared table rather than a `permanent` → `correspondence` string substitution.
 */

export type AddressCopyPair = {
  /** The DOM id suffix the activated record's markup assigns as `perm-<s>` and `corr-<s>`. */
  idSuffix: string;
  /** The `person` column / draft-profile key on the Permanent (or main contact) side. */
  permanentKey: string;
  /** The `person` column / draft-profile key on the Correspondence side. */
  correspondenceKey: string;
};

export const ADDRESS_COPY_PAIRS: readonly AddressCopyPair[] = [
  { idSuffix: 'addressLine1', permanentKey: 'permanentAddressLine1', correspondenceKey: 'correspondenceAddressLine1' },
  { idSuffix: 'addressLine2', permanentKey: 'permanentAddressLine2', correspondenceKey: 'correspondenceAddressLine2' },
  { idSuffix: 'addressLine3', permanentKey: 'permanentAddressLine3', correspondenceKey: 'correspondenceAddressLine3' },
  { idSuffix: 'postcode', permanentKey: 'permanentPostcode', correspondenceKey: 'correspondencePostcode' },
  { idSuffix: 'city', permanentKey: 'permanentCity', correspondenceKey: 'correspondenceCity' },
  { idSuffix: 'state', permanentKey: 'permanentState', correspondenceKey: 'correspondenceState' },
  { idSuffix: 'country', permanentKey: 'permanentCountry', correspondenceKey: 'correspondenceCountry' },
  // bf953339 — the permanent side of the phone pair is NOT `permanent*`: `phone` IS the Mobile Phone
  // Number (a label-only rename of the pre-existing column) and `homePhone` sits beside it.
  { idSuffix: 'mobile-phone', permanentKey: 'phone', correspondenceKey: 'correspondenceMobilePhone' },
  { idSuffix: 'home-phone', permanentKey: 'homePhone', correspondenceKey: 'correspondenceHomePhone' },
] as const;

/** Just the seven ADDRESS suffixes, in the order both screens render them (no phones). */
export const ADDRESS_FIELD_SUFFIXES = ADDRESS_COPY_PAIRS.slice(0, 7).map((p) => p.idSuffix);

/**
 * "SAME AS PERMANENT" AS A RULE RATHER THAN A BUTTON — item da7463b4's decision, stated in code.
 *
 * A button copies once and walks away; the two addresses then drift the first time somebody corrects the
 * permanent one, which is the reporter's own complaint in miniature. So on a DRAFT the tick is STORED
 * (`EmployeeDraftProfile.sameAsPermanent`) and the correspondence side is DERIVED from the permanent side
 * every time either changes — in the browser as the form is typed, and again on the server in
 * `completeEmployeeDraft`, which is the authority. Untick and the last copied values stay put, editable:
 * from that moment the two are independent, which is the only thing "not the same" can mean.
 *
 * A BLANK PERMANENT FIELD COPIES AS BLANK. `undefined` is written through rather than skipped, because the
 * alternative — "leave the correspondence value alone when the permanent one is empty" — would leave a
 * stale correspondence line behind after HR clears the permanent one, i.e. exactly the drift this exists
 * to prevent.
 *
 * Generic over the record shape so the draft's `EmployeeDraftProfile` and any future caller share it
 * without this module importing either.
 */
export function copyPermanentToCorrespondence<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = { ...value };
  for (const pair of ADDRESS_COPY_PAIRS) {
    out[pair.correspondenceKey] = value[pair.permanentKey];
  }
  return out as T;
}
