import {describe,expect,it} from 'vitest';
import {normalizedAllocationRows,percentageHundredths,formatAllocationPercent} from '../lib/employment-cost-allocation';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
describe('Exact allocation percentages',()=>{
 it('accepts a single 100%, partial sets and the exact decimal boundary without rounding',()=>{
  expect(percentageHundredths('100')).toBe(10000);expect(percentageHundredths('0.01')).toBe(1);
  expect(normalizedAllocationRows(['33.33','33.33','33.34'].map((percentage,i)=>({costCenterId:id(i),percentage})),'replace').reduce((n,r)=>n+r.hundredths,0)).toBe(10000);
  expect(normalizedAllocationRows([{costCenterId:id(1),percentage:'50.01'}],'replace')[0].hundredths).toBe(5001);expect(formatAllocationPercent(3333)).toBe('33.33');
 });
 it.each(['0','-1','NaN','Infinity','100.01','1.001','1e2','','  ','01','0.0001',Number.NaN,Number.POSITIVE_INFINITY])('refuses invalid or overprecision value %s',input=>expect(()=>percentageHundredths(input)).toThrow());
 it('rejects duplicate IDs and group totals above 100; only explicit clear permits an empty set',()=>{
  expect(()=>normalizedAllocationRows([{costCenterId:id(1),percentage:'50'},{costCenterId:id(1),percentage:'20'}],'replace')).toThrow(/once/);
  expect(()=>normalizedAllocationRows([{costCenterId:id(1),percentage:'50.01'},{costCenterId:id(2),percentage:'50'}],'replace')).toThrow(/100/);
  expect(()=>normalizedAllocationRows([],'replace')).toThrow(/clear/);expect(normalizedAllocationRows([],'clear')).toEqual([]);
 });
});
