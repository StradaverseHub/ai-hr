// Probation letters generated from a template version with signing and review routing (lane D2 / W1, migration 5752).
// Real authorized fixtures: a recorded Confirm outcome on a native case, a routed template version, then Review,
// send back, re-send, Sign and release. Letters without routing keep today's flow (test/probation-persistence.test.ts).
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {hireEmployee,setReportingLine} from '../core/org';
import {createAppUser,adminCtx,closeAll,setModule,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {newProbationPart} from '../lib/probation-model';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {newProbationLetterTemplate} from '../lib/probation-letter-template';
import {withTenant,type SessionContext} from '../db/client';
import {probationCase,saveProbationDraft,actOnProbation,saveProbationLetterTemplate,probationLetterTemplates,prepareProbationLetter,readProbationLetter,actOnProbationLetter,resendProbationLetter,releaseProbationLetter,DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM,defaultProbationRoutes} from '../packs/probation/service';
import type {DocumentRouting} from '../lib/document-signing-routing';

let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);});

async function person(name:string){
 const e=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@probation.example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 const userId=await createAppUser(b.tenantId,e.personId,'employee');
 return{...e,userId,ctx:{...admin,userId,personId:e.personId,roles:['employee'],grants:undefined} as SessionContext};
}
/** A native Part 3 with a recorded Confirm outcome; the admin is the case's PBP and GBS. */
async function recordedConfirm(extraGroups:{id:string;name:string;members:string[];limit:number}[]=[]){
 const[hrPerson]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional HR Partner',${randomUUID()+'@probation.example.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${hrPerson.id}::uuid where id=${admin.userId}::uuid`);admin={...admin,personId:hrPerson.id};
 const staff=await person('Fictional Staff'),manager=await person('Fictional Manager'),peer=await person('Fictional Reviewer');
 const groups=[{id:'probation-people',name:'Fictional People Ops',members:[admin.userId],limit:10},...extraGroups];
 await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:9,peopleOpsGroup:'probation-people',groups,bpRules:[{rules:{company:[b.companyId]},userId:admin.userId}]})}::jsonb)`);
 await owner.db.execute(sql`insert into lc_onboarding_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({groups})}::jsonb)`);
 await owner.db.execute(sql`update employment set probation_value=0,probation_months=0 where id in(${manager.employmentId}::uuid,${peer.employmentId}::uuid)`);
 const endOn=addDaysIso(todayInKualaLumpur(),-4);
 await owner.db.execute(sql`update employment set probation_unit='month',probation_value=12,probation_months=12,probation_end_date=${endOn}::date where id=${staff.employmentId}::uuid`);
 const ids={caseId:randomUUID(),settings:randomUUID(),form:randomUUID(),route:randomUUID(),part:randomUUID()};
 const part={...newProbationPart(ids.part,3,0,endOn,30),state:'issued' as const};
 const data={id:ids.caseId,employmentId:staff.employmentId,companyId:b.companyId,sourceKey:'employment:'+staff.employmentId,startOn:'2026-01-01',originalEndOn:endOn,endOn,gradeAtStart:'12',revision:1,config:DEFAULT_PROBATION_CONFIG,planMonths:12,planFlag:true,extensionCount:0,kpiAcknowledged:true,state:'in_review',pendingOutcome:null,facts:{employeeName:'Fictional Staff',holders:{employee:staff.userId,lm:null,hod:null,pbp:null}}};
 await owner.db.execute(sql`insert into probation_configuration(id,tenant_id,company_id,kind,version,state,data,created_by) values(${ids.settings}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'settings',1,'published',${JSON.stringify(DEFAULT_PROBATION_CONFIG)}::jsonb,${admin.userId}::uuid),(${ids.form}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'form',1,'published',${JSON.stringify(DEFAULT_PROBATION_FORM)}::jsonb,${admin.userId}::uuid),(${ids.route}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'route',1,'published',${JSON.stringify(defaultProbationRoutes())}::jsonb,${admin.userId}::uuid)`);
 await owner.db.execute(sql`insert into probation_activation(tenant_id,company_id,enabled,activation_on,dry_run_digest,approved_by) values(${b.tenantId}::uuid,${b.companyId}::uuid,true,'2026-01-01',${'a'.repeat(64)},${admin.userId}::uuid)`);
 await owner.db.execute(sql`insert into probation_case(id,tenant_id,company_id,employment_id,source_key,settings_id,form_id,route_id,data) values(${ids.caseId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${staff.employmentId}::uuid,${data.sourceKey},${ids.settings}::uuid,${ids.form}::uuid,${ids.route}::uuid,${JSON.stringify(data)}::jsonb)`);
 const {employee,manager:managerValues,employeeComments,kpis,support,strengths,development,managerComments,outcome,midpointStatus,justification,extensionMonths,...metadata}=part;
 void employee;void managerValues;void employeeComments;void kpis;void support;void strengths;void development;void managerComments;void outcome;void midpointStatus;void justification;void extensionMonths;
 await owner.db.execute(sql`insert into probation_part(id,tenant_id,case_id,data) values(${ids.part}::uuid,${b.tenantId}::uuid,${ids.caseId}::uuid,${JSON.stringify({...metadata,route:defaultProbationRoutes().parts['3']})}::jsonb)`);
 const blank=Object.fromEntries(DEFAULT_PROBATION_FORM.criteria.map(c=>[c.id,{rating:null,evidence:''}]));
 await owner.db.execute(sql`insert into probation_rater_draft(part_id,tenant_id,rater,data) values(${ids.part}::uuid,${b.tenantId}::uuid,'employee',${JSON.stringify({employee:blank,employeeComments:''})}::jsonb),(${ids.part}::uuid,${b.tenantId}::uuid,'lm',${JSON.stringify({manager:blank})}::jsonb)`);
 await setReportingLine(admin,{subordinateEmploymentId:staff.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
 await owner.db.execute(sql`update department set head_employment_id=${peer.employmentId}::uuid where id=${b.deptA}::uuid`);
 await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) values(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'pbp','2026-01-01','Fictional PBP opt-in'),(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'gbs','2026-01-01','Fictional GBS opt-in')`);
 const current=async(ctx:SessionContext)=>(await probationCase(ctx,ids.caseId)).parts[0];
 const assessment=Object.fromEntries(DEFAULT_PROBATION_FORM.criteria.map(c=>[c.id,{rating:3,evidence:'Observed fictional evidence for this criterion'}]));
 let p=await current(staff.ctx);await saveProbationDraft(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,rater:'employee',patch:{employee:assessment}});
 p=await current(staff.ctx);await actOnProbation(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,command:'submit_employee'});
 p=await current(manager.ctx);await saveProbationDraft(manager.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,rater:'lm',patch:{manager:assessment,reviewOn:todayInKualaLumpur(),conductedBy:manager.userId,outcome:'confirm',justification:'Observed evidence supports confirmation'}});
 p=await current(manager.ctx);await actOnProbation(manager.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,command:'submit_manager',method:'typed',value:'Fictional Manager',consent:true});
 p=await current(staff.ctx);await saveProbationDraft(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,rater:'employee',patch:{employeeComments:'I acknowledge the submitted review.'}});
 p=await current(staff.ctx);await actOnProbation(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,command:'acknowledge',method:'typed',value:'Fictional Staff',consent:true});
 for(const actor of[peer.ctx,admin]){p=await current(actor);await actOnProbation(actor,{caseId:ids.caseId,partId:ids.part,revision:p.revision,command:'approve',method:'typed',value:actor.userId===admin.userId?'Fictional PBP':'Fictional Reviewer',consent:true});}
 p=await current(admin);await actOnProbation(admin,{caseId:ids.caseId,partId:ids.part,revision:p.revision,command:'record'});
 const[decision]=await owner.db.execute<{id:string;revision:number}>(sql`select id,revision from probation_outcome where part_id=${ids.part}::uuid`);
 return{ids,staff,manager,peer,decision};
}
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
