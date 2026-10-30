/** Authored UNRUN; requires coordinated custody/feedback migrations. Raw fictional storage fixtures
 * test erasure and bounds only, never canonical preparation, consent or submitted-leave provenance.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant, type Tx } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { requirePackFor } from '../localization/registry';
import { grantAssistant } from '../core/assistant-grant';
import { createBatch, setPayrollInput, generatePayslips, closeBatch } from '../packs/payroll/service';
import { preparePayrollReopenReview } from '../core/assistant-actions/payroll-reopen-review-store';
import { prepareOrgActionReview, confirmOrgActionReview } from '../core/assistant-actions/org-action-review-store';
import { todayInKualaLumpur } from '../lib/hr-date';
import { lockAccessConfigurationTx } from '../core/access-configuration-lock';
import { retireExpiredAiCustodyTx, AI_RETENTION_MAINTAINED_RELATIONS } from '../core/ai-retention-maintenance';
import { runAiRetentionTick } from '../scripts/ai-retention-runner';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, entitledCtx, type Base } from './harness';

let base: Base, employee: { employmentId: string; personId: string };
beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb(); base = await seedBase();
  employee = await hireEmployee(adminCtx(base), { person: { fullName: 'Fictional Retention Subject',
    primaryEmail: `${randomUUID()}@example.test` }, companyId: base.companyId, departmentId: base.deptA,
    employmentType: 'full_time', hiredOn: '2020-01-01' });
});
afterAll(closeAll);
afterEach(()=>vi.unstubAllEnvs());
async function review(expired: boolean) {
  const id = randomUUID(), created = new Date(Date.now() - 600_000), expires = new Date(Date.now() + (expired ? -1000 : 600_000));
  await owner.db.execute(sql`with inserted as (
    insert into app.assistant_own_leave_review(id,tenant_id,user_id,person_id,employment_id,company_id,
      intent_digest,reviewed_digest,state,created_at,expires_at)
    values(${id}::uuid,${base.tenantId}::uuid,${base.adminUserId}::uuid,${employee.personId}::uuid,
      ${employee.employmentId}::uuid,${base.companyId}::uuid,${'a'.repeat(64)},${'b'.repeat(64)},
      'awaiting_confirmation',${created.toISOString()}::timestamptz,${expires.toISOString()}::timestamptz) returning id
  ) insert into app.assistant_own_leave_review_content(action_id,kid,wrapped_dek,ciphertext)
    select id,'0123456789abcdef','fictional-wrapped-bytes','fictional-encrypted-bytes' from inserted`);
  return id;
}
async function feedback(expired: boolean) {
  const id = randomUUID(), exchange = randomUUID();
  await owner.db.execute(sql`insert into public.assistant_exchange(id,tenant_id,app_user_id,question)
    values(${exchange}::uuid,${base.tenantId}::uuid,${base.adminUserId}::uuid,'Fictional consent fixture')`);
  await owner.db.execute(sql`insert into public.ai_agent_feedback(id,tenant_id,user_id,exchange_id,outcome,consented,created_at,expires_at)
    values(${id}::uuid,${base.tenantId}::uuid,${base.adminUserId}::uuid,${exchange}::uuid,'incorrect',true,
      now()-interval '29 days',${new Date(Date.now() + (expired ? -1000 : 60_000)).toISOString()}::timestamptz)`);
  return id;
}
/** Fictional raw content aged past the approved 30-day window; the source triggers capture identity. */
async function expiredTranscript() {
  const id = randomUUID();
  await owner.db.execute(sql`insert into public.assistant_exchange(id,tenant_id,app_user_id,asked_at,question,answer)
    values(${id}::uuid,${base.tenantId}::uuid,${base.adminUserId}::uuid,now()-interval '31 days','Fictional expired transcript fixture','Fictional expired answer')`);
  return id;
}
const state = async () => ({
  reviews: await owner.db.execute(sql`select r.*,c.ciphertext from app.assistant_own_leave_review r
    left join app.assistant_own_leave_review_content c on c.action_id=r.id order by r.id`),
  feedback: await owner.db.execute(sql`select * from public.ai_agent_feedback order by id`),
  requests: await owner.db.select().from(schema.leaveRequest).orderBy(schema.leaveRequest.id),
  ledger: await owner.db.select().from(schema.leaveLedger).orderBy(schema.leaveLedger.id),
  events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, base.tenantId)).orderBy(schema.domainEvent.id),
});

