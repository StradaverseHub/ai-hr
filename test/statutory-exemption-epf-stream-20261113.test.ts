/**
 * Owner decisions A and B (2026-11-13) — NO DATABASE. The pack options, the per-item trace treatment and the
 * month stamp reader. The kernel half on real payslips is test/statutory-exemption-epf-stream-20261113-db.test.ts.
 *
 *   A. A PCB exemption is income-tax only: EPF / SOCSO / EIS / SKBBK follow the item's ticks on the whole amount.
 *   B. The PCB remuneration type does not choose the EPF stream: only EPF Bonus 2012 is bonus EPF wages.
 *
 * Golden rows (KWSP Third Schedule Part A, PERKESO Act 4 / Act 800), independent of the code under test:
 *   3,734 + 1,000 exempt award = 4,734 → 4,720.01–4,740.00 → 522 / 617
 *   SOCSO 3,734 + 500 OT + 1,000 = 5,234 → 5,200.01–5,300.00 → 26.25 / 91.85; EIS 10.50
 */
import { describe, expect, it } from 'vitest';
import { statutory } from '../localization/my/payroll';
import { buildStatutoryTraceLines, readEarlierRunLiability, readRunStatutoryStamp } from '../core/statutory-trace';

const T = { trace: {} };

describe('the pack: the new agency-base options', () => {
  it('B0141: PCB-exempt money ticked EPF and SOCSO joins both bases (and nothing else)', () => {
    const before = statutory(3734, undefined, 0, 500, { month: 10 }, T);
    const after = statutory(3734, undefined, 0, 500, { month: 10 }, { ...T, exemptEpfWage: 1000, exemptSocsoWage: 1000 });
    expect([before.epfEmployee, before.epfEmployer]).toEqual([412, 487]);
    expect([after.epfEmployee, after.epfEmployer]).toEqual([522, 617]);
    expect([after.socsoEmployee, after.socsoEmployer, after.eisEmployee, after.eisEmployer]).toEqual([26.25, 91.85, 10.5, 10.5]);
    expect(after.statutoryTrace!.epf).toMatchObject({ normalWage: 4734, bonusWage: 0, band: { from: 4720.01, upTo: 4740 } });
    expect(after.statutoryTrace!.socso).toMatchObject({ wage: 5234, band: { from: 5200.01, upTo: 5300 } });
  });

  it("epfWageExtra moves 'additional' money to the NORMAL EPF stream without changing the amounts or PCB's Yt", () => {
    const bonusStream = statutory(4000, undefined, 800, 0, { month: 10 }, T);
    const normalStream = statutory(4000, undefined, 800, 0, { month: 10 }, { ...T, epfAdditionalExcluded: 800, epfWageExtra: 800 });
    expect(bonusStream.statutoryTrace!.epf).toMatchObject({ normalWage: 4000, bonusWage: 800 });
    expect(normalStream.statutoryTrace!.epf).toMatchObject({ normalWage: 4800, bonusWage: 0 });
    // One Third Schedule lookup on the month (bdf7d248), so the contribution is the same either way.
    expect([normalStream.epfEmployee, normalStream.epfEmployer]).toEqual([528, 624]);
    expect([bonusStream.epfEmployee, bonusStream.epfEmployer]).toEqual([528, 624]);
    // The bonus-share relief split follows the stream: nothing of it is EPF on a bonus any more.
    expect(normalStream.statutoryTrace!.epf.employeeOnBonus).toBe(0);
  });

  it('exemptEpfAdditional is bonus EPF wages (EPF Bonus 2012) and never SOCSO wages', () => {
    const r = statutory(4000, undefined, 0, 0, { month: 10 }, { ...T, exemptEpfAdditional: 800 });
    expect(r.statutoryTrace!.epf).toMatchObject({ normalWage: 4000, bonusWage: 800 });
    expect(r.statutoryTrace!.socso.wage).toBe(4000);
  });

  it('all four default to 0: byte-identical result for a caller that does not pass them', () => {
    const plain = statutory(5000, undefined, 1200, 300, { month: 10 }, T);
    const zeros = statutory(5000, undefined, 1200, 300, { month: 10 }, { ...T, epfWageExtra: 0, exemptEpfWage: 0, exemptEpfAdditional: 0, exemptSocsoWage: 0 });
    expect(zeros).toEqual(plain);
  });
});

