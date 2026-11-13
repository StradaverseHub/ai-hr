/**
 * Item 69d6ed3c — EPF / SOCSO / SKBBK / EIS statutory trace v1, and the multi-run EPF defect. NO DATABASE.
 *
 * The reporter (Irwin Law) asked that the Statutory Explanation show how each contribution was obtained —
 * the pay items in the wage, the wage range of the official table, and both shares — and that it "matches
 * the actual calculation engine result". So the trace is produced by the SAME pack calls that produce the
 * amounts, and these golden figures are the KWSP Third Schedule Part A and PERKESO Act 4 / Act 800 rows
 * the approved plan names, independent of the code that reads them:
 *
 *   Basic 3,500 + Transport 300 (EPF) + Bonus 800 (EPF + EPF Bonus 2012) + OT 250 + Phone 150 (no EPF)
 *     EPF wages 3,800 normal + 800 bonus = 4,600 → row 4,580.01–4,600.00 → 506 / 598
 *     normal alone 3,800 → row 3,780.01–3,800.00 → 418, so the bonus share is 88
 *     SOCSO wages 4,200 → row 4,100.01–4,200.00 → 20.75 / 72.65, SKBBK 31.15, EIS 8.30 / 8.30
 *
 * The kernel/database half (the stamp on real payslips, reprocess after unticking, the closed month and
 * the real multi-run 88 / 104) is test/statutory-trace-69d6ed3c-db.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { statutory, type StatutoryTraceV1 } from '../localization/my/payroll';
import { buildStatutoryTraceLines, readEarlierRunLiability, readRunStatutoryStamp } from '../core/statutory-trace';
import { readStatutoryTrace, STATUTORY_TRACE_AMOUNT_KEYS } from '../core/statutory-trace-explain';
import { explainStatutory } from '../core/statutory-explain';
import { epfTraceItemRows, epfTraceRows, runTraceRows, scheduleTraceItemRows, scheduleTraceRows, scheduleTraceWageHeading } from '../app/payroll/statutory-detail/statutory-trace';

const ROOT = path.resolve(__dirname, '..');
const code = (rel: string) =>
  fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SEL = { epfAge: 35, epfCitizenship: 'citizen' as const, epfWageMonth: '2026-10' };
/** The kernel's call shape: wage ex-OT, additional, OT, carve-outs, and the trace request. */
const run = (wage: number, additional: number, overtime: number, opts: Record<string, unknown> = {}) =>
  statutory(wage, undefined, additional, overtime, undefined, { ...SEL, trace: {}, ...opts });
const traceOf = (r: { statutoryTrace?: StatutoryTraceV1 }) => {
  expect(r.statutoryTrace, 'the kernel asked for a trace, so the pack must return one').toBeDefined();
  return r.statutoryTrace!;
};

// Basic 3,500 + Transport 300 + Phone 150 ride the normal stream (Phone not EPF); OT 250; Bonus 800 additional.
const GOLDEN = () => run(3950, 800, 250, { epfWageExcluded: 150 });

