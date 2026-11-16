// Probation outcomes on the shared workflow runner (lane D2 / W2, migrations 5748 and 5753; handoff B4, decision 4).
// A live shared workflow on "The probation outcome is decided" prepares the letter, waits for its release, then creates
// the Personnel posting; the case closes with the posting pending until the posting-approver group approves it.
// Outcomes without a matching workflow keep today's path (test/probation-persistence.test.ts).
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {adminCtx,closeAll,setModule,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {probationOutcomeFixture} from './helpers/probation-outcome-fixture';
import {newProbationLetterTemplate} from '../lib/probation-letter-template';
import type {SessionContext,Tx} from '../db/client';
import {saveProbationLetterTemplate,readProbationLetter,actOnProbationLetter,releaseProbationLetter,sweepProbation,applyProbationOutcome} from '../packs/probation/service';
import {approvePersonnelPosting} from '../core/personnel-posting';
import {movementHistory} from '../core/movement';

let b:Base,admin:SessionContext,fixture:ReturnType<typeof probationOutcomeFixture>;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);fixture=probationOutcomeFixture(b,admin);});

async function letterTemplate(ctx:SessionContext,key:string){
 const template=newProbationLetterTemplate('confirm',key,'Fictional confirmation letter');template.unfinished=false;
 template.blocks=template.blocks.filter(block=>block.type!=='letterhead');template.blocks.find(block=>block.type==='text')!.text='Confirmation for {employeeName}.';
 return saveProbationLetterTemplate(ctx,{companyId:b.companyId,template,publish:true,expectedVersion:0});
}
async function liveWorkflow(steps:Record<string,unknown>[],conditions:Record<string,unknown>[],trigger='outcomeDecided'){
 const id=randomUUID();
 const definition={name:'Fictional confirmation workflow',description:'Letter, posting and notice',module:'probation',trigger:{event:trigger,days:0,workdays:false,repeat:false},skipWhen:'never',conditions,
  steps:steps.map((step,i)=>({id:'s'+(i+1),conditions:[],to:[],cc:[],params:{},...step}))};
 await owner.db.execute(sql`insert into automation_workflow_version(tenant_id,workflow_id,revision,module,status,required,definition,reason,saved_by) values(${b.tenantId}::uuid,${id}::uuid,1,'probation','live',false,${JSON.stringify(definition)}::jsonb,'Fictional live workflow',${admin.userId}::uuid)`);
 return id;
}
const runsOf=(caseId:string)=>owner.db.execute<{status:string;waiting:string|null;failure:string|null;key:string}>(sql`select status,waiting_for::text as waiting,failure,event_key as key from automation_run where subject_id=${caseId}::uuid order by started_at`);

