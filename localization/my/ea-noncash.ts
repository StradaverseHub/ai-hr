/** EA consumes run-owned, frozen noncash reporting evidence; it never reprices monthly PCB inputs. */
import { readPcbNonCash } from '../noncash-benefits';

const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Separates genuine recorded noncash exemption from the cash allowance subtraction. */
export function eaNonCashExemption(statutory: unknown): number {
  const st = record(statutory);
  if (!st || st.pcbNonCash === undefined) return 0; // Earlier payroll never used this noncash producer.
  const saved = readPcbNonCash(st.pcbNonCash);
  if (!saved) throw new Error('EA_NONCASH_PROVENANCE_INVALID');
  const byCode = new Map<string, number>();
  for (const entry of saved.ownedEaEntries) {
    if (entry.exemptAmount === 0) continue;
    if (!entry.subjectPCB || !entry.exemptionCode?.startsWith('PCB_')) throw new Error('EA_NONCASH_EXEMPTION_INVALID');
    byCode.set(entry.exemptionCode, round((byCode.get(entry.exemptionCode) ?? 0) + entry.exemptAmount));
  }
  const ledger = record(st.exemptionUsed);
  for (const [code, amount] of byCode) {
    const recorded = ledger?.[code];
    if (typeof recorded !== 'number' || !Number.isFinite(recorded) || recorded + 0.0000001 < amount) {
      throw new Error('EA_NONCASH_EXEMPTION_UNRECORDED');
    }
  }
  return round([...byCode.values()].reduce((sum, amount) => sum + amount, 0));
}

export function accumulatedEaNonCash(slips: readonly { payPeriod: string; statutory: unknown }[]): {
  complete: boolean; benefitsInKind: number; livingAccommodation: number; unmapped: string[];
} {
  let complete = slips.length > 0, bik = 0, vola = 0;
  const seen = new Set<string>(), unmapped = new Set<string>();
  for (const slip of slips) {
    const saved = readPcbNonCash(record(slip.statutory)?.pcbNonCash);
    if (!saved || !/^\d{4}-(0[1-9]|1[0-2])$/.test(slip.payPeriod)) { complete = false; continue; }
    for (const entry of saved.ownedEaEntries) {
      // A recurring monthly valuation belongs once per month; a one-off transaction belongs once.
      const key = entry.source === 'recurring' ? `${slip.payPeriod}:recurring:${entry.sourceId ?? entry.code}`
        : entry.sourceId ? `one_off:${entry.sourceId}` : null;
      if (!key || seen.has(key)) { complete = false; continue; }
      seen.add(key);
      const target = entry.eaFormLine === 'EA_B3' || entry.eaFormLine === 'bik' ? 'bik'
        : entry.eaFormLine === 'EA_B4' || entry.eaFormLine === 'vola' ? 'vola' : null;
      if (!target) { unmapped.add(entry.code); continue; }
      if (target !== entry.kind) { complete = false; continue; }
      // The frozen reporting amount owns its exemptions; subjectPCB is not an EA inclusion decision.
      if (target === 'bik') bik = round(bik + entry.reportableAmount);
      else vola = round(vola + entry.reportableAmount);
    }
  }
  // Never label a partial-year subtotal as an annual amount.
  return { complete, benefitsInKind: complete ? bik : 0, livingAccommodation: complete ? vola : 0, unmapped: [...unmapped].sort() };
}