describe('69d6ed3c — golden: the trace is the calculation that produced the payslip', () => {
  it('Auto, citizen 35: EPF 4,600 reads row 4,580.01–4,600.00 → 506 / 598', () => {
    const r = GOLDEN();
    expect([r.epfEmployee, r.epfEmployer]).toEqual([506, 598]);
    const e = traceOf(r).epf;
    expect(e).toMatchObject({
      part: 'A', mode: 'auto', age: 35, citizenship: 'citizen', method: 'schedule_row',
      normalWage: 3800, bonusWage: 800, base: 4600,
      band: { from: 4580.01, upTo: 4600 },
      scheduleEmployee: 506, scheduleEmployer: 598, employee: 506, employer: 598,
    });
    // Normal wages alone: row 3,780.01–3,800.00 → 418, so the bonus share (Kₜ) is 506 − 418 = 88.
    expect(e.normalOnly).toMatchObject({ method: 'schedule_row', base: 3800, band: { from: 3780.01, upTo: 3800 }, scheduleEmployee: 418 });
    expect(e.employeeOnBonus).toBe(88);
  });

  it('SOCSO 4,200 reads row 4,100.01–4,200.00 → 20.75 / 72.65; SKBBK 31.15; EIS 8.30 / 8.30', () => {
    const r = GOLDEN();
    const t = traceOf(r);
    expect([r.socsoEmployee, r.socsoEmployer, r.socsoSkbbk, r.eisEmployee, r.eisEmployer]).toEqual([20.75, 72.65, 31.15, 8.3, 8.3]);
    expect(t.socso).toMatchObject({ category: 1, wage: 4200, band: { from: 4100.01, upTo: 4200 }, employee: 20.75, employer: 72.65 });
    expect(t.skbbk).toMatchObject({ wage: 4200, band: { from: 4100.01, upTo: 4200 }, employee: 31.15, employer: 0 });
    expect(t.eis).toMatchObject({ wage: 4200, band: { from: 4100.01, upTo: 4200 }, employee: 8.3, employer: 8.3 });
    for (const s of [t.socso, t.skbbk, t.eis]) expect(s.notApplicable).toBeUndefined();
  });

  it('every amount in the trace IS the amount on the result — the screen cannot disagree with the payslip', () => {
    const r = GOLDEN();
    const t = traceOf(r);
    expect(t.epf.employee).toBe(r.epfEmployee);
    expect(t.epf.employer).toBe(r.epfEmployer);
    expect(t.socso.employee).toBe(r.socsoEmployee);
    expect(t.socso.employer).toBe(r.socsoEmployer);
    expect(t.skbbk.employee).toBe(r.socsoSkbbk);
    expect(t.eis.employee).toBe(r.eisEmployee);
    expect(t.eis.employer).toBe(r.eisEmployer);
    expect(t.rulesetVersion).toBe(r.version);
  });

  it('asking for the trace changes nothing else: every other caller stays byte-identical', () => {
    const withTrace = GOLDEN() as Record<string, unknown>;
    const without = statutory(3950, undefined, 800, 250, undefined, { ...SEL, epfWageExcluded: 150 }) as Record<string, unknown>;
    expect('statutoryTrace' in without).toBe(false);
    const { statutoryTrace: _t, ...rest } = withTrace;
    expect(rest).toEqual(without);
  });

  it('untick EPF on Transport: EPF wages 4,300 → 473 / 559', () => {
    const r = run(3950, 800, 250, { epfWageExcluded: 450 });
    expect([r.epfEmployee, r.epfEmployer]).toEqual([473, 559]);
    expect(traceOf(r).epf).toMatchObject({ normalWage: 3500, bonusWage: 800, base: 4300, band: { from: 4280.01, upTo: 4300 } });
  });

  it('untick EPF Bonus 2012 on Bonus (PCB normal): EPF stays 506 / 598; SOCSO 5,000 → 24.75 / 86.65, SKBBK 37.15, EIS 9.90', () => {
    // The bonus now rides the normal stream (SOCSO ticked), so it joins the normal wage, and the SOCSO wage.
    const r = run(4750, 0, 250, { epfWageExcluded: 150 });
    expect([r.epfEmployee, r.epfEmployer]).toEqual([506, 598]);
    expect([r.socsoEmployee, r.socsoEmployer, r.socsoSkbbk, r.eisEmployee, r.eisEmployer]).toEqual([24.75, 86.65, 37.15, 9.9, 9.9]);
    const t = traceOf(r);
    expect(t.epf).toMatchObject({ normalWage: 4600, bonusWage: 0, band: { from: 4580.01, upTo: 4600 } });
    expect(t.epf.normalOnly, 'no bonus, so no separate normal-only lookup').toBeUndefined();
    expect(t.socso).toMatchObject({ wage: 5000, band: { from: 4900.01, upTo: 5000 } });
  });
});

