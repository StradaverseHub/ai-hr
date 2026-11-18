import {describe,it,expect} from 'vitest';
import {aggregateHistoryItems,appendHistoryContribution,removeHistoryAttempt,removeHistoryItems,effectiveHistoryItems,retainedNativeHistoryBaseline,historyMoneyCents,type HistoryOwnedItem,type HistoryContributionState} from '../lib/payroll-history-maintenance-lineage';
import {maintenanceSourceItems} from '../core/payroll-history-maintenance-state';
import {maintenanceTaxInput} from '../lib/payroll-history-maintenance-tax-input';
import {SYSTEM_BASIC_TAX_SETTING} from '../lib/payroll-import-tax-input';
import type {ImportCodeEntry} from '../lib/payroll-history-import-schema';
const item=(code:string,amount:string):HistoryOwnedItem=>({key:code==='BASIC'?'destination:basic':'component:'+code,code,label:code,amount,destination:code==='BASIC'?'basic':'allowance',direction:'earning',sourceRows:[2],originalCodes:[code]});
const empty:HistoryContributionState={version:1,baselineSnapshotId:null,chains:{}};
const amounts=(state:HistoryContributionState)=>Object.fromEntries(effectiveHistoryItems(state).map(item=>[item.code,item.amount]));
describe('canonical total-setting maintenance lineage',()=>{
 it('aggregates repeated canonical aliases as exact totals, without floating-point addition',()=>{
  const entry:ImportCodeEntry={code:'TRV',targetCode:'TRV',ownerId:'TRV',label:'Travel',destination:'allowance',direction:'earning',source:'component'};
  const lines=maintenanceSourceItems([{rowNum:2,code:'TRV',amount:'0.10'},{rowNum:3,code:'ALIAS',amount:'0.20'}],new Map([['TRV',entry],['ALIAS',{...entry,code:'ALIAS',source:'alias'}]]));
  expect(lines).toEqual([{key:'component:TRV',code:'TRV',label:'Travel',amount:'0.30',destination:'allowance',direction:'earning',sourceRows:[2,3],originalCodes:['ALIAS','TRV']}]);
 });
 it('sets listed totals while preserving unlisted cash and original statutory items',()=>{
  const original=appendHistoryContribution(empty,'A',[item('BASIC','1000.00'),item('TRV','500.00')],'replace');
  const after=appendHistoryContribution(original,'B',[item('TRV','200.00')],'update_listed');expect(amounts(after)).toEqual({BASIC:'1000.00',TRV:'200.00'});expect(amounts(original)).toEqual({BASIC:'1000.00',TRV:'500.00'});
  expect(amounts(appendHistoryContribution(after,'B',[item('TRV','200.00')],'update_listed'))).toEqual(amounts(after));
 });
 it('full replacement omits old items with a tombstone and restores them only through their retained owner',()=>{
  const a=appendHistoryContribution(empty,'A',[item('BASIC','1000.00'),item('TRV','500.00')],'replace'),b=appendHistoryContribution(a,'B',[item('BASIC','1200.00')],'replace');
  expect(amounts(b)).toEqual({BASIC:'1200.00'});expect(b.chains['component:TRV'][0]).toEqual({attemptId:'B',item:null});expect(amounts(removeHistoryAttempt(b,'B'))).toEqual(amounts(a));
 });
 it('removes an earlier batch at every depth without resurrecting it after a later batch is removed',()=>{
  const a=appendHistoryContribution(empty,'A',[item('BASIC','1000.00'),item('TRV','500.00')],'replace'),b=appendHistoryContribution(a,'B',[item('TRV','200.00')],'update_listed'),c=appendHistoryContribution(b,'C',[item('TRV','300.00')],'update_listed');
  const removed=removeHistoryAttempt(c,'B');expect(removed.chains['component:TRV'].map(row=>row.attemptId)).toEqual(['C','A']);expect(amounts(removeHistoryAttempt(removed,'C'))).toEqual({BASIC:'1000.00',TRV:'500.00'});expect(amounts(c)).toEqual({BASIC:'1000.00',TRV:'300.00'});
 });
 it('preserves later explicit zero and removal tombstones when an earlier batch is removed',()=>{
  const a=appendHistoryContribution(empty,'A',[item('BASIC','1000.00'),item('TRV','500.00')],'replace'),zero=appendHistoryContribution(a,'B',[item('TRV','0.00')],'update_listed');
  expect(amounts(removeHistoryAttempt(zero,'A'))).toEqual({TRV:'0.00'});const removed=removeHistoryItems(zero,'C',['component:TRV']);expect(amounts(removeHistoryAttempt(removed,'A'))).toEqual({});expect(removeHistoryAttempt(removed,'A').chains['component:TRV'][0]).toEqual({attemptId:'C',item:null});
 });
 it('restores only the immutable native baseline, never a removed imported owner',()=>{
  const native:HistoryContributionState={version:1,baselineSnapshotId:'native-copy',chains:{'destination:basic':[{attemptId:null,item:item('BASIC','900.00')}]}};
  const imported=appendHistoryContribution(native,'A',[item('BASIC','1000.00')],'replace');expect(retainedNativeHistoryBaseline(imported)).toEqual(native);expect(amounts(native)).toEqual({BASIC:'900.00'});
 });
 it('refuses ambiguous canonical identities, negative/inexact values and aggregate overflow',()=>{
  expect(()=>aggregateHistoryItems([item('TRV','1.00'),{...item('TRV','1.00'),direction:'deduction'}])).toThrow(/ambiguous/);
  for(const value of ['-1.00','1.001','NaN','10000000000.00'])expect(()=>historyMoneyCents(value)).toThrow();expect(()=>aggregateHistoryItems([item('TRV','9999999999.99'),item('TRV','0.01')])).toThrow(/range/);
 });
});
describe('merged history uses the canonical tax input adapter',()=>{
 const setting={...SYSTEM_BASIC_TAX_SETTING,id:'TRV',code:'TRV',name:'Travel'},items=[item('BASIC','1000.00'),item('TRV','500.00')];
 it('retains unlisted original cash ownership and reads latest PCB flags without changing original amounts',()=>{
  const result=maintenanceTaxInput(items,[{...setting,includedInPcb:false}],[]);expect(result.map(line=>[line.code,line.amount,line.direction,line.settingId])).toEqual([['BASIC',1000,'earning','system-basic-salary'],['TRV',500,'earning','TRV']]);expect(items[1].amount).toBe('500.00');
 });
 it('supports an explicitly recorded custom basic-field owner only when its exact current component is available',()=>{
  const basic={...item('BASIC','1000.00'),code:'SALARY',originalCodes:['SALARY']},salary={...SYSTEM_BASIC_TAX_SETTING,id:'salary-owner',code:'SALARY',name:'Salary'};
  expect(maintenanceTaxInput([basic],[salary],[])[0]).toMatchObject({code:'SALARY',settingId:'salary-owner',amount:1000,direction:'earning'});expect(()=>maintenanceTaxInput([basic],[],[])).toThrow(/basic salary/);
 });
 it('does not use a remapped UUID or changed monetary kind',()=>{
  expect(()=>maintenanceTaxInput(items,[{...setting,id:'OTHER'}],[])).toThrow(/identity/);expect(()=>maintenanceTaxInput(items,[{...setting,kind:'deduction'}],[])).toThrow(/direction/);expect(()=>maintenanceTaxInput([...items,items[1]],[setting],[])).toThrow(/duplicated/);
 });
 it('keeps noncash source ownership only with an exact retained receipt',()=>{
  const benefit={...setting,id:'BIK',code:'BIK',name:'Benefit',isNonPayable:true,displayCategory:'bik',eaFormLine:'EA_B3'},noncash:HistoryOwnedItem={...item('BIK','300.00'),destination:'noncash',direction:'noncash'},receipt={code:'BIK',settingId:'BIK',amount:300,nonCashSource:{source:'one_off',sourceId:'import:'+'a'.repeat(64)}};
  expect(maintenanceTaxInput([noncash],[benefit],[receipt])[0].nonCashSource).toEqual(receipt.nonCashSource);expect(()=>maintenanceTaxInput([noncash],[benefit],[])).toThrow(/ownership/);expect(()=>maintenanceTaxInput([noncash],[benefit],[{...receipt,amount:301}])).toThrow(/ownership/);
 });
});
