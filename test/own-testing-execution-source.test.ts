/** Authored UNRUN; requires the coordinated testing-execution-source migration before DB execution.
 * Fictional human-entered statuses/notes are recorded observations, never independently verified passes. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import * as workspace from '../core/system-testing-workspace';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {pgSqlState} from '../lib/db-error';
import {TestingRefusal,EXECUTION_STATUSES,type InstructionDefinition} from '../lib/system-testing/model';
import {OwnTestingExecutionNomination,OwnTestingExecutionIntent} from '../lib/assistant-actions/own-testing-execution-contract';
import {prepareOwnTestingExecutionTx,confirmOwnTestingExecutionTx,reopenOwnTestingExecutionEventTx} from '../core/assistant-actions/own-testing-execution-source';
import {adminCtx,closeAll,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
const guide:InstructionDefinition={format:1,title:'Fictional human observation',objective:'Record a fictional manually observed saved value.',functionKey:'personnel.profile',area:'personnel',moduleCode:'employees',category:'functional',priority:'medium',active:true,prerequisites:[],testData:[],steps:[{id:'observe',action:'Inspect the fictional saved value.',expected:'The fictional value is retained.'}],expectedBehavior:'The observed value can be recorded.',expectedFunction:'Personal Testing record.',permissions:['Only the assigned tester records their own observation.'],jurisdiction:null,configuration:null,screenKeys:['personnelAdmin']};
beforeAll(async()=>{await migrateTestDb();const [helper]=await owner.db.execute<{available:boolean}>(sql`select to_regprocedure('app.testing_own_execution_event_source(uuid,uuid)') is not null as available`);expect(helper.available,'Coordinated Testing source helper must be installed before this suite.').toBe(true);});afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();await setModule(base.tenantId,'system_testing','active');await setModule(base.tenantId,'assistant','active');});
async function tester(){
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'user_'+randomUUID(),personId:null}).returning({id:schema.appUser.id});await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId:null,role:'employee'});await grantAssistant(adminCtx(base),{appUserId:user.id});
 return {tenantId:base.tenantId,userId:user.id,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}],entitlements:harnessSnapshot(base.tenantId)} satisfies SessionContext;
}
async function fixture(){
 const admin=adminCtx(base),ctx=await tester(),other=await tester(),draft=await workspace.saveTestInstructionDraft(admin,{caseId:null,expectedRevision:0,definition:guide}),version=await workspace.publishTestInstruction(admin,{caseId:draft.caseId,expectedDraftRevision:draft.revision,expectedVersionId:null});
 const assignment=await workspace.assignTestingCase(admin,{caseId:draft.caseId,testerUserId:ctx.userId,expectedVersionId:version.versionId,active:true,expectedRevision:null}),execution=await workspace.beginTestingExecution(ctx,{assignmentId:assignment.assignmentId,expectedVersionId:version.versionId,newAttempt:false});
 const intent=OwnTestingExecutionIntent.parse({version:1,humanObserved:true,observation:{executionId:execution.executionId,assignmentId:assignment.assignmentId,versionId:version.versionId,expectedRevision:execution.revision,status:'in_progress',actualResult:'Fictional value inspected by the human.',comments:'Human comment',defectNotes:'Human defect note',improvementNotes:'Human improvement note'}});
 return {admin,ctx,other,draft,version,assignment,execution,intent};
}
const prepare=(a:Awaited<ReturnType<typeof fixture>>)=>withTenant(a.ctx,tx=>prepareOwnTestingExecutionTx(tx,a.ctx,a.intent));
const confirm=(a:Awaited<ReturnType<typeof fixture>>,digest:string)=>withTenant(a.ctx,tx=>confirmOwnTestingExecutionTx(tx,a.ctx,a.intent,digest));
async function state(){return {runs:await owner.db.select().from(schema.testRun).orderBy(schema.testRun.id),executions:await owner.db.select().from(schema.testExecution).orderBy(schema.testExecution.id),events:await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'test_execution.observation_saved')).orderBy(schema.domainEvent.id)};}
describe('human-only own assigned Testing execution source',()=>{
 it('keeps the model schema references-only and preserves every native human observation field/status',()=>{
  const executionId=randomUUID();expect(OwnTestingExecutionNomination.safeParse({version:1,executionId}).success).toBe(true);for(const field of ['status','actualResult','comments','defectNotes','improvementNotes','verified','score'])expect(OwnTestingExecutionNomination.safeParse({version:1,executionId,[field]:'model'}).success).toBe(false);
  for(const status of EXECUTION_STATUSES){const intent={version:1,humanObserved:true,observation:{executionId,assignmentId:randomUUID(),versionId:randomUUID(),expectedRevision:0,status,actualResult:'Human observation',comments:'Human comment',defectNotes:'Human defect',improvementNotes:'Human improvement'}};expect(OwnTestingExecutionIntent.parse(intent).observation).toEqual(intent.observation);expect(OwnTestingExecutionIntent.safeParse({...intent,humanObserved:false}).success).toBe(false);}
 });
 it('records a nonadmin standalone tester observation, returns an exact native event and never grants staff visibility',async()=>{
  const a=await fixture(),before=await state(),review=await prepare(a);expect(a.ctx.personId).toBeNull();expect(review.humanObservation).toEqual(a.intent.observation);expect(JSON.stringify(review)).not.toContain(guide.objective);expect((await state()).runs).toEqual(before.runs);
  const receipt=await confirm(a,review.reviewDigest),after=await state();expect(receipt.meaning).toBe('human_observation_recorded_not_independently_verified');expect(receipt.status).toBe('in_progress');expect(after.runs).toHaveLength(1);expect(after.runs[0]).toMatchObject({actualResult:a.intent.observation.actualResult,comments:'Human comment',defectNotes:'Human defect note',improvementNotes:'Human improvement note',runByUserId:a.ctx.userId});expect(after.events[0].id).toBe(receipt.eventId);
  const hidden=await withTenant(a.ctx,tx=>tx.select({id:schema.domainEvent.id}).from(schema.domainEvent).where(eq(schema.domainEvent.id,receipt.eventId)));expect(hidden).toEqual([]);
  const reference={runId:receipt.runId,eventId:receipt.eventId};expect(await withTenant(a.ctx,tx=>reopenOwnTestingExecutionEventTx(tx,a.ctx,reference))).toEqual(receipt);expect(await state()).toEqual(after);await expect(confirm(a,review.reviewDigest)).rejects.toThrow();expect(await state()).toEqual(after);
  const [staff]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.employment e join public.app_user u on u.person_id=e.person_id where u.id=${a.ctx.userId}::uuid`);expect(staff.n).toBe(0);
 });
 it('does not include or invalidate on an unpublished draft, but refuses a published replacement instruction',async()=>{
  const a=await fixture(),review=await prepare(a);const draft=await workspace.saveTestInstructionDraft(a.admin,{caseId:a.draft.caseId,expectedRevision:a.version.draftRevision,definition:{...guide,objective:'PRIVATE_UNPUBLISHED_DRAFT_BODY'}});const unchanged=await prepare(a);expect(unchanged.reviewDigest).toBe(review.reviewDigest);expect(JSON.stringify(unchanged)).not.toContain('PRIVATE_UNPUBLISHED_DRAFT_BODY');
  await workspace.publishTestInstruction(a.admin,{caseId:a.draft.caseId,expectedDraftRevision:draft.revision,expectedVersionId:a.version.versionId});await expect(confirm(a,review.reviewDigest)).rejects.toThrow();expect((await state()).runs).toHaveLength(0);
 });
 it('refuses revoked assignment, another tester, an older attempt and stale revision without recording an observation',async()=>{
  const a=await fixture(),review=await prepare(a);await expect(withTenant(a.other,tx=>prepareOwnTestingExecutionTx(tx,a.other,a.intent))).rejects.toThrow();await workspace.assignTestingCase(a.admin,{caseId:a.draft.caseId,testerUserId:a.ctx.userId,expectedVersionId:a.version.versionId,active:false,expectedRevision:a.assignment.revision});await expect(confirm(a,review.reviewDigest)).rejects.toThrow();await workspace.assignTestingCase(a.admin,{caseId:a.draft.caseId,testerUserId:a.ctx.userId,expectedVersionId:a.version.versionId,active:true,expectedRevision:a.assignment.revision+1});
  const fresh=await prepare(a);await workspace.beginTestingExecution(a.ctx,{assignmentId:a.assignment.assignmentId,expectedVersionId:a.version.versionId,newAttempt:true});await expect(confirm(a,fresh.reviewDigest)).rejects.toThrow();expect((await state()).runs).toHaveLength(0);
 });
 it('rechecks Assistant/module revocation and preserves original ordinary save shape/wait configuration',async()=>{
  const a=await fixture(),review=await prepare(a);await revokeAssistant(a.admin,{appUserId:a.ctx.userId});await expect(confirm(a,review.reviewDigest)).rejects.toThrow();await grantAssistant(a.admin,{appUserId:a.ctx.userId});await setModule(base.tenantId,'system_testing','disabled');await expect(confirm(a,review.reviewDigest)).rejects.toThrow();await setModule(base.tenantId,'system_testing','active');
  const result=await workspace.saveTestingExecution(a.ctx,a.intent.observation);expect(Object.keys(result).sort()).toEqual(['revision','runId']);expect(result.revision).toBe(1);
 });
 it('rolls back native run/head/event together if shared completion fails, then permits the original retry',async()=>{
  const a=await fixture(),review=await prepare(a),before=await state();await expect(withTenant(a.ctx,async tx=>{await confirmOwnTestingExecutionTx(tx,a.ctx,a.intent,review.reviewDigest);throw Error('fictional custody failure');})).rejects.toThrow('fictional custody failure');expect(await state()).toEqual(before);await confirm(a,review.reviewDigest);expect((await state()).runs).toHaveLength(1);
 });
 it('records one observation across duplicate direct confirmations and captures human input before awaiting',async()=>{
  const a=await fixture(),original=a.intent.observation.actualResult,review=await withTenant(a.ctx,async tx=>{const pending=prepareOwnTestingExecutionTx(tx,a.ctx,a.intent);a.intent.observation.actualResult='Changed retained input';return pending;});expect(review.humanObservation.actualResult).toBe(original);await expect(confirm(a,review.reviewDigest)).rejects.toThrow();a.intent.observation.actualResult=original;const results=await Promise.allSettled([confirm(a,review.reviewDigest),confirm(a,review.reviewDigest)]);expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect((await state()).runs).toHaveLength(1);
 });
 it('uses only the narrow metadata helper for nonadmin events and refuses forged/foreign references or current-head changes',async()=>{
  const a=await fixture(),receipt=await confirm(a,(await prepare(a)).reviewDigest),reference={runId:receipt.runId,eventId:receipt.eventId};const rows=await withTenant(a.ctx,tx=>tx.execute(sql`select * from app.testing_own_execution_event_source(${receipt.runId}::uuid,${receipt.eventId}::uuid)`));expect(rows).toHaveLength(1);expect(Object.keys(rows[0]).sort()).toEqual(['assignment_id','case_id','content_hash','event_id','execution_id','execution_revision','execution_status','run_id','source_content_hash','version_id']);expect(JSON.stringify(rows)).not.toContain(a.intent.observation.actualResult);
  expect(await withTenant(a.other,tx=>tx.execute(sql`select * from app.testing_own_execution_event_source(${receipt.runId}::uuid,${receipt.eventId}::uuid)`))).toEqual([]);await expect(withTenant(a.other,tx=>reopenOwnTestingExecutionEventTx(tx,a.other,reference))).rejects.toThrow();await expect(withTenant(a.ctx,tx=>reopenOwnTestingExecutionEventTx(tx,a.ctx,{...reference,eventId:randomUUID()}))).rejects.toThrow();
  await workspace.saveTestingExecution(a.ctx,{...a.intent.observation,expectedRevision:receipt.revision,status:'blocked',actualResult:'Human reports blocked follow-up.'});await expect(withTenant(a.ctx,tx=>reopenOwnTestingExecutionEventTx(tx,a.ctx,reference))).rejects.toThrow();expect((await state()).runs).toHaveLength(2);
 });
 it('does not increase an existing shorter lock timeout and restores exact text on success and a valid business refusal',async()=>{
  const a=await fixture(),original=workspace.prepareTestingExecutionSaveTx,observed:number[]=[];const spy=vi.spyOn(workspace,'prepareTestingExecutionSaveTx').mockImplementation(async(tx,...args)=>{const [guc]=await tx.execute<{setting:number;unit:string}>(sql`select setting::integer as setting,unit from pg_settings where name='lock_timeout'`);expect(guc.unit).toBe('ms');observed.push(guc.setting);return original(tx,...args);});
  try{await withTenant(a.ctx,async tx=>{await tx.execute(sql`select set_config('lock_timeout','50ms',true)`);const [before]=await tx.execute<{saved:string}>(sql`select current_setting('lock_timeout') as saved`);await prepareOwnTestingExecutionTx(tx,a.ctx,a.intent);const [after]=await tx.execute<{saved:string}>(sql`select current_setting('lock_timeout') as saved`);expect(after.saved).toBe(before.saved);});expect(observed).toEqual([50]);}finally{spy.mockRestore();}
  await expect(withTenant(a.ctx,async tx=>{await tx.execute(sql`select set_config('lock_timeout','50ms',true)`);try{await prepareOwnTestingExecutionTx(tx,a.ctx,{...a.intent,observation:{...a.intent.observation,expectedRevision:1}});}catch(error){expect(error).toBeInstanceOf(TestingRefusal);const [after]=await tx.execute<{saved:string}>(sql`select current_setting('lock_timeout') as saved`);expect(after.saved).toBe('50ms');throw error;}})).rejects.toThrow();
 });
 it('bounds contention using the actual existing case→assignment lock helper and aborts the whole transaction',async()=>{
  const a=await fixture(),before=await state();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(yes=>{entered=yes;}),resume=new Promise<void>(yes=>{release=yes;}),held=withTenant(a.admin,async tx=>{await tx.select({id:schema.testCase.id}).from(schema.testCase).where(eq(schema.testCase.id,a.draft.caseId)).for('update');entered();await resume;});
  try{await started;let failure:unknown;try{await withTenant(a.ctx,async tx=>{await tx.execute(sql`select set_config('lock_timeout','50ms',true)`);return prepareOwnTestingExecutionTx(tx,a.ctx,a.intent);});}catch(error){failure=error;}expect(pgSqlState(failure)).toBe('55P03');expect(await state()).toEqual(before);}finally{release();await held;}await prepare(a);
 });
});
