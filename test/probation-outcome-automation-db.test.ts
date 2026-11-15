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
import {saveProbationLetterTemplate,readProbationLetter,actOnProbationLetter,releaseProbationLetter,sweepProbation} from '../packs/probation/service';

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
