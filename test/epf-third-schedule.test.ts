/**
 * G1 (#95) — EPF Act 1991 THIRD SCHEDULE Part A golden test (citizen/PR < 60).
 * The statutory artifact backing the move from a rate-on-exact-wage approximation to the exact band
 * table. Amounts are the published derivation rule (band amount = ceil(rate × band-upper)), cross-checked
 * against the official KWSP "Jadual Ketiga" anchors. Any drift here is a real LHDN/KWSP filing change and
 * must be re-confirmed against the live KWSP calculator (see STATUTORY-SOURCES.md §2 sign-off).
 */
import { describe, expect, it } from 'vitest';
import { epf, epfContribution } from '../localization/my/payroll';
import { MY_EPF_THIRD_SCHEDULE_PART_A } from '../localization/my/statutory-tables';

describe('EPF Third Schedule Part A (#95)', () => {
  it('first band RM0.01–10 is a statutory NIL/NIL exception', () => {
    expect(epf(0.01)).toEqual({ employee: 0, employer: 0 });
    expect(epf(10)).toEqual({ employee: 0, employer: 0 });
    expect(epf(10.01).employee).toBe(3); // next band RM10.01–20: ceil(0.11*20)
  });

  it('matches the official KWSP anchors', () => {
    expect(epf(1000)).toEqual({ employee: 110, employer: 130 });
    expect(epf(3000)).toEqual({ employee: 330, employer: 390 });
    expect(epf(5000)).toEqual({ employee: 550, employer: 650 });
    expect(epf(6000)).toEqual({ employee: 660, employer: 720 });
    expect(epf(10000)).toEqual({ employee: 1100, employer: 1200 });
    expect(epf(20000)).toEqual({ employee: 2200, employer: 2400 });
  });

  it('uses the band, not the exact wage — the bug #95 fixes', () => {
    // Wage 2990 → band 2980.01–3000 → 330/390 (approximation gave 329/389).
    expect(epf(2990)).toEqual({ employee: 330, employer: 390 });
    // Wage exactly 2980 → band 2960.01–2980 → 328/388 (the lower band; boundary is exact).
    expect(epf(2980)).toEqual({ employee: 328, employer: 388 });
  });

  it('steps the employer rate 13%→12% at RM5,000 (a real drop, not an error)', () => {
    expect(epf(5000).employer).toBe(650); // ceil(0.13*5000)
    expect(epf(5000.01).employer).toBe(612); // band 5000.01–5100 → ceil(0.12*5100); 612 < 650
    expect(epf(5100).employer).toBe(612);
    expect(epf(5100).employee).toBe(561); // ceil(0.11*5100)
  });

  it('applies the exact percentage above RM20,000 where the schedule ends', () => {
    expect(epf(25000)).toEqual({ employee: 2750, employer: 3000 }); // 11% / 12%, round up to RM1
    expect(epf(33333)).toEqual({ employee: Math.ceil(33333 * 0.11), employer: Math.ceil(33333 * 0.12) });
  });

  it('reads the schedule ONCE for wage + bonus together (bdf7d248, r210)', () => {
    // MOVED, NOT BROKEN — this case used to assert { 1650, 1950 } and the reasoning it carried was
    // "the employer rate stays 13% because the NORMAL wage is ≤ RM5,000, even when the bonus pushes the
    // month over". Item bdf7d248 reversed exactly that: the Third Schedule describes a MONTH, so the
    // month's normal wage and its additional remuneration are added first and the combined base is what
    // the row is read for. RM5,000 + RM10,000 is a RM15,000 month, which is a 12% row: employee
    // ceil(11% × 15,000) = 1,650 (unchanged — this pair cannot tell the two readings apart on the
    // employee side) and employer ceil(12% × 15,000) = 1,800, where the old reading charged 1,950.
    // The reporter's own month is the case that shows the employee side moving too; it lives in
    // test/epf-combined-month-bdf7d248.test.ts.
    expect(epf(5000, 10000)).toEqual({ employee: 1650, employer: 1800 });
    // The same month paid on ONE payslip gives the same answer — the property the reporter asked for.
    expect(epf(15000, 0)).toEqual({ employee: 1650, employer: 1800 });
  });

  it('i-Topup raises a side; exempt zeroes both', () => {
    expect(epf(3000, 0, undefined, { mode: 'exempt' })).toEqual({ employee: 0, employer: 0 });
    // voluntary excess employee 15% on RM3000 = 450 > schedule floor 330 → raised
    expect(epf(3000, 0, undefined, { mode: 'voluntary_excess', employeeRate: 0.15 }).employee).toBe(450);
    // an election below the floor cannot lower it
    expect(epf(3000, 0, undefined, { mode: 'voluntary_excess', employeeRate: 0.05 }).employee).toBe(330);
  });

  it('the table is monotonic and spans NIL → RM20,000', () => {
    const t = MY_EPF_THIRD_SCHEDULE_PART_A;
    expect(t[0]).toEqual({ upTo: 10, employer: 0, employee: 0 });
    expect(t[t.length - 1]).toEqual({ upTo: 20000, employee: 2200, employer: 2400 });
    for (let i = 1; i < t.length; i++) expect(t[i].upTo).toBeGreaterThan(t[i - 1].upTo);
  });
});

