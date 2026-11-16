// Lane I (I7): the handoff §10 acceptance lines that had no test yet, through the real commands, the shared workflow
// runner and the owner sweep. Fictional people only.
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {adminCtx,closeAll,setModule,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {probationOutcomeFixture} from './helpers/probation-outcome-fixture';
import {newProbationLetterTemplate} from '../lib/probation-letter-template';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import type {SessionContext,Tx} from '../db/client';
import {approvePersonnelPosting} from '../core/personnel-posting';
import {probationAutomationContextTx} from '../core/probation-automation';
import {saveProbationLetterTemplate,readProbationLetter,actOnProbationLetter,releaseProbationLetter,sweepProbation,probationCase,saveProbationDraft,actOnProbation,
 probationSetup,saveProbationSettingsScope,DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM} from '../packs/probation/service';
import {PROBATION_SETTINGS_FIELD_DEFAULTS} from '../lib/probation-model';

let b:Base,admin:SessionContext,fixture:ReturnType<typeof probationOutcomeFixture>;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);fixture=probationOutcomeFixture(b,admin);});

async function letterTemplate(ctx:SessionContext,outcome:'confirm'|'extend'|'not_confirm',key=outcome+'-'+randomUUID().slice(0,8)){
 const template=newProbationLetterTemplate(outcome,key,'Fictional '+outcome+' letter');template.unfinished=false;
 template.blocks=template.blocks.filter(block=>block.type!=='letterhead');template.blocks.find(block=>block.type==='text')!.text='Outcome for {employeeName}.';
 await saveProbationLetterTemplate(ctx,{companyId:b.companyId,template,publish:true,expectedVersion:0});
 return key;
}
async function liveWorkflow(trigger:string,steps:Record<string,unknown>[],conditions:Record<string,unknown>[]=[]){
 const id=randomUUID();
 const definition={name:'Fictional '+trigger+' workflow',description:'',module:'probation',trigger:{event:trigger,days:0,workdays:false,repeat:false},skipWhen:'never',conditions,
  steps:steps.map((step,i)=>({id:'s'+(i+1),conditions:[],to:[],cc:[],params:{},...step}))};
 await owner.db.execute(sql`insert into automation_workflow_version(tenant_id,workflow_id,revision,module,status,required,definition,reason,saved_by) values(${b.tenantId}::uuid,${id}::uuid,1,'probation','live',false,${JSON.stringify(definition)}::jsonb,'Fictional live workflow',${admin.userId}::uuid)`);
 return id;
}
const runner=()=>({...admin,userId:undefined,roles:[],grants:undefined} as SessionContext);
const port={withTenant:async<T>(context:SessionContext,run:(tx:Tx)=>Promise<T>)=>owner.withTenant(context,run)};
const sweep=async()=>{await sweepProbation(runner(),port);await sweepProbation(runner(),port);};
const letterOf=async(outcomeId:string)=>(await owner.db.execute<{letter:string|null}>(sql`select letter_part_id::text as letter from probation_outcome where id=${outcomeId}::uuid`))[0].letter;
/** The PBP signs, the employee signs, the PBP releases, then the owner sweep files and applies. */
async function signAndRelease(caseId:string,outcomeId:string,staff:{ctx:SessionContext}){
 const letterId=await letterOf(outcomeId);expect(letterId).toBeTruthy();
 let letter=await readProbationLetter(admin,caseId,letterId!);const hr=letter.signing!.document.route.steps.find(s=>s.role==='pbp')!;
 await actOnProbationLetter(admin,{caseId,partId:letter.id,revision:letter.storageRevision,stepId:hr.id,action:'signed',method:'typed',value:'Fictional PBP',consent:true});
 letter=await readProbationLetter(staff.ctx,caseId,letterId!);const ack=letter.signing!.document.route.steps.find(s=>s.role==='employee')!;
 await actOnProbationLetter(staff.ctx,{caseId,partId:letter.id,revision:letter.storageRevision,stepId:ack.id,action:'signed',method:'typed',value:'Fictional Staff',consent:true});
 letter=await readProbationLetter(admin,caseId,letterId!);
 await releaseProbationLetter(admin,{caseId,partId:letter.id,outcomeRevision:letter.outcomeRevision!,reason:'Release the signed letter'});
 await sweep();
}
const caseState=async(caseId:string)=>(await owner.db.execute<{state:string;endOn:string;count:number;pending:{id:string;eventType:string}|null}>(sql`select data->>'state' as state,data->>'endOn' as "endOn",(data->>'extensionCount')::int as count,data->'pendingPosting' as pending from probation_case where id=${caseId}::uuid`))[0];
const postingsOf=(caseId:string)=>owner.db.execute<{id:string;event:string;status:string;group:string;revision:number;proposed:{effectiveDate:string;endDate?:string}}>(sql`select id,event_type as event,status,approver_group_id as group,revision,proposed from personnel_posting where source_ref=${caseId}::uuid order by created_at`);

