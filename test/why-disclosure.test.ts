/** AI v2 W5 — the pay difference and claim limit explanations under harness disclosure. No figure reaches the model.
 *
 * The explanations are the real pure owners' output on fictional payslips and a fictional claim balance, wrapped as
 * their harness owners wrap them. What the model receives is the disclosure output: every field declared (nothing
 * removed as undeclared), no number left anywhere in it (every figure is a placeholder plus its band), the exact
 * figures kept only in the turn's ledger for restoring to the person, health-indicative names withheld, and company
 * ids never present. No database. */
import {describe,expect,it} from 'vitest';
import {DisclosureLedger,discloseToolOutput} from '../core/harness/disclosure';
import {comparePayPeriods,type StoredPayslipRow} from '../core/pay-difference';
import {claimLimitExplanation} from '../core/claim-limit-explain';
import {PAY_DIFFERENCE_PROVENANCE} from '../core/explainers/pay-difference';
import {CLAIM_LIMIT_PROVENANCE} from '../core/explainers/claim-limit';
import {WHY_ENTITIES} from '../core/semantic-model/entities-why';
import {terasEntity} from '../core/semantic-model/generate';
import type {SemanticField} from '../core/semantic-model/types';

const numbers=(value:unknown,path='',out:string[]=[]):string[]=>{
 if(typeof value==='number')out.push(path);
 else if(Array.isArray(value))value.forEach((item,index)=>numbers(item,`${path}[${index}]`,out));
 else if(value&&typeof value==='object')for(const [key,child] of Object.entries(value))numbers(child,path?`${path}.${key}`:key,out);
 return out;
};
const stat=(over:Record<string,unknown>={})=>({version:'my-2026.1',epfEmployee:550,epfEmployer:650,socsoEmployee:24.75,socsoEmployer:86.65,socsoSkbbk:0,eisEmployee:9.9,eisEmployer:9.9,pcb:120,hrdf:0,
 bases:{epf:5000,epfAdditional:0,socsoEis:5000,pcb:5000,hrdf:5000},salaryBasis:{version:1,basicSalary:5000,effectiveFrom:'2024-01-01'},
 componentLines:[{code:'A0040',name:'Meal Allowance',amount:200,buckets:[{bucket:'reimburse',amount:200}]}],...over});
const COMPANY='44444444-4444-4444-8444-444444444444';
const row=(over:Partial<StoredPayslipRow>):StoredPayslipRow=>({companyId:COMPANY,company:'Fictional Ceria Sdn Bhd',payPeriod:'2026-09',runType:'regular',runSeq:1,basic:'5000.00',allowance:'200.00',overtime:'0.00',
 bonus:'0.00',gross:'5200.00',statutory:stat(),otherDeductions:'0.00',totalDeductions:'704.65',net:'4495.35',daysWorked:'30.00',...over});

