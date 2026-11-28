/** Board 0735d1b7 — Security Center › Users › By Batch Send Invitation on the shared bulk-job kernel: real PostgreSQL,
 * real row security, real worker ticks (core/account-invitation-batch.ts, core/account-invitation-batch-job.ts,
 * core/auth.ts inviteActivationCandidate). The email provider is a fake that records what it was asked to send; nothing
 * leaves the test. All names and addresses are invented. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {inviteActivationCandidate,inviteUser,type AuthProvider} from '../core/auth';
import {InvitationBatchError,readInvitationBatch,readInvitationBatchCandidates,startInvitationBatch,startInvitationBatchRetry,
 type InvitationBatchResult} from '../core/account-invitation-batch';
import {accountInvitationBatchHandler} from '../core/account-invitation-batch-job';
import {requestBulkJobCancel} from '../core/bulk-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {bulkJobLaneOf} from '../core/bulk-job-lanes';
import {BULK_JOB_NOTICES} from '../lib/bulk-job';
import {AccountEmailDeliveryError} from '../lib/account-email-model';

const TAG='Zqbatch';
const FIRST_PAGE={limit:25,size:25 as const,after:undefined,before:undefined,last:false,exactCount:false};
type Fake=AuthProvider&{sent:string[];failFor:Set<string>};
function fakeProvider():Fake{
 const sent:string[]=[],failFor=new Set<string>();
 return {sent,failFor,
  sendInvitation:async(email:string)=>{if(failFor.has(email))throw new AccountEmailDeliveryError('relayUnavailable');sent.push(email);return {invitationId:`fake_${email}`};},
  revokeInvitation:async()=>{},sendPasswordReset:async()=>{},endSession:async()=>{},emailReadiness:async()=>null};
}

let b:Base,admin:SessionContext,provider:Fake;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();admin=adminCtx(b);provider=fakeProvider();});
afterEach(()=>vi.unstubAllEnvs());
afterAll(closeAll);

/** A person of tenant `base`, employed by default, with a work email. */
async function person(name:string,email:string,opts:{employed?:boolean;terminatedOn?:string;base?:Base}={}){
 const base=opts.base??b;
 const [p]=await owner.db.insert(schema.person).values({tenantId:base.tenantId,fullName:`${TAG} ${name}`,primaryEmail:email}).returning({id:schema.person.id});
 if(opts.employed!==false)await owner.db.insert(schema.employment).values({tenantId:base.tenantId,personId:p.id,companyId:base.companyId,
  employeeCode:`ZQ-${name.replace(/\W/g,'').slice(0,12)}`,hiredOn:'2024-01-01',...(opts.terminatedOn?{terminatedOn:opts.terminatedOn}:{})});
 return p.id;
}
const handler=()=>accountInvitationBatchHandler(provider);
const job=async(id:string)=>(await owner.client<{state:string;result:InvitationBatchResult|null;input:unknown;steps_done:number;error:string|null}[]>`
 select state,result,input,steps_done,error from bulk_job where id=${id}::uuid`)[0];
async function run(id:string,stop=(row:{state:string;steps_done:number})=>['completed','failed','cancelled'].includes(row.state),max=400){
 for(let i=0;i<max;i++){const row=await job(id);if(stop(row))return row;if(!await runBulkJobTick(owner.client,{handlers:[handler()]}))await new Promise(r=>setTimeout(r,30));}
 throw new Error('the batch did not reach the expected state');
}
const outcomeOf=(result:InvitationBatchResult|null,personId:string)=>result?.outcomes.find(o=>o.p===personId);
const invitations=(personId:string)=>owner.db.select().from(schema.appInvitation).where(eq(schema.appInvitation.personId,personId));
const appUserCount=async(tenantId:string)=>(await owner.client<{n:number}[]>`select count(*)::int as n from app_user where tenant_id=${tenantId}::uuid`)[0].n;
const eligibleIds=(ctx:SessionContext=admin,search=TAG)=>readInvitationBatchCandidates(ctx,{search,page:FIRST_PAGE});

