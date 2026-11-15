// Routed Probation letter steps (lane F2/F3, migration 5755): one person per routing or group step is chosen by the V9
// assignment owner's rule on real facts (leave today, open-task limit, open load), a step nobody can take goes to the
// fallback group with the reason recorded, and a general Probation delegation moves a Head of Department, PBP or GBS
// step to the delegate on behalf of the holder (decision 7). Fictional people only.
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {adminCtx,closeAll,setModule,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {probationOutcomeFixture} from './helpers/probation-outcome-fixture';
import {newProbationLetterTemplate} from '../lib/probation-letter-template';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {SessionContext} from '../db/client';
import {saveProbationLetterTemplate,prepareProbationLetter,readProbationLetter,actOnProbationLetter} from '../packs/probation/service';
import {addDaysIso} from '../lib/roster-month';
import type {DocumentRouting} from '../lib/document-signing-routing';

let b:Base,admin:SessionContext,fixture:ReturnType<typeof probationOutcomeFixture>;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);fixture=probationOutcomeFixture(b,admin);});

function routedTemplate(key:string,routing:DocumentRouting){
 const template=newProbationLetterTemplate('confirm',key,'Fictional routed confirmation letter');
 template.unfinished=false;
 template.blocks=template.blocks.filter(block=>block.type!=='letterhead'&&block.type!=='signature');
 template.blocks.find(block=>block.type==='text')!.text='Confirmation for {employeeName}.';
 for(const step of routing.filter(s=>s.action==='sign'))template.blocks.push({id:'sig-'+step.id,type:'signature',text:'',section:'',role:'step:'+step.id,label:'Signed'});
 return{...template,routing};
}
const onLeaveToday=(employmentId:string)=>owner.db.execute(sql`insert into leave_request(tenant_id,employment_id,leave_type_id,start_date,end_date,days,status,reason) values(${b.tenantId}::uuid,${employmentId}::uuid,${b.annualLeaveTypeId}::uuid,${todayInKualaLumpur()}::date,${todayInKualaLumpur()}::date,1,'approved','Fictional approved leave')`);

describe('routed letter assignment (F2)',()=>{
 it('skips a group member on leave today although member order names them first',async()=>{
  let peerId='';
  const {ids,staff,peer,decision,admin:pbp}=await fixture.recordedConfirm([],{beforeRecord:async()=>{}});admin=pbp;peerId=peer.userId;
  await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(data,'{groups}',data->'groups'||${JSON.stringify([{id:'signers',name:'Fictional signers',members:[peerId,pbp.userId],limit:0}])}::jsonb) where tenant_id=${b.tenantId}::uuid`);
  await onLeaveToday(peer.employmentId);
  const routing:DocumentRouting=[
   {id:'sign-hr',order:1,action:'sign',owner:true,who:{kind:'group',groupId:'signers'},pick:'any'},
   {id:'sign-staff',order:2,action:'sign',owner:false,who:{kind:'employee'}},
  ];
  const templateId=await saveProbationLetterTemplate(admin,{companyId:b.companyId,template:routedTemplate('assign-'+randomUUID().slice(0,8),routing),publish:true,expectedVersion:0});
  const prepared=await prepareProbationLetter(admin,{outcomeId:decision.id,templateId,revision:decision.revision,edits:{}});
  const letter=await readProbationLetter(admin,ids.caseId,prepared.partId);
  expect(letter.signing!.document.route.steps.map(s=>({id:s.id,holderId:s.holderId}))).toEqual([{id:'sign-hr',holderId:pbp.userId},{id:'sign-staff',holderId:staff.userId}]);
  expect(letter.unresolved).toEqual([]);
 });

 it('gives the step to the fallback group with the assignment owner\'s reason when everyone is on leave',async()=>{
  const {ids,peer,decision,admin:pbp}=await fixture.recordedConfirm();admin=pbp;
  await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(data,'{groups}',data->'groups'||${JSON.stringify([{id:'away',name:'Fictional away group',members:[peer.userId],limit:0}])}::jsonb) where tenant_id=${b.tenantId}::uuid`);
  await onLeaveToday(peer.employmentId);
  const routing:DocumentRouting=[
   {id:'sign-hr',order:1,action:'sign',owner:true,who:{kind:'group',groupId:'away'},pick:'roundRobin'},
   {id:'sign-staff',order:2,action:'sign',owner:false,who:{kind:'employee'}},
  ];
  const templateId=await saveProbationLetterTemplate(admin,{companyId:b.companyId,template:routedTemplate('away-'+randomUUID().slice(0,8),routing),publish:true,expectedVersion:0});
  const prepared=await prepareProbationLetter(admin,{outcomeId:decision.id,templateId,revision:decision.revision,edits:{}});
  const letter=await readProbationLetter(admin,ids.caseId,prepared.partId);
  expect(letter.signing!.document.route.steps.find(s=>s.id==='sign-hr')).toMatchObject({holderId:pbp.userId,meantFor:'The assignment group away'});
  expect(letter.unresolved).toEqual([expect.objectContaining({stepId:'sign-hr',reason:`Everyone in Fictional away group is on leave on ${todayInKualaLumpur()}.`,holderId:pbp.userId})]);
 });

 it('answers the facts only to someone who may run the case\'s workflows',async()=>{
  const {ids,staff}=await fixture.recordedConfirm();
  const stranger={...staff.ctx,userId:randomUUID()} as SessionContext;
  await expect(owner.withTenant(stranger,tx=>tx.execute(sql`select app.probation_assignment_facts(${ids.caseId}::uuid,'{probation-people}'::text[],'{}'::uuid[])`))).rejects.toThrow();
 });
});

