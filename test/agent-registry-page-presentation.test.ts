/** Authored UNRUN fictional native controls for the finite Workers service slice.
 * Product reads use actual app RRRO transactions. Owner inserts below construct bounded
 * read fixtures; they are not evidence for command/writer admission or installed custody. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as schema from '../db/schema';
import {terasLoopRun,terasOutcomeFollowup} from '../db/teras-schema';
import {agentStatuses,workersBuiltInStatusesTx} from '../core/control-domains';
import {workerAgreementPageRatesTx} from '../core/control-tower';
import {recordProposal} from '../core/agent-proposal';
import {registeredWorkers} from '../core/agent-registry/workers';
import {listWorkers,workerDetail,listWorkersPageTx,workerDetailPageTx,type WorkerRow,type WorkerDetail} from '../core/agent-registry/views';
import {outcomeSummary,outcomeSummaryPageTx} from '../core/agent-registry/export';
import {workerPageContextTx,workerPageSwitchesTx,setWorkerSwitch,type WorkerPageReadFacts} from '../core/agent-registry/controls';
import {agentSwitchStatesTx,agentContext,ensureAgentPrincipal} from '../core/agent-principal';
import {isModuleEnabled,resolveEntitlementsTx} from '../core/entitlements';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import {decodeStoredActiveAiProviderRow} from '../core/ai-provider-row';
import {saveAiProviderConfig} from '../core/ai-config';
import * as providerSnapshots from '../core/ai-provider-snapshot';
import * as governance from '../core/ai-governance';
import {setAiFeature} from '../core/ai-management';
import {grantMandate,setJobTypeEnablement,setMandateStopSwitch,revokeMandate} from '../core/mandates/mandates';
import {writeOutcomeRecord} from '../core/outcome-record/record';
import {hireEmployee,terminateEmployment} from '../core/org';
import {appendEvent} from '../db/events';
import {pgSqlState} from '../lib/db-error';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {anthropicAdapter} from '../lib/ai/providers/anthropic';
import {googleAdapter} from '../lib/ai/providers/google';
import {gatewayAdapter} from '../lib/ai/providers/gateway';
import {openrouterAdapter} from '../lib/ai/providers/openrouter';
import type {AiAdapter} from '../lib/ai/types';
import {observeNativeRead} from './helpers/native-read-observer';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,group:SessionContext;
const transport=vi.fn(),network=vi.fn();
beforeAll(migrateTestDb);
beforeEach(async()=>{
 for(const key of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY','OPENROUTER_API_KEY','AI_GATEWAY_API_KEY'])vi.stubEnv(key,'');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-workers-presentation-secret-0123456789');
 transport.mockClear();network.mockClear();
 const forbidden=async()=>{transport();throw new Error('No provider transport belongs to a Workers display read.');};
 for(const adapter of [openaiAdapter,anthropicAdapter,googleAdapter,gatewayAdapter,openrouterAdapter] as AiAdapter[]){
  vi.spyOn(adapter,'generate').mockImplementation(forbidden);vi.spyOn(adapter,'validate').mockImplementation(forbidden);
  if(adapter.converse)vi.spyOn(adapter,'converse').mockImplementation(forbidden);
  if(adapter.readImage)vi.spyOn(adapter,'readImage').mockImplementation(forbidden);
 }
 vi.stubGlobal('fetch',async()=>{network();throw new Error('No network belongs to this native read fixture.');});
 await resetDb();b=await seedBase();
 for(const code of ['assistant','payroll','claims'])await setModule(b.tenantId,code,'active');
 group={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}]};
});
afterEach(()=>{expect(transport).not.toHaveBeenCalled();expect(network).not.toHaveBeenCalled();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
afterAll(closeAll);

/** This fixture has no environment fallback. It obtains the existing active native row,
 * validates its real encrypted fictional key with the canonical CPU decoder and never
 * issues a governed configuration. This is a test premise, not a substitute product resolver. */