describe('Extend on the shared workflow, then Confirm (handoff §10 main paths)',()=>{
 it('adds the extension, moves the end date, creates the extension posting and reopens Part 3; the second cycle confirms with the count kept',async()=>{
  const {ids,staff,manager,peer,decision,endOn,admin:pbp}=await fixture.recordedConfirm([],{outcome:'extend',beforeRecord:async ctx=>{
   const key=await letterTemplate(ctx,'extend');
   await liveWorkflow('outcomeDecided',[{type:'generateDocument',params:{letterTemplateId:key}},{type:'createPosting',params:{eventType:'Probation Extension'}}],[{field:'outcome',op:'is',values:['Extend']}]);
  }});
  admin=pbp;
  await signAndRelease(ids.caseId,decision.id,staff);
  const newEnd=addDaysIso(addCalendarMonths(addDaysIso(endOn,1),3),-1);
  const extension=await postingsOf(ids.caseId);
  expect(extension).toEqual([expect.objectContaining({event:'probationExtension',status:'pending',group:'probation-people',proposed:expect.objectContaining({effectiveDate:addDaysIso(endOn,1),endDate:newEnd})})]);
  expect(await caseState(ids.caseId)).toEqual({state:'extended',endOn:newEnd,count:1,pending:{id:extension[0].id,eventType:'probationExtension'}});
  const cycles=await owner.db.execute<{id:string;cycle:number;state:string}>(sql`select id,(data->>'cycle')::int as cycle,data->>'state' as state from probation_part where case_id=${ids.caseId}::uuid and data->>'type'='3' and coalesce(data->>'documentKind','review')='review' order by (data->>'cycle')::int`);
  expect(cycles.map(c=>[c.cycle,c.state])).toEqual([[0,'locked'],[1,'not_issued']]);
  // The posting-approver group approves the extension: Personnel now holds the new end date.
  await approvePersonnelPosting(admin,{id:extension[0].id,revision:extension[0].revision});
  // Second cycle, brought to today so the confirmation is due (Personnel and the case move together).
  const due=addDaysIso(todayInKualaLumpur(),-2),second=cycles[1].id;
  // The extension movement owns the extended and final confirmation dates; while its posting was pending the sweep held
  // the case for the date difference (sourceDateChangePending), cleared here as the reconciliation would.
  await owner.db.execute(sql`update employment set extended_confirmation_date=${due}::date,final_confirmation_date=${due}::date where id=${staff.employmentId}::uuid`);
  await owner.db.execute(sql`update probation_case set data=(data-'sourceDateChangePending')||jsonb_build_object('endOn',${due}::text) where id=${ids.caseId}::uuid`);
  await owner.db.execute(sql`update probation_part set data=data||jsonb_build_object('dueOn',${due}::text,'issueOn',${addDaysIso(due,-30)}::text) where id=${second}::uuid`);
  await sweepProbation(runner(),port);
  const part=async(ctx:SessionContext)=>(await probationCase(ctx,ids.caseId)).parts.find(p=>p.id===second)!;
  const issued=await part(admin);
  expect(issued.state,JSON.stringify({state:issued.state,issueOn:issued.issueOn,dueOn:issued.dueOn,case:await caseState(ids.caseId)})).not.toBe('not_issued');
  const assessment=Object.fromEntries(DEFAULT_PROBATION_FORM.criteria.map(c=>[c.id,{rating:4,evidence:'Observed fictional evidence after the extension'}]));
  let p=await part(staff.ctx);await saveProbationDraft(staff.ctx,{caseId:ids.caseId,partId:second,revision:p.revision,rater:'employee',patch:{employee:assessment}});
  p=await part(staff.ctx);await actOnProbation(staff.ctx,{caseId:ids.caseId,partId:second,revision:p.revision,command:'submit_employee'});
  p=await part(manager.ctx);await saveProbationDraft(manager.ctx,{caseId:ids.caseId,partId:second,revision:p.revision,rater:'lm',patch:{manager:assessment,reviewOn:todayInKualaLumpur(),conductedBy:manager.userId,outcome:'confirm',justification:'The extension goals are met'}});
  p=await part(manager.ctx);await actOnProbation(manager.ctx,{caseId:ids.caseId,partId:second,revision:p.revision,command:'submit_manager',method:'typed',value:'Fictional Manager',consent:true});
  p=await part(staff.ctx);await saveProbationDraft(staff.ctx,{caseId:ids.caseId,partId:second,revision:p.revision,rater:'employee',patch:{employeeComments:'I acknowledge the second review.'}});
  p=await part(staff.ctx);await actOnProbation(staff.ctx,{caseId:ids.caseId,partId:second,revision:p.revision,command:'acknowledge',method:'typed',value:'Fictional Staff',consent:true});
  for(const actor of[peer.ctx,admin]){p=await part(actor);await actOnProbation(actor,{caseId:ids.caseId,partId:second,revision:p.revision,command:'approve',method:'typed',value:'Fictional approver',consent:true});}
  await letterTemplate(admin,'confirm');
  p=await part(admin);await actOnProbation(admin,{caseId:ids.caseId,partId:second,revision:p.revision,command:'record'});
  const [confirm]=await owner.db.execute<{id:string}>(sql`select id from probation_outcome where part_id=${second}::uuid`);
  await signAndRelease(ids.caseId,confirm.id,staff);
  const all=await postingsOf(ids.caseId);
  expect(all.map(x=>[x.event,x.status])).toEqual([['probationExtension','approved'],['confirmation','pending']]);
  expect(await caseState(ids.caseId)).toMatchObject({state:'confirmed',count:1,pending:{id:all[1].id,eventType:'confirmation'}});
 });
});

