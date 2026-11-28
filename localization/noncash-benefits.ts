/** Saved non-cash remuneration contract. Cash payability and taxability remain separate. */
export type NonCashBenefitKind = 'bik' | 'vola';
export type NonCashAmounts = { bik: number; vola: number };
export type NonCashFigure = { entered: number; exempt: number; taxable: number };
export type NonCashFigures = { bik: NonCashFigure; vola: NonCashFigure };
/** PCB stream of a taxable benefit (board 8edeef41, 2026-11-25 amendment of ADR-0090). `normal` enters Y1;
 *  `additional` enters Yt through the existing section D.2 path with Kt = 0. Absent on a version 1 entry = normal. */
export type NonCashStream = 'normal' | 'additional';
export type NonCashEntry = NonCashFigure & {
  kind: NonCashBenefitKind; code: string; source: 'recurring' | 'one_off';
  sourceId?: string; exemptionCode?: string;
  /** Version 2 only. Every PCB entry of a version 2 snapshot carries it; a version 1 entry never does. */
  stream?: NonCashStream;
};
export type NonCashEaEntry = {
  kind: NonCashBenefitKind; code: string; source: 'recurring'|'one_off'; sourceId?:string;
  entered:number; reportableAmount:number; exemptAmount:number;
  eaFormLine:string|null; subjectPCB:boolean; exemptionCode?:string;
};
/** Version 1: every PCB entry is normal remuneration (Y1). Version 2: each PCB entry records its stream. Totals
 *  (`current`, `owned`, `cumulative`, `before`) are across both streams in either version. */