async function commonFacts(tx:Tx,ctx:SessionContext,at?:Date):Promise<WorkerPageReadFacts>{
 await assertAiPresentationPrincipalTx(tx,ctx);
 const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};
 const rows=await tx.execute<{provider:string;model:string;api_key_ciphertext:string;provider_options:unknown}>(sql`select provider,model,api_key_ciphertext,provider_options from app.ai_active_provider_config_v2()`);
 expect(rows.length).toBeLessThanOrEqual(1);
 let providerUsable=false;
 if(rows[0]){try{decodeStoredActiveAiProviderRow(rows[0],ctx.tenantId);providerUsable=true;}catch{/* CPU key refusal is an unavailable display, not an env fallback. */}}
 const [clock]=await tx.execute<{at:unknown}>(sql`select now()::text as at`);
 expect(clock).toMatchObject({at:expect.any(String)});
 if(typeof clock?.at!=='string')throw new Error('Expected the actual native timestamp text.');
 const nativeAt=new Date(clock.at);expect(Number.isFinite(nativeAt.getTime())).toBe(true);
 return {providerUsable,agentSwitches:await agentSwitchStatesTx(tx,fresh),at:at??nativeAt};
}
async function page(ctx=group,selected?:string,at?:Date){
 return withTenant(ctx,async tx=>{
  const facts=await commonFacts(tx,ctx,at),builtIns=await workersBuiltInStatusesTx(tx,ctx,facts.at),rows=await listWorkersPageTx(tx,ctx,facts);
  const summary=await outcomeSummaryPageTx(tx,ctx),detail=selected?await workerDetailPageTx(tx,ctx,selected,facts.at):null;
  return {facts,builtIns,rows,summary,detail};
 },{readOnlySnapshot:true});
}
const visibleRow=(r:WorkerRow)=>({id:r.id,label:r.label,family:r.family,trigger:r.trigger,effect:r.effect,authority:r.authority,switch:r.switch,
 stopped:r.stopped,stopHonoured:r.stopHonoured,gate:r.gate,lastRunAt:r.lastRunAt,mandates:r.mandates,
 metrics:{measured:r.metrics.measured,acceptanceRate:r.metrics.acceptanceRate,reversalRate:r.metrics.reversalRate,decided:r.metrics.decided}});
const visibleDetail=(v:WorkerDetail)=>({worker:{id:v.worker.id,label:v.worker.label},recentRuns:v.recentRuns.map(({mandateId:_unused,...run})=>run),
 mandates:v.mandates.map(m=>({id:m.id,state:m.state,validUntil:m.validUntil,revokedBy:m.revokedBy}))});
