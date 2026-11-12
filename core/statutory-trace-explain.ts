/**
 * Item 69d6ed3c — READ THE STATUTORY TRACE v1 A PAYSLIP CARRIES, OR SAY IT IS NOT RECORDED.
 *
 * `statutory.statutoryTrace` is written by the payroll run itself (core/payroll.ts, from the country pack's
 * own lookups): which pay items made up the EPF and SOCSO/EIS wages, which KWSP Third Schedule / PERKESO /
 * EIS row the wages fell in, and the employee and employer amounts that row gives. This module only READS
 * it, under the same rule as core/statutory-explain.ts: NEVER RECOMPUTE. It imports no pack, no kernel and
 * no session, so it cannot.
 *
 * A TRACE IS SHOWN ONLY WHEN IT AGREES WITH THE PAYSLIP IT SITS ON — the pattern of `readHrdfWorking`:
 *   · its shape is v1;
 *   · each base's item lines add up to that base;
 *   · the amounts it says this run charged are the payslip's own amounts (or, for a line a person set by
 *     hand under Statutory Adjustment, the system figure that adjustment recorded);
 *   · on a single run the row's amounts are this run's amounts; on a delta run this run's amounts are the
 *     whole month's less what the earlier runs were charged.
 * Anything else — hand-edited, half written, or simply a payslip processed before this item — reads as
 * "working not recorded". A trace that does not reconcile with the figure beside it is worse than none.
 */
import { z } from 'zod';

const money = z.number();
const nonneg = z.number().nonnegative();
const band = z.object({ from: nonneg, upTo: nonneg, aboveTable: z.literal(true).optional() });
const lookup = z.object({
  method: z.enum(['schedule_row', 'schedule_formula', 'flat_rate', 'no_contribution', 'exempt', 'election_working']),
  base: nonneg,
  band: band.optional(),
  employeeRate: nonneg.optional(),
  employerRate: nonneg.optional(),
  scheduleEmployee: nonneg,
  scheduleEmployer: nonneg,
  raisedByElection: z.literal(true).optional(),
});
const epfTrace = lookup.extend({
  part: z.enum(['A', 'E']).nullable(),
  mode: z.string(),
  age: z.number().nullable(),
  citizenship: z.enum(['citizen', 'pr', 'non_citizen']),
  normalWage: nonneg,
  bonusWage: nonneg,
  employee: nonneg,
  employer: nonneg,
  employeeOnBonus: nonneg,
  normalOnly: lookup.optional(),
  bonusEmployer: z.object({ rate: nonneg, amount: nonneg }).optional(),
  flatLegs: z.object({
    normal: z.object({ employee: nonneg, employer: nonneg }),
    bonus: z.object({ employee: nonneg, employer: nonneg }),
  }).optional(),
  notApplicable: z.enum(['age_75_plus', 'exempt']).optional(),
  manualEmployee: z.literal(true).optional(),
  manualEmployer: z.literal(true).optional(),
});
const schedule = <R extends [string, ...string[]]>(reasons: R) => z.object({
  wage: nonneg,
  band: band.optional(),
  scheduleEmployee: nonneg.optional(),
  scheduleEmployer: nonneg.optional(),
  employee: nonneg,
  employer: nonneg,
  notApplicable: z.enum(reasons).optional(),
});
const socsoTrace = schedule(['not_subject', 'category_none']).extend({ category: z.union([z.literal(1), z.literal(2)]) });
const skbbkTrace = schedule(['not_subject', 'not_in_ruleset']);
const eisTrace = schedule(['age_60_plus', 'non_citizen', 'category_none', 'not_eligible']);
const amounts = z.object({
  epfEmployee: nonneg, epfEmployer: nonneg, socsoEmployee: nonneg, socsoEmployer: nonneg,
  socsoSkbbk: nonneg, eisEmployee: nonneg, eisEmployer: nonneg,
});
const line = z.object({
  kind: z.enum(['basic', 'item', 'unpaid', 'overtime', 'earlier_runs', 'other']),
  code: z.string().optional(),
  name: z.string().optional(),
  amount: money.optional(),
  epf: z.boolean().optional(),
  epfBonus2012: z.boolean().optional(),
  socso: z.boolean().optional(),
  epfNormal: money,
  epfBonus: money,
  socsoEis: money,
});
const traceSchema = z.object({
  version: z.literal(1),
  rulesetVersion: z.string(),
  epfScheduleEffectiveFrom: z.string().optional(),
  epf: epfTrace,
  socso: socsoTrace,
  skbbk: skbbkTrace,
  eis: eisTrace,
  items: z.array(line),
  run: z.object({
    kind: z.enum(['single', 'additional', 'restate', 'post_employment']),
    own: z.object({ epfAdditional: nonneg, socsoWageExtra: nonneg }),
    earlier: z.object({
      runs: z.number().int().nonnegative(),
      unstamped: z.number().int().nonnegative(),
      additional: nonneg,
      epfAdditional: money,
      socsoWageExtra: nonneg,
    }).optional(),
    before: z.object({ epf: epfTrace, socso: socsoTrace, skbbk: skbbkTrace, eis: eisTrace }).optional(),
    // What the earlier runs were charged can be negative on a restating run's arithmetic, so not `nonneg`.
    chargedBefore: z.object({
      epfEmployee: money, epfEmployer: money, socsoEmployee: money, socsoEmployer: money,
      socsoSkbbk: money, eisEmployee: money, eisEmployer: money,
    }).optional(),
    thisRun: amounts,
  }),
});

