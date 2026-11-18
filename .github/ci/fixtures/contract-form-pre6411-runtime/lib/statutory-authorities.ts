/**
 * The statutory bodies a Malaysian employer pays (R46 orgbank 84719377).
 *
 * Lives in lib/ (not core/) because BOTH the server service and the client Company panel need it, and
 * core/statutory-authority.ts pulls in the DB client. core/ re-exports this so service callers keep one
 * import site.
 *
 * Controlled in CODE, not a pgEnum — migration 0275 exists precisely because a 4-value pgEnum had to be
 * widened, and this set will grow. Adding an authority is a one-line change here with no migration.
 *
 * ⚠ Confirm the list with the client before go-live: it covers the bodies named in the request (EPF,
 * SOCSO, EIS, LHDN, HRD Corp, Zakat) plus the common third-party payroll deduction bodies.
 */
export const STATUTORY_AUTHORITIES = [
  'epf', // KWSP — Employees Provident Fund
  'socso', // PERKESO — Social Security Organisation
  'eis', // SIP — Employment Insurance System (administered by PERKESO)
  'lhdn', // Inland Revenue Board — PCB / CP38
  'hrdf', // HRD Corp — levy under the PSMB Act 2001
  'zakat', // State religious council — zakat via salary deduction
  'ptptn', // National Higher Education Fund loan repayments
  'tabung_haji', // Lembaga Tabung Haji savings deduction
  // efe424b0 (r327) — 'koperasi' STOOD HERE and is deliberately gone. The reporter asked for
  // Co-operative to be removed, and it cost nothing to do: measured on production 2026-09-22,
  // `company_statutory_authority` is the ONLY table in the schema with an `authority` column and it held
  // ZERO koperasi rows across the single tenant. This list is controlled in CODE rather than a pgEnum
  // (see the header), so removing one is a one-line change with no migration — exactly as adding one is.
  //
  // `isStatutoryAuthority` now rejects the string, which is what makes a stale value from anywhere
  // unreachable rather than rendered as a nameless tile.
] as const;

export type StatutoryAuthority = (typeof STATUTORY_AUTHORITIES)[number];

export function isStatutoryAuthority(v: string | null | undefined): v is StatutoryAuthority {
  return !!v && (STATUTORY_AUTHORITIES as readonly string[]).includes(v);
}