/** Isolated fixture projection only: all relation/function/ACL changes roll back and are compared.
 * The outer pure CHECK gets EXECUTE only. Its owner and all nested Payroll helpers stay unchanged. */
async function maintenanceMetadata(){
 const functions=await owner.db.execute(sql`select p.oid,p.proowner,p.proacl::text from pg_proc p
  where p.oid in ('app._payroll_completion_shape(jsonb,text,text)'::regprocedure,'app._payroll_completion_uuid_array(jsonb)'::regprocedure,
   'app.assistant_transcripts_retire_expired(uuid,integer,integer)'::regprocedure,'app._assistant_transcripts_retire(uuid,uuid[],boolean)'::regprocedure,'app._assistant_transcript_bounds()'::regprocedure) order by p.oid`);
 const tables=await owner.db.execute(sql`select oid,relowner,relacl::text from pg_class where relnamespace in ('app'::regnamespace,'public'::regnamespace) and relkind in ('r','p') order by oid`);
 return{functions:Array.from(functions),tables:Array.from(tables)};
}
async function withMaintenanceOwner(outerExecute:boolean,work:(tx:Tx)=>Promise<void>){
 const name='ai_retention_fixture_'+randomUUID().replaceAll('-',''),role=sql.identifier(name),before=await maintenanceMetadata(),rollback=Error('owned role fixture rollback');
 try{
  await owner.db.transaction(async tx=>{
      await tx.execute(sql`create role ${role} nologin nosuperuser nobypassrls`);
      await tx.execute(sql`grant usage on schema app,public to ${role}`);
      await tx.execute(sql`grant execute on function app.current_tenant_id(),app.is_group_admin(),app.principal_snapshot_current() to ${role}`);
      await tx.execute(sql`grant execute on function app.agent_signal_custody_visible(text,uuid,uuid,uuid) to ${role}`);
      // 0650 PUBLIC policies on the FORCE-RLS job receipt and native association tables call this helper;
      // PostgreSQL checks EXECUTE when the policy expression is initialized, even where an earlier conjunct is false.
      await tx.execute(sql`grant execute on function app.agent_native_signal_custody_visible(text,uuid,uuid,uuid) to ${role}`);
      await tx.execute(sql`grant execute on function app._answer_metadata_erasure_authorized(uuid,uuid,uuid) to ${role}`);
      // PUBLIC policy dependency on feedback/markers; no scope row exists outside the owner helper.
      await tx.execute(sql`grant execute on function app.assistant_transcript_retirement_visible(uuid,uuid) to ${role}`);
      await tx.execute(sql`alter table app.assistant_own_leave_review owner to ${role}`);
      await tx.execute(sql`alter table app.assistant_own_leave_review_content owner to ${role}`);
      await tx.execute(sql`alter table public.ai_agent_feedback owner to ${role}`);
      for(const table of ['ai_assistant_answer_evaluation_arm','ai_assistant_answer_strategy_use','ai_assistant_answer_evaluation_intent','assistant_exchange','ai_agent_plan_proposal','ai_agent_job_feedback','ai_agent_candidate_provenance','ai_agent_job_receipt','personnel_import_assistance_attempt','employee_import_evaluation_attempt','employee_import_evaluation_run_membership'])await tx.execute(sql`alter table public.${sql.identifier(table)} owner to ${role}`);
      await tx.execute(sql`alter table public.ai_native_outcome_association owner to ${role}`);
      await tx.execute(sql`alter table app.native_outcome_source_capture owner to ${role}`);
      await tx.execute(sql`alter table app.native_outcome_source_target owner to ${role}`);
      await tx.execute(sql`alter table app.assistant_transcript_identity owner to ${role}`);
      await tx.execute(sql`alter table app.assistant_transcript_retirement_scope owner to ${role}`);
      // The transcript owner helper requires session = function owner = exchange owner (or superuser).
      await tx.execute(sql`alter function app.assistant_transcripts_retire_expired(uuid,integer,integer) owner to ${role}`);
      await tx.execute(sql`alter function app._assistant_transcripts_retire(uuid,uuid[],boolean) owner to ${role}`);
      await tx.execute(sql`alter function app._assistant_transcript_bounds() owner to ${role}`);
      if(outerExecute)await tx.execute(sql`grant execute on function app._payroll_completion_shape(jsonb,text,text) to ${role}`);
      await tx.execute(sql`set local session authorization ${role}`);
      const [identity]=await tx.execute<{current_role_name:string;session_role_name:string;rolsuper:boolean;rolbypassrls:boolean}>(sql`select current_user as current_role_name,session_user as session_role_name,r.rolsuper,r.rolbypassrls from pg_roles r where r.rolname=current_user`);
      expect(identity).toEqual({current_role_name:name,session_role_name:name,rolsuper:false,rolbypassrls:false});
      expect(AI_RETENTION_MAINTAINED_RELATIONS).toHaveLength(19);
      const [owners]=await tx.execute<{isolation:string;writable:boolean;signal:boolean;transcript:boolean;relations:number;owned:boolean}>(sql`select
       current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only')='off' as writable,
       has_function_privilege(current_user,'app.agent_signal_custody_visible(text,uuid,uuid,uuid)','EXECUTE') as signal,
       (select pg_get_userbyid(proowner)=current_user from pg_proc where oid='app.assistant_transcripts_retire_expired(uuid,integer,integer)'::regprocedure) as transcript,
       (select count(*)::int from pg_class where oid in (${sql.join(AI_RETENTION_MAINTAINED_RELATIONS.map(value=>sql`${value}::regclass`),sql`,`)})) as relations,
       (select bool_and(pg_get_userbyid(relowner)=current_user) from pg_class where oid in (${sql.join(AI_RETENTION_MAINTAINED_RELATIONS.map(value=>sql`${value}::regclass`),sql`,`)})) as owned`);
      expect(owners).toEqual({isolation:'read committed',writable:true,signal:true,transcript:true,relations:19,owned:true});
      const [capability]=await tx.execute<{outer:boolean;grant_option:boolean;nested:boolean;owner_unchanged:boolean;app:boolean;public:boolean;child:boolean}>(sql`select
       has_function_privilege(current_user,p.oid,'EXECUTE') as "outer",
       has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION') as grant_option,
       has_function_privilege(current_user,'app._payroll_completion_uuid_array(jsonb)','EXECUTE') as nested,
       p.proowner<>(select oid from pg_roles where rolname=current_user) as owner_unchanged,
       has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app,
       exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as "public",
       has_function_privilege('ai_hr_draft_discard_port',p.oid,'EXECUTE') as child
       from pg_proc p where p.oid='app._payroll_completion_shape(jsonb,text,text)'::regprocedure`);
      expect(capability).toEqual({outer:outerExecute,grant_option:false,nested:false,owner_unchanged:true,app:false,public:false,child:true});
      await work(tx as unknown as Tx);
      throw rollback;
  });
  throw Error('Fixture must roll back');
 }catch(error){if(error!==rollback)throw error;}
 finally{
  expect(await maintenanceMetadata()).toEqual(before);
  const [left]=await owner.db.execute<{count:number}>(sql`select count(*)::int as count from pg_roles where rolname=${name}`);expect(left.count).toBe(0);
 }
}
type CustodySnapshot={id:string;ledger:Record<string,unknown>;bodies:unknown[]};
async function custodySnapshot(tx:Tx){return Array.from(await tx.execute<CustodySnapshot>(sql`select r.id,to_jsonb(r) as ledger,
 (select coalesce(jsonb_agg(to_jsonb(c) order by c.action_id),'[]'::jsonb) from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies
 from app.assistant_own_leave_review r where r.tenant_id=${base.tenantId}::uuid order by r.id`));}