export type StatutoryTraceRecord = z.infer<typeof traceSchema>;
export type StatutoryTraceLineRecord = z.infer<typeof line>;
export type StatutoryTraceAmountKey = keyof z.infer<typeof amounts>;
export const STATUTORY_TRACE_AMOUNT_KEYS: readonly StatutoryTraceAmountKey[] = [
  'epfEmployee', 'epfEmployer', 'socsoEmployee', 'socsoEmployer', 'socsoSkbbk', 'eisEmployee', 'eisEmployer',
];

/** 'absent' — a payslip processed before the trace existed; 'invalid' — present but does not reconcile. */
export type StatutoryTraceStatus = 'recorded' | 'absent' | 'invalid';

const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * @param raw       `statutory.statutoryTrace` exactly as stored.
 * @param expected  per amount key, the figure the trace must explain: the payslip's own amount, or the
 *                  system figure a Statutory Adjustment recorded for a line a person typed.
 */
export function readStatutoryTrace(
  raw: unknown,
  expected: Record<StatutoryTraceAmountKey, number>,
): { status: StatutoryTraceStatus; trace: StatutoryTraceRecord | null } {
  if (raw === undefined || raw === null) return { status: 'absent', trace: null };
  const parsed = traceSchema.safeParse(raw);
  if (!parsed.success) return { status: 'invalid', trace: null };
  const t = parsed.data;
  const invalid = { status: 'invalid' as const, trace: null };

  // 1. The item lines add up to the wages each lookup was made on.
  const sum = (k: 'epfNormal' | 'epfBonus' | 'socsoEis') => t.items.reduce((acc, l) => r2(acc + l[k]), 0);
  if (!near(sum('epfNormal'), t.epf.normalWage) || !near(sum('epfBonus'), t.epf.bonusWage) || !near(sum('socsoEis'), t.socso.wage)) return invalid;

  // 2. What the trace says this run charged IS what the payslip carries.
  for (const k of STATUTORY_TRACE_AMOUNT_KEYS) if (!near(t.run.thisRun[k], expected[k])) return invalid;

  // 3. …and it follows from the rows shown.
  const month: Record<StatutoryTraceAmountKey, number> = {
    epfEmployee: t.epf.employee, epfEmployer: t.epf.employer,
    socsoEmployee: t.socso.employee, socsoEmployer: t.socso.employer,
    socsoSkbbk: t.skbbk.employee, eisEmployee: t.eis.employee, eisEmployer: t.eis.employer,
  };
  if (t.run.kind === 'single') {
    for (const k of STATUTORY_TRACE_AMOUNT_KEYS) if (!near(month[k], t.run.thisRun[k])) return invalid;
  } else {
    const before = t.run.chargedBefore;
    if (!before) return invalid;
    for (const k of STATUTORY_TRACE_AMOUNT_KEYS) if (!near(Math.max(0, r2(month[k] - before[k])), t.run.thisRun[k])) return invalid;
  }
  return { status: 'recorded', trace: t };
}
