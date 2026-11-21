/**
 * Payroll Reconciliation and the Payroll Comparison report compare every company in scope that is ready, and list the
 * others with their reasons, instead of refusing the whole comparison when one company is not ready (owner decision,
 * 12 November 2026). Real payroll runs through the Payroll owners; fictional companies and employees.
 *
 *   A  previous closed, current closed            -> included
 *   B  previous closed, current processed         -> included (provisional)
 *   C  previous processed (not closed)            -> "<previous month> not closed yet"
 *   D  previous closed, no current run            -> "No payroll run in <current month>"
 *   E  previous closed, current uncalculated      -> "<current month> still a draft"
 *   G  previous closed, current marked to redo    -> "<current month> needs reprocess"
 *   F  never ran payroll                          -> left out, counted only
 */
import {randomUUID} from 'node:crypto';
import {and,eq,inArray,sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import * as XLSX from 'xlsx';
import {type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {recordPayrollComparisonRun,runPayrollComparisonReport} from '../core/custom-reports';
import {closeBatch,createBatch,generatePayslips} from '../packs/payroll/service';
import {requirePackFor} from '../localization/registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import {previousPayrollComparisonPeriod} from '../lib/payroll-period-comparison';
import {serializePayrollComparison} from '../lib/payroll-comparison-export';
import {payrollComparisonEmptyMessage} from '../app/reports/payroll-comparison/inclusion';
import {closeAll,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,ctx:SessionContext,previousPeriod:string,currentPeriod:string;
const company:Record<string,string>={},employment:Record<string,string>={},batch:Record<string,string>={};
const NAMES={A:'Fictional Alpha Sdn Bhd',B:'Fictional Beta Sdn Bhd',C:'Fictional Gamma Sdn Bhd',D:'Fictional Delta Sdn Bhd',E:'Fictional Epsilon Sdn Bhd',F:'Fictional Zeta Sdn Bhd',G:'Fictional Eta Sdn Bhd'} as const;
type Key=keyof typeof NAMES;

async function companyWithEmployee(key:Key,basic:number){
 if(key==='A'){company.A=b.companyId;await owner.db.update(s.company).set({legalName:NAMES.A}).where(eq(s.company.id,b.companyId));}
 else{const [row]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:NAMES[key]}).returning({id:s.company.id});company[key]=row.id;}
 const [dept]=key==='A'?[{id:b.deptA}]:await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:company[key],name:'Finance'}).returning({id:s.department.id});
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional '+key+' employee',primaryEmail:randomUUID()+'@fixture.test'},companyId:company[key],
  departmentId:dept.id,employmentType:'full_time',employeeCode:'READY-'+key,hiredOn:previousPeriod+'-01'});
 employment[key]=hired.employmentId;
 await setCompensation(ctx,{employmentId:hired.employmentId,basicSalary:basic,effectiveFrom:previousPeriod+'-01'});
 await requirePackFor('MY').statutory.set(ctx,{personId:hired.personId,icNumber:'9001010112'+String(basic).slice(0,2)});
}
async function run(key:Key,period:string,state:'draft'|'processed'|'closed'){
 const created=await createBatch(ctx,{companyId:company[key],payPeriod:period});batch[key+period]=created.batchId;
 if(state!=='draft')await generatePayslips(ctx,{batchId:created.batchId});
 if(state==='closed')await closeBatch(ctx,{batchId:created.batchId});
}
const reconciliation=(scope:string[],filters:Record<string,unknown>={},verb:'view'|'export'='view')=>
 runPayrollComparisonReport(ctx,scope,{id:'reconciliation',verb,filters:{currentPeriod,previousPeriod,payItemCode:'@total/netPay',onlyVariances:'0',...filters}});
const t=(key:string,values?:Record<string,string|number|Date>)=>key+(values?JSON.stringify(values):'');

