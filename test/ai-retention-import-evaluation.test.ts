/** Authored UNRUN: raw fictional custody fixtures prove expiry/cascade/rollback, not canonical
 * import execution, actual provider charges or the validity of the synthetic encrypted body. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {aiModelRun,person,employment,assignment,domainEvent,leaveRequest,leaveLedger} from '../db/schema';
import {hireEmployee} from '../core/org';
import {runAiRetentionTick} from '../scripts/ai-retention-runner';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase();await hireEmployee(adminCtx(base),{person:{fullName:'Fictional Retention Graph',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});});afterAll(closeAll);
async function attempt(expired:boolean){
 const id=randomUUID(),runId=randomUUID(),now=Date.now(),created=new Date(now-(expired?31:0)*86400000).toISOString(),expires=new Date(now+(expired?-1:30)*86400000).toISOString();
 await owner.db.execute(sql`insert into public.employee_import_evaluation_attempt(id,tenant_id,user_id,company_id,cohort_id,operation_nonce,mode,binding_ciphertext,created_at,expires_at)
  values(${id}::uuid,${base.tenantId}::uuid,${base.adminUserId}::uuid,${base.companyId}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid,'assisted','synthetic-custody-not-a-canonical-receipt',${created}::timestamptz,${expires}::timestamptz)`);
 await owner.db.insert(aiModelRun).values({id:runId,tenantId:base.tenantId,userId:base.adminUserId,featureId:'personnel_import_mapping',operation:'draft',provider:'openrouter',model:'fictional/retention',state:'completed',reservedTokens:10,actualTokens:null});
 await owner.db.execute(sql`insert into public.employee_import_evaluation_run_membership(ai_run_id,evaluation_id,evaluation_version,slot,tenant_id,user_id,company_id,header_attempt_id)
  values(${runId}::uuid,${id}::uuid,1,1,${base.tenantId}::uuid,${base.adminUserId}::uuid,${base.companyId}::uuid,${randomUUID()}::uuid)`);
 return{id,runId};
}
async function snapshot(){return{
 attempts:await owner.db.execute(sql`select * from public.employee_import_evaluation_attempt order by id`),
 memberships:await owner.db.execute(sql`select * from public.employee_import_evaluation_run_membership order by ai_run_id`),
 runs:await owner.db.execute(sql`select * from public.ai_model_run order by id`),
 facts:{people:await owner.db.select().from(person).orderBy(person.id),employments:await owner.db.select().from(employment).orderBy(employment.id),assignments:await owner.db.select().from(assignment).orderBy(assignment.id),events:await owner.db.select().from(domainEvent).orderBy(domainEvent.id),requests:await owner.db.select().from(leaveRequest).orderBy(leaveRequest.id),ledger:await owner.db.select().from(leaveLedger).orderBy(leaveLedger.id)}
};}
it('retires only expired comparison custody and its run links, preserving active custody, billing and canonical HR facts',async()=>{
 const expired=await attempt(true),active=await attempt(false),before=await snapshot();expect(before.facts.employments.length).toBeGreaterThan(0);expect(before.facts.events.length).toBeGreaterThan(0);
 expect(await runAiRetentionTick(owner)).toMatchObject({tenants:1,importEvaluations:1,backlog:false});const after=await snapshot();
 expect(after.attempts).toEqual(before.attempts.filter(row=>row.id===active.id));expect(after.memberships).toEqual(before.memberships.filter(row=>row.evaluation_id===active.id));
 expect(after.runs).toEqual(before.runs);expect(after.facts).toEqual(before.facts);expect(after.memberships.some(row=>row.evaluation_id===expired.id)).toBe(false);
 expect(await runAiRetentionTick(owner)).toMatchObject({tenants:0,importEvaluations:0,backlog:false});
});
it('rolls parent and membership retirement back when the enclosing maintenance transaction fails',async()=>{
 await attempt(true);const before=await snapshot();await expect(owner.db.transaction(async tx=>{const {retireExpiredAiCustodyTx}=await import('../core/ai-retention-maintenance');expect(await retireExpiredAiCustodyTx(tx as unknown as import('../db/client').Tx)).toMatchObject({importEvaluations:1});throw Error('fictional maintenance rollback');})).rejects.toThrow('fictional maintenance rollback');expect(await snapshot()).toEqual(before);
});
