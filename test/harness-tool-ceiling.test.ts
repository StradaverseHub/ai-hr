/** The provider tool ceiling, per role, over the real tool provider on fictional data (release merge, coordinator decision
 * of 3 November 2026). lib/ai/teras-harness-policy.ts refuses a model call that declares more than 32 tools, counting
 * final_answer and the inert declaration of a tool an earlier step called but this step does not offer. v21 put an HR
 * administrator's biggest turn at 33; v22 folds main's two page guides into product_guidance. This computes each role's
 * worst case, with every module this suite can switch on, the explainers worker on, the capability catalogue offered and
 * one re-offered history tool, so the next tool that would cross the ceiling fails here instead of in production. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {nativeToolProvider} from '../core/harness/tools';
import {offerFor} from '../core/harness/runner';
import {HARNESS_SPEC} from '../core/harness/spec';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {gateTurn} from '../lib/product-context/request-gate';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

/** The policy's ceiling, read from its own refusal so a change there is a change here. */
const POLICY=readFileSync('lib/ai/teras-harness-policy.ts','utf8');
const CEILING=Number(/if\(tools\.length>(\d+)\)return privatePolicyRefusal\(\);/.exec(POLICY)?.[1]);
/** Every module the capability catalogue suite switches, on: the most tools any caller can be bound. */
const MODULES=['assistant','payroll','attendance','claims','performance','rewards','lifecycle','toil','multi_cycle_payroll','typed_pay_components','country-my','notifications','system_explorer','system_testing'];

let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-ceiling-passphrase');await resetDb();base=await seedBase();
 for(const code of MODULES)await setModule(base.tenantId,code,'active');});

type Grant={role:typeof schema.roleAssignment.$inferInsert['role'];companyId:string|null};
async function person(name:string,grants:readonly Grant[]):Promise<SessionContext>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'user_'+randomUUID(),personId:hired.personId}).returning({id:schema.appUser.id});
 for(const grant of grants)await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId:grant.companyId,role:grant.role});
 await grantAssistant(adminCtx(base),{appUserId:user.id});
 const roles=[...new Set(grants.map(grant=>grant.role))];
 return{...await entitledCtx(base,roles),userId:user.id,personId:hired.personId,roles,grants:[...grants]} as SessionContext;
}

describe('the provider tool ceiling',()=>{
 it('reads the policy ceiling of 32 tools per call',()=>{
  expect(CEILING).toBe(32);
 });
 it('keeps every role\'s biggest turn, with the catalogue, final_answer and one re-offered history tool, within it',async()=>{
  const callers:Record<string,SessionContext>={
   employee:await person('Fictional Ceiling Employee',[{role:'employee',companyId:null}]),
   manager:await person('Fictional Ceiling Manager',[{role:'employee',companyId:null},{role:'manager',companyId:null}]),
   hrAdmin:await person('Fictional Ceiling Admin',[{role:'hr_admin',companyId:base.companyId}]),
   payroll:await person('Fictional Ceiling Payroll',[{role:'employee',companyId:null},{role:'payroll_partner',companyId:base.companyId}]),
   groupAdmin:await person('Fictional Ceiling Group Admin',[{role:'hr_admin',companyId:null}]),
  };
  // Every worker-gated capability offered: the explainers worker on, as a group administrator switches it.
  await setWorkerSwitch(callers.groupAdmin,{workerId:'explainers',enabled:true});
  const gate=gateTurn('How many days of annual leave do I have left?',{sensitive:HARNESS_SPEC.sensitive.topics});
  expect(gate.privateReads&&gate.actions).toBe(true);
  const worst:Record<string,number>={};
  for(const [role,ctx] of Object.entries(callers)){
   const {bindings}=await nativeToolProvider(ctx,{companyId:base.companyId,locale:'en'},true);
   const names=bindings.map(binding=>binding.name);expect(new Set(names).size,role).toBe(names.length);
   // The catalogue offered (capability intent), so nothing bound is held back on an open turn.
   const offered=offerFor(bindings,gate,undefined,true);
   expect(offered.map(binding=>binding.name),role).toContain(HARNESS_SPEC.offer.capabilityTool);
   worst[role]=offered.length+1/* final_answer */+1/* one inert history declaration */;
  }
  console.info('[tool-ceiling]',JSON.stringify(worst));
  for(const [role,count] of Object.entries(worst))expect(count,role+' worst-case tools per call').toBeLessThanOrEqual(CEILING);
  // The administrators carry the most tools; the folded guides are reached through product_guidance, never bound.
  expect(worst.groupAdmin).toBeGreaterThan(worst.employee);
  const {bindings}=await nativeToolProvider(callers.groupAdmin,{companyId:base.companyId,locale:'en'},true);
  expect(bindings.map(binding=>binding.name)).not.toContain('password_policy_guidance');
  expect(bindings.map(binding=>binding.name)).not.toContain('correction_controls_guidance');
 });
});
