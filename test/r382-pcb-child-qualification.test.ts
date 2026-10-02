import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import { childReliefFor, childReliefPrices } from '../localization/my/child-relief';
import { pcbMonth } from '../localization/my/payroll';
import { assertChildQualificationReliefs, prepareChildQualificationReliefs, repriceChildQualificationReliefs, formatQualifyingChildCount } from '../localization/child-qualification';
import { getActiveStatutoryMY, saveStatutoryRulesetMY, setComponentOverrideMY, validateStatutoryRuleset } from '../localization/my/statutory-config';
import { assemble, initState } from '../components/statutory-config-form';

import { withTenant } from '../db/client';
import { statutoryRuleset } from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const base = () => structuredClone(DEFAULT_MY_STATUTORY.pcb.reliefs);
const legacy = () => { const r = base(); delete r.childQualificationVersion; delete r.childQualificationWeights; return r; };
const tableCases = [
  [{}, 0],
  [{ under_18: { full: 1 } }, 1],
  [{ under_18: { half: 1 } }, .5],
  [{ under_18: { full: 1 }, disabled_study: { full: 1 } }, 9],
  [{ under_18: { half: 1 }, study_tertiary: { full: 1, half: 1 } }, 6.5],
] as const;

describe('r382 one exact child qualification owner', () => {
  it.each(tableCases)('Q changes money without changing full/half/mixed count %j', (table, count) => {
    for (const q of [2000, 3000, 0]) {
      const reliefs = repriceChildQualificationReliefs({ ...base(), perChild: q }, base());
      const figure = childReliefFor({ from: 'table', taxCategory: 3, table, prices: childReliefPrices(reliefs) });
      expect(figure.units).toBe(count);
      expect(figure.amountRM).toBe(count * q);
      const pcb = { ...structuredClone(DEFAULT_MY_STATUTORY.pcb), reliefs };
      const result = pcbMonth({ monthlyWage: 14000, epfMonthly: 1540, month: 7, pcb, profile: { category: 3, childReliefAmount: figure.amountRM, childReliefCount: figure.units } });
      expect(result.snapshot.trace?.childCount).toBe(count);
      expect(result.snapshot.trace?.childCountVersion).toBe(1);
      expect(result.snapshot.reliefs.children).toBe(q * count);
    }
  });
  it.each([2000, 3000, 0])('manual and category-one use the same count owner at Q=%s', q => {
    const reliefs = repriceChildQualificationReliefs({ ...base(), perChild: q }, base());
    for (const category of [1, 2, 3] as const) {
      const figure = childReliefFor({ from: 'headCount', taxCategory: category, children: 3, perChild: q });
      const result = pcbMonth({ monthlyWage: 14000, epfMonthly: 1540, month: 7, pcb: { ...DEFAULT_MY_STATUTORY.pcb, reliefs }, profile: { category, children: 3, childReliefCount: figure.units } });
      expect(result.snapshot.trace?.childCount).toBe(figure.units);
      expect(result.snapshot.reliefs.children).toBe(figure.amountRM);
    }
  });
  it('legacy money stays intact and exact C is not rounded to a monetary precision', () => {
    const reliefs = { ...legacy(), perChild: 3000 };
    const figure = childReliefFor({ from: 'table', taxCategory: 3, table: { under_18: { full: 1 } }, prices: childReliefPrices(reliefs) });
    expect(figure.amountRM).toBe(2000);
    expect(figure.units).toBe(2 / 3);
    const result = pcbMonth({ monthlyWage: 14000, epfMonthly: 1540, month: 7, pcb: { ...DEFAULT_MY_STATUTORY.pcb, reliefs }, profile: { category: 3, childReliefAmount: figure.amountRM, childReliefCount: figure.units } });
    expect(result.snapshot.trace?.childCount).toBe(2 / 3);
    expect(result.snapshot.trace!.childCount * reliefs.perChild).toBe(2000);
    expect(formatQualifyingChildCount(result.snapshot.trace!.childCount)).toBe(String(figure.units));
  });
  it('count rendering cannot silently turn 1.25 into 1.3 or a shared claim into a whole child', () => {
    for (const count of [0, .5, 1.25, 6.5, 2 / 3, 9]) expect(formatQualifyingChildCount(count)).toBe(String(count));
    const src = readFileSync('components/identity-tax-card.tsx', 'utf8');
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain('const fmtCount = formatQualifyingChildCount');
    expect(src).not.toContain('n.toFixed(1)');
  });
  it('zero-Q weighted money cannot invent C without the owner count', () => {
    const reliefs = repriceChildQualificationReliefs({ ...base(), perChild: 0 }, base());
    expect(() => pcbMonth({ monthlyWage: 14000, epfMonthly: 1540, month: 7, pcb: { ...DEFAULT_MY_STATUTORY.pcb, reliefs }, profile: { category: 3, children: 2, childReliefAmount: 0 } })).toThrow('Child qualification configuration');
  });
  it('refuses a count that contradicts the actual payroll child deduction', () => {
    expect(() => pcbMonth({ monthlyWage: 14000, epfMonthly: 1540, month: 7, profile: { category: 3, childReliefAmount: 2000, childReliefCount: 9 } })).toThrow('Child qualification configuration');
  });
});