export type PcbNonCashSnapshot = {
  version: 1 | 2;
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
/** Stable refusal reasons. The EPF Bonus 2012 refusal applies only when that box is ticked (board 8edeef41).
 *  Since the 2026-11-25 amendment of ADR-0090 a taxable benefit may be Normal or Additional; only Optional Deduction
 *  (or another unknown type) is refused, as `remuneration_type_not_supported`. `normal_remuneration_required` is no
 *  longer produced and is retained so stored outcomes and old payloads still decode. */
export type NonCashBenefitConfigurationReason = 'classification_conflict' | 'unsupported_kind' | 'epf_bonus_not_allowed'
  | 'remuneration_type_not_supported' | 'normal_remuneration_required' | 'month_baseline_unavailable';
export class NonCashBenefitConfigurationError extends Error {
  readonly code = 'pcb_non_cash_configuration_invalid';
  constructor(readonly componentCode: string, readonly reason: NonCashBenefitConfigurationReason) {
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
  if (c.pcb && c.epfBonus2012) throw new NonCashBenefitConfigurationError(c.code, 'epf_bonus_not_allowed');
  if (c.pcb && c.pcbRemunerationType != null && c.pcbRemunerationType !== 'normal' && c.pcbRemunerationType !== 'additional') {
    throw new NonCashBenefitConfigurationError(c.code, 'remuneration_type_not_supported');
  }
  return benefit;
}
/** The PCB stream a classified benefit item takes. Only an explicit Additional is additional; Normal, and a legacy
 *  blank type, stay Normal (today's behaviour). Call after `classifyNonCashBenefit` accepted the item. */
export function nonCashBenefitStream(c: { pcbRemunerationType?: string | null }): NonCashStream {
  return c.pcbRemunerationType === 'additional' ? 'additional' : 'normal';
}
/** A saved entry's stream. A version 1 entry has none and is normal remuneration (Y1). */
export const nonCashEntryStream = (e: { stream?: NonCashStream }): NonCashStream => e.stream === 'additional' ? 'additional' : 'normal';
/** The same entry with its stream explicit, for carrying saved version 1 entries into a new snapshot. */
export const withNonCashStream = <T extends NonCashEntry>(e: T): T => ({ ...e, stream: nonCashEntryStream(e) });
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export function totalNonCash(entries: readonly NonCashEntry[]): NonCashFigures {
  const out: NonCashFigures = { bik: {entered:0,exempt:0,taxable:0}, vola: {entered:0,exempt:0,taxable:0} };
  for (const e of entries) for (const field of ['entered','exempt','taxable'] as const) out[e.kind][field] = round(out[e.kind][field]+e[field]);
  return out;
}
export function taxableNonCash(entries: readonly NonCashEntry[]): NonCashAmounts {
  const f=totalNonCash(entries); return {bik:f.bik.taxable,vola:f.vola.taxable};
}
export type NonCashByStream<T> = { normal: T; additional: T };
/** Taxable benefits split by PCB stream. With no Additional entry, `normal` equals `taxableNonCash(entries)`. */
export function taxableNonCashByStream(entries: readonly NonCashEntry[]): NonCashByStream<NonCashAmounts> {
  return { normal: taxableNonCash(entries.filter(e => nonCashEntryStream(e) === 'normal')),
    additional: taxableNonCash(entries.filter(e => nonCashEntryStream(e) === 'additional')) };
}
export function totalNonCashByStream(entries: readonly NonCashEntry[]): NonCashByStream<NonCashFigures> {
  return { normal: totalNonCash(entries.filter(e => nonCashEntryStream(e) === 'normal')),
    additional: totalNonCash(entries.filter(e => nonCashEntryStream(e) === 'additional')) };
}
export const hasAdditionalNonCash = (entries: readonly NonCashEntry[]) => entries.some(e => nonCashEntryStream(e) === 'additional');
/** A saved snapshot's month figures by stream: what this run owned, the month's cumulative, and the month before
 *  this run. A version 1 snapshot is all normal. */
export function pcbNonCashStreams(v: PcbNonCashSnapshot): {owned: NonCashByStream<NonCashAmounts>; cumulative: NonCashByStream<NonCashAmounts>; before: NonCashByStream<NonCashAmounts>; current: NonCashByStream<NonCashFigures>} {
  const owned = taxableNonCashByStream(v.ownedEntries), cumulative = taxableNonCashByStream(v.entries);
  const minus = (a: NonCashAmounts, b: NonCashAmounts): NonCashAmounts => ({ bik: round(a.bik - b.bik), vola: round(a.vola - b.vola) });
  return { owned, cumulative, before: { normal: minus(cumulative.normal, owned.normal), additional: minus(cumulative.additional, owned.additional) },
    current: totalNonCashByStream(v.entries) };
}
type SnapshotFields = Omit<PcbNonCashSnapshot, 'version'>;
/** The one writer of the snapshot version. With no Additional entry it is version 1 with no `stream` key anywhere,
 *  byte for byte the shape written before the amendment; otherwise version 2 with every PCB entry's stream explicit. */
export function versionedPcbNonCash(fields: SnapshotFields): PcbNonCashSnapshot {
  const v2 = hasAdditionalNonCash(fields.entries) || hasAdditionalNonCash(fields.ownedEntries);
  const shape = (xs: NonCashEntry[]) => xs.map(e => { const { stream: _stream, ...rest } = e; return v2 ? { ...rest, stream: nonCashEntryStream(e) } : rest; });
  return { version: v2 ? 2 : 1, current: fields.current, ownedCurrent: fields.ownedCurrent, owned: fields.owned, cumulative: fields.cumulative,
    before: fields.before, accumulated: fields.accumulated, cashNormal: fields.cashNormal, entries: shape(fields.entries),
    ownedEntries: shape(fields.ownedEntries), eaEntries: fields.eaEntries, ownedEaEntries: fields.ownedEaEntries };
}
/** The noncash inputs a tax-basis revision compares (core/payroll-tax-basis.ts). Comparison form 1, used by every
 *  existing preview and saved revision, has no stream. Form 2 (8edeef41) is used only when an owned entry is Additional:
 *  it marks itself and adds each entry's stream. A Normal entry therefore hashes exactly as before, so an unchanged
 *  employee creates no new revision, while a Normal to Additional change is a change. */
export function nonCashComparisonInputs(value: unknown) {
  const saved = readPcbNonCash(value);
  if (!saved) return { owned: { bik: 0, vola: 0 }, entries: [] as Omit<NonCashEntry, 'source' | 'sourceId'>[], ea: [] as Omit<NonCashEaEntry, 'source' | 'sourceId'>[] };
  const additional = hasAdditionalNonCash(saved.ownedEntries);
  const entries = saved.ownedEntries.map(({ sourceId: _sourceId, source: _source, stream, ...entry }) => additional ? { ...entry, stream: nonCashEntryStream({ stream }) } : entry);
  return { ...(additional ? { comparisonVersion: 2 as const } : {}), owned: saved.owned, entries,
    ea: saved.ownedEaEntries.map(({ sourceId: _sourceId, source: _source, ...entry }) => entry) };
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
  // Version 1 entries never carry a stream (they are all Y1); version 2 entries always do.
  const streamOk = (e: NonCashEntry) => v.version === 1 ? !Object.hasOwn(e, 'stream') : e.stream === 'normal' || e.stream === 'additional';
  const entries = (xs: unknown): xs is NonCashEntry[] => Array.isArray(xs) && xs.every(e => e && typeof e === 'object' && source(e) && streamOk(e) &&
    money(e.entered) && money(e.exempt) && money(e.taxable) && same(e.entered, round(e.exempt + e.taxable))) && unique(xs);
  const eaEntries = (xs: unknown): xs is NonCashEaEntry[] => Array.isArray(xs) && xs.every(e => e && typeof e === 'object' && source(e) &&
    (e.eaFormLine === null || typeof e.eaFormLine === 'string') && typeof e.subjectPCB === 'boolean' &&
    money(e.entered) && money(e.reportableAmount) && money(e.exemptAmount) && same(e.entered, round(e.reportableAmount + e.exemptAmount)) &&
    (e.subjectPCB || e.exemptAmount === 0)) && unique(xs);
  if ((v.version !== 1 && v.version !== 2) || !money(v.cashNormal) || !entries(v.entries) || !entries(v.ownedEntries) ||
      !eaEntries(v.eaEntries) || !eaEntries(v.ownedEaEntries) || typeof v.accumulated?.complete !== 'boolean') return null;
  const fields = (e: NonCashEntry | NonCashEaEntry) => [e.kind, e.code, e.source, e.sourceId ?? null, e.exemptionCode ?? null];
  const exact = (a: NonCashEntry | NonCashEaEntry, b: NonCashEntry | NonCashEaEntry) => JSON.stringify(fields(a)) === JSON.stringify(fields(b));
  for (const e of v.ownedEntries) {
    const full = v.entries.find(x => ownership(x) === ownership(e));
    if (!full || !exact(e, full) || e.stream !== full.stream || !same(e.entered, full.entered) || !same(e.exempt, full.exempt) || !same(e.taxable, full.taxable)) return null;
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

/** Board d9ded29c — ONE MEANING FOR THE PCB BASE. Live payroll stamps `bases.pcb` as the month's cash remuneration
 *  (normal + additional) PLUS the month's cumulative taxable BIK/VOLA (core/payroll.ts statBases.pcb), and the prior-month
 *  fold takes Y = bases.pcb - (cumulative - owned). A saved historical tax basis (an Income Tax Correction revision or an
 *  accepted import projection, `TaxBasisValue` version 1) records `pcb` as cash only, with the benefits beside it in
 *  `pcbNonCash`. Read back as a PCB base, it must carry the same benefits, or the fold drops them from Y. This is that
 *  read: the saved cash base plus the cumulative taxable benefits of the snapshot it is read with. No stored value
 *  changes; a basis without a readable snapshot has no benefits to add. Exempt parts never enter (`cumulative` is the
 *  taxable figure, after annual exemption limits). */
export function pcbBaseWithNonCash(cashPcb: number, pcbNonCash: unknown): number {
  const nc = readPcbNonCash(pcbNonCash);
  return nc ? round(cashPcb + nc.cumulative.bik + nc.cumulative.vola) : cashPcb;
}
/** Board d9ded29c — the taxable BIK/VOLA a saved record itself owns (counted once, in the month and run it belongs to):
 *  what the prior-month fold adds to Y for it. Zero without a readable snapshot. */
export function ownedTaxableNonCash(pcbNonCash: unknown): number {
  const nc = readPcbNonCash(pcbNonCash);
  return nc ? round(nc.owned.bik + nc.owned.vola) : 0;
}

/** Rebuild saved noncash snapshots from exact, ordered owned sources. No rates or taxability are inferred. */
export function createNonCashOwnershipReplay(prefixComplete=true){
 let period='',complete=prefixComplete;const annual={bik:0,vola:0};let monthOpening={bik:0,vola:0,complete:prefixComplete};
 const entries=new Map<string,NonCashEntry>(),ea=new Map<string,NonCashEaEntry>();
 const key=(entry:{source:string;sourceId?:string;code:string})=>entry.source+':'+(entry.sourceId??entry.code);
 return (input:{period:string;cashNormal:number;owned:NonCashEntry[];ownedEa:NonCashEaEntry[];original:PcbNonCashSnapshot|null;completeSource:boolean}):PcbNonCashSnapshot=>{
  if(input.period!==period){period=input.period;entries.clear();ea.clear();monthOpening={...annual,complete};}
  const before=taxableNonCash([...entries.values()]),accumulated={...monthOpening};
  for(const entry of input.ownedEa){if(ea.has(key(entry)))throw new NonCashBenefitConfigurationError(entry.code,'month_baseline_unavailable');ea.set(key(entry),entry);}
  for(const entry of input.owned)entries.set(key(entry),withNonCashStream(entry));
  const missing=input.original?.eaEntries.find(entry=>!ea.has(key(entry)));if(missing)throw new NonCashBenefitConfigurationError(missing.code,'month_baseline_unavailable');
  const full=[...entries.values()],fullEa=[...ea.values()],owned=taxableNonCash(input.owned);
  const snapshot=versionedPcbNonCash({current:totalNonCash(full),ownedCurrent:totalNonCash(input.owned),owned,cumulative:taxableNonCash(full),before,accumulated,cashNormal:input.cashNormal,entries:full,ownedEntries:input.owned.map(withNonCashStream),eaEntries:fullEa,ownedEaEntries:input.ownedEa});
  if(!readPcbNonCash(snapshot))throw new NonCashBenefitConfigurationError(input.period,'month_baseline_unavailable');
  annual.bik=round(annual.bik+owned.bik);annual.vola=round(annual.vola+owned.vola);complete=complete&&input.completeSource;
  return snapshot;
 };
}