async function manager(){
 const hired=await hireEmployee(group,{person:{fullName:'Fictional Workers Grantor',primaryEmail:randomUUID()+'@workers.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,'manager');
 return {...group,userId,personId:hired.personId,roles:['manager'],grants:[{role:'manager',companyId:null}]} satisfies SessionContext;
}
async function proposal(type:'anomaly_narration'|'input_triage'|'readiness_fix',decision?:'approved'|'declined'){
 const id=await recordProposal(group,{type,facts:{fixture:true},proposal:{fixture:true},adjudication:{ok:true},...(decision?{decision}:{})});expect(id).not.toBeNull();return id!;
}
async function outcome(identity:string,at:Date,tool?:string,ctx=group,privateToAsker=false){
 return writeOutcomeRecord(ctx,{runId:randomUUID(),runKind:'turn',startedAt:at,finishedAt:new Date(at.getTime()+1),authority:{kind:'person',askedByUserId:ctx.userId!},
  agentIdentity:identity,reads:tool?[{tool,status:'read'}]:[],checks:[],replay:{model:null,provider:null,instructionSet:null,specVersion:null,specDigest:null,toolCatalogue:null},
  outcomeKind:'suggested',outcome:{fixture:true},humanInvolvement:'none',notice:'not_applicable',privateToAsker});
}
async function populated(){
 await saveAiProviderConfig(group,{provider:'openai',model:'fictional-workers-model',apiKey:'fictional-workers-key-never-sent',makeActive:true});
 await setModule(b.tenantId,'claims','active');await setAiFeature(group,'claims_triage',true);
 await setWorkerSwitch(group,{workerId:'explainers',enabled:true});await setWorkerSwitch(group,{workerId:'approver_recommendation',enabled:true});
 const origin=new Date(Date.now()-60_000);
 await proposal('anomaly_narration','approved');await proposal('anomaly_narration','declined');await proposal('input_triage');await proposal('readiness_fix','approved');
 const recommended=await outcome('worker.approver_recommendation',origin);
 // Bounded owner read fixture, not a bypass exercised by the product writer. This file tests the read arithmetic.
 await owner.db.insert(terasOutcomeFollowup).values([{tenantId:b.tenantId,recordId:recommended.id,kind:'decision',decision:'accepted',humanInvolvement:'decided',byUserId:group.userId,at:new Date(origin.getTime()+2)},
  {tenantId:b.tenantId,recordId:recommended.id,kind:'undo',decision:'undone',humanInvolvement:'decided',byUserId:group.userId,at:new Date(origin.getTime()+3)}]);
 await outcome('teras.assistant',new Date(origin.getTime()+10),'explain_leave_entitlement');
 await outcome('teras.assistant',new Date(origin.getTime()+20),'fictional_unregistered_tool');
 const loopIds=['loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry','loop_salary_payroll','loop_payroll_audit'] as const;
 for(const worker of registeredWorkers()){
  const record=worker.record;
  if(record.kind==='domain_event')await withTenant(group,tx=>appendEvent(tx,{tenantId:b.tenantId,aggregateType:'workers-fixture',aggregateId:b.tenantId,eventType:record.eventType,
   actor:{type:'user',id:group.userId!},payload:{...(record.source?{source:record.source}:{})}}));
  const loopId=loopIds.find(id=>id===worker.id);
  if(record.kind==='loop_runs'&&!loopId)throw new Error('Extend the independent loop read fixtures.');
  if(record.kind==='loop_runs'&&loopId)await owner.db.insert(terasLoopRun).values({tenantId:b.tenantId,runId:randomUUID(),workerId:loopId,
   companyId:b.companyId,status:'ran',sponsorUserId:group.userId,loopVersion:'fictional-worker-read',startedAt:origin,finishedAt:origin,checks:[],reads:[]});
 }
 await setJobTypeEnablement(group,{jobType:'team_absence_weekly_summary',enabled:true});await setJobTypeEnablement(group,{jobType:'daily_digest',enabled:true});
 const grantor=await manager(),weekly=await grantMandate(grantor,{jobType:'team_absence_weekly_summary',scope:{team:'direct'},limits:{maxRunsPerDay:1,maxPeople:50},schedule:{weekday:1},notify:'daily_summary',validDays:30});
 const daily=await grantMandate(grantor,{jobType:'daily_digest',scope:{team:'self'},limits:{maxRunsPerDay:1,maxPeople:1},schedule:{daily:true},notify:'daily_summary',validDays:30});
 const principal=await ensureAgentPrincipal(owner.db,b.tenantId),agent=agentContext(b.tenantId,principal,group.entitlements!);
 for(const m of [weekly,daily])await writeOutcomeRecord(agent,{runId:randomUUID(),runKind:'mandate_run',startedAt:origin,finishedAt:origin,authority:{kind:'mandate',mandateId:m.id,mandateVersion:m.version,grantorUserId:grantor.userId!},
  agentIdentity:`mandate-agent:${m.agentIdentityId}`,reads:[],checks:[],replay:{model:null,provider:null,instructionSet:null,specVersion:null,specDigest:null,toolCatalogue:null},outcomeKind:'prepared',outcome:{fixture:true},humanInvolvement:'none',notice:'not_given'});
 group={...group,entitlements:(await entitledCtx(b)).entitlements};
 return {origin,grantor,weekly,daily,recommended};
}

it('matches the legacy visible registry/summary/detail fields for all20 workers and five record families',async()=>{
 await populated();const full=await listWorkers(group),summary=await outcomeSummary(group),result=await page();
 expect(result.rows).toEqual(full.map(visibleRow));expect(result.rows).toHaveLength(20);expect(result.summary).toEqual({records:summary.records,byFamily:summary.byFamily});
 for(const id of ['payroll_anomaly_narrator','approval_chasers','conversation','team_absence_weekly_summary','loop_payroll_audit']){
  const baseline=await workerDetail(group,id),current=await page(group,id);expect(current.detail).toEqual(visibleDetail(baseline));
 }
 expect(result.rows.find(r=>r.id==='payroll_anomaly_narrator')?.metrics).toEqual({measured:true,acceptanceRate:0.5,reversalRate:null,decided:2});
 expect(result.rows.find(r=>r.id==='approver_recommendation')?.metrics).toEqual({measured:true,acceptanceRate:1,reversalRate:1,decided:1});
});

it('executes one native checkout in RRRO and batches actual last-run/control/job reads without issuing a provider',async()=>{
 await populated();const issued=vi.spyOn(providerSnapshots,'resolveAiProviderSnapshotTx'),governed=vi.spyOn(governance,'governedAiConfig'),probe=observeNativeRead();
 try{
  const result=await page();expect(result.rows).toHaveLength(20);expect(issued).not.toHaveBeenCalled();expect(governed).not.toHaveBeenCalled();
  expect(probe.properties).toHaveLength(1);expect(probe.properties[0]).toMatchObject({role:'ai_hr_app',isolation:'repeatable read',readOnly:true});expect(probe.state).toEqual({active:0,maxActive:1});
  const aggregate=probe.queries.filter(q=>q.sql.includes('max(')&&q.sql.includes('filter(where'));
  expect(aggregate).toHaveLength(5);expect(new Set(aggregate.flatMap(q=>registeredWorkers().filter(w=>q.params.includes(w.id)).map(w=>w.id))).has('loop_payroll_audit')).toBe(true);
  expect(probe.queries.filter(q=>q.sql.includes('from "teras_worker_control"'))).toHaveLength(1);
  expect(probe.queries.filter(q=>q.sql.includes('from "teras_mandate_job_type_enablement"'))).toHaveLength(1);
  expect(probe.queries.filter(q=>q.sql.includes('from "teras_mandate_control"'))).toHaveLength(1);
  const listPayload=probe.queries.filter(q=>q.sql.includes('from "teras_mandate"'));expect(listPayload).toHaveLength(1);expect(listPayload[0].sql).not.toContain('"scope"');
 }finally{probe.restore();}
});

it('reads only the four visible built-ins and preserves their independent expected reasons',async()=>{
 const baseline=await agentStatuses(group),probe=observeNativeRead();
 try{
  const rows=await withTenant(group,tx=>workersBuiltInStatusesTx(tx,group,new Date()),{readOnlySnapshot:true});
  expect(rows).toEqual(baseline.filter(row=>['detectors','sweep','actions','autonomy'].includes(row.id)));
  expect(rows.map(row=>row.id)).toEqual(['detectors','sweep','actions','autonomy']);expect(rows.find(row=>row.id==='sweep')).toMatchObject({active:false,reasonKey:'sweepNever'});
  expect(rows.find(row=>row.id==='autonomy')).toMatchObject({active:false,offByDesign:true,reasonKey:'autonomyByDesign'});
  expect(probe.queries.filter(q=>q.sql.includes('payroll_anomaly_verdict'))).toHaveLength(1);
  for(const q of probe.queries)expect(q.sql).not.toMatch(/ai_active_provider|payroll_anomaly_finding|assistant_grant|domain_event/);
 }finally{probe.restore();}
});

it('omits agreement closure classification, blockers/provider work and summary follow-up reads on their actual page purposes',async()=>{
 await populated();const probe=observeNativeRead();
 try{
  await withTenant(group,async tx=>{
   await workerAgreementPageRatesTx(tx,group,['anomaly_narration','input_triage','readiness_fix']);await outcomeSummaryPageTx(tx,group);
  },{readOnlySnapshot:true});
  expect(probe.queries.some(q=>q.sql.includes('"agent_proposal"'))).toBe(true);expect(probe.queries.some(q=>q.sql.includes('"teras_outcome_record"'))).toBe(true);
  for(const q of probe.queries)expect(q.sql).not.toMatch(/payroll_anomaly_verdict|payroll_anomaly_finding|ai_active_provider|"domain_event"|teras_outcome_followup/);
  const records=probe.queries.find(q=>q.sql.includes('from "teras_outcome_record"'))!;expect(records.sql).toContain('"reads"');expect(records.sql).not.toMatch(/"outcome"|"checks"|"replay"|"trace"|"notice"/);
 }finally{probe.restore();}
});

it('keeps empty denominators null and rejects an unsupported closure-rate purpose before reading it',async()=>{
 const result=await page();for(const row of result.rows)expect(row.metrics).toMatchObject({measured:false,acceptanceRate:null,reversalRate:null,decided:0});
 await expect(withTenant(group,tx=>workerAgreementPageRatesTx(tx,group,['close_fixed_upstream']),{readOnlySnapshot:true})).rejects.toThrow('tested-closure');
 expect((await page()).summary).toEqual({records:0,byFamily:{}});
});

it('narrows detail without recomputing provider, switches, proposal rates or whole record payloads',async()=>{
 await populated();const baseline=await workerDetail(group,'conversation'),probe=observeNativeRead();
 try{
  const detail=await withTenant(group,tx=>workerDetailPageTx(tx,group,'conversation',new Date()),{readOnlySnapshot:true});expect(detail).toEqual(visibleDetail(baseline));
  expect(detail.worker).toEqual({id:'conversation',label:baseline.worker.label});
  for(const q of probe.queries)expect(q.sql).not.toMatch(/ai_active_provider|"teras_worker_control"|"agent_proposal"|"scope"|"outcome"|"checks"|"replay"|"trace"/);
  expect(probe.queries.filter(q=>q.sql.includes('from "teras_outcome_record"'))).toHaveLength(1);
 }finally{probe.restore();}
});

it('preserves the exact recent20 timestamp/id ordering and latest follow-up decision',async()=>{
 const at=new Date(Date.now()-60_000),records=[];
 for(let i=0;i<24;i++)records.push(await outcome('teras.assistant',new Date(at.getTime()+i),'fixture_tool'));
 const newest=records.at(-1)!;
 await owner.db.insert(terasOutcomeFollowup).values([{tenantId:b.tenantId,recordId:newest.id,kind:'decision',decision:'accepted',humanInvolvement:'decided',byUserId:group.userId,at:new Date(at.getTime()+100)},
  {tenantId:b.tenantId,recordId:newest.id,kind:'undo',decision:'undone',humanInvolvement:'decided',byUserId:group.userId,at:new Date(at.getTime()+101)}]);
 const current=await page(group,'conversation');expect(current.detail?.recentRuns).toHaveLength(20);
 expect(current.detail?.recentRuns.map(r=>r.runId)).toEqual(records.slice(-20).reverse().map(r=>r.runId));expect(current.detail?.recentRuns[0].decision).toBe('undone');
 expect(current.detail).toEqual(visibleDetail(await workerDetail(group,'conversation')));
});

it('retains the explainer tool discriminator, private-to-asker visibility and foreign-tenant isolation',async()=>{
 const at=new Date(Date.now()-60_000),self=await outcome('teras.assistant',at,'explain_leave_entitlement');await outcome('teras.assistant',new Date(at.getTime()+1),'different_tool');
 const strangerId=await createAppUser(b.tenantId,null,'employee'),stranger={...group,userId:strangerId,personId:undefined,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const hidden=await outcome('teras.assistant',new Date(at.getTime()+2),'explain_leave_entitlement',stranger,true);
 const other=await seedBase(),foreign={...adminCtx(other),grants:[{role:'hr_admin',companyId:null}]};await outcome('teras.assistant',new Date(at.getTime()+3),'explain_leave_entitlement',foreign);
 const result=await page(group,'explainers');expect(result.summary).toEqual({records:2,byFamily:{explainer:1,preparer:1}});expect(result.detail?.recentRuns.map(r=>r.runId)).toEqual([self.runId]);
 expect(JSON.stringify(result)).not.toContain(hidden.runId);expect(JSON.stringify(result)).not.toContain(other.tenantId);
});

it('uses the common attributed switch/provider facts but no newly issued configuration or permission grant',async()=>{
 await populated();const issued=vi.spyOn(providerSnapshots,'resolveAiProviderSnapshotTx'),governed=vi.spyOn(governance,'governedAiConfig');
 const result=await page();expect(result.rows.find(r=>r.id==='claims_triage')?.switch).toEqual({on:true,owner:'tenant_setting',detail:'on'});
 expect(result.rows.find(r=>r.id==='payroll_anomaly_narrator')?.switch).toEqual({on:true,owner:'ai_provider',detail:'on'});expect(issued).not.toHaveBeenCalled();expect(governed).not.toHaveBeenCalled();
 await owner.db.update(schema.aiProviderConfig).set({apiKeyCiphertext:'broken-fictional-workers-ciphertext'}).where(eq(schema.aiProviderConfig.tenantId,b.tenantId));
 const broken=await page();expect(broken.facts.providerUsable).toBe(false);expect(broken.rows.find(r=>r.id==='payroll_anomaly_narrator')?.switch.on).toBe(false);
 expect(JSON.stringify(broken)).not.toContain('fictional-workers-key-never-sent');expect(issued).not.toHaveBeenCalled();expect(governed).not.toHaveBeenCalled();
});

it('keeps mandate state boundaries, count denominators and revocation independent of display facts',async()=>{
 const f=await populated();
 for(const [at,state,active]of [[new Date(f.weekly.validFrom.getTime()-1),'not_started',0],[f.weekly.validFrom,'active',1],[f.weekly.validUntil,'expired',0]] as const){
  const result=await page(group,'team_absence_weekly_summary',at);expect(result.detail?.mandates.find(m=>m.id===f.weekly.id)?.state).toBe(state);
  expect(result.rows.find(r=>r.id==='team_absence_weekly_summary')?.mandates).toEqual({active,total:1});
 }
 await revokeMandate(f.grantor,f.weekly.id);expect((await page(group,'team_absence_weekly_summary')).detail?.mandates.find(m=>m.id===f.weekly.id)?.state).toBe('revoked');
});

it.each(['read-write','read-only'] as const)('rejects Read Committed %s even when supplied render facts say enabled',async mode=>{
 await expect(withTenant(group,async tx=>{
  if(mode==='read-only')await tx.execute(sql`set transaction read only`);
  return listWorkersPageTx(tx,group,{providerUsable:true,agentSwitches:[],at:new Date()});
 })).rejects.toThrow('Current AI calling authority');
});

it('company HR gets only built-ins and cannot obtain registry/summary/detail through forged display facts',async()=>{
 const user=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.update(schema.roleAssignment).set({companyId:b.companyId}).where(eq(schema.roleAssignment.appUserId,user));
 const ctx={...group,userId:user,grants:[{role:'hr_admin',companyId:b.companyId}]};
 expect(await withTenant(ctx,tx=>workersBuiltInStatusesTx(tx,ctx,new Date()),{readOnlySnapshot:true})).toHaveLength(4);
 for(const read of [(tx:Tx)=>listWorkersPageTx(tx,ctx,{providerUsable:true,agentSwitches:[],at:new Date()}),(tx:Tx)=>outcomeSummaryPageTx(tx,ctx),(tx:Tx)=>workerDetailPageTx(tx,ctx,'conversation',new Date()),(tx:Tx)=>workerPageSwitchesTx(tx,ctx,{providerUsable:true,agentSwitches:[],at:new Date()}),(tx:Tx)=>workerAgreementPageRatesTx(tx,ctx,['anomaly_narration'])])
  await expect(withTenant(ctx,read,{readOnlySnapshot:true})).rejects.toThrow();
});

it.each(['employee','foreign-carrier','mismatched-grants','revoked','archived','relinked','blocked'] as const)('refuses %s through every native page reader',async mode=>{
 let ctx:SessionContext={...group};
 if(mode==='employee')ctx={...group,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 if(mode==='foreign-carrier'){const other=await seedBase();ctx={...adminCtx(other),grants:[{role:'hr_admin',companyId:null}]};}
 if(mode==='mismatched-grants')ctx={...group,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]};
 if(mode==='revoked')await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,group.userId!));
 if(mode==='archived')await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,group.userId!));
 if(mode==='relinked'){const [p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional Relinked Worker Administrator',primaryEmail:randomUUID()+'@workers.invalid'}).returning();await owner.db.update(schema.appUser).set({personId:p.id}).where(eq(schema.appUser.id,group.userId!));}
 if(mode==='blocked'){
  const hired=await hireEmployee(group,{person:{fullName:'Fictional Blocked Worker Administrator',primaryEmail:randomUUID()+'@workers.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const id=await createAppUser(b.tenantId,hired.personId,'hr_admin');ctx={...group,userId:id,personId:hired.personId};await terminateEmployment(group,{employmentId:hired.employmentId,terminationDate:'2021-01-01'});
 }
 const captured=ctx;
 for(const read of [(tx:Tx)=>workersBuiltInStatusesTx(tx,captured,new Date()),(tx:Tx)=>listWorkersPageTx(tx,captured,{providerUsable:true,agentSwitches:[],at:new Date()}),
  (tx:Tx)=>outcomeSummaryPageTx(tx,captured),(tx:Tx)=>workerDetailPageTx(tx,captured,'conversation',new Date()),(tx:Tx)=>workerPageSwitchesTx(tx,captured,{providerUsable:true,agentSwitches:[],at:new Date()}),(tx:Tx)=>workerAgreementPageRatesTx(tx,captured,['anomaly_narration'])])
  await expect(withTenant(mode==='foreign-carrier'?group:captured,read,{readOnlySnapshot:true})).rejects.toThrow();
});

it('retains the admitted MVCC snapshot after revocation, then refuses a later snapshot',async()=>{
 await withTenant(group,async tx=>{
  const facts=await commonFacts(tx,group);await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,group.userId!));
  const rows=await listWorkersPageTx(tx,group,facts);expect(rows).toHaveLength(20);expect((await outcomeSummaryPageTx(tx,group)).records).toBe(0);
 },{readOnlySnapshot:true});
 await expect(page()).rejects.toThrow('Current AI calling authority');
});

it.each([['access','rollback'],['access','commit'],['ai-stop','rollback'],['ai-stop','commit']] as const)('finishes while a real %s writer remains held through %s',async(kind,settlement)=>{
 await populated();await setMandateStopSwitch(group,false);
 // Keep another recovery administrator while the held Access edit narrows this caller.
 await createAppUser(b.tenantId,null,'hr_admin');
 let entered!:()=>void,failed!:(error:unknown)=>void,release!:()=>void;const ready=new Promise<void>((resolve,reject)=>{entered=resolve;failed=reject;}),held=new Promise<void>(r=>{release=r;});
 let holderPid=0,writerFailure:unknown;const rollback=new Error('fictional-held-writer-rollback');
 const writer=owner.client.begin(async holder=>{
  await holder`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${group.userId!},true),set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify(group.grants)},true)`;
  if(kind==='access'){
   await holder`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
   await holder`update role_assignment set company_id=${b.companyId}::uuid where app_user_id=${group.userId!}::uuid and role='hr_admin'`;
  }else await holder`update teras_mandate_control set stopped=true where tenant_id=${b.tenantId}::uuid`;
  holderPid=Number((await holder`select pg_backend_pid() as pid`)[0].pid);entered();await held;if(settlement==='rollback')throw rollback;
 }).catch(error=>{if(error!==rollback){writerFailure=error;failed(error);}});
 try{
  await ready;
  await withTenant(group,async tx=>{
   await tx.execute(sql`set local lock_timeout='750ms'`);await tx.execute(sql`set local statement_timeout='10s'`);
   const [backend]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`),facts=await commonFacts(tx,group),rows=await listWorkersPageTx(tx,group,facts);
   expect(rows).toHaveLength(20);expect(rows.every(row=>!row.stopped)).toBe(true);
   const [state]=await owner.client`select pg_blocking_pids(${backend.pid}::integer) as blockers,(select count(*)::integer from pg_locks where pid=${backend.pid} and locktype='advisory') as reader_locks,
    (select count(*)::integer from pg_locks where pid=${holderPid} and locktype='advisory' and granted) as holder_locks`;
   expect(state.blockers).toEqual([]);expect(state.reader_locks).toBe(0);expect(state.holder_locks).toBeGreaterThan(0);
  },{readOnlySnapshot:true});
 }finally{release();await writer;if(writerFailure)throw writerFailure;}
 if(kind==='access'&&settlement==='commit')await expect(page()).rejects.toThrow('Current AI calling authority');
 else expect((await page()).rows.every(row=>row.stopped===(kind==='ai-stop'&&settlement==='commit'))).toBe(true);
});

it('keeps database-enforced read-only mode and settles a failed read before the next snapshot',async()=>{
 const error=await withTenant(group,async tx=>{
  const facts=await commonFacts(tx,group);await listWorkersPageTx(tx,group,facts);
  await tx.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,group.userId!));
 },{readOnlySnapshot:true}).then(()=>null,(e:unknown)=>e);
 expect(pgSqlState(error)).toBe('25006');expect((await page()).rows).toHaveLength(20);
 await expect(withTenant(group,async tx=>{await tx.execute(sql`select 1/0`);return outcomeSummaryPageTx(tx,group);},{readOnlySnapshot:true})).rejects.toThrow();
 expect((await page()).summary).toEqual({records:0,byFamily:{}});
});

