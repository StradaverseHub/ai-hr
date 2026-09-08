/**
 * 420ebab5 part two — the sections one "Save Changes" button owns on the Personnel → Profile tab, and the
 * ORDER the consolidated action writes them in.
 *
 * This list is the contract between three files that cannot see each other: the server page marks each
 * card `data-save-section="<id>"`, the client scope packs the dirty ones into one payload keyed by that id
 * (lib/tab-save-dom.ts), and `saveProfileTabAction` unpacks them and calls each card's own service. It
 * lives outside `actions.ts` because that file carries `'use server'`, where only async functions may be
 * exported.
 *
 * WHY ONLY THESE FIVE. docs/audits/420ebab5-personnel-save-classification.md sorts all 35 forms on the
 * employee detail screen into (a) field edits on the person/employment record, which consolidate, and
 * (b) child-record lifecycle — add/edit/archive a dependant, a qualification, an emergency contact, a CP38
 * order, an encashment adjustment, a compensation revision, a pay item. Bucket (b) is NOT here and must
 * never be added: those are discrete acts, several of them move money, and a tab-wide "Discard Changes"
 * that appeared to cover a recorded salary revision would be a control lying about what it does. The
 * Profile tab's own bucket (b) forms (emergency contacts) are rendered OUTSIDE the save scope entirely, so
 * the fence is structural rather than a list that could rot.
 *
 * WHY THE ORDER IS FIXED AND NOT THE CLIENT'S. Two of these cards write through the SAME service
 * (`updatePerson`): Personal Details owns the name, Contact & Address owns the email/phone, and each posts
 * the other's value as a hidden input so that saving one alone cannot null the other's column. The client
 * re-points those hidden mirrors at the live values before submitting (lib/tab-save-dom.ts
 * `syncCarriedValues`) — that is what makes saving both at once safe — and writing in a declared order on
 * top of it means the outcome never depends on DOM order or on which field the user touched first.
 */

/**
 * THE WIRE FORMAT. Every field a section contributes to the consolidated payload is namespaced
 * `section.<id>.<field>`, and `sections` names the dirty ids. Namespacing rather than flattening is not
 * tidiness: `fullName` is a real input on Personal Details and a hidden carry-through on Contact &
 * Address, so one flat bag would collide them, and a writer that reads an ABSENT field as "leave as-is"
 * would start seeing fields its own form deliberately no longer carries.
 */
export const SECTION_FIELD_PREFIX = 'section';
export const SECTIONS_FIELD = 'sections';

export const PROFILE_TAB_SECTION_ORDER = ['person', 'compliance', 'contact', 'ic', 'passport'] as const;

export type ProfileTabSection = (typeof PROFILE_TAB_SECTION_ORDER)[number];

export function isProfileTabSection(value: string): value is ProfileTabSection {
  return (PROFILE_TAB_SECTION_ORDER as readonly string[]).includes(value);
}

/**
 * What a consolidated per-tab save reports back.
 *
 * NOT a redirect, unlike every per-card action on this screen. A redirect cannot say WHICH of five writes
 * failed, and the classification's own constraint is that the consolidated save "surface a per-section
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
