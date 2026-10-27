/** Authored UNRUN. Requires the complete normally installed coordinated native-outcome migration.
 * Raw fictional storage fixtures test expiry, RLS, FK and admitted privacy cleanup ONLY. They never
 * establish canonical action provenance, consent, job execution, quality or benefit. Actual native
 * source capture is exercised separately by canonical owner/association suites. No live provider. */
import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type Tx} from '../db/client';
import {hireEmployee} from '../core/org';
import {erasePersonPii} from '../core/pdpa';
import {retireExpiredAiCustodyTx} from '../core/ai-retention-maintenance';
import {runAiRetentionTick} from '../scripts/ai-retention-runner';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();});
const zero={reviews:0,feedback:0,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0,importEvaluations:0,nativeOutcomes:0,nativeSources:0};
const receipt='fictional-storage-only-not-canonical-proof';
async function storageJob(b=base){const id=randomUUID();await owner.db.execute(sql`insert into public.ai_agent_job_receipt(id,tenant_id,user_id,request_nonce,requested_plan_digest,expires_at,receipt) values(${id}::uuid,${b.tenantId}::uuid,${b.adminUserId}::uuid,${randomUUID()}::uuid,${'a'.repeat(64)},now()+interval '1 day',${receipt})`);return id;}
async function storageCapture(options:{b?:Base;expired?:boolean;targets?:readonly {kind:'person'|'employment';id:string}[]}={}){
 const b=options.b??base,id=randomUUID(),review=randomUUID(),event=randomUUID(),targets=options.targets??[];
 await owner.db.transaction(async tx=>{
  await tx.execute(sql`insert into public.domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) values(${event}::uuid,${b.tenantId}::uuid,'fictional-custody',${randomUUID()}::uuid,'fictional-custody.created','user',${b.adminUserId}::uuid,'{}'::jsonb)`);
  await tx.execute(sql`insert into app.assistant_own_leave_review(id,action_kind,tenant_id,user_id,state,pay_component_id,pay_component_created_event_id,created_at,expires_at) values(${review}::uuid,'typed_pay_components.create',${b.tenantId}::uuid,${b.adminUserId}::uuid,'completed',${randomUUID()}::uuid,${event}::uuid,now(),now()+interval '10 minutes')`);
  await tx.execute(sql`insert into app.native_outcome_source_capture(id,tenant_id,user_id,action,source_id,source_kind,review_id,event_id,target_count,created_at,expires_at) values(${id}::uuid,${b.tenantId}::uuid,${b.adminUserId}::uuid,'typed_pay_components.create',${review}::uuid,'review',${review}::uuid,${event}::uuid,${targets.length},case when ${options.expired??false} then now()-interval '31 days' else now() end,case when ${options.expired??false} then now()-interval '1 day' else now()+interval '1 day' end)`);
  for(const target of targets)await tx.execute(sql`insert into app.native_outcome_source_target(capture_id,kind,target_id) values(${id}::uuid,${target.kind},${target.id}::uuid)`);
 });return{id,review,event,b};
}
async function storageAssociation(source:Awaited<ReturnType<typeof storageCapture>>,job:string,expired:boolean){const id=randomUUID();
 await withTenant(adminCtx(source.b),tx=>tx.execute(sql`insert into public.ai_native_outcome_association(id,tenant_id,user_id,job_id,request_nonce,request_digest,action,source_kind,review_id,event_id,native_digest,job_receipt_digest,receipt,consented,created_at,expires_at) values(${id}::uuid,${source.b.tenantId}::uuid,${source.b.adminUserId}::uuid,${job}::uuid,${randomUUID()}::uuid,${'a'.repeat(64)},'typed_pay_components.create','review',${source.review}::uuid,${source.event}::uuid,${'b'.repeat(64)},${createHash('sha256').update(receipt).digest('hex')},${receipt},true,case when ${expired} then now()-interval '31 days' else now() end,case when ${expired} then now()-interval '1 day' else now()+interval '1 hour' end)`));return id;}
