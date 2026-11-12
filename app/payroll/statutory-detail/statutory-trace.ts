import type { StatutoryTraceLineRecord, StatutoryTraceRecord } from '@/core/statutory-trace-explain';

/**
 * Item 69d6ed3c — the statutory trace v1, as rows. The on-screen cards (Transaction View › Statutory
 * Explanation and the standalone Statutory Detail screen share one view) and the Excel export both build
 * from THIS file, so the screen and the file cannot tell different stories.
 *
 * EVERY FIGURE IS READ OFF THE PAYSLIP'S OWN `statutory.statutoryTrace`, which `readStatutoryTrace` has
 * already checked against the payslip's amounts. Nothing here looks up a table or multiplies a rate: the
 * wage ranges are the rows the run itself read, and the amounts are the amounts those rows gave.
 *
 * STATIC KEYS ONLY. A computed `t()` key is invisible to the i18n coverage scan.
 */
export type TraceItemRow = {
  description: string;
  code?: string;
  amount: string;
  settings: string;
  treatment: string;
  contribution: string;
  emphasis?: boolean;
};
export type TraceRow = { label: string; value: string };
export type TraceKey = 'epf' | 'socso' | 'skbbk' | 'eis';

type T = (key: string, values?: Record<string, string>) => string;
type Money = (amount: number) => string;

const LINE_LABEL = {
  basic: 'traceLineBasic',
  unpaid: 'traceLineUnpaid',
  overtime: 'traceLineRegularOvertime',
  earlier_runs: 'traceLineEarlierRuns',
  other: 'traceLineOther',
} as const;
const CITIZENSHIP = { citizen: 'traceCitizen', pr: 'tracePr', non_citizen: 'traceNonCitizen' } as const;
const EPF_NOT_APPLICABLE = { age_75_plus: 'traceEpfAge75', exempt: 'traceEpfExempt' } as const;
const SOCSO_NOT_APPLICABLE = { not_subject: 'traceSocsoNotSubject', category_none: 'traceSocsoCategoryNone' } as const;
const SKBBK_NOT_APPLICABLE = { not_subject: 'traceSkbbkNotSubject', not_in_ruleset: 'traceSkbbkNotInRuleset' } as const;
const EIS_NOT_APPLICABLE = {
  age_60_plus: 'traceEisAge60',
  non_citizen: 'traceEisNonCitizen',
  category_none: 'traceEisCategoryNone',
  not_eligible: 'traceEisNotEligible',
} as const;
const RUN_KIND = {
  single: 'traceRunSingle',
  additional: 'traceRunAdditional',
  restate: 'traceRunRestate',
  post_employment: 'traceRunPostEmployment',
} as const;

const yesNo = (t: T, v: boolean | undefined) => t(v ? 'traceYes' : 'traceNo');
const signed = (money: Money, amount: number) => (amount < 0 ? `−${money(-amount)}` : money(amount));

/** "RM4,580.01 – RM4,600.00", or "above RM6,000.00" for a wage past the table's last row. */
export function traceRange(band: { from: number; upTo: number; aboveTable?: true }, t: T, money: Money): string {
  if (band.aboveTable) return t('traceRangeAbove', { upTo: money(band.upTo) });
  return t('traceRange', { from: money(band.from), upTo: money(band.upTo) });
}

function lineDescription(l: StatutoryTraceLineRecord, t: T): string {
  if (l.kind === 'item') return l.name || l.code || t('traceLineItem');
  return t(LINE_LABEL[l.kind]);
}

/** The pay items table for EPF: every line, with its EPF settings as the run read them and how it was treated. */
export function epfTraceItemRows(trace: StatutoryTraceRecord, t: T, money: Money): TraceItemRow[] {
  const rows: TraceItemRow[] = [];
  for (const l of trace.items) {
    if (l.kind !== 'item' && l.epfNormal === 0 && l.epfBonus === 0) continue;
    const treatment = l.epfBonus !== 0
      ? t(l.epfBonus2012 ? 'traceTreatEpfBonus2012' : 'traceTreatEpfAdditional')
      : l.epfNormal !== 0 ? t('traceTreatEpfNormal') : t('traceTreatEpfExcluded');
    rows.push({
      description: lineDescription(l, t),
      ...(l.code ? { code: l.code } : {}),
      amount: l.amount == null ? '' : signed(money, l.amount),
      settings: l.kind === 'item' ? t('traceEpfSettings', { epf: yesNo(t, l.epf), bonus2012: yesNo(t, l.epfBonus2012) }) : '',
      treatment,
      contribution: signed(money, l.epfNormal + l.epfBonus),
    });
  }
  rows.push({ description: t('traceEpfNormalTotal'), amount: '', settings: '', treatment: '', contribution: money(trace.epf.normalWage), emphasis: true });
  rows.push({ description: t('traceEpfBonusTotal'), amount: '', settings: '', treatment: '', contribution: money(trace.epf.bonusWage), emphasis: true });
  return rows;
}

