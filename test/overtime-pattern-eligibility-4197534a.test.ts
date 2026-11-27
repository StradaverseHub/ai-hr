/** Board 4197534a — one Pattern Code for many companies through Eligibility, activation from a date, Preview with the
 * calculation's own matching, delete as archive with its guards, and the one-time consolidation data step. Real
 * database, fictional fixtures (every name and figure is invented). */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {and,asc,eq,isNull} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,setModule,type Base} from './harness';
import {seedAttendanceSubmissionBase} from './helpers/attendance-submission-fixture';
import {todayInKualaLumpur} from '../lib/hr-date';
import {createCompany} from '../core/admin';
import {moduleKeyOf} from '../lib/audit-format';
import {blankOvertimePattern} from '../lib/overtime-pattern-editor-scope';
import {overtimeSettingsToDefinition} from '../lib/overtime-pattern-settings';
import {overtimeStarterSeed} from '../lib/overtime-pattern-starters';
import {resolveOvertimePattern} from '../lib/overtime-pattern-evaluate';
import type {OvertimeFacts} from '../lib/overtime-pattern-model';
import {resolveOvertimePatternTx} from '../packs/attendance/overtime-patterns';
import {activateOvertimePatternWithEligibility,archiveOvertimePattern,cancelOvertimePatternAssignment,consolidateOvertimePatterns,forkOvertimePatternDraft,getOvertimePattern,listOvertimePatterns,overtimePlannedCandidates,overtimePreviewFacts,overtimeStarterIdentity,previewOvertimePatternEligibility,saveOvertimePatternDraft,type OvertimePopulationRow} from '../packs/attendance/service';

let b:Base,ctx:SessionContext,second:string,earningId:string,gradeA:string,gradeB:string;
const today=()=>todayInKualaLumpur();
const plus=(n:number)=>{const d=new Date(today()+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const employees:{id:string;companyId:string;gradeId:string}[]=[];
function definition(){
 return overtimeSettingsToDefinition(blankOvertimePattern({code:'MYR',minorScale:2}),{rows:[{from:'0:00',to:'',rate:'1.5',restRate:'',phRate:'3',rounding:'none',roundTo:''}],monthlyHours:'208',earningItemId:earningId});
}
async function draft(code:string,planned:Record<string,unknown>,companyIds=[b.companyId,second]){
 return saveOvertimePatternDraft(ctx,{draft:{code,creationCompanyId:b.companyId,companyIds,name:`${code} fictional`,description:'',definition:definition(),plannedEligibility:{v:1,criteria:{},employmentIds:[],priority:100,from:today(),...planned}}});
}
async function employ(companyId:string,gradeId:string,label:string){
 const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:`Fictional ${label}`,primaryEmail:`ot-elig-${randomUUID()}@example.test`}).returning();
 const [row]=await owner.db.insert(s.employment).values({tenantId:b.tenantId,companyId,personId:person.id,employeeCode:label,hiredOn:plus(-30),gradeId}).returning();
 await owner.db.insert(s.assignment).values({tenantId:b.tenantId,employmentId:row.id,companyId,departmentId:b.deptA,employmentType:'full_time',validFrom:plus(-30)});
 employees.push({id:row.id,companyId,gradeId});return row.id;
}
const facts=(employmentId:string):OvertimeFacts=>{const e=employees.find(item=>item.id===employmentId)!;const k=(value:string|null)=>({state:'known' as const,value,provenance:{owner:'personnel' as const,reference:'fixture',asOf:today(),basis:'recorded' as const}});
 return {companyId:k(e.companyId),employmentId:k(e.id),gradeId:k(e.gradeId),departmentId:k(b.deptA),businessUnitId:k(null),positionId:k(null),employmentType:k('full_time')};};
