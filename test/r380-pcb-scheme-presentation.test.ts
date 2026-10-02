import {describe, expect, it} from 'vitest';
import {explainPcb, pcbMtdStep1Section, pcbWorksheet} from '../core/pcb-explain';
import {pcbFormulaBlocks} from '../app/payroll/pcb-detail/formulas';

// Synthetic stored facts, not a second payroll calculation. Deliberately include a legacy rate key
// to prove that immutable scheme dispatch takes priority over the old flat reader.
function saved(scheme: 'rep' | 'knowledge_worker' | 'c_suite' = 'rep') {
  return {pcb: 45, pcbBonus: 0, zakat: 5, epfEmployee: 100, pcbMeta: {
    taxSchemeDeclarationId: '11111111-2222-4333-8444-555555555555', calculationScheme: scheme, rate: .15, month: 10, n: 2, ytdNet: 1000, epfClaimed: 500,
    pcbPaid: 20, P1: 30000, reliefs: {individual: 9000, spouse: 0, children: 0,
      disabledIndividual: 0, disabledSpouse: 0, total: 9000, lp: 0},
    trace: {schemeVersion: 1, T: 400, M: 0, R: .15, B: -400, taxOnP1: 4100,
      category: 1, Y1: 2000, K1: 100, Y2: 2000, K2: 100, Yt: 0, Kt: 0, K2t: 100,
      Z: 0, lpAccumulated: 0, lpCurrent: 0, zakatCurrent: 5, mtdNormalCalc: 50,
      mtdAdditionalCalc: 0, mtdNormalFloored: 50, mtdAdditionalFloored: 0, zakatLeftover: 0},
  }};
}
const format = {b2: (v: number) => v.toFixed(2), pct: (v: number) => `${v * 100}%`, int: String};

describe('r380 stored scheme presentation', () => {
  it.each(['rep', 'knowledge_worker', 'c_suite'] as const)('dispatches %s before legacy rate and hides compatibility M/B', scheme => {
    const x = explainPcb(saved(scheme), null);
    expect(x.kind).toBe('mtd');
    if (x.kind !== 'mtd') throw Error('expected recorded scheme');
    expect(x.calculationScheme).toBe(scheme);
    expect(x.taxSchemeDeclarationId).toBe('11111111-2222-4333-8444-555555555555');
    const monthly = pcbFormulaBlocks(x, format).find(b => b.key === 'mtd')!;
    expect(monthly.formula).toBe(scheme === 'c_suite' ? 'formulaSchemeMtd' : 'formulaSchemeMtdRebate');
    expect(monthly.substituted).toContain('30000.00 × 15%');
    expect(monthly.substituted).not.toContain('( 30000.00 − 0.00 )');
    expect(monthly.result).toBe(50);
    expect(pcbMtdStep1Section(x).rows.map(r => r.line)).not.toEqual(expect.arrayContaining(['M', 'B']));
    expect(pcbMtdStep1Section(x).rows.some(r => r.line === 'T')).toBe(scheme !== 'c_suite');
    const worksheet = pcbWorksheet(x, null);
    expect(worksheet.sections.flatMap(s => s.rows).filter(r => ['M','B'].includes(r.symbol))).toEqual([]);
    expect(x.pcb).toBe(45);
  });
  it('does not turn missing rebate or malformed scheme into normal or zero working', () => {
    for (const value of [undefined, null, '400', Infinity]) {
      const st = saved(); Object.assign(st.pcbMeta.trace, {T: value});
      expect(explainPcb(st, null).kind).toBe('unavailable');
    }
    const st = saved(); Object.assign(st.pcbMeta, {calculationScheme: 'future_scheme'});
    expect(explainPcb(st, null).kind).toBe('unavailable');
    Object.assign(st.pcbMeta, {calculationScheme: 'rep'}); Object.assign(st.pcbMeta.trace, {schemeVersion: 2});
    expect(explainPcb(st, null).kind).toBe('unavailable');
  });
  it('refuses incentive provenance without a valid saved declaration ID', () => {
    for (const value of [undefined, null, '', 'not-a-uuid', 123]) {
      const st = saved(); Object.assign(st.pcbMeta, {taxSchemeDeclarationId: value});
      expect(explainPcb(st, null)).toMatchObject({kind: 'unavailable', pcb: 45});
    }
  });
  it('retains legacy flat working instead of reclassifying from a current relief profile', () => {
    const x = explainPcb({pcb: 100, pcbMeta: {flatRate: .15, trace: {remuneration: 1000, additional: 0, rate: .15}}},
      {individual: 99999, spouse: 99999, children: 99999, disabledIndividual: 0, disabledSpouse: 0, total: 299997, lp: 0});
    expect(x.kind).toBe('flat');
    expect(pcbFormulaBlocks(x, format)[0]).toMatchObject({formula: 'flatFormula', result: 100, notes: ['flatRoundingNote','flatNote']});
  });
  it('requires the additional-leg rebate provenance and preserves recorded annual tax result', () => {
    const st = saved(); Object.assign(st.pcbMeta, {P2: 40000});
    Object.assign(st.pcbMeta.trace, {totalTaxYear: 6000, totalMtdYear: 200});
    expect(explainPcb(st, null).kind).toBe('unavailable');
    Object.assign(st.pcbMeta.trace, {T2: 0});
    const x = explainPcb(st, null); expect(x.kind).toBe('mtd');
    if (x.kind === 'mtd') {
      expect(x.trace?.totalTaxYear).toBe(6000);
      expect(pcbFormulaBlocks(x, format).find(b => b.key === 'schemeAnnual')).toMatchObject({formula: 'formulaSchemeAnnualRebate', result: 6000});
    }
  });
});
