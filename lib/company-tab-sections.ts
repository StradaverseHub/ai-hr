/**
 * 65b22c00 — the sections ONE "Save Changes" owns on Organization → a company → General, and the ORDER
 * the consolidated action writes them in.
 *
 * This list is the contract between three files that cannot see each other: the panel marks each card
 * `data-save-section="<id>"`, the client scope packs the dirty ones into one payload keyed by that id
 * (lib/tab-save-dom.ts), and `saveCompanyGeneralTabAction` unpacks them and calls each card's own
 * service. It lives outside app/admin/actions.ts because that file carries `'use server'`, where only
 * async functions may be exported.
 *
 * WHY ONLY THESE THREE, AND WHY THE STATUTORY NUMBERS ARE NOT AMONG THEM.
 * docs/audits/65b22c00-organization-save-classification.md sorts all thirteen bindings on the screen into
 * (a) field edits on the `company` row, which consolidate, and (b) record lifecycle — deleting the
 * company, archiving it, adding or removing a bank account, configuring or clearing a statutory body,
 * uploading or removing the logo. Bucket (b) is NOT here and must never be added: those are discrete
 * acts, and a tab-wide "Discard Changes" that appeared to undo a deleted company would be a control
 * lying about what it does.
 *
 * Bucket (a) has FOUR members, and only three are here. The fourth — the SSM / MyInvois registrations
 * form — is bucket (a) by every test and is drawn on the STATUTORY tab, and a scope cannot span two tab
 * panes. Moving the card to General to win a tidier button would reverse r226's deliberate placement
 * (pinned by test/company-panel-bank-statutory-layout.test.ts). Finding 1 of the audit has the full
 * argument, and the reporter was owed that sentence rather than a silent omission.
 *
 * ⚠️ 15e5bd93 (r352) GAVE THE STATUTORY TAB A CONSOLIDATED SAVE OF ITS OWN, AND 15e5bd93 REVISION 2
 * (r353) TOOK IT BACK OUT. That is not a flip-flop, it is the reporter contesting the premise: r352 could
 * consolidate the fourth member only because it had removed the Save buttons from the eight statutory body
 * editors on the same tab, and the contest rejects those editors being on the tab at all ("Do not expand
 * the statutory settings directly within the existing Statutory tab"). With the editors on a dedicated
 * screen, the registrations card is alone on the tab and a sticky bar over one two-field card is the
 * "worse than none" finding 1 named — so it has its own Save button again. `lib/company-statutory-tab-
 * sections.ts` is retired with the action it declared the vocabulary for. ONE scope on this screen, and
 * this list is still only about General.
 *
 * THE ORDER IS THE READING ORDER, and that is a real choice rather than a default. Unlike the personnel
 * tabs, these three writers touch DISJOINT columns of the same row — `updateCompany` writes the identity
 * and address columns, `setCompanyDefaultPayrollCycle` writes `default_payroll_cycle`, `setCompanyParent`
 * writes `parent_company_id` — so none can undo another and no order is load-bearing. It is declared
 * anyway, and pinned, because a fixed write order is what keeps the outcome independent of DOM order and
 * of which field the administrator touched first, and because the next section added here may not be
 * disjoint.
 */
export const COMPANY_GENERAL_TAB_SECTION_ORDER = ['company', 'cycle', 'parent'] as const;

export type CompanyGeneralTabSection = (typeof COMPANY_GENERAL_TAB_SECTION_ORDER)[number];