async function counts(){const [row]=await owner.db.execute<{sources:number;targets:number;associations:number}>(sql`select(select count(*)::integer from app.native_outcome_source_capture) as sources,(select count(*)::integer from app.native_outcome_source_target) as targets,(select count(*)::integer from public.ai_native_outcome_association) as associations`);return row;}
async function subject(){return hireEmployee(adminCtx(base),{person:{fullName:'Fictional private outcome subject',primaryEmail:randomUUID()+'@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});}
async function heldNative(user:string,callback:()=>Promise<void>){let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(yes=>{entered=yes;}),done=new Promise<void>(yes=>{release=yes;});const holder=owner.db.transaction(async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'native-outcome:v1:'+base.tenantId+':'+user},0))`);entered();await done;});try{await ready;await callback();}finally{release();await holder;}}
describe('bounded private native outcome retention',()=>{
 it('retires 101 expired append/delete-only associations in two ticks without UPDATE ownership or touching active captures/native receipts',async()=>{
  const job=await storageJob(),ids:string[]=[];for(let i=0;i<101;i++)ids.push(await storageAssociation(await storageCapture(),job,true));
  const before=await counts(),first=await runAiRetentionTick(owner);expect(first).toMatchObject({...zero,tenants:1,busy:0,nativeOutcomes:100,backlog:true});expect(first.oldestExpiredAgeSeconds).toBeGreaterThan(0);
  expect(await counts()).toEqual({...before,associations:1});expect(await runAiRetentionTick(owner)).toEqual({...zero,tenants:1,busy:0,nativeOutcomes:1,backlog:false,oldestExpiredAgeSeconds:null});
  const [reviews]=await owner.db.execute<{n:number}>(sql`select count(*)::integer as n from app.assistant_own_leave_review`);expect(reviews.n).toBe(101);expect((await counts()).sources).toBe(101);
  for(const id of ids)expect(JSON.stringify(first)).not.toContain(id);
 });
 it('retires 101 expired source captures and their private target children in two ticks, counting direct deletion only',async()=>{
  const target=await subject();for(let i=0;i<101;i++)await storageCapture({expired:true,targets:[{kind:'person',id:target.personId}]});
  expect(await runAiRetentionTick(owner)).toMatchObject({...zero,tenants:1,busy:0,nativeSources:100,backlog:true});expect(await counts()).toEqual({sources:1,targets:1,associations:0});
  expect(await runAiRetentionTick(owner)).toEqual({...zero,tenants:1,busy:0,nativeSources:1,backlog:false,oldestExpiredAgeSeconds:null});expect(await counts()).toEqual({sources:0,targets:0,associations:0});
 });
 it('processes ten oldest real tenant queues then reports the eleventh backlog, without tenant echoes',async()=>{
  for(let i=0;i<11;i++){const b=i===0?base:await seedBase();await storageCapture({b,expired:true});}
  const first=await runAiRetentionTick(owner);expect(first).toMatchObject({...zero,tenants:10,busy:0,nativeSources:10,backlog:true});expect((await counts()).sources).toBe(1);
  expect(await runAiRetentionTick(owner)).toMatchObject({...zero,tenants:1,busy:0,nativeSources:1,backlog:false});expect(JSON.stringify(first)).not.toContain(base.tenantId);
 });
 it('rejects app-role maintenance and private target reads, retains shorter timeouts, and rolls real busy custody refusal back before later success',async()=>{
  await storageCapture({expired:true});const before=await counts();await expect(withTenant(adminCtx(base),tx=>retireExpiredAiCustodyTx(tx))).rejects.toThrow('AI retention maintenance could not be confirmed');
  await expect(withTenant(adminCtx(base),tx=>tx.execute(sql`select * from app.native_outcome_source_target`))).rejects.toThrow();
  await owner.db.transaction(async tx=>{await tx.execute(sql`set local statement_timeout='900ms'`);await tx.execute(sql`set local lock_timeout='90ms'`);await retireExpiredAiCustodyTx(tx as unknown as Tx);const bounds=await tx.execute<{name:string;setting:string}>(sql`select name,setting from pg_settings where name in('statement_timeout','lock_timeout') order by name`);expect(bounds).toEqual([{name:'lock_timeout',setting:'90'},{name:'statement_timeout',setting:'900'}]);throw Error('retention bound rollback');}).catch(error=>{expect(String(error)).toContain('retention bound rollback');});
  expect(await counts()).toEqual(before);
  await heldNative(base.adminUserId,async()=>{const start=Date.now();await expect(runAiRetentionTick(owner)).rejects.toThrow('AI retention maintenance could not be confirmed');expect(Date.now()-start).toBeLessThan(4500);expect(await counts()).toEqual(before);});
  expect(await runAiRetentionTick(owner)).toMatchObject({nativeSources:1,backlog:false});
 });
 it('bounds an actual physical association row wait and rolls back, then retires after holder release',async()=>{
  const job=await storageJob(),source=await storageCapture(),association=await storageAssociation(source,job,true),before=await counts();
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(yes=>{entered=yes;}),done=new Promise<void>(yes=>{release=yes;});
  // No advisory/Access holder: only the real DELETE target row is held.
  const holder=owner.db.transaction(async tx=>{const rows=await tx.execute(sql`select id from public.ai_native_outcome_association where id=${association}::uuid for update`);expect(rows).toHaveLength(1);entered();await done;});
  try{await ready;const start=Date.now();await expect(runAiRetentionTick(owner)).rejects.toThrow('AI retention maintenance could not be confirmed');expect(Date.now()-start).toBeLessThan(4500);expect(await counts()).toEqual(before);}
  finally{release();await holder;}
  expect(await runAiRetentionTick(owner)).toMatchObject({nativeOutcomes:1,nativeSources:0,backlog:false});
 });
 it('rolls all earlier direct retirement back on an injected later source DELETE trigger failure',async()=>{
  const source=await storageCapture({expired:true}),before=await counts();const name='fixture_native_retention_'+randomUUID().replaceAll('-','');
  await owner.db.execute(sql`create function public.${sql.identifier(name)}() returns trigger language plpgsql as $$ begin raise exception 'fictional source deletion failure'; end $$`);
  await owner.db.execute(sql`create trigger ${sql.identifier(name)} before delete on app.native_outcome_source_capture for each row execute function public.${sql.identifier(name)}()`);
  try{await expect(runAiRetentionTick(owner)).rejects.toThrow('AI retention maintenance could not be confirmed');expect(await counts()).toEqual(before);}
  finally{await owner.db.execute(sql`drop trigger ${sql.identifier(name)} on app.native_outcome_source_capture`);await owner.db.execute(sql`drop function public.${sql.identifier(name)}()`);}
  expect(await runAiRetentionTick(owner)).toMatchObject({nativeSources:1});expect(source.id).toBeTruthy();
 });
});
describe('admitted native outcome learning privacy cleanup',()=>{
 it("erases an HR actor's links about a different subject and exact original PERSON after relink, preserving unrelated learning and native receipts",async()=>{
  const original=await subject(),other=await subject(),job=await storageJob();
  const affected=await storageCapture({targets:[{kind:'person',id:original.personId},{kind:'employment',id:original.employmentId}]}),unrelated=await storageCapture({targets:[{kind:'person',id:other.personId}]});
  await storageAssociation(affected,job,false);const keep=await storageAssociation(unrelated,job,false);
  // Deliberate storage-level relink adversary; original effect-time PERSON remains in the index.
  await owner.db.execute(sql`update public.employment set person_id=${other.personId}::uuid where id=${original.employmentId}::uuid`);
  const [old]=await owner.db.execute<{id:string}>(sql`insert into public.employment(tenant_id,person_id,company_id,hired_on) values(${base.tenantId}::uuid,${original.personId}::uuid,${base.companyId}::uuid,'2020-01-01') returning id`);
  const result=await erasePersonPii(adminCtx(base),{subjectEmploymentId:old.id,scope:'contact',reason:'Fictional privacy request',requestRef:'fictional-native-outcome-contact'});expect(result.erased).toContain('assistantOutcomeLearning');
  expect(await counts()).toEqual({sources:1,targets:1,associations:1});const [remaining]=await owner.db.execute<{id:string}>(sql`select id from public.ai_native_outcome_association`);expect(remaining.id).toBe(keep);
  const [native]=await owner.db.execute<{n:number}>(sql`select count(*)::integer as n from app.assistant_own_leave_review`);expect(native.n).toBe(2);
 });
 it('cascades physical nonactor PERSON deletion through exact private capture/targets/association while preserving domain events',async()=>{
  // A legitimate unlinked PERSON has no employment/statutory FK blocker; testing a login would
  // instead pin the pre-existing non-cascading governed-job USER FK and prove nothing here.
  const [target]=await owner.db.execute<{id:string}>(sql`insert into public.person(tenant_id,full_name,primary_email) values(${base.tenantId}::uuid,'Fictional unlinked privacy subject',${randomUUID()+'@example.test'}) returning id`);
  const source=await storageCapture({targets:[{kind:'person',id:target.id}]}),job=await storageJob();await storageAssociation(source,job,false);
  const before=await owner.db.execute(sql`select id,event_type,payload from public.domain_event order by id`);
  await owner.db.execute(sql`delete from public.person where id=${target.id}::uuid`);
  expect(await counts()).toEqual({sources:0,targets:0,associations:0});expect(await owner.db.execute(sql`select id,event_type,payload from public.domain_event order by id`)).toEqual(before);
 });
 it('bounds an actual held source row during admitted privacy erasure, rolls back admission and metadata, then erases after release',async()=>{
  const target=await subject(),source=await storageCapture({targets:[{kind:'person',id:target.personId}]}),job=await storageJob();await storageAssociation(source,job,false);const before=await counts();
  const events=await owner.db.execute(sql`select id,event_type,payload from public.domain_event order by id`);
  const intents=await owner.db.execute(sql`select * from app.home_greeting_erasure_intent order by xact_id,tenant_id,user_id,person_id`);
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(yes=>{entered=yes;}),done=new Promise<void>(yes=>{release=yes;});
  // Deliberately no advisory/Access holder: actual source DELETE row wait must be bounded itself.
  const holder=owner.db.transaction(async tx=>{expect(await tx.execute(sql`select id from app.native_outcome_source_capture where id=${source.id}::uuid for update`)).toHaveLength(1);entered();await done;});
  const request={subjectEmploymentId:target.employmentId,scope:'contact' as const,reason:'Fictional source row bound',requestRef:'fictional-source-row-holder'};
  try{await ready;const started=Date.now();await expect(erasePersonPii(adminCtx(base),request)).rejects.toThrow();expect(Date.now()-started).toBeLessThan(4500);expect(await counts()).toEqual(before);
   expect(await owner.db.execute(sql`select id,event_type,payload from public.domain_event order by id`)).toEqual(events);expect(await owner.db.execute(sql`select * from app.home_greeting_erasure_intent order by xact_id,tenant_id,user_id,person_id`)).toEqual(intents);
  }finally{release();await holder;}
  expect((await erasePersonPii(adminCtx(base),request)).erased).toContain('assistantOutcomeLearning');expect(await counts()).toEqual({sources:0,targets:0,associations:0});
 });
 it('refuses unadmitted erasure and missing exact pii.erased audit, rolling source/association deletion back; identity-only own erasure is idempotent',async()=>{
  const target=await subject(),source=await storageCapture({targets:[{kind:'person',id:target.personId}]}),job=await storageJob();await storageAssociation(source,job,false);const before=await counts();
  await expect(withTenant(adminCtx(base),tx=>tx.execute(sql`select app.native_outcome_targets_redact(${target.employmentId}::uuid)`))).rejects.toThrow();expect(await counts()).toEqual(before);
  await expect(withTenant(adminCtx(base),async tx=>{await tx.execute(sql`select app.access_workforce_write_lock()`);await tx.execute(sql`select app.home_greeting_erasure_begin(${target.employmentId}::uuid,'contact','fictional-omitted-audit','Fictional audit omission')`);await tx.execute(sql`select app.native_outcome_targets_redact(${target.employmentId}::uuid)`);const [remaining]=await tx.execute<{n:number}>(sql`select count(*)::integer as n from public.ai_native_outcome_association`);expect(remaining.n).toBe(0);})).rejects.toThrow();expect(await counts()).toEqual(before);
  expect(await withTenant(adminCtx(base),tx=>tx.execute<{erased:boolean}>(sql`select app.native_outcome_own_erase() as erased`))).toEqual([{erased:true}]);expect(await counts()).toEqual({sources:0,targets:0,associations:0});
  expect(await withTenant(adminCtx(base),tx=>tx.execute<{erased:boolean}>(sql`select app.native_outcome_own_erase() as erased`))).toEqual([{erased:true}]);
 });
});
