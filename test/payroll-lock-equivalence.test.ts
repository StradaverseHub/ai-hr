/**
 * Reader/writer Access lock, payroll wave: figures stay exactly as before for the same inputs.
 *
 * A populated fictional payroll (salaries, a mid-month hire, MY statutory profiles, a loan, a CP38, a fixed
 * allowance, a bonus and overtime input) is processed, reset and processed again. Every payslip figure,
 * the statutory breakdown, the run totals and the loan ledger are reduced to one canonical document. Its
 * digest was recorded on the base commit, before the lock changes (claude/access-reader-writer-20261110
 * @ 9b94dafef), so this compares the converted code with the old exclusive-lock code on the same inputs.
 */
import {createHash} from 'node:crypto';
import {asc,eq,inArray} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {setCp38} from '../core/cp38';
import {createBatch,generatePayslips,resetProcessedBatch,setPayrollInput} from '../core/payroll';
import {createLoan,prefillLoansForBatch} from '../core/loans';
import {verifyStoredTraces,withoutTraces} from './helpers/statutory-trace-evidence';
import {listPayComponents,seedPayComponentCatalog,setEmploymentPayComponent} from '../core/pay-components';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';

/** sha256 of the canonical document the base commit produced for this exact fixture (Chen's payroll-input bonus
 * and overtime are recorded but not paid, because the typed pay component path pays from items). Recorded twice:
 * on 9b94dafef plus this file only it was 13f356722b8a12c17c3f6c716f4f1760785e93172519bbeefa98318d3e2da142 (focused CI
 * run 42812523075). The combined release stands on the architecture release 6e4a883c2, whose own document for the
 * same fixture is the value below (focused CI run 42888470119 on 6e4a883c2 plus this file only, no reader/writer
 * lock and no payroll job in that tree), so this is the base the combined release must reproduce. */
const GOLDEN='5b4730ac081e0d12377359c31d0c7272bf3440a64fd03495f367398d26343aa6';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP=/^\d{4}-\d{2}-\d{2}T/;
const DROPPED=new Set(['id','createdAt','updatedAt','version','tenantId','batchId','reservedBatchId','appliedBatchId','appliedAt','loanId']);
function canonical(value:unknown,names:ReadonlyMap<string,string>):unknown{
 if(value instanceof Date)return '<timestamp>';
 if(typeof value==='string'){if(names.has(value))return names.get(value);if(UUID.test(value))return '<id>';if(TIMESTAMP.test(value))return '<timestamp>';return value;}
 if(Array.isArray(value))return value.map(entry=>canonical(entry,names));
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(key=>!DROPPED.has(key)).map(key=>[key,canonical((value as Record<string,unknown>)[key],names)]));
 return value;
}

let base:Base;
beforeAll(async()=>{await migrateTestDb();});
beforeEach(async()=>{await resetDb();base=await seedBase();for(const module of ['payroll','typed_pay_components'])await setModule(base.tenantId,module,'active');await setSetting(base.tenantId,'payroll.reset_enabled',true);});
afterAll(async()=>{await closeAll();});