describe('Probation outcome on the shared workflow runner (W2)',()=>{
 it('prepares the letter, waits for release, creates the posting and closes the case; approval clears the pending posting',async()=>{
  const key='confirm-'+randomUUID().slice(0,8);let companyName='';
  const {ids,staff,decision,endOn,admin:pbp}=await fixture.recordedConfirm([],{beforeRecord:async ctx=>{
   await letterTemplate(ctx,key);
   [{companyName}]=await owner.db.execute<{companyName:string}>(sql`select legal_name as "companyName" from company where id=${b.companyId}::uuid`);
   // A company condition saved as a name before ids (W5) still matches through the read-time aliases.
   await liveWorkflow([{type:'generateDocument',params:{letterTemplateId:key}},{type:'createPosting',params:{eventType:'Confirmation'}},{type:'notify',params:{subject:'Confirmed',body:'Welcome aboard'},to:[{kind:'role',role:'employee'}]}],
    [{field:'outcome',op:'is',values:['Confirm']},{field:'company',op:'is',values:[companyName]}]);
  }});
  admin=pbp;
  // Decided: the run prepared the letter and waits for it; no old-path auto-draft failure.
  const [outcome]=await owner.db.execute<{state:string;failure:string|null;letter:string|null}>(sql`select state,failure,letter_part_id::text as letter from probation_outcome where id=${decision.id}::uuid`);
  expect(outcome).toMatchObject({state:'awaiting_release',failure:null});
  const [document]=await owner.db.execute<{id:string}>(sql`select id from document_signing_document where subject_id=${outcome.letter}::uuid`);
  expect(await runsOf(ids.caseId)).toEqual([expect.objectContaining({status:'waiting',waiting:document.id})]);
  // Sign and release the letter as today.
  let letter=await readProbationLetter(admin,ids.caseId,outcome.letter!);const hr=letter.signing!.document.route.steps.find(s=>s.role==='pbp')!;
  await actOnProbationLetter(admin,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:hr.id,action:'signed',method:'typed',value:'Fictional PBP',consent:true});
  letter=await readProbationLetter(staff.ctx,ids.caseId,outcome.letter!);const ack=letter.signing!.document.route.steps.find(s=>s.role==='employee')!;
  await actOnProbationLetter(staff.ctx,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:ack.id,action:'signed',method:'typed',value:'Fictional Staff',consent:true});
  letter=await readProbationLetter(admin,ids.caseId,outcome.letter!);
  await releaseProbationLetter(admin,{caseId:ids.caseId,partId:letter.id,outcomeRevision:letter.outcomeRevision!,reason:'Release the signed letter'});
  const runner={...admin,userId:undefined,roles:[],grants:undefined} as SessionContext;
  const port={withTenant:async<T>(context:SessionContext,run:(tx:Tx)=>Promise<T>)=>owner.withTenant(context,run)};
  await sweepProbation(runner,port);await sweepProbation(runner,port);
  // Released: the frozen remaining steps ran; the posting waits for approval and the movement is not written.
  const [effect]=await owner.db.execute<{outcomeState:string;movement:string|null;caseState:string;pending:{id:string;eventType:string}|null;confirmed:string|null}>(sql`
   select o.state as "outcomeState",o.movement_ref as movement,c.data->>'state' as "caseState",c.data->'pendingPosting' as pending,e.confirmation_date::text as confirmed
   from probation_outcome o join probation_case c on c.id=o.case_id join employment e on e.id=c.employment_id where o.id=${decision.id}::uuid`);
  const postings=await owner.db.execute<{id:string;status:string;event:string;group:string;proposed:{effectiveDate:string}}>(sql`select id,status,event_type as event,approver_group_id as group,proposed from personnel_posting where source_ref=${ids.caseId}::uuid`);
  expect(postings).toEqual([expect.objectContaining({status:'pending',event:'confirmation',group:'probation-people',proposed:expect.objectContaining({effectiveDate:endOn})})]);
  expect(effect).toEqual({outcomeState:'completed',movement:'posting:'+postings[0].id,caseState:'confirmed',pending:{id:postings[0].id,eventType:'confirmation'},confirmed:null});
  expect(await runsOf(ids.caseId)).toEqual([expect.objectContaining({status:'done'})]);
  const notices=await owner.db.execute<{users:string[]}>(sql`select recipient_user_ids as users from probation_occurrence where case_id=${ids.caseId}::uuid and kind='automation'`);
  expect(notices).toEqual([{users:[staff.userId]}]);
  // Approval (the movement writer is covered by test/personnel-posting-db.test.ts) clears the case's pending posting.
  await owner.db.execute(sql`update personnel_posting set status='approved',applied=proposed,movement_id=${randomUUID()},approved_by=${admin.userId}::uuid,approved_at=now() where id=${postings[0].id}::uuid`);
  const [after]=await owner.db.execute<{pending:unknown}>(sql`select data->'pendingPosting' as pending from probation_case where id=${ids.caseId}::uuid`);
  expect(after.pending).toBeNull();
  expect(await owner.db.execute(sql`select 1 from domain_event where aggregate_id=${ids.caseId}::uuid and event_type='probation.posting_approved'`)).toHaveLength(1);
 });

 it('fails the run with the guardrail when the company has not published the chosen letter, and asks the PBP to release by hand',async()=>{
  const {ids,decision}=await fixture.recordedConfirm([],{beforeRecord:async()=>{
   await liveWorkflow([{type:'generateDocument',params:{letterTemplateId:'not-published-here'}},{type:'createPosting',params:{eventType:'Confirmation'}}],[{field:'outcome',op:'is',values:['Confirm']}]);
  }});
  const runs=await runsOf(ids.caseId);
  expect(runs).toEqual([expect.objectContaining({status:'failed'})]);
  expect(runs[0].failure).toContain('document template');
  const [outcome]=await owner.db.execute<{failure:string|null;letter:string|null}>(sql`select failure,letter_part_id::text as letter from probation_outcome where id=${decision.id}::uuid`);
  expect(outcome.letter).toBeNull();expect(outcome.failure).toContain('release by hand');
  expect(await owner.db.execute(sql`select 1 from personnel_posting where source_ref=${ids.caseId}::uuid`)).toHaveLength(0);
 });

 it('keeps today\'s path when no workflow matches the outcome',async()=>{
  const {ids,decision}=await fixture.recordedConfirm([],{beforeRecord:async()=>{
   await liveWorkflow([{type:'notify',params:{subject:'Extended',body:'Extended'},to:[{kind:'role',role:'employee'}]}],[{field:'outcome',op:'is',values:['Extend']}]);
  }});
  expect(await runsOf(ids.caseId)).toEqual([]);
  // No published template: today's auto-draft routes the outcome to the PBP with the existing message.
  const [outcome]=await owner.db.execute<{failure:string|null}>(sql`select failure from probation_outcome where id=${decision.id}::uuid`);
  expect(outcome.failure).toBe('The review is recorded. Select and complete the approved outcome letter before signing and release.');
 });
});

