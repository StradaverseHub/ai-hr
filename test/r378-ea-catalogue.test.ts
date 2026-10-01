import {describe,it,expect} from 'vitest';
import {packFor} from '../localization/registry';
import {EA_FORM_LINES} from '../core/pay-components';
describe('pack-owned EA reporting catalogue compatibility',()=>{
 it('has exactly twelve ordered destinations and normalizes existing aliases without rewriting stored identities',()=>{
  const rows=packFor('MY')!.eaReporting!;
  expect(rows).toHaveLength(12);expect(new Set(rows.map(r=>r.code)).size).toBe(12);
  expect(rows.map(r=>r.order)).toEqual(Array.from({length:12},(_,i)=>i));
  for(const row of rows){expect(EA_FORM_LINES).toContain(row.code);for(const alias of row.aliases??[])expect(EA_FORM_LINES).toContain(alias)}
  const canonical=(code:string)=>rows.find(r=>r.code===code||r.aliases?.includes(code))?.code??code;
  expect(canonical('bonus')).toBe('EA_B1B');expect(canonical('director_fee')).toBe('EA_B1B');
  expect(canonical('allowance_taxable')).toBe('EA_B1C');expect(canonical('arrears')).toBe('arrears');expect(canonical('allowance_exempt')).toBe('allowance_exempt');
  expect(rows.filter(r=>r.section==='C').map(r=>r.destination)).toEqual(['pension','annuity']);
 });
});
