/**
 * Employee ID (employee_code) — the ONE shared format rule + display helpers (feedback 38668d9b).
 *
 * The rule: an Employee ID is alphanumeric, max 30 characters, and reads to the LEFT of the name
 * everywhere it appears. HR keys it in at hire (singly or in bulk) and can correct it later; the
 * system only validates it (letters/numbers, max 30) and that it is not already used by another employee.
 * The original 9-char cap (38668d9b) was lifted by feedback de2823cc: the numbering engine must accept
 * long company/group formats (e.g. CHINHIN-HQ-000001-MY); 30 is a generous practical ceiling so IDs still
 * fit on payslips, reports and screens.
 *
 * This file has NO server (DB) imports so the hire form, the bulk-import validator, the edit action and
 * the core service can all share exactly one normalization + validation contract. The dash is allowed
 * deliberately so existing auto codes (EMP-0001) and common client formats (E-1001) stay valid.
 */

/** Max characters an Employee ID may have (practical ceiling, feedback de2823cc — was 9). */
export const EMPLOYEE_CODE_MAX_LEN = 30;

/** Allowed shape after normalization: uppercase letters, digits and dashes, 1..30 chars. */
export const EMPLOYEE_CODE_RE = /^[A-Z0-9-]{1,30}$/;

/**
 * Normalize a keyed-in Employee ID to its canonical stored form: trim surrounding whitespace and
 * uppercase. Case-insensitive so "emp-0001" and "EMP-0001" are the same identifier (uniqueness is
 * checked on the normalized value).
 */
export function normalizeEmployeeCode(raw: string | null | undefined): string {
  return (raw ?? '').trim().toUpperCase();
}

/** True when `raw` (after normalization) is a valid Employee ID. */
export function isValidEmployeeCode(raw: string | null | undefined): boolean {
  return EMPLOYEE_CODE_RE.test(normalizeEmployeeCode(raw));
}

/**
 * Normalize + validate in one step. Returns the canonical value, or throws a clear, user-facing error
 * (surfaced verbatim through the action → redirect error param, matching the plain-English convention of
 * updatePerson's "Name is required").
 */
export function requireEmployeeCode(raw: string | null | undefined): string {
  const code = normalizeEmployeeCode(raw);
  if (!code) throw new Error('Employee ID is required');
  if (code.length > EMPLOYEE_CODE_MAX_LEN)
    throw new Error(`Employee ID must be at most ${EMPLOYEE_CODE_MAX_LEN} characters`);
  if (!EMPLOYEE_CODE_RE.test(code))
    throw new Error('Employee ID may only contain letters, numbers and dashes');
  return code;
}

/**
 * Plain-string "CODE · Name" label for places a React component cannot render — `<option>` labels and
 * document/title strings. When there is no code it degrades to just the name.
 */
export function employeeLabel(code: string | null | undefined, name: string): string {
  const c = (code ?? '').trim();
  return c ? `${c} · ${name}` : name;
}
