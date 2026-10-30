/** Actual child-role DELETE and private SQL custody. Authored for hosted migrated DB only. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import * as s from '../db/schema';
import {createConfig} from '../core/employee-id-config';
import {createEmployeeDraftWithReservedCode,discardEmployeeDraft,saveEmployeeDraft} from '../core/employee-draft';
import {hireEmployee} from '../core/org';
import {erasePersonPiiTx} from '../core/pdpa';
import {pgSqlState,pgErrorChain} from '../lib/db-error';
import {grantAssistant} from '../core/assistant-grant';
import {employeeDraftDiscardReviews} from '../core/assistant-actions/employee-draft-discard-review-store';
import {requireNativeOutcomeTargetsTx} from '../core/module-native-outcome-targets';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,entitledCtx,type Base} from './harness';
let b:Base,ctx:SessionContext;
const INTENT='a'.repeat(64),REVIEWED='b'.repeat(64),KID='0123456789abcdef';
type Source={draftId:string;companyId:string;companyName:string;label:string;reservedEmployeeCode:string|null;reservedNumber:number|null;sourceDigest:string;nativeRowDigest:string;xmin:string;ctid:string;counterBeforeDigest:string};
type Stored={metadata:{actionId:string;state:string;binding:{personId:string|null;draftId:string}};sealed:unknown;eventId:string|null;nativeOutcome:{kind:string;reservedEmployeeCode:string|null}|null};
async function command(tx:Tx,who:SessionContext,operation:string,id:string|null=null,draft:string|null=null,source:string|null=null,event:string|null=null){
 const [out]=await tx.execute<{value:unknown}>(sql`select app.assistant_employee_draft_discard_command(${operation},${id}::uuid,${who.personId??null}::uuid,${b.companyId}::uuid,${draft}::uuid,${INTENT},${REVIEWED},${KID},${'fictional-wrapped-key'},${'fictional-ciphertext'},${source},${event}::uuid) as value`);return out.value;
}
async function source(tx:Tx,draft:string,who=ctx){return await command(tx,who,'source',null,draft) as Source;}
async function prepare(draft:string,who=ctx){const id=randomUUID();await withTenant(who,async tx=>{const snapshot=await source(tx,draft,who);await command(tx,who,'prepare',id,draft,snapshot.sourceDigest);});return id;}
async function complete(tx:Tx,id:string,event:string,who=ctx){return await command(tx,who,'complete',id,null,null,event) as Stored;}
async function configured(){await createConfig(ctx,{companyId:b.companyId,prefix:'DP',startNumber:10,numberLength:4,increment:3,allowManualOverride:true});return createEmployeeDraftWithReservedCode(ctx,{companyId:b.companyId,fullName:'Fictional private draft',primaryEmail:randomUUID()+'@fixture.test'});}
async function plain(){return saveEmployeeDraft(ctx,{data:{profile:{fullName:'PRIVATE source input'},employment:{companyId:b.companyId}},currentStep:1});}
async function status(id:string){const [row]=await owner.db.execute<{state:string;bodies:number;source:unknown;stamp:unknown;arm:string|null}>(sql`select r.state,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) bodies,r.draft_discard_source source,r.draft_discard_delete_witness stamp,r.draft_discard_capture_xid::text arm from app.assistant_own_leave_review r where r.id=${id}::uuid`);return row;}
async function snapshot(){return{
 drafts:await owner.db.select().from(s.employeeDraft).where(eq(s.employeeDraft.tenantId,b.tenantId)).orderBy(s.employeeDraft.id),
 configs:await owner.db.select().from(s.employeeIdConfig).where(eq(s.employeeIdConfig.tenantId,b.tenantId)).orderBy(s.employeeIdConfig.id),
 counters:await owner.db.select().from(s.tenantCounter).where(eq(s.tenantCounter.tenantId,b.tenantId)).orderBy(s.tenantCounter.kind),
 events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id),
 reviews:await owner.db.execute(sql`select to_jsonb(r) value from app.assistant_own_leave_review r where tenant_id=${b.tenantId}::uuid order by id`),
 bodies:await owner.db.execute(sql`select c.* from app.assistant_own_leave_review_content c join app.assistant_own_leave_review r on r.id=c.action_id where r.tenant_id=${b.tenantId}::uuid order by c.action_id`),
};}
const linked=(tx:Tx,draft:string)=>tx.execute(sql`insert into lc_onboarding_case(tenant_id,company_id,source_draft_id,data) values(${b.tenantId}::uuid,${b.companyId}::uuid,${draft}::uuid,'{"version":1,"state":"cancelled","source":{},"tasks":[],"requisitions":[]}'::jsonb)`);
async function assertRefusal(work:Promise<unknown>,code?:string,message?:string){let error:unknown;try{await work;}catch(e){error=e;}expect(error).toBeDefined();if(code)expect(pgSqlState(error)).toBe(code);if(message)expect(pgErrorChain(error).some(link=>link.message===message)).toBe(true);}
/** Test-only owner probe sees this app transaction's uncommitted physical proof. It returns no
 * source/body values, is restricted to the actual current USER/tenant, and is removed in finally. */
