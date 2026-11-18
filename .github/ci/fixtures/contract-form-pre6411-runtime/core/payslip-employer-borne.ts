/**
 * Feedback 3c473773 issue 2 — DISCLOSURE of employer-borne statutory contributions.
 *
 * THE ENGINE IS CORRECT AND IS NOT TOUCHED HERE. When "Employer bears EPF / SOCSO / EIS / SKBBK / Tax" is
 * set on Personnel → Bank & Statutory, core/payroll.ts already subtracts the employee's share from
 * `statDeductions` and adds it to `employerCost` (items 5a461b99 / 8b5334db / 0d9bb2da). Measured on the
 * reporter's own payslip: employee shares 2,402.90, employer-borne 710.90, total_deductions 1,692.00 —
 * exact. Nothing about that arithmetic changes.
 *
 * WHAT WAS MISSING IS THE SENTENCE. `employerBorne` was written to the payslip's statutory blob and read by
 * NO screen. The payslip therefore listed "EPF 629.00" as an employee deduction beside a total that did not
 * include it, and nothing on the page reconciled the two. The reporter read the payslip correctly and
 * concluded the setting had been ignored. This module turns the stored snapshot into the three things a
 * payslip needs to say: what actually came off the employee, what the employer funded on their behalf, and
 * which components those were.
 *
 * TWO HARD RULES, each of which this file exists to enforce in one place:
 *
 *  1. READ THE PAYSLIP'S OWN BLOB. Never re-derive from the employee's CURRENT flags. A payslip is a
 *     historical document; re-deriving would make a slip issued before the flag was switched on
 *     retro-explain itself with today's settings. A blob with no `employerBorne` key predates the feature
 *     (or had every flag off) and must render EXACTLY as it does now — hence `any: false` and
 *     `employee === reported`, which is the identity path.
 *
 *  2. THE REPORTED SHARE IS NOT REDUCED. KWSP / PERKESO / LHDN submissions must carry the FULL employee
 *     share — that is why the kernel leaves `st.epfEmployee` et al. untouched. `reported` is that figure and
 *     is what the statutory forms keep using; `employee` is the take-home view and is display-only.
 */

/** The statutory components an employer can bear, as keyed in the payslip blob's `employerBorne` object. */
export const EMPLOYER_BORNE_KEYS = ['epf', 'socso', 'skbbk', 'eis', 'tax'] as const;
export type EmployerBorneKey = (typeof EMPLOYER_BORNE_KEYS)[number];

export type EmployerBorneAmounts = Record<EmployerBorneKey, number>;

export type EmployerBorneView = {
  /** True when this payslip's own blob records at least one component the employer funded. */
  any: boolean;
  /** Per-component amounts the EMPLOYER funded on the employee's behalf (0 where not borne). */
  borne: EmployerBorneAmounts;
  /** Sum of `borne` — the amount by which the employee's statutory deductions were reduced. */
  total: number;
  /** The components actually borne, in payslip order — the named disclosure ("EPF, SOCSO, EIS, SKBBK"). */
  keys: EmployerBorneKey[];
  /** What genuinely came off take-home: the reported share less the part the employer funded. */
  employee: { epf: number; socso: number; skbbk: number; eis: number; pcb: number };
  /** The FULL employee share as computed and as filed. Unchanged by any employer-bears setting. */
  reported: { epf: number; socso: number; skbbk: number; eis: number; pcb: number };
};

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

type Blob = {
  epfEmployee?: unknown;
  socsoEmployee?: unknown;
  socsoSkbbk?: unknown;
  eisEmployee?: unknown;
  pcb?: unknown;
  employerBorne?: Partial<Record<EmployerBorneKey | 'total', unknown>>;
};

/**
 * Derive the employer-borne view from ONE payslip's stored statutory blob.
 *
 * Pure, total, and defensive about shape: a blob is plain jsonb with no validator, so every field is read
 * through `n()` and a missing/garbage `employerBorne` degrades to the identity path rather than throwing on
 * a payslip screen.
 *
 * `total` is recomputed from the parts rather than trusted from the stored `total` key, so a screen can
 * never print a disclosure whose lines do not add up to its own total.
 */
export function payslipEmployerBorne(statutory: unknown): EmployerBorneView {
  const st = (statutory ?? {}) as Blob;
  const reported = {
    epf: n(st.epfEmployee),
    socso: n(st.socsoEmployee),
    skbbk: n(st.socsoSkbbk),
    eis: n(st.eisEmployee),
    pcb: n(st.pcb),
  };
  const raw = st.employerBorne;
  const zero: EmployerBorneAmounts = { epf: 0, socso: 0, skbbk: 0, eis: 0, tax: 0 };
  if (!raw || typeof raw !== 'object') {
    // The pre-feature path: no snapshot, nothing to disclose, render exactly as before.
    return { any: false, borne: zero, total: 0, keys: [], employee: { ...reported }, reported };
  }
  const borne: EmployerBorneAmounts = {
    epf: n(raw.epf),
    socso: n(raw.socso),
    skbbk: n(raw.skbbk),
    eis: n(raw.eis),
    tax: n(raw.tax),
  };
  // Only a POSITIVE amount is a disclosure. A flag that was ticked on a month where the contribution was
  // zero anyway has nothing to say, and a line reading "the company paid RM0.00" is noise, not information.
  const keys = EMPLOYER_BORNE_KEYS.filter((k) => borne[k] > 0);
  const total = r2(keys.reduce((s, k) => s + borne[k], 0));
  return {
    any: keys.length > 0,
    borne,
    total,
    keys,
    employee: {
      // Never below zero: the borne amount IS the employee share by construction, but a hand-edited or
      // partially-migrated blob must not be able to print a negative deduction.
      epf: Math.max(0, r2(reported.epf - borne.epf)),
      socso: Math.max(0, r2(reported.socso - borne.socso)),
      skbbk: Math.max(0, r2(reported.skbbk - borne.skbbk)),
      eis: Math.max(0, r2(reported.eis - borne.eis)),
      pcb: Math.max(0, r2(reported.pcb - borne.tax)),
    },
    reported,
  };
}