describe('pay difference disclosure',()=>{
 const result=comparePayPeriods([row({}),row({payPeriod:'2026-10',basic:'5500.00',gross:'5730.77',allowance:'230.77',otherDeductions:'230.77',totalDeductions:'990.42',net:'4740.35',
  statutory:stat({epfEmployee:605,unpaidLeave:{days:1,amount:230.77},salaryBasis:{version:1,basicSalary:5500,effectiveFrom:'2026-10-01'},
   componentLines:[{code:'A0040',name:'Meal Allowance',amount:230.77,buckets:[{bucket:'reimburse',amount:230.77}]}]})})]);
 if(!result.ok)throw Error(result.reason);
 // As core/explainers/pay-difference.ts explainOwnPayDifference returns it: company ids dropped, provenance added.
 const outcome={ok:true,period:result.period,previousPeriod:result.previousPeriod,availablePeriods:result.availablePeriods,
  comparisons:result.comparisons.map(({companyId:_companyId,...rest})=>rest),onlyIn:result.onlyIn,provenance:PAY_DIFFERENCE_PROVENANCE};
 it('declares every field the explainer returns and leaves no figure in what the model receives',()=>{
  const ledger=new DisclosureLedger('me');
  const {value,applied}=discloseToolOutput('explain_pay_difference','pay_difference_explanation',outcome,ledger);
  expect(applied.undeclared).toEqual([]);expect(applied.removed).toEqual([]);
  // Not one number survives: every amount, day count, wage base and payslip count left as a placeholder and band.
  expect(numbers(value)).toEqual([]);
  expect(numbers(outcome).length).toBeGreaterThan(20);
  expect(applied.banded).toEqual(expect.arrayContaining(['comparisons[0].lines[0].change','comparisons[0].totals.net.change','comparisons[0].causes[0].current','comparisons[0].statutory[0].baseCurrent']));
  const text=JSON.stringify(value);
  expect(text).toMatch(/"change":"\{\{F\d+\}\} \(/);
  // The ledger holds the service's exact figures for restoring to the person: net 4,740.35 − 4,495.35 and the unpaid day.
  const figures=[...ledger.figures.values()].map(row=>row.value);
  expect(figures).toEqual(expect.arrayContaining([245,500,230.77,55,5500,5000,1]));
  // Vocabulary the model needs to word the answer stays; company ids never appear.
  expect(text).toContain('"kind":"unpaid_leave"');expect(text).toContain('"kind":"salary_change"');expect(text).toContain('"key":"basic"');
  expect(text).toContain('Meal Allowance');expect(text).toContain('core/pay-difference.ts#comparePayPeriods');expect(text).not.toContain(COMPANY);
 });
});

describe('claim limit disclosure',()=>{
 const balance={claimTypeId:'ct',typeCode:'MED',typeName:'Medical',items:[{claimItemId:'i',itemName:'Dental',annualLimit:1000,usedThisYear:300,remainingThisYear:700,monthlyLimit:null,usedThisMonth:0,remainingThisMonth:null,perClaimCap:null}],
  annualLimit:2000,usedThisYear:620,reservedThisYear:120,remainingThisYear:1380,monthlyLimit:300,usedThisMonth:120,remainingThisMonth:180,perClaimCap:500,lifetimeLimit:null,usedLifetime:0,
  claimsUsedThisYear:3,maxClaimsPerYear:12,blockLimit:null,usedThisBlock:0,remainingThisBlock:null,blockEndsOn:null,policyValidFrom:'2026-01-01',policyGradeScoped:true};
 const outcome={ok:true,claimType:'Medical',asOf:'2026-11-03',employments:[{company:'Fictional Ceria Sdn Bhd',...claimLimitExplanation(balance)}],provenance:CLAIM_LIMIT_PROVENANCE};
 it('bands every amount and count, withholds a health-indicative claim name, and keeps the policy version',()=>{
  const ledger=new DisclosureLedger('me');
  const {value,applied}=discloseToolOutput('explain_claim_limit','claim_limit_explanation',outcome,ledger);
  expect(applied.undeclared).toEqual([]);expect(applied.removed).toEqual([]);
  expect(numbers(value)).toEqual([]);
  expect([...ledger.figures.values()].map(row=>row.value)).toEqual([2000,620,120,1380,300,120,180,500,12,3,1000,300,700]);
  const text=JSON.stringify(value);
  // "Medical" and "Dental" name a health matter: they leave as text placeholders, restored for the person.
  expect(text).not.toMatch(/Medical|Dental/);expect(applied.withheld).toEqual(expect.arrayContaining(['claimType','employments[0].claimType','employments[0].items[0].name']));
  expect(text).toContain('"validFrom":"2026-01-01"');expect(text).toContain('"gradeScoped":true');
 });
});

describe('the declarations',()=>{
 const walk=(fields:readonly SemanticField[]):SemanticField[]=>fields.flatMap(field=>[field,...(field.of?walk(field.of):[])]);
 it('class every number of both pay-sensitive entities as a band and are the ones the harness discloses by',()=>{
  for(const entity of WHY_ENTITIES){
   expect(entity.sensitivity,entity.id).toBe('pay');expect(entity.audience,entity.id).toBe('self');
   expect(terasEntity(entity.id)).toBe(entity);
   for(const field of walk(entity.fields)){
    if(['number','integer'].includes(field.type))expect(field.disclosure,entity.id+'.'+field.name).toBe('bands');
    if(['id','code','text'].includes(field.type))expect(field.disclosure,entity.id+'.'+field.name).toBe('never');
    expect(field.meaning.trim(),entity.id+'.'+field.name).not.toBe('');
   }
  }
 });
});