type PhaseProof={stamped:boolean;draftAbsent:boolean;casePresent:boolean;stampRowXmin:string;parentXid:string;deleteXid:string|null;armXid:string|null;eventPresent:boolean;eventRowXmin:string|null};
async function withPhaseProbe(work:()=>Promise<void>){
 await owner.db.execute(sql`create function public.ai_discard_test_phase_probe(p_id uuid,p_event uuid) returns jsonb language sql security definer set search_path=pg_catalog,public,pg_temp as $$
  select pg_catalog.jsonb_build_object('stamped',r.draft_discard_delete_witness is not null,
   'draftAbsent',not exists(select 1 from public.employee_draft d where d.id=r.receipt_subject_id and d.tenant_id=r.tenant_id),
   'casePresent',exists(select 1 from public.lc_onboarding_case c where c.source_draft_id=r.receipt_subject_id and c.tenant_id=r.tenant_id),
   'stampRowXmin',r.xmin::text,'parentXid',pg_catalog.pg_current_xact_id()::xid::text,
   'deleteXid',r.draft_discard_delete_xid::xid::text,'armXid',r.draft_discard_capture_xid::xid::text,
   'eventPresent',exists(select 1 from public.domain_event e where e.id=p_event and e.tenant_id=r.tenant_id and e.actor_id=r.user_id and e.actor_type='user' and e.aggregate_type='employee-draft' and e.aggregate_id=r.receipt_subject_id and e.event_type='employee-draft.discarded'),
   'eventRowXmin',(select e.xmin::text from public.domain_event e where e.id=p_event and e.tenant_id=r.tenant_id))
  from app.assistant_own_leave_review r where r.id=p_id and r.tenant_id=app.current_tenant_id() and r.user_id=app.current_user_id()
 $$`);
 try{await owner.db.execute(sql`revoke all on function public.ai_discard_test_phase_probe(uuid,uuid) from public`);await owner.db.execute(sql`grant execute on function public.ai_discard_test_phase_probe(uuid,uuid) to ai_hr_app`);await work();}finally{await owner.db.execute(sql`drop function public.ai_discard_test_phase_probe(uuid,uuid)`);}
}
async function phaseProof(tx:Tx,id:string,event:string|null=null){const [row]=await tx.execute<{value:PhaseProof}>(sql`select public.ai_discard_test_phase_probe(${id}::uuid,${event}::uuid) value`);expect(row.value).not.toBeNull();return row.value;}
function expectChildProof(proof:PhaseProof){expect(proof).toMatchObject({stamped:true,draftAbsent:true,eventPresent:true});expect(proof.deleteXid).toBe(proof.parentXid);expect(proof.armXid).toBe(proof.parentXid);expect(proof.stampRowXmin).not.toBe(proof.parentXid);expect(proof.eventRowXmin).not.toBe(proof.parentXid);}
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);await setModule(b.tenantId,'lifecycle',null);});