const resolve=(employmentId:string)=>withTenant(ctx,tx=>resolveOvertimePatternTx(tx,ctx,{employmentId,date:today(),recordedFacts:facts(employmentId),resolvedLegacyRuleId:null}));
async function revision(patternId:string){const [row]=await owner.db.select({revision:s.overtimePattern.revision}).from(s.overtimePattern).where(eq(s.overtimePattern.id,patternId));return row.revision;}
async function version(versionId:string){const [row]=await owner.db.select().from(s.overtimePatternVersion).where(eq(s.overtimePatternVersion.id,versionId));return row;}

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 employees.length=0;await resetDb();b=await seedAttendanceSubmissionBase();await setModule(b.tenantId,'attendance','active');await setModule(b.tenantId,'payroll','active');ctx=adminCtx(b);
 second=(await createCompany(ctx,{legalName:'Second fictional OT employer',country:'MY',currency:'MYR'})).id;
 // The fixture department is an "All Companies" label, so both companies' assignments may use it.
 await owner.withTenant(ctx,tx=>tx.update(s.department).set({isGlobal:true}).where(eq(s.department.id,b.deptA)));
 const [earning]=await owner.db.insert(s.payComponent).values({tenantId:b.tenantId,code:'OT',name:'Overtime Pay fixture',kind:'allowance'}).returning();earningId=earning.id;
 const grades=await owner.db.insert(s.jobGrade).values([{tenantId:b.tenantId,code:'FX-EXE',name:'Fictional Executive'},{tenantId:b.tenantId,code:'FX-NEX',name:'Fictional Non-Executive'}] as never).returning({id:s.jobGrade.id});
 gradeA=grades[0].id;gradeB=grades[1].id;
 await employ(b.companyId,gradeA,'E-A1');await employ(b.companyId,gradeB,'E-B1');await employ(second,gradeA,'E-A2');await employ(second,gradeB,'E-B2');
});

