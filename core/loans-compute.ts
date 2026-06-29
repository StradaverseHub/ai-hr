/**
 * Pure loan calc engine + client-safe constants/types — RSC-SAFE: this module imports NO db/postgres.
 *
 * Split out of core/loans.ts (which imports ../db/client → postgres at module scope) so a client component
 * (components/loan-new-form.tsx) can import `computeLoan` + the constants without dragging postgres into the
 * browser bundle. `next build` rejects a 'use client' → core/loans → db/client edge as module-not-found;
 * tsc + vitest do NOT run `next build`, so that boundary must be kept clean by construction. core/loans.ts
 * imports and re-exports everything here, so server callers + tests keep importing from '@/core/loans'.
 */

export class LoanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoanError';
  }
}

export const LOAN_TYPES = ['personal', 'housing', 'advance'] as const;
export type LoanType = (typeof LOAN_TYPES)[number];
export const LOAN_INTEREST_METHODS = ['flat', 'none'] as const;
export type LoanInterestMethod = (typeof LOAN_INTEREST_METHODS)[number];

export const toCents = (n: number): number => Math.round(n * 100);
export const fromCents = (c: number): number => c / 100;
export const money = (n: number): string => n.toFixed(2);

/** Total interest in cents for the chosen method (flat = add-on on the original principal, ADR-0060). */
function totalInterestCents(principalCents: number, annualPct: number, durationMonths: number, method: LoanInterestMethod): number {
  if (method === 'none') return 0;
  // flat: principal × (rate/100) × (months/12), rounded to cents.
  return Math.round(principalCents * (annualPct / 100) * (durationMonths / 12));
}

export type LoanComputation = {
  totalRepayableCents: number;
  monthlyInstalmentCents: number;
  /** The per-month due amounts in cents; sums byte-exact to totalRepayableCents (last reconciles). */
  schedule: number[];
};

/**
 * Compute the instalment + the full schedule in integer cents. `durationMonths-1` equal instalments plus a
 * final instalment that reconciles, so the schedule sums to totalRepayable exactly (no drift).
 */
export function computeLoan(p: {
  principal: number;
  annualInterestPct: number;
  durationMonths: number;
  method: LoanInterestMethod;
}): LoanComputation {
  if (!(p.durationMonths >= 1) || !Number.isInteger(p.durationMonths)) {
    throw new LoanError('Duration (months) must be a whole number ≥ 1');
  }
  if (!(p.principal > 0)) throw new LoanError('Principal must be greater than zero');
  if (p.annualInterestPct < 0) throw new LoanError('Interest rate must be zero or positive');
  const principalCents = toCents(p.principal);
  const interestCents = totalInterestCents(principalCents, p.annualInterestPct, p.durationMonths, p.method);
  const totalRepayableCents = principalCents + interestCents;
  const instalment = Math.round(totalRepayableCents / p.durationMonths);
  const schedule: number[] = [];
  for (let i = 0; i < p.durationMonths - 1; i++) schedule.push(instalment);
  // Final instalment reconciles the sum exactly (may differ by a few cents from the equal instalment).
  schedule.push(totalRepayableCents - instalment * (p.durationMonths - 1));
  return { totalRepayableCents, monthlyInstalmentCents: instalment, schedule };
}