/** The pay items table for SOCSO / EIS / SKBBK — the three share one wage. */
export function socsoTraceItemRows(trace: StatutoryTraceRecord, t: T, money: Money): TraceItemRow[] {
  const rows: TraceItemRow[] = [];
  for (const l of trace.items) {
    if (l.kind !== 'item' && l.socsoEis === 0) continue;
    rows.push({
      description: lineDescription(l, t),
      ...(l.code ? { code: l.code } : {}),
      amount: l.amount == null ? '' : signed(money, l.amount),
      settings: l.kind === 'item' ? t('traceSocsoSettings', { socso: yesNo(t, l.socso), bonus2012: yesNo(t, l.epfBonus2012) }) : '',
      treatment: t(l.socsoEis !== 0 ? 'traceTreatSocsoIncluded' : 'traceTreatSocsoExcluded'),
      contribution: signed(money, l.socsoEis),
    });
  }
  rows.push({ description: t('traceSocsoTotal'), amount: '', settings: '', treatment: '', contribution: money(trace.socso.wage), emphasis: true });
  return rows;
}

type EpfLookup = StatutoryTraceRecord['epf'] | NonNullable<StatutoryTraceRecord['epf']['normalOnly']>;

const LOOKUP_LABEL = {
  month: { traceEpfRange: 'traceEpfRange', traceEpfRowEmployee: 'traceEpfRowEmployee', traceEpfRowEmployer: 'traceEpfRowEmployer' },
  normal: { traceEpfRange: 'traceEpfRangeNormalOnly', traceEpfRowEmployee: 'traceEpfRowEmployeeNormalOnly', traceEpfRowEmployer: 'traceEpfRowEmployer' },
} as const;

function epfLookupRows(l: EpfLookup, t: T, money: Money, percent: Intl.NumberFormat, prefix: '' | 'normal'): TraceRow[] {
  const label = (key: 'traceEpfRange' | 'traceEpfRowEmployee' | 'traceEpfRowEmployer') =>
    t(LOOKUP_LABEL[prefix === 'normal' ? 'normal' : 'month'][key]);
  if (l.method === 'schedule_row' && l.band) {
    return [
      { label: label('traceEpfRange'), value: traceRange(l.band, t, money) },
      { label: label('traceEpfRowEmployee'), value: money(l.scheduleEmployee) },
      ...(prefix === 'normal' ? [] : [{ label: label('traceEpfRowEmployer'), value: money(l.scheduleEmployer) }]),
    ];
  }
  if (l.method === 'schedule_formula' || l.method === 'flat_rate') {
    return [
      { label: t(l.method === 'flat_rate' ? 'traceEpfFlatRate' : 'traceEpfAboveSchedule'), value: t('traceEpfRates', {
        employee: percent.format(l.employeeRate ?? 0), employer: percent.format(l.employerRate ?? 0),
      }) },
      { label: label('traceEpfRowEmployee'), value: money(l.scheduleEmployee) },
      ...(prefix === 'normal' ? [] : [{ label: label('traceEpfRowEmployer'), value: money(l.scheduleEmployer) }]),
    ];
  }
  if (l.method === 'election_working') return [{ label: t('traceEpfMethod'), value: t('traceEpfElectionWorking') }];
  return [];
}

/** EPF: classification, wages, the Third Schedule range used and the amounts it gives. */
export function epfTraceRows(trace: StatutoryTraceRecord, t: T, money: Money, locale: string): TraceRow[] {
  const e = trace.epf;
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 4 });
  const part = e.part === 'A' ? t('traceEpfPartA') : e.part === 'E' ? t('traceEpfPartE')
    : e.method === 'flat_rate' ? t('traceEpfPartFlat') : t('traceEpfPartNone');
  const rows: TraceRow[] = [
    { label: t('traceClassification'), value: t('traceEpfClassification', {
      citizenship: t(CITIZENSHIP[e.citizenship]),
      age: e.age == null ? t('traceAgeUnknown') : e.age >= 75 ? t('traceAge75') : e.age >= 60 ? t('traceAge60') : t('traceAgeUnder60'),
    }) },
    { label: t('traceSchedule'), value: part },
    { label: t('traceEpfCategory'), value: e.mode === 'auto' ? t('traceEpfModeAuto') : t('traceEpfModeElection') },
  ];
  if (e.notApplicable) {
    rows.push({ label: t('traceNotApplicable'), value: t(EPF_NOT_APPLICABLE[e.notApplicable]) });
    return rows;
  }
  rows.push(
    { label: t('traceEpfNormalWages'), value: money(e.normalWage) },
    { label: t('traceEpfBonusWages'), value: money(e.bonusWage) },
    { label: e.part === 'E' ? t('traceEpfLookupWageNormal') : t('traceEpfLookupWage'), value: money(e.base) },
    ...epfLookupRows(e, t, money, percent, ''),
  );
  if (e.bonusEmployer) {
    rows.push({ label: t('traceEpfBonusEmployerPartE'), value: `${percent.format(e.bonusEmployer.rate)} → ${money(e.bonusEmployer.amount)}` });
  }
  if (e.flatLegs) {
    rows.push(
      { label: t('traceEpfFlatNormal'), value: `${money(e.flatLegs.normal.employee)} / ${money(e.flatLegs.normal.employer)}` },
      { label: t('traceEpfFlatBonus'), value: `${money(e.flatLegs.bonus.employee)} / ${money(e.flatLegs.bonus.employer)}` },
    );
  }
  if (e.normalOnly) {
    rows.push(...epfLookupRows(e.normalOnly, t, money, percent, 'normal'));
    rows.push({ label: t('traceEpfEmployeeOnBonus'), value: money(e.employeeOnBonus) });
  }
  if (e.raisedByElection) rows.push({ label: t('traceNote'), value: t('traceEpfRaised') });
  if (e.manualEmployee || e.manualEmployer) rows.push({ label: t('traceNote'), value: t('traceEpfManual') });
  rows.push(
    { label: t('traceMonthEmployee'), value: money(e.employee) },
    { label: t('traceMonthEmployer'), value: money(e.employer) },
  );
  if (trace.epfScheduleEffectiveFrom) rows.push({ label: t('traceScheduleEffective'), value: trace.epfScheduleEffectiveFrom });
  return rows;
}