describe('activation with Eligibility',()=>{
 it('turns planned Eligibility into assignments for many companies; a named employee beats a group; the resolver selects it',async()=>{
  const wide=await draft('OT001',{criteria:{gradeId:[gradeA]},priority:200});
  const named=await draft('OT002',{criteria:{gradeId:[gradeB]},employmentIds:[employees[1].id],priority:1});
  const activated=await activateOvertimePatternWithEligibility(ctx,{versionId:wide.versionId,expectedRevision:wide.revision});
  expect(activated.effectiveFrom).toBe(today());expect(activated.assignmentIds).toHaveLength(1);
  await activateOvertimePatternWithEligibility(ctx,{versionId:named.versionId,expectedRevision:named.revision});
  const rows=await owner.db.select().from(s.overtimePatternAssignment).where(eq(s.overtimePatternAssignment.tenantId,b.tenantId)).orderBy(asc(s.overtimePatternAssignment.priority));
  expect(rows.map(row=>[row.priority,(row.target as {type:string}).type,row.validFrom]).sort((x,y)=>String(x).localeCompare(String(y)))).toEqual([[1,'group',today()],[1,'individual',today()],[200,'group',today()]]);
  expect(await owner.db.select().from(s.overtimePatternAssignmentEmployment).where(eq(s.overtimePatternAssignmentEmployment.tenantId,b.tenantId))).toHaveLength(1);
  // Grade A in both companies follows OT001; the named Grade B employee follows OT002 (named first); other Grade B: OT002's group.
  for(const employee of [employees[0],employees[2]])expect(await resolve(employee.id)).toMatchObject({status:'selected',patternVersionId:wide.versionId});
  const person=await resolve(employees[1].id);expect(person).toMatchObject({status:'selected',patternVersionId:named.versionId});
  expect(person.status==='selected'&&rows.find(row=>row.id===person.assignmentId)!.target).toMatchObject({type:'individual'});
  expect(await resolve(employees[3].id)).toMatchObject({status:'selected',patternVersionId:named.versionId});
  const listed=(await listOvertimePatterns(ctx,{search:'OT00'})).items;
  expect(listed.map(item=>[item.code,item.status,item.companyCount])).toEqual(expect.arrayContaining([['OT001','active',2],['OT002','active',2]]));
  const events=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,wide.patternId),eq(s.domainEvent.eventType,'overtime.version.activated')));
  expect(events).toHaveLength(1);expect(events[0].payload).toMatchObject({versionId:wide.versionId,effectiveFrom:today(),priority:200});
 });
 it('refuses an equal-priority overlap at activation, shows it in Preview, and writes nothing',async()=>{
  const first=await draft('OT010',{criteria:{gradeId:[gradeA]},priority:100});
  await activateOvertimePatternWithEligibility(ctx,{versionId:first.versionId,expectedRevision:first.revision});
  const clash=await draft('OT011',{criteria:{},priority:100},[second]);
  const preview=await previewOvertimePatternEligibility(ctx,{patternId:clash.patternId,versionId:clash.versionId,expectedRevision:clash.revision,companyIds:[second],plannedEligibility:{v:1,criteria:{},employmentIds:[],priority:100,from:today()}});
  expect(preview.conflicts).toEqual([{code:'OT010',name:'OT010 fictional',employees:1}]);expect(preview.ready).toBe(false);
  await expect(activateOvertimePatternWithEligibility(ctx,{versionId:clash.versionId,expectedRevision:clash.revision})).rejects.toMatchObject({code:'conflict',detail:{reason:'eligibilityConflict'}});
  expect((await version(clash.versionId)).activatedAt).toBeNull();
  expect(await owner.db.select().from(s.overtimePatternAssignment).where(eq(s.overtimePatternAssignment.tenantId,b.tenantId))).toHaveLength(1);
  // A different priority is not a conflict.
  const resolved=await previewOvertimePatternEligibility(ctx,{patternId:clash.patternId,companyIds:[second],plannedEligibility:{v:1,criteria:{},employmentIds:[],priority:101,from:today()}});
  expect(resolved.conflicts).toEqual([]);
 });
 it('refuses a missing Applies from date or incomplete settings, naming the reason',async()=>{
  const undated=await draft('OT020',{from:null});
  await expect(activateOvertimePatternWithEligibility(ctx,{versionId:undated.versionId,expectedRevision:undated.revision})).rejects.toMatchObject({code:'invalid',detail:{reason:'eligibilityFromMissing'}});
  const blank=await saveOvertimePatternDraft(ctx,{draft:{code:'OT021',creationCompanyId:b.companyId,companyIds:[b.companyId],name:'Incomplete fictional',definition:blankOvertimePattern({code:'MYR',minorScale:2}),plannedEligibility:{v:1,criteria:{},employmentIds:[],priority:100,from:today()}}});
  await expect(activateOvertimePatternWithEligibility(ctx,{versionId:blank.versionId,expectedRevision:blank.revision})).rejects.toMatchObject({code:'invalid',detail:{reason:'activationChecks'}});
 });
 it('edits an active pattern through a new draft that replaces it from its own date, keeping the old assignment until then',async()=>{
  const saved=await draft('OT030',{criteria:{gradeId:[gradeA]},priority:100});
  await activateOvertimePatternWithEligibility(ctx,{versionId:saved.versionId,expectedRevision:saved.revision});
  const fork=await forkOvertimePatternDraft(ctx,{versionId:saved.versionId,expectedPatternRevision:await revision(saved.patternId)});
  expect(fork.versionId).not.toBe(saved.versionId);
  const detail=await getOvertimePattern(ctx,saved.patternId);
  expect(detail!.versions.find(item=>item.id===fork.versionId)!.plannedEligibility).toEqual({v:1,criteria:{gradeId:[gradeA]},employmentIds:[],priority:100,from:null});
  // The fork is returned again instead of a second draft.
  expect((await forkOvertimePatternDraft(ctx,{versionId:saved.versionId,expectedPatternRevision:await revision(saved.patternId)})).versionId).toBe(fork.versionId);
  const replaced=await saveOvertimePatternDraft(ctx,{patternId:saved.patternId,versionId:fork.versionId,expectedRevision:fork.revision,draft:{code:'OT030',creationCompanyId:b.companyId,companyIds:[b.companyId,second],name:'OT030 revised',definition:definition(),plannedEligibility:{v:1,criteria:{gradeId:[gradeA]},employmentIds:[],priority:100,from:plus(7)}}});
  await activateOvertimePatternWithEligibility(ctx,{versionId:replaced.versionId,expectedRevision:replaced.revision});
  const old=await owner.db.select().from(s.overtimePatternAssignment).where(eq(s.overtimePatternAssignment.versionId,saved.versionId));
  expect(old.map(row=>[row.validTo,row.supersededAt])).toEqual([[plus(7),null]]);
  const states=await owner.db.select().from(s.overtimePatternVersionState).where(eq(s.overtimePatternVersionState.versionId,saved.versionId)).orderBy(asc(s.overtimePatternVersionState.sequence));
  expect(states.map(row=>[row.state,row.effectiveFrom])).toEqual([['active',today()],['inactive',plus(7)]]);
  // Today the old rules still apply.
  expect(await resolve(employees[0].id)).toMatchObject({status:'selected',patternVersionId:saved.versionId});
 });
 it('cancels an Eligibility that has not started yet, and refuses one that has',async()=>{
  const later=await draft('OT040',{from:plus(3)});
  await activateOvertimePatternWithEligibility(ctx,{versionId:later.versionId,expectedRevision:later.revision});
  const [row]=await owner.db.select().from(s.overtimePatternAssignment).where(eq(s.overtimePatternAssignment.versionId,later.versionId));
  await cancelOvertimePatternAssignment(ctx,{assignmentId:row.id,expectedRevision:row.revision,reason:'Fictional change of plan'});
  const [after]=await owner.db.select().from(s.overtimePatternAssignment).where(eq(s.overtimePatternAssignment.id,row.id));
  expect(after.supersededAt).not.toBeNull();expect(after.closeReason).toBe('Fictional change of plan');
  const now=await draft('OT041',{priority:5});
  await activateOvertimePatternWithEligibility(ctx,{versionId:now.versionId,expectedRevision:now.revision});
  const [started]=await owner.db.select().from(s.overtimePatternAssignment).where(eq(s.overtimePatternAssignment.versionId,now.versionId));
  await expect(cancelOvertimePatternAssignment(ctx,{assignmentId:started.id,expectedRevision:started.revision,reason:'Too late'})).rejects.toMatchObject({detail:{reason:'cancelStarted'}});
 });
});