it('captures calling context and render inputs before suspension without treating them as command authority',async()=>{
 const before=JSON.stringify(group);
 await withTenant(group,async tx=>{
  const validated=await commonFacts(tx,group),ctx={...group,roles:group.roles?.slice(),grants:group.grants?.map(g=>({...g}))};
  const input={...validated,at:new Date(validated.at),agentSwitches:validated.agentSwitches.map(s=>({...s}))};
  const pending=listWorkersPageTx(tx,ctx,input);
  ctx.userId=randomUUID();ctx.roles?.splice(0,ctx.roles.length,'employee');ctx.grants?.splice(0,ctx.grants.length,{role:'employee',companyId:null});
  input.providerUsable=true;input.at.setFullYear(2099);input.agentSwitches.splice(0,input.agentSwitches.length);
  const rows=await pending;expect(rows).toHaveLength(20);expect(rows.find(r=>r.id==='payroll_anomaly_narrator')?.switch.on).toBe(false);
 },{readOnlySnapshot:true});
 expect(JSON.stringify(group)).toBe(before);
});

it('awaits a real native statement cancellation and rollback before another page snapshot',async()=>{
 const failure=await withTenant(group,async tx=>{
  const facts=await commonFacts(tx,group);await listWorkersPageTx(tx,group,facts);
  await tx.execute(sql`set local statement_timeout='25ms'`);await tx.execute(sql`select pg_sleep(0.1)`);
 },{readOnlySnapshot:true}).then(()=>null,(error:unknown)=>error);
 expect(pgSqlState(failure)).toBe('57014');
 expect((await page()).rows).toHaveLength(20);
});