describe('the trace: per-item treatment follows the ticks', () => {
  const totals = { epfNormal: 0, epfBonus: 0, socsoEis: 0 };
  const lines = (src: Parameters<typeof buildStatutoryTraceLines>[0]['lines'], b2012: string[] = []) =>
    buildStatutoryTraceLines({ basic: 0, lines: src, bonus2012Codes: new Set(b2012), ownOvertimeCharged: true, unpaid: 0, totals })
      .filter((l) => l.kind === 'item');

  it('a PCB-exempt slice stamped exemptStatutory counts by its ticks; an unstamped one (written before) counts nowhere', () => {
    const [award, legacy] = lines([
      { code: 'A0097', name: 'Award', epf: true, socso: true, exemptStatutory: true, buckets: [{ bucket: 'reimburse', amount: 1000 }] },
      { code: 'OLD', name: 'Old exempt', epf: true, socso: true, buckets: [{ bucket: 'reimburse', amount: 400 }] },
    ]);
    expect(award).toMatchObject({ amount: 1000, epfNormal: 1000, epfBonus: 0, socsoEis: 1000 });
    expect(legacy).toMatchObject({ amount: 400, epfNormal: 0, epfBonus: 0, socsoEis: 0 });
  });

  it('partial exemption: exempt slice and taxable remainder both normal EPF wages', () => {
    const [award] = lines([{ code: 'A0097', name: 'Award', epf: true, socso: true, exemptStatutory: true, epfNormalStream: true,
      buckets: [{ bucket: 'reimburse', amount: 2000 }, { bucket: 'bonus', amount: 500 }] }]);
    expect(award).toMatchObject({ amount: 2500, epfNormal: 2500, epfBonus: 0, socsoEis: 2500 });
  });

  it('EPF Bonus 2012: the exempt slice and the bonus stay on the bonus EPF stream, out of SOCSO/EIS', () => {
    const [bns] = lines([{ code: 'BNS', name: 'Bonus', epf: true, socso: true, exemptStatutory: true,
      buckets: [{ bucket: 'reimburse', amount: 300 }, { bucket: 'bonus', amount: 700 }] }], ['BNS']);
    expect(bns).toMatchObject({ epfNormal: 0, epfBonus: 1000, socsoEis: 0 });
  });

  it('an exempt slice ticked SOCSO but not EPF stays out of EPF', () => {
    const [x] = lines([{ code: 'X', name: 'X', epf: false, socso: true, exemptStatutory: true, buckets: [{ bucket: 'reimburse', amount: 1000 }] }]);
    expect(x).toMatchObject({ epfNormal: 0, epfBonus: 0, socsoEis: 1000 });
  });
});

describe('the month stamp: later runs read the new figures', () => {
  const stamp = (own: Record<string, unknown>) => ({ statutoryTrace: { version: 1, run: { own } } });

  it('reads the four 2026-11-13 figures, absent as 0, and refuses impossible ones', () => {
    expect(readRunStatutoryStamp(stamp({ epfAdditional: 0, socsoWageExtra: 0, epfWageExtra: 600, exemptEpfWage: 1000, exemptSocsoWage: 1000 }), 600))
      .toEqual({ epfAdditional: 0, socsoWageExtra: 0, epfWageExtra: 600, exemptEpfWage: 1000, exemptEpfAdditional: 0, exemptSocsoWage: 1000 });
    expect(readRunStatutoryStamp(stamp({ epfAdditional: 0, socsoWageExtra: 0, exemptEpfWage: -1 }), 600)).toBeNull();
    // Both EPF parts of the run's additional pay together can never exceed it.
    expect(readRunStatutoryStamp(stamp({ epfAdditional: 400, socsoWageExtra: 0, epfWageExtra: 400 }), 600)).toBeNull();
  });

  it('a pre-trace run read off its item lines: a line stamped epfNormalStream is normal EPF wages', () => {
    const lines = [
      { code: 'PERF', epf: true, epfNormalStream: true, buckets: [{ bucket: 'bonus', amount: 600 }] },
      { code: 'BNS', epf: true, buckets: [{ bucket: 'bonus', amount: 400 }] },
    ];
    expect(readEarlierRunLiability({ componentLines: lines }, 1000))
      .toMatchObject({ epfAdditional: 400, epfWageExtra: 600, source: 'component_lines' });
  });
});
