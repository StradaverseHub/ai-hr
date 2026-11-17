/** Approved ffb6c2e0: EPF classification never adjudicates another agency's wage switch. */
import { describe, expect, it } from 'vitest';
import { nonEpfStatutoryWage } from '../core/statutory-wage-inclusion';
import { buildStatutoryTraceLines, readEarlierRunLiability } from '../core/statutory-trace';
import { scheduleTraceItemRows } from '../app/payroll/statutory-detail/statutory-trace';
import { readStatutoryTrace } from '../core/statutory-trace-explain';
import { statutory } from '../localization/my/payroll';

const schemes = ['socso', 'eis', 'skbbk'] as const;
const selection = { trace: {}, epfAge: 35, epfCitizenship: 'citizen' as const, epfWageMonth: '2026-10' };
const cases = [false, true].flatMap(epfBonus2012 => [false, true].map(socso => ({ epfBonus2012, socso })));

describe('ffb6c2e0 — independent non-EPF item inclusion', () => {
  it.each(cases)('taxable/exempt, EPF Bonus 2012 $epfBonus2012, SOCSO/EIS $socso', ({ epfBonus2012, socso }) => {
    const source = { code: 'AWARD', name: 'Award', epf: true, socso, exemptStatutory: true,
      epfNormalStream: true as const, buckets: [{ bucket: 'bonus' as const, amount: 700 }, { bucket: 'reimburse' as const, amount: 300 }] };
    const wage = socso ? 1000 : 0;
    const items = buildStatutoryTraceLines({ basic: 4000, lines: [source], bonus2012Codes: new Set(epfBonus2012 ? ['AWARD'] : []),
      ownOvertimeCharged: true, unpaid: 0, totals: { epfNormal: epfBonus2012 ? 4000 : 5000, epfBonus: epfBonus2012 ? 1000 : 0, socsoEis: 4000 + wage } });
    expect(items.find(l => l.code === 'AWARD')).toMatchObject({ socsoEis: wage, epfNormal: epfBonus2012 ? 0 : 1000, epfBonus: epfBonus2012 ? 1000 : 0 });
    expect(items.some(l => l.kind === 'other')).toBe(false);
    const r = statutory(4000, undefined, 700, 0, { month: 10 }, { ...selection,
      ...(epfBonus2012 ? { exemptEpfAdditional: 300 } : { epfAdditionalExcluded: 700, epfWageExtra: 700, exemptEpfWage: 300 }),
      socsoWageExtra: nonEpfStatutoryWage(700, socso), exemptSocsoWage: nonEpfStatutoryWage(300, socso) });
    const trace = r.statutoryTrace!;
    for (const scheme of schemes) expect(trace[scheme].wage).toBe(4000 + wage);
    expect([r.socsoEmployee, r.socsoEmployer, r.socsoSkbbk, r.eisEmployee, r.eisEmployer])
      .toEqual(socso ? [24.75, 86.65, 37.15, 9.9, 9.9] : [19.75, 69.15, 29.65, 7.9, 7.9]);
    expect([r.epfEmployee, r.epfEmployer]).toEqual([550, 650]);
  });

  it('signed adjustments retain their sign; overtime and unticked deductions keep existing routing', () => {
    expect(nonEpfStatutoryWage(-125.35, true)).toBe(-125.35);
    expect(nonEpfStatutoryWage(-125.35, false)).toBe(0);
    const out = buildStatutoryTraceLines({ basic: 4000, bonus2012Codes: new Set(['X']), ownOvertimeCharged: true, unpaid: 0,
      lines: [{ code: 'X', name: 'Adjustment', epf: true, socso: true, buckets: [{ bucket: 'bonus', amount: -125.35 }] },
        { code: 'D', name: 'Deduction', epf: false, socso: false, buckets: [{ bucket: 'deduct', amount: 80 }] },
        { code: 'OT', name: 'OT', epf: false, socso: true, buckets: [{ bucket: 'ot', amount: 50 }] }],
      totals: { epfNormal: 4000, epfBonus: -125.35, socsoEis: 3924.65 } });
    expect(out.find(l => l.code === 'X')?.socsoEis).toBe(-125.35);
    expect(out.find(l => l.code === 'D')?.socsoEis).toBe(0);
    expect(out.find(l => l.code === 'OT')?.socsoEis).toBe(50);
    expect(out.some(l => l.kind === 'other')).toBe(false);
  });

  it('eligibility and cap rules follow the corrected base without hiding inclusion', () => {
    const r = statutory(5900, undefined, 500, 0, undefined, { ...selection, socsoWageExtra: 500,
      subjectToSocso: false, subjectToSkbbk: false, eisEligible: false });
    for (const scheme of schemes) expect(r.statutoryTrace![scheme].wage).toBe(6400);
    expect([r.socsoEmployee, r.socsoEmployer, r.socsoSkbbk, r.eisEmployee]).toEqual([0, 0, 0, 0]);
    const eligible = statutory(5900, undefined, 500, 0, undefined, { ...selection, socsoWageExtra: 500 });
    expect([eligible.socsoEmployee, eligible.socsoEmployer, eligible.socsoSkbbk, eligible.eisEmployee]).toEqual([29.75, 104.15, 44.65, 11.9]);
    expect(eligible.statutoryTrace!.socso.band).toEqual({ from: 5900.01, upTo: 6000, aboveTable: true });
  });

  it('earlier persisted liability is read verbatim, regardless of today’s rule', () => {
    for (const socsoWageExtra of [0, 700]) {
      const original = { statutoryTrace: { version: 1, run: { own: { epfAdditional: 700, socsoWageExtra, exemptSocsoWage: 300 } } } };
      const bytes = JSON.stringify(original);
      expect(readEarlierRunLiability(original, 700)).toMatchObject({ socsoWageExtra, exemptSocsoWage: 300, source: 'trace' });
      expect(JSON.stringify(original)).toBe(bytes);
    }
  });

  it('the explanation shows stored inclusion and preserves a historical exclusion', () => {
    for (const included of [false, true]) {
      const result = statutory(4000, undefined, 800, 0, undefined, { ...selection, socsoWageExtra: included ? 800 : 0 });
      const trace = { ...result.statutoryTrace!, items: [{ kind: 'basic' as const, amount: 4000, epfNormal: 4000, epfBonus: 0, socsoEis: 4000 }, { kind: 'item' as const, code: 'X', name: 'Award', amount: 800,
        epf: true, epfBonus2012: true, socso: true, epfNormal: 0, epfBonus: 800, socsoEis: included ? 800 : 0 }],
        run: { kind: 'single' as const, own: { epfAdditional: 800, socsoWageExtra: included ? 800 : 0 }, thisRun: result } };
      const stored = { ...result, statutoryTrace: trace };
      const bytes = JSON.stringify(stored);
      const read = readStatutoryTrace(stored.statutoryTrace, result);
      expect(read.status).toBe('recorded');
      if (!read.trace) throw new Error('fixture trace must reconcile');
      for (const key of schemes) {
        const row = scheduleTraceItemRows(read.trace, key, k => k, n => n.toFixed(2)).find(r => r.code === 'X')!;
        expect(row.treatment).toBe(included ? `traceTreat${key === 'socso' ? 'Socso' : key === 'eis' ? 'Eis' : 'Skbbk'}Included` : `traceTreat${key === 'socso' ? 'Socso' : key === 'eis' ? 'Eis' : 'Skbbk'}ExcludedBonus2012`);
        expect(row.contribution).toBe(included ? '800.00' : '0.00');
      }
      expect(JSON.stringify(stored)).toBe(bytes);
    }
  });
});