describe('EPF by age + citizenship (Part E / non-citizen; deck slides 7–9)', () => {
  const ee = (r: { employee: number; employer: number }) => ({ employee: r.employee, employer: r.employer });

  it('citizen < 60 → Part A (default)', () => {
    expect(ee(epfContribution(3000, 0, undefined, undefined, { age: 35, citizenship: 'citizen' }))).toEqual({ employee: 330, employer: 390 });
    expect(ee(epfContribution(3000))).toEqual({ employee: 330, employer: 390 }); // no selection = citizen <60
  });

  it('Malaysian citizen 60–<75 → Part E (employee 0%, employer 4% banded)', () => {
    expect(ee(epfContribution(3000, 0, undefined, undefined, { age: 62, citizenship: 'citizen' }))).toEqual({ employee: 0, employer: 120 }); // ceil(0.04*3000)
    expect(ee(epfContribution(5000, 0, undefined, undefined, { age: 65, citizenship: 'citizen' }))).toEqual({ employee: 0, employer: 200 });
    // >RM20,000 tail: deck sample 22,300.80 × 4% = 892.032 → RM893
    expect(epfContribution(22300.8, 0, undefined, undefined, { age: 65, citizenship: 'citizen' }).employer).toBe(893);
  });

  it('non-citizen → flat 2% / 2% round up (deck sample 2,800.60 × 2% → RM57)', () => {
    expect(ee(epfContribution(2800.6, 0, undefined, undefined, { age: 30, citizenship: 'non_citizen' }))).toEqual({ employee: 57, employer: 57 });
    expect(ee(epfContribution(5000, 0, undefined, undefined, { age: 40, citizenship: 'non_citizen' }))).toEqual({ employee: 100, employer: 100 });
  });

  it('age ≥ 75 → no mandatory EPF', () => {
    expect(ee(epfContribution(8000, 0, undefined, undefined, { age: 76, citizenship: 'citizen' }))).toEqual({ employee: 0, employer: 0 });
  });

  it('bonus follows the selected rule (Part E employer 4%, non-citizen 2% both sides)', () => {
    // senior citizen, wage 3000 (employer 120) + bonus 1000 (employer ceil(0.04*1000)=40)
    expect(ee(epfContribution(3000, 1000, undefined, undefined, { age: 62, citizenship: 'citizen' }))).toEqual({ employee: 0, employer: 160 });
    // non-citizen, wage 5000 (100/100) + bonus 1000 (20/20)
    expect(ee(epfContribution(5000, 1000, undefined, undefined, { age: 30, citizenship: 'non_citizen' }))).toEqual({ employee: 120, employer: 120 });
  });
});
