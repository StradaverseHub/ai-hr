/** Board 2103041d: the PAT grid's pure cell parsing and row state. No database. */
import {describe,expect,it} from 'vitest';
import {parsePatValue,patRowState,formatPatValue} from '../app/admin/rewards/pat-inputs/grid-model';

describe('PAT grid cells',()=>{
 const base={targetCents:1_000_000,forecastCents:null,actualCents:null,targetMonthsBp:20000};
 it('parses money to integer cents and months to basis points',()=>{
  expect(parsePatValue('targetCents','10,000.5')).toBe(1_000_050);
  expect(parsePatValue('actualCents','-250.25')).toBe(-25_025);
  expect(parsePatValue('targetCents','-1')).toBe('invalid');
  expect(parsePatValue('targetCents','1.234')).toBe('invalid');
  expect(parsePatValue('forecastCents','')).toBeNull();
  expect(parsePatValue('targetMonthsBp','2.5')).toBe(25_000);
  expect(parsePatValue('targetMonthsBp','')).toBe('invalid');
  expect(formatPatValue('targetMonthsBp',25_000)).toBe('2.50');expect(formatPatValue('actualCents',null)).toBe('');
 });
 it('marks changed, invalid and missing figures and derives the pool status like the service',()=>{
  const untouched=patRowState(base,undefined);
  expect(untouched).toMatchObject({changed:[],status:'not-set',achievementBp:null,missing:{target:false,actual:true}});
  const final=patRowState(base,{actualCents:'11000.00'});
  expect(final.changed).toEqual(['actualCents']);expect(final.status).toBe('final');expect(final.achievementBp).toBe(11_000);
  const loss=patRowState(base,{forecastCents:'-500.00'});expect(loss.status).toBe('provisional');expect(loss.values.forecastCents).toBe(-50_000);
  const noTarget=patRowState(base,{targetCents:'',actualCents:'5000'});expect([...noTarget.invalid]).toEqual(['targetCents']);
  const zeroTarget=patRowState(base,{targetCents:'0'});expect(zeroTarget.invalid.has('targetCents')).toBe(true);
  const sameValue=patRowState(base,{targetCents:'10000.00'});expect(sameValue.changed).toEqual([]);
 });
});