describe('0735d1b7: registration on the kernel',()=>{
 it('registers the kind in the default lane with a completion notice',()=>{
  expect(BULK_JOB_HANDLERS.filter(h=>h.kind==='account_invitation_batch')).toHaveLength(1);
  expect(bulkJobLaneOf('account_invitation_batch')).toBe('default');
  expect(BULK_JOB_NOTICES.account_invitation_batch).toEqual({messages:'accountInvitationBatch',linkPath:'/admin/users/invitations/batch'});
 });
 it('has its bulk_job_kind row: tenant-exclusive, bounded input',async()=>{
  const [kind]=await owner.client<{exclusive:string;input_max_bytes:number;finalize_owner:boolean}[]>`select exclusive,input_max_bytes,finalize_owner from bulk_job_kind where kind='account_invitation_batch'`;
  expect(kind).toEqual({exclusive:'tenant',input_max_bytes:262144,finalize_owner:false});
 });
});

describe('0735d1b7: who can receive an invitation',()=>{
 it('lists Pending Activation people with the reason the ineligible ones cannot be ticked, and leaves out the rest',async()=>{
  const ready=await person('Ready One','ready.one@zq.test');
  const noEmail=await person('No Email','');
  // Another person already signs in with this email: the candidate cannot be invited with it.
  const holder=await person('Email Holder','shared@zq.test');await createAppUser(b.tenantId,holder,'employee');
  const clash=await person('Email Clash','Shared@zq.test');
  const invited=await person('Invited Already','invited@zq.test');
  await inviteUser(admin,{email:'invited@zq.test',role:'employee',personId:invited},provider);
  const left=await person('Left Company','left@zq.test',{terminatedOn:'2020-01-31'});
  const standalone=await person('No Employment','standalone@zq.test',{employed:false});
  const read=await eligibleIds();
  const byId=new Map(read.rows.map(r=>[r.id,r]));
  expect(byId.get(ready)?.ineligible).toBeNull();
  expect(byId.get(standalone)?.ineligible).toBeNull();
  expect(byId.get(noEmail)?.ineligible).toBe('noEmail');
  expect(byId.get(clash)?.ineligible).toBe('emailInUse');
  // A login, an open invitation and a leaver are not Pending Activation candidates at all.
  for(const gone of [holder,invited,left])expect(byId.has(gone)).toBe(false);
  expect(read.rows.map(r=>r.id).sort()).toEqual([ready,noEmail,clash,standalone].sort());
  expect(read.eligible).toEqual({count:2,capped:false});
  expect(read.total).toEqual({count:4,capped:false});
  // Ordered by name, then id.
  expect(read.rows.map(r=>r.name)).toEqual([...read.rows.map(r=>r.name)].sort((x,y)=>x<y?-1:x>y?1:0));
 });
 it('leaves out a person whose manual username and password setup is in progress',async()=>{
  for(const [k,v] of Object.entries({AUTH_PROVIDER:'internal',AUTH_PUBLIC_ORIGIN:'https://hr.test',AUTH_SESSION_KEY:'f'.repeat(64)}))vi.stubEnv(k,v);
  const issuer=`https://hr.test/auth/${b.tenantId}`;
  await owner.db.insert(schema.appExternalIdentity).values({issuer,subject:'zq-admin',appUserId:b.adminUserId});
  const setup=await person('Setup Running','setup@zq.test'),other=await person('Setup Free','free@zq.test');
  await owner.client`insert into app_manual_identity_enrollment(id,tenant_id,person_id,created_by,issuer,username,email,role,status)
   values(${randomUUID()}::uuid,${b.tenantId}::uuid,${setup}::uuid,${b.adminUserId}::uuid,${issuer},'setup.running','setup@zq.test','employee','reserved')`;
  const ids=(await eligibleIds()).rows.map(r=>r.id);
  expect(ids).toContain(other);expect(ids).not.toContain(setup);
  const result=await inviteActivationCandidate(admin,{personId:setup,role:'employee',companyId:null,emailLocale:'en',batchJobId:randomUUID()},provider);
  expect(result).toEqual({outcome:'skipped',reason:'setupInProgress'});
  expect(await invitations(setup)).toEqual([]);
 });
 it('refuses a company-scoped administrator everywhere',async()=>{
  const id=await person('Scoped Target','scoped.target@zq.test');
  const userId=await createAppUser(b.tenantId,null,'employee');
  await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:userId,companyId:b.companyId,role:'hr_admin'});
  const scoped:SessionContext={...admin,userId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
  await expect(readInvitationBatchCandidates(scoped,{page:FIRST_PAGE})).rejects.toMatchObject({code:'forbidden'});
  await expect(startInvitationBatch(scoped,{selection:'ids',personIds:[id],role:'employee',companyId:null,emailLocale:'en',expectedCount:1})).rejects.toMatchObject({code:'forbidden'});
  await expect(inviteActivationCandidate(scoped,{personId:id,role:'employee',companyId:null,emailLocale:'en',batchJobId:randomUUID()},provider)).rejects.toThrow(/group administrator/);
  expect(await invitations(id)).toEqual([]);
 });
});

