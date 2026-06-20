/**
 * ADR-0029 (G2) — `allocatePcb` golden test. The pure split of a person's single combined monthly MTD
 * back across their concurrent employments. Invariant: the slices ALWAYS sum to the combined total/
 * additional to the sen (residual pinned to the largest-share employment). The combined-vs-summed
 * correctness (combined MTD < sum of per-employment MTD) is proven in the kernel test (Slice 2).
 */
import { describe, expect, it } from 'vitest';
import { allocatePcb } from '../localization/my/payroll';

const sum = (m: Map<string, { pcb: number; pcbBonus: number }>, f: 'pcb' | 'pcbBonus') =>
  Math.round([...m.values()].reduce((a, b) => a + b[f], 0) * 100) / 100;

describe('allocatePcb (#G2 / ADR-0029)', () => {
  it('splits the combined MTD pro-rata and sums to the total to the sen', () => {
    const r = allocatePcb(500, 0, [
      { employmentId: 'a', normalShare: 3000, bonusShare: 0 },
      { employmentId: 'b', normalShare: 4000, bonusShare: 0 },
    ]);
    expect(r.get('a')!.pcb).toBe(214.29); // round2(500 * 3000/7000)
    expect(r.get('b')!.pcb).toBe(285.71); // residual: 500 − 214.29
    expect(sum(r, 'pcb')).toBe(500);
  });

  it('allocates the additional (bonus) MTD on the bonus share', () => {
    const r = allocatePcb(0, 300, [
      { employmentId: 'a', normalShare: 5000, bonusShare: 1000 },
      { employmentId: 'b', normalShare: 5000, bonusShare: 2000 },
    ]);
    expect(r.get('a')!.pcbBonus).toBe(100);
    expect(r.get('b')!.pcbBonus).toBe(200);
    expect(sum(r, 'pcbBonus')).toBe(300);
  });

  it('pins the rounding residual so three-way splits still sum exactly', () => {
    const r = allocatePcb(100, 0, [
      { employmentId: 'a', normalShare: 1000, bonusShare: 0 },
      { employmentId: 'b', normalShare: 1000, bonusShare: 0 },
      { employmentId: 'c', normalShare: 1000, bonusShare: 0 },
    ]);
    expect(sum(r, 'pcb')).toBe(100); // 33.33 + 33.33 + 33.34
  });

  it('a single employment receives the whole amount', () => {
    const r = allocatePcb(250, 40, [{ employmentId: 'solo', normalShare: 5000, bonusShare: 1000 }]);
    expect(r.get('solo')).toEqual({ pcb: 250, pcbBonus: 40 });
  });

  it('falls back to the first employment when there is no taxable basis', () => {
    const r = allocatePcb(90, 0, [
      { employmentId: 'a', normalShare: 0, bonusShare: 0 },
      { employmentId: 'b', normalShare: 0, bonusShare: 0 },
    ]);
    expect(sum(r, 'pcb')).toBe(90);
    expect(r.get('a')!.pcb).toBe(90);
    expect(r.get('b')!.pcb).toBe(0);
  });
});