describe('Non-confirmation on the shared workflow (handoff §10 main paths)',()=>{
 it('closes the case as Not confirmed with exactly one offboarding case and no posting, idempotently',async()=>{
  const {ids,staff,decision,admin:pbp}=await fixture.recordedConfirm([],{outcome:'not_confirm',beforeRecord:async ctx=>{
   const key=await letterTemplate(ctx,'not_confirm');
   await liveWorkflow('outcomeDecided',[{type:'generateDocument',params:{letterTemplateId:key}},{type:'startOffboarding',params:{exitReason:'Non-confirmation'}}],[{field:'outcome',op:'is',values:['Non-confirmation']}]);
  }});
  admin=pbp;
  // Decided: nothing is started before the letter is released.
  expect(await owner.db.execute(sql`select 1 from lc_v9_case where data->>'probationSourceCaseId'=${ids.caseId}`)).toHaveLength(0);
  await signAndRelease(ids.caseId,decision.id,staff);
  await sweep();
  const runs=await owner.db.execute<{status:string;failure:string|null;log:unknown}>(sql`select status,failure,log from automation_run where subject_id=${ids.caseId}::uuid and trigger_event='outcomeDecided'`);
  const [state]=await owner.db.execute<{state:string;failure:string|null}>(sql`select state,failure from probation_outcome where id=${decision.id}::uuid`);
  expect(runs.map(r=>r.status),JSON.stringify({runs,state})).toEqual(['done']);
  const handoffs=await owner.db.execute<{id:string;kind:string}>(sql`select id,data->'facts'->>'caseType' as kind from lc_v9_case where tenant_id=${b.tenantId}::uuid and data->>'probationSourceCaseId'=${ids.caseId}`);
  expect(handoffs).toEqual([{id:expect.any(String),kind:'Non-confirmation'}]);
  expect(await postingsOf(ids.caseId)).toEqual([]);
  expect((await caseState(ids.caseId)).state).toBe('not_confirmed');
  const [outcome]=await owner.db.execute<{state:string;handoff:string|null;movement:string|null}>(sql`select state,handoff_ref::text as handoff,movement_ref as movement from probation_outcome where id=${decision.id}::uuid`);
  expect(outcome).toEqual({state:'completed',handoff:handoffs[0].id,movement:null});
 });
});

describe('a workflow with no Generate document step (handoff §10 exception paths)',()=>{
 it('stops: no posting is created, no letter is attached, and the PBP is asked to check it',async()=>{
  const {ids,decision,admin:pbp}=await fixture.recordedConfirm([],{beforeRecord:async ctx=>{
   await letterTemplate(ctx,'confirm');
   await liveWorkflow('outcomeDecided',[{type:'createPosting',params:{eventType:'Confirmation'}}],[{field:'outcome',op:'is',values:['Confirm']}]);
  }});
  admin=pbp;
  const runs=await owner.db.execute<{status:string;failure:string|null}>(sql`select status,failure from automation_run where subject_id=${ids.caseId}::uuid and trigger_event='outcomeDecided'`);
  expect(runs).toEqual([expect.objectContaining({status:'failed'})]);expect(runs[0].failure).toContain('no Generate document step');
  const [outcome]=await owner.db.execute<{failure:string|null;letter:string|null;file:string|null}>(sql`select failure,letter_part_id::text as letter,letter_file_id::text as file from probation_outcome where id=${decision.id}::uuid`);
  // The workflow matched, so today's automatic draft does not run behind it; the PBP is asked to check and release by hand.
  expect(outcome).toMatchObject({letter:null,file:null});expect(outcome.failure).toContain('release by hand');
  expect(await postingsOf(ids.caseId)).toEqual([]);
  expect((await caseState(ids.caseId)).state).toBe('outcome_pending');
 });
});