describe('69d6ed3c — the multi-run defect, in the arithmetic the kernel performs', () => {
  // Regular run 3,800; bonus run 1 pays 1,000 NOT ticked for EPF; bonus run 2 pays 800 ticked for EPF.
  // Run 2's charge is (month with run 2) − (month before run 2).
  const month = (additional: number, epfAdditionalExcluded: number) =>
    statutory(3800, undefined, additional, 0, undefined, { ...SEL, epfAdditionalExcluded });

  it('fixed: earlier run 1 keeps its own "not EPF" — run 2 adds 506 − 418 = 88 and 598 − 494 = 104', () => {
    const now = month(1800, 1000);
    const before = month(1000, 1000);
    expect([now.epfEmployee - before.epfEmployee, now.epfEmployer - before.epfEmployer]).toEqual([88, 104]);
  });

  it('the old reading (earlier gross counted as EPF wages) gave 88 / 48: 5,600 at 616 / 672 minus 4,800 at 528 / 624', () => {
    const now = month(1800, 0);
    const before = month(1000, 0);
    expect([now.epfEmployee, now.epfEmployer, before.epfEmployee, before.epfEmployer]).toEqual([616, 672, 528, 624]);
    expect([now.epfEmployee - before.epfEmployee, now.epfEmployer - before.epfEmployer]).toEqual([88, 48]);
  });

  it('readRunStatutoryStamp reads an earlier run’s own stamp, and refuses one that cannot be true', () => {
    const stamped = { statutoryTrace: { version: 1, run: { own: { epfAdditional: 0, socsoWageExtra: 0 } } } };
    expect(readRunStatutoryStamp(stamped, 1000)).toEqual({ epfAdditional: 0, socsoWageExtra: 0 });
    expect(readRunStatutoryStamp({}, 1000), 'a payslip from before the trace has no stamp').toBeNull();
    expect(readRunStatutoryStamp({ statutoryTrace: { version: 1, run: { own: { epfAdditional: 1200, socsoWageExtra: 0 } } } }, 1000)).toBeNull();
    expect(readRunStatutoryStamp({ statutoryTrace: { version: 2, run: { own: { epfAdditional: 0, socsoWageExtra: 0 } } } }, 1000)).toBeNull();
    expect(readRunStatutoryStamp({ statutoryTrace: { version: 1, run: { own: { epfAdditional: -1, socsoWageExtra: 0 } } } }, 1000)).toBeNull();
  });
});

describe('69d6ed3c — a pre-trace earlier run is read off its own pay item lines', () => {
  const lines = [
    { code: 'B1', epf: false, buckets: [{ bucket: 'bonus', amount: 1000 }] },
    { code: 'T', epf: true, buckets: [{ bucket: 'wage', amount: 300 }] },
  ];
  it('EPF-liable = bonus-bucket money on EPF-ticked lines, when the lines add up to the slip bonus', () => {
    expect(readEarlierRunLiability({ componentLines: lines }, 1000)).toEqual({ epfAdditional: 0, socsoWageExtra: 0, source: 'component_lines' });
    expect(readEarlierRunLiability({ componentLines: [...lines, { code: 'B2', epf: true, buckets: [{ bucket: 'bonus', amount: 800 }] }] }, 1800))
      .toEqual({ epfAdditional: 800, socsoWageExtra: 0, source: 'component_lines' });
  });
  it('the trace stamp wins; lines that do not reconcile, or none at all, mean the old gross reading', () => {
    expect(readEarlierRunLiability({ componentLines: lines, statutoryTrace: { version: 1, run: { own: { epfAdditional: 0, socsoWageExtra: 5 } } } }, 1000))
      .toEqual({ epfAdditional: 0, socsoWageExtra: 5, source: 'trace' });
    expect(readEarlierRunLiability({ componentLines: lines }, 1200)).toBeNull();
    expect(readEarlierRunLiability({}, 1000)).toBeNull();
    expect(readEarlierRunLiability({ componentLines: [{ code: 'X', buckets: [] }] }, 0)).toBeNull();
  });
});

