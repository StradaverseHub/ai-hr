/** Owner decision, 11 Nov 2026 — wiring grantMandate: an HR administrator's own morning summary (the `daily_digest`
 * work job), started and stopped on Admin Today (core/digest/own-digest.ts) and prepared by the nightly sweep
 * (core/digest/run.ts runDueDailyDigests). Fictional data only.
 *
 *  1. Grant and stop: both are audited (teras-mandate.granted, teras-mandate.revoked), the grant runs for the tenant's
 *     validity ceiling with the job's own fixed shape, and both keys and the stop switch still apply.
 *  2. Who: a non-administrator is refused, in code and again in the database; an administrator of another company or
 *     another tenant can neither see nor stop someone else's summary, and a company administrator's digest counts only
 *     the companies they administer.
 *  3. Which jobs: only the morning summary is offered. The team absence summary is refused as not offered; decision
 *     jobs and everything that would decide pay, employment or access stay refused by the core.
 *  4. The sweep: a granted summary is prepared once per HR day and shown to its grantor; without a grant there is none. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import {terasMandate} from '../db/teras-schema';
import type {SessionContext} from '../db/client';
import {ensureAgentPrincipal} from '../core/agent-principal';
import {MandateRefused} from '../core/mandates/job-types';
import {grantMandate,revokeMandate,setJobTypeEnablement,setMandateStopSwitch} from '../core/mandates/mandates';
import {listOutcomeRecords} from '../core/outcome-record/record';
import {prepareDailyDigest} from '../core/digest/daily-digest';
import {JobNotOffered,OFFERED_JOB_TYPES,delegateOwnJob,offeredJobType,readMorningSummary,stopOwnJob} from '../core/digest/own-digest';
import {runDueDailyDigests} from '../core/digest/run';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,entitledCtx,eventTypesFor,latestEventPayload,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const JOB={jobType:'daily_digest'};
let b:Base,other:Base,group:SessionContext,companyAdmin:SessionContext,secondCompanyAdmin:SessionContext,manager:SessionContext,foreign:SessionContext;
let secondCompanyId:string,principalId:string;

/** A login with its own person and employment, holding exactly these grants. */
async function persona(base:Base,name:string,grants:{role:'hr_admin'|'manager'|'employee';companyId:string|null}[]):Promise<SessionContext>{
 const [p]=await owner.db.insert(schema.person).values({tenantId:base.tenantId,fullName:name,primaryEmail:`${randomUUID()}@fixture.test`}).returning({id:schema.person.id});
 await owner.db.insert(schema.employment).values({tenantId:base.tenantId,personId:p.id,companyId:base.companyId,employeeCode:`MS-${randomUUID().slice(0,6)}`,hiredOn:'2020-01-01'});
 const [u]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:`user_${randomUUID()}`,personId:p.id}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values(grants.map(g=>({tenantId:base.tenantId,appUserId:u.id,companyId:g.companyId,role:g.role})));
 const roles=[...new Set(grants.map(g=>g.role))];
 return {...await entitledCtx(base,roles),userId:u.id,personId:p.id,roles,grants};
}
async function refusal(promise:Promise<unknown>):Promise<unknown>{return promise.then(()=>null,(error:unknown)=>error);}
async function refused(promise:Promise<unknown>,reason:string){const error=await refusal(promise);expect(error).toBeInstanceOf(MandateRefused);expect((error as MandateRefused).reason).toBe(reason);}
const mandatesOf=(ctx:SessionContext)=>owner.db.select().from(terasMandate).where(and(eq(terasMandate.tenantId,ctx.tenantId),eq(terasMandate.grantorUserId,ctx.userId!)));
const sweep=async(now?:Date)=>runDueDailyDigests({tenantId:b.tenantId,principalId,entitlements:(await entitledCtx(b)).entitlements!,now});

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();other=await seedBase();
 // A sibling, not a subsidiary: an administrator of a parent company also administers its subsidiaries.
 const [second]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Second Company Sdn Bhd'}).returning({id:schema.company.id});
 secondCompanyId=second.id;
 group=await persona(b,'Fictional Group Administrator',[{role:'hr_admin',companyId:null}]);
 companyAdmin=await persona(b,'Fictional Company Administrator',[{role:'hr_admin',companyId:b.companyId}]);
 secondCompanyAdmin=await persona(b,'Fictional Second Company Administrator',[{role:'hr_admin',companyId:secondCompanyId}]);
 manager=await persona(b,'Fictional Line Manager',[{role:'manager',companyId:null}]);
 foreign=await persona(other,'Fictional Other Tenant Administrator',[{role:'hr_admin',companyId:null}]);
 principalId=await ensureAgentPrincipal(owner.db,b.tenantId);
});

