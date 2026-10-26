/** Authored UNRUN. Canonical approval configuration writers versus actual employee intervals. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as tenantDb from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setLeaveApprovalPolicy,createLeaveApprovalRule,updateLeaveApprovalRule,archiveLeaveApprovalRule,setLeaveEscalationPolicy} from '../core/leave-approval-policy';
import {lockLeaveDependenciesTx} from '../core/leave-dependency-lock';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const group=():SessionContext=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
const subject=()=>hireEmployee(group(),{person:{fullName:'Fictional Approval Source',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
async function state(){return{rules:await owner.db.select().from(schema.leaveApprovalPolicy).where(eq(schema.leaveApprovalPolicy.tenantId,b.tenantId)).orderBy(schema.leaveApprovalPolicy.id),companies:await owner.db.select().from(schema.company).where(eq(schema.company.tenantId,b.tenantId)).orderBy(schema.company.id),requests:await owner.db.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.tenantId,b.tenantId)).orderBy(schema.leaveRequest.id),ledger:await owner.db.select().from(schema.leaveLedger).where(eq(schema.leaveLedger.tenantId,b.tenantId)).orderBy(schema.leaveLedger.id),events:await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId,b.tenantId)).orderBy(schema.domainEvent.id)};}
async function held(id:string){let ready!:()=>void,failed!:(e:unknown)=>void,release!:()=>void;const started=new Promise<void>((yes,no)=>{ready=yes;failed=no;}),done=new Promise<void>(yes=>{release=yes;});const timer=setTimeout(()=>{failed(Error('owned approval interval timed out'));release();},10000);const pending=withTenant(group(),async tx=>{await lockLeaveDependenciesTx(tx,b.tenantId,[id]);ready();await done;});void pending.catch(failed);await started;return{async close(){release();clearTimeout(timer);await pending;}};}
describe('approval rule/chain/escalation protected configuration source',()=>{
 it.each(['policy','create','update','archive','escalation'] as const)('%s refuses without rule/company/request/ledger/event effects, then applies after release',async kind=>{
  const a=await subject(),ctx=group();let ruleId:string|undefined;
  if(kind==='policy')await setLeaveApprovalPolicy(ctx,{companyId:b.companyId,levels:['direct_manager']});
  if(kind==='update'||kind==='archive')ruleId=(await createLeaveApprovalRule(ctx,{companyId:b.companyId,departmentId:b.deptA,levels:['direct_manager'],ruleName:'Fictional Existing Rule'})).id;
  const invoke=()=>kind==='policy'?setLeaveApprovalPolicy(ctx,{companyId:b.companyId,levels:['hr_admin'],reason:'Fictional chain change'}):kind==='create'?createLeaveApprovalRule(ctx,{companyId:b.companyId,departmentId:b.deptB,levels:['hr_admin'],ruleName:'Fictional New Rule'}):kind==='update'?updateLeaveApprovalRule(ctx,ruleId!,{companyId:b.companyId,departmentId:b.deptB,levels:['hr_admin'],ruleName:'Fictional Changed Rule'},{reason:'Fictional route correction'}):kind==='archive'?archiveLeaveApprovalRule(ctx,ruleId!,b.companyId):setLeaveEscalationPolicy(ctx,{companyId:b.companyId,enabled:true,escalateAfterDays:3,target:'specific_role',targetRole:'hr_admin',reason:'Fictional escalation'});
  const before=await state(),holder=await held(a.employmentId);try{await expect(invoke()).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);}finally{await holder.close();}
  await invoke();const after=await state(),old=new Set(before.events.map(row=>row.id)),added=after.events.filter(row=>!old.has(row.id));expect(added).toHaveLength(1);expect(added[0].eventType).toBe(kind==='policy'?'leave-approval-policy.updated':kind==='create'?'leave-approval-rule.created':kind==='update'?'leave-approval-rule.updated':kind==='archive'?'leave-approval-rule.archived':'leave-escalation-policy.updated');expect(after.requests).toEqual(before.requests);expect(after.ledger).toEqual(before.ledger);
  if(kind==='archive')expect(after.rules.find(row=>row.id===ruleId)?.active).toBe(false);else if(kind==='escalation')expect(after.companies.find(row=>row.id===b.companyId)).toMatchObject({escalationEnabled:true,escalateAfterDays:3,escalationTarget:'specific_role',escalationTargetRole:'hr_admin'});else expect(after.rules.some(row=>row.companyId===b.companyId&&JSON.stringify(row.levels)===JSON.stringify(['hr_admin']))).toBe(true);
 });
 it('captures rule scopes/levels/opts/context before the transaction await rather than retargeting a saved change',async()=>{
  await subject();const rule=await createLeaveApprovalRule(group(),{companyId:b.companyId,departmentId:b.deptA,levels:['direct_manager']}),ctx=group(),p={companyId:b.companyId,departmentId:b.deptB,levels:['hr_admin'],ruleName:'Fictional Captured Rule'},opts={reason:'Fictional captured reason'};let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(yes=>{entered=yes;}),pause=new Promise<void>(yes=>{release=yes;});const actual=tenantDb.withTenant,boundary=vi.spyOn(tenantDb,'withTenant').mockImplementationOnce(async(c,fn)=>{entered();await pause;return actual(c,fn);});const pending=updateLeaveApprovalRule(ctx,rule.id,p,opts);
  try{await ready;p.companyId=randomUUID();p.departmentId=b.deptA;p.levels.splice(0,1,'payroll');p.ruleName='retargeted';opts.reason='retargeted';ctx.userId=randomUUID();ctx.grants![0].role='employee';release();await pending;}finally{release();await pending.catch(()=>{});boundary.mockRestore();}
  const [fresh]=await owner.db.select().from(schema.leaveApprovalPolicy).where(eq(schema.leaveApprovalPolicy.id,rule.id));expect(fresh).toMatchObject({companyId:b.companyId,departmentId:b.deptB,ruleName:'Fictional Captured Rule',levels:['hr_admin']});const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,rule.id));expect(JSON.stringify(events)).toContain('Fictional captured reason');expect(JSON.stringify(events)).not.toContain('retargeted');
 });
});
