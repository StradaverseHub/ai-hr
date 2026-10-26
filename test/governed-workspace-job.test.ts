/** Actual metadata command + read-only replay acceptance, authored UNRUN. No provider or model facts. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import * as reads from '../core/read';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {runGovernedModuleReadPlan,reopenGovernedModuleReadJobTx} from '../core/module-agent-releases';
import {loadAiWorkspace} from '../core/ai-workspace';
import {decryptSecret,encryptSecret} from '../lib/ai/crypto';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-governed-job-secret');await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});
async function fixture(){const admin=adminCtx(base);
 const make=async(name:string)=>{const subject=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const userId=await createAppUser(base.tenantId,subject.personId,'employee');await grantAssistant(admin,{appUserId:userId});
  const ctx:SessionContext={...await entitledCtx(base,['employee']),userId,personId:subject.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};return {ctx,subject};};
 return {admin,mine:await make('Canonical governed caller'),peer:await make('PRIVATE_OTHER_CALLER')};}
const plan={version:1,modules:['employees','ess']};
const reopen=(ctx:SessionContext,id:string)=>withTenant(ctx,async tx=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);return reopenGovernedModuleReadJobTx(tx,ctx,id);});
async function count(){const [row]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_agent_job_receipt`);return row.n;}
describe('human-invoked current-user governed jobs',()=>{
 it('saves baseline metadata without HR rows and reuses the same owner/nonce/plan after a lost redirect',async()=>{
  const f=await fixture(),nonce=randomUUID();const first=await runGovernedModuleReadPlan(f.mine.ctx,plan,{nonce});
  const second=await runGovernedModuleReadPlan(f.mine.ctx,plan,{nonce});expect(first.mode).toBe('baseline');expect(second).toMatchObject({jobId:first.jobId,mode:'baseline',replayed:true});expect(await count()).toBe(1);
  await expect(runGovernedModuleReadPlan(f.mine.ctx,{version:1,modules:['employees']},{nonce})).rejects.toThrow('Agent review could not be confirmed.');expect(await count()).toBe(1);
  const [row]=await owner.db.execute<{id:string;receipt:string;request_nonce:string;requested_plan_digest:string;promotion_id:string|null;expires_at:string;created_at:string}>(sql`select id,receipt,request_nonce,requested_plan_digest,promotion_id,expires_at::text,created_at::text from public.ai_agent_job_receipt where id=${first.jobId}::uuid`);
  expect(row.promotion_id).toBeNull();expect(row.request_nonce).toBe(nonce);expect(row.requested_plan_digest).toMatch(/^[a-f0-9]{64}$/);
  expect(new Date(row.expires_at).getTime()-new Date(row.created_at).getTime()).toBe(30*86400000);
  const plain=decryptSecret(row.receipt,JSON.stringify(['ai-hr.module-agent.v1','governed-job-v2',base.tenantId,first.jobId]));
  const proof=JSON.parse(plain);expect(proof).toMatchObject({version:2,stage:'completed',userId:f.mine.ctx.userId,requestedPlan:plan,executedPlan:plan});
  expect(proof).not.toHaveProperty('results');for(const text of ['Canonical governed caller','PRIVATE_OTHER_CALLER',f.mine.subject.employmentId,f.peer.subject.employmentId])expect(plain).not.toContain(text);
 });
 it('makes concurrent duplicate submissions at most one completed job rather than two successful-job receipts',async()=>{
  const f=await fixture(),nonce=randomUUID();const outcomes=await Promise.allSettled([runGovernedModuleReadPlan(f.mine.ctx,plan,{nonce}),runGovernedModuleReadPlan(f.mine.ctx,plan,{nonce})]);
  const successes=outcomes.filter((row):row is PromiseFulfilledResult<Awaited<ReturnType<typeof runGovernedModuleReadPlan>>>=>row.status==='fulfilled');expect(successes.length).toBeGreaterThan(0);expect(new Set(successes.map(row=>row.value.jobId)).size).toBe(1);expect(await count()).toBe(1);
 });
 it('refuses an actually held nonce interval before any job metadata is committed, then succeeds after release',async()=>{
  const f=await fixture(),nonce=randomUUID();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
  const holder=withTenant(f.mine.ctx,async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'agent-job:'+base.tenantId+':'+f.mine.ctx.userId+':'+nonce},0))`);entered();await resume;});
  try{await started;await expect(runGovernedModuleReadPlan(f.mine.ctx,plan,{nonce})).rejects.toThrow('Agent review could not be confirmed.');expect(await count()).toBe(0);}finally{release();await holder;}
  expect((await runGovernedModuleReadPlan(f.mine.ctx,plan,{nonce})).replayed).toBe(false);expect(await count()).toBe(1);
 });
 it('reopens on the same actual read-only backend, refreshes changed canonical values, and never writes or spends another permit',async()=>{
  const f=await fixture(),job=await runGovernedModuleReadPlan(f.mine.ctx,plan,{nonce:randomUUID()}),pids:number[]=[];
  const original=reads.myOwnEmploymentSubjectsTx;const spy=vi.spyOn(reads,'myOwnEmploymentSubjectsTx').mockImplementation(async(tx,current,...args)=>{
   const [row]=await tx.execute<{pid:number;readonly:string}>(sql`select pg_backend_pid() as pid,current_setting('transaction_read_only') as readonly`);expect(row.readonly).toBe('on');pids.push(row.pid);return original(tx,current,...args);
  });
  const first=await reopen(f.mine.ctx,job.jobId);expect(first.changedSinceRun).toBe(false);expect(new Set(pids).size).toBe(1);spy.mockRestore();
  await owner.db.update(schema.employment).set({employeeCode:'CHANGED-CANONICAL-CODE'}).where(eq(schema.employment.id,f.mine.subject.employmentId));
  const second=await reopen(f.mine.ctx,job.jobId);expect(second.changedSinceRun).toBe(true);expect(JSON.stringify(second.results)).toContain('CHANGED-CANONICAL-CODE');
  const workspace=await loadAiWorkspace(f.mine.ctx,{includeHistory:false,includeGovernance:false,governedJobId:job.jobId});
  expect(workspace.governedJob).toMatchObject({state:'ready',jobId:job.jobId,changedSinceRun:true});expect(JSON.stringify(workspace.governedJob)).not.toContain('receipt');expect(await count()).toBe(1);
 });
 it('has no cross-owner existence oracle and rechecks current grant/module authority before replay',async()=>{
  const f=await fixture(),job=await runGovernedModuleReadPlan(f.mine.ctx,plan,{nonce:randomUUID()});
  const missing=await reopen(f.peer.ctx,randomUUID()).catch(error=>error.message),foreign=await reopen(f.peer.ctx,job.jobId).catch(error=>error.message);expect(foreign).toBe(missing);
  await revokeAssistant(f.admin,{appUserId:f.mine.ctx.userId!});await expect(reopen(f.mine.ctx,job.jobId)).rejects.toThrow();
  await grantAssistant(f.admin,{appUserId:f.mine.ctx.userId!});vi.stubEnv('MODULE_KILL','employees');await expect(reopen(f.mine.ctx,job.jobId)).rejects.toThrow();expect(await count()).toBe(1);
 });
 it('refuses independently prepared expired metadata even when its encrypted owner/source binding is authentic',async()=>{
  const f=await fixture(),job=await runGovernedModuleReadPlan(f.mine.ctx,plan,{nonce:randomUUID()});
  const [row]=await owner.db.execute<{receipt:string}>(sql`select receipt from public.ai_agent_job_receipt where id=${job.jobId}::uuid`);
  const aad=JSON.stringify(['ai-hr.module-agent.v1','governed-job-v2',base.tenantId,job.jobId]),proof=JSON.parse(decryptSecret(row.receipt,aad));
  const expires=new Date(Date.now()-60000).toISOString(),created=new Date(Date.now()-30*86400000).toISOString();
  proof.expiresAt=expires;proof.createdAt=created;const receipt=encryptSecret(JSON.stringify(proof),aad);
  await owner.db.execute(sql`update public.ai_agent_job_receipt set created_at=${created}::timestamptz,expires_at=${expires}::timestamptz,receipt=${receipt} where id=${job.jobId}::uuid`);
  await expect(reopen(f.mine.ctx,job.jobId)).rejects.toThrow('Agent review could not be confirmed.');
 });
 it('keeps legacy v1 receipts audit-only, refuses forged bodies and rejects caller-supplied fact/scope fields',async()=>{
  const f=await fixture(),id=randomUUID();await owner.db.execute(sql`insert into public.ai_agent_job_receipt(id,tenant_id,user_id,promotion_id,receipt) values(${id}::uuid,${base.tenantId}::uuid,${f.mine.ctx.userId}::uuid,null,'legacy-v1-audit-only')`);
  await expect(reopen(f.mine.ctx,id)).rejects.toThrow('Agent review could not be confirmed.');
  const nonce=randomUUID();await expect(runGovernedModuleReadPlan(f.mine.ctx,{...plan,facts:{net:'MODEL_INVENTED'},companyId:base.companyId},{nonce})).rejects.toThrow();expect(await count()).toBe(1);
  const job=await runGovernedModuleReadPlan(f.mine.ctx,plan,{nonce});await owner.db.execute(sql`update public.ai_agent_job_receipt set receipt='POSTED_MODEL_PASS' where id=${job.jobId}::uuid`);await expect(reopen(f.mine.ctx,job.jobId)).rejects.toThrow('Agent review could not be confirmed.');
 });
});