describe('Preview uses the calculation\'s matching',()=>{
 it('returns exactly the employees the resolver selects, with counts of who does not match',async()=>{
  const planned={v:1,criteria:{gradeId:[gradeA]},employmentIds:[employees[3].id],priority:100,from:today()};
  const preview=await previewOvertimePatternEligibility(ctx,{companyIds:[b.companyId,second],plannedEligibility:planned});
  const selected=employees.filter(e=>resolveOvertimePattern(overtimePlannedCandidates(planned as never,[b.companyId,second].sort(),today()),facts(e.id),today()).status==='selected').map(e=>e.id).sort();
  expect(selected).toHaveLength(3);
  expect(preview.rows.map(row=>row.employmentId).sort()).toEqual(selected);
  expect(preview.matched).toEqual({count:3,capped:false});
  // Every fixture employee is in these companies; the base fixture may hold more employees there, all non-matching.
  expect(preview.unmatched.count).toBeGreaterThanOrEqual(1);
  expect(preview.issues).toBeNull();
  const row:OvertimePopulationRow={employment_id:employees[0].id,employee_code:null,full_name:'x',company_id:b.companyId,department_id:b.deptA,business_unit_id:null,position_id:null,employment_type:'full_time',grade_id:gradeA,org_division:null,org_branch:null,org_region:null,org_line:null,org_section:null,org_team:null,org_base:null,employment_category:null,attendance_rule_id:null};
  expect(overtimePreviewFacts(row,today()).gradeId).toMatchObject({state:'known',value:gradeA});
 });
 it('refuses a company outside the reader\'s administrator scope and mixed currencies',async()=>{
  const foreignCurrency=(await createCompany(ctx,{legalName:'Singapore fictional OT employer',country:'MY',currency:'SGD'})).id;
  await expect(previewOvertimePatternEligibility(ctx,{companyIds:[b.companyId,foreignCurrency],plannedEligibility:{v:1}})).rejects.toMatchObject({detail:{reason:'mixedCurrency'}});
  const [subject]=await owner.db.select({personId:s.employment.personId}).from(s.employment).where(eq(s.employment.id,employees[0].id));
  const userId=await createAppUser(b.tenantId,subject.personId,'hr_admin');await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,userId));
  const scoped={...ctx,userId,personId:subject.personId,grants:[{role:'hr_admin',companyId:b.companyId}]};
  await expect(previewOvertimePatternEligibility(scoped,{companyIds:[b.companyId,second],plannedEligibility:{v:1}})).rejects.toMatchObject({code:'permission'});
 });
});

