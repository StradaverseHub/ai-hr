/** Authored UNRUN. Actual canonical graph writers and two-connection protected intervals. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as tenantDb from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,transferEmployee,setEmploymentAssignment,changeEmploymentCompany,transferEmploymentCompanyTx,setReportingLine,editDelegation,endReportingLine} from '../core/org';
import * as commands from '../core/workforce-commands';
import {commitEmployeeImport} from '../core/import';
import {lockLeaveDependenciesTx} from '../core/leave-dependency-lock';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const group=():SessionContext=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
const hire=(name:string)=>hireEmployee(group(),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
const state=async()=>({employment:await owner.db.select().from(schema.employment).where(eq(schema.employment.tenantId,b.tenantId)).orderBy(schema.employment.id),assignments:await owner.db.select().from(schema.assignment).where(eq(schema.assignment.tenantId,b.tenantId)).orderBy(schema.assignment.id),lines:await owner.db.select().from(schema.reportingLine).where(eq(schema.reportingLine.tenantId,b.tenantId)).orderBy(schema.reportingLine.id),scopes:await owner.db.select().from(schema.reportingLineScope).where(eq(schema.reportingLineScope.tenantId,b.tenantId)).orderBy(schema.reportingLineScope.id),ledger:await owner.db.select().from(schema.leaveLedger).where(eq(schema.leaveLedger.tenantId,b.tenantId)).orderBy(schema.leaveLedger.id),events:await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId,b.tenantId)).orderBy(schema.domainEvent.id)});
// ADR-0155 §5: a refused or rolled-back full import still appends its own import-attempt audit events
// (previewed, then failed) outside the rolled-back write. Those are the history record of the refusal,
// not an employee graph/ledger/event effect, so they are asserted separately and exactly.
type State=Awaited<ReturnType<typeof state>>;
const isAttemptEvent=(e:State['events'][number])=>e.aggregateType==='import-attempt';
const withoutAttemptEvents=(s:State)=>({...s,events:s.events.filter(e=>!isAttemptEvent(e))});
const newAttemptEvents=(before:State,after:State)=>after.events.filter(e=>isAttemptEvent(e)&&!before.events.some(o=>o.id===e.id)).map(e=>e.eventType).sort();
async function heldEmployee(id:string){let ready!:()=>void,failed!:(error:unknown)=>void,release!:()=>void;const started=new Promise<void>((yes,no)=>{ready=yes;failed=no;}),finish=new Promise<void>(yes=>{release=yes;});const watchdog=setTimeout(()=>{failed(Error('owned placement handshake timed out'));release();},10000);const holder=withTenant(group(),async tx=>{await lockLeaveDependenciesTx(tx,b.tenantId,[id]);ready();await finish;});void holder.catch(failed);await started;return{async close(){release();clearTimeout(watchdog);await holder;}};}
async function destination(){const [co]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Destination',country:'MY',currency:'MYR'}).returning();const [dept]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:co.id,name:'DEST',label:'Fictional Destination Department'}).returning();return{companyId:co.id,departmentId:dept.id};}
describe('structural placement writers own configuration before planning',()=>{
 it.each(['transfer','assignment','company-correction','company-transfer-tx','reporting','delegate','edit-delegate','end-line'] as const)('%s refuses a held participant with identical graph, then applies after release',async kind=>{
  const a=await hire('Fictional Placement Subject'),manager=await hire('Fictional Placement Manager'),today=todayInKualaLumpur();
  let lineId:string|undefined;
  if(['delegate','edit-delegate','end-line'].includes(kind)){
   const childA=await hire('Fictional Report A'),childB=await hire('Fictional Report B');
   await setReportingLine(group(),{subordinateEmploymentId:childA.employmentId,managerEmploymentId:a.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
   await setReportingLine(group(),{subordinateEmploymentId:childB.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
   if(kind!=='delegate')lineId=(await setReportingLine(group(),{subordinateEmploymentId:a.employmentId,managerEmploymentId:manager.employmentId,lineType:'delegate',validFrom:'2020-01-01'})).reportingLineId;
  }
  const dest=['company-correction','company-transfer-tx'].includes(kind)?await destination():undefined;
  const invoke=()=>kind==='transfer'?transferEmployee(group(),{employmentId:a.employmentId,effectiveDate:today,departmentId:b.deptB})
   :kind==='assignment'?setEmploymentAssignment(group(),{employmentId:a.employmentId,effectiveDate:today,departmentId:b.deptB})
   :kind==='company-correction'?changeEmploymentCompany(group(),{employmentId:a.employmentId,newCompanyId:dest!.companyId,departmentId:dest!.departmentId})
   :kind==='company-transfer-tx'?withTenant(group(),tx=>transferEmploymentCompanyTx(tx,group(),{employmentId:a.employmentId,newCompanyId:dest!.companyId,effectiveDate:today,placement:{departmentId:dest!.departmentId,positionId:null,businessUnitId:null,locationId:null,managerEmploymentId:null},movement:{type:'entityTransfer',groupId:randomUUID()}}))
   :kind==='edit-delegate'?editDelegation(group(),{reportingLineId:lineId!,managerEmploymentId:manager.employmentId,validFrom:today,validTo:null,reason:'Fictional changed scope',scopes:[{module:'leave',taskType:null}]})
   :kind==='end-line'?endReportingLine(group(),{reportingLineId:lineId!,endDate:today})
   :setReportingLine(group(),{subordinateEmploymentId:a.employmentId,managerEmploymentId:manager.employmentId,lineType:kind==='delegate'?'delegate':'administrative',validFrom:today,reason:'Fictional placement fixture'});
  const before=await state(),holder=await heldEmployee(a.employmentId);
  try{await expect(invoke()).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);}finally{await holder.close();}
  await invoke();const after=await state();expect(after.events.length).toBeGreaterThan(before.events.length);
  if(kind==='transfer'||kind==='assignment'){const open=after.assignments.find(row=>row.employmentId===a.employmentId&&row.validTo===null&&row.supersededAt===null);expect(open?.departmentId).toBe(b.deptB);}
  if(dest)expect(after.employment.find(row=>row.id===a.employmentId)?.companyId).toBe(dest.companyId);
  if(kind==='edit-delegate'){expect(after.lines.find(row=>row.id===lineId)?.supersededAt).not.toBeNull();expect(after.scopes.some(row=>row.module==='leave')).toBe(true);}
  if(kind==='end-line')expect(after.lines.find(row=>row.id===lineId)?.validTo).toBe(today);
 });
 it.each(['transfer','assignment','reporting'] as const)('captures %s wrapper arguments BEFORE asynchronous Workforce admission',async kind=>{
  const a=await hire('Fictional Captured Subject'),manager=await hire('Fictional Captured Manager'),ctx=group(),today=todayInKualaLumpur();
  let reached!:()=>void,release!:()=>void;const entered=new Promise<void>(yes=>{reached=yes;}),held=new Promise<void>(yes=>{release=yes;});
  const actual=tenantDb.withTenant,boundary=vi.spyOn(tenantDb,'withTenant').mockImplementationOnce(async(c,fn)=>{reached();await held;return actual(c,fn);});
  const input={employmentId:a.employmentId,effectiveDate:today,departmentId:b.deptB,movement:{type:'transfer',groupId:randomUUID()}},report={subordinateEmploymentId:a.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative' as const,validFrom:today,movement:{type:'transfer',groupId:randomUUID()}};
  const pending=kind==='transfer'?commands.transferEmployee(ctx,input):kind==='assignment'?commands.setEmploymentAssignment(ctx,input):commands.setReportingLine(ctx,report);
  try{await entered;input.employmentId=randomUUID();input.departmentId=b.deptA;input.movement.type='retargeted';report.managerEmploymentId=randomUUID();report.movement.type='retargeted';ctx.userId=randomUUID();ctx.roles!.splice(0,ctx.roles!.length,'employee');ctx.grants![0].role='employee';release();await pending;}
  finally{release();await pending.catch(()=>{});boundary.mockRestore();}
  const after=await state();expect(JSON.stringify(after.events)).not.toContain('retargeted');
  if(kind==='reporting')expect(after.lines.some(row=>row.subordinateEmploymentId===a.employmentId&&row.managerEmploymentId===manager.employmentId)).toBe(true);
  else expect(after.assignments.find(row=>row.employmentId===a.employmentId&&row.validTo===null&&row.supersededAt===null)?.departmentId).toBe(b.deptB);
 });
});
const importRow=()=>({full_name:'Fictional Import Placement',email:randomUUID()+'@fixture.test',department:'Finance',hired_on:todayInKualaLumpur(),employment_type:'full_time',employee_code:'PLACEMENT01',basic_salary:'2500'});
describe('whole employee import owns its earlier actual source interval',()=>{
 it('refuses a held participant without any employee graph/ledger/event effect, then imports after release',async()=>{
  const existing=await hire('Fictional Import Interval'),row=importRow(),before=await state(),holder=await heldEmployee(existing.employmentId);
  try{const result=await commitEmployeeImport(group(),{companyId:b.companyId,records:[row]});expect(result.imported).toBe(0);expect(result.fileErrors?.some(message=>message.includes('rolled back'))).toBe(true);const after=await state();expect(withoutAttemptEvents(after)).toEqual(withoutAttemptEvents(before));expect(newAttemptEvents(before,after)).toEqual(['import-attempt.failed','import-attempt.previewed']);expect(await owner.db.select().from(schema.person).where(eq(schema.person.primaryEmail,row.email))).toEqual([]);}
  finally{await holder.close();}
  const result=await commitEmployeeImport(group(),{companyId:b.companyId,records:[row]});expect(result.imported).toBe(1);expect(result.failed).toEqual([]);
 });
 it('freshly resolves the original file in its actual write Tx and refuses changed nomination without retarget',async()=>{
  const row=importRow(),before=await state(),actual=tenantDb.withTenant;let intercepted=0;
  // An actual catalogue mutation between committed preview reads and the write transaction. Assert
  // this explicit barrier was reached; no timer/promise scheduling is accepted as concurrency proof.
  const boundary=vi.spyOn(tenantDb,'withTenant').mockImplementation(async(ctx,fn)=>{
   if(fn.toString().includes('Employee import inputs changed')){intercepted++;await owner.db.update(schema.department).set({label:'Fictional changed catalogue label'}).where(eq(schema.department.id,b.deptA));}
   return actual(ctx,fn);
  });
  try{const result=await commitEmployeeImport(group(),{companyId:b.companyId,records:[row]});expect(intercepted).toBe(1);expect(result.imported).toBe(0);expect(result.fileErrors?.some(message=>message.includes('Employee import inputs changed'))).toBe(true);const after=await state();expect(withoutAttemptEvents(after)).toEqual(withoutAttemptEvents(before));expect(newAttemptEvents(before,after)).toEqual(['import-attempt.failed','import-attempt.previewed']);expect(await owner.db.select().from(schema.person).where(eq(schema.person.primaryEmail,row.email))).toEqual([]);}
  finally{boundary.mockRestore();}
  const retried=await commitEmployeeImport(group(),{companyId:b.companyId,records:[row]});expect(retried.imported).toBe(1);
 });
 it('captures uploaded records, scalar options and calling actor before any preview await',async()=>{
  const row=importRow(),ctx=group(),input={companyId:b.companyId,records:[row],fileName:'fictional-original.csv'};
  let reached!:()=>void,release!:()=>void;const entered=new Promise<void>(yes=>{reached=yes;}),held=new Promise<void>(yes=>{release=yes;});
  const actual=tenantDb.withTenant,boundary=vi.spyOn(tenantDb,'withTenant').mockImplementationOnce(async(c,fn)=>{reached();await held;return actual(c,fn);});
  const pending=commitEmployeeImport(ctx,input),originalEmail=row.email;
  try{await entered;row.email='retargeted@fixture.test';row.department='Missing department';input.fileName='retargeted.csv';input.companyId=randomUUID();ctx.userId=randomUUID();ctx.roles!.splice(0,ctx.roles!.length,'employee');ctx.grants![0].role='employee';release();const result=await pending;expect(result.imported).toBe(1);}
  finally{release();await pending.catch(()=>{});boundary.mockRestore();}
  expect(await owner.db.select().from(schema.person).where(eq(schema.person.primaryEmail,originalEmail))).toHaveLength(1);
  expect(await owner.db.select().from(schema.person).where(eq(schema.person.primaryEmail,'retargeted@fixture.test'))).toEqual([]);
 });
});