/** Signs (PBP, then the employee) and releases the outcome's prepared letter, then runs the owner sweep twice. */
async function signReleaseAndSweep(pbp:SessionContext,staff:{ctx:SessionContext},caseId:string,letterPartId:string){
 let letter=await readProbationLetter(pbp,caseId,letterPartId);const hr=letter.signing!.document.route.steps.find(s=>s.role==='pbp')!;
 await actOnProbationLetter(pbp,{caseId,partId:letter.id,revision:letter.storageRevision,stepId:hr.id,action:'signed',method:'typed',value:'Fictional PBP',consent:true});
 letter=await readProbationLetter(staff.ctx,caseId,letterPartId);const ack=letter.signing!.document.route.steps.find(s=>s.role==='employee')!;
 await actOnProbationLetter(staff.ctx,{caseId,partId:letter.id,revision:letter.storageRevision,stepId:ack.id,action:'signed',method:'typed',value:'Fictional Staff',consent:true});
 letter=await readProbationLetter(pbp,caseId,letterPartId);
 await releaseProbationLetter(pbp,{caseId,partId:letter.id,outcomeRevision:letter.outcomeRevision!,reason:'Release the signed letter'});
 const runner={...pbp,userId:undefined,roles:[],grants:undefined} as SessionContext;
 const port={withTenant:async<T>(context:SessionContext,run:(tx:Tx)=>Promise<T>)=>owner.withTenant(context,run)};
 await sweepProbation(runner,port);await sweepProbation(runner,port);
 return {runner,port};
}

