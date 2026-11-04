/** Installed navigation migration keeps the original native company-policy audience. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {AssignedWorkPrincipalUnavailableError} from '../lib/assigned-work';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {assertAssignedWorkPrincipalTx} from '../core/approvals';
import {setAiAllowance,setAiFeature} from '../core/ai-management';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('keeps the full native pause-policy audience with bounded visibility candidates',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),base:SessionContext={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 const foreignAdmin:SessionContext={...adminCtx(foreign),grants:[{role:'hr_admin',companyId:null}]};
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
 await setAiFeature(base,'hr_assistant',true);await setAiFeature(foreignAdmin,'hr_assistant',true);
 const [installed]=await owner.client`select pg_get_functiondef(oid)as ddl,to_jsonb(p)-'prosrc' as attributes from pg_proc p where oid='app._ai_control_context(text,boolean)'::regprocedure`;
 const statement="SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}') INTO company_ids FROM company c WHERE c.tenant_id=tid AND(app.is_admin_for(c.id) OR EXISTS(SELECT 1 FROM employment e WHERE e.tenant_id=tid AND e.company_id=c.id AND app.can_see_employment(e.id)));";
 const optimized=`WITH navigation_visible AS MATERIALIZED(SELECT unnest(app.visible_employment_ids())AS id)
 SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}') INTO company_ids FROM company c WHERE c.tenant_id=tid
 AND(app.is_admin_for(c.id) OR EXISTS(SELECT 1 FROM employment e JOIN navigation_visible v ON v.id=e.id
 WHERE e.tenant_id=tid AND e.company_id=c.id AND app.can_see_employment(e.id)));`;
 expect(installed.ddl).toContain(optimized);
 const original={...installed,ddl:installed.ddl.replace(optimized,statement)},candidate=installed.ddl;
 const check=(ctx:SessionContext)=>withTenant(ctx,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,ctx);
  const [row]=await tx.execute<{allowed:boolean}>(sql`select app.ai_action_unpaused('hr_assistant',false)as allowed`);return row.allowed;
 });
 const actors=[...users.filter(u=>u.index%50===4).map(u=>({ctx:context(u),companyId:u.companyId})),
  ...[users[0],users[2],users[3]].map(u=>({ctx:context(u),companyId:u.companyId})),
  {ctx:base,companyId:'all'},{ctx:foreignAdmin,companyId:'foreign'}];
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
  await owner.client.unsafe(original.ddl);
  const expected=await measure('original');
  await owner.client.unsafe(candidate);expect(await measure('candidate')).toEqual(expected);expect(await measure('candidate-warm')).toEqual(expected);
  const [metadata]=await owner.client`select to_jsonb(p)-'prosrc' as attributes from pg_proc p where oid='app._ai_control_context(text,boolean)'::regprocedure`;
  expect(metadata.attributes).toEqual(original.attributes);
  await setAiFeature(base,'hr_assistant',false);expect(await check(context(users[4]))).toBe(false);expect(await check(foreignAdmin)).toBe(true);await setAiFeature(base,'hr_assistant',true);
  await setAiAllowance(base,{kind:'user',subjectId:users[4].id,enabled:false,dailyRequests:null,monthlyTokens:null});
  expect(await check(context(users[4]))).toBe(false);expect(await check(context(users[54]))).toBe(true);
  await setAiAllowance(base,{kind:'user',subjectId:users[4].id,enabled:true,dailyRequests:null,monthlyTokens:null});
  const [privateAccess]=await owner.client`select has_function_privilege('ai_hr_app','app._ai_control_context(text,boolean)','EXECUTE')as allowed`;
  expect(privateAccess.allowed).toBe(false);
  const [runs]=await owner.client`select count(*)::int as count from ai_model_run`;expect(runs.count).toBe(0);
  await owner.client.unsafe(original.ddl);expect(await measure('restored')).toEqual(expected);
  // Compare independently expected outcomes under both bodies after scope changes. No cached
  // context or previous truth matrix may stand in for a fresh principal decision.
  const stateChecks:string[]=[];
  const compareState=async(label:string,ctx:SessionContext,expectedAllowed:boolean|'refused')=>{
   for(const ddl of [original.ddl,candidate]){
    await owner.client.unsafe(ddl);
    if(expectedAllowed==='refused')await expect(check(ctx)).rejects.toBeInstanceOf(AssignedWorkPrincipalUnavailableError);
    else expect(await check(ctx)).toBe(expectedAllowed);
   }
   stateChecks.push(label);
  };
  const pause=async(companyId:string,enabled:boolean)=>setAiAllowance(base,{kind:'company',subjectId:companyId,enabled,dailyRequests:null,monthlyTokens:null});
  // The base company has no employments: the admin arm must retain it regardless of candidate IDs.
  await pause(b.companyId,false);
  try{await compareState('empty company remains in group-admin audience',base,false);await compareState('empty foreign company does not affect employee',context(users[4]),true);}
  finally{await pause(b.companyId,true);}
  const endedId=randomUUID();
  await owner.db.insert(s.employment).values({id:endedId,tenantId:b.tenantId,personId:users[4].personId,companyId:companies[9].id,hiredOn:'2010-01-01',terminatedOn:'2015-01-01'});
  await pause(companies[9].id,false);
  try{await compareState('historical own employment retains its company policy',context(users[4]),false);}
  finally{await pause(companies[9].id,true);}
  const [grant]=await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:users[4].id,role:'hr_admin',companyId:companies[1].id}).returning();
  const elevated:SessionContext={...context(users[4]),roles:['employee','hr_admin'],grants:[{role:'employee',companyId:users[4].companyId},{role:'hr_admin',companyId:companies[1].id}]};
  await pause(companies[1].id,false);
  try{
   await compareState('stored extra company grant expands policy audience',elevated,false);
   await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.id,grant.id));
   await compareState('revoked grant refuses stale principal',elevated,'refused');
   await compareState('fresh principal after grant revocation loses extra company',context(users[4]),true);
  }finally{await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.id,grant.id));await pause(companies[1].id,true);}
  await owner.db.update(s.company).set({parentCompanyId:companies[0].id}).where(eq(s.company.id,companies[1].id));
  const [edge]=await owner.db.insert(s.reportingLine).values({tenantId:b.tenantId,managerEmploymentId:users[2].employmentId,subordinateEmploymentId:users[54].employmentId,lineType:'administrative',validFrom:'2025-01-01'}).returning();
  await pause(companies[1].id,false);
  try{
   await compareState('cross-company administrative report expands policy audience',context(users[2]),false);
   await owner.db.delete(s.reportingLine).where(eq(s.reportingLine.id,edge.id));
   await compareState('revoked reporting edge immediately removes company audience',context(users[2]),true);
  }finally{await owner.db.delete(s.reportingLine).where(eq(s.reportingLine.id,edge.id));await owner.db.update(s.company).set({parentCompanyId:null}).where(eq(s.company.id,companies[1].id));await pause(companies[1].id,true);}
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,users[4].id));
  try{await compareState('archived user refuses the previous principal',context(users[4]),'refused');}
  finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,users[4].id));}
  await compareState('foreign tenant refuses forged actor context',{...context(users[4]),tenantId:foreign.tenantId},'refused');
  await compareState('unknown company grant refuses forged principal',{...context(users[4]),grants:[{role:'employee',companyId:randomUUID()}]},'refused');
  const [finalMetadata]=await owner.client`select to_jsonb(p)-'prosrc' as attributes from pg_proc p where oid='app._ai_control_context(text,boolean)'::regprocedure`;
  expect(finalMetadata.attributes).toEqual(original.attributes);
  const [finalRuns]=await owner.client`select count(*)::int as count from ai_model_run`;expect(finalRuns.count).toBe(0);
  measurements.push({phase:'scope-change-contracts',checks:stateChecks,exactAudience:true});

 }finally{
  await owner.client.unsafe(candidate);
  const [restored]=await owner.client`select pg_get_functiondef('app._ai_control_context(text,boolean)'::regprocedure)as ddl`;
  expect(restored.ddl).toBe(candidate);
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'ai-control-navigation-scope.json'),JSON.stringify({kind:'INSTALLED_NATIVE_AI_NAVIGATION_COMPONENT_ONLY',fixturePrincipals:500,companies:10,measurements,restored:restored.ddl===candidate,modelCalls:0},null,2));
 }
},480000);
