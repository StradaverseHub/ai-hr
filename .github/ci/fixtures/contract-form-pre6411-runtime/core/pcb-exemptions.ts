/** Recorded evidence only. This reader never consults current configuration or computes money. */
export type PcbExemptionRow = {
  code: string; table: 'pcb' | 'lp'; annualLimit: number | null;
  accumulated: number; thisMonth: number; payItems: string[]; reused: boolean;
};
export type PcbExemptionSnapshot = {
  version: 1; payPeriod: string; taxYear: number; basis: 'selected_calculation'; rows: PcbExemptionRow[];
};
export type PcbExemptionDetail = {
  source: 'recorded' | 'partial' | 'unavailable';
  rows: (Omit<PcbExemptionRow, 'accumulated' | 'thisMonth'> & {accumulated: number | null; thisMonth: number | null})[];
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const money = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && Number.isSafeInteger(Math.round(v * 100)) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

export function readPcbExemptions(value: unknown): PcbExemptionSnapshot | null {
  if (!record(value) || value.version !== 1 || value.basis !== 'selected_calculation' ||
      typeof value.payPeriod !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.payPeriod) ||
      value.taxYear !== Number(value.payPeriod.slice(0, 4)) || !Array.isArray(value.rows)) return null;
  const seen = new Set<string>();
  for (const row of value.rows) {
    if (!record(row) || !text(row.code) || (row.table !== 'pcb' && row.table !== 'lp') || !row.code.startsWith(row.table === 'pcb' ? 'PCB_' : 'LP_') ||
        !(row.annualLimit === null || row.annualLimit === -1 || money(row.annualLimit)) ||
        !money(row.accumulated) || !money(row.thisMonth) || typeof row.reused !== 'boolean' ||
        !Array.isArray(row.payItems) || !row.payItems.every(text) || new Set(row.payItems).size !== row.payItems.length ||
        seen.has(row.code)) return null;
    seen.add(row.code);
  }
  return value as unknown as PcbExemptionSnapshot;
}

export function pcbExemptionDetail(statutory: unknown, expectedPayPeriod?: string): PcbExemptionDetail {
  const unavailable: PcbExemptionDetail = {source: 'unavailable', rows: []};
  if (!record(statutory)) return unavailable;
  if (Object.prototype.hasOwnProperty.call(statutory, 'pcbExemptions')) {
    const saved = readPcbExemptions(statutory.pcbExemptions);
    if (!saved || expectedPayPeriod !== undefined && saved.payPeriod !== expectedPayPeriod) return unavailable;
    return {source: 'recorded', rows: saved.rows};
  }
  const used = statutory.exemptionUsed;
  if (!record(used) || Object.keys(used).length === 0) return unavailable;
  const rows: PcbExemptionDetail['rows'] = [];
  for (const [code, amount] of Object.entries(used)) {
    if (!text(code) || !money(amount) || !(code.startsWith('PCB_') || code.startsWith('LP_'))) return unavailable;
    rows.push({code, table: code.startsWith('LP_') ? 'lp' : 'pcb', annualLimit: null,
      accumulated: null, thisMonth: amount, payItems: [], reused: false});
  }
  return {source: 'partial', rows: rows.sort((a, b) => a.code.localeCompare(b.code))};
}