describe('r382 prospective effective-dated configuration contract', () => {
  it('materializes legacy weights against the OLD Q on a Q-only edit, without mutating either input', () => {
    const old = legacy();
    old.childByCategory!.under_18 = 2500;
    const input = { ...structuredClone(old), perChild: 3000 };
    const next = prepareChildQualificationReliefs(input, old);
    expect(next.childQualificationWeights?.under_18).toBe(1.25);
    expect(next.childByCategory?.under_18).toBe(3750);
    expect(input.childQualificationVersion).toBeUndefined();
    expect(old.childByCategory!.under_18).toBe(2500);
    expect(old.perChild).toBe(2000);
    const nextAgain = repriceChildQualificationReliefs({ ...next, perChild: 4000 }, next);
    expect(nextAgain.childQualificationWeights).toEqual(next.childQualificationWeights);
    expect(nextAgain.childByCategory?.under_18).toBe(5000);
  });
  it('preserves deliberately supplied independent legacy category monetary changes', () => {
    const old = legacy();
    const input = { ...structuredClone(old), perChild: 3000, childByCategory: { ...old.childByCategory, under_18: 4500 } };
    const next = prepareChildQualificationReliefs(input, old);
    expect(next.childByCategory?.under_18).toBe(4500);
    expect(next.childQualificationWeights?.under_18).toBe(1.5);
  });
  it('explicit versioned monetary/weight contradictions are refused, not silently reinterpreted', () => {
    const bad = { ...base(), perChild: 3000 };
    expect(() => prepareChildQualificationReliefs(bad, base())).toThrow();
    const rules = structuredClone(DEFAULT_MY_STATUTORY); rules.pcb.reliefs = bad;
    expect(validateStatutoryRuleset(rules)).toContain('pcb_child_relief_configuration_invalid');
  });
  it('zero Q plus positive legacy category money refuses payroll and yields no printable UI prices', () => {
    const reliefs = { ...legacy(), perChild: 0 };
    expect(() => assertChildQualificationReliefs(reliefs)).toThrow();
    expect(childReliefPrices(reliefs)).toEqual([]);
    expect(() => prepareChildQualificationReliefs(reliefs, reliefs)).toThrow();
    expect(() => pcbMonth({ monthlyWage: 14000, epfMonthly: 1540, month: 7, pcb: { ...DEFAULT_MY_STATUTORY.pcb, reliefs }, profile: { category: 3 } })).toThrow();
  });
  it('the actual advanced-editor round trip freezes legacy weights before replacing Q', () => {
    const rules = structuredClone(DEFAULT_MY_STATUTORY); rules.pcb.reliefs = legacy();
    const fallback = { partA: rules.epf.partA!, partE: rules.epf.partE! };
    const state = initState(rules, fallback); state.reliefPerChild = '3000';
    const next = assemble(state, rules, fallback) as typeof rules;
    expect(next.pcb.reliefs.perChild).toBe(3000);
    expect(next.pcb.reliefs.childQualificationWeights?.disabled_study).toBe(8);
    expect(next.pcb.reliefs.childByCategory?.disabled_study).toBe(24000);
    expect(validateStatutoryRuleset(next)).toEqual([]);
    expect(rules.pcb.reliefs.childByCategory?.disabled_study).toBe(16000);
  });
});


describe('r382 real append-only configuration publication', () => {
  let fixture: Base;
  beforeAll(async () => { await migrateTestDb(); });
  beforeEach(async () => { await resetDb(); fixture = await seedBase(); });
  afterAll(async () => { await closeAll(); });
  it('whole-ruleset publication freezes old weights and leaves the earlier effective-dated row unchanged', async () => {
    const old = structuredClone(DEFAULT_MY_STATUTORY); old.pcb.reliefs = legacy();
    await withTenant(adminCtx(fixture), tx => tx.insert(statutoryRuleset).values({ tenantId: fixture.tenantId, country: 'MY', version: 'legacy-child-prices', effectiveFrom: '2026-01-01', data: old }));
    const next = structuredClone(old); next.pcb.reliefs.perChild = 3000;
    await saveStatutoryRulesetMY(adminCtx(fixture), { effectiveFrom: '2026-02-01', version: 'explicit-child-weights', data: next });
    const prior = await withTenant(adminCtx(fixture), tx => getActiveStatutoryMY(tx, { asOf: '2026-01-01' }));
    const active = await withTenant(adminCtx(fixture), tx => getActiveStatutoryMY(tx, { asOf: '2026-02-01' }));
    expect(prior.pcb.reliefs.childQualificationVersion).toBeUndefined();
    expect(prior.pcb.reliefs.childByCategory?.under_18).toBe(2000);
    expect(active.pcb.reliefs.childQualificationVersion).toBe(1);
    expect(active.pcb.reliefs.childQualificationWeights?.under_18).toBe(1);
    expect(active.pcb.reliefs.childByCategory?.under_18).toBe(3000);
    expect(next.pcb.reliefs.childQualificationVersion).toBeUndefined();
  });
  it('PCB component publication uses the same prospective contract without changing other statutory bodies', async () => {
    const input = structuredClone(DEFAULT_MY_STATUTORY.pcb); input.reliefs = { ...legacy(), perChild: 3000 };
    await setComponentOverrideMY(adminCtx(fixture), { body: 'pcb', effectiveFrom: '2026-02-01', version: 'pcb-explicit-weights', data: input });
    const active = await withTenant(adminCtx(fixture), tx => getActiveStatutoryMY(tx, { asOf: '2026-02-01' }));
    expect(active.pcb.reliefs.childQualificationWeights?.disabled_study).toBe(8);
    expect(active.pcb.reliefs.childByCategory?.disabled_study).toBe(24000);
    expect(active.epf).toEqual(DEFAULT_MY_STATUTORY.epf);
    expect(input.reliefs.childQualificationVersion).toBeUndefined();
  });
});
