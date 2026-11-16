// The case's own employee holds only their own Probation steps (lane H2, migration 5759): never a signer candidate,
// replacement, delegate, general delegate or chosen member of a Review, Approve, Approve-and-sign or another person's
// Sign step. Routed choices skip them and fall back to the next member, then the fallback group with "meant for"
// recorded; a step they would hold as a role holder moves on like a duplicate signer. Fictional people only.
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {setReportingLine} from '../core/org';
import {adminCtx,closeAll,setModule,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {probationFormCaseFixture} from './helpers/probation-form-case-fixture';
import {probationOutcomeFixture} from './helpers/probation-outcome-fixture';
import {newProbationLetterTemplate} from '../lib/probation-letter-template';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {withTenant,type SessionContext} from '../db/client';
import type {SigningRoute} from '../lib/document-signing-model';
import type {DocumentRouting} from '../lib/document-signing-routing';
import {overrideProbationRoute,replaceProbationSigner,defaultProbationRoutes,saveProbationLetterTemplate,prepareProbationLetter,readProbationLetter} from '../packs/probation/service';

let b:Base,admin:SessionContext,forms:ReturnType<typeof probationFormCaseFixture>,outcomes:ReturnType<typeof probationOutcomeFixture>;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);forms=probationFormCaseFixture(b,admin);outcomes=probationOutcomeFixture(b,admin);});

/** The database's refusal text (drizzle wraps it with the failed query). */
const refusal=(work:Promise<unknown>)=>work.then(()=>'',(e:{message?:string;cause?:{message?:string}})=>`${e?.cause?.message??''} ${e?.message??''}`);
const OWN=/employee cannot review or approve their own probation/;
const today=()=>todayInKualaLumpur();