describe('delete as archive',()=>{
 it('refuses while employees follow the pattern or a Schedule Group uses it, and frees the code once deleted',async()=>{
  const live=await draft('OT050',{criteria:{gradeId:[gradeA]}});
  await activateOvertimePatternWithEligibility(ctx,{versionId:live.versionId,expectedRevision:live.revision});
  await expect(archiveOvertimePattern(ctx,{patternId:live.patternId,expectedRevision:await revision(live.patternId)})).rejects.toMatchObject({code:'conflict',detail:{reason:'deleteBlocked',values:{assignments:1,employees:2,companies:2,groupCount:0}}});
  // A Schedule Group Overtime Setting naming the version also blocks (written through its guarded owner table).
  const [rule]=await withTenant(ctx,tx=>tx.insert(s.attendanceRule).values({tenantId:b.tenantId,name:'Fictional Office Hours'}).returning());
  const day={minimumMinutes:0,maximumMinutes:null,patternVersionId:live.versionId};
  await withTenant(ctx,tx=>tx.insert(s.attendanceGroupPolicyRevision).values({tenantId:b.tenantId,companyId:b.companyId,ruleId:rule.id,ordinal:1,effectiveFrom:plus(1),reason:'Fictional future group setting',createdByUserId:b.adminUserId,
   policy:{version:1,clock:{},overtime:{enabled:true,days:{normal:day,off:day,rest:day,publicHoliday:day,replacementHoliday:day}}}} as never));
  // Fixture shortcut: the Eligibility is withdrawn (a direct historical write; the product ends it from a date).
  const [assignment]=await owner.db.select().from(s.overtimePatternAssignment).where(eq(s.overtimePatternAssignment.versionId,live.versionId));
  await owner.client.begin(async tx=>{await tx`set local session_replication_role = replica`;await tx`update overtime_pattern_assignment set superseded_at=now(),close_reason='Fixture end',revision=revision+1 where id=${assignment.id}`;});
  await expect(archiveOvertimePattern(ctx,{patternId:live.patternId,expectedRevision:await revision(live.patternId)})).rejects.toMatchObject({detail:{reason:'deleteBlocked',values:{assignments:0,groups:'Fictional Office Hours',groupCount:1}}});
  expect((await getOvertimePattern(ctx,live.patternId))!.pattern.archivedAt).toBeNull();
  // A never-activated draft is deleted (archived), audited under Attendance with its code and name, and its code is free.
  const unused=await draft('OT051',{});
  await archiveOvertimePattern(ctx,{patternId:unused.patternId,expectedRevision:await revision(unused.patternId)});
  const [archived]=await owner.db.select().from(s.overtimePattern).where(eq(s.overtimePattern.id,unused.patternId));
  expect(archived.archivedAt).not.toBeNull();expect(await version(unused.versionId)).toBeTruthy();
  const [audit]=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,unused.patternId),eq(s.domainEvent.eventType,'overtime.pattern.archived')));
  expect(audit.payload).toMatchObject({code:'OT051',name:'OT051 fictional',reason:'Deleted from Overtime Patterns'});expect(moduleKeyOf(audit.aggregateType)).toBe('attendance');
  expect((await listOvertimePatterns(ctx,{search:'OT051'})).items).toEqual([]);
  expect((await listOvertimePatterns(ctx,{search:'OT051',status:'archived'})).items.map(item=>item.id)).toEqual([unused.patternId]);
  const replacement=await draft('ot051',{});expect(replacement.patternId).not.toBe(unused.patternId);
  await expect(draft('OT051',{})).rejects.toMatchObject({code:'conflict',detail:{reason:'duplicateCode'}});
 });
 it('refuses a Schedule Group (legacy) pattern',async()=>{
  await withTenant(ctx,tx=>tx.insert(s.attendanceRule).values({tenantId:b.tenantId,name:'Fictional legacy group'}).returning());
  const [legacy]=await owner.db.select().from(s.overtimePattern).where(and(eq(s.overtimePattern.tenantId,b.tenantId),eq(s.overtimePattern.kind,'legacy')));
  await expect(archiveOvertimePattern(ctx,{patternId:legacy.id,expectedRevision:legacy.revision})).rejects.toMatchObject({code:'permission',detail:{reason:'deleteLegacy'}});
 });
});