beforeAll(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'typed_pay_components','disabled');
 ctx={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 currentPeriod=previousPayrollComparisonPeriod(todayInKualaLumpur().slice(0,7));previousPeriod=previousPayrollComparisonPeriod(currentPeriod);
 const basic:Record<Key,number>={A:3000,B:3100,C:3200,D:3300,E:3400,F:3500,G:3600};
 for(const key of Object.keys(NAMES) as Key[])await companyWithEmployee(key,basic[key]);
 await run('A',previousPeriod,'closed');await run('A',currentPeriod,'closed');
 await run('B',previousPeriod,'closed');await run('B',currentPeriod,'processed');
 await run('C',previousPeriod,'processed');await run('C',currentPeriod,'processed');
 await run('D',previousPeriod,'closed');
 await run('E',previousPeriod,'closed');await run('E',currentPeriod,'draft');
 await run('G',previousPeriod,'closed');await run('G',currentPeriod,'processed');
 // A rate or input changed after G's current run was calculated: Payroll marks it for reprocessing.
 await owner.db.update(s.payrollBatch).set({needsRecalcAt:new Date()}).where(eq(s.payrollBatch.id,batch['G'+currentPeriod]));
},120_000);
afterAll(closeAll);

const all=()=>(Object.keys(NAMES) as Key[]).map(key=>company[key]);
async function netPay(keys:Key[],period:string){
 const rows=await owner.db.select({net:s.payslip.netPay}).from(s.payslip).innerJoin(s.payrollBatch,eq(s.payrollBatch.id,s.payslip.batchId))
  .where(and(inArray(s.payrollBatch.companyId,keys.map(key=>company[key])),eq(s.payrollBatch.payPeriod,period)));
 return rows.reduce((sum,row)=>sum+Math.round(Number(row.net)*100),0);
}

