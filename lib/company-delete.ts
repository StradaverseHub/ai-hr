/**
 * f00bd1eb — why a company cannot be deleted, as a closed list both sides of the wire share.
 *
 * Pure and dependency-free, so the company panel (a client component) and the server action can both import
 * it: the panel opens the refusal with the reason's sentence, and the action answers a refused delete with
 * the SAME sentence. The decision itself is made from core/company-refs.ts; this file only names its answers.
 */

/** The three refusals, in the order they are tested: an employee record outranks payroll, which outranks
 *  a remaining link. */
export const COMPANY_DELETE_BLOCKS = ['employees', 'payroll', 'other'] as const;
export type CompanyDeleteBlock = (typeof COMPANY_DELETE_BLOCKS)[number];

/** admin.organization message key per refusal — one map, read by the panel's dialog and by the action. */
export const COMPANY_DELETE_REFUSAL_KEY = {
  employees: 'deleteRefusedEmployees',
  payroll: 'deleteRefusedPayroll',
  other: 'deleteRefusedOther',
} as const satisfies Record<CompanyDeleteBlock, string>;

export function isCompanyDeleteBlock(v: unknown): v is CompanyDeleteBlock {
  return typeof v === 'string' && (COMPANY_DELETE_BLOCKS as readonly string[]).includes(v);
}