describe('an approver returns Part 3 (handoff §10 exception paths)',()=>{
 it('clears the signatures, returns the part to the Line Manager and notifies them',async()=>{
  await liveWorkflow('returned',[{type:'notify',params:{subject:'Returned',body:'Please update and resubmit'},to:[{kind:'role',role:'directSuperior'}]}]);
  const {ids,manager,peer,current}=await fixture.recordedConfirm([],{until:'acknowledged'});
  let part=await current(peer.ctx);
  expect(part.allowedCommands).toContain('return');
  await actOnProbation(peer.ctx,{caseId:ids.caseId,partId:ids.part,revision:part.revision,command:'return',reason:'Please add evidence for the second objective'});
  part=await current(manager.ctx);
  expect(part.state).toBe('returned');expect(part.managerSubmittedAt).toBeNull();expect(part.acknowledgedAt).toBeNull();
  expect(part.allowedCommands).toContain('submit_manager');
  // The return is recorded on the document by the approver; the Line Manager signs again when resubmitting.
  expect(part.signing!.document.actions).toContainEqual(expect.objectContaining({action:'returned',actorId:peer.userId}));
  const notices=await owner.db.execute<{users:string[]}>(sql`select recipient_user_ids as users from probation_occurrence where case_id=${ids.caseId}::uuid and kind='automation'`);
  expect(notices).toEqual([{users:[manager.userId]}]);
 });
});

describe('the fallback and posting-approver groups (handoff §10 configuration)',()=>{
 it('take effect only once the settings version is published, and a case uses the values it pinned',async()=>{
  const {ids,staff,decision,admin:pbp}=await fixture.recordedConfirm([{id:'g-new',name:'Fictional new approvers',members:[],limit:10}],{beforeRecord:async ctx=>{await letterTemplate(ctx,'confirm');}});
  admin=pbp;
  await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(data,'{groups}',(select jsonb_agg(case when g->>'id'='g-new' then g||jsonb_build_object('members',jsonb_build_array(${admin.userId}::text)) else g end) from jsonb_array_elements(data->'groups') g)) where tenant_id=${b.tenantId}::uuid`);
  const standard={...structuredClone(DEFAULT_PROBATION_CONFIG),...PROBATION_SETTINGS_FIELD_DEFAULTS,overrides:[],fallbackGroupId:'g-new',postingApproverGroupId:'g-new'};
  // A draft changes nothing that resolves for new cases.
  const draft=await saveProbationSettingsScope(admin,{settingKey:null,scope:'standard',name:'Group standard',companyIds:[],data:standard,publish:false,expectedVersion:0});
  expect((await probationSetup(admin,b.companyId)).settings?.data).not.toMatchObject({postingApproverGroupId:'g-new'});
  await saveProbationSettingsScope(admin,{settingKey:draft.settingKey,scope:'standard',name:'Group standard',companyIds:[],data:standard,publish:true,expectedVersion:1});
  const published=(await probationSetup(admin,b.companyId)).settings!;
  expect(published.data).toMatchObject({fallbackGroupId:'g-new',postingApproverGroupId:'g-new'});
  // This case started before: it keeps what it pinned (People Ops). Pin the published values as a new case would.
  const before=await owner.withTenant(runner(),tx=>probationAutomationContextTx(tx,ids.caseId));
  expect(before).toMatchObject({fallbackGroupId:'probation-people',postingApproverGroupId:'probation-people'});
  await owner.db.execute(sql`update probation_case set data=jsonb_set(data,'{config}',${JSON.stringify(published.data)}::jsonb) where id=${ids.caseId}::uuid`);
  const after=await owner.withTenant(runner(),tx=>probationAutomationContextTx(tx,ids.caseId));
  expect(after).toMatchObject({fallbackGroupId:'g-new',postingApproverGroupId:'g-new'});
  await signAndRelease(ids.caseId,decision.id,staff);
  expect((await postingsOf(ids.caseId)).map(p=>p.group)).toEqual(['g-new']);
 });
});
