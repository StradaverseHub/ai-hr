import {describe,it,expect} from 'vitest';
import {importedTaxInput,SYSTEM_BASIC_TAX_SETTING,type ImportedTaxSetting} from '../lib/payroll-import-tax-input';
import {projectImportedTaxBasis} from '../core/payroll-import-tax-source';
import {resolveTaxOpeningEvidence} from '../lib/payroll-tax-opening-evidence';
import {DEFAULT_MY_STATUTORY} from '../localization/my/statutory-tables';
import {replayMyTaxBasis} from '../localization/my/tax-basis-replay';
import {createNonCashOwnershipReplay,readPcbNonCash} from '../localization/noncash-benefits';
import type {ImportCodeEntry} from '../lib/payroll-history-import-schema';
const settings:ImportedTaxSetting[]=[SYSTEM_BASIC_TAX_SETTING,{...SYSTEM_BASIC_TAX_SETTING,id:'travel',code:'TRAVEL',name:'Travel'},{...SYSTEM_BASIC_TAX_SETTING,id:'bonus',code:'BONUS',name:'Bonus',pcbRemunerationType:'additional'},{...SYSTEM_BASIC_TAX_SETTING,id:'deduct',code:'DEDUCT',name:'Deduction',kind:'deduction'},{...SYSTEM_BASIC_TAX_SETTING,id:'excluded',code:'EXCLUDED',name:'Excluded',includedInPcb:false}];
const codes=new Map<string,ImportCodeEntry>([['BASIC',{code:'BASIC',destination:'basic',direction:'earning',label:'Basic',source:'statutory',basicSalaryOwner:true}],...settings.slice(1).map(setting=>[setting.code,{code:setting.code,label:setting.name,destination:setting.kind==='deduction'?'other_deduction':'allowance',direction:setting.kind==='deduction'?'deduction':'earning',source:'component',targetCode:setting.code}] as [string,ImportCodeEntry]),['ALIAS',{code:'ALIAS',label:'Imported alias',destination:'allowance',direction:'earning',source:'alias',targetCode:'TRAVEL'}]]);
const rows=[{rowNum:2,code:'BASIC',amount:5000},{rowNum:3,code:'ALIAS',amount:500},{rowNum:4,code:'BONUS',amount:200},{rowNum:5,code:'EXCLUDED',amount:300},{rowNum:6,code:'DEDUCT',amount:100}];
const project=(change:Partial<Parameters<typeof projectImportedTaxBasis>[0]>={})=>projectImportedTaxBasis({ownerKey:'fixture-owner:ME',replay:replayMyTaxBasis,period:'2026-01',rows,codes,settings,rules:DEFAULT_MY_STATUTORY,rulesHash:'verified-2026',gross:6000,deductions:100,statutory:{pcb:40,epfEmployee:550,lp:0},...change});
describe('canonical imported tax source ownership',()=>{
 it('resolves exact aliases, normal/additional, deductions and non-PCB items without changing original tax paid',()=>{
  const original={pcb:40,epfEmployee:550,lp:0},result=project({statutory:original});
  expect(result.state).toBe('ready');expect(result.basis).toMatchObject({pcb:5600,normal:5400,additional:200,exempt:300});
  expect(result.lines[1]).toEqual({rowNum:3,originalCode:'ALIAS',code:'TRAVEL',settingId:'travel',amount:500,direction:'earning'});
  expect(result.settings.find(setting=>setting.id==='travel')).toEqual(settings[1]);expect(original).toEqual({pcb:40,epfEmployee:550,lp:0});
 });
 it('does not guess a basic owner or UUID for an unmapped or ambiguous custom code',()=>{
  expect(()=>importedTaxInput([{rowNum:9,code:'UNKNOWN',amount:1}],codes,settings)).toThrow(/Row 9.*UNKNOWN/);
  expect(()=>importedTaxInput(rows,codes,[...settings,{...settings[1],id:'duplicate'}])).toThrow(/ambiguous/);
  expect(()=>importedTaxInput(rows,codes,settings.map(setting=>setting.id==='travel'?{...setting,archivedAt:'2026-01-01'}:setting))).toThrow(/archived/);
 });
 it('holds annual caps and optional deductions without fabricating an opening or losing item detail',()=>{
  const result=project({settings:settings.map(setting=>setting.id==='travel'?{...setting,pcbExemptionCode:'PCB_TRA_BUSINESS'}:setting)});
  expect(result.state).toBe('held');expect(result.missing.join(' ')).toMatch(/prior-employer/);expect(result.basis).toBeUndefined();expect(result.lines).toHaveLength(5);
 });
 it('supports explicitly owned BIK outside cash gross and refuses an unclassified noncash item',()=>{
  const benefit={...SYSTEM_BASIC_TAX_SETTING,id:'bik',code:'BIK',name:'Benefit',isNonPayable:true,displayCategory:'bik',eaFormLine:'EA_B3'};
  const benefitCodes=new Map(codes).set('BIK',{code:'BIK',label:'Benefit',destination:'noncash',direction:'earning',source:'component',targetCode:'BIK'});
  const result=project({rows:[...rows,{rowNum:7,code:'BIK',amount:400}],codes:benefitCodes,settings:[...settings,benefit]});
  expect(result.state).toBe('ready');expect(result.basis?.pcb).toBe(5600);expect(readPcbNonCash(result.basis?.pcbNonCash)).toMatchObject({owned:{bik:400,vola:0},cashNormal:5400});
  expect(()=>project({rows:[...rows,{rowNum:7,code:'BIK',amount:400}],codes:benefitCodes,settings:[...settings,{...benefit,displayCategory:null,eaFormLine:null}]})).toThrow(/BIK\/VOLA/);
 });
});
describe('historical opening evidence boundary',()=>{
 const identity={year:2026,employmentId:'employee',companyId:'original-employer',required:true};
 const old={id:'old',sourceHash:'old-hash',statutory:{}};
 const native=(used:Record<string,number>,change:Record<string,unknown>={})=>({id:'native',sourceHash:'native-hash',statutory:{taxBasisOpeningExemptionYear:2026,taxBasisOpeningExemptionUsed:used,taxBasisOpeningSource:{version:1,year:2026,employmentId:'employee',companyId:'original-employer',prefix:[{payslipId:'old',sourceHash:'old-hash'}]},...change}});
 it('requires no opening for an uncapped prefix without asserting a saved zero',()=>{expect(resolveTaxOpeningEvidence({...identity,required:false,sources:[old]})).toEqual({state:'known',used:{},sourceIds:[]});});
 it('accepts an explicitly saved zero only with exact year/employer/employment/source lineage',()=>{
  expect(resolveTaxOpeningEvidence({...identity,sources:[old,native({})]})).toEqual({state:'known',used:{},sourceIds:['native']});
  for(const change of [{taxBasisOpeningExemptionYear:2025},{taxBasisOpeningSource:undefined},{taxBasisOpeningSource:{version:1,year:2026,employmentId:'other',companyId:'original-employer',prefix:[{payslipId:'old',sourceHash:'old-hash'}]}}])expect(resolveTaxOpeningEvidence({...identity,sources:[old,native({},change)]}).state).toBe('missing');
  expect(resolveTaxOpeningEvidence({...identity,sources:[{...old,sourceHash:'changed'},native({})]}).state).toBe('missing');
 });
 it('rejects conflicting recorded evidence and never substitutes current profile data',()=>{
  const result=resolveTaxOpeningEvidence({...identity,sources:[native({PCB_TRA_BUSINESS:0}),{...native({PCB_TRA_BUSINESS:5000}),id:'other-native'}]});expect(result.state).toBe('conflict');
  expect(resolveTaxOpeningEvidence({...identity,sources:[old]}).state).toBe('missing');
 });
});