it('recovers current built-ins and context from a real authorized session with an earlier error and no cached entitlements',async()=>{
 const supplied:SessionContext={...group,entitlements:undefined,entitlementsError:'Fictional earlier session resolver failure'},before=JSON.stringify(supplied);
 const result=await withTenant(supplied,async tx=>({builtIns:await workersBuiltInStatusesTx(tx,supplied,new Date()),current:await workerPageContextTx(tx,supplied)}),{readOnlySnapshot:true});
 expect(result.builtIns).toEqual([{id:'detectors',kind:'deterministic',active:true,reasonKey:'detectorsOn'},
  {id:'sweep',kind:'deterministic',active:false,reasonKey:'sweepNever'},
  {id:'actions',kind:'deterministic',active:true,reasonKey:'actionsOn'},
  {id:'autonomy',kind:'deterministic',active:false,reasonKey:'autonomyByDesign',offByDesign:true}]);
 expect(result.current).toMatchObject({tenantId:b.tenantId,userId:b.adminUserId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}],
  entitlements:{tenantId:b.tenantId,tenantStatus:'active',scopedModules:{}}});
 expect(result.current.entitlementsError).toBeUndefined();expect(result.current.entitlements?.enabledModules).toEqual(expect.arrayContaining(['assistant','payroll','claims']));
 expect(isModuleEnabled(result.current,'payroll')).toBe(true);expect(JSON.stringify(supplied)).toBe(before);
});