async function nativeSnapshot(tx:Tx){
 return{batches:Array.from(await tx.execute(sql`select to_jsonb(r) as row from public.payroll_batch r where tenant_id=${base.tenantId}::uuid order by id`)),
  periods:Array.from(await tx.execute(sql`select to_jsonb(r) as row from public.pay_period r where tenant_id=${base.tenantId}::uuid order by id`)),
  slips:Array.from(await tx.execute(sql`select to_jsonb(r) as row from public.payslip r where tenant_id=${base.tenantId}::uuid order by id`)),
  inputs:Array.from(await tx.execute(sql`select to_jsonb(r) as row from public.payroll_input r where tenant_id=${base.tenantId}::uuid order by id`)),
  history:Array.from(await tx.execute(sql`select to_jsonb(r) as row from public.payroll_status_history r where tenant_id=${base.tenantId}::uuid order by id`)),
  lines:Array.from(await tx.execute(sql`select to_jsonb(r) as row from public.reporting_line r where tenant_id=${base.tenantId}::uuid order by id`)),
  events:Array.from(await tx.execute(sql`select to_jsonb(r) as row from public.domain_event r where tenant_id=${base.tenantId}::uuid order by id`)),
  captures:Array.from(await tx.execute(sql`select to_jsonb(r) as row from app.native_outcome_source_capture r where tenant_id=${base.tenantId}::uuid order by id`)),
  targets:Array.from(await tx.execute(sql`select to_jsonb(t) as row from app.native_outcome_source_target t join app.native_outcome_source_capture c on c.id=t.capture_id where c.tenant_id=${base.tenantId}::uuid order by t.capture_id,t.kind,t.target_id`)),
  associations:Array.from(await tx.execute(sql`select to_jsonb(r) as row from public.ai_native_outcome_association r where tenant_id=${base.tenantId}::uuid order by id`))};
}
async function preparedExpiryFixture(){
 vi.stubEnv('AI_CONFIG_SECRET','fictional-retention-native-custody-key-123456789012');
 for(const code of ['assistant','payroll'])await setModule(base.tenantId,code,'active');
 await setSetting(base.tenantId,'payroll.unlock_enabled',true);
 const ctx={...await entitledCtx(base,['hr_admin']),grants:[{role:'hr_admin' as const,companyId:null}]};await grantAssistant(ctx,{appUserId:base.adminUserId});
 await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:5000,effectiveFrom:'2020-01-01'});
 await requirePackFor('MY').statutory.set(ctx,{personId:employee.personId,icNumber:'900101019885'});
 const year=Number(todayInKualaLumpur().slice(0,4));
 async function reopening(month:string){
  const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:String(year-1)+'-'+month});
  await setPayrollInput(ctx,{batchId,employmentId:employee.employmentId,overtimeAmount:0});await generatePayslips(ctx,{batchId});await closeBatch(ctx,{batchId});
  const prepared=await preparePayrollReopenReview(ctx,{action:'payroll.reopen',contractVersion:1,batchId,reason:'Fictional retention expiry proof',confirmReopenClosedRun:true,acknowledgeRecordedDownstreamWarnings:true});
  if(prepared.kind!=='prepared')throw Error('Expected genuine encrypted Payroll reopening');return prepared.review.actionId;
 }
 const payroll=await reopening('08'),sibling=await reopening('09');
 const hire=(name:string)=>hireEmployee(ctx,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const prior=await hire('Fictional prior manager'),next=await hire('Fictional next manager');
 await setReportingLine(ctx,{subordinateEmploymentId:employee.employmentId,managerEmploymentId:prior.employmentId,lineType:'administrative',validFrom:todayInKualaLumpur()});
 const human={action:'org.reporting.change' as const,contractVersion:1 as const,subordinateEmploymentId:employee.employmentId,managerEmploymentId:next.employmentId,lineType:'administrative' as const,validFrom:todayInKualaLumpur(),confirmReportingChange:true as const};
 const first=await prepareOrgActionReview(ctx,human);if(first.kind!=='prepared')throw Error('Expected genuine reporting custody');
 const done=await confirmOrgActionReview(ctx,{action:human.action,contractVersion:1,actionId:first.review.actionId,reviewedDigest:first.review.reviewedDigest});expect(done.kind).toBe('completed');
 const second=await prepareOrgActionReview(ctx,{...human,managerEmploymentId:prior.employmentId});if(second.kind!=='prepared')throw Error('Expected genuine pending reporting custody');
 // Owner-only fixture aging crosses real DB expiry; native preparation/root/body bytes are genuine.
 await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' where id in (${payroll}::uuid,${second.review.actionId}::uuid)`);
 const before=await custodySnapshot(owner.db as unknown as Tx),native=await nativeSnapshot(owner.db as unknown as Tx);
 expect(before.find(row=>row.id===payroll)).toMatchObject({ledger:{action_kind:'payroll.reopen',state:'awaiting_confirmation',payroll_completion_root:{phase:'prepared'}}});
 expect(before.find(row=>row.id===payroll)?.bodies).toHaveLength(1);
 expect(before.find(row=>row.id===second.review.actionId)).toMatchObject({ledger:{action_kind:'org.reporting.change',state:'awaiting_confirmation',org_manager_person_id:prior.personId,org_previous_manager_person_id:next.personId}});
 expect(before.find(row=>row.id===second.review.actionId)?.bodies).toHaveLength(1);
 expect(before.find(row=>row.id===first.review.actionId)).toMatchObject({ledger:{state:'completed'}});
 expect(before.find(row=>row.id===sibling)?.bodies).toHaveLength(1);
 return{expired:[payroll,second.review.actionId],sibling,completed:first.review.actionId,before,native};
}