describe('the default path when no workflow matches (I1, decision 4)',()=>{
 it('creates the Personnel posting and never writes the movement; approving the posting writes it once',async()=>{
  const {ids,staff,decision,endOn,admin:pbp}=await fixture.recordedConfirm([],{beforeRecord:async ctx=>{await letterTemplate(ctx,'confirm-'+randomUUID().slice(0,8));}});
  admin=pbp;
  expect(await runsOf(ids.caseId)).toEqual([]);
  // Today's path: the single published template is drafted automatically.
  const [outcome]=await owner.db.execute<{letter:string|null;failure:string|null}>(sql`select letter_part_id::text as letter,failure from probation_outcome where id=${decision.id}::uuid`);
  expect(outcome).toMatchObject({failure:null});expect(outcome.letter).toBeTruthy();
  const {runner,port}=await signReleaseAndSweep(admin,staff,ids.caseId,outcome.letter!);
  const state=()=>owner.db.execute<{outcomeState:string;movement:string|null;caseState:string;pending:{id:string;eventType:string}|null;confirmed:string|null}>(sql`
   select o.state as "outcomeState",o.movement_ref as movement,c.data->>'state' as "caseState",c.data->'pendingPosting' as pending,e.confirmation_date::text as confirmed
   from probation_outcome o join probation_case c on c.id=o.case_id join employment e on e.id=c.employment_id where o.id=${decision.id}::uuid`);
  const postings=await owner.db.execute<{id:string;status:string;event:string;group:string;revision:number;proposed:{effectiveDate:string}}>(sql`select id,status,event_type as event,approver_group_id as group,revision,proposed from personnel_posting where source_ref=${ids.caseId}::uuid`);
  expect(postings).toEqual([expect.objectContaining({status:'pending',event:'confirmation',group:'probation-people',proposed:expect.objectContaining({effectiveDate:endOn})})]);
  expect((await state())[0]).toEqual({outcomeState:'completed',movement:'posting:'+postings[0].id,caseState:'confirmed',pending:{id:postings[0].id,eventType:'confirmation'},confirmed:null});
  expect((await movementHistory(admin,staff.employmentId)).filter(row=>row.kind==='confirmation')).toEqual([]);
  // Another sweep changes nothing: the completed outcome is not applied again and no second posting appears.
  await sweepProbation(runner,port);
  expect(await owner.db.execute(sql`select 1 from personnel_posting where source_ref=${ids.caseId}::uuid`)).toHaveLength(1);
  // Only the posting-approver group's approval writes the movement, once.
  const approved=await approvePersonnelPosting(admin,{id:postings[0].id,revision:postings[0].revision});
  await expect(approvePersonnelPosting(admin,{id:postings[0].id,revision:postings[0].revision})).rejects.toThrow();
  expect((await movementHistory(admin,staff.employmentId)).filter(row=>row.kind==='confirmation').map(row=>row.id)).toEqual([approved.movementId]);
  expect((await state())[0]).toMatchObject({confirmed:endOn,pending:null,caseState:'confirmed'});
 });

 it('asks for a GBS retry instead of writing the movement when no group approves Personnel postings',async()=>{
  const {ids,staff,decision,admin:pbp}=await fixture.recordedConfirm([],{beforeRecord:async ctx=>{await letterTemplate(ctx,'confirm-'+randomUUID().slice(0,8));}});
  admin=pbp;
  await owner.db.execute(sql`update lc_v9_config set data=data-'peopleOpsGroup' where tenant_id=${b.tenantId}::uuid`);
  await owner.db.execute(sql`update probation_case set data=data#-'{config,postingApproverGroupId}' where id=${ids.caseId}::uuid`);
  const [outcome]=await owner.db.execute<{letter:string|null}>(sql`select letter_part_id::text as letter from probation_outcome where id=${decision.id}::uuid`);
  await signReleaseAndSweep(admin,staff,ids.caseId,outcome.letter!);
  const [after]=await owner.db.execute<{state:string;failure:string|null;movement:string|null}>(sql`select state,failure,movement_ref as movement from probation_outcome where id=${decision.id}::uuid`);
  expect(after.state).not.toBe('completed');expect(after.movement).toBeNull();expect(after.failure).toContain('approve Personnel postings');
  expect(await owner.db.execute(sql`select 1 from personnel_posting where source_ref=${ids.caseId}::uuid`)).toHaveLength(0);
  expect((await movementHistory(admin,staff.employmentId)).filter(row=>row.kind==='confirmation')).toEqual([]);
 });
});

