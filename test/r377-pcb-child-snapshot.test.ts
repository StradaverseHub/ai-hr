import { describe, expect, it } from 'vitest';
import { pcbMonth } from '../localization/my/payroll';
import { childReliefFor, childReliefPrices } from '../localization/my/child-relief';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import { explainPcb, pcbSlipSections } from '../core/pcb-explain';

const sides = { profile: { mode: 'auto_table', table: { disabled_study: { full: 99 } }, disabledIndividual: true, disabledSpouse: true }, catalogue: [], rebateCatalogue: [], currentDeduction: null, accumulatedDeduction: null, previousDeduction: null, currentRebate: null, accumulatedRebate: null };
const current = { individual: 9000, spouse: 0, children: 0, disabledIndividual: 0, disabledSpouse: 0, total: 9000, lp: 0 };
function run(table: Record<string, { full?: number; half?: number }>, q = 2000) {
  const pcb = structuredClone(DEFAULT_MY_STATUTORY.pcb);
  pcb.reliefs.perChild = q;
  const figure = childReliefFor({ from: 'table', table, prices: childReliefPrices(pcb.reliefs) });
  const childWorking = { mode: 'auto_table' as const, table, rows: figure.rows, categoryUnits: Object.fromEntries(figure.rows.map(row => [row.category, figure.rows.filter(other => other.category === row.category).reduce((sum, other) => sum + other.units, 0)])), headCount: figure.rows.reduce((n, r) => n + r.children, 0) };
  const payroll = pcbMonth({ monthlyWage: 14000, epfMonthly: 1540, month: 7, profile: { category: 2, children: 0, childReliefAmount: figure.amountRM, childWorking }, pcb });
  const x = explainPcb({ pcb: payroll.total, pcbBonus: payroll.additional, pcbMeta: payroll.snapshot }, current);
  if (x.kind !== 'mtd') throw Error('expected MTD');
  return { payroll, x, section: pcbSlipSections(x, sides)[0], childWorking };
}
const cell = (r: ReturnType<typeof run>, key: string) => r.section.rows.find(row => row.caption === key)!;
describe('r377 immutable child working', () => {
  it.each([
    [{}, 0, 0], [{ under_18: { full: 1 } }, 1, 1], [{ under_18: { half: 1 } }, .5, .5],
    [{ under_18: { full: 1 }, disabled_study: { half: 1 } }, 5, 1],
  ] as const)('records actual weighted claims %j', (table, c, under18) => {
    const r = run(table);
    expect(r.x.trace?.childCount).toBe(c);
    expect(cell(r, 'slipChildUnder18').third).toEqual({ kind: 'count', count: under18 });
    expect(cell(r, 'slipChildDisabled').third).toEqual({ kind: 'count', count: 0 });
    expect(cell(r, 'slipChildRelief').first).toEqual({ kind: 'money', amount: 2000 });
    expect(r.x.reliefs.children).toBe(2000 * c);
  });
  it('subsequent Q follows resolved configuration while an earlier snapshot stays immutable', () => {
    const earlier = run({ under_18: { full: 1 } });
    earlier.childWorking.table.under_18.full = 99;
    expect(earlier.payroll.snapshot.trace?.childWorking?.table?.under_18?.full).toBe(1);
    const later = run({ under_18: { full: 1 } }, 1000);
    expect(later.x.trace?.childDeductionPerChild).toBe(1000);
    expect(earlier.x.trace?.childDeductionPerChild).toBe(2000);
    expect(cell(earlier, 'slipChildUnder18').first).toEqual({ kind: 'count', count: 1 });
    expect(pcbSlipSections(earlier.x, { ...sides, profile: null })[0]).toEqual(earlier.section);
  });
  it('legacy childCount without Q is not assumed to be a weighted C', () => {
    const r = run({ under_18: { full: 1 } });
    const snapshot = structuredClone(r.payroll.snapshot);
    delete snapshot.trace!.childWorking;
    delete (snapshot.trace as Partial<NonNullable<typeof snapshot.trace>>).childDeductionPerChild;
    const x = explainPcb({ pcb: r.payroll.total, pcbMeta: snapshot }, current);
    if (x.kind !== 'mtd') throw Error('expected MTD');
    expect(x.trace?.childCount).toBeNull();
    const section = pcbSlipSections(x, sides)[0];
    expect(section.rows.find(row => row.caption === 'slipChildUnder18')?.first).toEqual({ kind: 'notRecorded' });
    expect(section.rows.find(row => row.caption === 'slipChildCount')?.first).toEqual({ kind: 'notRecorded' });
  });
  it('manual totals preserve C without inventing child-category claims', () => {
    const r = pcbMonth({ monthlyWage: 14000, epfMonthly: 1540, month: 7, profile: { category: 2, children: 3, childWorking: { mode: 'manual', table: null, rows: [], categoryUnits: {}, headCount: 3 } } });
    const x = explainPcb({ pcb: r.total, pcbMeta: r.snapshot }, current);
    if (x.kind !== 'mtd') throw Error('expected MTD');
    expect(x.trace?.childCount).toBe(3);
    const section = pcbSlipSections(x, sides)[0];
    expect(section.rows.find(row => row.caption === 'slipChildUnder18')?.third).toEqual({ kind: 'notRecorded' });
  });
});