it('uses the actual current disabled module despite a stale enabled snapshot and earlier resolution error',async()=>{
 const supplied:SessionContext={...group,entitlementsError:'Fictional earlier resolver failure'};expect(group.entitlements?.enabledModules).toContain('payroll');
 await setModule(b.tenantId,'payroll',null);
 const result=await withTenant(supplied,async tx=>({builtIns:await workersBuiltInStatusesTx(tx,supplied,new Date()),current:await workerPageContextTx(tx,supplied)}),{readOnlySnapshot:true});
 expect(result.builtIns).toEqual([{id:'detectors',kind:'deterministic',active:false,reasonKey:'moduleOff'},
  {id:'sweep',kind:'deterministic',active:false,reasonKey:'sweepNever'},
  {id:'actions',kind:'deterministic',active:false,reasonKey:'moduleOff'},
  {id:'autonomy',kind:'deterministic',active:false,reasonKey:'autonomyByDesign',offByDesign:true}]);
 expect(result.current.entitlements?.enabledModules).not.toContain('payroll');expect(result.current.entitlementsError).toBeUndefined();expect(isModuleEnabled(result.current,'payroll')).toBe(false);
 expect(supplied.entitlementsError).toBe('Fictional earlier resolver failure');expect(supplied.entitlements?.enabledModules).toContain('payroll');
});

