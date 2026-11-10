/**
 * Reader/writer Access lock, people and workforce wave. Real PostgreSQL through the repository harness.
 *
 * Three kinds of fact, each observed on real transactions:
 * - strict mode: a converted writer run inside one transaction with app.access_lock_strict and
 *   AIHR_ACCESS_LOCK_STRICT on still holds only the SHARED Access lock when it finishes, so nothing on its
 *   path (TypeScript or SQL) asked for the exclusive lock;
 * - liveness: a converted writer that owns its own transaction completes while another session holds the
 *   shared lock (an exclusive request would wait for that holder), and still waits for an editor;
 * - serialisers: the invariants exclusivity used to protect still hold under concurrency, through the
 *   real services, including the last-administrator check through the administrator guard.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,isNull,sql as dsql} from 'drizzle-orm';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appUser,domainEvent,employeeDraft,employment,person,reportingLine,reviewDocument,roleAssignment} from '../db/schema';
import {lockAccessAdministratorSetTx,lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {revokeRole} from '../core/admin';
import {endReportingLine,hireEmployee,ReportingCycleError,setEmploymentAssignment,setEmploymentHolidayCalendar,setEmploymentInfo,setEmploymentWorkState,setReportingLine,terminateEmployment,terminateEmploymentTx,updatePerson} from '../core/org';
import * as commands from '../core/workforce-commands';
import * as registers from '../core/workforce-registers';
import {assertWorkforceEmploymentTx} from '../core/workforce-access';
import {withPersonnelRead} from '../core/personnel-read-bounds';
import {addEmployeeDocument,deleteEmployeeDocument,getEmployeeDocument,listEmployeeDocuments,replaceEmployeeDocumentContent,updateEmployeeDocumentMeta} from '../core/employee-documents';
import {decideReview,startReview,submitManagerEvaluation,uploadReviewDocument} from '../core/employment-review';
import {createEmployeeDraftWithReservedCode,saveEmployeeDraft} from '../core/employee-draft';
import {decideResignation,submitResignation} from '../core/offboarding';
import {correctHireDetails} from '../core/hire-correction';
import {movementImportDownloadData} from '../core/movement-import';
import {withExitDateAuthorityTx} from '../core/exit-date-authority';
import {maintainWorkforceRecord,workforceEditor} from '../core/workforce-maintenance';
import {WorkforceRecordChangedError} from '../core/workforce-code';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';

const barrier=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const lockKey=(tenantId:string)=>`hashtextextended('access-configuration:${tenantId}',0)`;
async function settled<T>(promise:Promise<T>,ms=4000):Promise<'timeout'|{value:T}>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise.then(value=>({value})),new Promise<'timeout'>(resolve=>{timer=setTimeout(()=>resolve('timeout'),ms);})]);}
 finally{if(timer)clearTimeout(timer);}
}
const sqlState=(reason:unknown)=>{
 let current=reason as {code?:unknown;cause?:unknown}|undefined;
 for(let depth=0;current&&depth<6;depth++){if(typeof current.code==='string')return current.code;current=current.cause as typeof current;}
 return undefined;
};
const PDF=Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
const yesterday=()=>{const d=new Date(`${todayInKualaLumpur()}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);};

let b:Base;
let raw:postgres.Sql;
let strictBefore:string|undefined;
beforeAll(async()=>{
 await migrateTestDb();raw=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:16,onnotice:()=>{}});
 // The TypeScript half of strict mode: a shared holder asking for the exclusive lock throws at once.
 strictBefore=process.env.AIHR_ACCESS_LOCK_STRICT;process.env.AIHR_ACCESS_LOCK_STRICT='on';
});
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(async()=>{
 if(strictBefore===undefined)delete process.env.AIHR_ACCESS_LOCK_STRICT;else process.env.AIHR_ACCESS_LOCK_STRICT=strictBefore;
 await raw.end({timeout:5});await closeAll();
});

const today=()=>todayInKualaLumpur();
async function hire(label:string,ctx:SessionContext=adminCtx(b)){
 return hireEmployee(ctx,{person:{fullName:`Fictional ${label}`,primaryEmail:`people-${label.toLowerCase().replace(/\W+/g,'-')}-${randomUUID()}@example.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
}
/** Run a writer in one transaction with strict mode on, and report the Access mode held when it finishes. */
async function strict<T>(ctx:SessionContext,work:(tx:Tx)=>Promise<T>):Promise<{value:T;mode:string|null}>{
 return withTenant(ctx,async tx=>{
  await tx.execute(dsql`select set_config('app.access_lock_strict','on',true)`);
  const value=await work(tx);
  const [row]=await tx.execute<{mode:string|null}>(dsql`select app.access_lock_mode_held(${ctx.tenantId}::uuid) as mode`);
  return {value,mode:row?.mode??null};
 });
}
/** Another session holds the shared Access lock until released. */
async function sharedHolder(){
 const held=barrier(),release=barrier();
 const done=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock_shared(${lockKey(b.tenantId)})`);held.resolve();await release.promise;});
 await held.promise;
 return {release:async()=>{release.resolve();await done;}};
}
/** Hold a real transaction open at a chosen point, then commit it on release. */
function heldTransaction<T>(ctx:SessionContext,work:(tx:Tx)=>Promise<T>){
 const held=barrier(),release=barrier();
 const done=withTenant(ctx,async tx=>{const value=await work(tx);held.resolve();await release.promise;return value;});
 void done.catch(()=>held.resolve());
 return {held:held.promise,release:()=>release.resolve(),done};
}

describe('Workforce checks join the mode the transaction holds',()=>{
 it('joins the shared lock after a converted writer took it, and keeps the exclusive lock otherwise',async()=>{
  const e=await hire('join');
  const shared=await withTenant(adminCtx(b),async tx=>{
   await lockAccessConfigurationTx(tx,b.tenantId);await assertWorkforceEmploymentTx(tx,adminCtx(b),e.employmentId,'maintain');await assertWorkforceEmploymentTx(tx,adminCtx(b),e.employmentId,'view');
   const [row]=await tx.execute<{mode:string}>(dsql`select app.access_lock_mode_held(${b.tenantId}::uuid) as mode`);return row.mode;
  });
  expect(shared).toBe('S');
  const exclusive=await withTenant(adminCtx(b),async tx=>{
   await assertWorkforceEmploymentTx(tx,adminCtx(b),e.employmentId,'maintain');
   const [row]=await tx.execute<{mode:string}>(dsql`select app.access_lock_mode_held(${b.tenantId}::uuid) as mode`);return row.mode;
  });
  expect(exclusive).toBe('X');
 });
 it('reads a borrowed Personnel transaction under the shared lock it already holds',async()=>{
  const e=await hire('borrowed');
  const mode=await withTenant(adminCtx(b),async tx=>{
   await lockAccessConfigurationTx(tx,b.tenantId);
   await withPersonnelRead(adminCtx(b),async borrowed=>borrowed.select({id:employment.id}).from(employment).where(eq(employment.id,e.employmentId)),{existingTx:tx});
   const [row]=await tx.execute<{mode:string}>(dsql`select app.access_lock_mode_held(${b.tenantId}::uuid) as mode`);return row.mode;
  });
  expect(mode).toBe('S');
 });
});

describe('strict mode: converted people writers never ask for the exclusive lock',()=>{
 it('person, employment, reporting-line, register and compliance writers finish holding only the shared lock',async()=>{
  const ctx=adminCtx(b),subject=await hire('strict subject'),manager=await hire('strict manager');
  const results=[
   await strict(ctx,tx=>updatePerson(ctx,{personId:subject.personId,fullName:'Fictional Strict Renamed',primaryEmail:`strict-${randomUUID()}@example.invalid`},tx)),
   await strict(ctx,tx=>commands.setEmploymentInfo(ctx,{employmentId:subject.employmentId,contractRemark:'Fictional strict remark'},tx)),
   await strict(ctx,tx=>commands.setEmploymentGrade(ctx,{employmentId:subject.employmentId,gradeId:null},tx)),
   await strict(ctx,tx=>commands.setEmploymentAssignment(ctx,{employmentId:subject.employmentId,effectiveDate:today(),departmentId:b.deptB},tx)),
   await strict(ctx,tx=>commands.setReportingLine(ctx,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:today()},tx)),
   await strict(ctx,tx=>commands.setPersonComplianceFields(ctx,{employmentId:subject.employmentId,gender:'female'},tx)),
   await strict(ctx,tx=>registers.addEmergencyContact(ctx,{personId:subject.personId,fullName:'Fictional Strict Contact',relationship:'spouse',mobilePhone:'+60123456789',priority:'primary'},tx)),
  ];
  expect(results.map(result=>result.mode)).toEqual(['S','S','S','S','S','S','S']);
 },120000);
 it('an exit-date save and a termination take the administrator guard under the shared lock',async()=>{
  const ctx=adminCtx(b),leaver=await hire('strict leaver'),exit=await hire('strict exit date');
  const epoch=async()=>{const [row]=await owner.db.execute<{epoch:string}>(dsql`select epoch::text from app.access_administrator_guard where tenant_id=${b.tenantId}::uuid`);return Number(row.epoch);};
  const before=await epoch();
  const dates=await strict(ctx,tx=>withExitDateAuthorityTx(tx,exit.employmentId,()=>setEmploymentInfo(ctx,{employmentId:exit.employmentId,lastWorkingDate:today()},tx)));
  const terminated=await strict(ctx,async tx=>{
   await lockAccessConfigurationTx(tx,b.tenantId);await lockAccessAdministratorSetTx(tx,b.tenantId);
   await assertWorkforceEmploymentTx(tx,ctx,leaver.employmentId,'maintain');
   return terminateEmploymentTx(tx,ctx,{employmentId:leaver.employmentId,terminationDate:today(),terminationType:'voluntary',terminationReason:'Fictional strict exit'});
  });
  expect([dates.mode,terminated.mode]).toEqual(['S','S']);
  expect(await epoch()).toBeGreaterThanOrEqual(before+2);
 },120000);
 it('document, review, draft and resignation writers finish holding only the shared lock',async()=>{
  const ctx=adminCtx(b),subject=await hire('strict records');
  const {id:documentId}=await addEmployeeDocument(ctx,{employmentId:subject.employmentId,title:'Fictional strict document',fileName:'strict.pdf',mimeType:'application/pdf',content:PDF});
  await owner.db.update(employment).set({probationEndDate:'2026-04-30'}).where(eq(employment.id,subject.employmentId));
  const {reviewId}=await startReview(ctx,{employmentId:subject.employmentId});
  const userId=await createAppUser(b.tenantId,subject.personId,'employee');
  const own:SessionContext={tenantId:b.tenantId,userId,personId:subject.personId,roles:['employee']};
  const {requestId}=await submitResignation(own,{employmentId:subject.employmentId,lastWorkingDay:'2099-12-31',reason:'Fictional strict resignation'});
  const results=[
   await strict(ctx,tx=>updateEmployeeDocumentMeta(ctx,{documentId,title:'Fictional strict renamed'},tx)),
   await strict(ctx,tx=>submitManagerEvaluation(ctx,{reviewId,recommendation:'recommend_confirm'},tx)),
   await strict(ctx,tx=>decideReview(ctx,{reviewId,decision:'confirm'},tx)),
   await strict(ctx,tx=>saveEmployeeDraft(ctx,{data:{profile:{fullName:'Fictional Strict Draft'},employment:{companyId:b.companyId}},currentStep:1},tx)),
   await strict(ctx,tx=>decideResignation(ctx,{requestId,decision:'accepted'},tx)),
  ];
  expect(results.map(result=>result.mode)).toEqual(['S','S','S','S','S']);
 },120000);
});

describe('liveness: converted writers run while another writer holds the shared lock',()=>{
 it('completes employment, person, reporting-line, correction and document writes without the exclusive lock',async()=>{
  const ctx=adminCtx(b),subject=await hire('live subject'),manager=await hire('live manager'),leaver=await hire('live leaver');
  const line=await setReportingLine(ctx,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
  const {id:documentId}=await addEmployeeDocument(ctx,{employmentId:subject.employmentId,title:'Fictional live document',fileName:'live.pdf',mimeType:'application/pdf',content:PDF});
  const holder=await sharedHolder();
  try{
   const writes:[string,()=>Promise<unknown>][]=[
    ['work state',()=>setEmploymentWorkState(ctx,{employmentId:subject.employmentId,workState:'Selangor'})],
    ['holiday calendar',()=>setEmploymentHolidayCalendar(ctx,{employmentId:subject.employmentId,selection:{kind:'none'}})],
    ['person',()=>updatePerson(ctx,{personId:subject.personId,fullName:'Fictional Live Renamed',primaryEmail:`live-${randomUUID()}@example.invalid`})],
    ['assignment',()=>setEmploymentAssignment(ctx,{employmentId:subject.employmentId,effectiveDate:today(),departmentId:b.deptB})],
    ['hire correction',()=>correctHireDetails(ctx,{employmentId:leaver.employmentId,reason:'Fictional correction',changes:{departmentId:b.deptB}})],
    ['end line',()=>endReportingLine(ctx,{reportingLineId:line.reportingLineId,endDate:today()})],
    ['document add',()=>addEmployeeDocument(ctx,{employmentId:subject.employmentId,title:'Fictional second document',fileName:'second.pdf',mimeType:'application/pdf',content:PDF})],
    ['document replace',()=>replaceEmployeeDocumentContent(ctx,{documentId,fileName:'live-2.pdf',mimeType:'application/pdf',content:PDF})],
    ['document list',()=>listEmployeeDocuments(ctx,subject.employmentId)],
    ['document read',()=>getEmployeeDocument(ctx,documentId)],
    ['document delete',()=>deleteEmployeeDocument(ctx,{documentId})],
    ['movement workbook',()=>movementImportDownloadData(ctx,{companyId:b.companyId})],
    ['draft reservation',()=>createEmployeeDraftWithReservedCode(ctx,{companyId:b.companyId,fullName:'Fictional Live Draft',primaryEmail:`draft-${randomUUID()}@example.invalid`,employeeCode:`LIVE-${randomUUID().slice(0,6).toUpperCase()}`})],
    ['termination',()=>terminateEmployment(ctx,{employmentId:leaver.employmentId,terminationDate:today(),terminationType:'voluntary',terminationReason:'Fictional live exit'})],
   ];
   const outcomes:string[]=[];
   for(const [name,write] of writes){
    const result=await settled(write().then(()=>'ok',error=>`${sqlState(error)??''}:${(error as Error).message}`),20000);
    outcomes.push(`${name}=${result==='timeout'?'timeout':result.value}`);
   }
   expect(outcomes).toEqual(writes.map(([name])=>`${name}=ok`));
  }finally{await holder.release();}
 },240000);
 it('still waits behind an access configuration editor',async()=>{
  const subject=await hire('editor wait'),held=barrier(),release=barrier();
  const editor=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock(${lockKey(b.tenantId)})`);held.resolve();await release.promise;});
  await held.promise;
  const write=updatePerson(adminCtx(b),{personId:subject.personId,fullName:'Fictional Editor Wait',primaryEmail:`wait-${randomUUID()}@example.invalid`});
  expect(await settled(write,800)).toBe('timeout');
  release.resolve();await editor;
  await expect(write).resolves.toBeDefined();
 },60000);
});

