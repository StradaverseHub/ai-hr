/**
 * Statutory trace v1 (item 69d6ed3c) — EVERY contribution shape the pack computes gets the trace. NO DATABASE.
 *
 * Reported on staging, 13 Nov 2026: a regular-run payslip reprocessed for one Auto-EPF employee carried no
 * `statutory.statutoryTrace`, so the Statutory Explanation said the working was not recorded. That payslip
 * was written by the background import worker, which was still running the release from before the trace
 * existed (the web had been updated; the worker was updated about 18 minutes after the reprocess). This file
 * pins the property the incident was suspected of breaking, so a real code defect of that kind would fail
 * here rather than on a payslip:
 *
 *   · the reported shape — Auto EPF, citizen under 60, EPF wages 1,690 (a deduction ticked for EPF and
 *     SOCSO/EIS), overtime-type additional pay 60.62 that is SOCSO/EIS wages but not EPF wages, so
 *     SOCSO/EIS wages 1,750.62 — returns the trace, and it names the rows the amounts came from:
 *       KWSP Third Schedule Part A, row 1,680.01–1,700.00 → 187 / 221
 *       PERKESO Act 4 First Category, row 1,700.01–1,800.00 → 8.75 / 30.65, SKBBK 13.15
 *       Act 800 Second Schedule, row 1,700.01–1,800.00 → 3.50 / 3.50
 *   · a sweep of every EPF branch (citizen / PR / non-citizen × age bands × each EPF category, with and
 *     without additional pay) × each SOCSO / SKBBK / EIS switch × each PCB path returns a trace whose
 *     amounts ARE the result's amounts, never moves money, and is accepted by the Statutory Explanation's
 *     reconciliation guard once the kernel's stamp is laid around it;
 *   · SOCSO, SKBBK and EIS are traced for an employee with no EPF contribution at all (exempt, 75+).
 *
 * The kernel and database half — processing, the background reprocess job and the request-path reprocess,
 * additional and restating runs, post-employment payments — is test/statutory-trace-every-shape-20261113-db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { statutory, type EpfElection, type StatutoryTraceV1 } from '../localization/my/payroll';
import { buildStatutoryTraceLines } from '../core/statutory-trace';
import { readStatutoryTrace, STATUTORY_TRACE_AMOUNT_KEYS, type StatutoryTraceAmountKey } from '../core/statutory-trace-explain';

type Result = ReturnType<typeof statutory>;
type Opts = NonNullable<Parameters<typeof statutory>[5]>;
const TRACE_REQUEST = { socsoNotApplicable: 'not_subject', eisNotApplicable: 'not_eligible' } as const;
const PCB_CTX = { month: 11 };
const amountsOf = (r: Result): Record<StatutoryTraceAmountKey, number> => ({
  epfEmployee: r.epfEmployee, epfEmployer: r.epfEmployer,
  socsoEmployee: r.socsoEmployee, socsoEmployer: r.socsoEmployer, socsoSkbbk: r.socsoSkbbk,
  eisEmployee: r.eisEmployee, eisEmployer: r.eisEmployer,
});
const traceOf = (r: Result) => (r as { statutoryTrace?: StatutoryTraceV1 }).statutoryTrace;

/** The kernel's stamp around the pack's trace for a single run (core/payroll.ts `savedStatutoryTrace`), with no
 *  pay item lines: `buildStatutoryTraceLines` then discloses each whole base as one `other` line. */
function stampedSingleRun(trace: StatutoryTraceV1, r: Result) {
  const items = buildStatutoryTraceLines({
    basic: 0, lines: [], bonus2012Codes: new Set(), ownOvertimeCharged: true, unpaid: 0,
    totals: { epfNormal: trace.epf.normalWage, epfBonus: trace.epf.bonusWage, socsoEis: trace.socso.wage },
  });
  return { ...trace, items, run: { kind: 'single' as const, own: { epfAdditional: trace.epf.bonusWage, socsoWageExtra: 0 }, thisRun: amountsOf(r) } };
}

