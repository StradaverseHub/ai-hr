/** ADR-0170 §3.13, §3.8 and §11.3 changes 5 and 6, step 5 — the agent registry on fictional data.
 *
 *  1. One contract: every automated worker is registered with family, trigger, read scope from the semantic
 *     model, effect, authority, switch, stop, record and metrics; a worker that cannot declare all of them is
 *     not registered and cannot run.
 *  2. Every switch is off by default; a disabled worker never runs; the tenant-wide stop switch halts all.
 *  3. Revocation of a mandate by the grantor's manager only where tenant policy allows it, in code and in SQL.
 *  4. The customer-facing outcome summary and registry export hold counts, families, decisions and opaque ids
 *     of this tenant only. */
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {terasMandate,terasWorkerControl} from '../db/teras-schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee,setReportingLine} from '../core/org';
import {ensureAgentPrincipal} from '../core/agent-principal';
import {MandateRefused} from '../core/mandates/job-types';
import {grantMandate,listMandates,renewMandate,revokeMandate,setJobTypeEnablement,setManagerRevocationPolicy,setMandateStopSwitch} from '../core/mandates/mandates';
import {runMandate} from '../core/mandates/run';
import {terasEntities} from '../core/semantic-model/generate';
import {buildRegistry,registeredWorkers,workerDeclarationProblems,WorkerNotRegistrable,type WorkerDeclaration} from '../core/agent-registry/workers';
import {registryGates,setWorkerSwitch,workerRunGate} from '../core/agent-registry/controls';
import {listWorkers,workerDetail} from '../core/agent-registry/views';
import {exportAgentRegistry,outcomeSummary} from '../core/agent-registry/export';
import {recommendLeaveDecision} from '../core/recommenders/leave-decision';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const root=new URL('../',import.meta.url).pathname;
const IDS=['payroll_anomaly_narrator','claims_triage','readiness_nudges','approval_chasers','review_chasers','clock_reminders','document_reminders','lifecycle_chasers',
 'approver_recommendation','explainers','conversation','team_absence_weekly_summary','daily_digest',
 // AI v2 W8: the five loops at the Prepare level (test/teras-loops.test.ts).
 'loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry',
 // AI v2 P2-2a: the Salary payroll loop (test/payroll-cycle-loops.test.ts). The Pre-salary loop is loop_payroll_inputs.
 'loop_salary_payroll'];

describe('one contract for every worker',()=>{
 it('registers every automated worker with every field, in one family, scoped by the semantic model',async()=>{
  const workers=registeredWorkers();
  expect(workers.map(worker=>worker.id)).toEqual(IDS);
  const entities=new Set(terasEntities().map(entity=>entity.id));
  for(const worker of workers){
   expect(workerDeclarationProblems(worker),worker.id).toEqual([]);
   expect(['watcher','chaser','preparer','decider','explainer']).toContain(worker.family);
   for(const entity of worker.readScope)expect(entities.has(entity),worker.id+' '+entity).toBe(true);
   for(const anchor of worker.owners){const [file,name]=anchor.split('#');expect(existsSync(root+file),anchor).toBe(true);
    expect(typeof (await import('../'+file.replace(/\.ts$/,'')))[name],anchor).toBe('function');}
  }
  // Nothing decides yet (step 5b); mandate workers are switched by their job type and recorded per run.
  expect(workers.filter(worker=>worker.family==='decider')).toEqual([]);
  expect(workers.filter(worker=>worker.authority.kind==='mandate').map(worker=>[worker.id,worker.switch.kind,worker.record.kind]))
   .toEqual([['team_absence_weekly_summary','job_type','mandate_runs'],['daily_digest','job_type','mandate_runs']]);
 });

 it('refuses a worker that cannot declare every field, or declares an effect its family may not have',()=>{
  const good=registeredWorkers().find(worker=>worker.id==='approver_recommendation')!;
  const copy=()=>structuredClone(good) as unknown as Record<string,unknown>;
  for(const field of ['id','label','family','owners','trigger','readScope','effect','authority','switch','stop','record','metrics']){
   const missing=copy();delete missing[field];
   expect(workerDeclarationProblems(missing),field).toContain(field);
   expect(()=>buildRegistry([missing]),field).toThrow(WorkerNotRegistrable);
  }
  expect(workerDeclarationProblems({...copy(),readScope:['not_an_entity']})).toContain('readScope');
  expect(workerDeclarationProblems({...copy(),readScope:[]})).toContain('readScope');
  expect(workerDeclarationProblems({...copy(),effect:'notify'})).toContain('effect');
  expect(workerDeclarationProblems({...copy(),family:'decider',effect:'complete_under_mandate'})).toContain('authority');
  expect(workerDeclarationProblems({...copy(),stop:{honoured:false,pending:''}})).toContain('stop');
  expect(workerDeclarationProblems({...copy(),metrics:{kind:'not_measurable',reason:' '}})).toContain('metrics');
  expect(workerDeclarationProblems({...copy(),trigger:{kind:'whenever',detail:'x'}})).toContain('trigger');
  expect(()=>buildRegistry([good,good])).toThrow(WorkerNotRegistrable);
  expect(buildRegistry([good as WorkerDeclaration])).toHaveLength(1);
 });
});

