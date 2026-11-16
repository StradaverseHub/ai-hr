// PBP route overrides and per-part delegation for routed form approver steps (lane H, migration 5758). A PBP may
// override an unsubmitted Part route that contains routing, group, named-people or Direct Superior steps (same authority,
// revision and audit; routed steps keep a routing of the case's form version), and may record a dated delegation for
// such a step, which represents the step's current person and still meets the duplicate-role policy. The case's
// employee is never the person for a routed step. Fictional people only.
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {setReportingLine} from '../core/org';
import {adminCtx,closeAll,setModule,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {probationFormCaseFixture} from './helpers/probation-form-case-fixture';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import type {SessionContext} from '../db/client';
import type {SigningRoute} from '../lib/document-signing-model';
import type {ProbationApprovalRow} from '../lib/probation-form';
import {actOnProbation,overrideProbationRoute,replaceProbationSigner,defaultProbationRoutes} from '../packs/probation/service';

let b:Base,admin:SessionContext,fixture:ReturnType<typeof probationFormCaseFixture>;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);fixture=probationFormCaseFixture(b,admin);});

/** The database's refusal text (drizzle wraps it with the failed query). */
const refusal=(work:Promise<unknown>)=>work.then(()=>'',(e:{message?:string;cause?:{message?:string}})=>`${e?.cause?.message??''} ${e?.message??''}`);
const person=(name:string)=>fixture.person(name);
/** A native Part 3 whose pinned form version carries `rows` (test/helpers/probation-form-case-fixture.ts); the admin is the case's PBP and GBS. */
async function caseWithRows(rows:ProbationApprovalRow[],groups:{id:string;name:string;members:string[];limit:number}[]=[]){const c=await fixture.caseWithRows(rows,()=>groups);admin=c.admin;return c;}
const today=()=>todayInKualaLumpur();