describe('69d6ed3c — not applicable is a reason, never a misleading wage range', () => {
  it('EPF at 75+: no contribution, reason age_75_plus', () => {
    const r = run(3950, 0, 0, { epfAge: 76 });
    expect([r.epfEmployee, r.epfEmployer]).toEqual([0, 0]);
    expect(traceOf(r).epf).toMatchObject({ method: 'no_contribution', notApplicable: 'age_75_plus' });
    expect(traceOf(r).epf.band).toBeUndefined();
  });

  it('EIS at 60+: the kernel’s reason is carried and no EIS range is shown', () => {
    const r = run(3950, 0, 0, { epfAge: 61, eisEligible: false, socsoCategory: 2, trace: { eisNotApplicable: 'age_60_plus' } });
    const t = traceOf(r);
    expect([r.eisEmployee, r.eisEmployer]).toEqual([0, 0]);
    expect(t.eis).toEqual({ wage: 3950, employee: 0, employer: 0, notApplicable: 'age_60_plus' });
    // SOCSO Second Category still applies (employer-only Injury) and still shows its row.
    expect(t.socso).toMatchObject({ category: 2, band: { from: 3900.01, upTo: 4000 }, employee: 0 });
    // Part E (citizen 60–74): the normal wage is banded alone, employee 0.
    expect(t.epf).toMatchObject({ part: 'E', method: 'schedule_row', employee: 0 });
  });

  it('Subject to SKBBK unticked: SKBBK 0 with reason not_subject; SOCSO unaffected', () => {
    const r = run(3950, 800, 250, { epfWageExcluded: 150, subjectToSkbbk: false });
    const t = traceOf(r);
    expect(r.socsoSkbbk).toBe(0);
    expect(t.skbbk).toEqual({ wage: 4200, employee: 0, employer: 0, notApplicable: 'not_subject' });
    expect(t.socso.band).toEqual({ from: 4100.01, upTo: 4200 });
  });

  it('SOCSO category None: reason category_none, no range', () => {
    const r = run(3950, 0, 0, { subjectToSocso: false, trace: { socsoNotApplicable: 'category_none' } });
    expect(traceOf(r).socso).toEqual({ category: 1, wage: 3950, employee: 0, employer: 0, notApplicable: 'category_none' });
  });

  it('EPF exempt category: reason exempt', () => {
    const r = run(3950, 0, 0, { epfElection: { mode: 'exempt' } });
    expect(traceOf(r).epf).toMatchObject({ method: 'exempt', notApplicable: 'exempt', employee: 0, employer: 0 });
  });

  it('a wage above the PERKESO table reads the top row and says so', () => {
    const t = traceOf(run(9000, 0, 0));
    expect(t.socso.band).toEqual({ from: 5900.01, upTo: 6000, aboveTable: true });
  });

  it('non-citizen: the flat rate on each stream, both legs recorded', () => {
    const t = traceOf(run(3000, 1000, 0, { epfCitizenship: 'non_citizen' }));
    expect(t.epf).toMatchObject({ method: 'flat_rate', part: null, employeeRate: 0.02, employerRate: 0.02, employee: 80, employer: 80 });
    expect(t.epf.flatLegs).toEqual({ normal: { employee: 60, employer: 60 }, bonus: { employee: 20, employer: 20 } });
  });
});

describe('69d6ed3c — the kernel’s item lines add up to the bases', () => {
  const lines = [
    { code: 'TRANSPORT', name: 'Transport', buckets: [{ bucket: 'wage' as const, amount: 300 }], epf: true, socso: true },
    { code: 'PHONE', name: 'Phone', buckets: [{ bucket: 'wage' as const, amount: 150 }], epf: false, socso: true },
    { code: 'OT', name: 'Overtime', buckets: [{ bucket: 'ot' as const, amount: 250 }], epf: false, socso: true },
    { code: 'BNS', name: 'Bonus', buckets: [{ bucket: 'bonus' as const, amount: 800 }], epf: true, socso: true },
  ];
  it('each line carries its settings as read and its contribution to each wage', () => {
    const out = buildStatutoryTraceLines({
      basic: 3500, lines, bonus2012Codes: new Set(['BNS']), ownOvertimeCharged: true, unpaid: 0,
      totals: { epfNormal: 3800, epfBonus: 800, socsoEis: 4200 },
    });
    expect(out).toEqual([
      { kind: 'basic', amount: 3500, epfNormal: 3500, epfBonus: 0, socsoEis: 3500 },
      { kind: 'item', code: 'TRANSPORT', name: 'Transport', amount: 300, epf: true, epfBonus2012: false, socso: true, epfNormal: 300, epfBonus: 0, socsoEis: 300 },
      { kind: 'item', code: 'PHONE', name: 'Phone', amount: 150, epf: false, epfBonus2012: false, socso: true, epfNormal: 0, epfBonus: 0, socsoEis: 150 },
      { kind: 'item', code: 'OT', name: 'Overtime', amount: 250, epf: false, epfBonus2012: false, socso: true, epfNormal: 0, epfBonus: 0, socsoEis: 250 },
      // EPF Bonus 2012 keeps the bonus out of SOCSO even with SOCSO ticked (SOCSO Act 1969 s.2).
      { kind: 'item', code: 'BNS', name: 'Bonus', amount: 800, epf: true, epfBonus2012: true, socso: true, epfNormal: 0, epfBonus: 800, socsoEis: 0 },
    ]);
  });
  it('money the items cannot account for is disclosed as one other line, never hidden', () => {
    const out = buildStatutoryTraceLines({
      basic: 3500, lines: [], bonus2012Codes: new Set(), ownOvertimeCharged: true, unpaid: 100,
      totals: { epfNormal: 3500, epfBonus: 0, socsoEis: 3400 },
    });
    expect(out.at(-1)).toEqual({ kind: 'other', epfNormal: 100, epfBonus: 0, socsoEis: 0 });
  });
});

