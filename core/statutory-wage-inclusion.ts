/**
 * The pay item's SOCSO/EIS switch owns its contribution to the shared SOCSO, EIS and SKBBK
 * wage base (approved feedback ffb6c2e0, 17 November 2026). EPF classification is deliberately
 * not an input. The kernel and its item trace use the same decision for taxable/exempt pay.
 * Amount rounding remains with the caller's existing money fold.
 */
export function nonEpfStatutoryWage(amount: number, includedInSocsoEis: boolean): number {
  return includedInSocsoEis ? amount : 0;
}
