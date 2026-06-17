/**
 * Default Malaysia pay-component catalog (Wave 3 #9, ADR-0025). Treatment flags are sourced from
 * docs/architecture/MY-pay-component-treatment-matrix.md (EPF Act s.2 / PERKESO Act 4 s.2(24) /
 * LHDN ITA s.13(1) / HRD Corp Circular 5/2018).
 *
 * The five BACKFILL-CRITICAL codes (BASIC, ALLOWANCE, OVERTIME, BONUS, CLAIM) carry exactly the flags
 * that reproduce the CURRENT payroll kernel, so the typed path is byte-identical when back-filled from
 * compensation + payroll_input:
 *   - BASIC + fixed ALLOWANCE  → EPF + SOCSO/EIS + PCB + HRDF   (the normal wage; in the HRDF base)
 *   - OVERTIME                 → SOCSO/EIS + PCB only           (EPF excludes OT; not in HRDF base)
 *   - BONUS                    → EPF + PCB only                 (additional remuneration; SOCSO excludes bonus)
 *   - CLAIM (taxable, ADR-0021)→ EPF + SOCSO/EIS + PCB, NOT HRDF (rides the taxable allowance base)
 *
 * v1 supports earning components that map to the calculator's normal-wage / overtime / additional
 * buckets via their (EPF, SOCSO) flags, all-false "reimbursement" earnings (paid but untaxed), and
 * deductions (reduce net). PCB-only and non-payable (BIK) components are NOT computed in v1 (see ADR §5)
 * and are deliberately not seeded.
 */
export type PayComponentKind = 'allowance' | 'deduction' | 'contribution' | 'non_payable';

export type PayComponentSeed = {
  code: string;
  name: string;
  kind: PayComponentKind;
  includedInEpf: boolean;
  includedInSocsoEis: boolean;
  includedInPcb: boolean;
  includedInHrdfBase: boolean;
  isNonPayable: boolean;
  prorates: boolean;
};

const earn = (
  code: string,
  name: string,
  epf: boolean,
  socso: boolean,
  pcb: boolean,
  hrdf: boolean,
  prorates: boolean,
): PayComponentSeed => ({
  code,
  name,
  kind: 'allowance',
  includedInEpf: epf,
  includedInSocsoEis: socso,
  includedInPcb: pcb,
  includedInHrdfBase: hrdf,
  isNonPayable: false,
  prorates,
});

export const MY_DEFAULT_PAY_COMPONENTS: PayComponentSeed[] = [
  //    code          name                         EPF    SOCSO  PCB    HRDF   prorates
  earn('BASIC', 'Basic salary', true, true, true, true, true),
  earn('ALLOWANCE', 'Fixed allowance', true, true, true, true, true),
  earn('HOUSING', 'Housing allowance (fixed)', true, true, true, true, true),
  earn('COLA', 'Cost-of-living allowance', true, true, true, true, true),
  earn('SHIFT', 'Shift allowance', true, true, true, false, true),
  earn('ATTENDANCE', 'Attendance allowance', true, true, true, false, true),
  earn('COMMISSION', 'Commission', true, true, true, false, false),
  earn('OVERTIME', 'Overtime', false, true, true, false, false),
  earn('BONUS', 'Bonus', true, false, true, false, false),
  earn('CLAIM', 'Taxable claim allowance', true, true, true, false, false),
  earn('REIMBURSEMENT', 'Reimbursement (receipted)', false, false, false, false, false),
  {
    code: 'DEDUCTION',
    name: 'Deduction',
    kind: 'deduction',
    includedInEpf: false,
    includedInSocsoEis: false,
    includedInPcb: false,
    includedInHrdfBase: false,
    isNonPayable: false,
    prorates: false,
  },
];

/** The codes whose flags must reproduce the legacy kernel exactly (used by the backfill + compat test). */
export const BACKFILL_COMPONENT_CODES = {
  basic: 'BASIC',
  allowance: 'ALLOWANCE',
  overtime: 'OVERTIME',
  bonus: 'BONUS',
  claim: 'CLAIM',
} as const;