describe('payroll figures under the reader/writer Access lock',()=>{
 it('processes a populated run to the same figures as the exclusive-lock base, and again after a reset',async()=>{
  const admin=adminCtx(base);
  const people:{label:string;basic:number;hiredOn:string;ic:string}[]=[
   {label:'Aisha',basic:5200,hiredOn:'2025-03-01',ic:'880101145522'},
   {label:'Bala',basic:3100,hiredOn:'2024-07-01',ic:'900215105533'},
   {label:'Chen',basic:8800,hiredOn:'2023-01-01',ic:'850630085544'},
   {label:'Devi',basic:2400,hiredOn:'2026-05-15',ic:'010405145566'},
   {label:'Eng',basic:15000,hiredOn:'2022-11-01',ic:'780912105577'},
  ];
  const hired=new Map<string,{employmentId:string;personId:string}>(),names=new Map<string,string>();
  for(const p of people){
   const e=await hireEmployee(admin,{person:{fullName:`Fictional ${p.label}`,primaryEmail:`fictional-${p.label.toLowerCase()}@equivalence.test`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:p.hiredOn});
   await setCompensation(admin,{employmentId:e.employmentId,basicSalary:p.basic,monthlyAllowance:0,effectiveFrom:p.hiredOn});
   await setStatutoryProfileMY(admin,{personId:e.personId,icNumber:p.ic});
   hired.set(p.label,e);names.set(e.employmentId,p.label);names.set(e.personId,`${p.label} person`);
  }
  const a=await entitledCtx(base);
  await seedPayComponentCatalog(admin);
  const allowance=(await listPayComponents(admin)).find(c=>c.code==='ALLOWANCE');
  if(!allowance)throw new Error('Missing native ALLOWANCE item');
  await setEmploymentPayComponent(a,{employmentId:hired.get('Chen')!.employmentId,componentId:allowance.id,amount:350,effectiveFrom:'2026-01-01'});
  await setCp38(a,{employmentId:hired.get('Eng')!.employmentId,cp38Ref:'CP38/EQ',amount:500,validFrom:'2026-01-01'});
  const loan=await createLoan(a,{employmentId:hired.get('Bala')!.employmentId,loanType:'personal',principal:2400,interestRate:0,interestMethod:'none',durationMonths:12,startDate:'2026-01-01'});
  const {batchId}=await createBatch(a,{companyId:base.companyId,payPeriod:'2026-05'});
  await prefillLoansForBatch(a,{batchId});
  await setPayrollInput(a,{batchId,employmentId:hired.get('Chen')!.employmentId,overtimeAmount:120,bonusAmount:1000});

  const snapshot=async()=>{
   const slips=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));
   const [batch]=await owner.db.select({status:schema.payrollBatch.status,employeeCount:schema.payrollBatch.employeeCount,totals:schema.payrollBatch.totals}).from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId));
   const [ledger]=await owner.db.select({outstandingBalance:schema.employeeLoan.outstandingBalance,instalmentsPaid:schema.employeeLoan.instalmentsPaid,status:schema.employeeLoan.status}).from(schema.employeeLoan).where(eq(schema.employeeLoan.id,loan.id));
   const schedule=await owner.db.select({sequenceNo:schema.loanRepayment.sequenceNo,dueAmount:schema.loanRepayment.dueAmount,appliedAmount:schema.loanRepayment.appliedAmount,status:schema.loanRepayment.status}).from(schema.loanRepayment).where(eq(schema.loanRepayment.loanId,loan.id)).orderBy(asc(schema.loanRepayment.sequenceNo));
   const inputs=await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId,batchId));
   return canonical({
    payslips:[...slips].sort((x,y)=>names.get(x.employmentId)!.localeCompare(names.get(y.employmentId)!)),
    batch,ledger,schedule,
    inputs:[...inputs].sort((x,y)=>names.get(x.employmentId)!.localeCompare(names.get(y.employmentId)!)),
   },names);
  };
  await generatePayslips(a,{batchId});
  const first=await snapshot();
  expect((first as {payslips:unknown[]}).payslips).toHaveLength(people.length);
  await resetProcessedBatch(a,{batchId,reason:'Fictional equivalence reset'});
  const unwound=await owner.db.select({outstandingBalance:schema.employeeLoan.outstandingBalance,instalmentsPaid:schema.employeeLoan.instalmentsPaid}).from(schema.employeeLoan).where(inArray(schema.employeeLoan.id,[loan.id]));
  expect(unwound).toEqual([{outstandingBalance:'2400.00',instalmentsPaid:0}]);
  await generatePayslips(a,{batchId});
  const second=await snapshot();
  expect(second).toEqual(first);
  // 69d6ed3c — the golden predates statutory trace v1; each trace is verified against its payslip, then set aside.
  expect(verifyStoredTraces(await owner.db.select({statutory:schema.payslip.statutory}).from(schema.payslip).where(eq(schema.payslip.batchId,batchId)))).toBe(people.length);
  const document=JSON.stringify(withoutTraces(first)),digest=createHash('sha256').update(document).digest('hex');
  if(digest!==GOLDEN)console.log(`PAYROLL_EQUIVALENCE_DOCUMENT ${document}`);
  expect(digest).toBe(GOLDEN);
 },240000);
});
