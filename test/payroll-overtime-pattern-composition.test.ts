import {describe,expect,it} from 'vitest';
import {composePayrollOvertime,type PayrollOvertimePatternLine} from '../core/payroll-overtime-pattern';
import type {OvertimeLine} from '../lib/overtime-pattern-model';
const exact=(n:string)=>({unit:'minutes' as const,numerator:n,denominator:'1'});
function line(id:string,cents:string,minutes:string,dayType:'workday'|'rest_day'|'holiday'='workday'):PayrollOvertimePatternLine {
 return {sourceId:'source-'+id,calculationId:'calc-'+id,sourceRevision:1,settlementId:'claim-'+id,employmentId:'employee',date:'2026-03-02',dayType,lineId:id,earningItemId:'earning',earningItemCode:'OT',earningItemName:'Configured OT',treatment:{epf:false,socso:true,pcb:true,hrdf:false},amountMinorUnits:cents,payableMinutes:exact(minutes),evidence:{} as OvertimeLine};
}
const legacy=(workday=0,minutes:number|null=0)=>({workday,restDay:0,holiday:0,minutes});
describe('one mixed-source OT policy composition',()=>{
 it('does not multiply an already priced formula by the legacy policy multiplier',()=>{
  const result=composePayrollOvertime({config:{overtime:{multiplier:3}},legacy:legacy(10,60),lines:[line('a','2000','60')]});
  expect(result.capped).toBe(40);expect(result.allocations).toEqual([{id:'legacy',amountMinorUnits:'2000'},{id:'claim-a:a',amountMinorUnits:'2000'}]);
 });
 it('applies the combined hour cap once, followed by one amount ceiling',()=>{
  const result=composePayrollOvertime({config:{overtime:{maxHoursPerMonth:2,maxAmount:50}},legacy:legacy(40,120),lines:[line('a','8000','120')]});
  expect(result.preCap).toBe(120);expect(result.capped).toBe(50);expect(result.excess).toBe(70);
  expect(result.allocations.reduce((sum,l)=>sum+BigInt(l.amountMinorUnits),0n)).toBe(5000n);
 });
 it('refuses unknown manual/transaction hours when a monthly hours cap would otherwise guess zero',()=>{
  expect(()=>composePayrollOvertime({config:{overtime:{maxHoursPerMonth:10}},legacy:legacy(10,null),lines:[line('a','2000','60')]})).toThrowError(expect.objectContaining({code:'unknownHours'}));
 });
 it('permits independent manual cash without an hours cap and never changes the immutable formula amount',()=>{
  const lines=[line('a','3001','60')];const result=composePayrollOvertime({config:{overtime:{maxAmount:20}},legacy:legacy(10,null),lines});
  expect(result.capped).toBe(20);expect(lines[0].amountMinorUnits).toBe('3001');expect(result.allocations.reduce((sum,l)=>sum+BigInt(l.amountMinorUnits),0n)).toBe(2000n);
 });
 it('filters day types before both common caps, with no legacy workday relabeling of formula holidays',()=>{
  const result=composePayrollOvertime({config:{overtime:{eligibleDayTypes:['holiday'],maxAmount:15}},legacy:legacy(100,60),lines:[line('a','2000','60','workday'),line('b','3000','60','holiday')]});
  expect(result.preCap).toBe(30);expect(result.capped).toBe(15);expect(result.allocations.find(l=>l.id==='claim-a:a')).toBeUndefined();
  expect(result.allocations.find(l=>l.id==='claim-b:b')?.amountMinorUnits).toBe('1500');
 });
 it('assigns the cents residual deterministically while preserving the exact total',()=>{
  const p={config:{overtime:{maxAmount:0.01}},legacy:legacy(),lines:[line('a','1','1'),line('b','1','1')]};
  const result=composePayrollOvertime(p);expect(result.allocations).toEqual([{id:'legacy',amountMinorUnits:'0'},{id:'claim-a:a',amountMinorUnits:'0'},{id:'claim-b:b',amountMinorUnits:'1'}]);expect(composePayrollOvertime(p)).toEqual(result);
 });
});