describe('imported cash classification does not establish occurrence ownership',()=>{
 for(const stream of ['normal','additional'] as const)it(`retains ${stream} capped usage without inventing a one-off receipt`,()=>{
  const setting={...SYSTEM_BASIC_TAX_SETTING,id:'capped',code:'CAPPED',name:'Capped cash',pcbRemunerationType:stream,pcbExemptionCode:'PCB_TRA_BUSINESS'};
  const [result]=replayMyTaxBasis({year:2026,upToMonth:1,openingExemptionUsed:{},settings:[setting],rulesByPeriod:{'2026-01':{rules:DEFAULT_MY_STATUTORY,hash:'verified'}},slips:[{id:'source',period:'2026-01',runOrder:1,sourceKind:'import',sourceLines:[{code:'CAPPED',settingId:'capped',amount:500,direction:'earning'}],statutory:{},expectedGross:500,expectedOtherDeductions:0}]});
  expect(result.basis.exemptionUsed).toEqual({PCB_TRA_BUSINESS:500});expect(result.basis).not.toHaveProperty('oneOffExemptionUsed');
 });
});

describe('canonical noncash cycle ownership reconstruction',()=>{
 const owned=(sourceId:string,amount:number)=>({kind:'bik' as const,code:'BIK',source:'one_off' as const,sourceId,entered:amount,exempt:0,taxable:amount});
 const ea=(sourceId:string,amount:number)=>({kind:'bik' as const,code:'BIK',source:'one_off' as const,sourceId,entered:amount,reportableAmount:amount,exemptAmount:0,eaFormLine:'EA_B3',subjectPCB:true});
 it('separates current run, prior same-month ownership and prior-month annual accumulation',()=>{
  const replay=createNonCashOwnershipReplay();
  const january=replay({period:'2026-01',cashNormal:5000,owned:[owned('jan',100)],ownedEa:[ea('jan',100)],original:null,completeSource:true});
  const first=replay({period:'2026-02',cashNormal:5000,owned:[owned('feb-normal',300)],ownedEa:[ea('feb-normal',300)],original:null,completeSource:true});
  const second=replay({period:'2026-02',cashNormal:5000,owned:[owned('feb-additional',200)],ownedEa:[ea('feb-additional',200)],original:null,completeSource:true});
  expect(january.accumulated).toEqual({bik:0,vola:0,complete:true});expect(first.accumulated).toEqual({bik:100,vola:0,complete:true});expect(second.accumulated).toEqual(first.accumulated);
  expect(second).toMatchObject({before:{bik:300,vola:0},owned:{bik:200,vola:0},cumulative:{bik:500,vola:0},current:{bik:{entered:500,taxable:500}},ownedCurrent:{bik:{entered:200,taxable:200}}});expect(readPcbNonCash(second)).toEqual(second);
  expect(()=>replay({period:'2026-02',cashNormal:0,owned:[owned('feb-additional',200)],ownedEa:[ea('feb-additional',200)],original:null,completeSource:true})).toThrow(/configuration requires review/);
 });
 it('refuses an orphaned cumulative snapshot rather than inventing a prior owner',()=>{
  const original=createNonCashOwnershipReplay()({period:'2026-01',cashNormal:0,owned:[owned('missing-owner',100)],ownedEa:[ea('missing-owner',100)],original:null,completeSource:true});
  expect(()=>createNonCashOwnershipReplay()({period:'2026-01',cashNormal:0,owned:[],ownedEa:[],original,completeSource:true})).toThrow(/configuration requires review/);
 });
});
