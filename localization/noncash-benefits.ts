/** Saved non-cash remuneration contract. Cash payability and taxability remain separate. */
export type NonCashBenefitKind = 'bik' | 'vola';
export type NonCashAmounts = { bik: number; vola: number };
export type NonCashFigure = { entered: number; exempt: number; taxable: number };
export type NonCashFigures = { bik: NonCashFigure; vola: NonCashFigure };
export type NonCashEntry = NonCashFigure & {
  kind: NonCashBenefitKind; code: string; source: 'recurring' | 'one_off';
  sourceId?: string; exemptionCode?: string;
};
export type NonCashEaEntry = {
  kind: NonCashBenefitKind; code: string; source: 'recurring'|'one_off'; sourceId?:string;
  entered:number; reportableAmount:number; exemptAmount:number;
  eaFormLine:string|null; subjectPCB:boolean; exemptionCode?:string;
};
export type PcbNonCashSnapshot = {
  version: 1;
  current: NonCashFigures; ownedCurrent: NonCashFigures;
  owned: NonCashAmounts; cumulative: NonCashAmounts; before: NonCashAmounts;
  accumulated: NonCashAmounts & { complete: boolean };
  cashNormal: number;
  entries: NonCashEntry[]; ownedEntries: NonCashEntry[];
  eaEntries:NonCashEaEntry[]; ownedEaEntries:NonCashEaEntry[];
};
export type NonCashClassificationInput = {
  code: string; kind: string; nonPayable: boolean; pcb: boolean;
  displayCategory?: string | null; eaFormLine?: string | null;
  pcbRemunerationType?: string | null; epfBonus2012?: boolean;
};
export class NonCashBenefitConfigurationError extends Error {
  readonly code = 'pcb_non_cash_configuration_invalid';
  constructor(readonly componentCode: string, readonly reason: 'classification_conflict' | 'unsupported_kind' | 'normal_remuneration_required' | 'month_baseline_unavailable') {
    super('Non-cash benefit configuration requires review'); this.name = 'NonCashBenefitConfigurationError';
  }
}
/** EA identifies legacy benefit kind only; it never elects PCB inclusion. */
export function classifyNonCashBenefit(c: NonCashClassificationInput): NonCashBenefitKind | null {
  if (!c.nonPayable) return null;
  const explicit = c.displayCategory === 'bik' || c.displayCategory === 'vola' ? c.displayCategory : null;
  const legacy = c.eaFormLine === 'EA_B3' || c.eaFormLine === 'bik' ? 'bik'
    : c.eaFormLine === 'EA_B4' || c.eaFormLine === 'vola' ? 'vola' : null;
  if (explicit && legacy && explicit !== legacy) throw new NonCashBenefitConfigurationError(c.code, 'classification_conflict');
  const benefit = explicit ?? legacy;
  if (!benefit) return null;
  if (c.kind !== 'allowance' && c.kind !== 'earning' && c.kind !== 'non_payable') throw new NonCashBenefitConfigurationError(c.code, 'unsupported_kind');
  if (c.pcb && (c.epfBonus2012 || (c.pcbRemunerationType != null && c.pcbRemunerationType !== 'normal'))) {
    throw new NonCashBenefitConfigurationError(c.code, 'normal_remuneration_required');
  }
  return benefit;
}
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export function totalNonCash(entries: readonly NonCashEntry[]): NonCashFigures {
  const out: NonCashFigures = { bik: {entered:0,exempt:0,taxable:0}, vola: {entered:0,exempt:0,taxable:0} };
  for (const e of entries) for (const field of ['entered','exempt','taxable'] as const) out[e.kind][field] = round(out[e.kind][field]+e[field]);
  return out;
}
export function taxableNonCash(entries: readonly NonCashEntry[]): NonCashAmounts {
  const f=totalNonCash(entries); return {bik:f.bik.taxable,vola:f.vola.taxable};
}
/** Strict enough to reuse saved ownership in a future calculation; malformed is unavailable. */
export function readPcbNonCash(value: unknown): PcbNonCashSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as PcbNonCashSnapshot;
  const money = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && Number.isSafeInteger(Math.round(n * 100)) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
  const same = (a: number, b: number) => money(a) && money(b) && Math.round(a * 100) === Math.round(b * 100);
  const ownership = (e: { source: string; sourceId?: string; code: string }) => `${e.source}:${e.sourceId ?? e.code}`;
  const source = (e: NonCashEntry | NonCashEaEntry) => (e.kind === 'bik' || e.kind === 'vola') && typeof e.code === 'string' && e.code.length > 0 &&
    (e.source === 'recurring' || e.source === 'one_off') &&
    (e.sourceId === undefined ? e.source === 'recurring' : typeof e.sourceId === 'string' && e.sourceId.length > 0) &&
    (e.exemptionCode === undefined || typeof e.exemptionCode === 'string' && e.exemptionCode.length > 0);
  const unique = (xs: (NonCashEntry | NonCashEaEntry)[]) => new Set(xs.map(ownership)).size === xs.length;
  const entries = (xs: unknown): xs is NonCashEntry[] => Array.isArray(xs) && xs.every(e => e && typeof e === 'object' && source(e) &&
    money(e.entered) && money(e.exempt) && money(e.taxable) && same(e.entered, round(e.exempt + e.taxable))) && unique(xs);
  const eaEntries = (xs: unknown): xs is NonCashEaEntry[] => Array.isArray(xs) && xs.every(e => e && typeof e === 'object' && source(e) &&
    (e.eaFormLine === null || typeof e.eaFormLine === 'string') && typeof e.subjectPCB === 'boolean' &&
    money(e.entered) && money(e.reportableAmount) && money(e.exemptAmount) && same(e.entered, round(e.reportableAmount + e.exemptAmount)) &&
    (e.subjectPCB || e.exemptAmount === 0)) && unique(xs);
  if (v.version !== 1 || !money(v.cashNormal) || !entries(v.entries) || !entries(v.ownedEntries) ||
      !eaEntries(v.eaEntries) || !eaEntries(v.ownedEaEntries) || typeof v.accumulated?.complete !== 'boolean') return null;
  const fields = (e: NonCashEntry | NonCashEaEntry) => [e.kind, e.code, e.source, e.sourceId ?? null, e.exemptionCode ?? null];
  const exact = (a: NonCashEntry | NonCashEaEntry, b: NonCashEntry | NonCashEaEntry) => JSON.stringify(fields(a)) === JSON.stringify(fields(b));
  for (const e of v.ownedEntries) {
    const full = v.entries.find(x => ownership(x) === ownership(e));
    if (!full || !exact(e, full) || !same(e.entered, full.entered) || !same(e.exempt, full.exempt) || !same(e.taxable, full.taxable)) return null;
  }
  for (const e of v.ownedEaEntries) {
    const full = v.eaEntries.find(x => ownership(x) === ownership(e));
    if (!full || !exact(e, full) || e.eaFormLine !== full.eaFormLine || e.subjectPCB !== full.subjectPCB ||
        !same(e.entered, full.entered) || !same(e.exemptAmount, full.exemptAmount) || !same(e.reportableAmount, full.reportableAmount)) return null;
  }
  const reconcile = (pcb: NonCashEntry[], ea: NonCashEaEntry[]) => {
    if (pcb.length !== ea.filter(e => e.subjectPCB).length) return false;
    return ea.every(e => {
      const p = pcb.find(x => ownership(x) === ownership(e));
      return e.subjectPCB ? !!p && exact(e, p) && same(e.entered, p.entered) && same(e.exemptAmount, p.exempt) && same(e.reportableAmount, p.taxable) : !p;
    });
  };
  if (!reconcile(v.entries, v.eaEntries) || !reconcile(v.ownedEntries, v.ownedEaEntries)) return null;
  const current = totalNonCash(v.entries), owned = totalNonCash(v.ownedEntries);
  for (const k of ['bik', 'vola'] as const) {
    if (!money(v.owned?.[k]) || !money(v.before?.[k]) || !money(v.cumulative?.[k]) || !money(v.accumulated?.[k])) return null;
    for (const f of ['entered', 'exempt', 'taxable'] as const) {
      if (!money(v.current?.[k]?.[f]) || !money(v.ownedCurrent?.[k]?.[f]) || !same(v.current[k][f], current[k][f]) || !same(v.ownedCurrent[k][f], owned[k][f])) return null;
    }
    if (!same(v.owned[k], owned[k].taxable) || !same(v.cumulative[k], current[k].taxable) || !same(round(v.before[k] + v.owned[k]), v.cumulative[k])) return null;
  }
  return v;
}
