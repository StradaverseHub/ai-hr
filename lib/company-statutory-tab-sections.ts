/**
 * 15e5bd93 (r352) — the sections ONE "Save Changes" owns on Organization → a company → STATUTORY, and
 * the ORDER the consolidated action writes them in.
 *
 * The sibling of lib/company-tab-sections.ts, and it exists for the same three-file reason: the panel
 * marks each card `data-save-section="<id>"`, the client scope packs the dirty ones into one payload
 * keyed by that id (lib/tab-save-dom.ts), and `saveCompanyStatutoryTabAction` unpacks them and calls
 * each card's own service. It lives outside the `'use server'` action module because that file may only
 * export async functions.
 *
 * ── WHY THIS TAB NOW HAS A SCOPE AT ALL, AND WHAT IT RESOLVES ─────────────────────────────────────
 * docs/audits/65b22c00-organization-save-classification.md Finding 1 sorted the company screen's
 * thirteen bindings into (a) field edits and (b) record lifecycle, found FOUR (a) forms, and could only
 * consolidate three: `TabSaveScope` cannot span two tab panes, and the fourth — the SSM / MyInvois
 * registrations card — is drawn on the Statutory tab. That round's own note said a one-card scope here
 * would be worse than none, because a sticky bar would sit above "eight statutory-body editors it does
 * not own".
 *
 * 15e5bd93 removes the premise rather than working around it: the reporter's approved redesign puts the
 * eight bodies in a permanent left-hand rail with ONE workspace, under ONE Save for the whole tab. The
 * eight editors are now cards this bar DOES own, so the registrations card joins them instead of
 * keeping a lonely second button, and it stays exactly where r226 put it. Finding 1 is answered, not
 * side-stepped.
 *
 * ── WHAT IS STILL BUCKET (b) AND MUST NEVER BE ADDED HERE ─────────────────────────────────────────
 * `removeCompanyStatutoryAuthorityAction` — "Clear this authority" DELETES the body's row. It is a
 * discrete act, it keeps its own button outside the section marker, and a tab-wide "Discard Changes"
 * that appeared to undo it would be a control lying about what it does.
 *
 * ── THE ORDER IS THE READING ORDER, AND HERE IT IS LOAD-BEARING ───────────────────────────────────
 * Unlike the General tab's three disjoint writers, two sections on THIS tab can reach the same row:
 * `company_statutory_my` holds SSM + MyInvois (the identity card) AND the EPF / SOCSO / LHDN filing
 * numbers and the HRD Corp band (each on its own body). They do not collide today because the writer is
 * a PARTIAL PATCH and each form posts only its own boxes — but "they do not collide" is a property of
 * the writer, not of the order, so the order is declared and pinned anyway. Identity first, then the
 * bodies in the controlled set's own order, which is also the order the rail draws them in.
 */
import { STATUTORY_AUTHORITIES } from './statutory-authorities';

/** The SSM / MyInvois registrations card — the company's own filing identity, not a body it pays. */
export const STATUTORY_IDENTITY_SECTION = 'identity';

/**
 * Every section id the Statutory tab's consolidated Save owns, in write order.
 *
 * A body's section id IS its authority key, so the server can force the `authority` it writes from the
 * validated section id rather than trusting the form's own hidden copy — the same move
 * `companySectionFormData` makes for the company id, and for the same reason.
 */
export const COMPANY_STATUTORY_TAB_SECTION_ORDER = [
  STATUTORY_IDENTITY_SECTION,
  ...STATUTORY_AUTHORITIES,
] as const;

export type CompanyStatutoryTabSection = (typeof COMPANY_STATUTORY_TAB_SECTION_ORDER)[number];
