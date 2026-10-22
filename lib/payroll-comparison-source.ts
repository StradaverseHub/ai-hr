/** Read recorded paid results. Today's pay-item catalogue and company settings are deliberately absent. */
import { payrollAmountMinor, payrollMinorDecimal } from './payroll-period-comparison';
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function recordedPayrollComparisonCurrency(statutory: unknown, companyId: string): string | null {
  const stamp = object(object(statutory)?.reportContext);
  return stamp?.version === 1 && stamp.payingCompanyId === companyId &&
    typeof stamp.currency === 'string' && /^[A-Z]{3}$/.test(stamp.currency) ? stamp.currency : null;
}
/** A present component array is a recorded itemization. An absent array is unavailable history,
 * including an old run with no components: it does not prove that a selected item paid zero. */
export function recordedPayrollComparisonAmount(basicSalary: string, statutory: unknown, code: string): string | null {
  if (code === 'BASIC') return payrollMinorDecimal(payrollAmountMinor(basicSalary));
  const lines = object(statutory)?.componentLines;
  if (!Array.isArray(lines)) return null;
  let amount = 0n;
  for (const entry of lines) {
    const line = object(entry);
    if (!line || typeof line.code !== 'string') return null;
    if (line.code !== code) continue;
    try { amount += payrollAmountMinor(line.amount); } catch { return null; }
  }
  return payrollMinorDecimal(amount);
}
