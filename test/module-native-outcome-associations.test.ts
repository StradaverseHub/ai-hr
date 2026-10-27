import {expectNativeSourceCapture} from './native-outcome-source-capture.helpers';
import {readCompletedNativeOutcomeTx} from '../core/assistant-actions/completed-outcome-readers';
/** Authored UNRUN. Requires normally installed coordinated drafts; never applies/forges schema,
 * native completion, governed job provenance or provider capability receipts in this fixture. */
import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {applyLeaveAdjustmentBatch} from '../packs/leave/service';
import {prepareOwnLeaveReviewTx,confirmOwnLeaveReview,discardOwnLeaveReviewTx,readCompletedOwnLeaveOutcomeTx} from '../core/assistant-actions/own-leave-store';
import {runGovernedModuleReadPlan,beginOwnNativeOutcomeJobProvenanceTx,createCanonicalSpecialistCandidate,promoteCanonicalSpecialistCandidate} from '../core/module-agent-releases';
import {recordOwnNativeOutcomeAssociation,reopenOwnNativeOutcomeAssociation,eraseOwnNativeOutcomeAssociations} from '../core/module-native-outcomes';
import {readVerifiedNativeOutcomeAssociationTx,recordVerifiedNativeOutcomeAssociationTx,finishNativeOutcomeJobRecheckTx} from '../core/module-native-outcome-references';
import {boundNativeOutcomeTransactionTx} from '../core/module-native-outcome-bounds';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-native-outcome-association-master-secret');await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});
async function fixture(asAdmin=false){
 const admin=adminCtx(base);
 const make=async()=>{const subject=await hireEmployee(admin,{person:{fullName:'Fictional outcome applicant',primaryEmail:randomUUID()+'@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const userId=await createAppUser(base.tenantId,subject.personId,asAdmin?'hr_admin':'employee');await grantAssistant(admin,{appUserId:userId});
  const ctx:SessionContext={...await entitledCtx(base,['employee']),userId,personId:subject.personId,roles:[asAdmin?'hr_admin':'employee'],grants:[{role:asAdmin?'hr_admin':'employee',companyId:null}]};
  expect((await applyLeaveAdjustmentBatch(admin,{leaveTypeIds:[base.annualLeaveTypeId],days:10,effectiveOn:todayInKualaLumpur(),reason:'Fictional native outcome fixture opening credit',targetMode:'individual',employmentIds:[subject.employmentId]})).written).toBe(1);
  return{ctx,subject};};
 return{admin,mine:await make(),peer:await make()};
}
function nominationFor(f:Awaited<ReturnType<typeof fixture>>){
 const date=new Date(todayInKualaLumpur()+'T00:00:00Z');do{date.setUTCDate(date.getUTCDate()+1);}while([0,6].includes(date.getUTCDay()));
 return{action:'leave.apply' as const,contractVersion:1 as const,employmentId:f.mine.subject.employmentId,leaveTypeId:base.annualLeaveTypeId,date:date.toISOString().slice(0,10),durationType:'full_day' as const};
}
async function preparation(f:Awaited<ReturnType<typeof fixture>>){
 const job=await runGovernedModuleReadPlan(f.mine.ctx,{version:1,modules:['leave']},{nonce:randomUUID()});
 const nomination=nominationFor(f);
 // Human text as the human input owner sends it: an empty remark box is ABSENT, never ''
 // (components/assistant/own-leave-command-panel.tsx). '' is refused by the bounded slice; see below.
 const prepared=await withTenant(f.mine.ctx,tx=>prepareOwnLeaveReviewTx(tx,f.mine.ctx,nomination,{employmentId:nomination.employmentId,leaveTypeId:nomination.leaveTypeId},{reason:'Fictional HUMAN PRIVATE REASON'},'en'));
 if(prepared.kind!=='prepared')throw Error('Canonical fixture failed to prepare: '+prepared.kind);
 const review=prepared.review;return{job,review,input:{jobId:job.jobId,reference:{source:'review' as const,action:'leave.apply' as const,actionId:review.actionId},nonce:randomUUID(),consented:true as const}};
}
async function complete(f:Awaited<ReturnType<typeof fixture>>,p:Awaited<ReturnType<typeof preparation>>){
 const result=await confirmOwnLeaveReview(f.mine.ctx,{actionId:p.review.actionId,contractVersion:p.review.contractVersion,reviewedDigest:p.review.reviewedDigest},'en');
 expect(result.kind).toBe('completed');return result;
}
async function counts(){const [r]=await owner.db.execute<{links:number;requests:number;runs:number}>(sql`select (select count(*)::int from public.ai_native_outcome_association) as links,(select count(*)::int from public.leave_request) as requests,(select count(*)::int from public.ai_model_run) as runs`);return r;}
const unavailable='This outcome link needs a fresh look. Please check your access and completed action.';

describe('actual own native outcome links',()=>{
 it('links a real changed Leave outcome to original job provenance, replays only same nonce/reference and never executes again',async()=>{
  const f=await fixture(),p=await preparation(f);await complete(f,p);const before=await counts();
  const linked=await recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input);
  expect(linked).toMatchObject({action:'leave.apply',module:'leave',semantics:'submitted_not_approved',causalCredit:false,quality:'not_assessed',currentStatus:null});
  expect(await recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input)).toEqual(linked);
  expect(await reopenOwnNativeOutcomeAssociation(f.mine.ctx,{associationId:linked.associationId})).toEqual(linked);
  expect(await counts()).toEqual({...before,links:before.links+1});
  const [stored]=await owner.db.execute<{receipt:string}>(sql`select receipt from public.ai_native_outcome_association where id=${linked.associationId}::uuid`);
  const [sqlDigest]=await owner.db.execute<{digest:string}>(sql`select encode(sha256(convert_to(receipt,'UTF8')),'hex') as digest from public.ai_native_outcome_association where id=${linked.associationId}::uuid`);
  const reference=await withTenant(f.mine.ctx,async tx=>{const provenance=await beginOwnNativeOutcomeJobProvenanceTx(tx,f.mine.ctx,p.job.jobId);return readVerifiedNativeOutcomeAssociationTx(tx,f.mine.ctx,linked.associationId,provenance);});
  expect(reference.reference.associationReceiptDigest).toBe(sqlDigest.digest);expect(sqlDigest.digest).toBe(createHash('sha256').update(stored.receipt,'utf8').digest('hex'));
  expect(stored.receipt).not.toContain('HUMAN PRIVATE REASON');expect(JSON.stringify(linked)).not.toContain(p.review.actionId);
  await expect(recordOwnNativeOutcomeAssociation(f.mine.ctx,{...p.input,nonce:randomUUID()})).rejects.toThrow(unavailable);
  await expect(recordOwnNativeOutcomeAssociation(f.mine.ctx,{...p.input,reference:{...p.input.reference,actionId:randomUUID()}})).rejects.toThrow(unavailable);
  expect(await counts()).toEqual({...before,links:before.links+1});
 });
 it('refuses pending/discarded custody without completing or decrypting pending content',async()=>{
  const f=await fixture(),p=await preparation(f),before=await counts();
  await expect(recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input)).rejects.toThrow(unavailable);
  await expect(withTenant(f.mine.ctx,tx=>readCompletedOwnLeaveOutcomeTx(tx,f.mine.ctx,p.review.actionId))).rejects.toThrow();
  expect(await counts()).toEqual(before);
  await withTenant(f.mine.ctx, tx => discardOwnLeaveReviewTx(tx, f.mine.ctx, {actionId:p.review.actionId,contractVersion:p.review.contractVersion}));
  await expect(recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input)).rejects.toThrow(unavailable);expect(await counts()).toEqual(before);
 });
 it('refuses foreign owner/tenant, revoked Assistant and module kill before association; own erasure survives revocation',async()=>{
  const f=await fixture(),p=await preparation(f);await complete(f,p);const linked=await recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input);
  await expect(reopenOwnNativeOutcomeAssociation(f.peer.ctx,{associationId:linked.associationId})).rejects.toThrow(unavailable);
  await expect(recordOwnNativeOutcomeAssociation({...f.mine.ctx,tenantId:randomUUID()},p.input)).rejects.toThrow(unavailable);
  vi.stubEnv('MODULE_KILL','leave');await expect(reopenOwnNativeOutcomeAssociation(f.mine.ctx,{associationId:linked.associationId})).rejects.toThrow(unavailable);vi.unstubAllEnvs();vi.stubEnv('AI_CONFIG_SECRET','fictional-native-outcome-association-master-secret');
  await revokeAssistant(f.admin,{appUserId:f.mine.ctx.userId!});
  await expect(reopenOwnNativeOutcomeAssociation(f.mine.ctx,{associationId:linked.associationId})).rejects.toThrow(unavailable);
  expect(await eraseOwnNativeOutcomeAssociations(f.mine.ctx)).toEqual({erased:true});expect((await counts()).links).toBe(0);
 });
 it('rolls back a fully inserted link on caller failure and permits the same authenticated retry',async()=>{
  const f=await fixture(),p=await preparation(f);await complete(f,p);const before=await counts();
  await expect(withTenant(f.mine.ctx,async tx=>{const proof=await beginOwnNativeOutcomeJobProvenanceTx(tx,f.mine.ctx,p.job.jobId);await recordVerifiedNativeOutcomeAssociationTx(tx,f.mine.ctx,p.input,proof);throw Error('injected caller rollback');})).rejects.toThrow('injected caller rollback');
  expect(await counts()).toEqual(before);await recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input);expect((await counts()).links).toBe(before.links+1);
 });
 it.each(['agent-release','agent-signals','native-outcome:v1'])('refuses actual held %s ownership with no link/native effect and succeeds after release',async(prefix)=>{
  const f=await fixture(),p=await preparation(f);await complete(f,p);const before=await counts();let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
  // Metadata holder uses real owner connection: no Access lock hides the exact tested TRY interval.
  const key=prefix+':'+base.tenantId+':'+f.mine.ctx.userId;
  const holder=owner.db.transaction(async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);entered();await resume;});
  try{await started;await expect(recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input)).rejects.toThrow(unavailable);expect(await counts()).toEqual(before);}finally{release();await holder;}
  await recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input);expect((await counts()).links).toBe(before.links+1);
 });
 it('uses DB-enforced append/delete custody without UPDATE grants and refuses tampered sealed references',async()=>{
  const f=await fixture(),p=await preparation(f);await complete(f,p);const linked=await recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input);
  await expect(withTenant(f.mine.ctx,tx=>tx.execute(sql`update public.ai_native_outcome_association set consented=true where id=${linked.associationId}::uuid`))).rejects.toThrow();
  await owner.db.execute(sql`update public.ai_native_outcome_association set receipt='tampered' where id=${linked.associationId}::uuid`);
  await expect(reopenOwnNativeOutcomeAssociation(f.mine.ctx,{associationId:linked.associationId})).rejects.toThrow(unavailable);
 });
 it('enforces the custody TRY trigger for direct deletes and rolls back an earlier multi-owner deletion',async()=>{
  const f=await fixture(),p=await preparation(f);await complete(f,p);const mine=await recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input);
  const peerFixture={...f,mine:f.peer},q=await preparation(peerFixture);await complete(peerFixture,q);const peer=await recordOwnNativeOutcomeAssociation(f.peer.ctx,q.input),before=await counts();
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
  const holder=owner.db.transaction(async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'native-outcome:v1:'+base.tenantId+':'+f.peer.ctx.userId},0))`);entered();await resume;});
  try{await started;
   // Actual invoker DELETE intentionally bypasses the TS helper, never normal RLS ownership.
   await expect(withTenant(f.peer.ctx,tx=>tx.execute(sql`delete from public.ai_native_outcome_association`))).rejects.toThrow();
   // Actual maintenance owner touches two tenants/users: busy second owner aborts the whole batch.
   await expect(owner.db.transaction(async tx=>{await tx.execute(sql`delete from public.ai_native_outcome_association where id=${mine.associationId}::uuid`);await tx.execute(sql`delete from public.ai_native_outcome_association where id=${peer.associationId}::uuid`);})).rejects.toThrow();
   expect(await counts()).toEqual(before);
  }finally{release();await holder;}
  await eraseOwnNativeOutcomeAssociations(f.mine.ctx);expect((await counts()).links).toBe(before.links-1);
  expect(await reopenOwnNativeOutcomeAssociation(f.peer.ctx,{associationId:peer.associationId})).toMatchObject({associationId:peer.associationId});
 });
 it('physically removes an expired association and refuses all later reopening without native execution',async()=>{
  const f=await fixture(),p=await preparation(f);await complete(f,p);const linked=await recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input),before=await counts();
  await owner.db.execute(sql`update public.ai_native_outcome_association set created_at=now()-interval '31 days',expires_at=now()-interval '1 day' where id=${linked.associationId}::uuid`);
  await expect(reopenOwnNativeOutcomeAssociation(f.mine.ctx,{associationId:linked.associationId})).rejects.toThrow(unavailable);
  await owner.db.execute(sql`delete from public.ai_native_outcome_association where expires_at<=now()`);
  await expect(reopenOwnNativeOutcomeAssociation(f.mine.ctx,{associationId:linked.associationId})).rejects.toThrow(unavailable);
  expect(await counts()).toEqual({...before,links:before.links-1});
 });

 it('refuses a tampered historical governed job without changing a previously valid native action',async()=>{
  const f=await fixture(),p=await preparation(f);await complete(f,p);const before=await counts();
  await owner.db.execute(sql`update public.ai_agent_job_receipt set receipt='invalid historical proof' where id=${p.job.jobId}::uuid`);
  await expect(recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input)).rejects.toThrow(unavailable);
  expect(await counts()).toEqual(before);
 });

 it('bounds a physical completed-custody row wait before native reads, rolls back, then links/replays once after release',async()=>{
  const f=await fixture(),p=await preparation(f);await complete(f,p);const before=await counts();
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
  // Holder intentionally has no Access/advisory lock: the actual blocking legacy custody row is
  // the only competing resource, so metadata/Access TRY refusal cannot mask this test.
  const holder=owner.db.transaction(async tx=>{const rows=await tx.execute(sql`select id from app.assistant_own_leave_review where id=${p.review.actionId}::uuid for update`);expect(rows).toHaveLength(1);entered();await resume;});
  try{await started;const began=Date.now();
   await expect(recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input)).rejects.toThrow(unavailable);
   expect(Date.now()-began).toBeLessThan(4500);expect(await counts()).toEqual(before);
   await expect(withTenant(f.mine.ctx,tx=>readCompletedOwnLeaveOutcomeTx(tx,f.mine.ctx,p.review.actionId))).rejects.toThrow();
   expect(await counts()).toEqual(before);
  }finally{release();await holder;}
  const linked=await recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input);expect(await recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input)).toEqual(linked);
  expect(await counts()).toEqual({...before,links:before.links+1});
 });
 it('never relaxes shorter inherited statement or lock bounds',async()=>{
  const f=await fixture();await withTenant(f.mine.ctx,async tx=>{
   await tx.execute(sql`set local statement_timeout='1000ms'`);await tx.execute(sql`set local lock_timeout='100ms'`);
   await boundNativeOutcomeTransactionTx(tx);
   const rows=await tx.execute<{name:string;setting:string}>(sql`select name,setting from pg_catalog.pg_settings where name in ('statement_timeout','lock_timeout') order by name`);
   expect(rows.map(row=>({name:row.name,setting:Number(row.setting)}))).toEqual([{name:'lock_timeout',setting:100},{name:'statement_timeout',setting:1000}]);
  });
 });

});

/** Authored UNRUN. Actual same-owner completed Leave effect, association, candidate provenance,
 * erasure and independent admission must run after the normal consolidated migration install. */
describe('native completion as human-selected candidate hypothesis',()=>{
 it('binds actual completion to the same-module candidate without making it an independent PASS, then invalidates on own erasure',async()=>{
  const f=await fixture(true),p=await preparation(f);await complete(f,p);
  const linked=await recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input),before=await counts();
  const candidate=await createCanonicalSpecialistCandidate(f.mine.ctx,{module:'leave',version:1,playbook:'canonical_followup_v1',nativeSignalIds:[linked.associationId]});
  const [provenance]=await owner.db.execute<{refs:unknown[];native_refs:{associationId:string;module:string}[];receipt:string}>(sql`select refs,native_refs,receipt from public.ai_agent_candidate_provenance where candidate_id=${candidate.candidateId}::uuid`);
  expect(provenance.refs).toEqual([]);expect(provenance.native_refs).toHaveLength(1);expect(provenance.native_refs[0]).toMatchObject({associationId:linked.associationId,module:'leave'});expect(provenance.receipt).not.toContain('Fictional HUMAN PRIVATE REASON');
  const current=()=>withTenant(f.peer.ctx,async tx=>{const [row]=await tx.execute<{allowed:boolean}>(sql`select app.agent_candidate_native_signals_current(${candidate.candidateId}::uuid) as allowed`);return row.allowed;});
  expect(await current()).toBe(true);
  await expect(promoteCanonicalSpecialistCandidate(f.peer.ctx,{candidateId:candidate.candidateId,maxJobs:1,hours:1})).rejects.toThrow();
  expect(await counts()).toEqual(before);
  await eraseOwnNativeOutcomeAssociations(f.mine.ctx);expect(await current()).toBe(false);
  const [evaluation]=await owner.db.execute<{evaluations:number;promotions:number}>(sql`select (select count(*)::int from public.ai_agent_evaluation) as evaluations,(select count(*)::int from public.ai_agent_promotion) as promotions`);expect(evaluation).toEqual({evaluations:0,promotions:0});
 });
 it('refuses a different module, different owner, union or held custody without publishing partial candidate provenance',async()=>{
  const f=await fixture(true),p=await preparation(f);await complete(f,p);const linked=await recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input);
  const count=async()=>{const [row]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_agent_candidate`);return row.n;};const before=await count();
  await expect(createCanonicalSpecialistCandidate(f.mine.ctx,{module:'claims',version:1,nativeSignalIds:[linked.associationId]})).rejects.toThrow();
  await expect(createCanonicalSpecialistCandidate(f.peer.ctx,{module:'leave',version:1,nativeSignalIds:[linked.associationId]})).rejects.toThrow();
  await expect(createCanonicalSpecialistCandidate(f.mine.ctx,{module:'leave',version:1,nativeSignalIds:[linked.associationId,linked.associationId]})).rejects.toThrow();
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
  const holder=owner.db.transaction(async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'native-outcome:v1:'+base.tenantId+':'+f.mine.ctx.userId},0))`);entered();await resume;});
  try{await started;await expect(createCanonicalSpecialistCandidate(f.mine.ctx,{module:'leave',version:1,nativeSignalIds:[linked.associationId]})).rejects.toThrow();expect(await count()).toBe(before);}finally{release();await holder;}
  expect((await createCanonicalSpecialistCandidate(f.mine.ctx,{module:'leave',version:1,nativeSignalIds:[linked.associationId]})).state).toBe('unevaluated');expect(await count()).toBe(before+1);
 });
});

/** Authored UNRUN: begin/finish carriers cannot become reusable canonical-source capabilities. */
it('refuses copied, different-person, cross-transaction and already finished provenance before native association work',async()=>{
 const f=await fixture(),p=await preparation(f);await complete(f,p);const before=await counts();
 await expect(withTenant(f.mine.ctx,async tx=>{const proof=await beginOwnNativeOutcomeJobProvenanceTx(tx,f.mine.ctx,p.job.jobId);await recordVerifiedNativeOutcomeAssociationTx(tx,f.mine.ctx,p.input,{...proof});})).rejects.toThrow();
 await expect(withTenant(f.mine.ctx,async tx=>{const proof=await beginOwnNativeOutcomeJobProvenanceTx(tx,f.mine.ctx,p.job.jobId);await recordVerifiedNativeOutcomeAssociationTx(tx,{...f.mine.ctx,personId:f.peer.ctx.personId},p.input,proof);})).rejects.toThrow();
 let old!:Awaited<ReturnType<typeof beginOwnNativeOutcomeJobProvenanceTx>>;
 await withTenant(f.mine.ctx,async tx=>{old=await beginOwnNativeOutcomeJobProvenanceTx(tx,f.mine.ctx,p.job.jobId);await finishNativeOutcomeJobRecheckTx(tx,f.mine.ctx,old);});
 await expect(withTenant(f.mine.ctx,tx=>recordVerifiedNativeOutcomeAssociationTx(tx,f.mine.ctx,p.input,old))).rejects.toThrow();
 await expect(withTenant(f.mine.ctx,async tx=>{const proof=await beginOwnNativeOutcomeJobProvenanceTx(tx,f.mine.ctx,p.job.jobId);await finishNativeOutcomeJobRecheckTx(tx,f.mine.ctx,proof);await recordVerifiedNativeOutcomeAssociationTx(tx,f.mine.ctx,p.input,proof);})).rejects.toThrow();
 expect(await counts()).toEqual(before);await recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input);expect((await counts()).links).toBe(before.links+1);
});

/** New actual source-capture regressions, authored UNRUN. */

it('captures own original PERSON and actual EMPLOYMENT privately with the canonical effect',async()=>{
 const f=await fixture(),p=await preparation(f),done=await complete(f,p);if(done.kind!=='completed')throw Error('Expected native completion');
 await expectNativeSourceCapture(p.review.actionId,done.receipt.submissionEventId,[{kind:'person',id:f.mine.subject.personId},{kind:'employment',id:f.mine.subject.employmentId}]);
 await expect(withTenant(f.mine.ctx,tx=>tx.execute(sql`select * from app.native_outcome_source_target`))).rejects.toThrow();
});
it('rolls canonical request/event/body state back on private capture failure, then performs one explicit retry',async()=>{
 const f=await fixture(),p=await preparation(f),before=await counts();
 await owner.db.execute(sql`create function app.fictional_native_capture_failure() returns trigger language plpgsql as $$begin raise exception 'fictional private capture failure';end$$`);
 await owner.db.execute(sql`create trigger fictional_native_capture_failure before insert on app.native_outcome_source_capture for each row execute function app.fictional_native_capture_failure()`);
 try{await expect(complete(f,p)).rejects.toThrow();expect(await counts()).toEqual(before);
  const [row]=await owner.db.execute<{state:string;bodies:number;captures:number}>(sql`select state,(select count(*)::int from app.assistant_own_leave_review_content where action_id=r.id) as bodies,(select count(*)::int from app.native_outcome_source_capture where source_id=r.id) as captures from app.assistant_own_leave_review r where id=${p.review.actionId}::uuid`);
  expect(row).toEqual({state:'awaiting_confirmation',bodies:1,captures:0});
 }finally{await owner.db.execute(sql`drop trigger fictional_native_capture_failure on app.native_outcome_source_capture`);await owner.db.execute(sql`drop function app.fictional_native_capture_failure()`);}
 await complete(f,p);expect((await counts()).requests).toBe(before.requests+1);
});
it('refuses learning for historical missing source capture while preserving canonical human completion reopening',async()=>{
 const f=await fixture(),p=await preparation(f);await complete(f,p);const before=await counts();
 await owner.db.execute(sql`delete from app.native_outcome_source_capture where source_id=${p.review.actionId}::uuid`);
 expect((await withTenant(f.mine.ctx,tx=>readCompletedOwnLeaveOutcomeTx(tx,f.mine.ctx,p.review.actionId))).completion.kind).toBe('completed');
 await expect(withTenant(f.mine.ctx,tx=>readCompletedNativeOutcomeTx(tx,f.mine.ctx,p.input.reference))).rejects.toThrow();
 await expect(recordOwnNativeOutcomeAssociation(f.mine.ctx,p.input)).rejects.toThrow(unavailable);expect(await counts()).toEqual(before);
});
it('rolls an already inserted private capture back if final native completion fails',async()=>{
 const f=await fixture(),p=await preparation(f),before=await counts();
 await owner.db.execute(sql`create function app.fictional_native_completion_failure() returns trigger language plpgsql as $$begin if NEW.state='completed' then raise exception 'fictional completion failure';end if;return NEW;end$$`);
 await owner.db.execute(sql`create trigger fictional_native_completion_failure before update on app.assistant_own_leave_review for each row execute function app.fictional_native_completion_failure()`);
 try{await expect(complete(f,p)).rejects.toThrow();expect(await counts()).toEqual(before);const [capture]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from app.native_outcome_source_capture where source_id=${p.review.actionId}::uuid`);expect(capture.n).toBe(0);}
 finally{await owner.db.execute(sql`drop trigger fictional_native_completion_failure on app.assistant_own_leave_review`);await owner.db.execute(sql`drop function app.fictional_native_completion_failure()`);}
 await complete(f,p);
});
/** The canonical writer stores an empty remark as NULL. The bounded slice binds the human's exact text
 * into the reviewed intent, so text the writer would normalise is handed to the full form instead. */
it('hands an empty employee remark to the full Leave form without storing a review, and prepares once it is absent',async()=>{
 const f=await fixture(),nomination=nominationFor(f),selection={employmentId:nomination.employmentId,leaveTypeId:nomination.leaveTypeId};
 const reviews=async()=>(await owner.db.execute<{n:number}>(sql`select count(*)::int as n from app.assistant_own_leave_review`))[0].n,before=await reviews();
 expect(await withTenant(f.mine.ctx,tx=>prepareOwnLeaveReviewTx(tx,f.mine.ctx,nomination,selection,{reason:'Fictional HUMAN PRIVATE REASON',employeeRemark:''},'en'))).toEqual({kind:'use_leave_form'});
 expect(await reviews()).toBe(before);
 expect((await withTenant(f.mine.ctx,tx=>prepareOwnLeaveReviewTx(tx,f.mine.ctx,nomination,selection,{reason:'Fictional HUMAN PRIVATE REASON'},'en'))).kind).toBe('prepared');
 expect(await reviews()).toBe(before+1);
});
