/** Actual durable governed module-plan lifecycle after WP11 deleted the typed routing candidate kind.
 * Module plans always run the requested baseline order; legacy typed routing rows stay stored, are never
 * applied, and expire through ordinary maintenance. No provider or model is involved. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as canonical from '../core/read';
import { hireEmployee } from '../core/org';
import { grantAssistant,revokeAssistant } from '../core/assistant-grant';
import { AGENT_MODULE_CODES } from '../lib/ai/module-agents';
import * as releases from '../core/module-agent-releases';
import { runGovernedModuleReadPlan,reopenGovernedModuleReadJobTx,maintainModuleAgentReleases } from '../core/module-agent-releases';
import { adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base } from './harness';
let base:Base,oldSecret:string|undefined;
beforeAll(async()=>{oldSecret=process.env.AI_CONFIG_SECRET;process.env.AI_CONFIG_SECRET='fictional-agent-receipt-unit-passphrase';await migrateTestDb();});
afterAll(async()=>{if(oldSecret===undefined)delete process.env.AI_CONFIG_SECRET;else process.env.AI_CONFIG_SECRET=oldSecret;await closeAll();});
beforeEach(async()=>{await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});
async function actors(){
 const admin=adminCtx(base);const make=async(name:string)=>{
  const hired=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,
   departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const userId=await createAppUser(base.tenantId,hired.personId,'hr_admin');await grantAssistant(admin,{appUserId:userId});
  return {...await entitledCtx(base,['hr_admin']),userId,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]} satisfies SessionContext;
 };
 return {author:await make('Fictional Candidate Author'),reviewer:await make('Fictional Independent Reviewer'),second:await make('Fictional Second Reviewer')};
}
const hex=(c:string)=>c.repeat(64);
/** A typed routing row exactly as a pre-WP11 installation may still hold it. Inserted on the owner
 * connection because no application path can create this kind any more. */
