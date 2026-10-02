/** Annual EA routing consumes processed bucket amounts; it never recalculates payroll. */
import type { StoredComponentLine } from '../../core/payslip-earning-lines';
import type { EaField } from './reports';

export const EA_BUCKET_SOURCE_FIELD = { wage: 'allowances', ot: 'grossSalary', bonus: 'bonus' } as const;

export function accumulateEaRouting(
  lines: readonly StoredComponentLine[],
  mapping: ReadonlyMap<string, string | null>,
  targets: Readonly<Record<string, EaField>>,
  active: boolean,
): { deltas: Partial<Record<EaField, number>>; unmapped: Set<string> } {
  const deltas: Partial<Record<EaField, number>> = {};
  const unmapped = new Set<string>();
  for (const line of lines) {
    const code = (line.code ?? '').trim();
    if (!code) continue;
    const classification = mapping.get(code) ?? null;
    for (const bucket of line.buckets ?? []) {
      const source = EA_BUCKET_SOURCE_FIELD[(bucket.bucket ?? '') as keyof typeof EA_BUCKET_SOURCE_FIELD];
      if (!source) continue;
      const amount = Number(bucket.amount ?? 0);
      if (!Number.isFinite(amount) || amount === 0) continue;
      // A blank taxable income assignment has the approved B1(a) default. Exempt,
      // reimbursement and deduction amounts never become salary through this default.
      const target = classification == null ? 'grossSalary' : targets[classification];
      if (classification == null && !active || classification != null && !target && classification !== 'allowance_exempt') unmapped.add(code);
      if (!active || !target || target === source) continue;
      deltas[source] = (deltas[source] ?? 0) - amount;
      deltas[target] = (deltas[target] ?? 0) + amount;
    }
  }
  return { deltas, unmapped };
}

/** Complete earlier-year evidence, never reconstruction from current pay settings.
 * Item OT is stamped before caps; converted OT has no item allocation consumed by
 * this accumulator. Neither can establish a historical mapping exception.
 */
export function hasCompleteHistoricalEaProvenance(
  slips: readonly { allowance: unknown; bonus: unknown; statutory: unknown }[],
  mapping: ReadonlyMap<string, string | null>,
): boolean {
  const cents = (value: unknown): number | null => {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value))) return null;
    const n = Number(value);
    const rounded = Math.round(n * 100);
    return Number.isFinite(n) && n >= 0 && Number.isSafeInteger(rounded) && Math.abs(n * 100 - rounded) < 1e-7 ? rounded : null;
  };
  if (slips.length === 0) return false;
  return slips.every(slip => {
    const allowance = cents(slip.allowance), bonus = cents(slip.bonus);
    if (allowance === null || bonus === null || !slip.statutory || typeof slip.statutory !== 'object') return false;
    const st = slip.statutory as Record<string, unknown>;
    if (!Array.isArray(st.componentLines) || st.componentLines.length === 0) return false;
    if (st.otConvert !== undefined) {
      if (!st.otConvert || typeof st.otConvert !== 'object' || cents((st.otConvert as Record<string, unknown>).amount) !== 0) return false;
    }
    let wage = 0, reimburse = 0, additional = 0;
    const codes = new Set<string>();
    for (const raw of st.componentLines) {
      if (!raw || typeof raw !== 'object') return false;
      const line = raw as Record<string, unknown>;
      if (typeof line.code !== 'string' || !line.code.trim() || codes.has(line.code.trim()) || !mapping.has(line.code.trim())) return false;
      codes.add(line.code.trim());
      if (!Array.isArray(line.buckets) || line.buckets.length === 0) return false;
      const seenBuckets = new Set<string>();
      for (const rawBucket of line.buckets) {
        if (!rawBucket || typeof rawBucket !== 'object') return false;
        const bucket = rawBucket as Record<string, unknown>;
        if (typeof bucket.bucket !== 'string' || !['wage', 'bonus', 'ot', 'reimburse', 'deduct'].includes(bucket.bucket) || seenBuckets.has(bucket.bucket)) return false;
        seenBuckets.add(bucket.bucket);
        const amount = cents(bucket.amount);
        if (amount === null || (bucket.bucket === 'ot' && amount !== 0)) return false;
        if (bucket.bucket === 'wage') wage += amount;
        if (bucket.bucket === 'reimburse') reimburse += amount;
        if (bucket.bucket === 'bonus') additional += amount;
      }
    }
    let exempt = 0;
    if (st.exemptionUsed !== undefined) {
      if (!st.exemptionUsed || typeof st.exemptionUsed !== 'object' || Array.isArray(st.exemptionUsed)) return false;
      for (const [code, value] of Object.entries(st.exemptionUsed)) {
        const amount = cents(value);
        if (amount === null) return false;
        if (code.startsWith('PCB_')) exempt += amount;
      }
    }
    return [wage, reimburse, additional, exempt, wage + reimburse].every(Number.isSafeInteger) && wage + reimburse === allowance && additional === bonus && exempt <= reimburse;
  });
}
