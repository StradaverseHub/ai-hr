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
import {runGovernedModuleReadPlan,readVerifiedOwnGovernedJobProvenanceTx} from '../core/module-agent-releases';
import {recordOwnNativeOutcomeAssociation,reopenOwnNativeOutcomeAssociation,eraseOwnNativeOutcomeAssociations} from '../core/module-native-outcomes';
import {readVerifiedNativeOutcomeAssociationTx,recordVerifiedNativeOutcomeAssociationTx} from '../core/module-native-outcome-references';
import {boundNativeOutcomeTransactionTx} from '../core/module-native-outcome-bounds';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-native-outcome-association-master-secret');await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});
async function fixture(){
 const admin=adminCtx(base);
 const make=async()=>{const subject=await hireEmployee(admin,{person:{fullName:'Fictional outcome applicant',primaryEmail:randomUUID()+'@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const userId=await createAppUser(base.tenantId,subject.personId,'employee');await grantAssistant(admin,{appUserId:userId});
  const ctx:SessionContext={...await entitledCtx(base,['employee']),userId,personId:subject.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  expect((await applyLeaveAdjustmentBatch(admin,{leaveTypeIds:[base.annualLeaveTypeId],days:10,effectiveOn:todayInKualaLumpur(),reason:'Fictional native outcome fixture opening credit',targetMode:'individual',employmentIds:[subject.employmentId]})).written).toBe(1);
  return{ctx,subject};};
 return{admin,mine:await make(),peer:await make()};
}
async function preparation(f:Awaited<ReturnType<typeof fixture>>){
 const job=await runGovernedModuleReadPlan(f.mine.ctx,{version:1,modules:['leave']},{nonce:randomUUID()});
 const date=new Date(todayInKualaLumpur()+'T00:00:00Z');do{date.setUTCDate(date.getUTCDate()+1);}while([0,6].includes(date.getUTCDay()));
 const nomination={action:'leave.apply' as const,contractVersion:1 as const,employmentId:f.mine.subject.employmentId,leaveTypeId:base.annualLeaveTypeId,date:date.toISOString().slice(0,10),durationType:'full_day' as const};
 const prepared=await withTenant(f.mine.ctx,tx=>prepareOwnLeaveReviewTx(tx,f.mine.ctx,nomination,{employmentId:nomination.employmentId,leaveTypeId:nomination.leaveTypeId},{reason:'Fictional HUMAN PRIVATE REASON',employeeRemark:''},'en'));
 if(prepared.kind!=='prepared')throw Error('Canonical fixture failed to prepare');
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
  const reference=await withTenant(f.mine.ctx,async tx=>{const provenance=await readVerifiedOwnGovernedJobProvenanceTx(tx,f.mine.ctx,p.job.jobId);return readVerifiedNativeOutcomeAssociationTx(tx,f.mine.ctx,linked.associationId,provenance);});
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
  await withTenant(f.mine.ctx,tx=>discardOwnLeaveReviewTx(tx,{actionId:p.review.actionId,contractVersion:p.review.contractVersion}));
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
  await expect(withTenant(f.mine.ctx,async tx=>{const proof=await readVerifiedOwnGovernedJobProvenanceTx(tx,f.mine.ctx,p.job.jobId);await recordVerifiedNativeOutcomeAssociationTx(tx,f.mine.ctx,p.input,proof);throw Error('injected caller rollback');})).rejects.toThrow('injected caller rollback');
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