describe('out-of-band expired AI custody maintenance', () => {
  it('retires expired private bytes and opinions only, leaves active custody and HR facts unchanged, then is idempotent', async () => {
    const expired = await review(true), active = await review(false), expiredFeedback = await feedback(true), activeFeedback = await feedback(false);
    const before = await state(), result = await runAiRetentionTick(owner);
    expect(result).toEqual({ tenants: 1, busy: 0, reviews: 1, feedback: 1,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0,importEvaluations:0,nativeOutcomes:0,nativeSources:0,conversationArms:0,conversationUses:0,conversationIntents:0,transcripts:0, backlog: false, oldestExpiredAgeSeconds: null });
    for (const id of [expired, active, expiredFeedback, activeFeedback, base.tenantId]) expect(JSON.stringify(result)).not.toContain(id);
    const after = await state();
    expect(after.reviews.find(row => row.id === expired)).toMatchObject({ state: 'expired', intent_digest: null, reviewed_digest: null, ciphertext: null });
    expect(after.reviews.find(row => row.id === active)).toEqual(before.reviews.find(row => row.id === active));
    expect(after.feedback.some(row => row.id === expiredFeedback)).toBe(false);
    expect(after.feedback.find(row => row.id === activeFeedback)).toEqual(before.feedback.find(row => row.id === activeFeedback));
    expect(after.requests).toEqual(before.requests); expect(after.ledger).toEqual(before.ledger); expect(after.events).toEqual(before.events);
    expect(await runAiRetentionTick(owner)).toEqual({ tenants: 0, busy: 0, reviews: 0, feedback: 0,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0,importEvaluations:0,nativeOutcomes:0,nativeSources:0,conversationArms:0,conversationUses:0,conversationIntents:0,transcripts:0, backlog: false, oldestExpiredAgeSeconds: null });
  });
  it('rejects an app-role carrier despite administrator claims, without any mutation', async () => {
    await review(true); await feedback(true); const before = await state();
    await expect(withTenant(adminCtx(base), tx => retireExpiredAiCustodyTx(tx))).rejects.toThrow('AI retention maintenance could not be confirmed');
    expect(await state()).toEqual(before);
  });
  it('rolls all retirement back if the owning transaction fails', async () => {
    await review(true); await feedback(true); const before = await state();
    await expect(owner.db.transaction(async tx => { await retireExpiredAiCustodyTx(tx as unknown as Tx); throw Error('owned retention rollback'); })).rejects.toThrow('owned retention rollback');
    expect(await state()).toEqual(before);
  });
  it('retains stricter caller statement and lock timeouts', async () => {
    await owner.db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout='4000ms'`);
      await tx.execute(sql`set local lock_timeout='400ms'`);
      expect(await retireExpiredAiCustodyTx(tx as unknown as Tx)).toEqual({ tenants: 0, busy: 0, reviews: 0, feedback: 0,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0,importEvaluations:0,nativeOutcomes:0,nativeSources:0,conversationArms:0,conversationUses:0,conversationIntents:0,transcripts:0 });
      const rows = await tx.execute<{ name: string; setting: string }>(sql`select name,setting from pg_settings
        where name in ('statement_timeout','lock_timeout') order by name`);
      expect(rows).toEqual([{ name: 'lock_timeout', setting: '400' }, { name: 'statement_timeout', setting: '4000' }]);
    });
  });
  it('skips a genuinely busy Access interval without changes and retires after release', async () => {
    await review(true); await feedback(true); const before = await state();
    let ready!: () => void, fail!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; fail = no; }), finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { fail(Error('owned retention handshake timed out')); release(); }, 10_000);
    const holder = withTenant(adminCtx(base), async tx => { await lockAccessConfigurationTx(tx, base.tenantId); ready(); await finish; });
    void holder.catch(fail);
    try {
      await started; const result = await runAiRetentionTick(owner);
      expect(result).toMatchObject({ tenants: 1, busy: 1, reviews: 0, feedback: 0,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0,importEvaluations:0,nativeOutcomes:0,nativeSources:0,conversationArms:0,conversationUses:0,conversationIntents:0,transcripts:0, backlog: true });
      expect(result.oldestExpiredAgeSeconds).toBeGreaterThanOrEqual(1); expect(await state()).toEqual(before);
    }
    finally { release(); clearTimeout(watchdog); await holder; }
    expect(await runAiRetentionTick(owner)).toEqual({ tenants: 1, busy: 0, reviews: 1, feedback: 1,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0,importEvaluations:0,nativeOutcomes:0,nativeSources:0,conversationArms:0,conversationUses:0,conversationIntents:0,transcripts:0, backlog: false, oldestExpiredAgeSeconds: null });
  });
  it('reports real remaining expired custody after the100-row bound, then clears it in a separate pass', async () => {
    const ids: string[] = [];
    for (let index=0; index<101; index++) ids.push(await review(true));
    const first = await runAiRetentionTick(owner);
    expect(first).toMatchObject({ tenants: 1, busy: 0, reviews: 100, feedback: 0,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0,importEvaluations:0,nativeOutcomes:0,nativeSources:0,conversationArms:0,conversationUses:0,conversationIntents:0,transcripts:0, backlog: true });
    expect(first.oldestExpiredAgeSeconds).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(first)).not.toContain(base.tenantId);
    for (const id of ids) expect(JSON.stringify(first)).not.toContain(id);
    expect(await runAiRetentionTick(owner)).toEqual({ tenants: 1, busy: 0, reviews: 1, feedback: 0,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0,importEvaluations:0,nativeOutcomes:0,nativeSources:0,conversationArms:0,conversationUses:0,conversationIntents:0,transcripts:0, backlog: false, oldestExpiredAgeSeconds: null });
    const after=await state();expect(after.reviews).toHaveLength(101);
    expect(after.reviews.every(row=>row.state==='expired'&&row.ciphertext===null&&row.intent_digest===null&&row.reviewed_digest===null)).toBe(true);
  });
  it('supports a real nonsuperuser table-owner identity under FORCE RLS, without seeing nonexpired opinions', async () => {
    await review(true); await feedback(true); await feedback(false); const transcript = await expiredTranscript();
    await withMaintenanceOwner(true,async tx=>{
      const [expired] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from public.ai_agent_feedback where expires_at<=now()`);
      expect(expired.count).toBe(1);
      await tx.execute(sql`savepoint feedback_update_refusal`);
      await expect(tx.execute(sql`update public.ai_agent_feedback set outcome='helpful' where expires_at<=now()`)).rejects.toThrow();
      await tx.execute(sql`rollback to savepoint feedback_update_refusal`);
      expect(await retireExpiredAiCustodyTx(tx as unknown as Tx)).toEqual({ tenants: 1, busy: 0, reviews: 1, feedback: 1,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0,importEvaluations:0,nativeOutcomes:0,nativeSources:0,conversationArms:0,conversationUses:0,conversationIntents:0,transcripts:1 });
      const [content] = await tx.execute<{ question: string; answer: string | null; retired: boolean; identities: number }>(sql`select question,answer,content_retired_at is not null as retired,
        (select count(*)::int from app.assistant_transcript_identity where exchange_id=${transcript}::uuid) as identities from public.assistant_exchange where id=${transcript}::uuid`);
      expect(content).toEqual({ question: '', answer: null, retired: true, identities: 0 });
      const [hidden] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from public.ai_agent_feedback where expires_at>now()`);
      expect(hidden.count).toBe(0);
    });
  });

  it('refuses a split owner missing only the outer CHECK capability before retiring any class',async()=>{
    await review(true);await feedback(true);await expiredTranscript();
    const before=await state(),custodyBefore=await custodySnapshot(owner.db as unknown as Tx),[transcriptBefore]=await owner.db.execute<{rows:unknown}>(sql`select jsonb_agg(to_jsonb(e) order by id) as rows from public.assistant_exchange e where tenant_id=${base.tenantId}::uuid`);
    await withMaintenanceOwner(false,async tx=>{
      await expect(retireExpiredAiCustodyTx(tx)).rejects.toThrow('AI retention maintenance could not be confirmed.');
      // Return only the fixture observer to its original owner; maintenance itself used real nonsuper identity.
      await tx.execute(sql`set local session authorization default`);
      const [transcriptAfter]=await tx.execute<{rows:unknown}>(sql`select jsonb_agg(to_jsonb(e) order by id) as rows from public.assistant_exchange e where tenant_id=${base.tenantId}::uuid`);
      expect(transcriptAfter).toEqual(transcriptBefore);
      expect(await custodySnapshot(tx)).toEqual(custodyBefore);
      expect(Array.from(await tx.execute(sql`select * from public.ai_agent_feedback order by id`))).toEqual(Array.from(before.feedback));
    });
    expect(await state()).toEqual(before);
  });
  for(const restricted of [false,true])it(`expires genuine prepared Payroll/reporting custody under ${restricted?'split nonsuper':'ordinary migration'} owner without changing native facts or sibling/history`,async()=>{
    const f=await preparedExpiryFixture();
    const run=async(tx:Tx)=>{
      expect(await retireExpiredAiCustodyTx(tx)).toEqual({tenants:1,busy:0,reviews:2,feedback:0,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0,importEvaluations:0,nativeOutcomes:0,nativeSources:0,conversationArms:0,conversationUses:0,conversationIntents:0,transcripts:0});
      expect(await retireExpiredAiCustodyTx(tx)).toEqual({tenants:0,busy:0,reviews:0,feedback:0,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0,importEvaluations:0,nativeOutcomes:0,nativeSources:0,conversationArms:0,conversationUses:0,conversationIntents:0,transcripts:0});
      if(restricted)await tx.execute(sql`set local session authorization default`);
      const rows=await custodySnapshot(tx);
      expect(rows.map(row=>row.id)).toEqual(f.before.map(row=>row.id));
      for(const id of f.expired){
        const prior=f.before.find(row=>row.id===id)!,after=rows.find(row=>row.id===id)!;
        expect(after.ledger).toEqual({...prior.ledger,state:'expired',intent_digest:null,reviewed_digest:null,payroll_completion_root:null,org_manager_person_id:null,org_previous_manager_person_id:null});
        expect(after.bodies).toEqual([]);
      }
      for(const id of [f.sibling,f.completed])expect(rows.find(row=>row.id===id)).toEqual(f.before.find(row=>row.id===id));
      expect(await nativeSnapshot(tx)).toEqual(f.native);
    };
    if(restricted){
      await withMaintenanceOwner(true,run);
      // Successful maintenance effects and every temporary role/ACL projection must fully roll back.
      expect(await custodySnapshot(owner.db as unknown as Tx)).toEqual(f.before);
      expect(await nativeSnapshot(owner.db as unknown as Tx)).toEqual(f.native);
    }else await owner.db.transaction(tx=>run(tx as unknown as Tx));
  });
});