/** SOCSO / SKBBK / EIS: category, wage, range and the two shares — or the reason it does not apply. */
export function scheduleTraceRows(trace: StatutoryTraceRecord, key: Exclude<TraceKey, 'epf'>, t: T, money: Money): TraceRow[] {
  const s = trace[key];
  const rows: TraceRow[] = [];
  if (key === 'socso') {
    rows.push({ label: t('traceSocsoCategory'), value: t(trace.socso.category === 2 ? 'traceSocsoCategory2' : 'traceSocsoCategory1') });
  }
  rows.push({ label: t('traceWageBasis'), value: money(s.wage) });
  if (s.notApplicable) {
    const reason = key === 'socso'
      ? t(SOCSO_NOT_APPLICABLE[trace.socso.notApplicable!])
      : key === 'skbbk'
        ? t(SKBBK_NOT_APPLICABLE[trace.skbbk.notApplicable!])
        : t(EIS_NOT_APPLICABLE[trace.eis.notApplicable!]);
    rows.push({ label: t('traceNotApplicable'), value: reason });
    return rows;
  }
  rows.push({ label: t(key === 'socso' ? 'traceTableSocso' : key === 'skbbk' ? 'traceTableSkbbk' : 'traceTableEis'), value: s.band ? traceRange(s.band, t, money) : '' });
  rows.push({ label: t('traceRowEmployee'), value: money(s.scheduleEmployee ?? s.employee) });
  if (key !== 'skbbk') rows.push({ label: t('traceRowEmployer'), value: money(s.scheduleEmployer ?? s.employer) });
  return rows;
}

const KEYS: Record<TraceKey, { employee: 'epfEmployee' | 'socsoEmployee' | 'socsoSkbbk' | 'eisEmployee'; employer: 'epfEmployer' | 'socsoEmployer' | 'eisEmployer' | null }> = {
  epf: { employee: 'epfEmployee', employer: 'epfEmployer' },
  socso: { employee: 'socsoEmployee', employer: 'socsoEmployer' },
  skbbk: { employee: 'socsoSkbbk', employer: null },
  eis: { employee: 'eisEmployee', employer: 'eisEmployer' },
};

/**
 * A bonus / off-cycle / restating run: the whole month's figure above, the range the month was at before
 * this run, what the earlier runs were charged, and the difference this run charged. A single run: just
 * the amounts on this payslip.
 */
export function runTraceRows(trace: StatutoryTraceRecord, key: TraceKey, t: T, money: Money): TraceRow[] {
  const k = KEYS[key];
  const rows: TraceRow[] = [];
  const run = trace.run;
  if (run.kind !== 'single') {
    rows.push({ label: t('traceRunKind'), value: t(RUN_KIND[run.kind]) });
    const before = run.before?.[key];
    if (before?.band && !before.notApplicable) {
      rows.push({ label: t('traceBeforeRange'), value: traceRange(before.band, t, money) });
    }
    if (run.chargedBefore) {
      rows.push({ label: t('traceChargedBeforeEmployee'), value: money(run.chargedBefore[k.employee]) });
      if (k.employer) rows.push({ label: t('traceChargedBeforeEmployer'), value: money(run.chargedBefore[k.employer]) });
    }
    if (key === 'epf' && run.earlier && run.earlier.unstamped > 0) {
      rows.push({ label: t('traceNote'), value: t('traceEarlierUnstamped') });
    }
  }
  rows.push({ label: t('traceThisRunEmployee'), value: money(run.thisRun[k.employee]) });
  if (k.employer) rows.push({ label: t('traceThisRunEmployer'), value: money(run.thisRun[k.employer]) });
  return rows;
}