describe('one-time consolidation data step',()=>{
 /** The retired per-company starting drafts, exactly as the removed initializer wrote them. */
 async function seeds(companyIds:string[]){
  for(const companyId of companyIds)for(const key of ['ot15','ot20'] as const){
   const id=overtimeStarterIdentity(b.tenantId,companyId,key),code=`STD_${key.toUpperCase()}_${companyId}`;
   await withTenant(ctx,async tx=>{
    await tx.insert(s.overtimePattern).values({id,tenantId:b.tenantId,kind:'formula',code,creationCompanyId:companyId,revision:2});
    const [v]=await tx.insert(s.overtimePatternVersion).values({tenantId:b.tenantId,patternId:id,kind:'formula',creationCompanyId:companyId,ordinal:1,name:key==='ot15'?'OT 1.5':'OT 2.0',description:'',definition:overtimeStarterSeed(key) as never,digest:'d'.repeat(64)}).returning();
    await tx.insert(s.overtimePatternVersionCompany).values({tenantId:b.tenantId,versionId:v.id,companyId});
   });
  }
 }
 const snapshot=async()=>({patterns:await owner.db.select().from(s.overtimePattern).where(eq(s.overtimePattern.tenantId,b.tenantId)).orderBy(asc(s.overtimePattern.id)),
  companies:await owner.db.select().from(s.overtimePatternVersionCompany).where(eq(s.overtimePatternVersionCompany.tenantId,b.tenantId)).orderBy(asc(s.overtimePatternVersionCompany.versionId),asc(s.overtimePatternVersionCompany.companyId)),
  assignments:await owner.db.select().from(s.overtimePatternAssignment).where(eq(s.overtimePatternAssignment.tenantId,b.tenantId)).orderBy(asc(s.overtimePatternAssignment.id))});
 it('reports counts on a dry run, merges only unused identical drafts, leaves used and different ones, and is a no-op on rerun',async()=>{
  await seeds([b.companyId,second]);
  const same1=await draft('SAME_A',{},[b.companyId]),same2=await draft('SAME_B',{},[second]);
  // Same settings but a different name: kept. An activated pattern with the same content: never touched.
  await saveOvertimePatternDraft(ctx,{draft:{code:'DIFFERENT',creationCompanyId:b.companyId,companyIds:[second],name:'Another fictional name',definition:definition(),plannedEligibility:{v:1,criteria:{},employmentIds:[],priority:100,from:today()}}});
  const used=await draft('USED',{priority:9},[second]);
  await activateOvertimePatternWithEligibility(ctx,{versionId:used.versionId,expectedRevision:used.revision});
  // Make SAME_A and SAME_B identical apart from code and company (names differ by code in draft()): rename both.
  await saveOvertimePatternDraft(ctx,{patternId:same1.patternId,versionId:same1.versionId,expectedRevision:same1.revision,draft:{code:'SAME_A',creationCompanyId:b.companyId,companyIds:[b.companyId],name:'Shared fictional name',definition:definition(),plannedEligibility:{v:1,criteria:{},employmentIds:[],priority:100,from:today()}}});
  await saveOvertimePatternDraft(ctx,{patternId:same2.patternId,versionId:same2.versionId,expectedRevision:same2.revision,draft:{code:'SAME_B',creationCompanyId:b.companyId,companyIds:[second],name:'Shared fictional name',definition:definition(),plannedEligibility:{v:1,criteria:{},employmentIds:[],priority:100,from:today()}}});
  const before=await snapshot();
  const dry=await consolidateOvertimePatterns(ctx,{apply:false});
  expect(dry).toMatchObject({apply:false,formulaPatterns:8,candidates:7,groups:3,starterGroups:2,toArchive:5,archived:0,keptDifferent:1,keptInUse:1,skipped:[]});
  expect(await snapshot()).toEqual(before);
  const run=await consolidateOvertimePatterns(ctx,{apply:true});
  expect(run).toMatchObject({apply:true,archived:5,survivorsCreated:2,survivorsUpdated:1,skipped:[]});
  const live=(await owner.db.select().from(s.overtimePattern).where(and(eq(s.overtimePattern.tenantId,b.tenantId),eq(s.overtimePattern.kind,'formula'),isNull(s.overtimePattern.archivedAt)))).map(row=>row.code).sort();
  expect(live).toEqual(['DIFFERENT','SAME_A','STD_OT15','STD_OT20','USED']);
  const std=(await listOvertimePatterns(ctx,{search:'STD_OT15'})).items;expect(std).toHaveLength(1);expect(std[0].companyIds.sort()).toEqual([b.companyId,second].sort());
  const sameA=(await listOvertimePatterns(ctx,{search:'SAME_A'})).items[0];expect(sameA.companyIds.sort()).toEqual([b.companyId,second].sort());
  const [merged]=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,same2.patternId),eq(s.domainEvent.eventType,'overtime.pattern.archived')));
  expect(merged.payload).toMatchObject({reason:'Merged into SAME_A',mergedInto:same1.patternId});
  // The activated pattern and its assignments are byte-identical.
  const after=await snapshot();
  expect(after.assignments).toEqual(before.assignments);
  expect(after.patterns.find(row=>row.id===used.patternId)).toEqual(before.patterns.find(row=>row.id===used.patternId));
  // Rerun: nothing to merge, nothing written.
  const again=await consolidateOvertimePatterns(ctx,{apply:true});
  expect(again).toMatchObject({groups:0,toArchive:0,archived:0,survivorsCreated:0,survivorsUpdated:0});
  expect(await snapshot()).toEqual(after);
 });
});