// The reported payslip's option bag, as the kernel builds it: 1,990 of normal wages with 300 of absence
// ticked for EPF, SOCSO/EIS and PCB, plus 60.62 of overtime-type additional pay that is not EPF wages and is
// SOCSO/EIS wages. Fictional employee; the figures are the shape, not anybody's pay.
const REPORTED: Opts = {
  trace: TRACE_REQUEST,
  epfAge: 41, epfCitizenship: 'citizen', epfWageMonth: '2026-11',
  epfElection: { mode: 'auto', employeeRate: null, employerRate: null, employeeAmount: null, employerAmount: null },
  epfWageDeduction: 300, socsoWageDeduction: 300, pcbWageDeduction: 300,
  epfAdditionalExcluded: 60.62, socsoWageExtra: 60.62,
};
const reported = (opts: Opts = REPORTED) => statutory(1990, { category: 1, children: 0 }, 60.62, 0, PCB_CTX, opts);

describe('the reported shape: Auto EPF, regular single run, EPF 1,690, SOCSO/EIS 1,750.62', () => {
  it('returns the trace, naming the schedule rows the payslip amounts came from', () => {
    const r = reported();
    expect(amountsOf(r)).toEqual({ epfEmployee: 187, epfEmployer: 221, socsoEmployee: 8.75, socsoEmployer: 30.65, socsoSkbbk: 13.15, eisEmployee: 3.5, eisEmployer: 3.5 });
    const t = traceOf(r);
    expect(t, 'the kernel asked for the trace, so every Auto-EPF regular payslip must carry it').toBeDefined();
    expect(t!.epf).toMatchObject({
      part: 'A', mode: 'auto', citizenship: 'citizen', method: 'schedule_row', normalWage: 1690, bonusWage: 0, base: 1690,
      band: { from: 1680.01, upTo: 1700 }, scheduleEmployee: 187, scheduleEmployer: 221, employee: 187, employer: 221, employeeOnBonus: 0,
    });
    expect(t!.socso).toMatchObject({ category: 1, wage: 1750.62, band: { from: 1700.01, upTo: 1800 }, employee: 8.75, employer: 30.65 });
    expect(t!.skbbk).toMatchObject({ wage: 1750.62, band: { from: 1700.01, upTo: 1800 }, employee: 13.15, employer: 0 });
    expect(t!.eis).toMatchObject({ wage: 1750.62, band: { from: 1700.01, upTo: 1800 }, employee: 3.5, employer: 3.5 });
    for (const s of [t!.socso, t!.skbbk, t!.eis]) expect(s.notApplicable).toBeUndefined();
    expect(readStatutoryTrace(stampedSingleRun(t!, r), amountsOf(r)).status).toBe('recorded');
  });

  it('the trace moves no money: the result without it is the untraced result, key for key', () => {
    const { statutoryTrace, ...traced } = reported() as Result & { statutoryTrace?: unknown };
    expect(statutoryTrace).toBeDefined();
    const { trace: _ignored, ...untracedOpts } = REPORTED;
    expect(traced).toEqual(reported(untracedOpts));
    expect(traceOf(reported(untracedOpts)), 'a caller that does not ask gets no trace key').toBeUndefined();
  });
});