describe('0735d1b7: admission freezes the population on the server',()=>{
 it('"Select all" invites exactly the eligible people at admission, not someone added afterwards',async()=>{
  const a=await person('All A','all.a@zq.test'),c=await person('All C','all.c@zq.test');await person('All No Email','');
  const before=await appUserCount(b.tenantId);
  const read=await eligibleIds();expect(read.eligible.count).toBe(2);
  await expect(startInvitationBatch(admin,{selection:'all',search:TAG,role:'employee',companyId:null,emailLocale:'ms',expectedCount:3}))
   .rejects.toMatchObject({code:'countChanged',count:2});
  const started=await startInvitationBatch(admin,{selection:'all',search:TAG,role:'manager',companyId:'group',emailLocale:'ms',expectedCount:2});
  expect(started).toMatchObject({count:2,dropped:0,existing:false});
  expect((await job(started.jobId)).input).toEqual({mode:'send',personIds:[a,c],role:'manager',emailLocale:'ms'});
  const late=await person('All Late','all.late@zq.test');
  const done=await run(started.jobId);
  expect(done.state).toBe('completed');
  expect(done.result?.outcomes.map(o=>[o.p,o.o])).toEqual([[a,'sent'],[c,'sent']]);
  expect(done.result?.counts).toEqual({sent:2,failed:0,skipped:0,uncertain:0});
  expect(provider.sent.sort()).toEqual(['all.a@zq.test','all.c@zq.test']);
  expect(await invitations(late)).toEqual([]);
  const [inv]=await invitations(a);
  expect(inv).toMatchObject({status:'pending',role:'manager',companyId:null,emailLocale:'ms',email:'all.a@zq.test'});
  // The audit event names the batch; a login is never created or enabled by an invitation.
  const [event]=await owner.client<{payload:{batchJobId?:string}}[]>`select payload from domain_event where aggregate_id=${inv.id}::uuid and event_type='app-user.invited'`;
  expect(event.payload.batchJobId).toBe(started.jobId);
  expect(await appUserCount(b.tenantId)).toBe(before);
  expect((await job(started.jobId)).input).toBeNull();
 },120_000);
 it('drops a ticked person who is no longer eligible and refuses a forged count',async()=>{
  const a=await person('Ids A','ids.a@zq.test'),gone=await person('Ids Gone','ids.gone@zq.test');
  await createAppUser(b.tenantId,gone,'employee');
  await expect(startInvitationBatch(admin,{selection:'ids',personIds:[a,gone],role:'employee',companyId:null,emailLocale:'en',expectedCount:1}))
   .rejects.toMatchObject({code:'countChanged'});
  const started=await startInvitationBatch(admin,{selection:'ids',personIds:[a,gone],role:'employee',companyId:null,emailLocale:'en',expectedCount:2});
  expect(started).toMatchObject({count:1,dropped:1});
  expect((await job(started.jobId)).input).toMatchObject({personIds:[a]});
  await expect(startInvitationBatch(admin,{selection:'ids',personIds:[gone],role:'employee',companyId:null,emailLocale:'en',expectedCount:1}))
   .rejects.toMatchObject({code:'empty'});
  await expect(startInvitationBatch(admin,{selection:'ids',personIds:[a],role:'operator',companyId:null,emailLocale:'en',expectedCount:1}))
   .rejects.toMatchObject({code:'invalid'});
 });
 it('allows one active batch per tenant',async()=>{
  const a=await person('One A','one.a@zq.test'),c=await person('One C','one.c@zq.test');
  await startInvitationBatch(admin,{selection:'ids',personIds:[a],role:'employee',companyId:null,emailLocale:'en',expectedCount:1});
  await expect(startInvitationBatch(admin,{selection:'ids',personIds:[c],role:'employee',companyId:null,emailLocale:'en',expectedCount:1}))
   .rejects.toMatchObject({code:'running'});
 });
});

