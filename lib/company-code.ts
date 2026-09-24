/**
 * Item 7d2df42a — "Company Code: should it be required, and must it be unique?"
 *
 * ── THE ANSWER, AND WHY IT IS NOT THE ONE THAT WAS ASKED FOR ──────────────────────────────────────
 * The reporter asked for a COMPULSORY field and an ENFORCED unique rule. We recommended against both
 * and that recommendation was approved, so neither is built here. Their own data is the argument,
 * measured on production 2026-09-24: of 13 companies, 7 hold no code at all, and of the 6 that hold
 * something, one reads "PRIVATE CO." and one holds the entire legal name "ISEDECOR BINA SDN BHD".
 * A compulsory field would block those seven from being saved at all; an enforced unique rule would
 * reject the two odd rows the first time anybody touched any other field on their screen.
 *
 * What ships instead is a WARNING — a READ, never a constraint. When the operator types a code another
 * company already uses, the form says so AND NAMES THAT COMPANY, at the moment it matters, so an
 * accident looks different from an intention. They can still save, and the save still stores what they
 * typed. There is no unique index, no CHECK, no refusal anywhere on this path; the create action's
 * failure redirect (`failCompany`) is never reached by a duplicate, and
 * test/organization-company-code.test.ts asserts all of that against the live schema.
 *
 * ⚠️ NOTHING HERE IS A VALIDATOR. If a future change makes a caller treat `findCompanyCodeClash`
 * returning non-null as a reason to refuse a save, that is the rule change this item explicitly
 * declined. Ask for it; do not slip it in behind a UI round.
 *
 * ── THE TWO SCOPE RULES, STATED ONCE, HERE ────────────────────────────────────────────────────────
 * 1. ARCHIVED COMPANIES DO NOT COLLIDE. A code reused by a company retired years ago is not a
 *    collision worth a warning — it is the normal way a code gets recycled. `companyCodeHolders` is
 *    the ONE place that drops them, so the rule cannot be applied differently on two screens, and an
 *    archived company's NAME is never shipped to the browser by this feature either.
 * 2. THE LOOKUP NEVER LEAVES WHAT THE OPERATOR CAN ALREADY SEE. Both callers feed this from
 *    `listCompanies(s, { adminOnly: true })` — the tenant, narrowed by the database's own
 *    `app.is_admin_for`, which is the same set the Organization listing already shows them by name.
 *    ⚠️ DO NOT "FIX" THIS BY WIDENING THE READ TO THE WHOLE TENANT. The warning NAMES a company, and
 *    naming one this admin cannot administer is exactly the disclosure feedback ab77dc1f was raised
 *    about (see the note on `scopedSession` in lib/scope.ts, and the SCOPE paragraph in
 *    app/admin/organization/page.tsx: "the filter IS the permission boundary"). For a group-wide
 *    hr_admin — the reporter, and realistically anyone creating a company — the two sets are identical.
 *
 * ── AND WHAT "THE SAME CODE" MEANS ────────────────────────────────────────────────────────────────
 * Case- and whitespace-insensitive, because `ASG`, `asg` and `ASG ` are one code to a human and the
 * warning exists to be read by a human. STORAGE IS UNTOUCHED: `core/admin.ts normNullableText` still
 * writes back exactly what was typed (trimmed, blank ⇒ NULL). This key is for COMPARISON only —
 * writing it would be a silent data change nobody asked for.
 */

/** A company that already holds a code, as the warning needs to name it. Built only by `companyCodeHolders`. */
export type CompanyCodeHolder = { id: string; name: string; code: string };

/**
 * The comparison key for a typed code: trimmed, internal whitespace runs collapsed, lower-cased.
 * Returns `''` for anything blank — and a blank code never clashes with anything, because "no code"
 * is a state 7 of 13 production companies are in and is not a collision.
 */
export function companyCodeKey(v: string | null | undefined): string {
  return (v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The companies a duplicate warning may name, from a `listCompanies` read.
 *
 * Drops the codeless (nothing to collide with) and THE ARCHIVED (rule 1 above). Both filters are the
 * feature's rules, not a convenience: revert either one and
 * test/7d2df42a-company-code-duplicate.dom.test.tsx names which rule went.
 */
export function companyCodeHolders(
  rows: readonly { id: string; name: string; companyLabel: string | null; archivedAt: Date | null }[],
): CompanyCodeHolder[] {
  const out: CompanyCodeHolder[] = [];
  for (const r of rows) {
    if (r.archivedAt != null) continue;
    const code = (r.companyLabel ?? '').trim();
    if (code === '') continue;
    out.push({ id: r.id, name: r.name, code });
  }
  return out;
}

/**
 * The company already using `typed`, or null. `excludeId` is the company being EDITED — its own stored
 * code is not a duplicate of itself, or the General tab would warn about every company that has a code
 * the moment it opened.
 */
export function findCompanyCodeClash(
  typed: string | null | undefined,
  holders: readonly CompanyCodeHolder[],
  excludeId?: string | null,
): CompanyCodeHolder | null {
  const key = companyCodeKey(typed);
  if (key === '') return null;
  return holders.find((h) => h.id !== excludeId && companyCodeKey(h.code) === key) ?? null;
}
