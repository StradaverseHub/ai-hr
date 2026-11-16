// Lane I (I2, I3; migration 5760; handoff B4, B5, §6): letter steps reach the queue their kind names, and the PBP's own
// tasks for a low result and an Other outcome appear, clear when acted on, and let the case continue. Fictional people.
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {adminCtx,closeAll,setModule,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {probationOutcomeFixture} from './helpers/probation-outcome-fixture';
import {newProbationLetterTemplate} from '../lib/probation-letter-template';
import type {SessionContext,Tx} from '../db/client';
import type {DocumentRouting} from '../lib/document-signing-routing';
import {saveProbationLetterTemplate,prepareProbationLetter,readProbationLetter,actOnProbationLetter,releaseProbationLetter,sweepProbation,probationTaskList,
 probationSummaryRows,recordProbationLowResultAction,decideProbationOtherOutcome,probationCase} from '../packs/probation/service';

let b:Base,admin:SessionContext,fixture:ReturnType<typeof probationOutcomeFixture>;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);fixture=probationOutcomeFixture(b,admin);});
const onCase=(caseId:string,list:{items:{caseId:string}[]})=>list.items.filter(item=>item.caseId===caseId);

function template(outcome:'confirm'|'extend',key:string,routing?:DocumentRouting){
 const t=newProbationLetterTemplate(outcome,key,'Fictional '+outcome+' letter');t.unfinished=false;
 t.blocks=t.blocks.filter(block=>block.type!=='letterhead'&&(!routing||block.type!=='signature'));t.blocks.find(block=>block.type==='text')!.text='Outcome for {employeeName}.';
 if(routing)for(const step of routing.filter(s=>s.action==='sign'))t.blocks.push({id:'sig-'+step.id,type:'signature',text:'',section:'',role:'step:'+step.id,label:'Signed'});
 return routing?{...t,routing}:t;
}

describe('letter steps by kind (I2)',()=>{
 it('puts a Review step in Approval Items and a Sign step in the tasks, and moves on as each acts',async()=>{
  const {ids,peer,decision,admin:pbp}=await fixture.recordedConfirm();admin=pbp;
  const routing:DocumentRouting=[
   {id:'review',order:1,action:'review',owner:true,who:{kind:'people',userIds:[peer.userId]}},
   {id:'sign-hr',order:2,action:'sign',owner:false,who:{kind:'group',groupId:'probation-people'}},
   {id:'sign-staff',order:3,action:'sign',owner:false,who:{kind:'employee'}},
  ];
  const templateId=await saveProbationLetterTemplate(admin,{companyId:b.companyId,template:template('confirm','routed-'+randomUUID().slice(0,8),routing),publish:true,expectedVersion:0});
  const [current]=await owner.db.execute<{revision:number}>(sql`select revision from probation_outcome where id=${decision.id}::uuid`);
  const prepared=await prepareProbationLetter(admin,{outcomeId:decision.id,templateId,revision:current.revision,edits:{}});
  const href='/lifecycle/probation/'+ids.caseId+'/letters/'+prepared.partId;
  // The reviewer's Review step is an Approval Item, not a task.
  expect(onCase(ids.caseId,await probationTaskList(peer.ctx,{category:'approval'}))).toEqual([expect.objectContaining({partId:prepared.partId,kind:'letter_review',category:'approval',href})]);
  expect(onCase(ids.caseId,await probationTaskList(peer.ctx,{category:'task'}))).toEqual([]);
  // The HR signer's step is not pending yet.
  expect(onCase(ids.caseId,await probationTaskList(admin,{category:'approval'})).filter(item=>item.partId===prepared.partId)).toEqual([]);
  let letter=await readProbationLetter(peer.ctx,ids.caseId,prepared.partId);
  await actOnProbationLetter(peer.ctx,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:'review',action:'reviewed'});
  expect(onCase(ids.caseId,await probationTaskList(peer.ctx))).toEqual([]);
  // Now the Sign step is a task for the HR signer, never an Approval Item.
  expect(onCase(ids.caseId,await probationTaskList(admin,{category:'task'})).filter(item=>item.partId===prepared.partId)).toEqual([expect.objectContaining({kind:'letter_sign',category:'task',href})]);
  expect(onCase(ids.caseId,await probationTaskList(admin,{category:'approval'})).filter(item=>item.partId===prepared.partId)).toEqual([]);
  letter=await readProbationLetter(admin,ids.caseId,prepared.partId);
  expect(letter.state).toBe('pending_approval');
 });
});

