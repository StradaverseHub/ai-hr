/**
 * 15e5bd93 REVISION 4 (r370) — the sections ONE "Save all changes" owns on the dedicated Statutory
 * Payment Setup SCREEN, and the ORDER the consolidated action writes them in.
 *
 * ── RESTORED FROM r352 (d991c149), RE-POINTED, NOT REINVENTED ─────────────────────────────────────
 * r352 built this vocabulary for a rail-plus-workspace inside the company panel's Statutory TAB; r353
 * deleted it with that shape. The file name is the one it was born with and is kept so the approved
 * plan's own words still resolve — the surface it serves is now
 * `app/admin/organization/[companyId]/statutory/page.tsx`, a screen, not a tab.
 *
 * It is the contract between three files that cannot see each other: the screen marks each body's form
 * `data-save-section="<authority>"`, the client scope packs the dirty ones into one payload keyed by
 * that id (lib/tab-save-dom.ts), and `saveCompanyStatutoryTabAction` unpacks them and calls that body's
 * own service. It lives outside the `'use server'` action module because that file may only export
 * async functions.
 *
 * ── WHAT IS NOT HERE, AND THE TWO REASONS ────────────────────────────────────────────────────────
 *
 * 1. `identity` — the SSM / MyInvois registrations card. r352's order opened with it, because r352's
 *    scope enclosed that card. THIS screen prints the statutory identity READ-ONLY at the top (the
 *    approved plan: "The company's statutory identity stays at the top of the screen, read-only, so you
 *    can confirm whose configuration you are editing before you touch it"), and SSM / MyInvois keep
 *    their one editor on the company panel's Statutory tab, where r226 put them. A section id in this
 *    vocabulary that no card on the screen carries is a door onto `company_statutory_my` that nothing on
 *    the screen can be seen to open — CLAUDE.md §8's "a screen that holds a server action it never
 *    submits is how the next round re-adds half a feature". So the vocabulary is exactly the eight
 *    bodies the screen can actually post.
 *
 *    The FILING numbers (EPF employer no., SOCSO employer code, LHDN E-number, the HRD Corp band) still
 *    reach `company_statutory_my` — through each BODY's own section, as a partial patch, exactly as
 *    r226 designed and as the per-body form has always done.
 *
 * 2. `removeCompanyStatutoryAuthorityAction` — "Clear this authority" DELETES the body's row. Bucket (b)
 *    of docs/audits/65b22c00-organization-save-classification.md: a discrete act, its own form OUTSIDE
 *    the section marker, and a screen-wide Save that appeared to cover it would be a control lying about
 *    what it does.
 *
 * ── THE ORDER IS THE READING ORDER, AND HERE IT IS LOAD-BEARING ───────────────────────────────────
 * Unlike the General tab's three disjoint writers, two sections here can reach the same ROW:
 * `company_statutory_my` carries EPF's, SOCSO's and LHDN's filing numbers and HRD Corp's band, one per
 * body. They do not collide today because the writer is a PARTIAL PATCH and each card posts only its own
 * boxes — but "they do not collide" is a property of the writer, not of the order, so the order is
 * declared and pinned anyway. It is the controlled set's own order, which is also the order the screen
 * draws the cards in.
 */
import { STATUTORY_AUTHORITIES } from './statutory-authorities';

/**
 * Every section id the statutory screen's consolidated Save owns, in write order.
 *
 * A body's section id IS its authority key, so the server can force the `authority` it writes from the
 * validated section id rather than trusting the form's own hidden copy — the same move
 * `statutorySectionFormData` makes for the company id, and for the same reason.
 */
export const COMPANY_STATUTORY_TAB_SECTION_ORDER = [...STATUTORY_AUTHORITIES] as const;

export type CompanyStatutoryTabSection = (typeof COMPANY_STATUTORY_TAB_SECTION_ORDER)[number];
