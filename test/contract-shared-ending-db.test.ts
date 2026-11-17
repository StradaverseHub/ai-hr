import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner} from './harness';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import {v9Setup,v9Workspace,v9SaveConfig} from '../packs/lifecycle/service';
import {adoptContractSharedCase,previewContractSharedDecision,submitContractSharedDecision,contractSharedContext,contractPreviewJobHandler,contractAutomationJobHandler,readContractSharedLetter,actContractSharedLetter} from '../packs/contracts/service';
import {recordContractSharedDecline,readContractSharedEndingActions} from '../core/contract-shared-ending';
import {reservedSqlExecutor} from '../db/sql-executor';
import {recordDocumentSigningActionTx,replaceDocumentSignerTx} from '../packs/document-signing/service';
import {saveAutomationDocumentTemplate,saveAutomationWorkflow,type AutomationWorkflow} from '../packs/automation/service';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {readBulkJob} from '../core/bulk-job';
import {todayInKualaLumpur} from '../lib/hr-date';
import {pgSqlState} from '../lib/db-error';
import {historicalEmailPostingFixture} from './helpers/contract-email-work-fixture';
import {bindContractSharedEmployee} from '../packs/contracts/service';

beforeAll(migrateTestDb);afterAll(closeAll);
async function fixture(kind:'renew'|'end',twoDocuments=false){
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');let admin=await entitledCtx(b);
 const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional ending administrator',${randomUUID()+'@ending.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${admin.userId}::uuid`);admin={...admin,personId:person.id};
 await v9Setup(admin);const config=(await v9Workspace(admin)).config!,groupId=randomUUID();
 await v9SaveConfig(admin,config.revision,{...config,groups:[...config.groups,{id:groupId,name:'Contract ending People Ops',members:[admin.userId!],limit:0}],peopleOpsGroup:groupId});
 const year=Number(todayInKualaLumpur().slice(0,4)),start=`${year}-01-01`,end=`${year}-12-31`;
 const employee=await hireEmployee(admin,{person:{fullName:'Fictional ending subject',primaryEmail:randomUUID()+'@ending.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'contract',hiredOn:start,provisionalEndOn:end});
 await setEmploymentInfo(admin,{employmentId:employee.employmentId,contractStartDate:start,contractEndDate:end,contractNumber:3});
 const termId=randomUUID(),caseId=randomUUID();
 await owner.db.execute(sql`insert into contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision) values(${termId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employee.employmentId}::uuid,1,'project',${start}::date,${end}::date,'fixture-ending-period')`);
 await owner.db.execute(sql`insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data) values(${caseId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employee.employmentId}::uuid,${termId}::uuid,'CT-ENDING-1',1,jsonb_build_object('revision',1,'state','upcoming','term',jsonb_build_object('startOn',${start}::text,'endOn',${end}::text),'decision',NULL,'decisionDraft',NULL))`);
 await adoptContractSharedCase(admin,caseId);
 const templateIds:string[]=[];
 async function template(employeeSign:boolean,name:string){
  const id=randomUUID();await saveAutomationDocumentTemplate(admin,{template:{id,module:'contract_staff',name,description:'Fictional ending wording',rules:{},blocks:[{id:'intro',type:'text',text:'Dear {employee.name}. Current end: {contract.end}.',section:''}],fields:[],routing:[{id:randomUUID(),order:1,action:'review',owner:true,who:{kind:'group',groupId}},...(employeeSign?[{id:randomUUID(),order:2,action:'sign' as const,owner:false,who:{kind:'employee' as const}}]:[])]},expectedRevision:0,publish:true,retired:false});return id;
 }
 templateIds.push(await template(kind==='renew','Contract outcome'));
 if(twoDocuments)templateIds.push(await template(false,'Second ending letter'));
 const workflow:AutomationWorkflow={id:randomUUID(),module:'contract_staff',name:'Contract ending decision',description:'',status:'live',required:false,trigger:{event:'decisionSubmitted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[...templateIds.map(letterTemplateId=>({id:randomUUID(),type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId}})),...(kind==='end'?[{id:randomUUID(),type:'startOffboarding',conditions:[],to:[],cc:[],params:{}}]:[])]};
 await saveAutomationWorkflow(admin,{workflow,expectedRevision:0,reason:'Reviewed ending workflow fixture'});
 const declineTemplate=await template(false,'Declined renewal ending');
 await saveAutomationWorkflow(admin,{workflow:{...workflow,id:randomUUID(),name:'Recorded decline ending',trigger:{...workflow.trigger,event:'employeeDeclined'},steps:[{id:randomUUID(),type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:declineTemplate}},{id:randomUUID(),type:'startOffboarding',conditions:[],to:[],cc:[],params:{}}]},expectedRevision:0,reason:'Reviewed employee decline fixture'});
 return {b,admin,employee,caseId,start,end,workflow};
}
async function finish(id:string,as:SessionContext,kind:'contract_preview'|'contract_automation'){
 let failure:unknown;const original=kind==='contract_preview'?contractPreviewJobHandler:contractAutomationJobHandler;
 const diagnostic={...original,describeFailure:async(...args:Parameters<NonNullable<typeof original.describeFailure>>)=>{failure=args[1];return original.describeFailure!(...args);}};
 for(let n=0;n<100;n++){
  const job=await readBulkJob(as,id,kind);if(job.state==='failed')throw failure??new Error(job.error??'Ending worker failed');if(job.state==='completed')return;
  await runBulkJobTick(owner.client,{handlers:[diagnostic]});
 }
 throw new Error('The actual ending kernel job did not finish');
}
async function submit(f:Awaited<ReturnType<typeof fixture>>,kind:'renew'|'end'){
 const preview=await previewContractSharedDecision(f.admin,{caseId:f.caseId,revision:1,draft:kind==='end'?{kind,payChanges:false,endReason:'contract_expiry',reason:'The agreed period ends'}:{kind,payChanges:false,months:6,reason:'Continue the role'}});
 await finish(preview.jobId,f.admin,'contract_preview');const accepted=await submitContractSharedDecision(f.admin,{caseId:f.caseId,revision:1,previewId:preview.previewId});await finish(accepted.jobId,f.admin,'contract_automation');return accepted;
}
async function letters(f:Awaited<ReturnType<typeof fixture>>){return owner.db.execute<{id:string;purpose:string;state:string}>(sql`select id,purpose,data->>'state' as state from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid order by updated_at,id`);}
async function review(f:Awaited<ReturnType<typeof fixture>>,id:string){
 const before=await readContractSharedLetter(f.admin,id);expect(before.pendingAction?.kind).toBe('review');
 const after=await actContractSharedLetter(f.admin,{id,actionId:randomUUID(),stepId:before.pendingAction!.stepId,revision:before.contentRevision,hash:before.contentHash!,action:'reviewed'});
 const events=await owner.db.execute<{job:string}>(sql`select job_id as job from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and trigger_event='letterReleased' and data->>'letterId'=${id} order by created_at,id`);
 for(const event of events)await finish(event.job,f.admin,'contract_automation');return after;
}
describe('shared Contract endings use native Offboarding without automatic Personnel termination',()=>{
 it('accepts exactly one of an employee signature and simultaneous HR decline without a deadlock',async()=>{
  const f=await fixture('renew');const userId=await createAppUser(f.b.tenantId,f.employee.personId,'employee');
  const employee={...f.admin,userId,personId:f.employee.personId,roles:['employee'] as SessionContext['roles'],grants:undefined};
  await submit(f,'renew');const [letter]=await letters(f);await review(f,letter.id);
  const view=await readContractSharedLetter(employee,letter.id),flow=(await contractSharedContext(f.admin,f.caseId)).flow!;
  const results=await Promise.allSettled([
   actContractSharedLetter(employee,{id:letter.id,actionId:randomUUID(),stepId:view.pendingAction!.stepId,revision:view.contentRevision,hash:view.contentHash!,action:'signed',method:'typed',value:'Fictional ending subject',consent:true}),
   recordContractSharedDecline(f.admin,{caseId:f.caseId,revision:flow.revision,reason:'career_opportunity',notes:'The employee told People BP.'}),
  ]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  const refused=results.find(result=>result.status==='rejected') as PromiseRejectedResult;expect(pgSqlState(refused.reason)).not.toBe('40P01');
  const final=await readContractSharedLetter(f.admin,letter.id);expect(['released','declined']).toContain(final.state);
  expect(final.history.filter(action=>action.action==='signed').length+(final.state==='declined'?1:0)).toBe(1);
 },120_000);
 it('requires the exact private native self-binding route, unchanged subject and one real employee account',async()=>{
  const f=await historicalEmailPostingFixture({ordinaryLetter:true}),letter=f.email;
  const ownerPersonId=f.admin.personId;if(!ownerPersonId)throw Error('The actual routed owner Person is required.');
  const userId=await createAppUser(f.b.tenantId,f.employee.personId,'employee');
  const employee:SessionContext={...f.employeeActor,userId};
  const [native]=await owner.db.execute<{id:string;route:{version:number;steps:Record<string,unknown>[]}}>(sql`select d.id,d.data->'route' as route from contract_shared_letter l join document_signing_document d on d.tenant_id=l.tenant_id and d.id=l.signing_document_id where l.tenant_id=${f.b.tenantId}::uuid and l.id=${letter.id}::uuid`);
  const employeeStep=native.route.steps.find(step=>step.role==='employee')!;expect(employeeStep.holderId).toBeNull();
  await expect(withTenant(employee,tx=>replaceDocumentSignerTx(tx,employee,{id:native.id,stepId:String(employeeStep.id),holderId:userId,kind:'missing_holder',reason:'Generic replacement without the private native policy'}))).rejects.toThrow();
  // Stage the exact private preimage only in rollback savepoints on a genuine pinned document.
  await owner.client.begin(async tx=>{
   await tx`select set_config('app.tenant_id',${f.b.tenantId},true),set_config('app.user_id',${userId},true)`;
   const held=async()=>{const[row]=await tx<{held:boolean}[]>`select app.contract_shared_email_self_binding_held(${letter.id}::uuid) as held`;return row.held;};
   expect(await held()).toBe(false);
   const exact={...native.route,steps:native.route.steps.map(step=>step.role==='employee'&&step.holderId===null?{...step,holderId:userId,holderPersonId:f.employee.personId}:step)};
   const checks:[string,()=>Promise<unknown>][]=[
    ['exact private preimage',()=>tx`select 1`],
    ['other route step changed',()=>tx`update contract_shared_letter set data=jsonb_set(data,'{signingPolicy,route}',${JSON.stringify({...exact,steps:exact.steps.map((step,n)=>n===0?{...step,label:'Changed another step'}:step)})}::text::jsonb) where tenant_id=${f.b.tenantId}::uuid and id=${letter.id}::uuid`],
    ['subject changed',()=>tx`update employment set person_id=${ownerPersonId}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`],
    ['duplicate verified account',()=>tx`update app_user set archived_at=null where tenant_id=${f.b.tenantId}::uuid and id=${f.employeeActor.userId!}::uuid`],
    ['different actor',()=>tx`select set_config('app.user_id',${f.admin.userId!},true)`],
   ];
   for(const [name,mutate] of checks){
    await tx`savepoint self_binding_preimage`;
    await tx`update contract_shared_letter set data=jsonb_set(data,'{signingPolicy,route}',${JSON.stringify(exact)}::text::jsonb) where tenant_id=${f.b.tenantId}::uuid and id=${letter.id}::uuid`;
    await mutate();expect(await held(),name).toBe(name==='exact private preimage');
    await tx`rollback to savepoint self_binding_preimage`;await tx`release savepoint self_binding_preimage`;
   }
   expect(await held()).toBe(false);
  });
  await bindContractSharedEmployee(employee,letter.id);
  expect((await readContractSharedLetter(employee,letter.id)).pendingAction).toMatchObject({stepId:employeeStep.id,kind:'sign'});
  const [bound]=await owner.db.execute<{route:unknown}>(sql`select data->'route' as route from document_signing_document where tenant_id=${f.b.tenantId}::uuid and id=${native.id}::uuid`);
  expect(bound.route).toEqual({...native.route,steps:native.route.steps.map(step=>step.id===employeeStep.id?{...step,holderId:userId,holderPersonId:f.employee.personId}:step)});
 },120_000);
 it('keeps an email signing task independent after period posting and refuses a changed subject person',async()=>{
  const f=await historicalEmailPostingFixture({ordinaryLetter:true}),letter=f.email;
  const userId=await createAppUser(f.b.tenantId,f.employee.personId,'employee');
  const employee:SessionContext={...f.employeeActor,userId};
  const [closed]=await owner.db.execute<{data:unknown;revision:number}>(sql`select data,revision from contract_shared_case where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid`);
  expect((await contractSharedContext(f.admin,f.caseId)).flow?.stage).toBe('renewed');
  await bindContractSharedEmployee(employee,letter.id);
  const signView=await readContractSharedLetter(employee,letter.id);expect(signView.pendingAction?.kind).toBe('sign');
  const employeeStepId=signView.pendingAction!.stepId,oldName=signView.body!.values['employee.name'];expect(oldName).toBe('Fictional Contract employee');
  const [document]=await owner.db.execute<{id:string}>(sql`select signing_document_id as id from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and id=${letter.id}::uuid`);
  expect(signView.history.filter(action=>action.action==='reviewed')).toHaveLength(1);
  expect(signView.history.filter(action=>action.action==='signed')).toHaveLength(1); // Actual company signature.
  const [replacement]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${f.b.tenantId}::uuid,'Different Personnel person, never merged into the old email task',${randomUUID()+'@ending.test'}) returning id`);
  const tx=await owner.client.reserve();
  try{
   await tx`begin`;
   await tx`select set_config('app.tenant_id',${f.b.tenantId},true)`;
   await tx`savepoint changed_email_subject`;
   await tx`update employment set person_id=${replacement.id}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`;
   await tx`select set_config('app.user_id',${userId},true)`;
   const [access]=await tx<{current:boolean;allowed:boolean}[]>`select app.contract_shared_email_document_current(${letter.id}::uuid) as current,app.contract_shared_signing_access('contract',${letter.id}::uuid,'sign') as allowed`;
   expect(access).toEqual({current:false,allowed:false});
   const [retained]=await tx<{values:Record<string,string>}[]>`select app.contract_shared_letter_values(${letter.id}::uuid) as values`;expect(retained.values['employee.name']).toBe(oldName);expect(JSON.stringify(retained.values)).not.toContain('Different Personnel person');
   await expect(recordDocumentSigningActionTx(reservedSqlExecutor(tx),employee,{id:document.id,actionId:randomUUID(),stepId:employeeStepId,revision:signView.contentRevision,hash:signView.contentHash!,action:'signed',comment:'Changed Personnel subject must refuse',method:'typed',value:'Fictional employee',consent:true})).rejects.toThrow();
   await tx`rollback to savepoint changed_email_subject`;await tx`release savepoint changed_email_subject`;
   await tx`commit`;
  }finally{await tx`rollback`.catch(()=>undefined);tx.release();}
  const refreshed=await readContractSharedLetter(employee,letter.id);expect(refreshed.body!.values['employee.name']).toBe(oldName);expect(JSON.stringify(refreshed.body)).not.toContain('Different Personnel person');
  await actContractSharedLetter(employee,{id:letter.id,actionId:randomUUID(),stepId:employeeStepId,revision:refreshed.contentRevision,hash:refreshed.contentHash!,action:'signed',method:'typed',value:'Fictional employee',consent:true});
  const [after]=await owner.db.execute<{data:unknown;revision:number}>(sql`select data,revision from contract_shared_case where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid`);expect(after).toEqual(closed);
  expect((await readContractSharedLetter(employee,letter.id)).state).toBe('released');
  const outcomeEvents=await owner.db.execute(sql`select id from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and data->>'letterId'=${letter.id} and trigger_event in('letterReleased','letterSentBack')`);expect(outcomeEvents).toHaveLength(0);
 },120_000);
 it('locks the letter before its signing document for a direct canonical signer, without deadlocking a concurrent prepared writer',async()=>{
  const f=await fixture('renew');
  const userId=await createAppUser(f.b.tenantId,f.employee.personId,'employee');
  const employee={...f.admin,userId,personId:f.employee.personId,roles:['employee'] as SessionContext['roles'],grants:undefined};
  await submit(f,'renew');const [letter]=await letters(f);await review(f,letter.id);
  const view=await readContractSharedLetter(employee,letter.id);expect(view.pendingAction?.kind).toBe('sign');
  const [native]=await owner.db.execute<{id:string}>(sql`select signing_document_id as id from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and id=${letter.id}::uuid`);
  const blocker=await owner.client.reserve(),signer=await owner.client.reserve();let signing:Promise<unknown>|undefined;
  try{
   await blocker`begin`;await signer`begin`;
   await blocker`select set_config('app.tenant_id',${f.b.tenantId},true),set_config('app.user_id',${f.admin.userId!},true),set_config('jit','off',true)`;
   await signer`select set_config('app.tenant_id',${f.b.tenantId},true),set_config('app.user_id',${userId},true),set_config('jit','off',true)`;
   const [pid]=await signer<{pid:number}[]>`select pg_backend_pid() as pid`;
   await blocker`select id from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and id=${letter.id}::uuid for update`;
   signing=recordDocumentSigningActionTx(reservedSqlExecutor(signer),employee,{id:native.id,actionId:randomUUID(),stepId:view.pendingAction!.stepId,revision:view.contentRevision,hash:view.contentHash!,action:'signed',comment:'Accepted exact reviewed terms',method:'typed',value:'Fictional ending subject',consent:true});
   void signing.catch(()=>undefined); // Keep its original rejection for the awaited assertion below.
   // Observe the actual second backend waiting for the held letter, rather than guessing by elapsed time.
   let waiting=false;
   for(let attempt=0;attempt<200;attempt++){
    const [state]=await blocker<{waiting:boolean}[]>`select cardinality(pg_blocking_pids(${pid.pid}))>0 as waiting`;
    if(state.waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
   }
   expect(waiting).toBe(true);
   // With the old reverse order this backend waits on the signer, creating a deadlock cycle.
   await blocker`set local lock_timeout='2s'`;
   await blocker`select id from document_signing_document where tenant_id=${f.b.tenantId}::uuid and id=${native.id}::uuid for update`;
   await blocker`commit`;await signing;await signer`commit`;
  }finally{
   await blocker`rollback`.catch(()=>undefined);await signer`rollback`.catch(()=>undefined);
   await signing?.catch(()=>undefined);blocker.release();signer.release();
  }
  expect((await readContractSharedLetter(employee,letter.id)).state).toBe('released');
 },120_000);
 it('releases each authored document before handing off the exact final letter, idempotently',async()=>{
  const f=await fixture('end',true);const accepted=await submit(f,'end');
  let docs=await letters(f);expect(docs).toHaveLength(1);expect((await contractSharedContext(f.admin,f.caseId)).flow?.offboardingId).toBeNull();
  await review(f,docs[0].id);docs=await letters(f);expect(docs).toHaveLength(2);expect((await contractSharedContext(f.admin,f.caseId)).flow?.offboardingId).toBeNull();
  const second=docs.find(doc=>doc.state==='routing')!;await review(f,second.id);
  const view=await contractSharedContext(f.admin,f.caseId);expect(view.flow?.stage).toBe('offboarding');expect(view.flow?.offboardingId).toBeTruthy();
  const exits=await owner.db.execute<{id:string;data:Record<string,unknown>}>(sql`select id,data from lc_v9_case where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid and module='off'`);
  expect(exits).toHaveLength(1);expect(exits[0].data).toMatchObject({state:'pending',contractSharedSourceCaseId:f.caseId,contractSharedSourceLetter:{letterId:second.id},contractSharedTerminationReason:'contract_expiry',contractSharedClearance:'pending-manual-personnel',facts:{lastDay:f.end,caseType:'Contract end'}});
  const [personnel]=await owner.db.execute<{terminated:string|null;lastDay:string|null;counter:number}>(sql`select terminated_on::text as terminated,last_working_date::text as "lastDay",contract_number as counter from employment where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`);
  expect(personnel).toEqual({terminated:null,lastDay:null,counter:3});
  await finish(accepted.jobId,f.admin,'contract_automation');expect((await owner.db.execute(sql`select id from lc_v9_case where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid and module='off'`))).toHaveLength(1);
  await expect(withTenant(f.admin,tx=>tx.execute(sql`select app.contract_shared_offboarding_intent(${f.caseId}::uuid,${f.workflow.id}::uuid,${f.workflow.steps.at(-1)!.id})`))).rejects.toThrow();
 },120_000);
 it('records HR decline only while the real employee Sign step waits, stops that run and routes a separate ending letter',async()=>{
  const f=await fixture('renew');await submit(f,'renew');let docs=await letters(f);await review(f,docs[0].id);
  const waiting=await readContractSharedLetter(f.admin,docs[0].id);expect(waiting.layers.some(layer=>layer.kind==='sign'&&layer.unavailable)).toBe(true);
  const view=await contractSharedContext(f.admin,f.caseId),revision=view.flow!.revision;
  expect((await readContractSharedEndingActions(f.admin,f.caseId)).canRecordDecline).toBe(true);
  await expect(recordContractSharedDecline(f.admin,{caseId:f.caseId,revision,reason:'not_a_reason',notes:'Told People BP'})).rejects.toThrow();
  const outsiderId=await createAppUser(f.b.tenantId,f.employee.personId,'employee');const outsider={...f.admin,userId:outsiderId,personId:f.employee.personId,roles:['employee'] as SessionContext['roles'],grants:undefined};
  await expect(recordContractSharedDecline(outsider,{caseId:f.caseId,revision,reason:'career_opportunity',notes:''})).rejects.toThrow();
  const request={caseId:f.caseId,revision,reason:'career_opportunity',notes:'Employee told People BP they will not renew.'};
  const declined=await recordContractSharedDecline(f.admin,request);expect(declined.flow.declined).toMatchObject({reason:request.reason,notes:request.notes,by:f.admin.userId});
  expect((await readContractSharedEndingActions(f.admin,f.caseId)).canRecordDecline).toBe(false);
  expect(await recordContractSharedDecline(f.admin,request)).toMatchObject({eventId:declined.eventId,jobId:declined.jobId});
  const retained=await readContractSharedLetter(f.admin,docs[0].id);expect(retained.state).toBe('declined');expect(retained.history).toEqual(waiting.history);
  const oldRuns=await owner.db.execute<{status:string;waiting_for:string|null}>(sql`select status,waiting_for from automation_run where tenant_id=${f.b.tenantId}::uuid and subject_id=${f.caseId}::uuid and workflow_id=${f.workflow.id}::uuid`);expect(oldRuns).toEqual([{status:'failed',waiting_for:null}]);
  await finish(declined.jobId,f.admin,'contract_automation');docs=await letters(f);expect(docs).toHaveLength(2);const ending=docs.find(doc=>doc.purpose==='declined')!;expect(ending.state).toBe('routing');
  await review(f,ending.id);expect((await contractSharedContext(f.admin,f.caseId)).flow?.stage).toBe('offboarding');
  const [personnel]=await owner.db.execute<{terminated:string|null}>(sql`select terminated_on::text as terminated from employment where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`);expect(personnel.terminated).toBeNull();
  await expect(recordContractSharedDecline(f.admin,{...request,notes:'Changed retry'})).rejects.toThrow();
 },120_000);
});
