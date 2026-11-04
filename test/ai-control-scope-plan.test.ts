/** Reversible AI control scope experiment; native final guards/locks/ACL remain unchanged. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {assertAssignedWorkPrincipalTx} from '../core/approvals';
import {setAiAllowance,setAiFeature} from '../core/ai-management';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('keeps the full native pause-policy audience with bounded visibility candidates',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),base=adminCtx(b);
 const companies=await owner.db.insert(s.company).values(Array.from({length:10},(_,i)=>({tenantId:b.tenantId,country:'MY',legalName:'Fictional role-profile company '+i}))).returning();
 const departments=await owner.db.insert(s.department).values(companies.map(c=>({tenantId:b.tenantId,companyId:c.id,name:'Fictional role-profile department'}))).returning();
 const users=Array.from({length:500},(_,i)=>({index:i,id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),companyId:companies[Math.floor(i/50)].id,departmentId:departments[Math.floor(i/50)].id,
  role:(i%50<2?'hr_admin':i%50===3?'manager':'employee') as 'hr_admin'|'manager'|'employee',expected:i%50<2?'hr_admin':i%50<4?'manager':'employee'}));
 await owner.db.insert(s.person).values(users.map(u=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional Home role '+u.index,primaryEmail:u.id+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:u.companyId,hiredOn:'2025-01-01'})));
 await owner.db.insert(s.assignment).values(users.map(u=>({tenantId:b.tenantId,employmentId:u.employmentId,companyId:u.companyId,departmentId:u.departmentId,employmentType:'full_time' as const,validFrom:'2025-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'home_role_profile_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.id,role:u.role,companyId:u.companyId})));
 await owner.db.insert(s.reportingLine).values(users.filter(u=>u.index%50===2||u.index%50===3).flatMap(manager=>users.filter(u=>u.companyId===manager.companyId&&u.index%50>=4+(manager.index%50-2)*10&&u.index%50<14+(manager.index%50-2)*10).map(u=>({tenantId:b.tenantId,managerEmploymentId:manager.employmentId,subordinateEmploymentId:u.employmentId,lineType:'administrative' as const,validFrom:'2025-01-01'}))));
 for(const table of ['company','department','person','employment','assignment','app_user','role_assignment','reporting_line'])await owner.client.unsafe('analyze '+table);
 const context=(u:typeof users[number]):SessionContext=>({...base,userId:u.id,personId:u.personId,roles:[u.role],grants:[{role:u.role,companyId:u.companyId}]});
 await setModule(b.tenantId,'assistant','active');await setModule(foreign.tenantId,'assistant','active');
 await setAiFeature(base,'hr_assistant',true);await setAiFeature(adminCtx(foreign),'hr_assistant',true);
 const [original]=await owner.client`select pg_get_functiondef(oid)as ddl,to_jsonb(p)-'prosrc' as attributes from pg_proc p where oid='app._ai_control_context(text,boolean)'::regprocedure`;
 const statement="SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}') INTO company_ids FROM company c WHERE c.tenant_id=tid AND(app.is_admin_for(c.id) OR EXISTS(SELECT 1 FROM employment e WHERE e.tenant_id=tid AND e.company_id=c.id AND app.can_see_employment(e.id)));";
 expect(original.ddl).toContain(statement);
 const candidate=original.ddl.replace(statement,`WITH navigation_visible AS MATERIALIZED(SELECT unnest(app.visible_employment_ids())AS id)
 SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}') INTO company_ids FROM company c WHERE c.tenant_id=tid
 AND(app.is_admin_for(c.id) OR EXISTS(SELECT 1 FROM employment e JOIN navigation_visible v ON v.id=e.id
 WHERE e.tenant_id=tid AND e.company_id=c.id AND app.can_see_employment(e.id)));`);
 const check=(ctx:SessionContext)=>withTenant(ctx,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,ctx);
  const [row]=await tx.execute<{allowed:boolean}>(sql`select app.ai_action_unpaused('hr_assistant',false)as allowed`);return row.allowed;
 });
 const actors=[...users.filter(u=>u.index%50===4).map(u=>({ctx:context(u),companyId:u.companyId})),
  ...[users[0],users[2],users[3]].map(u=>({ctx:context(u),companyId:u.companyId})),
  {ctx:base,companyId:'all'},{ctx:adminCtx(foreign),companyId:'foreign'}];
 const measurements:unknown[]=[];
 const measure=async(phase:string)=>{
  const started=performance.now(),matrix:boolean[][]=[];
  for(const company of companies){
   await setAiAllowance(base,{kind:'company',subjectId:company.id,enabled:false,dailyRequests:null,monthlyTokens:null});
   try{
    const row=[];for(const actor of actors){const allowed=await check(actor.ctx);expect(allowed).toBe(actor.companyId!=='all'&&actor.companyId!==company.id);row.push(allowed);}
    matrix.push(row);
   }finally{await setAiAllowance(base,{kind:'company',subjectId:company.id,enabled:true,dailyRequests:null,monthlyTokens:null});}
  }
  measurements.push({phase,elapsedMs:performance.now()-started,reads:actors.length*companies.length,exactAudience:true});return matrix;
 };
 try{
  const expected=await measure('original');
  await owner.client.unsafe(candidate);expect(await measure('candidate')).toEqual(expected);expect(await measure('candidate-warm')).toEqual(expected);
  const [metadata]=await owner.client`select to_jsonb(p)-'prosrc' as attributes from pg_proc p where oid='app._ai_control_context(text,boolean)'::regprocedure`;
  expect(metadata.attributes).toEqual(original.attributes);
  await setAiFeature(base,'hr_assistant',false);expect(await check(context(users[4]))).toBe(false);expect(await check(adminCtx(foreign))).toBe(true);await setAiFeature(base,'hr_assistant',true);
  await setAiAllowance(base,{kind:'user',subjectId:users[4].id,enabled:false,dailyRequests:null,monthlyTokens:null});
  expect(await check(context(users[4]))).toBe(false);expect(await check(context(users[54]))).toBe(true);
  await setAiAllowance(base,{kind:'user',subjectId:users[4].id,enabled:true,dailyRequests:null,monthlyTokens:null});
  const [privateAccess]=await owner.client`select has_function_privilege('ai_hr_app','app._ai_control_context(text,boolean)','EXECUTE')as allowed`;
  expect(privateAccess.allowed).toBe(false);
  const [runs]=await owner.client`select count(*)::int as count from ai_model_run`;expect(runs.count).toBe(0);
  await owner.client.unsafe(original.ddl);expect(await measure('restored')).toEqual(expected);
 }finally{
  await owner.client.unsafe(original.ddl);
  const [restored]=await owner.client`select pg_get_functiondef('app._ai_control_context(text,boolean)'::regprocedure)as ddl`;
  expect(restored.ddl).toBe(original.ddl);
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'ai-control-scope-plan.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_AI_SCOPE_COMPONENT_ONLY',fixturePrincipals:500,companies:10,measurements,restored:restored.ddl===original.ddl,modelCalls:0},null,2));
 }
},480000);