async function legacyRoutingPromotion(owner_user_id:string,approver:string,expired:boolean,version=1){
 const candidateId=randomUUID(),promotionId=randomUUID();
 await owner.db.execute(sql`insert into public.ai_agent_candidate(id,tenant_id,owner_user_id,author_user_id,module_code,version,kind,configuration,candidate_digest,baseline_digest,source_digest,engine_digest,policy_digest,input_digest)
  values(${candidateId}::uuid,${base.tenantId}::uuid,${owner_user_id}::uuid,${owner_user_id}::uuid,'assistant',${version},'typed_route_priority_v1',${JSON.stringify({kind:'typed_route_priority_v1',priority:[...AGENT_MODULE_CODES].reverse()})}::jsonb,${hex('a')},${hex('b')},${hex('c')},${hex('d')},${hex('e')},${hex('f')})`);
 await owner.db.execute(sql`insert into public.ai_agent_promotion(id,tenant_id,candidate_id,owner_user_id,module_code,approver_user_id,receipt,max_jobs,created_at,expires_at)
  values(${promotionId}::uuid,${base.tenantId}::uuid,${candidateId}::uuid,${owner_user_id}::uuid,'assistant',${approver}::uuid,'legacy-sealed-routing-receipt',5,
   now()-interval '2 hours',${expired?sql`now()-interval '1 hour'`:sql`now()+interval '1 hour'`})`);
 return {candidateId,promotionId};
}
describe('governed module plans after the routing kind was deleted',()=>{
 it('no longer exposes a routing candidate owner or a misleading rollback alias',()=>{
  for(const name of ['createRoutingAgentCandidate','evaluateRoutingAgentCandidate','promoteRoutingAgentCandidate','rollbackRoutingAgent'])expect(name in releases,name).toBe(false);
  expect(typeof releases.rollbackAssistantPromotion).toBe('function');
 });
 it('retains actual baseline specialist reads and nonce replay with no promotion',async()=>{
  const a=await actors(),nonce=randomUUID(),plan={version:1,modules:['employees','ess']},first=await runGovernedModuleReadPlan(a.author,plan,{nonce}),again=await runGovernedModuleReadPlan(a.author,plan,{nonce});
  expect(first.mode).toBe('baseline');expect(first.results.map(row=>row.module)).toEqual(plan.modules);expect(first.specialists.every(row=>row.work.mode==='baseline')).toBe(true);expect(again).toMatchObject({jobId:first.jobId,replayed:true});
  const reopened=await withTenant(a.author,async tx=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);return reopenGovernedModuleReadJobTx(tx,a.author,first.jobId);});expect(reopened.mode).toBe('baseline');
  const[count]=await owner.db.execute<{n:number;p:number}>(sql`select(select count(*)::int from public.ai_agent_job_receipt) as n,(select count(*)::int from public.ai_agent_promotion) as p`);expect(count).toEqual({n:1,p:0});expect(await maintainModuleAgentReleases(a.reviewer)).toEqual({retired:0,outcomeRegressed:0});
 });
 it('never applies a stored legacy routing promotion, keeps the row readable and retires it on expiry without deleting it',async()=>{
  const a=await actors(),live=await legacyRoutingPromotion(a.author.userId!,a.reviewer.userId!,false);
  // The requested order runs unchanged: a reversed legacy priority would have reordered these two modules.
  const job=await runGovernedModuleReadPlan(a.author,{version:1,modules:['employees','ess']},{nonce:randomUUID()});
  expect(job.mode).toBe('baseline');expect(job.results.map(row=>row.module)).toEqual(['employees','ess']);
  const [unused]=await owner.db.execute<{used:number;promotion:string|null}>(sql`select (select used_jobs from public.ai_agent_promotion where id=${live.promotionId}::uuid) as used,(select promotion_id::text from public.ai_agent_job_receipt where id=${job.jobId}::uuid) as promotion`);
  expect(unused).toEqual({used:0,promotion:null});
  const visible=await withTenant(a.reviewer,tx=>tx.execute<{kind:string}>(sql`select kind from public.ai_agent_candidate where id=${live.candidateId}::uuid`));expect(Array.from(visible)).toEqual([{kind:'typed_route_priority_v1'}]);
  // A promotion row's times are immutable (the permit trigger), so an already-expired legacy row is stored separately.
  const old=await legacyRoutingPromotion(a.author.userId!,a.reviewer.userId!,true,2);
  expect(await maintainModuleAgentReleases(a.reviewer)).toEqual({retired:1,outcomeRegressed:0});
  const [after]=await owner.db.execute<{expired:string|null;live:string|null;candidates:number;promotions:number}>(sql`select (select reason from public.ai_agent_rollback where promotion_id=${old.promotionId}::uuid) as expired,(select reason from public.ai_agent_rollback where promotion_id=${live.promotionId}::uuid) as live,(select count(*)::int from public.ai_agent_candidate) as candidates,(select count(*)::int from public.ai_agent_promotion) as promotions`);
  expect(after).toEqual({expired:'expired',live:null,candidates:2,promotions:2});
  expect(await maintainModuleAgentReleases(a.reviewer)).toEqual({retired:0,outcomeRegressed:0});
 });
 it('refuses a revoked caller without creating a promotion',async()=>{
  const a=await actors();await revokeAssistant(adminCtx(base),{appUserId:a.author.userId!});
  await expect(runGovernedModuleReadPlan(a.author,{version:1,modules:['employees']},{nonce:randomUUID()})).rejects.toThrow();
  const[count]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_agent_promotion`);expect(count.n).toBe(0);
 });
 it('keeps the actual baseline source interval ordered and releases it only on whole-command completion',async()=>{
  const a=await actors();let entered!:()=>void,release!:()=>void;const start=new Promise<void>(yes=>{entered=yes;}),resume=new Promise<void>(yes=>{release=yes;}),original=canonical.myOwnEmploymentSubjectsTx;let once=false;
  const source=vi.spyOn(canonical,'myOwnEmploymentSubjectsTx').mockImplementation(async(tx,ctx,...args)=>{if(!once&&ctx.userId===a.author.userId){once=true;entered();await resume;}return original(tx,ctx,...args);});
  const pending=runGovernedModuleReadPlan(a.author,{version:1,modules:['employees','ess']},{nonce:randomUUID()});void pending.catch(()=>undefined);
  try{await Promise.race([start,pending.then(()=>{throw Error('Expected actual source interval');})]);const owned=await withTenant(a.second,async tx=>{const[row]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'agent-release:'+base.tenantId+':'+a.author.userId},0)) as owned`);return row.owned;});expect(owned).toBe(false);}
  finally{release();source.mockRestore();await pending;}
 });
});
