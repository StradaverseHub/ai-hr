/** Whole-stack review (claude/teras-review): sensitive-topic routing must not be attributable to the person through
 * the outcome record.
 *
 * A turn's outcome record (core/harness/trace-persistence.ts persistTurnTrace) stores storedTrace(trace), which keeps
 * `gate` verbatim, including `reason: 'sensitive_<topic>'`, next to `asked_by_user_id`. RLS on teras_outcome_record
 * (db/migrations/0890, teras_outcome_record_read) lets every group administrator read every record in the tenant. So
 * an HR group administrator can learn that a named employee raised harassment, a health crisis or whistleblowing with
 * the assistant: the routing that was meant to keep the topic away from the product's data writes it into an
 * HR-readable ledger. REVIEW tests fail on the current code; REVIEW pass tests pin what already holds. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../../db/schema';
import {terasOutcomeRecord} from '../../db/teras-schema';
import {withTenant,type SessionContext} from '../../db/client';
import {grantAssistant} from '../../core/assistant-grant';
import {hireEmployee} from '../../core/org';
import {HARNESS_TEST_ONLY,runTurn} from '../../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../../core/harness/memory';
import {persistTurnTrace} from '../../core/harness/trace-persistence';
import {scriptedModel} from '../harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from '../harness';

let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-review-passphrase');await resetDb();base=await seedBase();for(const code of ['assistant','claims'])await setModule(base.tenantId,code,'active');});

async function person(name:string,role:'employee'|'hr_admin',companyId:string|null):Promise<SessionContext>{
 const admin=adminCtx(base);
 const hired=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'review_'+randomUUID(),personId:hired.personId}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,role,companyId});
 await grantAssistant(admin,{appUserId:user.id});
 return{...await entitledCtx(base,[role]),userId:user.id,personId:hired.personId,roles:[role],grants:[{role,companyId}]};
}
async function sensitiveTurn(ctx:SessionContext,question:string){
 const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:randomUUID(),question,scope:{companyId:base.companyId,locale:'en'},
  model:scriptedModel([{final:{reply:'I am sorry this is happening. Please contact HR or the helpline.',mode:'answer'}}]),memory:new InMemoryTaskMemoryStore()});
 await persistTurnTrace(ctx,result.trace,{companyId:base.companyId});
 return result;
}
const recordsOf=(reader:SessionContext,askedBy:string)=>withTenant(reader,tx=>tx.select({trace:terasOutcomeRecord.trace,checks:terasOutcomeRecord.checks,outcome:terasOutcomeRecord.outcome})
 .from(terasOutcomeRecord).where(and(eq(terasOutcomeRecord.tenantId,reader.tenantId),eq(terasOutcomeRecord.askedByUserId,askedBy))));

describe('sensitive routing and the outcome record',()=>{
 it('REVIEW high: a group administrator cannot tell from the outcome record that a named employee raised a sensitive topic',async()=>{
  const employee=await person('Fictional Complainant','employee',null),groupAdmin=await person('Fictional Group HR','hr_admin',null);
  const result=await sensitiveTurn(employee,'My supervisor keeps making sexual comments about me in meetings.');
  // Precondition: the gate did route this turn as a sensitive topic.
  expect(String(result.trace.gate.reason)).toMatch(/^sensitive_/);
  const rows=await recordsOf(groupAdmin,employee.userId!);
  // The finding: the group administrator reads the employee's record, and it names the topic.
  expect(JSON.stringify(rows)).not.toMatch(/sensitive_[a-z_]+/);
 });

 it('REVIEW pass: a company-scoped HR administrator and another employee read nothing of it',async()=>{
  const employee=await person('Fictional Complainant','employee',null),companyAdmin=await person('Fictional Company HR','hr_admin',base.companyId),
   colleague=await person('Fictional Colleague','employee',null);
  await sensitiveTurn(employee,'I am being bullied by two people in my team. What should I do?');
  expect(await recordsOf(companyAdmin,employee.userId!)).toEqual([]);
  expect(await recordsOf(colleague,employee.userId!)).toEqual([]);
  // The person who asked still reads their own record.
  expect((await recordsOf(employee,employee.userId!)).length).toBe(1);
 });
});
