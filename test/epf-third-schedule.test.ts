/**
 * G1 (#95) — EPF Act 1991 THIRD SCHEDULE Part A golden test (citizen/PR < 60).
 * The statutory artifact backing the move from a rate-on-exact-wage approximation to the exact band
 * table. Amounts are the published derivation rule (band amount = ceil(rate × band-upper)), cross-checked
 * against the official KWSP "Jadual Ketiga" anchors. Any drift here is a real LHDN/KWSP filing change and
 * must be re-confirmed against the live KWSP calculator (see STATUTORY-SOURCES.md §2 sign-off).
 */
import { describe, expect, it } from 'vitest';
import { epf } from '../localization/my/payroll';
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

  it('adds the bonus as percentage on top of the schedule wage-amount (employer rate fixed by the wage)', () => {
    // wage 5000 (schedule 550/650) + bonus 10000 (employer rate stays 13% — fixed by the ≤5000 wage)
    expect(epf(5000, 10000)).toEqual({ employee: 1650, employer: 1950 });
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