describe('a run that fails after it created the posting (F7)',()=>{
 it('never falls back to writing the movement on the GBS retry: the outcome completes with the pending posting',async()=>{
  const key='confirm-'+randomUUID().slice(0,8);
  const {ids,staff,decision,admin:pbp}=await fixture.recordedConfirm([{id:'nobody',name:'Fictional empty group',members:[],limit:10}],{beforeRecord:async ctx=>{
   await letterTemplate(ctx,key);
   // The step after the posting reaches nobody: its group is empty and so is the case's fallback group.
   await owner.db.execute(sql`update probation_case set data=jsonb_set(data,'{config,fallbackGroupId}','"nobody"') where employment_id=(select e.id from employment e join person p on p.id=e.person_id where p.full_name='Fictional Staff' and e.tenant_id=${b.tenantId}::uuid)`);
   await liveWorkflow([{type:'generateDocument',params:{letterTemplateId:key}},{type:'createPosting',params:{eventType:'Confirmation'}},{type:'notify',params:{subject:'Confirmed',body:'Confirmed'},to:[{kind:'group',groupId:'nobody'}]}],[{field:'outcome',op:'is',values:['Confirm']}]);
  }});
  admin=pbp;
  const [outcome]=await owner.db.execute<{letter:string|null}>(sql`select letter_part_id::text as letter from probation_outcome where id=${decision.id}::uuid`);
  let letter=await readProbationLetter(admin,ids.caseId,outcome.letter!);const hr=letter.signing!.document.route.steps.find(s=>s.role==='pbp')!;
  await actOnProbationLetter(admin,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:hr.id,action:'signed',method:'typed',value:'Fictional PBP',consent:true});
  letter=await readProbationLetter(staff.ctx,ids.caseId,outcome.letter!);const ack=letter.signing!.document.route.steps.find(s=>s.role==='employee')!;
  await actOnProbationLetter(staff.ctx,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:ack.id,action:'signed',method:'typed',value:'Fictional Staff',consent:true});
  letter=await readProbationLetter(admin,ids.caseId,outcome.letter!);
  await releaseProbationLetter(admin,{caseId:ids.caseId,partId:letter.id,outcomeRevision:letter.outcomeRevision!,reason:'Release the signed letter'});
  const runner={...admin,userId:undefined,roles:[],grants:undefined} as SessionContext;
  const port={withTenant:async<T>(context:SessionContext,run:(tx:Tx)=>Promise<T>)=>owner.withTenant(context,run)};
  await sweepProbation(runner,port);await sweepProbation(runner,port);
  const state=()=>owner.db.execute<{outcomeState:string;failure:string|null;movement:string|null;caseState:string;pending:{id:string}|null;confirmed:string|null}>(sql`
   select o.state as "outcomeState",o.failure,o.movement_ref as movement,c.data->>'state' as "caseState",c.data->'pendingPosting' as pending,e.confirmation_date::text as confirmed
   from probation_outcome o join probation_case c on c.id=o.case_id join employment e on e.id=c.employment_id where o.id=${decision.id}::uuid`);
  // Resumed: the posting was created, the notice found nobody, the run failed and asked for a check by hand.
  expect(await runsOf(ids.caseId)).toEqual([expect.objectContaining({status:'failed'})]);
  const postings=await owner.db.execute<{id:string;status:string}>(sql`select id,status from personnel_posting where source_ref=${ids.caseId}::uuid`);
  expect(postings).toEqual([expect.objectContaining({status:'pending'})]);
  const [failed]=await state();
  expect(failed).toMatchObject({confirmed:null});expect(failed.outcomeState).not.toBe('completed');expect(failed.failure).toContain('release by hand');
  // The GBS retry completes the outcome with that posting; the movement is never written beside it.
  expect(await applyProbationOutcome(admin,decision.id)).toMatchObject({queued:true});
  await sweepProbation(runner,port);
  const [after]=await state();
  expect(after).toEqual({outcomeState:'completed',failure:null,movement:'posting:'+postings[0].id,caseState:'confirmed',pending:{id:postings[0].id,eventType:'confirmation'},confirmed:null});
  expect(await owner.db.execute(sql`select 1 from personnel_posting where source_ref=${ids.caseId}::uuid`)).toHaveLength(1);
 });
});

describe('Probation review events on the shared runner (W3)',()=>{
 it('runs live workflows when the Line Manager submits and when all approvals are complete, once each',async()=>{
  await liveWorkflow([{type:'notify',params:{subject:'Assessment submitted',body:'Submitted'},to:[{kind:'role',role:'directSuperior'}]}],[{field:'part',op:'is',values:['Part 3 · Final Confirmation Review']}],'lmSubmitted');
  await liveWorkflow([{type:'notify',params:{subject:'Approved',body:'All approvals are complete'},to:[{kind:'role',role:'employee'}]}],[],'approvalsComplete');
  const {ids,staff,manager}=await fixture.recordedConfirm();
  const runs=await owner.db.execute<{trigger:string;status:string}>(sql`select trigger_event as trigger,status from automation_run where subject_id=${ids.caseId}::uuid order by started_at`);
  expect(runs).toEqual([{trigger:'lmSubmitted',status:'done'},{trigger:'approvalsComplete',status:'done'}]);
  const notices=await owner.db.execute<{users:string[]}>(sql`select recipient_user_ids as users from probation_occurrence where case_id=${ids.caseId}::uuid and kind='automation' order by created_at`);
  expect(notices).toEqual([{users:[manager.userId]},{users:[staff.userId]}]);
 });
});
