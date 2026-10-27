import {eraseOwnNativeOutcomeAssociations} from '../core/module-native-outcomes';
/** Authored UNRUN. Actual canonical Leave fixture and app-role discovery; migrations must be installed normally. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {applyLeaveAdjustmentBatch} from '../packs/leave/service';
import {prepareOwnLeaveReviewTx,confirmOwnLeaveReview} from '../core/assistant-actions/own-leave-store';
import {runGovernedModuleReadPlan} from '../core/module-agent-releases';
import {loadOwnNativeOutcomeWorkspace} from '../core/module-native-outcome-workspace';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
beforeAll(async()=>{await migrateTestDb();const[r]=await owner.db.execute<{installed:boolean}>(sql`select to_regprocedure('app.native_outcome_completed_review_choices(jsonb)') is not null as installed`);expect(r.installed,'Coordinated native outcome migration must be installed through the normal journal.').toBe(true);});
afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-native-workspace-secret-not-a-provider-key');await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});
async function fixture(){
 const admin=adminCtx(base);
 const make=async()=>{const employee=await hireEmployee(admin,{person:{fullName:'Fictional native choice applicant',primaryEmail:randomUUID()+'@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()}),userId=await createAppUser(base.tenantId,employee.personId,'employee');await grantAssistant(admin,{appUserId:userId});
  const ctx:SessionContext={...await entitledCtx(base,['employee']),userId,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  await applyLeaveAdjustmentBatch(admin,{leaveTypeIds:[base.annualLeaveTypeId],days:10,effectiveOn:todayInKualaLumpur(),reason:'Fictional discovery fixture credit',targetMode:'individual',employmentIds:[employee.employmentId]});
  const job=await runGovernedModuleReadPlan(ctx,{version:1,modules:['leave']},{nonce:randomUUID()});
  const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));
  const prepared=await withTenant(ctx,tx=>prepareOwnLeaveReviewTx(tx,ctx,{action:'leave.apply',contractVersion:1,employmentId:employee.employmentId,leaveTypeId:base.annualLeaveTypeId,date:next.toISOString().slice(0,10),durationType:'full_day'},{employmentId:employee.employmentId,leaveTypeId:base.annualLeaveTypeId},{reason:'PRIVATE human reason must not appear in discovery',employeeRemark:''},'en'));
  if(prepared.kind!=='prepared')throw Error('Canonical Leave discovery fixture failed');return{ctx,employee,job,review:prepared.review};};
 return{admin,mine:await make(),peer:await make()};
}
async function complete(subject:Awaited<ReturnType<typeof fixture>>['mine']){const r=subject.review;expect((await confirmOwnLeaveReview(subject.ctx,{actionId:r.actionId,contractVersion:r.contractVersion,reviewedDigest:r.reviewedDigest},'en')).kind).toBe('completed');}
async function counts(){const[row]=await owner.db.execute<{requests:number;events:number;links:number;runs:number}>(sql`select (select count(*)::int from public.leave_request) as requests,(select count(*)::int from public.domain_event) as events,(select count(*)::int from public.ai_native_outcome_association) as links,(select count(*)::int from public.ai_model_run) as runs`);return row;}
describe('own completed native outcome discovery',()=>{
 it('discovers only own completed same-module metadata, never pending bodies or effects on GET',async()=>{
  const f=await fixture();await complete(f.peer);const before=await counts();
  expect(await loadOwnNativeOutcomeWorkspace(f.mine.ctx,f.mine.job.jobId)).toEqual({jobId:f.mine.job.jobId,choices:[],links:[],truncated:false});expect(await counts()).toEqual(before);
  await complete(f.mine);const after=await counts(),workspace=await loadOwnNativeOutcomeWorkspace(f.mine.ctx,f.mine.job.jobId);
  expect(workspace.choices).toHaveLength(1);expect(workspace.choices[0].reference).toEqual({source:'review',action:'leave.apply',actionId:f.mine.review.actionId});expect(workspace.links).toEqual([]);expect(workspace.truncated).toBe(false);
  expect(JSON.stringify(workspace)).not.toMatch(/PRIVATE|reason|remark|eventId|employmentId|leaveTypeId|balance|reviewedDigest|sealed|receipt/);expect(JSON.stringify(workspace)).not.toContain(f.peer.review.actionId);expect(await counts()).toEqual(after);
 });
 it('rechecks original own job authority and current native module before discovery after revocation',async()=>{
  const f=await fixture();await complete(f.mine);const before=await counts();
  await expect(loadOwnNativeOutcomeWorkspace(f.peer.ctx,f.mine.job.jobId)).rejects.toThrow();await expect(loadOwnNativeOutcomeWorkspace({...f.mine.ctx,tenantId:randomUUID()},f.mine.job.jobId)).rejects.toThrow();
  vi.stubEnv('MODULE_KILL','leave');await expect(loadOwnNativeOutcomeWorkspace(f.mine.ctx,f.mine.job.jobId)).rejects.toThrow();vi.unstubAllEnvs();vi.stubEnv('AI_CONFIG_SECRET','fictional-native-workspace-secret-not-a-provider-key');
  expect(await counts()).toEqual(before);await revokeAssistant(f.admin,{appUserId:f.mine.ctx.userId!});const afterRevocation=await counts();await expect(loadOwnNativeOutcomeWorkspace(f.mine.ctx,f.mine.job.jobId)).rejects.toThrow();expect(await counts()).toEqual(afterRevocation);
 });
 it('keeps the SQL discovery helper own-user scoped and refuses open or duplicate action vocabularies',async()=>{
  const f=await fixture();await complete(f.mine);await complete(f.peer);
  const rows=await withTenant(f.mine.ctx,tx=>tx.execute(sql`select * from app.native_outcome_completed_review_choices('["leave.apply"]'::jsonb)`));expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({action:'leave.apply',action_id:f.mine.review.actionId});expect(Object.keys(rows[0]).sort()).toEqual(['action','action_id','created_at']);
  for(const input of ['[]','null','{}','["leave.apply","leave.apply"]','["unknown.action"]','[42]'])await expect(withTenant(f.mine.ctx,tx=>tx.execute(sql`select * from app.native_outcome_completed_review_choices(${input}::jsonb)`))).rejects.toThrow();
 });
});

/** Authored UNRUN: erased/historical captures are not advertised as usable association choices. */
it('hides old completed source nominations after own learning erasure without changing the human completion',async()=>{
 const f=await fixture();await complete(f.mine);expect((await loadOwnNativeOutcomeWorkspace(f.mine.ctx,f.mine.job.jobId)).choices).toHaveLength(1);const before=await counts();
 await eraseOwnNativeOutcomeAssociations(f.mine.ctx);expect((await loadOwnNativeOutcomeWorkspace(f.mine.ctx,f.mine.job.jobId)).choices).toEqual([]);
 expect(await counts()).toEqual(before);const [row]=await owner.db.execute<{state:string}>(sql`select state from app.assistant_own_leave_review where id=${f.mine.review.actionId}::uuid`);expect(row.state).toBe('completed');
});
