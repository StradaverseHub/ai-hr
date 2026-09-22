/**
 * The wire format a consolidated per-tab Save uses, and what it reports back — shared by every screen
 * that has one.
 *
 * 420ebab5 built this for the personnel detail screen and declared it in lib/personnel-tab-sections.ts.
 * 65b22c00 gave the Organization company panel a consolidated Save too, and a company screen importing
 * `TabSaveResult` from a module called "personnel-tab-sections" would be a statement about where the
 * contract lives that is no longer true. So the three things that were never about personnel move here,
 * and lib/personnel-tab-sections.ts RE-EXPORTS them: one owner, and not a single existing import site
 * has to move to prove it.
 */

/**
 * THE WIRE FORMAT. Every field a section contributes to the consolidated payload is namespaced
 * `section.<id>.<field>`, and `sections` names the dirty ids. Namespacing rather than flattening is not
 * tidiness: on the personnel Profile tab `fullName` is a real input on Personal Details and a hidden
 * carry-through on Contact & Address, so one flat bag would collide them — and a writer that reads an
 * ABSENT field as "leave as-is" would start seeing fields its own form deliberately no longer carries.
 */
export const SECTION_FIELD_PREFIX = 'section';
export const SECTIONS_FIELD = 'sections';

/**
 * What a consolidated per-tab save reports back.
 *
 * NOT a redirect, unlike the per-card actions beside it. A redirect cannot say WHICH of several writes
 * failed, and the classification's own constraint is that a consolidated save "surface a per-section
 * failure rather than a single all-or-nothing error". `saved` names the sections that did commit — the
 * client marks exactly those clean and leaves the rest edited, so a partial failure never silently
 * discards the user's remaining changes.
 */
export type TabSaveResult = {
  ok: boolean;
  saved: string[];
  failedSection?: string;
  error?: string;
};
