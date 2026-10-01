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
