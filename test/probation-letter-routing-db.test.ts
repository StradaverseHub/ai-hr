// Probation letters generated from a template version with signing and review routing (lane D2 / W1, migration 5752).
// Real authorized fixtures: a recorded Confirm outcome on a native case, a routed template version, then Review,
// send back, re-send, Sign and release. Letters without routing keep today's flow (test/probation-persistence.test.ts).
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {adminCtx,closeAll,setModule,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {probationOutcomeFixture} from './helpers/probation-outcome-fixture';
import {newProbationLetterTemplate} from '../lib/probation-letter-template';
import {withTenant,type SessionContext} from '../db/client';
import {saveProbationLetterTemplate,probationLetterTemplates,prepareProbationLetter,readProbationLetter,actOnProbationLetter,resendProbationLetter,releaseProbationLetter} from '../packs/probation/service';
import type {DocumentRouting} from '../lib/document-signing-routing';

let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
let fixture:ReturnType<typeof probationOutcomeFixture>;
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);fixture=probationOutcomeFixture(b,admin);});
const recordedConfirm=async(...args:Parameters<ReturnType<typeof probationOutcomeFixture>['recordedConfirm']>)=>{const result=await fixture.recordedConfirm(...args);admin=result.admin;return result;};

function routedTemplate(key:string,routing:DocumentRouting){
 const template=newProbationLetterTemplate('confirm',key,'Fictional routed confirmation letter');
 template.unfinished=false;
 template.blocks=template.blocks.filter(block=>block.type!=='letterhead'&&block.type!=='signature');
 template.blocks.find(block=>block.type==='text')!.text='Confirmation for {employeeName}.';
 for(const step of routing.filter(s=>s.action==='sign'))template.blocks.push({id:'sig-'+step.id,type:'signature',text:'',section:'',role:'step:'+step.id,label:'Signed'});
 return{...template,routing};
}

