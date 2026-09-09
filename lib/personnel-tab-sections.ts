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
 * r256 UPDATED THIS NOTE RATHER THAN REPLACING IT. It used to end "Payroll is deliberately ABSENT and
 * must not be added without re-doing the classification", and the two reasons it gave were real: the
 * tab's three field edits sit among six child-record cards including the effective-dated salary revision,
 * and one of them — Payment Method — is rendered INSIDE the Basic Salary card itself. Both were answered
 * rather than waived; see PAYROLL_TAB_SECTION_ORDER below for which mechanism answered which. Family and
 * Qualification are still absent, and for a reason no mechanism can answer: they have no bucket (a) form
 * at all, so a tab-wide Save there would have nothing to save and a tab-wide Discard would cover nothing.
 */

/**
 * Bank & Statutory. The ONLY tab with no bucket (b) form at all, so its Save covers the whole tab with
 * nothing left over.
 *
 * THE ORDER IS NOT ARBITRARY AND IS NOT THE CLIENT'S. `setStatutoryProfileMY` is a FULL-ROW overwrite of
 * the columns it writes, and `setStatutoryAction` therefore reads the stored row and passes back every
 * column its own form no longer carries (bank, tax, TP3, zakat). Its pass-throughs read the row AT THE
 * MOMENT IT RUNS, so whichever of bank/tax has already committed is what it carries forward. Running it
 * FIRST means it carries the stored values forward and the partial writers then land their own on top,
 * which is why bank and others follow rather than lead.
 *
 * WHAT THIS ORDER IS NO LONGER LOAD-BEARING FOR, corrected in r255 after the money path was measured.
 * `applyStatutorySection` used to send `isResident` from a control the Statutory (Malaysia) form has
 * never carried, so it wrote `is_resident = false` on every save and the Income Tax card's setter
 * (`setTaxProfileMY`), which re-derives that column from `taxResidency`, was the only thing that put it
 * back. That made the order the difference between a resident and a flat-rate non-resident — and it left
 * a LONE statutory save (an EPF-number edit and nothing else) writing the wrong tax basis with no second
 * card to correct it. The helper now derives the flag from the stored `tax_residency`, so neither order
 * can move a residency and a lone save cannot either. The order stays declared, and stays pinned by a
 * test, because a fixed write order is what makes the outcome independent of DOM order and of which
 * field the admin touched first.
 */
export const BANK_STATUTORY_TAB_SECTION_ORDER = ['statutory', 'tax', 'bank', 'others'] as const;

/**
 * Attendance. Two of the tab's four cards are bucket (b) — Work Location and Shift Arrangement both
 * append a DATED record (a transfer movement event, a shift period) rather than overwriting a value —
 * so they keep their own buttons and are rendered BELOW the save scope, outside it. (r255 first put them
 * above it, which moved Holiday Calendar off the top of the tab and quietly reversed item 52a30630's
 * "Holiday Calendar pinned first". The scope leads the tab instead, and the Save bar names the cards it
 * owns rather than relying on being last.)
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
 * Payroll — r256, the LAST tab with a bucket (a) form still on its own button, and the one the audit
 * (docs/audits/420ebab5-personnel-save-classification.md, finding 3) held back twice.
 *
 * THE TWO OBJECTIONS, AND WHAT ANSWERED EACH. The audit's finding 3 refused this tab on two grounds, and
 * neither is waived here:
 *
 *  1. "A Save/Discard pair at the foot of that tab would read as covering a recorded salary revision."
 *     Answered by `covers` (r255): the bar prints the names of the cards it owns — "How This Employee Is
 *     Paid", "Payroll policy", "Previous employment this year (TP3 / opening balances)" — so it names a
 *     SUB-SECTION of the Basic Salary card rather than the card, and never claims the revision. The
 *     mechanical half was already true before the label existed: the fence is the MARKER, not the
 *     subtree, so `setCompensationAction`'s dialog is not read, marked, packed or reset even though it
 *     lives inside a card the scope encloses. That is the Employment tab's shape exactly — the audited
 *     company transfer sits inside the same card as the Employment Dates section — and it is why
 *     Payment Method being nested inside Basic Salary stopped being disqualifying.
 *  2. "Consolidating still requires moving TP3 up past Pay Items, CP38 and Leave Encashment."
 *     Not answered — ACCEPTED, and it is the one visible change r256 makes. A tab Save can only enclose a
 *     CONTIGUOUS run, so the three field-edit cards have to lead the tab: Basic Salary (which carries
 *     Payment Method) → Payroll policy → TP3, then the three registers, then the read-only zakat summary.
 *     The audit named this exact shape as the one to build if the reporter wanted the tab, and the
 *     reporter's own request names Payroll among the tabs to consolidate. It reverses no pinned decision:
 *     feedback 326f0b5e pinned compensation FIRST (still first) and R46 79eb7151 pinned the policy card
 *     SECOND (still second); TP3's sixth slot came from item a6a47698 simply appending it on relocation
 *     and was pinned by nothing. test/personnel-payroll-tab-order.test.ts now pins the new run.
 *
 * THE ORDER IS THE READING ORDER, and unlike Bank & Statutory that is not load-bearing. These are three
 * INDEPENDENT writers with no column in common: `setEmploymentPaymentMethod` writes
 * `employment.payment_method`, `assignPolicy` writes `employment.payroll_policy_id`, and `setTp3` writes
 * four columns on the person's statutory row. None is a full-row overwrite, so none can undo a sibling in
 * the same request and no order can change the outcome. It is declared anyway, because every other tab's
 * is, and because a fixed order is what keeps the result independent of DOM order.
 *
 * WHAT IS NOT HERE AND MUST NEVER BE. `compensation` (the effective-dated salary revision — the
 * classification's own worked example of what a Discard must never appear to cover), the pay-item rows,
 * both CP38 forms and both encashment forms. Six of the seven cards on this tab contain a bucket (b)
 * form; only three field edits fold, and they are these.
 */
export const PAYROLL_TAB_SECTION_ORDER = ['payment', 'policy', 'tp3'] as const;

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
  payroll: PAYROLL_TAB_SECTION_ORDER,
} as const;

export type PersonnelSaveTab = keyof typeof PERSONNEL_TAB_SECTIONS;

/** Every section id across every consolidated tab, deduplicated — the marker allow-list. */
export const ALL_PERSONNEL_TAB_SECTIONS: readonly string[] = Object.values(PERSONNEL_TAB_SECTIONS).flatMap(
  (ids) => [...ids],
);
