// Probation letter signers (lane L, L3/L4, migration 5765): a routed letter's unsigned signature blocks and its
// "Required signers" list name the person holding each Sign step on the letter's frozen route, never "[Signatory]".
// Real authorized fixtures (test/helpers/probation-outcome-fixture.ts); fictional people only.
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {adminCtx,closeAll,createAppUser,setModule,migrateTestDb,resetDb,seedBase,type Base} from './harness';
import {probationOutcomeFixture} from './helpers/probation-outcome-fixture';
import {newProbationLetterTemplate} from '../lib/probation-letter-template';
import {v9SignaturePresentation} from '../lib/lifecycle-v9-signature-presentation';
import {hireEmployee} from '../core/org';
import {withTenant,type SessionContext} from '../db/client';
import {saveProbationLetterTemplate,prepareProbationLetter,readProbationLetter,actOnProbationLetter} from '../packs/probation/service';
import type {DocumentRouting} from '../lib/document-signing-routing';

let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
let fixture:ReturnType<typeof probationOutcomeFixture>;
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);fixture=probationOutcomeFixture(b,admin);});

function routedTemplate(key:string,routing:DocumentRouting){
 const template=newProbationLetterTemplate('confirm',key,'Fictional routed confirmation letter');
 template.unfinished=false;
 template.blocks=template.blocks.filter(block=>block.type!=='letterhead'&&block.type!=='signature');
 template.blocks.find(block=>block.type==='text')!.text='Confirmation for {employeeName}.';
 for(const step of routing.filter(s=>s.action==='sign'))template.blocks.push({id:'sig-'+step.id,type:'signature',text:'',section:'',role:'step:'+step.id,label:'Signed'});
 return{...template,routing};
}

describe('Probation letter signers (5765)',()=>{
 it('names the holder of each Sign step on the generated letter and in Required signers, and only for people who may open it',async()=>{
  const result=await fixture.recordedConfirm();admin=result.admin;
  const{ids,staff,peer,decision}=result;
  const routing:DocumentRouting=[
   {id:'review',order:1,action:'review',owner:true,who:{kind:'people',userIds:[peer.userId]}},
   {id:'sign-hr',order:2,action:'sign',owner:false,who:{kind:'group',groupId:'probation-people'}},
   {id:'sign-staff',order:3,action:'sign',owner:false,who:{kind:'employee'}},
  ];
  const templateId=await saveProbationLetterTemplate(admin,{companyId:b.companyId,template:routedTemplate('signers-'+randomUUID().slice(0,8),routing),publish:true,expectedVersion:0});
  const prepared=await prepareProbationLetter(admin,{outcomeId:decision.id,templateId,revision:decision.revision,edits:{}});
  let letter=await readProbationLetter(admin,ids.caseId,prepared.partId);
  // Independent expectation: the frozen route's holders, as the signing store recorded them.
  const holders=Object.fromEntries(letter.signing!.document.route.steps.map(step=>[step.id,step.holderId]));
  expect(holders).toEqual({review:peer.userId,'sign-hr':admin.userId,'sign-staff':staff.userId});
  expect(letter.signers).toEqual({
   review:expect.objectContaining({holderId:peer.userId,name:'Fictional Reviewer',role:'people',representedName:null}),
   'sign-hr':expect.objectContaining({holderId:admin.userId,name:'Fictional HR Partner',role:'group:probation-people',label:'Fictional People Ops'}),
   'sign-staff':expect.objectContaining({holderId:staff.userId,name:'Fictional Staff',role:'employee'}),
  });
  // The unsigned signature blocks print the person who will sign, never the placeholder.
  for(const[step,name] of [['sign-hr','Fictional HR Partner'],['sign-staff','Fictional Staff']] as const){
   const block=v9SignaturePresentation(letter.document,`step:${step}`);
   expect(block.name).toBe(name);expect(block.status).toBe('Not signed yet');
  }

  // Once a step is signed, the block prints the authenticated signature receipt instead.
  await actOnProbationLetter(peer.ctx,{caseId:ids.caseId,partId:letter.id,revision:(await readProbationLetter(peer.ctx,ids.caseId,prepared.partId)).storageRevision,stepId:'review',action:'reviewed'});
  letter=await readProbationLetter(admin,ids.caseId,prepared.partId);
  await actOnProbationLetter(admin,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:'sign-hr',action:'signed',method:'typed',value:'Fictional HR Partner',consent:true});
  letter=await readProbationLetter(admin,ids.caseId,prepared.partId);
  const signed=v9SignaturePresentation(letter.document,'step:sign-hr');
  expect(signed.signature?.by.id).toBe(admin.userId);expect(signed.status).toMatch(/^Signed electronically/);
  expect(v9SignaturePresentation(letter.document,'step:sign-staff').name).toBe('Fictional Staff');

  // Someone with no access to the case learns nothing through the reader, even by calling it directly.
  const outsider=await hireEmployee(admin,{person:{fullName:'Fictional Outsider',primaryEmail:randomUUID()+'@probation.example.test'},companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',hiredOn:'2026-01-01'});
  const outsiderUser=await createAppUser(b.tenantId,outsider.personId,'employee');
  const outsiderCtx={...admin,userId:outsiderUser,personId:outsider.personId,roles:['employee'],grants:undefined} as SessionContext;
  const rows=await withTenant(outsiderCtx,tx=>tx.execute<{step_id:string}>(sql`select step_id from app.probation_letter_signers(${prepared.partId}::uuid)`));
  expect(rows).toHaveLength(0);
  // A review part is not a letter: nothing.
  const review=await withTenant(admin,tx=>tx.execute<{step_id:string}>(sql`select step_id from app.probation_letter_signers(${ids.part}::uuid)`));
  expect(review).toHaveLength(0);
 });
});
