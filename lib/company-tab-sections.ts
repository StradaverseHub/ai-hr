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
 * form — is bucket (a) by every test and still keeps its own button, because it is drawn on the
 * STATUTORY tab and a scope cannot span two tab panes. Moving the card to General to win a tidier button
 * would reverse r226's deliberate placement (pinned by test/company-panel-bank-statutory-layout.test.ts),
 * and leaving a one-card scope on the Statutory tab would put a Save/Discard bar above eight statutory
 * body editors it does not own. Finding 1 of the audit has the full argument, and the reporter is owed
 * that sentence rather than a silent omission.
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