describe('the PBP\'s low-result task (I3)',()=>{
 it('appears for a Band at or below the case\'s low band and clears once the action is recorded',async()=>{
  const {ids,staff,peer,admin:pbp}=await fixture.recordedConfirm([],{rating:1});admin=pbp;
  const [part]=await owner.db.execute<{band:number;revision:number}>(sql`select (data->>'scoreBand')::integer as band,content_revision as revision from probation_part where id=${ids.part}::uuid`);
  expect(part.band).toBe(1);
  expect(onCase(ids.caseId,await probationTaskList(admin,{category:'task'})).filter(item=>item.kind==='low_result_action')).toEqual([expect.objectContaining({partId:ids.part,category:'task',href:'/lifecycle/probation/'+ids.caseId})]);
  expect(onCase(ids.caseId,await probationTaskList(admin,{category:'approval'})).filter(item=>item.kind==='low_result_action')).toEqual([]);
  const row=async()=>(await probationSummaryRows(admin,{})).rows.find(r=>r.id===ids.caseId)!;
  expect((await row()).action).toBe('record_action');
  // Only the case's PBP or GBS records it, with a note.
  await expect(recordProbationLowResultAction(staff.ctx,{partId:ids.part,note:'Fictional note'})).rejects.toThrow();
  await expect(recordProbationLowResultAction(peer.ctx,{partId:ids.part,note:'Fictional note'})).rejects.toThrow();
  await expect(recordProbationLowResultAction(admin,{partId:ids.part,note:'no'})).rejects.toThrow();
  await recordProbationLowResultAction(admin,{partId:ids.part,note:'Agreed a coaching plan with the Line Manager'});
  await expect(recordProbationLowResultAction(admin,{partId:ids.part,note:'Again'})).rejects.toThrow();
  expect(onCase(ids.caseId,await probationTaskList(admin)).filter(item=>item.kind==='low_result_action')).toEqual([]);
  expect((await row()).action).not.toBe('record_action');
  const followups=await owner.db.execute<{kind:string;revision:number}>(sql`select kind,content_revision as revision from probation_followup where part_id=${ids.part}::uuid and kind='low_result_action'`);
  expect(followups).toEqual([{kind:'low_result_action',revision:part.revision}]);
  expect(await owner.db.execute(sql`select 1 from domain_event where aggregate_id=${ids.caseId}::uuid and event_type='probation.low_result_action_recorded'`)).toHaveLength(1);
  expect((await probationCase(admin,ids.caseId)).followups.some(f=>f.kind==='low_result_action'&&f.partId===ids.part)).toBe(true);
 });

 it('follows the case\'s pinned low band instead of a fixed Band 2',async()=>{
  const {ids,admin:pbp}=await fixture.recordedConfirm([],{rating:3});admin=pbp;
  expect(onCase(ids.caseId,await probationTaskList(admin)).filter(item=>item.kind==='low_result_action')).toEqual([]);
  await owner.db.execute(sql`update probation_case set data=jsonb_set(data,'{config,lowBand}','3') where id=${ids.caseId}::uuid`);
  expect(onCase(ids.caseId,await probationTaskList(admin)).filter(item=>item.kind==='low_result_action')).toEqual([expect.objectContaining({partId:ids.part})]);
  const tracker=await probationSummaryRows(admin,{flag:'low_result'});
  expect(tracker.rows.map(r=>r.id)).toContain(ids.caseId);
  expect(tracker.rows.find(r=>r.id===ids.caseId)?.action).toBe('record_action');
 });
});