describe('PBP route override of a Part with routed approver steps (5758)',()=>{
 it('reorders the routed steps of a reopened Part with the same authority, revision and audit, and the resubmission keeps the override',async()=>{
  const reviewer=await person('Fictional Named Reviewer'),approver=await person('Fictional Group Approver');
  const c=await caseWithRows([
   {id:'peer_review',order:1,action:'review',who:'people',userIds:[reviewer.userId]},
   {id:'group_ok',order:2,action:'approve',who:'group:approvers',pick:'any'},
  ],[{id:'approvers',name:'Fictional approvers',members:[approver.userId],limit:0}]);
  await c.prepare();await c.submit();
  expect((await c.stored()).route.steps.map(s=>[s.id,s.role,s.stage])).toEqual([['lm','lm',0],['employee','employee',1],['peer_review','people',2],['group_ok','group:approvers',3]]);
  const assigned=await c.holders();expect(assigned).toHaveLength(2);
  // The PBP reopens the Line Manager's submission; the route stays the one frozen from the form version.
  let part=await c.current(admin);
  await actOnProbation(admin,{caseId:c.ids.caseId,partId:c.ids.part,revision:part.revision,command:'unlock',reason:'Reopened to change the approval order',owner:'lm'});
  part=await c.current(admin);
  const before=await c.stored();
  // As the UI sends it: the resolved route without holders, routed steps swapped, a client label that the server ignores.
  const draft:SigningRoute={...part.route,steps:part.route.steps.map(s=>({...s,holderId:null,holderPersonId:undefined,representedId:undefined,coveredStepIds:undefined,coveredByStepId:undefined,
   ...(s.id==='peer_review'?{stage:3}:s.id==='group_ok'?{stage:2,label:'Client label'}:{})}))};
  // Refused: not the case's PBP, a stale revision, a routed step the form version does not define, a named holder.
  expect(await refusal(overrideProbationRoute(c.manager.ctx,{partId:c.ids.part,revision:part.storageRevision,route:draft,reason:'Manager tries to reroute'}))).toMatch(/PBP may change only an unsubmitted route/);
  expect(await refusal(overrideProbationRoute(admin,{partId:c.ids.part,revision:part.storageRevision-1,route:draft,reason:'Stale revision'}))).toMatch(/PBP may change only an unsubmitted route/);
  const invented={...draft,steps:[...draft.steps,{id:'new_group',role:'group:approvers',kind:'approve' as const,stage:4,holderId:null,required:true}]};
  expect(await refusal(overrideProbationRoute(admin,{partId:c.ids.part,revision:part.storageRevision,route:invented,reason:'Adds a routing the form does not have'}))).toMatch(/must keep a routing of this case's form version/);
  const named={...draft,steps:draft.steps.map(s=>s.id==='group_ok'?{...s,holderId:approver.userId}:s)};
  await expect(overrideProbationRoute(admin,{partId:c.ids.part,revision:part.storageRevision,route:named,reason:'Names a person in the route'})).rejects.toThrow();
  expect((await c.stored()).revision).toBe(before.revision);
  expect(await c.events('probation.route_changed')).toBe(0);

  await overrideProbationRoute(admin,{partId:c.ids.part,revision:part.storageRevision,route:draft,reason:'Group approval before the peer review'});
  const after=await c.stored();
  expect(after.revision).toBe(before.revision+1);expect(after.override).toBe(true);
  expect(after.policy).toEqual(before.policy);
  expect(after.route.steps.map(s=>[s.id,s.role,s.kind,s.stage,s.signature??null,s.label??null])).toEqual([
   ['lm','lm','sign',0,null,null],['employee','employee','acknowledge',1,null,null],
   ['peer_review','people','review',3,null,null],['group_ok','group:approvers','approve',2,false,'Fictional approvers']]);
  expect(await c.events('probation.route_changed')).toBe(1);
  const[snapshot]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from probation_revision where part_id=${c.ids.part}::uuid and rater='meta' and reason='Group approval before the peer review' and revision=${before.revision}`);expect(snapshot.n).toBe(1);

  // The Line Manager resubmits: the override is kept (not re-derived from the form) and each step keeps its person.
  await c.submit();
  expect((await c.stored()).route.steps.map(s=>[s.id,s.stage])).toEqual([['lm',0],['employee',1],['peer_review',3],['group_ok',2]]);
  expect(await c.holders()).toEqual(assigned);
  await c.acknowledge();
  expect((await c.current(approver.ctx)).allowedCommands).toContain('approve');
  expect((await c.current(reviewer.ctx)).allowedCommands).not.toContain('approve');
 });

 it('keeps the 0949 rules for a route without routed steps: Head of Department and PBP only',async()=>{
  const c=await caseWithRows([{id:'hod',order:1,action:'approve_sign',who:'hod'}]);
  const part=await c.current(admin),route=defaultProbationRoutes().parts['3'];
  const gbs={...route,steps:[...route.steps,{id:'gbs_extra',role:'gbs',kind:'approve' as const,stage:9,holderId:null,required:true}]};
  expect(await refusal(overrideProbationRoute(admin,{partId:c.ids.part,revision:part.storageRevision,route:gbs,reason:'Adds a GBS step'}))).toMatch(/source role approvers/);
  await overrideProbationRoute(admin,{partId:c.ids.part,revision:part.storageRevision,route,reason:'Keeps the configured route'});
  const after=await c.stored();
  expect(after.override).toBe(true);expect(after.route).toEqual(route);expect(after.policy??null).toBeNull();
 });
});

describe('Delegation of a routed approver step (5758)',()=>{
 it('records a dated delegation for an assigned named-people step; the delegate acts on behalf of the assigned person',async()=>{
  const approver=await person('Fictional Assigned Approver'),delegate=await person('Fictional Delegate');
  const c=await caseWithRows([{id:'named_ok',order:1,action:'approve_sign',who:'people',userIds:[approver.userId]}]);
  await c.prepare();await c.submit();await c.acknowledge();
  const input={partId:c.ids.part,stepId:'named_ok',holderId:delegate.userId,kind:'delegation' as const,validFrom:today(),validTo:addDaysIso(today(),5),reason:'Fictional planned absence'};
  // Same checks as a Head of Department or PBP step: a current PBP/GBS records it; never the employee.
  await expect(replaceProbationSigner(c.staff.ctx,input)).rejects.toThrow();
  expect(await refusal(replaceProbationSigner(admin,{...input,holderId:c.staff.userId}))).toMatch(/employee cannot review or approve their own probation/);
  expect(await refusal(replaceProbationSigner(admin,{...input,holderId:c.staff.userId,kind:'holder_changed'}))).toMatch(/employee cannot review or approve their own probation/);
  await replaceProbationSigner(admin,input);
  expect(await c.holders()).toEqual([
   {step_id:'named_ok',holder_id:approver.userId,kind:'missing_holder',represented_id:null},
   {step_id:'named_ok',holder_id:delegate.userId,kind:'delegation',represented_id:approver.userId}]);
  expect(await c.events('probation.signer_replaced')).toBe(1);
  const part=await c.current(delegate.ctx),step=part.route.steps.find(s=>s.id==='named_ok')!;
  expect(step).toMatchObject({holderId:delegate.userId,representedId:approver.userId});
  expect(part.allowedCommands).toContain('approve');
  expect((await c.current(approver.ctx)).allowedCommands).not.toContain('approve');
  await actOnProbation(delegate.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:part.revision,stepId:'named_ok',command:'approve',method:'typed',value:'Fictional Delegate',consent:true,coveredStepIds:step.coveredStepIds??[]});
  expect((await c.current(admin)).signing!.document.actions).toContainEqual(expect.objectContaining({stepId:'named_ok',action:'signed',actorId:delegate.userId,representedId:approver.userId}));
 });

 it('applies the duplicate-role policy to the delegate, and a Direct Superior step represents the Line Manager holder',async()=>{
  const approver=await person('Fictional Assigned Approver'),delegate=await person('Fictional Delegate');
  const c=await caseWithRows([{id:'ds',order:1,action:'approve_sign',who:'superior'},{id:'named_ok',order:2,action:'approve_sign',who:'people',userIds:[approver.userId]}]);
  await setReportingLine(admin,{subordinateEmploymentId:c.manager.employmentId,managerEmploymentId:c.peer.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
  await c.prepare();await c.submit();await c.acknowledge();
  // A delegation of a routed step to the Line Manager, who already signed: the escalate policy moves it to their manager.
  await replaceProbationSigner(admin,{partId:c.ids.part,stepId:'named_ok',holderId:c.manager.userId,kind:'delegation',validFrom:today(),validTo:null,reason:'Fictional cover by the manager'});
  let part=await c.current(admin);
  const escalated=part.route.steps.find(s=>s.id==='named_ok')!;
  expect(escalated.representedId).toBe(c.manager.userId);expect(escalated.holderId).not.toBe(c.manager.userId);
  // The Direct Superior step (held by the Line Manager holder) delegated to someone else represents the Line Manager.
  await replaceProbationSigner(admin,{partId:c.ids.part,stepId:'ds',holderId:delegate.userId,kind:'delegation',validFrom:today(),validTo:null,reason:'Fictional superior absence'});
  expect((await c.holders()).find(h=>h.step_id==='ds')).toEqual({step_id:'ds',holder_id:delegate.userId,kind:'delegation',represented_id:c.manager.userId});
  part=await c.current(delegate.ctx);
  expect(part.route.steps.find(s=>s.id==='ds')).toMatchObject({holderId:delegate.userId,representedId:c.manager.userId});
  expect(part.allowedCommands).toContain('approve');
 });
});