type KernelLine = Parameters<typeof buildStatutoryTraceLines>[0]['lines'][number];
const GOLDEN_LINES: KernelLine[] = [
  { code: 'TRANSPORT', name: 'Transport', buckets: [{ bucket: 'wage', amount: 300 }], epf: true, socso: true },
  { code: 'PHONE', name: 'Phone', buckets: [{ bucket: 'wage', amount: 150 }], epf: false, socso: true },
  { code: 'OT', name: 'Overtime', buckets: [{ bucket: 'ot', amount: 250 }], epf: false, socso: true },
  { code: 'BNS', name: 'Bonus', buckets: [{ bucket: 'bonus', amount: 800 }], epf: true, socso: true },
];

/** A stamped payslip blob for the reader, built from a real pack result + real kernel lines. */
function stampFrom(r: ReturnType<typeof run>, lines: KernelLine[], bonus2012Codes: Set<string>) {
  const t = traceOf(r);
  const items = buildStatutoryTraceLines({
    basic: 3500, lines, bonus2012Codes, ownOvertimeCharged: true, unpaid: 0,
    totals: { epfNormal: t.epf.normalWage, epfBonus: t.epf.bonusWage, socsoEis: t.socso.wage },
  });
  const thisRun = Object.fromEntries(STATUTORY_TRACE_AMOUNT_KEYS.map((k) => [k, r[k]]));
  return {
    ...r,
    bases: { epf: t.epf.normalWage, epfAdditional: t.epf.bonusWage, socsoEis: t.socso.wage, pcb: 5000, hrdf: 0 },
    statutoryTrace: { ...t, items, run: { kind: 'single', own: { epfAdditional: t.epf.bonusWage, socsoWageExtra: 0 }, thisRun } },
  };
}
const stampedBlob = () => stampFrom(GOLDEN(), GOLDEN_LINES, new Set(['BNS']));

describe('69d6ed3c — the explanation reads the trace, checks it, and never recomputes', () => {
  it('a reconciling trace is shown', () => {
    const ex = explainStatutory(stampedBlob(), 'regular');
    expect(ex.traceStatus).toBe('recorded');
    expect(ex.trace?.epf.band).toEqual({ from: 4580.01, upTo: 4600 });
  });

  it('a payslip from before the trace: absent, so the screen shows the pre-trace note', () => {
    const { statutoryTrace: _t, ...old } = stampedBlob();
    const ex = explainStatutory(old, 'regular');
    expect(ex.traceStatus).toBe('absent');
    expect(ex.trace).toBeNull();
    // …and the saved amounts are still the payslip's, untouched.
    expect(ex.items.find((i) => i.key === 'epf')!.employeeReported).toBe(506);
  });

  it('a trace whose amounts do not match the payslip is "not recorded", never shown', () => {
    const blob = stampedBlob();
    const ex = explainStatutory({ ...blob, epfEmployee: 507 }, 'regular');
    expect(ex.traceStatus).toBe('invalid');
    expect(ex.trace).toBeNull();
  });

  it('item lines that do not add up to the wage are "not recorded"', () => {
    const blob = stampedBlob();
    const broken = { ...blob, statutoryTrace: { ...blob.statutoryTrace, items: blob.statutoryTrace.items.slice(1) } };
    expect(explainStatutory(broken, 'regular').traceStatus).toBe('invalid');
  });

  it('a line set by hand under Statutory Adjustment: the trace explains the system figure it recorded', () => {
    const blob = stampedBlob();
    const adjusted = { ...blob, epfEmployee: 500, adjustment: { reason: 'agreed', lines: { epfEmployee: { system: 506, applied: 500 } } } };
    const ex = explainStatutory(adjusted, 'regular');
    expect(ex.traceStatus).toBe('recorded');
    expect(ex.items[0].provenance.source).toBe('statutoryAdjustment');
  });

  it('a delta run must reconcile: this run = whole month − charged by earlier runs', () => {
    const blob = stampedBlob();
    const tr = blob.statutoryTrace;
    const charged = { epfEmployee: 418, epfEmployer: 494, socsoEmployee: 20.75, socsoEmployer: 72.65, socsoSkbbk: 31.15, eisEmployee: 8.3, eisEmployer: 8.3 };
    const thisRun = { epfEmployee: 88, epfEmployer: 104, socsoEmployee: 0, socsoEmployer: 0, socsoSkbbk: 0, eisEmployee: 0, eisEmployer: 0 };
    const delta = { ...blob, ...thisRun, statutoryTrace: { ...tr, run: { ...tr.run, kind: 'additional', chargedBefore: charged, thisRun } } };
    expect(explainStatutory(delta, 'bonus').traceStatus).toBe('recorded');
    const wrong = { ...delta, statutoryTrace: { ...delta.statutoryTrace, run: { ...delta.statutoryTrace.run, chargedBefore: { ...charged, epfEmployer: 550 } } } };
    expect(explainStatutory(wrong, 'bonus').traceStatus).toBe('invalid');
  });

  it('the import fence holds: the readers reach no pack, kernel, database or session', () => {
    for (const rel of ['core/statutory-trace-explain.ts', 'core/statutory-explain.ts']) {
      const src = code(rel);
      for (const forbidden of ["from '../db/", "from './payroll'", "from './statutory-trace'", "from '../localization/", "from '../packs/", 'SessionContext', 'withTenant']) {
        expect(src, `${rel} must not reach ${forbidden}`).not.toContain(forbidden);
      }
    }
    expect([...code('core/statutory-trace-explain.ts').matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])).toEqual(['zod']);
    expect(readStatutoryTrace(undefined, {} as never).status).toBe('absent');
  });
});