let b:Base,hr:SessionContext,manager:SessionContext,peerManager:SessionContext,report:SessionContext,principalId:string;
async function login(base:Base,name:string,role:'employee'|'manager'|'hr_admin'){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);
 return{...hired,ctx:{...await entitledCtx(base,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} as SessionContext};
}
const refused=async(promise:Promise<unknown>,reason:string)=>{const error=await promise.then(()=>null,(e:unknown)=>e);expect(error).toBeInstanceOf(MandateRefused);expect((error as MandateRefused).reason).toBe(reason);};
const pgText=(error:unknown)=>{const parts:string[]=[];for(let cur=error as Record<string,unknown>|undefined,n=0;cur&&typeof cur==='object'&&n<5;cur=cur.cause as never,n++)
 for(const key of ['message','detail'])if(typeof cur[key]==='string')parts.push(cur[key] as string);return parts.join(' | ');};
const TEAM={jobType:'team_absence_weekly_summary',scope:{team:'direct'},limits:{maxRunsPerDay:1,maxPeople:50},schedule:{weekday:1},notify:'daily_summary',validDays:30};

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 // The explainers switch checks the assistant module (core/agent-registry/controls.ts).
 await setModule(b.tenantId,'assistant','active');
 hr=(await login(b,'Fictional Registry Administrator','hr_admin')).ctx;
 const top=await login(b,'Fictional Senior Manager','manager');manager=top.ctx;
 const middle=await login(b,'Fictional Middle Manager','manager');peerManager=(await login(b,'Fictional Peer Manager','manager')).ctx;
 const worker=await login(b,'Fictional Registry Report','employee');report=worker.ctx;
 // The middle manager reports to the senior manager and manages the report.
 await setReportingLine(adminCtx(b),{subordinateEmploymentId:middle.employmentId,managerEmploymentId:top.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 await setReportingLine(adminCtx(b),{subordinateEmploymentId:worker.employmentId,managerEmploymentId:middle.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 middleCtx=middle.ctx;
 principalId=await ensureAgentPrincipal(owner.db,b.tenantId);
});
let middleCtx:SessionContext;

describe('switches and the stop switch',()=>{
 it('starts with every worker off, so a disabled worker never runs',async()=>{
  const gates=await registryGates(hr);
  expect(Object.keys(gates)).toEqual(IDS);
  for(const id of IDS)expect(gates[id],id).toEqual({run:false,reasons:['switched_off']});
  expect(await workerRunGate(hr,'not_a_registered_worker')).toEqual({run:false,reasons:['not_registered']});
  // The recommender asks its gate first and does nothing while off.
  expect(await recommendLeaveDecision(manager,{leaveRequestId:randomUUID()})).toEqual({kind:'unavailable',reason:'switched_off'});
  const rows=await listWorkers(hr);
  expect(rows.map(row=>[row.id,row.switch.on,row.lastRunAt])).toEqual(IDS.map(id=>[id,false,null]));
  expect(rows.find(row=>row.id==='approval_chasers')).toMatchObject({switch:{owner:'tenant_setting'},stopHonoured:false,metrics:{measured:false,acceptanceRate:null}});
  expect(rows.find(row=>row.id==='daily_digest')).toMatchObject({switch:{owner:'job_type'},stopHonoured:true,mandates:{active:0,total:0}});
 });

 it('changes only the switches it owns, and only for a group administrator',async()=>{
  await expect(setWorkerSwitch(manager,{workerId:'explainers',enabled:true})).rejects.toMatchObject({reason:'not_administrator'});
  await expect(setWorkerSwitch(hr,{workerId:'approval_chasers',enabled:true})).rejects.toMatchObject({reason:'not_switchable_here'});
  await expect(setWorkerSwitch(hr,{workerId:'daily_digest',enabled:true})).rejects.toMatchObject({reason:'not_switchable_here'});
  await expect(setWorkerSwitch(hr,{workerId:'invented',enabled:true})).rejects.toMatchObject({reason:'not_switchable_here'});
  const direct=await withTenant(manager,tx=>tx.insert(terasWorkerControl).values({tenantId:b.tenantId,workerId:'explainers',enabled:true,changedByUserId:manager.userId!})).then(()=>null,(e:unknown)=>e);
  expect(pgText(direct)).toMatch(/row-level security/i);
  expect(await setWorkerSwitch(hr,{workerId:'explainers',enabled:true})).toMatchObject({enabled:true,version:1});
  expect(await workerRunGate(hr,'explainers')).toEqual({run:true,reasons:[]});
  // Mandate workers are switched by key 1.
  await setJobTypeEnablement(hr,{jobType:'daily_digest',enabled:true});
  expect(await workerRunGate(hr,'daily_digest')).toEqual({run:true,reasons:[]});
 });

 it('halts every worker and every mandate with the one tenant-wide stop switch',async()=>{
  await setWorkerSwitch(hr,{workerId:'explainers',enabled:true});await setWorkerSwitch(hr,{workerId:'approver_recommendation',enabled:true});
  await setJobTypeEnablement(hr,{jobType:'team_absence_weekly_summary',enabled:true});
  const mandate=await grantMandate(middleCtx,TEAM);
  await setMandateStopSwitch(hr,true);
  const gates=await registryGates(hr);
  for(const id of IDS){expect(gates[id].run,id).toBe(false);expect(gates[id].reasons,id).toContain('stopped');}
  expect(await recommendLeaveDecision(manager,{leaveRequestId:randomUUID()})).toEqual({kind:'unavailable',reason:'stopped'});
  expect(await runMandate({tenantId:b.tenantId,principalId,entitlements:(await entitledCtx(b)).entitlements!,mandateId:mandate.id})).toMatchObject({status:'stopped',failed:['stop_switch']});
  expect((await listWorkers(hr)).every(row=>row.stopped)).toBe(true);
  // Workers whose run path cannot consult the stop yet say so, with the reason.
  for(const row of await listWorkers(hr))if(!row.stopHonoured)expect(row.stopPending,row.id).toMatch(/\w/);
  await setMandateStopSwitch(hr,false);
  expect((await workerRunGate(hr,'explainers')).run).toBe(true);
 });

 it('serves the Workers list and detail to group administrators only',async()=>{
  for(const ctx of [manager,report])await expect(listWorkers(ctx)).rejects.toMatchObject({reason:'not_administrator'});
  await expect(workerDetail(hr,'invented')).rejects.toMatchObject({reason:'not_found'});
  await setJobTypeEnablement(hr,{jobType:'team_absence_weekly_summary',enabled:true});
  const mandate=await grantMandate(middleCtx,TEAM);
  await runMandate({tenantId:b.tenantId,principalId,entitlements:(await entitledCtx(b)).entitlements!,mandateId:mandate.id});
  const detail=await workerDetail(hr,'team_absence_weekly_summary');
  expect(detail.worker).toMatchObject({id:'team_absence_weekly_summary',family:'preparer',effect:'prepare',switch:{on:true},mandates:{active:1,total:1}});
  expect(detail.worker.lastRunAt).toBeInstanceOf(Date);
  expect(detail.recentRuns).toHaveLength(1);expect(detail.recentRuns[0]).toMatchObject({outcomeKind:'prepared',mandateId:mandate.id});
  expect(detail.mandates).toEqual([expect.objectContaining({id:mandate.id,grantorUserId:middleCtx.userId,state:'active',agentIdentity:`mandate-agent:${mandate.agentIdentityId}`})]);
 });
});

describe('revocation by the grantor\'s manager',()=>{
 it('is refused while tenant policy does not allow it, then allowed only to the grantor\'s current manager',async()=>{
  await setJobTypeEnablement(hr,{jobType:'team_absence_weekly_summary',enabled:true});
  const mandate=await grantMandate(middleCtx,TEAM);
  // Policy off (the default): the manager cannot even see the mandate.
  await refused(revokeMandate(manager,mandate.id),'not_found');
  expect(await listMandates(manager)).toEqual([]);
  await refused(setManagerRevocationPolicy(manager,true),'not_administrator');
  await setManagerRevocationPolicy(hr,true);
  // Someone who is not the grantor's manager still cannot.
  await refused(revokeMandate(peerManager,mandate.id),'not_found');
  await refused(revokeMandate(report,mandate.id),'not_found');
  // The manager may revoke, not renew, and the database refuses a forged attribution.
  expect((await listMandates(manager)).map(row=>row.id)).toEqual([mandate.id]);
  await refused(renewMandate(manager,{mandateId:mandate.id,validDays:10}),'not_grantor');
  const forged=await withTenant(manager,tx=>tx.update(terasMandate).set({revokedAt:new Date(),revokedByUserId:manager.userId!,revokedBy:'administrator'}).where(eq(terasMandate.id,mandate.id))).then(()=>null,(e:unknown)=>e);
  expect(pgText(forged)).toMatch(/administrator|row-level security/i);
  const revoked=await revokeMandate(manager,mandate.id);
  expect(revoked).toMatchObject({revokedBy:'manager',revokedByUserId:manager.userId,version:2});
  expect(await runMandate({tenantId:b.tenantId,principalId,entitlements:(await entitledCtx(b)).entitlements!,mandateId:mandate.id})).toMatchObject({status:'stopped',failed:['mandate_in_force']});
  // Policy off again: a second mandate is out of the manager's reach once more.
  await setManagerRevocationPolicy(hr,false);
  const second=await grantMandate(middleCtx,TEAM);
  await refused(revokeMandate(manager,second.id),'not_found');
  const sql=await withTenant(manager,tx=>tx.update(terasMandate).set({revokedAt:new Date(),revokedByUserId:manager.userId!,revokedBy:'manager'}).where(eq(terasMandate.id,second.id)).returning());
  expect(sql).toEqual([]);
  expect((await listMandates(middleCtx)).find(row=>row.id===second.id)!.revokedAt).toBeNull();
 });
});

describe('customer-facing outcome summary and export',()=>{
 it('contains this tenant\'s registry and outcomes only, as counts, families, decisions and opaque ids',async()=>{
  await setJobTypeEnablement(hr,{jobType:'team_absence_weekly_summary',enabled:true});
  const mandate=await grantMandate(middleCtx,TEAM);
  const entitlements=(await entitledCtx(b)).entitlements!;
  await runMandate({tenantId:b.tenantId,principalId,entitlements,mandateId:mandate.id});
  // A second tenant with its own administrator, mandate and runs.
  const other=await seedBase();
  const otherHr=(await login(other,'Fictional Other Tenant Administrator','hr_admin')).ctx;
  const otherBoss=await login(other,'Fictional Other Tenant Manager','manager');
  const otherReport=await login(other,'Fictional Other Tenant Report','employee');
  await setReportingLine(adminCtx(other),{subordinateEmploymentId:otherReport.employmentId,managerEmploymentId:otherBoss.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
  await setJobTypeEnablement(otherHr,{jobType:'team_absence_weekly_summary',enabled:true});
  const otherMandate=await grantMandate(otherBoss.ctx,TEAM);
  await runMandate({tenantId:other.tenantId,principalId:await ensureAgentPrincipal(owner.db,other.tenantId),entitlements:(await entitledCtx(other)).entitlements!,mandateId:otherMandate.id});

  await expect(exportAgentRegistry(manager)).rejects.toMatchObject({reason:'not_administrator'});
  await expect(outcomeSummary(report)).rejects.toMatchObject({reason:'not_administrator'});
  // AI v2 W8: a loop is sponsored by the person who switched it on; one that is off has no sponsor.
  await setWorkerSwitch(hr,{workerId:'loop_probation_ending',enabled:true});
  const exported=await exportAgentRegistry(hr);
  expect(exported).toMatchObject({kind:'teras.agent_registry_export',version:1,tenantId:b.tenantId,adapters:{entraAgentId:null,googleAgentIdentity:null}});
  const sponsorOf=(workerId:string)=>exported.agents.find(agent=>agent.kind==='worker'&&agent.workerId===workerId)?.sponsor;
  expect(sponsorOf('loop_probation_ending')).toEqual({kind:'person',userId:hr.userId});
  expect(sponsorOf('loop_payroll_inputs')).toEqual({kind:'none'});
  expect(sponsorOf('payroll_anomaly_narrator')).toEqual({kind:'tenant_administrators'});
  expect(exported.agents.filter(agent=>agent.kind==='worker'&&agent.workerId.startsWith('loop_')&&agent.sponsor.kind==='tenant_administrators')).toEqual([]);
  // One identity per non-mandate worker, plus one per mandate, acting for its grantor; nothing autonomous.
  expect(exported.agents.filter(agent=>agent.kind==='worker').map(agent=>agent.workerId)).toEqual(IDS.filter(id=>!['team_absence_weekly_summary','daily_digest'].includes(id)));
  expect(exported.agents.filter(agent=>agent.kind==='mandate_agent')).toEqual([expect.objectContaining({agentId:`mandate-agent:${mandate.agentIdentityId}`,
   sponsor:{kind:'person',userId:middleCtx.userId},actsAs:'for_grantor',status:'enabled',family:'preparer'})]);
  expect(exported.agents.every(agent=>agent.autonomous===false)).toBe(true);
  expect(exported.outcomes).toMatchObject({tenantId:b.tenantId,records:1,byFamily:{preparer:1},
   mandates:[{mandateId:mandate.id,jobType:'team_absence_weekly_summary',runs:1,outcomeKinds:{prepared:1}}]});
  expect(exported.outcomes.byWorker).toEqual([expect.objectContaining({workerId:'team_absence_weekly_summary',family:'preparer',runs:1,humanInvolvement:{none:1},notice:{not_given:1}})]);
  const text=JSON.stringify(exported);
  for(const leak of [other.tenantId,otherMandate.id,otherMandate.agentIdentityId,otherBoss.ctx.userId!,otherHr.userId!])expect(text,leak).not.toContain(leak);
  for(const name of ['Fictional Middle Manager','Fictional Registry Report','Fictional Senior Manager'])expect(text).not.toContain(name);
  // And the other tenant sees only its own.
  const theirs=await exportAgentRegistry(otherHr);
  expect(theirs.outcomes.mandates.map(row=>row.mandateId)).toEqual([otherMandate.id]);
  expect(JSON.stringify(theirs)).not.toContain(mandate.id);
  });
});