describe('morning summary: grant and stop',()=>{
 it('is offered only after a group administrator allows it, and grants and stops with audit rows',async()=>{
  expect(await readMorningSummary(companyAdmin)).toEqual({offered:false,stopped:false,mandate:null,prepared:null});
  await refused(delegateOwnJob(companyAdmin,JOB),'not_enabled');
  await setJobTypeEnablement(group,{jobType:'daily_digest',enabled:true,maxValidityDays:60,maxRunsPerDay:1});
  expect(await readMorningSummary(companyAdmin)).toMatchObject({offered:true,mandate:null});
  const now=new Date();
  const mandate=await delegateOwnJob(companyAdmin,JOB,now);
  // The job's own fixed shape, for the tenant's ceiling: the grantor's own items, once a day.
  expect(mandate).toMatchObject({jobType:'daily_digest',grantorUserId:companyAdmin.userId,grantorPersonId:companyAdmin.personId,scope:{team:'self'},
   limits:{maxRunsPerDay:1,maxPeople:1},schedule:{daily:true},notify:'daily_summary',revokedAt:null});
  expect(mandate.validUntil.getTime()-now.getTime()).toBe(60*86_400_000);
  expect(await eventTypesFor(b.tenantId,mandate.id)).toEqual(['teras-mandate.granted']);
  expect(await latestEventPayload(b.tenantId,mandate.id,'teras-mandate.granted')).toMatchObject({jobType:'daily_digest',scope:{team:'self'},notify:'daily_summary'});
  expect(await readMorningSummary(companyAdmin)).toMatchObject({offered:true,mandate:{id:mandate.id},prepared:null});
  // One in force at a time.
  await refused(delegateOwnJob(companyAdmin,JOB),'already_granted');
  const stopped=await stopOwnJob(companyAdmin,JOB);
  expect(stopped).toMatchObject({id:mandate.id,revokedBy:'grantor',revokedByUserId:companyAdmin.userId});
  expect(await eventTypesFor(b.tenantId,mandate.id)).toEqual(['teras-mandate.granted','teras-mandate.revoked']);
  expect(await readMorningSummary(companyAdmin)).toMatchObject({mandate:null});
  await refused(stopOwnJob(companyAdmin,JOB),'not_found');
  // Started again after a stop: a new mandate, its own audit trail.
  const again=await delegateOwnJob(companyAdmin,JOB);
  expect(again.id).not.toBe(mandate.id);
  expect(await eventTypesFor(b.tenantId,again.id)).toEqual(['teras-mandate.granted']);
 });

 it('is refused while the tenant stop switch is on, and not offered then',async()=>{
  await setJobTypeEnablement(group,{jobType:'daily_digest',enabled:true});
  await setMandateStopSwitch(group,true);
  expect(await readMorningSummary(companyAdmin)).toMatchObject({offered:false,stopped:true});
  await refused(delegateOwnJob(companyAdmin,JOB),'stopped');
  expect(await mandatesOf(companyAdmin)).toEqual([]);
 });
});

describe('morning summary: who may start it',()=>{
 beforeEach(async()=>{await setJobTypeEnablement(group,{jobType:'daily_digest',enabled:true});});

 it('refuses a non-administrator, in code and in the database',async()=>{
  await refused(delegateOwnJob(manager,JOB),'not_administrator');
  // A session that claims the administrator role the database does not hold is refused inside the grant's transaction.
  await refused(delegateOwnJob({...manager,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},JOB),'not_administrator');
  await refused(grantMandate(manager,{...JOB,scope:{team:'self'},limits:{maxRunsPerDay:1,maxPeople:1},schedule:{daily:true},notify:'daily_summary',validDays:1},new Date(),{requireAdministrator:true}),'not_administrator');
  await refused(delegateOwnJob({...companyAdmin,personId:undefined},JOB),'not_administrator');
  await refused(delegateOwnJob({...companyAdmin,agent:{principalId,enablements:[]}},JOB),'not_administrator');
  expect(await mandatesOf(manager)).toEqual([]);
 });

 it('keeps another company and another tenant out of someone else\'s summary',async()=>{
  const mandate=await delegateOwnJob(companyAdmin,JOB);
  // The administrator of another company in the same group neither sees nor stops it, and has none of their own.
  expect(await readMorningSummary(secondCompanyAdmin)).toMatchObject({mandate:null});
  await refused(stopOwnJob(secondCompanyAdmin,JOB),'not_found');
  const sideways=await refusal(revokeMandate(secondCompanyAdmin,mandate.id));
  expect(sideways).toBeInstanceOf(MandateRefused);expect(['not_found','not_grantor']).toContain((sideways as MandateRefused).reason);
  // Another tenant's administrator: not found, and their tenant's job type is not allowed at all.
  await refused(revokeMandate(foreign,mandate.id),'not_found');
  expect(await readMorningSummary(foreign)).toEqual({offered:false,stopped:false,mandate:null,prepared:null});
  await refused(delegateOwnJob(foreign,JOB),'not_enabled');
  expect((await mandatesOf(companyAdmin))[0]).toMatchObject({id:mandate.id,revokedAt:null});
  // The summary covers only the companies the grantor administers.
  const own=await prepareDailyDigest(companyAdmin),wide=await prepareDailyDigest(group);
  expect(own.setup!.companies+own.setup!.unknown).toBe(1);
  expect(wide.setup!.companies+wide.setup!.unknown).toBe(2);
 });
});

