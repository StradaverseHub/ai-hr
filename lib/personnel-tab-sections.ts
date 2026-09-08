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

/**
 * r255 — there is no per-tab `isXSection` guard any more, and the absence is deliberate. One shared
 * `runTabSave` (app/admin/personnel/[employmentId]/actions.ts) validates every request against THE TAB'S
 * OWN order list, so the vocabulary and the write order are the same declaration and cannot drift apart.
 * A hand-written guard per tab was four chances for one to be forgotten on a new tab, which would let a
 * section name the tab does not own reach a writer.
 */

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

/**
 * ── r255 · THE REMAINING TABS ────────────────────────────────────────────────────────────────────────
 *
 * r254 shipped the Profile tab. These are the other three tabs whose bucket (a) forms could be folded
 * under one Save honestly. Each list is that tab's own section ids, IN THE ORDER the consolidated action
 * writes them; the reasoning for each order is on the constant.
 *
 * Payroll is deliberately ABSENT and must not be added without re-doing the classification: its three
 * field edits (`setPaymentMethod`, `assignPolicy`, `setTp3`) sit among six child-record cards including
 * the effective-dated salary revision, and one of them — Payment Method — is rendered INSIDE the Basic
 * Salary card itself. A Save/Discard pair at the foot of that tab would read as covering a recorded
 * revision, which is the exact control-that-lies the classification exists to prevent. Family and
 * Qualification are absent for the opposite reason: they have no bucket (a) form at all, so a tab-wide
 * Save would have nothing to save.
 */

/**
 * Bank & Statutory. The ONLY tab with no bucket (b) form at all, so its Save covers the whole tab with
 * nothing left over.
 *
 * THE ORDER IS NOT ARBITRARY AND IS NOT THE CLIENT'S. `setStatutoryProfileMY` is a FULL-ROW overwrite of
 * the columns it writes, and `setStatutoryAction` therefore reads the stored row and passes back every
 * column its own form no longer carries (bank, tax, TP3, zakat). Two consequences:
 *
 *  1. It must run FIRST. It writes `isResident` on every save, and the Income Tax card's setter
 *     (`setTaxProfileMY`) re-derives that same column from `taxResidency`. With tax LAST, a save of both
 *     cards ends with the residency the admin actually chose; the other way round the statutory write
 *     would land on top of it.
 *  2. Its pass-throughs read the row AT THE MOMENT IT RUNS, so whichever of bank/tax has already
 *     committed is what it carries forward. Running it first means it carries the stored values forward
 *     and the partial writers then land their own — no ordering hazard either way, which is why bank and
 *     others follow rather than lead.
 */
export const BANK_STATUTORY_TAB_SECTION_ORDER = ['statutory', 'tax', 'bank', 'others'] as const;

/**
 * Attendance. Two of the tab's four cards are bucket (b) — Work Location and Shift Arrangement both
 * append a DATED record (a transfer movement event, a shift period) rather than overwriting a value —
 * so they keep their own buttons and are rendered ABOVE the save scope, outside it.
 *
 * The three here are independent writers on the employment row with no shared column, so the order is
 * simply the reading order of the cards.
 */
export const ATTENDANCE_TAB_SECTION_ORDER = ['holiday', 'clocking', 'geofencing'] as const;

/**
 * Employment (the `job` tab). One section: the Employment Dates card.
 *
 * ABSENT IS NOT BLANK here more sharply than anywhere else on the screen. `setEmploymentInfo` reads an
 * absent field as "leave as-is" and a present-but-empty one as "clear to NULL", and this card
 * deliberately no longer carries the eight flat org columns or the two service dates. The namespaced
 * wire format is what keeps that true: the section is unpacked back into exactly the fields the card
 * posted, so a field the card dropped stays dropped.
 *
 * The tab's other three cards — the company transfer, the Direct Superior reporting line and the
 * delegations — are bucket (b) (an audited transfer with a pre-transaction gate, a bitemporal line
 * tagged as a movement, and two windowed records) and keep their own buttons.
 */
export const JOB_TAB_SECTION_ORDER = ['employment'] as const;

/**
 * Every consolidated tab and the sections it owns — the single list a guard can read.
 *
 * The classification (docs/audits/420ebab5-personnel-save-classification.md) is a document, and documents
 * rot. This map is the same statement in a form that fails a build: test/personnel-tab-save.test.ts
 * asserts that the `data-save-section` markers actually present in the rendered source are EXACTLY these
 * ids and no others, so a later change that quietly moved a money-affecting child-record form under a
 * tab-wide Save would have to edit this map first — in a file whose whole purpose is to be read.
 */
export const PERSONNEL_TAB_SECTIONS = {
  profile: PROFILE_TAB_SECTION_ORDER,
  bankStatutory: BANK_STATUTORY_TAB_SECTION_ORDER,
  attendance: ATTENDANCE_TAB_SECTION_ORDER,
  job: JOB_TAB_SECTION_ORDER,
} as const;

export type PersonnelSaveTab = keyof typeof PERSONNEL_TAB_SECTIONS;

/** Every section id across every consolidated tab, deduplicated — the marker allow-list. */
export const ALL_PERSONNEL_TAB_SECTIONS: readonly string[] = Object.values(PERSONNEL_TAB_SECTIONS).flatMap(
  (ids) => [...ids],
);