describe('SOCSO, SKBBK and EIS are traced whatever EPF does', () => {
  const election = (mode: EpfElection['mode'], extra: Partial<EpfElection> = {}): EpfElection =>
    ({ mode, employeeRate: null, employerRate: null, employeeAmount: null, employerAmount: null, ...extra });

  it('EPF exempt: EPF 0 / 0 read as exempt; SOCSO / SKBBK / EIS still name their rows', () => {
    const r = reported({ ...REPORTED, epfElection: election('exempt') });
    const t = traceOf(r)!;
    expect([r.epfEmployee, r.epfEmployer]).toEqual([0, 0]);
    expect(t.epf).toMatchObject({ method: 'exempt', notApplicable: 'exempt', employee: 0, employer: 0 });
    expect(t.socso).toMatchObject({ band: { from: 1700.01, upTo: 1800 }, employee: 8.75, employer: 30.65 });
    expect(t.skbbk).toMatchObject({ employee: 13.15 });
    expect(t.eis).toMatchObject({ employee: 3.5, employer: 3.5 });
    expect(readStatutoryTrace(stampedSingleRun(t, r), amountsOf(r)).status).toBe('recorded');
  });

  it('age 75+: no EPF contribution; SOCSO Second Category, SKBBK and EIS (60+) are traced', () => {
    const r = reported({ ...REPORTED, epfAge: 78, socsoCategory: 2, eisEligible: false, trace: { ...TRACE_REQUEST, eisNotApplicable: 'age_60_plus' } });
    const t = traceOf(r)!;
    expect(t.epf).toMatchObject({ method: 'no_contribution', notApplicable: 'age_75_plus', employee: 0, employer: 0 });
    expect(t.socso).toMatchObject({ category: 2, employee: 0, employer: r.socsoEmployer });
    expect(r.socsoEmployer).toBeGreaterThan(0);
    expect(t.skbbk.employee).toBe(r.socsoSkbbk);
    expect(t.eis).toMatchObject({ employee: 0, employer: 0, notApplicable: 'age_60_plus' });
    expect(readStatutoryTrace(stampedSingleRun(t, r), amountsOf(r)).status).toBe('recorded');
  });
});

