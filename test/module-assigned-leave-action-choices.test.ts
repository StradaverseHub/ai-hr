/** Authored UNRUN: actual native assigned metadata/RLS gates, no inline migration application. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));vi.mock('../lib/real-auth',()=>({appOrigin:()=>undefined}));vi.mock('../core/assistant-actions/own-leave-server',()=>({authenticateOwnLeaveBrowserSession:vi.fn(()=>{throw Error('HTTP authentication is outside this actual choices test.');})}));vi.mock('../lib/identity/provider',()=>({currentProviderSession:vi.fn(async()=>null)}));
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {lockAccessConfigurationReadTx} from '../core/access-configuration-lock';
import {requestLeave,decideLeave,pendingLeaveTaskMetadata,lockLeaveDependencyConfigurationTx} from '../packs/leave/service';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {setAiFeature} from '../core/ai-management';
import {setAgentActionPause} from '../core/ai-inventory';
import {setMandateStopSwitch} from '../core/mandates/mandates';
import {hasAssignedLeaveActionForPresentation} from '../core/assistant-actions/assigned-leave-presentation';
import {moduleActionEntryAccess} from '../core/assistant-actions/module-action-entries';
import {readAssignedLeaveModuleActionChoices} from '../core/assistant-actions/module-action-server';
import {REVIEWED_LEAVE_DECISION_ACTION} from '../lib/assistant-actions/reviewed-leave-decision-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,requestId:string,subject:{employmentId:string;personId:string};
const group=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
const hire=(name:string)=>hireEmployee(group(),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur().slice(0,4)+'-01-01',grantLeaveTypes:[{id:b.annualLeaveTypeId,code:'ANNUAL'}]});
async function namedEmployeeApprover(){
 const named=await hire('Fictional named approver');
 const userId=await createAppUser(b.tenantId,named.personId,'employee');
 // Native request visibility follows the reporting line. The pending step supplies decision authority.
 await setReportingLine(group(),{subordinateEmploymentId:subject.employmentId,managerEmploymentId:named.employmentId,
  lineType:'administrative',validFrom:todayInKualaLumpur()});
 await owner.db.delete(s.leaveApprovalStep).where(eq(s.leaveApprovalStep.leaveRequestId,requestId));
 const [step]=await owner.db.insert(s.leaveApprovalStep).values({tenantId:b.tenantId,leaveRequestId:requestId,
  subjectEmploymentId:subject.employmentId,stepIndex:0,approverKind:'specific_employee',approverEmploymentId:named.employmentId}).returning();
 await grantAssistant(group(),{appUserId:userId});
 const who={...await entitledCtx(b,['employee']),userId,personId:named.personId,grants:[{role:'employee' as const,companyId:null}]};
 return {who,stepId:step.id};
}

function barrier(){
 let release!:()=>void;
 const promise=new Promise<void>(resolve=>{release=resolve;});
 return {promise,release};
}

async function bounded<T>(work:Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 const timeout=new Promise<never>((_,reject)=>{
  timer=setTimeout(()=>reject(Error('Independent Assistant readers did not overlap')),5000);
 });
 try{return await Promise.race([work,timeout]);}finally{clearTimeout(timer);}
}

beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');await grantAssistant(group(),{appUserId:b.adminUserId});ctx={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};await seedEntitlement(group(),{leaveTypeId:b.annualLeaveTypeId,annualDays:12,validFrom:todayInKualaLumpur().slice(0,4)+'-01-01',name:'Fictional assigned choice'});await owner.db.update(s.leaveType).set({counting:'calendar_days'}).where(eq(s.leaveType.id,b.annualLeaveTypeId));subject=await hire('Fictional permitted applicant');const date=new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+86400000*7).toISOString().slice(0,10);requestId=(await requestLeave(group(),{employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date,durationType:'full_day',reason:'PRIVATE applicant reason not chooser context',employeeRemark:'PRIVATE applicant remark'})).leaveRequestId;});
describe('actual assigned Leave metadata choice owner',()=>{
 it('supports actual personless HR and returns only the SAME canonical assigned tasks without private request fields',async()=>{expect(ctx.personId).toBeUndefined();const result=await readAssignedLeaveModuleActionChoices(ctx),inbox=await pendingLeaveTaskMetadata(ctx);expect(result.kind).toBe('choices');if(result.kind!=='choices')throw Error('Expected canonical choices');expect(result.tasks.map(row=>row.leaveRequestId)).toEqual(inbox.map(row=>row.id));expect(result.tasks[0].applicantLabel).toBe('Fictional permitted applicant');expect(Object.keys(result.tasks[0]).sort()).toEqual(['applicantLabel','createdAt','currentStepId','leaveRequestId','stepIndex']);expect(JSON.stringify(result)).not.toMatch(/PRIVATE|employmentId|personId|rejectReason|balance|days|attachment/);expect(result.truncated).toBe(false);});
 it('uses actual null single-decision references, never creates a fake step UUID',async()=>{await owner.db.delete(s.leaveApprovalStep).where(eq(s.leaveApprovalStep.leaveRequestId,requestId));const result=await readAssignedLeaveModuleActionChoices(ctx);if(result.kind!=='choices')throw Error('Expected choices');expect(result.tasks[0]).toMatchObject({leaveRequestId:requestId,currentStepId:null,stepIndex:null});});
 it('returns only the actual current pending step and advances through native decision owner',async()=>{await owner.db.delete(s.leaveApprovalStep).where(eq(s.leaveApprovalStep.leaveRequestId,requestId));const steps=await owner.db.insert(s.leaveApprovalStep).values([0,1].map(stepIndex=>({tenantId:b.tenantId,leaveRequestId:requestId,subjectEmploymentId:subject.employmentId,stepIndex,approverKind:'hr_admin'}))).returning();let result=await readAssignedLeaveModuleActionChoices(ctx);if(result.kind!=='choices')throw Error('Expected choices');expect(result.tasks[0]).toMatchObject({currentStepId:steps.find(row=>row.stepIndex===0)!.id,stepIndex:0});await decideLeave(ctx,{leaveRequestId:requestId,decision:'approved'});result=await readAssignedLeaveModuleActionChoices(ctx);if(result.kind!=='choices')throw Error('Expected current nextstep');expect(result.tasks[0]).toMatchObject({currentStepId:steps.find(row=>row.stepIndex===1)!.id,stepIndex:1});});
 it('does not turn Assistant grant or a person role into another user’s task assignment or applicant names',async()=>{const person=await hire('Fictional unassigned actor'),userId=await createAppUser(b.tenantId,person.personId,'employee');await grantAssistant(group(),{appUserId:userId});const who={...await entitledCtx(b,['employee']),userId,personId:person.personId,grants:[{role:'employee' as const,companyId:null}]},result=await readAssignedLeaveModuleActionChoices(who);expect(result).toEqual({kind:'choices',tasks:[],truncated:false});expect(JSON.stringify(result)).not.toContain('permitted applicant');});
 it('refuses real Assistant revocation and actual nonadmitting pause before returning applicant labels',async()=>{await revokeAssistant(group(),{appUserId:ctx.userId!});expect(await readAssignedLeaveModuleActionChoices(ctx)).toEqual({kind:'unavailable'});await grantAssistant(group(),{appUserId:ctx.userId!});const [proof]=await withTenant(group(),tx=>tx.execute<{allowed:boolean}>(sql`select app.is_group_admin() and app.principal_snapshot_current() as allowed`));expect(proof.allowed).toBe(true);await setAiFeature(group(),'hr_assistant',false);expect(await readAssignedLeaveModuleActionChoices(ctx)).toEqual({kind:'unavailable'});});
 it('refuses forged actor/person scope rather than returning a fake empty inbox',async()=>{expect(await readAssignedLeaveModuleActionChoices({...ctx,userId:randomUUID()})).toEqual({kind:'unavailable'});expect(await readAssignedLeaveModuleActionChoices({...ctx,personId:subject.personId})).toEqual({kind:'unavailable'});});
 it('refuses an actual held configuration interval before returning private labels; after release native choices remain intact',async()=>{let entered!:()=>void,release!:()=>void;const start=new Promise<void>(r=>{entered=r;}),resume=new Promise<void>(r=>{release=r;}),held=withTenant(group(),async tx=>{await lockLeaveDependencyConfigurationTx(tx,b.tenantId);entered();await resume;});try{await start;expect(await readAssignedLeaveModuleActionChoices(ctx)).toEqual({kind:'unavailable'});}finally{release();await held;}expect((await readAssignedLeaveModuleActionChoices(ctx)).kind).toBe('choices');});
});

describe('assigned Leave shortcut presentation',()=>{
 it('offers a named employee the actual task while another application transaction holds shared Access',async()=>{
  const {who,stepId}=await namedEmployeeApprover();
  expect(await readAssignedLeaveModuleActionChoices(who)).toMatchObject({kind:'choices',
   tasks:[{leaveRequestId:requestId,currentStepId:stepId}]});
  const entered=barrier(),release=barrier();
  const holder=withTenant(group(),async tx=>{
   await lockAccessConfigurationReadTx(tx,b.tenantId);
   entered.release();
   await release.promise;
  });
  let reading:Promise<unknown>|undefined;
  try{
   await bounded(Promise.race([entered.promise,holder]));
   const [probe]=await owner.db.execute<{exclusive_available:boolean}>(sql`select
    pg_try_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0)) as exclusive_available`);
   expect(probe.exclusive_available).toBe(false);
   reading=moduleActionEntryAccess(who,'assigned_leave');
   expect(await bounded(reading)).toBe('allowed');
  }finally{
   release.release();
   await Promise.allSettled([holder,...(reading?[reading]:[])]);
  }
 });

 it('uses fresh identity, roles, entitlement, grant, action, feature, Stop and assignment',async()=>{
  const {who,stepId}=await namedEmployeeApprover();
  const access=()=>moduleActionEntryAccess(who,'assigned_leave');
  expect(await access()).toBe('allowed');
  expect(await moduleActionEntryAccess({...who,personId:subject.personId},'assigned_leave')).toBe('unknown');
  await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,who.userId));
  expect(await access()).toBe('unknown');
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:who.userId,companyId:null,role:'employee'});

  await setModule(b.tenantId,'assistant','disabled');
  expect(await access()).toBe('unknown');
  await setModule(b.tenantId,'assistant','active');
  await revokeAssistant(group(),{appUserId:who.userId});
  expect(await access()).toBe('unknown');
  await grantAssistant(group(),{appUserId:who.userId});
  await setAgentActionPause(group(),REVIEWED_LEAVE_DECISION_ACTION,true);
  expect(await access()).toBe('unknown');
  await setAgentActionPause(group(),REVIEWED_LEAVE_DECISION_ACTION,false);
  await setAiFeature(group(),'hr_assistant',false);
  expect(await access()).toBe('unknown');
  await setAiFeature(group(),'hr_assistant',true);
  await setMandateStopSwitch(group(),true);
  expect(await access()).toBe('unknown');
  await setMandateStopSwitch(group(),false);
  expect(await access()).toBe('allowed');

  await owner.db.update(s.leaveApprovalStep).set({approverEmploymentId:subject.employmentId}).where(eq(s.leaveApprovalStep.id,stepId));
  expect(await access()).toBe('refused');
 });

 it('retains the native leave configuration barrier',async()=>{
  const {who}=await namedEmployeeApprover();
  const entered=barrier(),release=barrier();
  const holder=withTenant(group(),async tx=>{
   await lockLeaveDependencyConfigurationTx(tx,b.tenantId);
   entered.release();
   await release.promise;
  });
  let reading:Promise<boolean>|undefined;
  try{
   await bounded(Promise.race([entered.promise,holder]));
   reading=hasAssignedLeaveActionForPresentation(who);
   await expect(bounded(reading)).rejects.toMatchObject({name:'LeaveDependencyUnavailable',reason:'busy'});
  }finally{
   release.release();
   await Promise.allSettled([holder,...(reading?[reading]:[])]);
  }
  expect(await moduleActionEntryAccess(who,'assigned_leave')).toBe('allowed');
 });
});