describe('Head of Department and PBP steps (5759)',()=>{
 it('never offers or accepts the employee for a Review step, and moves on a step they would hold as their own department head',async()=>{
  const c=await forms.caseWithRows([{id:'hod',order:1,action:'review',who:'hod'},{id:'pbp',order:2,action:'approve_sign',who:'pbp'}],()=>[],{departmentHead:'staff'});
  admin=c.admin;
  await setReportingLine(admin,{subordinateEmploymentId:c.manager.employmentId,managerEmploymentId:c.peer.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
  // The signer candidate list names other people but never the employee.
  const candidates=(await withTenant(admin,tx=>tx.execute<{id:string}>(sql`select id from app.probation_signer_candidates(${c.ids.caseId}::uuid,'')`))).map(row=>row.id);
  expect(candidates).toContain(c.manager.userId);expect(candidates).not.toContain(c.staff.userId);
  await c.prepare();await c.submit();await c.acknowledge();
  // The employee heads their own department: the Head of Department Review step moves on (escalate), on behalf of them.
  const part=await c.current(admin),hod=part.route.steps.find(s=>s.id==='hod')!;
  expect(hod).toMatchObject({role:'hod',kind:'review',representedId:c.staff.userId,holderId:c.peer.userId});
  expect((await c.current(c.staff.ctx)).allowedCommands).not.toContain('approve');
  // Neither a replacement nor a delegation can give the employee a Head of Department or PBP step.
  for(const[stepId,kind]of [['hod','holder_changed'],['hod','missing_holder'],['pbp','delegation']]as const)
   expect(await refusal(replaceProbationSigner(admin,{partId:c.ids.part,stepId,holderId:c.staff.userId,kind,validFrom:today(),validTo:null,reason:'Fictional attempt'}))).toMatch(OWN);
  expect(await c.holders()).toEqual([]);
 });

 it('refuses a route override whose step the employee holds today, as role holder or as a current replacement',async()=>{
  const c=await forms.caseWithRows([],()=>[],{departmentHead:'staff'});
  admin=c.admin;
  const route=defaultProbationRoutes().parts['3'];
  let part=await c.current(admin);
  expect(await refusal(overrideProbationRoute(admin,{partId:c.ids.part,revision:part.storageRevision,route,reason:'Keeps the Head of Department step'}))).toMatch(OWN);
  const withoutHod:SigningRoute={...route,steps:route.steps.filter(s=>s.role!=='hod')};
  await overrideProbationRoute(admin,{partId:c.ids.part,revision:part.storageRevision,route:withoutHod,reason:'The employee heads their own department'});
  // A replacement recorded before this rule (written here directly) still blocks a route that keeps that step.
  await owner.db.execute(sql`insert into probation_delegate(tenant_id,part_id,step_id,holder_id,kind,reason,created_by,valid_from) values(${b.tenantId}::uuid,${c.ids.part}::uuid,'pbp',${c.staff.userId}::uuid,'missing_holder','Fictional legacy replacement',${admin.userId}::uuid,${today()}::date)`);
  part=await c.current(admin);
  expect(await refusal(overrideProbationRoute(admin,{partId:c.ids.part,revision:part.storageRevision,route:withoutHod,reason:'Saves the same route again'}))).toMatch(OWN);
  expect(await c.events('probation.route_changed')).toBe(1);
 });
});

describe('Routed form approvers (5759)',()=>{
 it('skips the employee in a group and among named people: the next member, else the fallback group with "meant for"',async()=>{
  const approver=await forms.person('Fictional Group Approver');
  const c=await forms.caseWithRows(({staff})=>[
   {id:'group_ok',order:1,action:'approve',who:'group:approvers',pick:'any'},
   {id:'solo',order:2,action:'review',who:'group:solo',pick:'any'},
   {id:'named',order:3,action:'review',who:'people',userIds:[staff]},
  ],({staff})=>[{id:'approvers',name:'Fictional approvers',members:[staff,approver.userId],limit:0},{id:'solo',name:'Fictional solo group',members:[staff],limit:0}]);
  admin=c.admin;
  await c.prepare();
  // The database refuses the employee even when the group names them (the freeze is rolled back).
  expect(await refusal(withTenant(c.manager.ctx,async tx=>{
   await tx.execute(sql`select app.probation_prepare_signing(${c.ids.part}::uuid)`);
   await tx.execute(sql`select app.probation_form_freeze_approvers(${c.ids.part}::uuid,${JSON.stringify([{stepId:'group_ok',holderId:c.staff.userId}])}::jsonb)`);
  }))).toMatch(OWN);
  await c.submit();
  // Member order names the employee first; the assignment owner takes the next member, and the fallback group (the
  // admin) takes the steps that only name the employee.
  expect(await c.holders()).toEqual(expect.arrayContaining([
   {step_id:'group_ok',holder_id:approver.userId,kind:'missing_holder',represented_id:null},
   {step_id:'solo',holder_id:admin.userId,kind:'missing_holder',represented_id:null},
   {step_id:'named',holder_id:admin.userId,kind:'missing_holder',represented_id:null}]));
  expect((await c.holders()).map(h=>h.holder_id)).not.toContain(c.staff.userId);
  const steps=(await c.stored()).route.steps;
  expect(steps.find(s=>s.id==='solo')).toMatchObject({meantFor:'The assignment group “Fictional solo group”'});
  expect(steps.find(s=>s.id==='named')).toMatchObject({meantFor:'The named people'});
  expect(steps.find(s=>s.id==='group_ok')?.meantFor).toBeUndefined();
  expect(await c.events('probation.form_routing_fallback')).toBe(1);
 });

 it('never moves an assigned step to the employee: no per-part delegation and no general Probation delegation',async()=>{
  const approver=await forms.person('Fictional Assigned Approver');
  const c=await forms.caseWithRows([{id:'named_ok',order:1,action:'approve_sign',who:'people',userIds:[approver.userId]}]);
  admin=c.admin;
  await c.prepare();await c.submit();await c.acknowledge();
  expect(await refusal(replaceProbationSigner(admin,{partId:c.ids.part,stepId:'named_ok',holderId:c.staff.userId,kind:'delegation',validFrom:today(),validTo:null,reason:'Fictional attempt'}))).toMatch(OWN);
  // The assigned approver's general delegation with Probation ticked names the employee: the step stays with the approver.
  const[line]=await owner.db.execute<{id:string}>(sql`insert into reporting_line(tenant_id,subordinate_employment_id,manager_employment_id,line_type,valid_from) values(${b.tenantId}::uuid,${approver.employmentId}::uuid,${c.staff.employmentId}::uuid,'delegate',${addDaysIso(today(),-1)}::date) returning id`);
  await owner.db.execute(sql`insert into reporting_line_scope(tenant_id,reporting_line_id,module,task_type) values(${b.tenantId}::uuid,${line.id}::uuid,'probation','probation.approve')`);
  const step=(await c.current(admin)).route.steps.find(s=>s.id==='named_ok')!;
  expect(step.holderId).toBe(approver.userId);expect(step.representedId??null).toBeNull();
  expect((await c.current(c.staff.ctx)).allowedCommands).not.toContain('approve');
  expect((await c.current(approver.ctx)).allowedCommands).toContain('approve');
 });
});

describe('Routed letters (5759)',()=>{
 it('skips the employee for every step but "The employee"; a step naming only them goes to the fallback group',async()=>{
  const {ids,staff,decision,admin:pbp}=await outcomes.recordedConfirm();admin=pbp;
  await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(data,'{groups}',data->'groups'||${JSON.stringify([{id:'signers',name:'Fictional signers',members:[staff.userId,pbp.userId],limit:0}])}::jsonb) where tenant_id=${b.tenantId}::uuid`);
  const routing:DocumentRouting=[
   {id:'sign-hr',order:1,action:'sign',owner:true,who:{kind:'group',groupId:'signers'},pick:'any'},
   {id:'review-named',order:2,action:'review',owner:false,who:{kind:'people',userIds:[staff.userId]}},
   {id:'sign-staff',order:3,action:'sign',owner:false,who:{kind:'employee'}},
  ];
  const template=newProbationLetterTemplate('confirm','own-'+randomUUID().slice(0,8),'Fictional routed confirmation letter');
  template.unfinished=false;
  template.blocks=template.blocks.filter(block=>block.type!=='letterhead'&&block.type!=='signature');
  template.blocks.find(block=>block.type==='text')!.text='Confirmation for {employeeName}.';
  for(const step of routing.filter(s=>s.action==='sign'))template.blocks.push({id:'sig-'+step.id,type:'signature',text:'',section:'',role:'step:'+step.id,label:'Signed'});
  const templateId=await saveProbationLetterTemplate(admin,{companyId:b.companyId,template:{...template,routing},publish:true,expectedVersion:0});
  const prepared=await prepareProbationLetter(admin,{outcomeId:decision.id,templateId,revision:decision.revision,edits:{}});
  const letter=await readProbationLetter(admin,ids.caseId,prepared.partId);
  const steps=letter.signing!.document.route.steps;
  expect(steps.map(s=>({id:s.id,holderId:s.holderId}))).toEqual([{id:'sign-hr',holderId:pbp.userId},{id:'review-named',holderId:pbp.userId},{id:'sign-staff',holderId:staff.userId}]);
  expect(steps.find(s=>s.id==='review-named')).toMatchObject({meantFor:'The named people'});
  expect(letter.unresolved).toEqual([expect.objectContaining({stepId:'review-named',meantFor:'The named people',reason:'No eligible members in the named people.',holderId:pbp.userId})]);
 });
});