describe('every EPF branch × every SOCSO / SKBBK / EIS switch × every PCB path returns a reconciling trace', () => {
  const CITIZENSHIP = ['citizen', 'pr', 'non_citizen'] as const;
  const AGES = [null, 18, 35, 59, 60, 66, 74, 75, 80] as const;
  const ELECTIONS: [string, EpfElection][] = [
    ['auto', { mode: 'auto' }],
    ['exempt', { mode: 'exempt' }],
    ['voluntary excess, both sides', { mode: 'voluntary_excess', employeeRate: 0.15, employerRate: 0.15 }],
    ['voluntary excess, employee only (entered-rate working)', { mode: 'voluntary_excess', employeeRate: 0.15, employerRate: null }],
    ['voluntary excess, employer only', { mode: 'voluntary_excess', employeeRate: null, employerRate: 0.14 }],
    ['manual percentage', { mode: 'manual_percentage', employeeRate: 0.09, employerRate: 0.12 }],
    ['top-up percentage', { mode: 'topup_percentage', employeeRate: 0.02, employerRate: 0.01 }],
    ['manual amount, both sides', { mode: 'manual_amount', employeeAmount: 150, employerAmount: 180 }],
    ['manual amount, employee only', { mode: 'manual_amount', employeeAmount: 150, employerAmount: null }],
  ];
  // Normal wage / additional pay: the reported figures, nothing at all, past the SOCSO/EIS ceiling, and past
  // the end of the Third Schedule (the percentage formula).
  const WAGES: [number, number][] = [[1990, 60.62], [1990, 0], [0, 0], [0, 800], [7200, 1500], [25000, 3000]];
  const SWITCHES: [string, Partial<Opts>][] = [
    ['all on', {}],
    ['SOCSO not subject', { subjectToSocso: false }],
    ['SOCSO category none', { subjectToSocso: false, trace: { ...TRACE_REQUEST, socsoNotApplicable: 'category_none' } }],
    ['SKBBK not subject', { subjectToSkbbk: false }],
    ['EIS not eligible', { eisEligible: false }],
    ['EIS category none', { eisEligible: false, trace: { ...TRACE_REQUEST, eisNotApplicable: 'category_none' } }],
    ['SOCSO Second Category', { socsoCategory: 2 }],
  ];
  const PCB: [string, Partial<Opts>][] = [
    ['resident', {}],
    ['non-resident flat rate', { resident: false, calculationScheme: 'non_resident' }],
    ['not subject to income tax', { taxCircumstance: { version: 1, epoch: 0, key: 'none', applicable: false, category: null } }],
  ];

  it('no shape drops the trace, moves money, or fails the screen’s reconciliation guard', () => {
    const failures: string[] = [];
    let checked = 0;
    let refusedByRule = 0;
    for (const citizenship of CITIZENSHIP) for (const age of AGES) for (const [label, e] of ELECTIONS)
      for (const [wage, additional] of WAGES) for (const [sw, flags] of SWITCHES) for (const [pcb, pcbOpts] of PCB) {
        const shape = `${citizenship} age ${age} · ${label} · ${wage}+${additional} · ${sw} · ${pcb}`;
        const untracedOpts: Opts = {
          epfAge: age, epfCitizenship: citizenship, epfWageMonth: '2026-11',
          epfElection: { employeeRate: null, employerRate: null, employeeAmount: null, employerAmount: null, ...e },
          epfAdditionalExcluded: additional === 60.62 ? 60.62 : 0, socsoWageExtra: additional === 60.62 ? 60.62 : 0,
          ...flags, ...pcbOpts,
        };
        delete (untracedOpts as { trace?: unknown }).trace;
        let untraced: Result;
        try {
          untraced = statutory(wage, { category: 1, children: 0 }, additional, 0, PCB_CTX, untracedOpts);
        } catch {
          // A combination the calculation itself refuses has no payslip to explain.
          refusedByRule += 1;
          continue;
        }
        const r = statutory(wage, { category: 1, children: 0 }, additional, 0, PCB_CTX, { ...untracedOpts, trace: flags.trace ?? TRACE_REQUEST });
        checked += 1;
        const t = traceOf(r);
        if (!t) { failures.push(`${shape}: no trace`); continue; }
        const { statutoryTrace: _t, ...rest } = r as Result & { statutoryTrace?: unknown };
        if (JSON.stringify(rest) !== JSON.stringify(untraced)) failures.push(`${shape}: the trace changed the result`);
        const month = { epfEmployee: t.epf.employee, epfEmployer: t.epf.employer, socsoEmployee: t.socso.employee, socsoEmployer: t.socso.employer,
          socsoSkbbk: t.skbbk.employee, eisEmployee: t.eis.employee, eisEmployer: t.eis.employer };
        for (const k of STATUTORY_TRACE_AMOUNT_KEYS) if (month[k] !== amountsOf(r)[k]) failures.push(`${shape}: trace ${k} ${month[k]} ≠ result ${amountsOf(r)[k]}`);
        if (t.rulesetVersion !== r.version) failures.push(`${shape}: ruleset ${t.rulesetVersion} ≠ ${r.version}`);
        if ((flags.subjectToSocso === false) !== (t.socso.notApplicable != null)) failures.push(`${shape}: SOCSO not-applicable flag disagrees with the switch`);
        if ((flags.eisEligible === false) !== (t.eis.notApplicable != null)) failures.push(`${shape}: EIS not-applicable flag disagrees with the switch`);
        if (flags.subjectToSkbbk === false && t.skbbk.notApplicable !== 'not_subject') failures.push(`${shape}: SKBBK off but traced as charged`);
        const read = readStatutoryTrace(stampedSingleRun(t, r), amountsOf(r));
        if (read.status !== 'recorded') failures.push(`${shape}: the explanation reads it as ${read.status}`);
      }
    expect(failures.slice(0, 20), `${failures.length} of ${checked} shapes failed`).toEqual([]);
    // The sweep really ran: every combination except the ones the calculation itself refuses.
    expect(checked).toBeGreaterThan(9000);
    expect(refusedByRule).toBeLessThan(checked / 10);
  });
});
