import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {pgSqlState} from '../lib/db-error';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {departmentArchiveReviews as reviews,readDepartmentArchiveChoices,departmentArchiveEntryAvailable} from '../core/assistant-actions/department-archive-review-store';
import {readCompletedNativeOutcomeTx} from '../core/assistant-actions/completed-outcome-readers';
import {hireEmployee} from '../core/org';
import {erasePersonPii} from '../core/pdpa';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {bulkSaveLabels,createCompany} from '../core/admin';
import {adminCtx,owner,resetDb,seedBase,setModule,createAppUser,closeAll,type Base} from './harness';
let b:Base,ctx:SessionContext;
const action='org.department.archive',intent=()=>({action,contractVersion:1,departmentId:b.deptB,expectedArchived:false,archived:true});
const confirmation=(r:{actionId:string;reviewedDigest:string})=>({action,contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});
async function stored(id:string){const [r]=await owner.db.execute<{state:string;bodyCount:number;employmentId:string|null;companyId:string;departmentId:string;eventId:string|null}>(sql`select state,employment_id as "employmentId",company_id as "companyId",receipt_subject_id as "departmentId",receipt_event_id as "eventId",(select count(*)::int from app.assistant_own_leave_review_content where action_id=r.id) as "bodyCount" from app.assistant_own_leave_review r where id=${id}::uuid`);return r;}
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-department-custody-key-20261030');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');ctx={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};await grantAssistant(ctx,{appUserId:b.adminUserId});});
afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
describe('genuine catalogue encrypted custody on the existing ledger',()=>{
 it('uses a real unlinked USER, binds no employment and records/replays exactly one native effect',async()=>{
  expect(ctx.personId).toBeUndefined();const p=await reviews.prepare(ctx,intent()),r=p.review;
  expect(await stored(r.actionId)).toMatchObject({state:'awaiting_confirmation',employmentId:null,departmentId:b.deptB,companyId:b.companyId,bodyCount:1});
  expect((await reviews.list(ctx)).reviews.map(x=>x.actionId)).toContain(r.actionId);
  expect(await reviews.reopen(ctx,r.actionId)).toEqual(p);
  const done=await reviews.confirm(ctx,confirmation(r));expect(done.kind).toBe('completed');expect(await reviews.confirm(ctx,confirmation(r))).toEqual(done);expect(await reviews.reopen(ctx,r.actionId)).toEqual(done);
  const held=await stored(r.actionId);expect(held).toMatchObject({state:'completed',bodyCount:0});
  const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,b.deptB));expect(events.filter(e=>e.eventType==='department.updated')).toHaveLength(1);
  expect(events.find(e=>e.id===held.eventId)).toMatchObject({actorId:ctx.userId,actorType:'user',aggregateType:'department',payload:{name:'Operations',archived:true}});
  const [proof]=await owner.db.execute<{same:boolean}>(sql`select r.xmin=p.xmin and r.xmin=d.xmin as same from app.assistant_own_leave_review r join department p on p.id=r.receipt_subject_id join domain_event d on d.id=r.receipt_event_id where r.id=${r.actionId}::uuid`);expect(proof.same).toBe(true);
  const restored=(await reviews.prepare(ctx,{...intent(),expectedArchived:true,archived:false})).review,doneRestore=await reviews.confirm(ctx,confirmation(restored));expect(doneRestore.kind).toBe('completed');if(doneRestore.kind!=='completed')throw Error('Missing restore receipt');expect(doneRestore.receipt.receipt.archived).toBe(false);expect(await reviews.reopen(ctx,restored.actionId)).toEqual(doneRestore);
 });
 it('verifies the closed outcome bridge with current actor, native event and privacy custody',async()=>{
  const r=(await reviews.prepare(ctx,intent())).review,done=await reviews.confirm(ctx,confirmation(r));if(done.kind!=='completed')throw Error('Missing canonical receipt');
  const reference={source:'review',action,actionId:r.actionId},eventId=done.receipt.receipt.eventId;
  expect((await withTenant(ctx,tx=>readCompletedNativeOutcomeTx(tx,ctx,reference))).evidence).toEqual({action,sourceId:r.actionId,eventId,currentStatus:null});
  const userId=await createAppUser(b.tenantId,null,'hr_admin');await grantAssistant(ctx,{appUserId:userId});const other={...ctx,userId};await expect(withTenant(other,tx=>readCompletedNativeOutcomeTx(tx,other,reference))).rejects.toThrow();
  await owner.db.update(schema.department).set({label:'Fictional later native metadata'}).where(eq(schema.department.id,b.deptB));await expect(withTenant(ctx,tx=>readCompletedNativeOutcomeTx(tx,ctx,reference))).rejects.toThrow();
 });
 it('refuses foreign logins without changing the original body or source',async()=>{
  const r=(await reviews.prepare(ctx,intent())).review,userId=await createAppUser(b.tenantId,null,'hr_admin');await grantAssistant(ctx,{appUserId:userId});const other={...ctx,userId};
  const before=await stored(r.actionId);await expect(reviews.confirm(other,confirmation(r))).rejects.toThrow();await expect(reviews.reopen(other,r.actionId)).rejects.toThrow();await expect(reviews.discard(other,{action,contractVersion:1,actionId:r.actionId})).rejects.toThrow();expect(await stored(r.actionId)).toEqual(before);
 });
 it('retires an actor-owned encrypted body after Assistant permission is revoked',async()=>{
  const r=(await reviews.prepare(ctx,intent())).review;await revokeAssistant(ctx,{appUserId:ctx.userId!});await expect(reviews.reopen(ctx,r.actionId)).rejects.toThrow();expect((await reviews.discard(ctx,{action,contractVersion:1,actionId:r.actionId})).receipt.state).toBe('discarded');expect(await stored(r.actionId)).toMatchObject({bodyCount:0,eventId:null});
 });
 it('retires after native role loss with a freshly authenticated carrier',async()=>{
  const r=(await reviews.prepare(ctx,intent())).review;await owner.db.update(schema.roleAssignment).set({role:'employee'}).where(eq(schema.roleAssignment.appUserId,ctx.userId!));const fresh={...ctx,roles:['employee' as const],grants:[{role:'employee' as const,companyId:null}]};
  await expect(reviews.reopen(fresh,r.actionId)).rejects.toThrow();expect((await reviews.discard(fresh,{action,contractVersion:1,actionId:r.actionId})).receipt.state).toBe('discarded');
 });
 it('refuses SYSTEM and employee carriers',async()=>{await expect(reviews.prepare({...ctx,userId:undefined},intent())).rejects.toThrow();const userId=await createAppUser(b.tenantId,null,'employee');await grantAssistant(ctx,{appUserId:userId});const employee={...ctx,userId,roles:['employee' as const],grants:[{role:'employee' as const,companyId:null}]};await expect(reviews.prepare(employee,intent())).rejects.toThrow();});
 it('refuses a stale source without retiring or executing its pending review',async()=>{
  const r=(await reviews.prepare(ctx,intent())).review;await owner.db.update(schema.department).set({label:'Changed'}).where(eq(schema.department.id,b.deptB));await expect(reviews.confirm(ctx,confirmation(r))).rejects.toThrow();expect(await stored(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodyCount:1,eventId:null});
 });
 it('expires and erases the encrypted body before confirmation',async()=>{
  const r=(await reviews.prepare(ctx,intent())).review;await owner.db.execute(sql`update app.assistant_own_leave_review set expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '11 minutes' where id=${r.actionId}::uuid`);const result=await reviews.confirm(ctx,confirmation(r));expect(result.kind).toBe('retired');expect(await stored(r.actionId)).toMatchObject({state:'expired',bodyCount:0,eventId:null});
 });
 it('requires the envelope commitment and does not accept the native or forged digest',async()=>{const r=(await reviews.prepare(ctx,intent())).review;await expect(reviews.confirm(ctx,{...confirmation(r),reviewedDigest:'f'.repeat(64)})).rejects.toThrow();expect(await stored(r.actionId)).toMatchObject({bodyCount:1,eventId:null});});
 it('rejects a prior-transaction native event as completion proof',async()=>{
  const r=(await reviews.prepare(ctx,intent())).review;await bulkSaveLabels(ctx,'department',{creates:[],updates:[{key:b.deptB,id:b.deptB,name:'Operations',archived:true}]});const [event]=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,b.deptB));
  await expect(withTenant(ctx,tx=>tx.execute(sql`select app.assistant_department_archive_command('complete',${r.actionId}::uuid,NULL,NULL,NULL,NULL,NULL,${r.reviewedDigest},NULL,NULL,NULL,${event.id}::uuid)`))).rejects.toThrow();expect(await stored(r.actionId)).toMatchObject({state:'awaiting_confirmation',eventId:null});
 });
 it('rejects savepoint-local row/event evidence and rolls the native effect back',async()=>{
  await expect(withTenant(ctx,async tx=>{await tx.execute(sql`savepoint fictional_child`);await bulkSaveLabels(ctx,'department',{creates:[],updates:[{key:b.deptB,id:b.deptB,name:'Operations',archived:true}]},tx);await tx.execute(sql`release savepoint fictional_child`);await tx.execute(sql`select app.department_archive_grid_current_event(${b.deptB}::uuid,true)`);})).rejects.toThrow();const [p]=await owner.db.select().from(schema.department).where(eq(schema.department.id,b.deptB));expect(p.archivedAt).toBeNull();
 });
 it('refuses replay after a later native metadata write',async()=>{
  const r=(await reviews.prepare(ctx,intent())).review;await reviews.confirm(ctx,confirmation(r));await owner.db.update(schema.department).set({description:'Later metadata'}).where(eq(schema.department.id,b.deptB));await expect(reviews.reopen(ctx,r.actionId)).rejects.toThrow();
 });
 it('keeps dedicated-family receipt columns NULL with otherwise valid foreign keys',async()=>{
  const r=(await reviews.prepare(ctx,intent())).review;
  const [event]=await owner.db.insert(schema.domainEvent).values({tenantId:b.tenantId,aggregateType:'department',aggregateId:b.deptB,eventType:'fixture.hybrid',actorType:'user',actorId:ctx.userId,payload:{}}).returning({id:schema.domainEvent.id});
  const hired=await hireEmployee(ctx,{person:{fullName:'Fictional Hybrid FK',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01'});
  for(const statement of [sql`update app.assistant_own_leave_review set notification_event_id=${event.id}::uuid where id=${r.actionId}::uuid`,sql`update app.assistant_own_leave_review set employment_id=${hired.employmentId}::uuid where id=${r.actionId}::uuid`]){
   let error:unknown;try{await owner.db.execute(statement);}catch(caught){error=caught;}expect(pgSqlState(error)).toBe('23514');
  }
  expect(await stored(r.actionId)).toMatchObject({bodyCount:1,employmentId:null});
 });
 it('records the actual composed ledger constraint size',async()=>{
  const [size]=await owner.db.execute<{bytes:number;constraints:number}>(sql`select sum(pg_column_size(conbin))::int as bytes,count(*)::int as constraints from pg_constraint where conrelid='app.assistant_own_leave_review'::regclass and contype='c'`);
  expect(size.bytes).toBeGreaterThan(0);expect(size.constraints).toBeGreaterThan(0);console.info('department-custody-ledger-constraint-size',JSON.stringify(size));
 });
 it('joins canonical actor privacy erasure without inventing department employee targets',async()=>{
  const hired=await hireEmployee(ctx,{person:{fullName:'Fictional Catalogue Author',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01'}),userId=await createAppUser(b.tenantId,hired.personId,'hr_admin');await grantAssistant(ctx,{appUserId:userId});
  const author={...ctx,userId,personId:hired.personId},r=(await reviews.prepare(author,intent())).review;
  await erasePersonPii(ctx,{subjectEmploymentId:hired.employmentId,scope:'contact',reason:'Fictional catalogue author request',requestRef:'FIC-DEPARTMENT-PRIVACY'});
  expect(await stored(r.actionId)).toMatchObject({state:'refused',bodyCount:0,employmentId:null,eventId:null});
 });
 it('refuses another company and tenant at choices/prepare',async()=>{
  expect(await departmentArchiveEntryAvailable(ctx)).toBe(true);const other=await seedBase();expect(await readDepartmentArchiveChoices(ctx,{query:'',departmentId:other.deptB})).toEqual({kind:'unavailable'});await expect(reviews.prepare(ctx,{...intent(),departmentId:other.deptB})).rejects.toThrow();
  const c=await createCompany(ctx,{legalName:'Fictional Other Scope',country:'MY',currency:'MYR'}),userId=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.update(schema.roleAssignment).set({companyId:c.id}).where(eq(schema.roleAssignment.appUserId,userId));await grantAssistant(ctx,{appUserId:userId});const otherCompany={...ctx,userId,grants:[{role:'hr_admin' as const,companyId:c.id}]};expect(await departmentArchiveEntryAvailable(otherCompany)).toBe(false);await expect(reviews.prepare(otherCompany,intent())).rejects.toThrow();
 });
});
