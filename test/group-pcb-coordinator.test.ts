/**
 * ADR-0029 (G2 Slice 2b) — `coordinatedPcbForPerson` golden test. Proves the coordinator's correctness
 * claim through the real `pcbMonth`: a person's month is taxed ONCE on the combined remuneration, the
 * allocated slices sum exactly to that combined MTD, and the combined MTD EXCEEDS the sum of the
 * per-employment MTDs (the under-deduction that per-employer filing causes — the gap this gate closes).
 */
import { describe, expect, it } from 'vitest';
import { coordinatedPcbForPerson, pcbMonth } from '../localization/my/payroll';

const r2 = (n: number) => Math.round(n * 100) / 100;

describe('coordinatedPcbForPerson (#G2 / ADR-0029)', () => {
  it('taxes the combined month once; slices sum to it and exceed the per-employer sum', () => {
    // Same person earning RM4,000 at company A and RM4,000 at company B (no EPF, single, Jan, no priors).
    const a = pcbMonth({ monthlyWage: 4000, epfMonthly: 0, month: 1 });
    const b = pcbMonth({ monthlyWage: 4000, epfMonthly: 0, month: 1 });
    const summed = r2(a.total + b.total); // what two independent employers would each deduct → filed total
    const combined = pcbMonth({ monthlyWage: 8000, epfMonthly: 0, month: 1 }).total;

    const c = coordinatedPcbForPerson(
      [
        { employmentId: 'A', monthlyWage: 4000, epfMonthly: 0 },
        { employmentId: 'B', monthlyWage: 4000, epfMonthly: 0 },
      ],
      { month: 1 },
    );
    const sliceSum = r2(c.byEmployment.get('A')!.pcb + c.byEmployment.get('B')!.pcb);

    expect(c.combinedMtd).toBe(combined);
    expect(sliceSum).toBe(combined); // allocated slices sum to the combined MTD, to the sen
    expect(combined).toBeGreaterThan(summed); // per-employer filing under-deducts (progressive tax)
  });

  it('a single employment equals plain pcbMonth (no-op for the majority)', () => {
    const plain = pcbMonth({ monthlyWage: 6000, epfMonthly: 660, month: 1 });
    const c = coordinatedPcbForPerson([{ employmentId: 'solo', monthlyWage: 6000, epfMonthly: 660 }], { month: 1 });
    expect(c.byEmployment.get('solo')!.pcb).toBe(plain.total);
  });

  it('allocates a combined bonus across the bonus shares and sums exactly', () => {
    const c = coordinatedPcbForPerson(
      [
        { employmentId: 'A', monthlyWage: 5000, epfMonthly: 550, additional: 2000, epfOnAdditional: 220 },
        { employmentId: 'B', monthlyWage: 3000, epfMonthly: 330 },
      ],
      { month: 1 },
    );
    const totalPcb = r2([...c.byEmployment.values()].reduce((s, x) => s + x.pcb, 0));
    const totalBonus = r2([...c.byEmployment.values()].reduce((s, x) => s + x.pcbBonus, 0));
    expect(totalPcb).toBe(c.combinedMtd);
    expect(totalBonus).toBe(c.combinedAdditional);
  });
});
