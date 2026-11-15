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
import {saveProbationLetterTemplate,prepareProbationLetter,readProbationLetter} from '../packs/probation/service';
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
