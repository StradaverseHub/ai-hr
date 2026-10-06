/** One ordered vocabulary for company display settings and every standard payslip output. */
export const PAYSLIP_INFORMATION_FIELDS = [
  'employee', 'employeeCode', 'identityNumber', 'taxNumber', 'epfNumber', 'socsoNumber',
  'department', 'position', 'jobGrade', 'employmentType', 'businessUnit', 'division',
  'branch', 'region', 'line', 'section', 'team', 'base', 'category', 'daysWorked', 'currency',
  // r392 (23bd49d9) — the four payment facts that used to be appended after every selection whatever the
  // setting said. They are ordinary fields now, at the END of the catalogue and of the defaults, because
  // the end of the block is exactly where they printed before; migration 0513 appends them to every saved
  // row for the same reason, so no issued payslip changes on the day this ships.
  'paymentMethod', 'bankName', 'bankAccount', 'payrollCycle',
] as const;
export type PayslipInformationField = typeof PAYSLIP_INFORMATION_FIELDS[number];
export const DEFAULT_PAYSLIP_INFORMATION_FIELDS: readonly PayslipInformationField[] =
  PAYSLIP_INFORMATION_FIELDS.filter(k => !['businessUnit','division','branch','region','line','section','team','base','category'].includes(k));
/**
 * r389 (23bd49d9) — the company's saved setting IS the order. A stored `fields` array is the ordered list of
 * shown fields, read back exactly as saved: an unknown key is dropped (a renamed field never prints a raw
 * key), a repeated key keeps its FIRST place (a field never prints twice), and anything that is not an array
 * — no row yet — gives the defaults. Before r389 this re-filtered the catalogue, so the stored order was
 * ignored; every row the setter wrote then was already in catalogue order, which is why no existing payslip
 * changes until someone reorders.
 */
export function payslipInformationFields(raw: unknown): readonly PayslipInformationField[] {
  if (!Array.isArray(raw)) return DEFAULT_PAYSLIP_INFORMATION_FIELDS;
  const known = new Set<string>(PAYSLIP_INFORMATION_FIELDS);
  const seen = new Set<string>();
  const ordered: PayslipInformationField[] = [];
  for (const key of raw) {
    if (typeof key !== 'string' || !known.has(key) || seen.has(key)) continue;
    seen.add(key);
    ordered.push(key as PayslipInformationField);
  }
  return ordered;
}
export function selectPayslipInformation(
  data: Partial<Record<PayslipInformationField, unknown>>,
  settings: unknown,
  labels: Record<PayslipInformationField, string>,
): { key: PayslipInformationField; label: string; value: string }[] {
  return payslipInformationFields(settings).flatMap(key => {
    const value = data[key];
    if (value == null || String(value).trim() === '') return [];
    return [{ key, label: labels[key], value: String(value).trim() }];
  });
}

/** r392 (23bd49d9) — the payment facts migration 0513 appends to every saved setting, in catalogue order. */
export const PAYSLIP_PAYMENT_FIELDS = ['paymentMethod', 'bankName', 'bankAccount', 'payrollCycle'] as const satisfies readonly PayslipInformationField[];

/**
 * r392 (23bd49d9) — the TypeScript mirror of migration 0513, for tests: a saved array gains each payment
 * field it does not already name, at the end, in catalogue order; anything that is not an array (no row) is
 * returned unchanged, because "no row" already means the defaults, which now end with the same four.
 */
export function withPaymentFieldsAppended(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return [...raw, ...PAYSLIP_PAYMENT_FIELDS.filter(k => !raw.includes(k))];
}

/**
 * r392 (23bd49d9) — THE VALUES BEHIND THE FOUR PAYMENT FIELDS, built in one place for the review screen and
 * both PDF routes. Each caller used to spread its read row straight into `selectPayslipInformation`, which
 * is wrong for exactly these keys:
 *   - `row.paymentMethod` is the STORED ENUM (`bank_transfer`); a payslip must print the translated word, so
 *     the caller's resolved word is REQUIRED here and always replaces it (null when there is none);
 *   - neither read has a `bankAccount` key, only `bankAccountFull` and `bankAccountMasked`; the payslip
 *     prints the full number (f35f758a, b19042d0), so each caller passes `bankAccount: row.bankAccountFull`;
 *   - `payrollCycle` is not a column at all: it is the caller's `payslipCycleLabel` output.
 * The resolved values are required parameters and always win over the row, so a caller cannot forget one
 * and fall back to whatever the read happens to carry under that name.
 */
export function payslipInformationData(
  row: object,
  resolved: {
    employee: string | null; employmentType: string | null; paymentMethod: string | null;
    bankAccount: string | null; payrollCycle: string | null;
  },
): Partial<Record<PayslipInformationField, unknown>> {
  return { ...(row as Partial<Record<PayslipInformationField, unknown>>), ...resolved };
}