describe('69d6ed3c — the screen and the workbook rows', () => {
  const t = (key: string, values?: Record<string, string>) => (values ? `${key}(${Object.values(values).join('|')})` : key);
  const money = (n: number) => n.toFixed(2);
  it('EPF: items with their settings and treatment, the range, the shares and this payslip', () => {
    const trace = explainStatutory(stampedBlob(), 'regular').trace!;
    const items = epfTraceItemRows(trace, t, money);
    expect(items.find((r) => r.code === 'BNS')).toMatchObject({ treatment: 'traceTreatEpfBonus2012', contribution: '800.00' });
    expect(items.find((r) => r.code === 'PHONE')).toMatchObject({ treatment: 'traceTreatEpfExcluded', contribution: '0.00' });
    expect(items.find((r) => r.code === 'TRANSPORT')!.settings).toBe('traceEpfSettings(traceYes|traceNo)');
    const rows = epfTraceRows(trace, t, money, 'en-MY');
    expect(rows).toContainEqual({ label: 'traceEpfRange', value: 'traceRange(4580.01|4600.00)' });
    expect(rows).toContainEqual({ label: 'traceEpfRowEmployee', value: '506.00' });
    expect(rows).toContainEqual({ label: 'traceEpfRowEmployer', value: '598.00' });
    expect(rows).toContainEqual({ label: 'traceEpfRangeNormalOnly', value: 'traceRange(3780.01|3800.00)' });
    expect(rows).toContainEqual({ label: 'traceEpfEmployeeOnBonus', value: '88.00' });
    expect(rows).toContainEqual({ label: 'traceClassification', value: 'traceEpfClassification(traceCitizen|traceAgeUnder60)' });
    expect(runTraceRows(trace, 'epf', t, money)).toEqual([
      { label: 'traceThisRunEmployee', value: '506.00' },
      { label: 'traceThisRunEmployer', value: '598.00' },
    ]);
  });
  it('SOCSO / SKBBK / EIS rows, and SOCSO’s item table', () => {
    const trace = explainStatutory(stampedBlob(), 'regular').trace!;
    expect(scheduleTraceItemRows(trace, 'socso', t, money).at(-1)).toMatchObject({ contribution: '4200.00', emphasis: true });
    expect(scheduleTraceRows(trace, 'socso', t, money)).toContainEqual({ label: 'traceTableSocso', value: 'traceRange(4100.01|4200.00)' });
    expect(scheduleTraceRows(trace, 'skbbk', t, money)).toContainEqual({ label: 'traceRowEmployee', value: '31.15' });
    expect(scheduleTraceRows(trace, 'eis', t, money)).toContainEqual({ label: 'traceRowEmployer', value: '8.30' });
  });
});