describe('serialisers under the shared lock',()=>{
 it('two concurrent edits of the same person both apply, one after the other',async()=>{
  const subject=await hire('same person');
  const names=['Fictional Edit One','Fictional Edit Two'];
  const results=await Promise.allSettled(names.map(fullName=>updatePerson(adminCtx(b),{personId:subject.personId,fullName,primaryEmail:`same-${randomUUID()}@example.invalid`})));
  expect(results.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
  const [row]=await owner.db.select({fullName:person.fullName}).from(person).where(eq(person.id,subject.personId));
  expect(names).toContain(row.fullName);
  const events=await owner.db.select({id:domainEvent.id}).from(domainEvent).where(and(eq(domainEvent.aggregateId,subject.personId),eq(domainEvent.eventType,'person.updated')));
  expect(events).toHaveLength(2);
 },60000);
 it('two concurrent hires both complete without a deadlock',async()=>{
  const results=await settled(Promise.allSettled([hire('concurrent hire one'),hire('concurrent hire two')]),60000);
  expect(results).not.toBe('timeout');
  expect((results as {value:PromiseSettledResult<unknown>[]}).value.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
 },90000);
 it('a hire and an edit of another person at the same moment both complete',async()=>{
  const subject=await hire('edited during hire');
  const results=await Promise.allSettled([hire('hired during edit'),updatePerson(adminCtx(b),{personId:subject.personId,fullName:'Fictional Edited During Hire',primaryEmail:`during-${randomUUID()}@example.invalid`})]);
  expect(results.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
 },90000);
 it('refuses a reporting loop formed by two concurrent structural lines with the same typed error',async()=>{
  const ctx=adminCtx(b),first=await hire('loop first'),second=await hire('loop second');
  const one=heldTransaction(ctx,tx=>setReportingLine(ctx,{subordinateEmploymentId:first.employmentId,managerEmploymentId:second.employmentId,lineType:'administrative',validFrom:today()},tx));
  await one.held;
  const two=setReportingLine(ctx,{subordinateEmploymentId:second.employmentId,managerEmploymentId:first.employmentId,lineType:'administrative',validFrom:today()}).then(()=>'committed',error=>(error as Error).name);
  expect(await settled(two,400)).toBe('timeout');
  one.release();await one.done;
  expect(await two).toBe(new ReportingCycleError().name);
 },60000);
 it('keeps one open line when two managers are set for the same subordinate at the same moment',async()=>{
  const ctx=adminCtx(b),subject=await hire('one line'),managers=[await hire('line manager one'),await hire('line manager two')];
  const results=await Promise.allSettled(managers.map(manager=>setReportingLine(ctx,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:today()})));
  expect(results.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
  const open=await owner.db.select({id:reportingLine.id}).from(reportingLine).where(and(eq(reportingLine.subordinateEmploymentId,subject.employmentId),eq(reportingLine.lineType,'administrative'),isNull(reportingLine.validTo),isNull(reportingLine.supersededAt)));
  expect(open).toHaveLength(1);
 },60000);
 it('opens one review when two starts for the same employment arrive together',async()=>{
  const subject=await hire('review start');
  await owner.db.update(employment).set({probationEndDate:'2026-04-30'}).where(eq(employment.id,subject.employmentId));
  const results=await Promise.allSettled([1,2].map(()=>startReview(adminCtx(b),{employmentId:subject.employmentId})));
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  const refused=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
  expect(refused.map(result=>result.reason?.name)).toEqual(['ReviewError']);
 },60000);
 it('saves one system letter when two arrive together for the same review',async()=>{
  const ctx=adminCtx(b),subject=await hire('review letter');
  await owner.db.update(employment).set({probationEndDate:'2026-04-30'}).where(eq(employment.id,subject.employmentId));
  const {reviewId}=await startReview(ctx,{employmentId:subject.employmentId});
  await submitManagerEvaluation(ctx,{reviewId,recommendation:'recommend_confirm'});await decideReview(ctx,{reviewId,decision:'confirm'});
  const results=await Promise.allSettled([1,2].map(n=>uploadReviewDocument(ctx,{reviewId,kind:'system_letter',fileName:`letter-${n}.pdf`,mimeType:'application/pdf',content:PDF})));
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(results.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>String(result.reason?.message))).toEqual(['The letter is already saved to this review.']);
  expect(await owner.db.select({id:reviewDocument.id}).from(reviewDocument).where(and(eq(reviewDocument.reviewId,reviewId),eq(reviewDocument.kind,'system_letter')))).toHaveLength(1);
 },60000);
 it('reserves a hand-keyed Employee ID once when two drafts claim it together',async()=>{
  const code=`PPL-${randomUUID().slice(0,6).toUpperCase()}`;
  const results=await Promise.allSettled([1,2].map(n=>createEmployeeDraftWithReservedCode(adminCtx(b),{companyId:b.companyId,fullName:`Fictional Claimant ${n}`,primaryEmail:`claim-${n}-${randomUUID()}@example.invalid`,employeeCode:code})));
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(results.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>String(result.reason?.message))).toEqual([`Employee ID "${code}" is reserved by a draft employee record`]);
  expect(await owner.db.select({id:employeeDraft.id}).from(employeeDraft).where(eq(employeeDraft.reservedEmployeeCode,code))).toHaveLength(1);
 },60000);
});

describe('Personnel maintenance command under the shared lock',()=>{
 async function maintainer():Promise<SessionContext>{
  const hrPerson=await hire('maintainer');const userId=await createAppUser(b.tenantId,hrPerson.personId,'hr_admin');
  return {...adminCtx(b),userId,personId:hrPerson.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 }
 it('finishes a person save holding only the shared lock in strict mode',async()=>{
  const ctx=await maintainer(),subject=await hire('maintained strict');
  const workspace=await workforceEditor(ctx,subject.employmentId);
  expect(workspace?.sharedMaintain).toBe(true);
  const result=await strict(ctx,tx=>maintainWorkforceRecord(ctx,{employmentId:subject.employmentId,kind:'person',rowId:null,operation:'update',expectedVersion:workspace!.profileVersion,patch:{preferredName:'Fictional strict preferred'}},tx));
  expect(result.mode).toBe('S');
  expect(result.value).toMatchObject({changed:true});
 },60000);
 it('serialises two saves of the same profile version: one applies, the other sees the change',async()=>{
  const ctx=await maintainer(),subject=await hire('maintained twice');
  const workspace=(await workforceEditor(ctx,subject.employmentId))!;
  const results=await Promise.allSettled(['Fictional First','Fictional Second'].map(preferredName=>maintainWorkforceRecord(ctx,{employmentId:subject.employmentId,kind:'person',rowId:null,operation:'update',expectedVersion:workspace.profileVersion,patch:{preferredName}})));
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  const refused=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
  expect(refused).toHaveLength(1);
  expect(refused[0].reason).toBeInstanceOf(WorkforceRecordChangedError);
 },60000);
});

describe('S+A: two concurrent administrator removals cannot both commit',()=>{
 /** Two administrators whose logins depend on their employments, and an HR actor scoped to one company, which
  * makes it a Workforce maintainer but not a system administrator, so it never counts towards the last one. */
 async function twoAdministrators(){
  const groupAdmin={...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]};
  await withTenant(groupAdmin,tx=>accessConfigurationStore.loadCurrent(tx,groupAdmin));
  const people:{employmentId:string;personId:string;userId:string}[]=[];
  for(const label of ['one','two']){
   const hired=await hire(`administrator ${label}`);
   people.push({employmentId:hired.employmentId,personId:hired.personId,userId:await createAppUser(b.tenantId,hired.personId,'hr_admin')});
  }
  const [actorUser]=await owner.db.insert(appUser).values({tenantId:b.tenantId,workosUserId:`user_${randomUUID()}`,personId:null}).returning({id:appUser.id});
  await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:actorUser.id,companyId:b.companyId,role:'hr_admin'});
  const [grant]=await owner.db.select({id:roleAssignment.id}).from(roleAssignment).where(dsql`${roleAssignment.tenantId}=${b.tenantId}::uuid and ${roleAssignment.appUserId}=${b.adminUserId}::uuid and ${roleAssignment.role}='hr_admin'`);
  await revokeRole(groupAdmin,{roleAssignmentId:grant.id});
  const actor:SessionContext={...adminCtx(b),userId:actorUser.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
  return {people,actor};
 }
 const usableAdministrators=async()=>(await owner.db.select({id:roleAssignment.id}).from(roleAssignment).innerJoin(appUser,eq(appUser.id,roleAssignment.appUserId)).innerJoin(employment,eq(employment.personId,appUser.personId)).where(dsql`${roleAssignment.tenantId}=${b.tenantId}::uuid and ${roleAssignment.role}='hr_admin' and ${roleAssignment.companyId} is null and ${employment.terminatedOn} is null`)).length;
 /** The first removal, held open after its change: the same locks and writer terminateEmployment uses. */
 const heldTermination=(actor:SessionContext,employmentId:string)=>heldTransaction(actor,async tx=>{
  await lockAccessConfigurationTx(tx,actor.tenantId);await lockAccessAdministratorSetTx(tx,actor.tenantId);
  await assertWorkforceEmploymentTx(tx,actor,employmentId,'maintain');
  await terminateEmploymentTx(tx,actor,{employmentId,terminationDate:yesterday(),terminationType:'voluntary',terminationReason:'Fictional first removal'});
  const [row]=await tx.execute<{mode:string}>(dsql`select app.access_lock_mode_held(${actor.tenantId}::uuid) as mode`);return row.mode;
 });
 it('a second direct termination waits on the guard, then the last-administrator check refuses it',async()=>{
  const {people:[one,two],actor}=await twoAdministrators();
  const first=heldTermination(actor,one.employmentId);
  await first.held;
  const second=terminateEmployment(actor,{employmentId:two.employmentId,terminationDate:yesterday(),terminationType:'voluntary',terminationReason:'Fictional second removal'}).then(()=>'committed',error=>sqlState(error)??String(error));
  expect(await settled(second,1500)).toBe('timeout');
  first.release();
  expect(await first.done).toBe('S');
  expect(await second).toBe('23514');
  expect(await usableAdministrators()).toBe(1);
 },90000);
 it('an accepted resignation racing a termination is refused the same way',async()=>{
  const {people:[one,two],actor}=await twoAdministrators();
  const own:SessionContext={tenantId:b.tenantId,userId:two.userId,personId:two.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
  const {requestId}=await submitResignation(own,{employmentId:two.employmentId,lastWorkingDay:yesterday(),today:yesterday(),reason:'Fictional resignation'});
  const first=heldTermination(actor,one.employmentId);
  await first.held;
  const second=decideResignation(actor,{requestId,decision:'accepted'}).then(()=>'committed',error=>sqlState(error)??String(error));
  expect(await settled(second,1500)).toBe('timeout');
  first.release();await first.done;
  expect(await second).toBe('23514');
  expect(await usableAdministrators()).toBe(1);
 },90000);
});