describe('ready-company payroll comparison',()=>{
 it('compares the ready companies and lists every other company with payroll and its reasons',async()=>{
  const opened=await reconciliation(all());
  expect(opened.inclusion).toEqual({
   includedCompanyIds:[company.A,company.B],
   excluded:[
    {companyId:company.C,company:NAMES.C,reasons:[{code:'previousNotClosed',period:previousPeriod}]},
    {companyId:company.D,company:NAMES.D,reasons:[{code:'missingPayroll',period:currentPeriod}]},
    {companyId:company.E,company:NAMES.E,reasons:[{code:'draftPayroll',period:currentPeriod}]},
    {companyId:company.G,company:NAMES.G,reasons:[{code:'stalePayroll',period:currentPeriod}]},
   ],
   withPayrollCount:6,neverRanCount:1,
  });
  expect(opened.result.available).toBe(true);
  expect(opened.result.provisional).toBe(true);                       // B's current run is processed, not closed
  expect(opened.result.issues).toEqual([]);
  expect(new Set(opened.result.rows.map(row=>row.employmentId))).toEqual(new Set([employment.A,employment.B]));
  expect(new Set(opened.result.runs.map(row=>row.companyId))).toEqual(new Set([company.A,company.B]));
  expect(payrollComparisonEmptyMessage(opened.inclusion,t)).toBeNull();
 });

 it('totals cover the included companies only',async()=>{
  const opened=await reconciliation(all());
  const [total]=opened.result.summary!.totals;
  expect(opened.result.summary!.totals).toHaveLength(1);
  expect(Math.round(Number(total.current)*100)).toBe(await netPay(['A','B'],currentPeriod));
  expect(Math.round(Number(total.previous)*100)).toBe(await netPay(['A','B'],previousPeriod));
  expect(Math.round(Number(total.previous)*100)).toBeLessThan(await netPay(['A','B','C','D','E','G'],previousPeriod));
  expect(opened.result.summary!.previousHeadcount).toBe(2);
 });

 it('leaves out a company that never ran payroll instead of reporting it missing',async()=>{
  const opened=await reconciliation([company.A,company.F]);
  expect(opened.inclusion).toEqual({includedCompanyIds:[company.A],excluded:[],withPayrollCount:1,neverRanCount:1});
  expect(opened.result.rows.map(row=>row.employmentId)).toEqual([employment.A]);
  const alone=await reconciliation([company.F]);
  expect(alone.inclusion).toEqual({includedCompanyIds:[],excluded:[],withPayrollCount:0,neverRanCount:1});
  expect(alone.result).toMatchObject({available:false,rows:[],issues:[],summary:null});
  expect(payrollComparisonEmptyMessage(alone.inclusion,t)).toBe('inclusion.emptyNoPayroll');
 });

 it('shows the reasons and an empty state, never a partial company, when no company is ready',async()=>{
  const opened=await reconciliation([company.C,company.D,company.E]);
  expect(opened.inclusion?.includedCompanyIds).toEqual([]);
  expect(opened.inclusion?.excluded.map(row=>row.companyId)).toEqual([company.C,company.D,company.E]);
  expect(opened.result).toMatchObject({available:false,rows:[],summary:null,displayedRows:0});
  expect(payrollComparisonEmptyMessage(opened.inclusion,t)).toBe('inclusion.emptyNoneReady');
  // One chosen company that is not ready: the same panel and empty state.
  const chosen=await reconciliation(all(),{companyId:company.E});
  expect(chosen.inclusion).toMatchObject({includedCompanyIds:[],withPayrollCount:1,neverRanCount:0});
  expect(chosen.result.rows).toEqual([]);
  // A chosen ready company compares on its own.
  const ready=await reconciliation(all(),{companyId:company.A});
  expect(ready.result.rows.map(row=>row.employmentId)).toEqual([employment.A]);
 });

 it('records which companies were included and excluded, and exports the same rule',async()=>{
  const exported=await reconciliation(all(),{},'export');
  expect(exported.inclusion?.includedCompanyIds).toEqual([company.A,company.B]);
  const auditId=await recordPayrollComparisonRun(ctx,exported,'export','xlsx');
  const [event]=await owner.db.select({payload:s.domainEvent.payload}).from(s.domainEvent)
   .where(and(eq(s.domainEvent.tenantId,b.tenantId),eq(s.domainEvent.eventType,'custom-report.comparison-recorded'),sql`${s.domainEvent.payload}->>'auditId'=${auditId}`));
  expect((event.payload as {inclusion:unknown}).inclusion).toEqual({
   includedCompanyIds:[company.A,company.B],neverRanCount:1,
   excluded:[
    {companyId:company.C,reasons:[{code:'previousNotClosed',period:previousPeriod}]},
    {companyId:company.D,reasons:[{code:'missingPayroll',period:currentPeriod}]},
    {companyId:company.E,reasons:[{code:'draftPayroll',period:currentPeriod}]},
    {companyId:company.G,reasons:[{code:'stalePayroll',period:currentPeriod}]},
   ],
  });
  expect(new Set(exported.result.rows.map(row=>row.employmentId))).toEqual(new Set([employment.A,employment.B]));
  const file=await serializePayrollComparison(exported,'xlsx');
  const book=XLSX.read(file.bytes,{type:'array'});
  const summary=XLSX.utils.sheet_to_json<string[]>(book.Sheets[book.SheetNames[0]],{header:1}).map(row=>row.join(' | '));
  expect(summary).toContain('Companies compared | Comparing 2 of 6 companies with payroll. Rows and totals cover these companies only.');
  expect(summary).toContain('Not included | '+NAMES.D+': missingPayroll '+currentPeriod);
  expect(summary).toContain('Never ran payroll | 1');
 });
 it('keeps the saved-results completeness check for every included run',async()=>{
  // Last in this file: remove B's current payslip behind Payroll's back (owner session); the included run is now incomplete.
  await owner.client.begin(async tx=>{
   await tx`set local session_replication_role = replica`;
   await tx`delete from payslip where batch_id=${batch['B'+currentPeriod]}`;
  });
  await expect(reconciliation(all())).rejects.toThrow('Saved payroll results are incomplete or unavailable in this scope. No partial comparison was generated.');
  // Not when that company is outside the scope compared.
  expect((await reconciliation([company.A,company.C])).inclusion?.includedCompanyIds).toEqual([company.A]);
 });

});