describe('routed Probation letters (5752)',()=>{
 it('stores the routing, freezes it per employee and runs Review, send back, re-send, Sign and release',async()=>{
  const{ids,staff,peer,decision}=await recordedConfirm();
  const routing:DocumentRouting=[
   {id:'review',order:1,action:'review',owner:true,who:{kind:'people',userIds:[peer.userId]}},
   {id:'sign-hr',order:2,action:'sign',owner:false,who:{kind:'group',groupId:'probation-people'}},
   {id:'sign-staff',order:3,action:'sign',owner:false,who:{kind:'employee'}},
  ];
  const key='routed-'+randomUUID().slice(0,8);
  // Routing is checked against current groups, and a routed version needs signature blocks linked to its Sign steps.
  await expect(saveProbationLetterTemplate(admin,{companyId:b.companyId,template:routedTemplate(key,[{...routing[1],who:{kind:'group',groupId:'no-such-group'}},routing[2]]),publish:true,expectedVersion:0})).rejects.toThrow();
  const unlinked=routedTemplate(key,routing);unlinked.blocks=unlinked.blocks.filter(block=>block.role!=='step:sign-staff');
  await expect(saveProbationLetterTemplate(admin,{companyId:b.companyId,template:unlinked,publish:true,expectedVersion:0})).rejects.toThrow();
  const templateId=await saveProbationLetterTemplate(admin,{companyId:b.companyId,template:routedTemplate(key,routing),publish:true,expectedVersion:0});
  const stored=(await probationLetterTemplates(admin,b.companyId)).find(t=>t.id===templateId)!;
  expect((stored.data as unknown as {routing:DocumentRouting}).routing).toEqual(routing);

  const prepared=await prepareProbationLetter(admin,{outcomeId:decision.id,templateId,revision:decision.revision,edits:{}});
  let letter=await readProbationLetter(admin,ids.caseId,prepared.partId);
  expect(letter.routed).toBe(true);
  expect(letter.signing!.document.routing).toMatchObject({templateId:key,templateVersion:1,caseOwnerId:admin.userId,fallbackGroupId:'probation-people'});
  expect(letter.signing!.document.route.steps.map(s=>({id:s.id,kind:s.kind,stage:s.stage,role:s.role,holderId:s.holderId}))).toEqual([
   {id:'review',kind:'review',stage:1,role:'people',holderId:peer.userId},
   {id:'sign-hr',kind:'sign',stage:2,role:'group:probation-people',holderId:admin.userId},
   {id:'sign-staff',kind:'sign',stage:3,role:'employee',holderId:staff.userId},
  ]);
  expect(letter.owner).toEqual({stepId:'review',userId:peer.userId});
  expect(letter.unresolved).toEqual([]);
  // The frozen route cannot be frozen again.
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.probation_letter_freeze_route(${prepared.partId}::uuid,${JSON.stringify(letter.signing!.document.route)}::jsonb,'[]'::jsonb)`))).rejects.toThrow();
  // Not the employee's turn yet: no access to the content.
  await expect(readProbationLetter(staff.ctx,ids.caseId,prepared.partId)).rejects.toThrow();

  // The reviewer (the owner) reviews; Sign is refused for a Review step.
  letter=await readProbationLetter(peer.ctx,ids.caseId,prepared.partId);
  expect(letter.contentVisible).toBe(true);expect(letter.canEditContent).toBe(true);
  await expect(actOnProbationLetter(peer.ctx,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:'review',action:'signed',method:'typed',value:'Fictional Reviewer',consent:true})).rejects.toThrow();
  await actOnProbationLetter(peer.ctx,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:'review',action:'reviewed'});
  // The HR signer sends it back to the owner; only the owner sends it round again.
  letter=await readProbationLetter(admin,ids.caseId,prepared.partId);
  await actOnProbationLetter(admin,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:'sign-hr',action:'returned',comment:'Please check the effective date wording'});
  letter=await readProbationLetter(admin,ids.caseId,prepared.partId);expect(letter.state).toBe('returned');
  await expect(resendProbationLetter(admin,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision})).rejects.toThrow();
  letter=await readProbationLetter(peer.ctx,ids.caseId,prepared.partId);
  await resendProbationLetter(peer.ctx,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,comment:'Checked; sending again'});
  letter=await readProbationLetter(admin,ids.caseId,prepared.partId);expect(letter.state).toBe('pending_approval');
  // The round restarts: the review is needed again before HR signs.
  await expect(actOnProbationLetter(admin,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:'sign-hr',action:'signed',method:'typed',value:'Fictional PBP',consent:true})).rejects.toThrow();
  letter=await readProbationLetter(peer.ctx,ids.caseId,prepared.partId);
  await actOnProbationLetter(peer.ctx,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:'review',action:'reviewed'});
  letter=await readProbationLetter(admin,ids.caseId,prepared.partId);
  await actOnProbationLetter(admin,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:'sign-hr',action:'signed',method:'typed',value:'Fictional PBP',consent:true});
  // Now the employee's turn: content visible, signature lands on the employee's step block.
  letter=await readProbationLetter(staff.ctx,ids.caseId,prepared.partId);expect(letter.contentVisible).toBe(true);expect(letter.canEditContent).toBe(false);
  await actOnProbationLetter(staff.ctx,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:'sign-staff',action:'signed',method:'typed',value:'Fictional Staff',consent:true});
  letter=await readProbationLetter(admin,ids.caseId,prepared.partId);
  expect(Object.keys(letter.document.stepSignatures??{}).sort()).toEqual(['sign-hr','sign-staff']);
  expect(letter.document.stepSignatures!['sign-staff'].by.id).toBe(staff.userId);
  expect(letter.document.status).toBe('signed');
  const request=await releaseProbationLetter(admin,{caseId:ids.caseId,partId:prepared.partId,outcomeRevision:prepared.outcomeRevision,reason:'Release the routed signed letter'});
  expect(request).toMatch(/^[a-f0-9-]{36}$/);
 });

 it('gives a step nobody can take to the fallback group and records who it was meant for',async()=>{
  const{ids,staff,decision}=await recordedConfirm([{id:'empty-group',name:'Fictional empty group',members:[],limit:10}]);
  const routing:DocumentRouting=[
   {id:'sign-hr',order:1,action:'sign',owner:true,who:{kind:'group',groupId:'empty-group'}},
   {id:'sign-staff',order:2,action:'sign',owner:false,who:{kind:'employee'}},
  ];
  const templateId=await saveProbationLetterTemplate(admin,{companyId:b.companyId,template:routedTemplate('fallback-'+randomUUID().slice(0,8),routing),publish:true,expectedVersion:0});
  const prepared=await prepareProbationLetter(admin,{outcomeId:decision.id,templateId,revision:decision.revision,edits:{}});
  const letter=await readProbationLetter(admin,ids.caseId,prepared.partId);
  const hr=letter.signing!.document.route.steps.find(s=>s.id==='sign-hr')!;
  expect(hr.holderId).toBe(admin.userId);expect(hr.meantFor).toBe('The assignment group empty-group');
  expect(letter.signing!.document.route.steps.find(s=>s.id==='sign-staff')!.holderId).toBe(staff.userId);
  expect(letter.unresolved).toEqual([expect.objectContaining({stepId:'sign-hr',meantFor:'The assignment group empty-group',fallbackGroupId:'probation-people',holderId:admin.userId})]);
  const events=await owner.db.execute<{payload:{unresolved:{stepId:string}[]}}>(sql`select payload from domain_event where aggregate_id=${ids.caseId}::uuid and event_type='probation.letter_routing_fallback'`);
  expect(events.map(e=>e.payload.unresolved.map(u=>u.stepId))).toEqual([['sign-hr']]);
 });
});