describe('an Other outcome (I3, handoff B4)',()=>{
 it('waits with a PBP task, then proceeds as the outcome the PBP chooses: letter, signatures, posting, extension',async()=>{
  const {ids,staff,peer,decision,endOn,admin:pbp}=await fixture.recordedConfirm([],{outcome:'other',beforeRecord:async ctx=>{
   await saveProbationLetterTemplate(ctx,{companyId:b.companyId,template:template('extend','extend-'+randomUUID().slice(0,8)),publish:true,expectedVersion:0});
  }});
  admin=pbp;
  const outcome=async()=>(await owner.db.execute<{outcome:string;revision:number;months:number|null;failure:string|null;letter:string|null;state:string}>(sql`select outcome,revision,extension_months as months,failure,letter_part_id::text as letter,state from probation_outcome where id=${decision.id}::uuid`))[0];
  const parked=await outcome();
  expect(parked).toMatchObject({outcome:'other',letter:null,months:null});expect(parked.failure).toContain('PBP chooses');
  expect(onCase(ids.caseId,await probationTaskList(admin,{category:'task'})).filter(item=>item.kind==='choose_outcome')).toEqual([expect.objectContaining({partId:ids.part,href:'/lifecycle/probation/'+ids.caseId+'/outcomes/'+decision.id})]);
  // Authorised: only the case's PBP or GBS; a reason and a valid length are required; the revision must be current.
  const input={caseId:ids.caseId,outcomeId:decision.id,revision:parked.revision,outcome:'extend' as const,months:3 as const,reason:'Needs three more months on the core tasks'};
  await expect(decideProbationOtherOutcome(staff.ctx,input)).rejects.toThrow();
  await expect(decideProbationOtherOutcome(peer.ctx,input)).rejects.toThrow();
  await expect(decideProbationOtherOutcome(admin,{...input,months:null})).rejects.toThrow();
  await expect(decideProbationOtherOutcome(admin,{...input,revision:parked.revision+5})).rejects.toThrow();
  await decideProbationOtherOutcome(admin,input);
  await expect(decideProbationOtherOutcome(admin,{...input,revision:parked.revision+1})).rejects.toThrow();
  const decided=await outcome();
  // Proceeds as Extend in the same transaction: the single matching extend letter is drafted, no failure is left.
  expect(decided).toMatchObject({outcome:'extend',months:3,revision:parked.revision+1,failure:null});expect(decided.letter).toBeTruthy();
  expect(onCase(ids.caseId,await probationTaskList(admin)).filter(item=>item.kind==='choose_outcome')).toEqual([]);
  const [noted]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from probation_followup where case_id=${ids.caseId}::uuid and kind='other_decided'`);expect(noted.n).toBe(1);
  expect(await owner.db.execute(sql`select 1 from domain_event where aggregate_id=${ids.caseId}::uuid and event_type='probation.other_outcome_decided'`)).toHaveLength(1);
  // The letter carries the chosen extension; sign, release and apply: an extension posting for 3 months, the end date moves.
  const {addDaysIso}=await import('../lib/roster-month'),{addCalendarMonths}=await import('../lib/hr-date');
  const newEnd=addDaysIso(addCalendarMonths(addDaysIso(endOn,1),3),-1);
  const [merge]=await owner.db.execute<{months:string|null;newEnd:string|null}>(sql`select data->'letterMerge'->>'extensionMonths' as months,data->'letterMerge'->>'extensionNewEndOn' as "newEnd" from probation_part where id=${decided.letter}::uuid`);
  expect(merge).toEqual({months:'3',newEnd});
  let letter=await readProbationLetter(admin,ids.caseId,decided.letter!);
  const hr=letter.signing!.document.route.steps.find(s=>s.role==='pbp')!;
  await actOnProbationLetter(admin,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:hr.id,action:'signed',method:'typed',value:'Fictional PBP',consent:true});
  letter=await readProbationLetter(staff.ctx,ids.caseId,decided.letter!);const ack=letter.signing!.document.route.steps.find(s=>s.role==='employee')!;
  await actOnProbationLetter(staff.ctx,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:ack.id,action:'signed',method:'typed',value:'Fictional Staff',consent:true});
  letter=await readProbationLetter(admin,ids.caseId,decided.letter!);
  await releaseProbationLetter(admin,{caseId:ids.caseId,partId:letter.id,outcomeRevision:letter.outcomeRevision!,reason:'Release the signed letter'});
  const runner={...admin,userId:undefined,roles:[],grants:undefined} as SessionContext;
  const port={withTenant:async<T>(context:SessionContext,run:(tx:Tx)=>Promise<T>)=>owner.withTenant(context,run)};
  await sweepProbation(runner,port);await sweepProbation(runner,port);
  const postings=await owner.db.execute<{event:string;status:string;proposed:{effectiveDate:string;endDate:string}}>(sql`select event_type as event,status,proposed from personnel_posting where source_ref=${ids.caseId}::uuid`);
  expect(postings).toEqual([expect.objectContaining({event:'probationExtension',status:'pending',proposed:expect.objectContaining({effectiveDate:addDaysIso(endOn,1),endDate:newEnd})})]);
  const [record]=await owner.db.execute<{state:string;endOn:string;count:number}>(sql`select data->>'state' as state,data->>'endOn' as "endOn",(data->>'extensionCount')::int as count from probation_case where id=${ids.caseId}::uuid`);
  expect(record).toEqual({state:'extended',endOn:newEnd,count:1});
  expect((await outcome()).state).toBe('completed');
 });
});