it('uses a non-table-owner child with inherited app RLS and no login/bypass/role-management authority',async()=>{
 const [row]=await owner.db.execute<{login:boolean;super:boolean;bypass:boolean;createRole:boolean;owns:boolean;inherits:boolean;reverse:boolean;setChild:boolean;appRaw:boolean;childSourceWrite:boolean;childStampWrite:boolean;content:boolean;createApp:boolean}>(sql`select c.rolcanlogin login,c.rolsuper super,c.rolbypassrls bypass,c.rolcreaterole "createRole",exists(select 1 from pg_class t where t.oid in ('employee_draft'::regclass,'app.assistant_own_leave_review'::regclass) and t.relowner=c.oid) owns,pg_has_role(c.oid,'ai_hr_app','USAGE') inherits,pg_has_role('ai_hr_app',c.oid,'MEMBER') reverse,pg_has_role('ai_hr_app',c.oid,'SET') "setChild",has_table_privilege('ai_hr_app','app.assistant_own_leave_review','SELECT') "appRaw",has_column_privilege(c.oid,'app.assistant_own_leave_review','draft_discard_source','UPDATE') "childSourceWrite",has_column_privilege(c.oid,'app.assistant_own_leave_review','draft_discard_delete_witness','UPDATE') "childStampWrite",has_column_privilege(c.oid,'app.assistant_own_leave_review_content','ciphertext','SELECT') content,has_schema_privilege(c.oid,'app','CREATE') "createApp" from pg_roles c where c.rolname='ai_hr_draft_discard_port'`);
 expect(row).toEqual({login:false,super:false,bypass:false,createRole:false,owns:false,inherits:true,reverse:false,setChild:false,appRaw:false,childSourceWrite:false,childStampWrite:true,content:false,createApp:false});
 await assertRefusal(withTenant(ctx,tx=>tx.execute(sql`set local role ai_hr_draft_discard_port`)),'42501');
 await assertRefusal(withTenant(ctx,tx=>tx.execute(sql`select * from app.assistant_own_leave_review`)),'42501');
 await assertRefusal(withTenant(ctx,tx=>tx.execute(sql`select app._draft_discard_source_snapshot(${randomUUID()}::uuid,${b.companyId}::uuid)`)),'42501');
});
it('captures only actual SQL-owned source/version metadata and refuses caller-supplied source digests',async()=>{
 const d=await plain(),before=await snapshot();
 await withTenant(ctx,async tx=>{const v=await source(tx,d.id);expect(Object.keys(v).sort()).toEqual(['companyId','companyName','counterBeforeDigest','ctid','draftId','label','nativeRowDigest','reservedEmployeeCode','reservedNumber','sourceDigest','xmin'].sort());expect(v.sourceDigest).toMatch(/^[a-f0-9]{64}$/);});
 await assertRefusal(withTenant(ctx,tx=>command(tx,ctx,'prepare',randomUUID(),d.id,'0'.repeat(64))),'22023');expect(await snapshot()).toEqual(before);
 const id=await prepare(d.id),r=await status(id);expect(JSON.stringify(r.source)).not.toContain('PRIVATE source input');expect(r.stamp).toBeNull();expect(r.bodies).toBe(1);
});
it.each(['numeric','compressed','oversize'] as const)('hands the %s private source off but ordinary native GUI deletion still succeeds',async mode=>{
 const d=await plain();const data=mode==='numeric'?{profile:{value:1e100}}:mode==='compressed'?{private:'PRIVATE'.repeat(10000)}:{private:Array.from({length:16000},()=>randomUUID()).join('')};
 await owner.db.update(s.employeeDraft).set({data:data as never}).where(eq(s.employeeDraft.id,d.id));
 await assertRefusal(withTenant(ctx,tx=>source(tx,d.id)),'54000');expect((await snapshot()).reviews).toEqual([]);
 await discardEmployeeDraft(ctx,d.id);expect((await snapshot()).drafts).toEqual([]);
});
it('ordinary GUI deletion skips an old review arm and retires all pending custody without a discard proof',async()=>{
 const d=await plain(),id=await prepare(d.id);await withTenant(ctx,async tx=>{await discardEmployeeDraft(ctx,d.id,tx);const r=await command(tx,ctx,'read',id) as Stored;expect(r.metadata.state).toBe('awaiting_confirmation');expect(r.sealed).not.toBeNull();});
 expect(await status(id)).toMatchObject({state:'discarded',bodies:0,source:null,stamp:null,arm:null});
});
it('ordinary GUI retains native linked-case semantics after an old review, while current-TX armed capture refuses a new same-TX case',async()=>{
 const d=await plain(),id=await prepare(d.id);await owner.db.transaction(tx=>linked(tx,d.id));await discardEmployeeDraft(ctx,d.id);expect(await status(id)).toMatchObject({state:'discarded',bodies:0,stamp:null});
 const second=await plain(),review=await prepare(second.id),before=await snapshot();let inserted=false,portAttempted=false;
 await withPhaseProbe(async()=>{await assertRefusal(withTenant(ctx,async tx=>{await source(tx,second.id);await linked(tx,second.id);const proof=await phaseProof(tx,review);expect(proof.casePresent).toBe(true);expect(proof.stamped).toBe(false);inserted=true;portAttempted=true;await discardEmployeeDraft(ctx,second.id,tx,{returnResult:true});}),'42501','Draft discard unavailable');});
 expect({inserted,portAttempted}).toEqual({inserted:true,portAttempted:true});expect(await snapshot()).toEqual(before);expect(await status(review)).toMatchObject({state:'awaiting_confirmation',stamp:null});
});
it('direct SQL source/prepare cannot bypass the canonical linked-case helper',async()=>{
 const d=await plain();await owner.db.transaction(tx=>linked(tx,d.id));const before=await snapshot();await assertRefusal(withTenant(ctx,tx=>source(tx,d.id)),'42501');await assertRefusal(withTenant(ctx,tx=>command(tx,ctx,'prepare',randomUUID(),d.id,INTENT)),'42501');expect(await snapshot()).toEqual(before);
});
it('proves a top-level actual native deletion, tip release and exact event, then reopens without freezing later counters',async()=>{
 const d=await configured(),id=await prepare(d.id);let event='';
 const done=await withTenant(ctx,async tx=>{await source(tx,d.id);const native=await discardEmployeeDraft(ctx,d.id,tx,{returnResult:true});event=native.eventId;return complete(tx,id,event);});
 expect(done).toMatchObject({metadata:{state:'completed'},sealed:null,eventId:event,nativeOutcome:{kind:'released_tip',reservedEmployeeCode:d.employeeCode}});expect(await status(id)).toMatchObject({state:'completed',bodies:0});
 await createEmployeeDraftWithReservedCode(ctx,{companyId:b.companyId,fullName:'Later reservation',primaryEmail:randomUUID()+'@fixture.test'});
 expect(await withTenant(ctx,tx=>command(tx,ctx,'read',id))).toEqual(done);expect(await withTenant(ctx,tx=>complete(tx,id,event))).toEqual(done);
});
it.each(['no_reservation','unreserved_code','retained_gap'] as const)('proves the exact native %s outcome without an invented counter change',async kind=>{
 let d:{id:string;employeeCode?:string};
 if(kind==='retained_gap'){d=await configured();await createEmployeeDraftWithReservedCode(ctx,{companyId:b.companyId,fullName:'Later held code',primaryEmail:randomUUID()+'@fixture.test'});}
 else if(kind==='unreserved_code')d=await createEmployeeDraftWithReservedCode(ctx,{companyId:b.companyId,fullName:'Manual',primaryEmail:randomUUID()+'@fixture.test',employeeIdMode:'manual',employeeCode:'MANUAL-PORT'});
 else d=await plain();
 const id=await prepare(d.id);const done=await withTenant(ctx,async tx=>{await source(tx,d.id);const native=await discardEmployeeDraft(ctx,d.id,tx,{returnResult:true});return complete(tx,id,native.eventId);});expect(done.nativeOutcome).toEqual({kind,reservedEmployeeCode:kind==='no_reservation'?null:d.employeeCode});
});
it('refuses raw activation-style DELETE plus a forged same-TX discard event: actual port stamp is mandatory',async()=>{
 const d=await plain(),id=await prepare(d.id),before=await snapshot();let deleted=false,eventCreated=false,completeAttempted=false;
 await withPhaseProbe(async()=>{await assertRefusal(withTenant(ctx,async tx=>{await source(tx,d.id);const removed=await tx.delete(s.employeeDraft).where(eq(s.employeeDraft.id,d.id)).returning({id:s.employeeDraft.id});expect(removed).toEqual([{id:d.id}]);deleted=true;const event=await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'employee-draft',aggregateId:d.id,eventType:'employee-draft.discarded',actor:actorOf(ctx),payload:{}},{returnId:true});const proof=await phaseProof(tx,id,event);expect(proof).toMatchObject({stamped:false,draftAbsent:true,eventPresent:true});expect(proof.eventRowXmin).toBe(proof.parentXid);eventCreated=true;completeAttempted=true;await complete(tx,id,event);}),'42501','Draft discard proof unavailable');});
 expect({deleted,eventCreated,completeAttempted}).toEqual({deleted:true,eventCreated:true,completeAttempted:true});expect(await snapshot()).toEqual(before);
});
it('refuses a released child-savepoint actual DELETE and a later attempt to re-arm its missing source',async()=>{
 const d=await plain(),id=await prepare(d.id),before=await snapshot();let childWitness=false,completeAttempted=false;
 await withPhaseProbe(async()=>{await assertRefusal(withTenant(ctx,async tx=>{await source(tx,d.id);const native=await tx.transaction(inner=>discardEmployeeDraft(ctx,d.id,inner,{returnResult:true}));expectChildProof(await phaseProof(tx,id,native.eventId));childWitness=true;completeAttempted=true;await complete(tx,id,native.eventId);}),'42501','Draft discard proof unavailable');});
 expect({childWitness,completeAttempted}).toEqual({childWitness:true,completeAttempted:true});expect(await snapshot()).toEqual(before);
 let retainedChildWitness=false,rearmAttempted=false;
 await withPhaseProbe(async()=>{await assertRefusal(withTenant(ctx,async tx=>{await source(tx,d.id);const native=await tx.transaction(inner=>discardEmployeeDraft(ctx,d.id,inner,{returnResult:true}));expectChildProof(await phaseProof(tx,id,native.eventId));retainedChildWitness=true;rearmAttempted=true;await command(tx,ctx,'source',null,d.id);}),'42501','Draft discard unavailable');});
 expect({retainedChildWitness,rearmAttempted}).toEqual({retainedChildWitness:true,rearmAttempted:true});expect(await snapshot()).toEqual(before);
});
it('same-XID draft updates invalidate ctid even though xmin alone would still match',async()=>{
 const d=await plain(),id=await prepare(d.id),before=await snapshot();await assertRefusal(withTenant(ctx,async tx=>{const v=await source(tx,d.id);await tx.update(s.employeeDraft).set({label:'Changed same transaction'}).where(eq(s.employeeDraft.id,d.id));const [now]=await tx.execute<{xmin:string;ctid:string}>(sql`select xmin::text,ctid::text from employee_draft where id=${d.id}::uuid`);expect(now.ctid).not.toBe(v.ctid);const native=await discardEmployeeDraft(ctx,d.id,tx,{returnResult:true});await complete(tx,id,native.eventId);}),'42501');expect(await snapshot()).toEqual(before);
});
it('missing and wrong-payload events cannot complete or consume the pending body',async()=>{
 const d=await configured(),id=await prepare(d.id),before=await snapshot();await assertRefusal(withTenant(ctx,async tx=>{await source(tx,d.id);await tx.execute(sql`select id from app.native_employee_draft_discard_delete(${d.id}::uuid)`);const fake=await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'employee-draft',aggregateId:d.id,eventType:'employee-draft.discarded',actor:actorOf(ctx),payload:{reservedEmployeeCode:d.employeeCode,released:false}},{returnId:true});await complete(tx,id,fake);}),'42501');expect(await snapshot()).toEqual(before);
 await assertRefusal(withTenant(ctx,tx=>complete(tx,id,randomUUID())),'42501');expect(await snapshot()).toEqual(before);
});
it('canonical privacy clears a completed bodyless proof, preserves original actor binding and requires its real audit',async()=>{
 const actor=await hireEmployee(ctx,{person:{fullName:'Fictional proof actor',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'}),userId=await createAppUser(b.tenantId,actor.personId,'hr_admin'),who={...ctx,userId,personId:actor.personId};
 const d=await plain(),id=await prepare(d.id,who);await withTenant(who,async tx=>{await source(tx,d.id,who);const native=await discardEmployeeDraft(who,d.id,tx,{returnResult:true});await complete(tx,id,native.eventId,who);});expect(await status(id)).toMatchObject({state:'completed',bodies:0});
 const before=await snapshot();await assertRefusal(withTenant(ctx,async tx=>{await tx.execute(sql`select app.home_greeting_erasure_begin(${actor.employmentId}::uuid,'contact','fictional-proof-erasure','Fictional reason')`);await tx.execute(sql`select app.assistant_own_leave_reviews_redact(${actor.employmentId}::uuid)`);}),'42501');expect(await snapshot()).toEqual(before);
 await withTenant(ctx,tx=>erasePersonPiiTx(tx,ctx,{subjectEmploymentId:actor.employmentId,scope:'contact',requestRef:'fictional-proof-erasure',reason:'Fictional reason'}));expect(await status(id)).toMatchObject({state:'completed',bodies:0,source:null,stamp:null,arm:null});await assertRefusal(withTenant(who,tx=>command(tx,who,'read',id)),'42501');
});
it('ordinary native captures retain non-increasing bounds through the actual enclosing transaction',async()=>{
 const d=await plain();await withTenant(ctx,async tx=>{await tx.execute(sql`set local lock_timeout='100ms'`);await discardEmployeeDraft(ctx,d.id,tx);const [settings]=await tx.execute<{lock:string;statement:string}>(sql`select current_setting('lock_timeout') lock,current_setting('statement_timeout') statement`);expect(settings.lock).toBe('100ms');expect(settings.statement).toBe('5s');});
});

it.each([false,true])('real completed-outcome reader and learning privacy capture support actor PERSON linked=%s',async linkedActor=>{
 await setModule(b.tenantId,'assistant','active');
 const person=linkedActor?await hireEmployee(ctx,{person:{fullName:'Fictional linked outcome actor',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'}):null;
 const userId=await createAppUser(b.tenantId,person?.personId??null,'hr_admin');await grantAssistant(ctx,{appUserId:userId});
 const who:SessionContext={...await entitledCtx(b,['hr_admin']),userId,personId:person?.personId??null,grants:[{role:'hr_admin',companyId:null}]};
 const d=await plain(),input={action:'employees.draft.discard',contractVersion:1,draftId:d.id,companyId:b.companyId,consent:'discard_saved_draft_captured_input'};
 const prepared=(await employeeDraftDiscardReviews.prepare(who,input)).review;
 const done=await employeeDraftDiscardReviews.confirm(who,{action:'employees.draft.discard',contractVersion:1,draftId:d.id,companyId:b.companyId,actionId:prepared.actionId,reviewedDigest:prepared.reviewedDigest,consent:'discard_saved_draft_captured_input'});
 expect(done.kind).toBe('completed');if(done.kind!=='completed')throw Error('Expected actual completed native receipt');
 const eventId=done.receipt.receipt.eventId;
 await withTenant(who,async tx=>{
  const completed=await employeeDraftDiscardReviews.readCompletedOutcomeTx(tx,who,prepared.actionId);expect(completed.eventId).toBe(eventId);expect(completed.completion).toEqual(done);
  await requireNativeOutcomeTargetsTx(tx,who,{action:'employees.draft.discard',sourceId:prepared.actionId,eventId});
  const [choices]=await tx.execute<{action:string;action_id:string}>(sql`select action,action_id from app.native_outcome_completed_review_choices('["employees.draft.discard"]'::jsonb)`);expect(choices).toEqual({action:'employees.draft.discard',action_id:prepared.actionId});
 });
 const [capture]=await owner.db.execute<{person:string|null;targets:number}>(sql`select person_id person,target_count targets from app.native_outcome_source_capture where source_id=${prepared.actionId}::uuid and action='employees.draft.discard'`);
 expect(capture).toEqual({person:person?.personId??null,targets:linkedActor?1:0});
});
it('a native author after company grant loss still reviews a non-tip gap, while native tip release keeps its own company CHECK',async()=>{
 const [author]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional retained draft author',primaryEmail:randomUUID()+'@fixture.test'}).returning({id:s.person.id});
 const userId=await createAppUser(b.tenantId,author.id,'hr_admin'),initial={...ctx,userId,personId:author.id},d=await configured();
 await owner.db.update(s.employeeDraft).set({createdByPersonId:author.id}).where(eq(s.employeeDraft.id,d.id));
 const later=await createEmployeeDraftWithReservedCode(ctx,{companyId:b.companyId,fullName:'Later held reservation',primaryEmail:randomUUID()+'@fixture.test'});
 const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional other HR scope'}).returning({id:s.company.id});
 await owner.db.update(s.roleAssignment).set({companyId:other.id}).where(eq(s.roleAssignment.appUserId,userId));const lost={...initial,grants:[{role:'hr_admin',companyId:other.id}]};
 const id=await prepare(d.id,lost);const done=await withTenant(lost,async tx=>{await source(tx,d.id,lost);const native=await discardEmployeeDraft(lost,d.id,tx,{returnResult:true});return complete(tx,id,native.eventId,lost);});expect(done.nativeOutcome?.kind).toBe('retained_gap');
 await owner.db.update(s.employeeDraft).set({createdByPersonId:author.id}).where(eq(s.employeeDraft.id,later.id));const tip=await prepare(later.id,lost),before=await snapshot();await assertRefusal(withTenant(lost,async tx=>{await source(tx,later.id,lost);await discardEmployeeDraft(lost,later.id,tx,{returnResult:true});}),'42501');expect(await snapshot()).toEqual(before);expect(await status(tip)).toMatchObject({state:'awaiting_confirmation',stamp:null});
});
it('capture deadline crossing refuses completion and rolls back the already attempted native effect',async()=>{
 const d=await plain(),id=await prepare(d.id);await owner.db.execute(sql`update app.assistant_own_leave_review set expires_at=clock_timestamp()+interval '1 second' where id=${id}::uuid`);const before=await snapshot();
 await assertRefusal(withTenant(ctx,async tx=>{await source(tx,d.id);const native=await discardEmployeeDraft(ctx,d.id,tx,{returnResult:true});expect(native.eventId).toMatch(/^[a-f0-9-]{36}$/);await tx.execute(sql`select pg_sleep(1.1)`);await complete(tx,id,native.eventId);}),'42501');expect(await snapshot()).toEqual(before);
});
it('a matching historical event cannot adopt a current actual port DELETE stamp',async()=>{
 const d=await plain(),id=await prepare(d.id),oldEvent=await withTenant(ctx,tx=>appendEvent(tx,{tenantId:b.tenantId,aggregateType:'employee-draft',aggregateId:d.id,eventType:'employee-draft.discarded',actor:actorOf(ctx),payload:{}},{returnId:true})),before=await snapshot();let currentProof=false,historicalProof=false,completeAttempted=false;
 await withPhaseProbe(async()=>{await assertRefusal(withTenant(ctx,async tx=>{await source(tx,d.id);const native=await discardEmployeeDraft(ctx,d.id,tx,{returnResult:true});expect(native.eventId).not.toBe(oldEvent);const actual=await phaseProof(tx,id,native.eventId);expect(actual).toMatchObject({stamped:true,draftAbsent:true,eventPresent:true});expect(actual.stampRowXmin).toBe(actual.parentXid);expect(actual.eventRowXmin).toBe(actual.parentXid);currentProof=true;const old=await phaseProof(tx,id,oldEvent);expect(old.eventPresent).toBe(true);expect(old.eventRowXmin).not.toBe(old.parentXid);historicalProof=true;completeAttempted=true;await complete(tx,id,oldEvent);}),'42501','Draft discard proof unavailable');});
 expect({currentProof,historicalProof,completeAttempted}).toEqual({currentProof:true,historicalProof:true,completeAttempted:true});expect(await snapshot()).toEqual(before);
});
it('the invoker guard rejects an actual owner-context no-op UPDATE before it can wash child stamp xmin',async()=>{
 const d=await plain(),id=await prepare(d.id),before=await snapshot();let actualChildWitness=false,ownerUpdateAttempted=false;
 await owner.db.execute(sql`create function public.ai_discard_test_owner_noop(p_id uuid) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin update app.assistant_own_leave_review set state=state,draft_discard_capture_xid=pg_catalog.pg_current_xact_id() where id=p_id;end$$`);
 try{await owner.db.execute(sql`revoke all on function public.ai_discard_test_owner_noop(uuid) from public`);await owner.db.execute(sql`grant execute on function public.ai_discard_test_owner_noop(uuid) to ai_hr_app`);
  await withPhaseProbe(async()=>{await assertRefusal(withTenant(ctx,async tx=>{await source(tx,d.id);const native=await tx.transaction(inner=>discardEmployeeDraft(ctx,d.id,inner,{returnResult:true}));expectChildProof(await phaseProof(tx,id,native.eventId));actualChildWitness=true;ownerUpdateAttempted=true;await tx.execute(sql`select public.ai_discard_test_owner_noop(${id}::uuid)`);}),'42501','Pending witness immutable');});
  expect({actualChildWitness,ownerUpdateAttempted}).toEqual({actualChildWitness:true,ownerUpdateAttempted:true});expect(await snapshot()).toEqual(before);
 }finally{await owner.db.execute(sql`drop function public.ai_discard_test_owner_noop(uuid)`);}
});
it('schema-owner SQL cannot forge a pending deletion witness without the actual restricted child DELETE',async()=>{
 const d=await plain(),id=await prepare(d.id),before=await snapshot();await assertRefusal(owner.db.execute(sql`update app.assistant_own_leave_review set draft_discard_delete_witness=jsonb_build_object('rowDigest',draft_discard_source->>'rowDigest','admittedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),draft_discard_delete_xid=pg_current_xact_id() where id=${id}::uuid`),'42501');expect(await snapshot()).toEqual(before);
});
it('public more-specific to_jsonb overload cannot hijack the child source counter serializer',async()=>{
 const d=await configured();await owner.db.execute(sql`create function public.to_jsonb(public.employee_id_config) returns jsonb language plpgsql immutable as $$begin raise exception 'public polymorphic overload poison';end$$`);
 try{await withTenant(ctx,async tx=>{const actual=await source(tx,d.id);expect(actual.draftId).toBe(d.id);expect(actual.counterBeforeDigest).toMatch(/^[a-f0-9]{64}$/);});}finally{await owner.db.execute(sql`drop function public.to_jsonb(public.employee_id_config)`);}
});
it('normal deferred completion proof rejects a later same-transaction counter mutation and rolls everything back',async()=>{
 const d=await configured(),id=await prepare(d.id),before=await snapshot();await assertRefusal(withTenant(ctx,async tx=>{await source(tx,d.id);const native=await discardEmployeeDraft(ctx,d.id,tx,{returnResult:true});await complete(tx,id,native.eventId);await tx.update(s.employeeIdConfig).set({currentRunningNumber:999}).where(eq(s.employeeIdConfig.companyId,b.companyId));}),'42501');expect(await snapshot()).toEqual(before);
});
it('role loss leaves raw native author DELETE rights intact but cannot stamp or prepare an old HR review',async()=>{
 const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional role-loss author',primaryEmail:randomUUID()+'@fixture.test'}).returning({id:s.person.id}),userId=await createAppUser(b.tenantId,person.id,'hr_admin'),who={...ctx,userId,personId:person.id},d=await plain();await owner.db.update(s.employeeDraft).set({createdByPersonId:person.id}).where(eq(s.employeeDraft.id,d.id));const id=await prepare(d.id,who);
 await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,userId));const employee={...who,roles:['employee'],grants:[{role:'employee',companyId:null}]};await assertRefusal(withTenant(employee,tx=>source(tx,d.id,employee)),'42501');await expect(discardEmployeeDraft(employee,d.id)).rejects.toThrow('Only an admin');
 await withTenant(employee,async tx=>{const deleted=await tx.execute<{id:string}>(sql`select id from app.native_employee_draft_discard_delete(${d.id}::uuid)`);expect(deleted).toEqual([{id:d.id}]);});expect(await status(id)).toMatchObject({state:'discarded',source:null,stamp:null,arm:null,bodies:0});
});