describe('69d6ed3c — SOCSO, SKBBK and EIS each explain their own wage, classification and range', () => {
  const t = (key: string, values?: Record<string, string>) => (values ? `${key}(${Object.values(values).join('|')})` : key);
  const rm = (n: number) => n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const traceFor = (blob: ReturnType<typeof stampedBlob>) => {
    const ex = explainStatutory(blob, 'regular');
    expect(ex.traceStatus, 'the fixture must reconcile, or the screen shows no trace at all').toBe('recorded');
    return ex.trace!;
  };
  // Basic 3,500 + Transport 300 (EPF) + OT 250 + Phone 150 (SOCSO ticked, no EPF) + Bonus 800 (EPF Bonus 2012).
  const golden = () => traceFor(stampedBlob());

  const SCHEMES = [
    { key: 'socso', heading: 'traceColSocsoWages', included: 'traceTreatSocsoIncluded', bonus: 'traceTreatSocsoExcludedBonus2012', total: 'traceSocsoTotal' },
    { key: 'skbbk', heading: 'traceColSkbbkWages', included: 'traceTreatSkbbkIncluded', bonus: 'traceTreatSkbbkExcludedBonus2012', total: 'traceSkbbkTotal' },
    { key: 'eis', heading: 'traceColEisWages', included: 'traceTreatEisIncluded', bonus: 'traceTreatEisExcludedBonus2012', total: 'traceEisTotal' },
  ] as const;

  it.each(SCHEMES)('$key: its own pay item table, Bonus 2012 kept out, ending at 4,200.00', ({ key, heading, included, bonus, total }) => {
    const rows = scheduleTraceItemRows(golden(), key, t, rm);
    expect(scheduleTraceWageHeading(key, t)).toBe(heading);
    expect(rows.map((r) => [r.description, r.amount, r.settings, r.treatment, r.contribution])).toEqual([
      ['traceLineBasic', '3,500.00', '', included, '3,500.00'],
      ['Transport', '300.00', 'traceSocsoSetting(traceYes)', included, '300.00'],
      ['Phone', '150.00', 'traceSocsoSetting(traceYes)', included, '150.00'],
      ['Overtime', '250.00', 'traceSocsoSetting(traceYes)', included, '250.00'],
      // Ticked for SOCSO/EIS, yet EPF Bonus 2012 kept it out — so the setting that excluded it is shown.
      ['Bonus', '800.00', 'traceSocsoSettings(traceYes|traceYes)', bonus, '0.00'],
      [total, '', '', '', '4,200.00'],
    ]);
    expect(rows.at(-1)!.emphasis).toBe(true);
  });

  it('an item with the SOCSO/EIS tick off reads "not included", without a bonus reason', () => {
    const lines = GOLDEN_LINES.map((l) => (l.code === 'PHONE' ? { ...l, socso: false } : l));
    const r = run(3950, 800, 250, { epfWageExcluded: 150, socsoWageExcluded: 150 });
    const trace = traceFor(stampFrom(r, lines, new Set(['BNS'])));
    const phone = scheduleTraceItemRows(trace, 'eis', t, rm).find((row) => row.code === 'PHONE');
    expect(phone).toMatchObject({ settings: 'traceSocsoSetting(traceNo)', treatment: 'traceTreatEisExcluded', contribution: '0.00' });
    expect(scheduleTraceItemRows(trace, 'eis', t, rm).at(-1)!.contribution).toBe('4,050.00');
  });

  it('classification: SOCSO category, citizenship and age group on all three; EIS eligibility', () => {
    const trace = golden();
    for (const key of ['socso', 'skbbk', 'eis'] as const) {
      const rows = scheduleTraceRows(trace, key, t, rm);
      expect(rows.slice(0, 2)).toEqual([
        { label: 'traceSocsoCategory', value: 'traceSocsoCategory1' },
        { label: 'traceClassification', value: 'traceSchemeClassification(traceCitizen|traceSchemeAge18To59)' },
      ]);
    }
    expect(scheduleTraceRows(trace, 'eis', t, rm)).toContainEqual({ label: 'traceEisEligibility', value: 'traceEisEligible' });
    expect(scheduleTraceRows(trace, 'socso', t, rm).some((r) => r.label === 'traceEisEligibility')).toBe(false);
  });

  it('the rows already shown stay: EIS wage, row 4,100.01–4,200.00 and 8.30 / 8.30; SKBBK employee only', () => {
    const trace = golden();
    expect(scheduleTraceRows(trace, 'eis', t, rm).slice(3)).toEqual([
      { label: 'traceWageBasis', value: '4,200.00' },
      { label: 'traceTableEis', value: 'traceRange(4,100.01|4,200.00)' },
      { label: 'traceRowEmployee', value: '8.30' },
      { label: 'traceRowEmployer', value: '8.30' },
    ]);
    const skbbk = scheduleTraceRows(trace, 'skbbk', t, rm);
    expect(skbbk).toContainEqual({ label: 'traceRowEmployee', value: '31.15' });
    expect(skbbk.some((r) => r.label === 'traceRowEmployer')).toBe(false);
    expect(runTraceRows(trace, 'eis', t, rm)).toEqual([
      { label: 'traceThisRunEmployee', value: '8.30' },
      { label: 'traceThisRunEmployer', value: '8.30' },
    ]);
  });

  it('EIS at age 60+: not eligible, the trace’s reason, no EIS range; SOCSO Second Category, age 60 and above', () => {
    const r = run(3950, 0, 0, { epfAge: 61, epfWageExcluded: 150, eisEligible: false, socsoCategory: 2, trace: { eisNotApplicable: 'age_60_plus' } });
    const trace = traceFor(stampFrom(r, GOLDEN_LINES.filter((l) => l.code === 'TRANSPORT' || l.code === 'PHONE'), new Set()));
    expect(scheduleTraceRows(trace, 'eis', t, rm)).toEqual([
      { label: 'traceSocsoCategory', value: 'traceSocsoCategory2' },
      { label: 'traceClassification', value: 'traceSchemeClassification(traceCitizen|traceSchemeAge60)' },
      { label: 'traceEisEligibility', value: 'traceEisIneligible' },
      { label: 'traceWageBasis', value: '3,950.00' },
      { label: 'traceNotApplicable', value: 'traceEisAge60' },
    ]);
    // The wage it would have been charged on is still itemised, read off the same lines.
    expect(scheduleTraceItemRows(trace, 'eis', t, rm).at(-1)).toMatchObject({ description: 'traceEisTotal', contribution: '3,950.00' });
  });

  it('non-citizen: citizenship shown, EIS not applicable for non-citizens', () => {
    const r = run(3950, 0, 0, { epfWageExcluded: 150, epfCitizenship: 'non_citizen', eisEligible: false, socsoCategory: 2, trace: { eisNotApplicable: 'non_citizen' } });
    const trace = traceFor(stampFrom(r, GOLDEN_LINES.filter((l) => l.code === 'TRANSPORT' || l.code === 'PHONE'), new Set()));
    const eis = scheduleTraceRows(trace, 'eis', t, rm);
    expect(eis).toContainEqual({ label: 'traceClassification', value: 'traceSchemeClassification(traceNonCitizen|traceSchemeAge18To59)' });
    expect(eis).toContainEqual({ label: 'traceNotApplicable', value: 'traceEisNonCitizen' });
    expect(eis.some((row) => row.label === 'traceTableEis')).toBe(false);
    expect(scheduleTraceRows(trace, 'socso', t, rm)).toContainEqual({ label: 'traceClassification', value: 'traceSchemeClassification(traceNonCitizen|traceSchemeAge18To59)' });
  });

  it('an age the run did not record is left out, never guessed', () => {
    const trace = traceFor(stampFrom(run(3950, 800, 250, { epfAge: undefined, epfWageExcluded: 150 }), GOLDEN_LINES, new Set(['BNS'])));
    expect(trace.epf.age).toBeNull();
    expect(scheduleTraceRows(trace, 'socso', t, rm)).toContainEqual({ label: 'traceClassification', value: 'traceCitizen' });
  });

  it('the screen and the workbook build every scheme’s table from the shared builder; the “same as SOCSO” note is gone', () => {
    for (const rel of ['app/payroll/statutory-detail/statutory-detail-view.tsx', 'app/payroll/statutory-detail/export/route.ts']) {
      const src = code(rel);
      expect(src, rel).toContain('scheduleTraceItemRows(');
      expect(src, rel).toContain('scheduleTraceWageHeading(');
      expect(src, rel).not.toContain('traceSameWageAsSocso');
    }
    for (const locale of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const ns = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${locale}.json`), 'utf8')).payroll.statutoryDetail;
      expect(ns.traceSameWageAsSocso, locale).toBeUndefined();
      // Every key the SOCSO / SKBBK / EIS builders reach through a lookup table, which the coverage scan cannot see.
      const reached = [
        ...SCHEMES.flatMap((s) => [s.heading, s.included, s.bonus, s.total]),
        'traceTreatSocsoExcluded', 'traceTreatSkbbkExcluded', 'traceTreatEisExcluded', 'traceSocsoSetting', 'traceSocsoSettings',
        'traceSchemeClassification', 'traceSchemeAgeUnder18', 'traceSchemeAge18To59', 'traceSchemeAge60',
        'traceEisEligibility', 'traceEisEligible', 'traceEisIneligible',
      ];
      for (const k of reached) expect(ns[k], `${locale}.${k}`).toBeTruthy();
    }
  });
});