describe('0735d1b7: each person is checked again when the worker reaches them',()=>{
 it('skips someone invited by another administrator meanwhile and an email taken meanwhile, records a delivery failure, and retries only the failures',async()=>{
  const a=await person('Run A','run.a@zq.test'),raced=await person('Run Raced','run.raced@zq.test');
  const twin1=await person('Run Twin One','twin@zq.test'),twin2=await person('Run Twin Two','twin@zq.test');
  const broken=await person('Run Broken','run.broken@zq.test');
  provider.failFor.add('run.broken@zq.test');
  const started=await startInvitationBatch(admin,{selection:'all',search:`${TAG} Run`,role:'employee',companyId:null,emailLocale:'en',expectedCount:5});
  // Another administrator invites one of them after admission.
  await inviteUser(admin,{email:'run.raced@zq.test',role:'employee',personId:raced},fakeProvider());
  const done=await run(started.jobId);
  expect(done.state).toBe('completed');
  expect(outcomeOf(done.result,a)).toMatchObject({o:'sent'});
  expect(outcomeOf(done.result,raced)).toMatchObject({o:'skipped',r:'alreadyInvited'});
  // The two people share an email: the first is invited, the second is skipped (5e0b2154).
  expect([outcomeOf(done.result,twin1)?.o,outcomeOf(done.result,twin2)?.o].sort()).toEqual(['sent','skipped']);
  expect([outcomeOf(done.result,twin1)?.r,outcomeOf(done.result,twin2)?.r]).toContain('emailInUse');
  const failed=outcomeOf(done.result,broken);
  expect(failed).toMatchObject({o:'failed',r:'relayUnavailable',d:expect.any(String)});
  expect(done.result?.counts).toEqual({sent:2,failed:1,skipped:2,uncertain:0});
  const [delivery]=await owner.db.select().from(schema.accountEmailDelivery).where(eq(schema.accountEmailDelivery.id,failed!.d!));
  expect(delivery).toMatchObject({status:'failed',lastError:'relayUnavailable'});
  // The results screen's read (creator only).
  const view=await readInvitationBatch(admin,{jobId:started.jobId,outcome:'failed'});
  expect(view.lines).toEqual([{personId:broken,name:`${TAG} Run Broken`,employeeCode:'ZQ-RunBroken',outcome:'failed',reason:'relayUnavailable'}]);
  expect(view.canRetry).toBe(true);
  // Retry failed only, with the relay back.
  provider.failFor.clear();const sentBefore=provider.sent.length;
  const retry=await startInvitationBatchRetry(admin,{jobId:started.jobId});
  expect(retry.count).toBe(1);
  const retried=await run(retry.jobId);
  expect(retried.result?.outcomes).toEqual([{p:broken,o:'sent',r:null,d:expect.any(String)}]);
  expect(provider.sent.slice(sentBefore)).toEqual(['run.broken@zq.test']);
  const rows=await invitations(broken);
  expect(rows.map(r=>r.status).sort()).toEqual(['pending','revoked']);
  await expect(startInvitationBatchRetry(admin,{jobId:started.jobId})).rejects.toMatchObject({code:'nothingToRetry'});
 },120_000);
 it('reports a re-run after a crash as not confirmed and never sends twice',async()=>{
  const a=await person('Crash A','crash.a@zq.test'),batchJobId=randomUUID();
  const first=await inviteActivationCandidate(admin,{personId:a,role:'employee',companyId:null,emailLocale:'en',batchJobId},provider);
  expect(first).toMatchObject({outcome:'sent',deliveryId:expect.any(String)});
  const again=await inviteActivationCandidate(admin,{personId:a,role:'employee',companyId:null,emailLocale:'en',batchJobId},provider);
  expect(again).toEqual({outcome:'uncertain',invitationId:first.invitationId,deliveryId:first.deliveryId,reason:'sent'});
  expect(provider.sent).toEqual(['crash.a@zq.test']);
  // Another batch (or a single invite) sees an ordinary open invitation.
  expect(await inviteActivationCandidate(admin,{personId:a,role:'employee',companyId:null,emailLocale:'en',batchJobId:randomUUID()},provider))
   .toEqual({outcome:'skipped',reason:'alreadyInvited'});
  expect(await invitations(a)).toHaveLength(1);
 });
 it('stops the steps not yet started when cancelled and keeps the outcomes so far',async()=>{
  const ids=[await person('Stop A','stop.a@zq.test'),await person('Stop B','stop.b@zq.test'),await person('Stop C','stop.c@zq.test'),await person('Stop D','stop.d@zq.test')];
  const started=await startInvitationBatch(admin,{selection:'ids',personIds:ids,role:'employee',companyId:null,emailLocale:'en',expectedCount:4});
  await run(started.jobId,row=>row.steps_done>=1);
  await requestBulkJobCancel(admin,started.jobId,'account_invitation_batch');
  const stopped=await run(started.jobId);
  expect(stopped.state).toBe('cancelled');
  const reached=stopped.result?.outcomes??[];
  expect(reached.length).toBeGreaterThanOrEqual(1);expect(reached.length).toBeLessThan(4);
  const invited=(await owner.db.select().from(schema.appInvitation).where(eq(schema.appInvitation.tenantId,b.tenantId))).filter(i=>ids.includes(i.personId!));
  expect(invited.map(i=>i.personId).sort()).toEqual(reached.map(o=>o.p).sort());
  expect(provider.sent).toHaveLength(reached.length);
 },120_000);
});

