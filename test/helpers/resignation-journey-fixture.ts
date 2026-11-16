import {vi} from 'vitest';
import {resignationRuntimeKey} from '../../lib/resignation-runtime-proof';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {adminCtx,createAppUser,owner,seedBase,harnessSnapshot,setModule} from '../harness';
import {setCompensation} from '../../core/comp';
import {hireEmployee} from '../../core/org';
import {v9Defaults} from '../../lib/lifecycle-v9-defaults';
import {submitResignationJourney} from '../../packs/lifecycle/resignation/service';
import {todayInKualaLumpur,addCalendarMonths} from '../../lib/hr-date';
import type {SessionContext} from '../../db/client';
import type {AutomationStep,AutomationWorkflow} from '../../lib/automation/workflow';
/** Real Personnel + native shared workflow fixture; no managed row is forged by the service tests. */
export async function resignationJourneyFixture(opts:{sessionKey?:string;origin?:string;accountOnlyDecisionMaker?:boolean;compensation?:{basicSalary:number;currency:string}}={}){
 vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN',opts.origin??'https://resignation.example.test');vi.stubEnv('AUTH_SESSION_KEY',opts.sessionKey??'a'.repeat(64));await owner.db.execute(sql`insert into app.resignation_runtime_verifier(singleton,secret) values(true,${resignationRuntimeKey(opts.sessionKey??'a'.repeat(64))}) on conflict(singleton) do update set secret=excluded.secret`);
 const base=await seedBase();await setModule(base.tenantId,'lifecycle','active');const setup=adminCtx(base);
 const hire=(name:string)=>hireEmployee(setup,{person:{fullName:name,primaryEmail:`${randomUUID()}@example.test`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 const employee=await hire('Journey employee'),manager=await hire('Journey manager'),fyi=await hire('Journey business partner');
 if(opts.compensation)await setCompensation(setup,{employmentId:employee.employmentId,basicSalary:opts.compensation.basicSalary,currency:opts.compensation.currency,effectiveFrom:'2026-01-01'});
 const employeeUserId=await createAppUser(base.tenantId,employee.personId,'employee'),managerUserId=await createAppUser(base.tenantId,opts.accountOnlyDecisionMaker?null:manager.personId,'hr_admin'),fyiUserId=await createAppUser(base.tenantId,fyi.personId,'employee');
 const ctx=(userId:string,personId:string|null,roles:string[]):SessionContext=>({tenantId:base.tenantId,userId,personId,roles,entitlements:harnessSnapshot(base.tenantId)});
 const staff=ctx(employeeUserId,employee.personId,['employee']),admin=ctx(managerUserId,opts.accountOnlyDecisionMaker?null:manager.personId,['hr_admin']),watcher=ctx(fyiUserId,fyi.personId,['employee']);
 const config=v9Defaults(),groupId=config.peopleOpsGroup??randomUUID();if(!config.groups.some(g=>g.id===groupId))config.groups.push({id:groupId,name:'Journey PeopleOps',members:[],limit:0});config.peopleOpsGroup=groupId;config.groups.find(g=>g.id===groupId)!.members=[managerUserId];
 await owner.db.execute(sql`insert into lc_v9_config(tenant_id,revision,data) values(${base.tenantId}::uuid,${config.revision},${JSON.stringify(config)}::jsonb) on conflict(tenant_id) do update set data=excluded.data,revision=excluded.revision`);
 async function workflow(event:string,steps:AutomationStep[]){const id=randomUUID();const definition:AutomationWorkflow={id,module:'off',name:'Fixture '+event,description:'',status:'live',required:true,trigger:{event,days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps};await owner.db.execute(sql`insert into automation_workflow_version(tenant_id,workflow_id,revision,module,status,required,definition,reason,saved_by) values(${base.tenantId}::uuid,${id}::uuid,1,'off','live',true,${JSON.stringify(definition)}::jsonb,'Authorized test workflow',${managerUserId}::uuid)`);return id;}
 await workflow('submitted',[{id:'decision',type:'requestDecision',conditions:[],to:[{kind:'person',userId:managerUserId}],cc:[],params:{choices:'both',watch:[{kind:'person',userId:fyiUserId}],canComment:true,dueDays:3}}]);
 const lastWorkingDay=addCalendarMonths(todayInKualaLumpur(),3),journey=await submitResignationJourney(staff,{employmentId:employee.employmentId,lastWorkingDay,reason:'A real authorized fixture resignation.'});
 return{base,admin,staff,watcher,employee,manager,fyi,employeeUserId,managerUserId,fyiUserId,config,groupId,journey,lastWorkingDay,workflow};
}
