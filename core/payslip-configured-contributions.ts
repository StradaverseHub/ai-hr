/** A recorded employer contribution is declared by this run, never today's catalogue. */
export function isRecordedEmployerContribution(line: unknown): boolean {
  if (!line || typeof line !== 'object') return false;
  const value = line as Record<string, unknown>;
  return value.nonPayable === true && value.kind === 'contribution';
}

/**
 * 5a5309d5 — IS THIS RECORD LINE A NON-PAYABLE AMOUNT (a BIK, a VOLA) — the one owner of that answer.
 *
 * `statutory.recordLines` is a MIXED array: record-only benefits in kind beside named provenance for
 * one-offs that were genuinely paid, plus the employer contributions above. The only safe discriminator is
 * the flag the kernel wrote at run time, so this takes `nonPayable === true` and treats every other value —
 * false, and the `undefined` every payslip written before f35f758a (r185) carries — as an ordinary line.
 * Matching a code back to today's catalogue would print today's answer against last month's pay.
 *
 * Read by the printed payslip's Non-payable box (lib/payslip-pdf.ts) and by Transaction View → History, so
 * the two cannot sort one slip's lines differently.
 */
export function isNonPayableRecordLine(line: unknown): boolean {
  if (!line || typeof line !== 'object') return false;
  return (line as Record<string, unknown>).nonPayable === true && !isRecordedEmployerContribution(line);
}

export function payslipConfiguredContributions(statutory: unknown): { code: string; name: string; amount: number }[] {
  if (!statutory || typeof statutory !== 'object') return [];
  const lines = (statutory as Record<string, unknown>).recordLines;
  if (!Array.isArray(lines)) return [];
  return lines.flatMap(line => {
    if (!isRecordedEmployerContribution(line)) return [];
    const amount = Number(line.amount);
    if (!Number.isFinite(amount) || amount === 0) return [];
    return [{ code: typeof line.code === 'string' ? line.code : '', name: typeof line.name === 'string' ? line.name : '', amount }];
  });
}