it('does not turn an earlier resolution error into native authority for a foreign carrier or revoked login',async()=>{
 const other=await seedBase(),foreign:SessionContext={...adminCtx(other),grants:[{role:'hr_admin',companyId:null}],entitlementsError:'Fictional earlier resolver failure'};
 for(const read of [(tx:Tx)=>workersBuiltInStatusesTx(tx,foreign,new Date()),(tx:Tx)=>workerPageContextTx(tx,foreign)])
  await expect(withTenant(group,read,{readOnlySnapshot:true})).rejects.toThrow('Current AI calling authority');
 const revoked:SessionContext={...group,entitlements:undefined,entitlementsError:'Fictional earlier resolver failure'};
 await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,group.userId!));
 for(const read of [(tx:Tx)=>workersBuiltInStatusesTx(tx,revoked,new Date()),(tx:Tx)=>workerPageContextTx(tx,revoked)])
  await expect(withTenant(revoked,read,{readOnlySnapshot:true})).rejects.toThrow('Current AI calling authority');
 expect(revoked.entitlementsError).toBe('Fictional earlier resolver failure');expect(foreign.entitlementsError).toBe('Fictional earlier resolver failure');
});

it.each(['built-ins','context'] as const)('propagates a real entitlement query SQL failure through %s and rolls back before recovery',async purpose=>{
 const supplied:SessionContext={...group,entitlements:undefined,entitlementsError:'Fictional earlier resolver failure'},probe=observeNativeRead();
 let failure:unknown;
 try{
  failure=await withTenant(supplied,async tx=>{
   // Native principal helpers use their pinned source paths. The entitlement owner deliberately
   // resolves its real unqualified tables; a transaction-local path makes that actual SQL fail.
   await tx.execute(sql`set local search_path=pg_catalog`);
   return purpose==='built-ins'?workersBuiltInStatusesTx(tx,supplied,new Date()):workerPageContextTx(tx,supplied);
  },{readOnlySnapshot:true}).then(()=>null,(error:unknown)=>error);
  expect(pgSqlState(failure)).toBe('42P01');expect(probe.queries.some(q=>q.sql.includes('FROM tenant_module tm'))).toBe(true);
  expect(probe.state).toEqual({active:0,maxActive:1});expect(probe.properties).toHaveLength(1);
 }finally{probe.restore();}
 expect(supplied.entitlements).toBeUndefined();expect(supplied.entitlementsError).toBe('Fictional earlier resolver failure');
 const current=await withTenant(supplied,tx=>workerPageContextTx(tx,supplied),{readOnlySnapshot:true});
 expect(current.entitlementsError).toBeUndefined();expect(isModuleEnabled(current,'payroll')).toBe(true);
 expect((await withTenant(supplied,tx=>workersBuiltInStatusesTx(tx,supplied,new Date()),{readOnlySnapshot:true})).find(row=>row.id==='detectors')).toMatchObject({active:true,reasonKey:'detectorsOn'});
});
