/**
 * Board 4ce2c481 — the PURE half of the group tax opening (core/payroll-group-tax-opening.ts owns the read): the shape
 * of one contributing company's month, the prior-slip form the pack fold reads, and the stamp a payslip keeps of the
 * opening it was calculated with. Here, outside the payroll implementation, because the PCB explanation and the MY
 * multi-cycle worksheet read the stamp back and import no payroll module. Totals per company and month only.
 */
const num = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };

/** One contributing company's month for one of the run's employments: totals only, never a payslip line. */
export type GroupTaxMonth = {
  companyId: string;
  companyName: string;
  period: string;
  /** Where the figures came from: Import Payroll History, payroll processed in the system, or both in one month. */
  source: 'imported' | 'processed' | 'mixed';
  slips: number;
  /** Remuneration for MTD purposes (LHDN Y) of the month, after the stored non-cash adjustment. */
  y: number;
  epf: number;
  /** PCB/MTD already deducted that month (part of LHDN's X). */
  pcb: number;
  zakat: number;
  zakatRebate: number;
  lp: number;
  /** The TP1 part of ∑LP, kept apart so the TP1 delta nets off what the group already fed (item 3fa088fb). */
  tp1Lp: number;
  exemptionUsed: Record<string, number>;
  bik: number;
  vola: number;
  noncashComplete: boolean;
  /** Null when the month is usable. Otherwise the reason the employee is held, with this month named. */
  unusable: 'imported_review' | 'no_tax_basis' | null;
};

/** The TP3 outcome against the group history: applied as today, replaced by the group history, or held. */
export type GroupTp3Outcome = 'apply' | 'replaced' | 'conflict';

export type GroupTaxOpening = {
  employmentId: string;
  months: GroupTaxMonth[];
  tp3: GroupTp3Outcome;
};

/**
 * The months as prior slips for the pack fold: Y as the stamped base (non-cash already adjusted by the definer), EPF,
 * PCB, zakat with the TP1 rebate kept apart (the fold adds both into Z), ∑LP. Pure.
 */
export function groupTaxPriorSlips(opening: GroupTaxOpening | undefined): {period: string; gross: number; statutory: Record<string, unknown>; group: GroupTaxMonth}[] {
  return (opening?.months ?? []).map(m => ({
    period: m.period, gross: m.y, group: m,
    statutory: {bases: {pcb: m.y}, epfEmployee: m.epf, pcb: m.pcb, zakat: m.zakat, zakatRebateTp1: m.zakatRebate, lp: m.lp, lpDetail: {tp1: m.tp1Lp}, exemptionUsed: {...m.exemptionUsed}},
  }));
}

/** What a payslip records about the group opening it was calculated with: totals per company and month, for the PCB
 * explanation and the multi-cycle worksheet. A payslip calculated without one records nothing. Pure. */
export type GroupTaxOpeningStamp = {version: 1; tp3: GroupTp3Outcome; months: GroupTaxMonth[];
  /** The per-company totals, written once by the run so the explanation prints what was recorded, not a re-sum. */
  companies: GroupTaxCompanySummary[]};
export function groupTaxOpeningStamp(opening: GroupTaxOpening | undefined): GroupTaxOpeningStamp | undefined {
  if (!opening?.months.length) return undefined;
  const months = opening.months.map(m => ({...m, exemptionUsed: {...m.exemptionUsed}}));
  return {version: 1, tp3: opening.tp3, months, companies: summarizeGroupTaxOpening(months)};
}

/** Read a payslip's stamp back, validated; anything malformed reads as none. Pure. */
export function readGroupTaxOpeningStamp(statutory: unknown): GroupTaxOpeningStamp | null {
  const raw = (statutory as {groupTaxOpening?: unknown} | null)?.groupTaxOpening as Partial<GroupTaxOpeningStamp> | undefined;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.months)) return null;
  const months: GroupTaxMonth[] = [];
  for (const m of raw.months as Partial<GroupTaxMonth>[]) {
    if (typeof m?.companyId !== 'string' || typeof m.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(m.period)) return null;
    months.push({companyId: m.companyId, companyName: String(m.companyName ?? ''), period: m.period,
      source: m.source === 'imported' || m.source === 'mixed' ? m.source : 'processed', slips: Number(m.slips ?? 0),
      y: num(m.y), epf: num(m.epf), pcb: num(m.pcb), zakat: num(m.zakat), zakatRebate: num(m.zakatRebate), lp: num(m.lp), tp1Lp: num(m.tp1Lp),
      exemptionUsed: Object.fromEntries(Object.entries(m.exemptionUsed ?? {}).map(([k, v]) => [k, num(v)])), bik: num(m.bik), vola: num(m.vola),
      noncashComplete: m.noncashComplete === true, unusable: null});
  }
  const stored = Array.isArray(raw.companies) && raw.companies.every(c => typeof c?.companyId === 'string' && Array.isArray(c.periods)) ? raw.companies : null;
  return {version: 1, tp3: raw.tp3 === 'replaced' || raw.tp3 === 'conflict' ? raw.tp3 : 'apply', months,
    companies: stored ? stored.map(c => ({companyId: c.companyId, companyName: String(c.companyName ?? ''), periods: c.periods.map(String),
      sources: Array.isArray(c.sources) ? c.sources : [], y: num(c.y), pcb: num(c.pcb), epf: num(c.epf), zakat: num(c.zakat), lp: num(c.lp),
      exemptionUsed: Object.fromEntries(Object.entries(c.exemptionUsed ?? {}).map(([k, v]) => [k, num(v)])), missing: []})) : summarizeGroupTaxOpening(months)};
}

/** Per contributing company, the months it covers and its totals: the shape the PCB explanation and the recalculation
 * preview show. Pure. */
export type GroupTaxCompanySummary = {companyId: string; companyName: string; periods: string[]; sources: GroupTaxMonth['source'][];
  y: number; pcb: number; epf: number; zakat: number; lp: number; exemptionUsed: Record<string, number>; missing: string[]};
export function summarizeGroupTaxOpening(months: readonly GroupTaxMonth[]): GroupTaxCompanySummary[] {
  const by = new Map<string, GroupTaxCompanySummary>();
  const r2 = (n: number) => Math.round(n * 100) / 100;
  for (const m of months) {
    const s = by.get(m.companyId) ?? {companyId: m.companyId, companyName: m.companyName, periods: [], sources: [], y: 0, pcb: 0, epf: 0, zakat: 0, lp: 0, exemptionUsed: {}, missing: []};
    s.periods.push(m.period);
    if (!s.sources.includes(m.source)) s.sources.push(m.source);
    if (m.unusable) s.missing.push(m.period);
    s.y = r2(s.y + m.y); s.pcb = r2(s.pcb + m.pcb); s.epf = r2(s.epf + m.epf); s.zakat = r2(s.zakat + m.zakat + m.zakatRebate); s.lp = r2(s.lp + m.lp);
    for (const [code, amount] of Object.entries(m.exemptionUsed)) s.exemptionUsed[code] = r2((s.exemptionUsed[code] ?? 0) + amount);
    by.set(m.companyId, s);
  }
  return [...by.values()].sort((a, b) => a.periods[0].localeCompare(b.periods[0]) || a.companyName.localeCompare(b.companyName));
}
