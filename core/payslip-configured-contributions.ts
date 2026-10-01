/** A recorded employer contribution is declared by this run, never today's catalogue. */
export function isRecordedEmployerContribution(line: unknown): boolean {
  if (!line || typeof line !== 'object') return false;
  const value = line as Record<string, unknown>;
  return value.nonPayable === true && value.kind === 'contribution';
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