describe('routed letter delegation (F3, decision 7)',()=>{
 const routing:DocumentRouting=[
  {id:'sign-hod',order:1,action:'sign',owner:true,who:{kind:'people',userIds:[]}},
  {id:'sign-staff',order:2,action:'sign',owner:false,who:{kind:'employee'}},
 ];
 async function delegated(module:'probation'|'leave'){
  const {ids,staff,peer,decision,admin:pbp}=await fixture.recordedConfirm();admin=pbp;
  const delegate=await fixture.person('Fictional Letter Delegate');
  const[line]=await owner.db.execute<{id:string}>(sql`insert into reporting_line(tenant_id,subordinate_employment_id,manager_employment_id,line_type,valid_from) values(${b.tenantId}::uuid,${peer.employmentId}::uuid,${delegate.employmentId}::uuid,'delegate',${addDaysIso(todayInKualaLumpur(),-1)}::date) returning id`);
  await owner.db.execute(sql`insert into reporting_line_scope(tenant_id,reporting_line_id,module,task_type) values(${b.tenantId}::uuid,${line.id}::uuid,${module},${module==='probation'?'probation.letter_sign':null})`);
  // The Head of Department (the fixture's department head) holds the routed Sign step.
  const steps=routing.map(step=>step.id==='sign-hod'?{...step,who:{kind:'people' as const,userIds:[peer.userId]}}:step);
  const templateId=await saveProbationLetterTemplate(admin,{companyId:b.companyId,template:routedTemplate('delegate-'+randomUUID().slice(0,8),steps),publish:true,expectedVersion:0});
  const prepared=await prepareProbationLetter(admin,{outcomeId:decision.id,templateId,revision:decision.revision,edits:{}});
  return{ids,staff,peer,delegate,prepared};
 }
 it('moves the Head of Department\'s routed Sign step to the delegate on behalf of the holder; the employee step never moves',async()=>{
  const{ids,staff,peer,delegate,prepared}=await delegated('probation');
  let letter=await readProbationLetter(delegate.ctx,ids.caseId,prepared.partId);
  expect(letter.route!.steps.map(s=>({id:s.id,holderId:s.holderId,representedId:s.representedId??null}))).toEqual([
   {id:'sign-hod',holderId:delegate.userId,representedId:peer.userId},
   {id:'sign-staff',holderId:staff.userId,representedId:null},
  ]);
  await actOnProbationLetter(delegate.ctx,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:'sign-hod',action:'signed',method:'typed',value:'Fictional Letter Delegate',consent:true});
  letter=await readProbationLetter(admin,ids.caseId,prepared.partId);
  expect(letter.signing!.document.actions).toContainEqual(expect.objectContaining({stepId:'sign-hod',action:'signed',actorId:delegate.userId,representedId:peer.userId}));
 });
 it('keeps the holder when the delegation does not tick Probation, and a per-part replacement wins over the delegation',async()=>{
  const other=await delegated('leave');
  let letter=await readProbationLetter(admin,other.ids.caseId,other.prepared.partId);
  expect(letter.route!.steps.find(s=>s.id==='sign-hod')).toMatchObject({holderId:other.peer.userId});
  expect(letter.route!.steps.find(s=>s.id==='sign-hod')!.representedId).toBeUndefined();
  await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);fixture=probationOutcomeFixture(b,admin);
  const ticked=await delegated('probation');
  const replacement=await fixture.person('Fictional Part Replacement');
  await owner.db.execute(sql`insert into probation_delegate(tenant_id,part_id,step_id,holder_id,represented_id,kind,reason,created_by,valid_from) values(${b.tenantId}::uuid,${ticked.prepared.partId}::uuid,'sign-hod',${replacement.userId}::uuid,${ticked.peer.userId}::uuid,'delegation','Fictional per-part replacement',${admin.userId}::uuid,${addDaysIso(todayInKualaLumpur(),-1)}::date)`);
  letter=await readProbationLetter(admin,ticked.ids.caseId,ticked.prepared.partId);
  expect(letter.route!.steps.find(s=>s.id==='sign-hod')).toMatchObject({holderId:replacement.userId,representedId:ticked.peer.userId});
 });
});