describe('0735d1b7: tenant isolation',()=>{
 it('another tenant\'s administrator cannot see the people, start a batch for them, or open the batch',async()=>{
  const other=await seedBase(),otherAdmin=adminCtx(other);
  const a=await person('Iso A','iso.a@zq.test');
  const started=await startInvitationBatch(admin,{selection:'ids',personIds:[a],role:'employee',companyId:null,emailLocale:'en',expectedCount:1});
  expect((await readInvitationBatchCandidates(otherAdmin,{search:TAG,page:FIRST_PAGE})).rows).toEqual([]);
  await expect(startInvitationBatch(otherAdmin,{selection:'ids',personIds:[a],role:'employee',companyId:null,emailLocale:'en',expectedCount:1}))
   .rejects.toMatchObject({code:'empty'});
  await expect(readInvitationBatch(otherAdmin,{jobId:started.jobId})).rejects.toBeInstanceOf(InvitationBatchError);
  await expect(startInvitationBatchRetry(otherAdmin,{jobId:started.jobId})).rejects.toMatchObject({code:'unavailable'});
  expect(await inviteActivationCandidate(otherAdmin,{personId:a,role:'employee',companyId:null,emailLocale:'en',batchJobId:randomUUID()},provider))
   .toEqual({outcome:'skipped',reason:'notCandidate'});
  await run(started.jobId);
  expect((await owner.db.select().from(schema.appInvitation).where(eq(schema.appInvitation.tenantId,other.tenantId))).length).toBe(0);
  expect((await invitations(a)).map(i=>i.tenantId)).toEqual([b.tenantId]);
  // A company of the other tenant cannot be the scope.
  const p=await person('Iso B','iso.b@zq.test');
  await expect(startInvitationBatch(admin,{selection:'ids',personIds:[p],role:'hr_admin',companyId:other.companyId,emailLocale:'en',expectedCount:1}))
   .rejects.toMatchObject({code:'invalid'});
  const [count]=await owner.client<{n:number}[]>`select count(*)::int as n from bulk_job where tenant_id=${other.tenantId}::uuid`;
  expect(count.n).toBe(0);
 },120_000);
});
