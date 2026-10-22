import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,desc,eq} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {saveMyTp1Draft,submitMyTp1,getMyTp1ById,listMyTp1Declarations,listMyTp1Versions,tp1Revision,
 getTp1ByIdForPerson,saveTp1DraftForPerson,submitTp1ForPerson,approveTp1ForPerson,rejectTp1ForPerson,
 getLatestApprovedTp1,Tp1ChangedError,type Tp1WriteInput} from '../packs/payroll/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {domainEvent} from '../db/schema';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();});
async function employee(role:'employee'|'hr_admin'='employee') {
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional monthly TP1 owner',primaryEmail:`${randomUUID()}@example.invalid`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(base.tenantId,e.personId,role);
 const ctx:SessionContext={...adminCtx(base),userId,personId:e.personId,roles:[role],grants:[{role,companyId:base.companyId}]};
 return{...e,ctx};
}
const year=()=>Number(todayInKualaLumpur().slice(0,4));
const input=(month:number|null,amount=100,expectedRevision='new'):Tp1WriteInput=>({assessmentYear:year(),deductionMonth:month,expectedRevision,declarationAccepted:true,categories:{form:'tp1-2026',items:{c5:{subItems:{a:amount}}},rebates:{}}});
const own=(e:Awaited<ReturnType<typeof employee>>,id:string)=>getMyTp1ById(e.ctx,{id});
describe('monthly Mine TP1 shares canonical records, revisions and employer consent',()=>{
 it('saves and reopens one month without changing another month or turning null into January',async()=>{
  const e=await employee(),jan=await saveMyTp1Draft(e.ctx,input(1)),feb=await saveMyTp1Draft(e.ctx,input(2,200)),legacy=await saveMyTp1Draft(e.ctx,input(null,50));
  const row=(await own(e,jan.id))!;await saveMyTp1Draft(e.ctx,input(1,150,tp1Revision(row)));
  expect(await own(e,jan.id)).toMatchObject({id:jan.id,deductionMonth:1,tp1Amount:150,status:'draft'});
  expect(await own(e,feb.id)).toMatchObject({id:feb.id,deductionMonth:2,tp1Amount:200});
  expect(await own(e,legacy.id)).toMatchObject({id:legacy.id,deductionMonth:null,tp1Amount:50});
  expect((await listMyTp1Declarations(e.ctx)).map(row=>[row.deductionMonth,row.tp1Amount,row.versions])).toEqual([[1,150,1],[2,200,1],[null,50,1]]);
  const [savedEvent]=await owner.db.select({at:domainEvent.occurredAt}).from(domainEvent)
   .where(and(eq(domainEvent.aggregateId,jan.id),eq(domainEvent.eventType,'tp1.draft.saved')))
   .orderBy(desc(domainEvent.occurredAt),desc(domainEvent.id)).limit(1);
  expect(savedEvent).toBeDefined();
  expect((await listMyTp1Declarations(e.ctx)).find(row=>row.id===jan.id)?.lastSavedAt).toEqual(savedEvent.at);
 });
 it('keeps Pending out of the feed and respects Payroll’s distinct effective month on the same transaction',async()=>{
  const e=await employee(),saved=await submitMyTp1(e.ctx,input(1));
  const mine=(await own(e,saved.id))!,admin=await getTp1ByIdForPerson(adminCtx(base),{personId:e.personId,id:saved.id});
  expect(mine).toEqual(admin);expect(mine).toMatchObject({status:'submitted',deductionMonth:1,approvedMonth:null,approvedBy:null});
  expect(await getLatestApprovedTp1(adminCtx(base),{personId:e.personId,assessmentYear:year(),deductionMonth:12})).toBeNull();
  await approveTp1ForPerson(adminCtx(base),{personId:e.personId,id:saved.id,approvedMonth:3,approvedYear:year()});
  expect(await own(e,saved.id)).toMatchObject({id:saved.id,status:'approved',deductionMonth:1,approvedMonth:3,approvedYear:year(),approvedBy:base.adminUserId});
  expect(await getLatestApprovedTp1(adminCtx(base),{personId:e.personId,assessmentYear:year(),deductionMonth:2})).toBeNull();
  expect(await getLatestApprovedTp1(adminCtx(base),{personId:e.personId,assessmentYear:year(),deductionMonth:3})).toMatchObject({id:saved.id,tp1Amount:100});
 });
 it('creates a visible correction draft and retains the old draft and submission unchanged',async()=>{
  const e=await employee(),first=await saveMyTp1Draft(e.ctx,input(1)),oldDraft=(await own(e,first.id))!;
  const submitted=await submitMyTp1(e.ctx,input(1,100,tp1Revision(oldDraft))),oldSubmitted=(await own(e,submitted.id))!;
  const correction=await saveMyTp1Draft(e.ctx,input(1,200,tp1Revision(oldSubmitted)));
  expect(correction.id).not.toBe(first.id);expect(correction.id).not.toBe(submitted.id);
  expect(await own(e,first.id)).toEqual(oldDraft);expect(await own(e,submitted.id)).toEqual(oldSubmitted);
  expect(await listMyTp1Declarations(e.ctx)).toEqual([expect.objectContaining({id:correction.id,status:'draft',versions:3,tp1Amount:200})]);
  expect((await listMyTp1Versions(e.ctx,{assessmentYear:year(),deductionMonth:1})).map(row=>row.id)).toEqual([correction.id,submitted.id,first.id]);
 });
 it('rejects a stale edit after an administrator changes the same draft and serializes repeated submit',async()=>{
  const e=await employee(),first=await saveMyTp1Draft(e.ctx,input(2)),old=(await own(e,first.id))!;
  await saveTp1DraftForPerson(adminCtx(base),{...input(2,300),expectedRevision:undefined,personId:e.personId});
  await expect(saveMyTp1Draft(e.ctx,input(2,400,tp1Revision(old)))).rejects.toBeInstanceOf(Tp1ChangedError);
  const latest=(await own(e,first.id))!,request=input(2,300,tp1Revision(latest));
  const outcomes=await Promise.allSettled([submitMyTp1(e.ctx,request),submitMyTp1(e.ctx,request)]);
  expect(outcomes.filter(row=>row.status==='fulfilled')).toHaveLength(1);
  expect((await listMyTp1Versions(e.ctx,{assessmentYear:year(),deductionMonth:2})).filter(row=>row.status==='submitted')).toHaveLength(1);
 });
 it('retains past and rejected history but refuses past-year writes and spoofed employee consent fields',async()=>{
  const e=await employee(),past=await submitTp1ForPerson(adminCtx(base),{...input(null),personId:e.personId,expectedRevision:undefined,assessmentYear:year()-1});
  expect(await own(e,past.id)).toMatchObject({assessmentYear:year()-1,deductionMonth:null,status:'submitted'});
  await expect(saveMyTp1Draft(e.ctx,{...input(1),assessmentYear:year()-1})).rejects.toThrow('read-only');
  const saved=await submitMyTp1(e.ctx,Object.assign(input(3),{status:'approved',approvedMonth:1,approvedYear:year(),approvedBy:base.adminUserId}));
  expect(await own(e,saved.id)).toMatchObject({status:'submitted',approvedMonth:null,approvedYear:null,approvedBy:null});
  await rejectTp1ForPerson(adminCtx(base),{personId:e.personId,id:saved.id});
  expect(await own(e,saved.id)).toMatchObject({status:'rejected'});
  expect(await getLatestApprovedTp1(adminCtx(base),{personId:e.personId,assessmentYear:year(),deductionMonth:12})).toBeNull();
 });
 it('keeps Mine own-only for an administrator and refuses self-approval through the existing consent owner',async()=>{
  const e=await employee('hr_admin'),peer=await employee(),foreign=await submitMyTp1(peer.ctx,input(1));
  expect(await own(e,foreign.id)).toBeNull();
  await expect(listMyTp1Declarations({...e.ctx,personId:peer.personId})).rejects.toThrow();
  await expect(saveMyTp1Draft({...e.ctx,personId:peer.personId},input(2))).rejects.toThrow();
  expect(await listMyTp1Declarations(e.ctx)).toEqual([]);
  const ownSubmission=await submitMyTp1(e.ctx,input(1));
  await expect(approveTp1ForPerson(e.ctx,{personId:e.personId,id:ownSubmission.id,approvedMonth:1,approvedYear:year()})).rejects.toThrow('own TP1');
  expect(await own(e,ownSubmission.id)).toMatchObject({status:'submitted',approvedBy:null});
 });
});