describe('morning summary: which jobs',()=>{
 beforeEach(async()=>{await setJobTypeEnablement(group,{jobType:'team_absence_weekly_summary',enabled:true});});

 it('offers only the morning summary; every decision, pay, employment or access job stays refused',async()=>{
  expect([...OFFERED_JOB_TYPES]).toEqual(['daily_digest']);
  expect(offeredJobType('daily_digest')).toBe('daily_digest');
  // A valid work job with nowhere to read its result yet: not offered, even though it is allowed in settings.
  const notOffered=await refusal(delegateOwnJob(group,{jobType:'team_absence_weekly_summary'}));
  expect(notOffered).toBeInstanceOf(JobNotOffered);expect((notOffered as JobNotOffered).reason).toBe('not_offered');
  for(const jobType of ['leave.approve','claims.approve'])await refused(delegateOwnJob(group,{jobType}),'decision_job');
  for(const jobType of ['pay.amount.change','payroll.inputs.apply','payroll.close','payroll.reprocess','employment.hire','employment.confirm','employment.terminate',
   'access.role.grant','access.role.revoke','access.permission.change','records.delete','leave.approve.own'])await refused(delegateOwnJob(group,{jobType}),'never_delegable');
  await refused(delegateOwnJob(group,{jobType:'anything.else'}),'unknown_job_type');
  await refused(delegateOwnJob(group,{jobType:42}),'invalid');
  await refused(stopOwnJob(group,{jobType:'employment.terminate'}),'never_delegable');
  expect(await mandatesOf(group)).toEqual([]);
 });
});

describe('morning summary: the nightly sweep',()=>{
 it('prepares a granted summary once a day for its grantor, and nothing without a grant',async()=>{
  await setJobTypeEnablement(group,{jobType:'daily_digest',enabled:true});
  // Nothing granted: nothing due, nothing recorded.
  expect(await sweep()).toEqual({due:0,prepared:0,stopped:0,failed:0,capped:false});
  const mandate=await delegateOwnJob(companyAdmin,JOB);
  const first=await sweep();
  expect(first).toEqual({due:1,prepared:1,stopped:0,failed:0,capped:false});
  const [record]=await listOutcomeRecords(companyAdmin,{mandateId:mandate.id});
  expect(record).toMatchObject({runKind:'mandate_run',authorityKind:'mandate',grantorUserId:companyAdmin.userId,outcomeKind:'prepared',humanInvolvement:'none'});
  const view=await readMorningSummary(companyAdmin);
  expect(view).toMatchObject({mandate:{id:mandate.id},prepared:{recordId:record.id,digest:{kind:'teras.daily_digest',asOf:todayInKualaLumpur()}}});
  expect(view.prepared!.digest.setup).not.toBeNull();
  // Nobody else gets it: another administrator, and the manager, have no summary.
  expect((await readMorningSummary(secondCompanyAdmin)).prepared).toBeNull();
  expect((await readMorningSummary(manager)).prepared).toBeNull();
  // Once per HR day: a second sweep finds nothing due and records nothing.
  expect(await sweep()).toEqual({due:0,prepared:0,stopped:0,failed:0,capped:false});
  expect(await listOutcomeRecords(companyAdmin,{mandateId:mandate.id})).toHaveLength(1);
  // Stopped: the next sweep does not prepare it, and Today no longer shows it.
  await stopOwnJob(companyAdmin,JOB);
  const tomorrow=new Date(Date.now()+86_400_000);
  expect(await sweep(tomorrow)).toEqual({due:0,prepared:0,stopped:0,failed:0,capped:false});
  expect(await readMorningSummary(companyAdmin)).toMatchObject({mandate:null,prepared:null});
 });

 it('chooses nothing while the job type is switched off or the stop switch is on',async()=>{
  await setJobTypeEnablement(group,{jobType:'daily_digest',enabled:true});
  await delegateOwnJob(companyAdmin,JOB);
  await setMandateStopSwitch(group,true);
  expect(await sweep()).toMatchObject({due:0,prepared:0});
  await setMandateStopSwitch(group,false);
  await setJobTypeEnablement(group,{jobType:'daily_digest',enabled:false});
  expect(await sweep()).toMatchObject({due:0,prepared:0});
  await setJobTypeEnablement(group,{jobType:'daily_digest',enabled:true});
  expect(await sweep()).toMatchObject({due:1,prepared:1});
 });

});
