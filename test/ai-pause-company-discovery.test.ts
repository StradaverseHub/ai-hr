/** Reversible pause-only discovery experiment. All native scope/pause owners remain authoritative. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
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
it('compares necessary company discovery for actual pause checks without changing policy audiences',async()=>{
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
 // Compare semantic defaults as well as every other pg_proc attribute; AST source offsets
 // necessarily move when pg_get_functiondef is executed again. Never omit default semantics.
 const [installed]=await owner.client<{ddl:string;attributes:Record<string,unknown>}[]>`select pg_get_functiondef(oid)as ddl,(to_jsonb(p)-'prosrc'-'proargdefaults')||jsonb_build_object('proargdefaults',pg_get_expr(p.proargdefaults,0)) as attributes from pg_proc p where oid='app.ai_action_unpaused(text,boolean)'::regprocedure`;
 const [contextOwner]=await owner.client<{body:string;ddl:string;attributes:Record<string,unknown>;owner:string}[]>`select prosrc as body,pg_get_functiondef(oid)as ddl,(to_jsonb(p)-'prosrc'-'proargdefaults')||jsonb_build_object('proargdefaults',pg_get_expr(p.proargdefaults,0))as attributes,proowner::regrole::text as owner from pg_proc p where oid='app._ai_control_context(text,boolean)'::regprocedure`;
 const helper='app._ai_control_context_for_purpose';
 const [helperDefinition]=await owner.client<{ddl:string;owner:string;acl:unknown}[]>`select pg_get_functiondef(oid)as ddl,proowner::regrole::text as owner,proacl as acl from pg_proc where oid='app._ai_control_context_for_purpose(text,boolean,boolean)'::regprocedure`;
 expect(helperDefinition.owner).toBe(contextOwner.owner);
 const contextSource=readFileSync('db/migrations/2131_ai_read_only_metadata_locks.sql','utf8');
 const contextStart=contextSource.indexOf('CREATE OR REPLACE FUNCTION app._ai_control_context(');
 const legacyContext=contextSource.slice(contextStart,contextSource.indexOf('$$;',contextStart)+3);
 const actionSource=readFileSync('db/migrations/0621_ai_action_controls.sql','utf8');
 const actionStart=actionSource.indexOf('CREATE FUNCTION app.ai_action_unpaused(');
 const legacyAction=actionSource.slice(actionStart,actionSource.indexOf('$$;',actionStart)+3).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
 const original={...installed,ddl:legacyAction},candidate=installed.ddl;
 expect(candidate).not.toBe(original.ddl);
 const installAction=async(ddl:string)=>{
  await owner.client.unsafe(ddl===candidate?contextOwner.ddl:legacyContext);
  await owner.client.unsafe(ddl);
 };
 const check=(ctx:SessionContext,readOnly=false)=>withTenant(ctx,async tx=>{
  if(readOnly)await tx.execute(sql`set transaction read only`);
  await assertAssignedWorkPrincipalTx(tx,ctx);
  const [row]=await tx.execute<{allowed:boolean}>(sql`select app.ai_action_unpaused('hr_assistant',false)as allowed`);return row.allowed;
 });
 const actors=[...users.filter(u=>u.index%50===4).map(u=>({ctx:context(u),companyId:u.companyId})),
  ...[users[0],users[2],users[3]].map(u=>({ctx:context(u),companyId:u.companyId})),
  {ctx:base,companyId:'all'},{ctx:foreignAdmin,companyId:'foreign'}];
 const measurements:unknown[]=[];
 const unpausedMeasurements:unknown[]=[];
 const fullScopes=new Map<string,unknown>();
 const measureUnpaused=async(phase:string)=>{
  const [disabled]=await owner.client`select count(*)::int as count from ai_control_policy where tenant_id=${b.tenantId}::uuid and kind='company'and not enabled`;expect(disabled.count).toBe(0);
  for(const [i,actor]of actors.entries()){
   const scope=await owner.withTenant(actor.ctx,tx=>tx.execute(sql`select company_ids,feature_paused from app._ai_control_context('hr_assistant',false)`));
   if(phase==='original')fullScopes.set(String(i),Array.from(scope));else expect(Array.from(scope)).toEqual(fullScopes.get(String(i)));
  }
  const start=performance.now();for(let i=0;i<150;i++)expect(await check(actors[i%actors.length].ctx)).toBe(true);
  unpausedMeasurements.push({phase,reads:150,elapsedMs:performance.now()-start,exactUnpaused:true});
 };

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
  const [helperProperties]=await owner.client`select proowner::regrole::text as owner,has_function_privilege('ai_hr_app',oid,'EXECUTE')as app_execute,
   exists(select 1 from aclexplode(proacl)where grantee=0 and privilege_type='EXECUTE')as public_execute from pg_proc where oid=${helper+'(text,boolean,boolean)'}::regprocedure`;
  expect(helperProperties).toEqual({owner:contextOwner.owner,app_execute:false,public_execute:false});
  await installAction(original.ddl);
  const expected=await measure('original');await measureUnpaused('original');
  await installAction(candidate);expect(await measure('candidate')).toEqual(expected);await measureUnpaused('candidate');expect(await measure('candidate-warm')).toEqual(expected);await measureUnpaused('candidate-warm');
  const [metadata]=await owner.client`select (to_jsonb(p)-'prosrc'-'proargdefaults')||jsonb_build_object('proargdefaults',pg_get_expr(p.proargdefaults,0)) as attributes from pg_proc p where oid='app.ai_action_unpaused(text,boolean)'::regprocedure`;
  expect(metadata.attributes).toEqual(original.attributes);
  await setAiFeature(base,'hr_assistant',false);expect(await check(context(users[4]))).toBe(false);expect(await check(foreignAdmin)).toBe(true);await setAiFeature(base,'hr_assistant',true);
  await setAiAllowance(base,{kind:'user',subjectId:users[4].id,enabled:false,dailyRequests:null,monthlyTokens:null});
  expect(await check(context(users[4]))).toBe(false);expect(await check(context(users[54]))).toBe(true);
  await setAiAllowance(base,{kind:'user',subjectId:users[4].id,enabled:true,dailyRequests:null,monthlyTokens:null});
  const [privateAccess]=await owner.client`select has_function_privilege('ai_hr_app','app._ai_control_context(text,boolean)','EXECUTE')as allowed`;
  expect(privateAccess.allowed).toBe(false);
  const [runs]=await owner.client`select count(*)::int as count from ai_model_run`;expect(runs.count).toBe(0);
  await installAction(original.ddl);expect(await measure('restored')).toEqual(expected);await measureUnpaused('restored');
  // Compare independently expected outcomes under both bodies after scope changes. No cached
  // context or previous truth matrix may stand in for a fresh principal decision.
  const stateChecks:string[]=[];
  const compareState=async(label:string,ctx:SessionContext,expectedAllowed:boolean|'refused')=>{
   for(const ddl of [original.ddl,candidate]){
    await installAction(ddl);
    for(const readOnly of [false,true]){
     if(expectedAllowed==='refused')await expect(check(ctx,readOnly)).rejects.toBeInstanceOf(AssignedWorkPrincipalUnavailableError);
     else expect(await check(ctx,readOnly)).toBe(expectedAllowed);
    }
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
  await setAiAllowance(base,{kind:'user_default',enabled:false,dailyRequests:null,monthlyTokens:null});
  try{
   await compareState('user default pause still blocks the uncovered actor',context(users[54]),false);
   await compareState('explicit user enable still overrides the default',context(users[4]),true);
   await compareState('another tenant default never applies',foreignAdmin,true);
  }finally{await setAiAllowance(base,{kind:'user_default',enabled:true,dailyRequests:null,monthlyTokens:null});}
  // A policy published while the reader waits must be observed after the same native
  // ai-control barrier. Checking policy absence before acquiring that barrier is unsafe.
  for(const ddl of [original.ddl,candidate]){
   await installAction(ddl);let pending:Promise<boolean>|undefined;
   try{
    await owner.client.begin(async holder=>{
     await holder`select pg_advisory_xact_lock(hashtext('ai-control'),hashtext(${b.tenantId}::text))`;
     const [identity]=await holder<{pid:number}[]>`select pg_backend_pid()as pid`;
     pending=check(context(users[54]),true);void pending.catch(()=>undefined);const deadline=Date.now()+3000;let waiting=false;
     while(Date.now()<deadline){
      const [observed]=await owner.client<{waiting:boolean}[]>`select exists(select 1 from pg_stat_activity a where ${identity.pid}::integer=any(pg_blocking_pids(a.pid))and a.query like '%ai_action_unpaused%')as waiting`;
      if(observed.waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
     }
     expect(waiting).toBe(true);
     const updated=await holder`update ai_control_policy set enabled=false where tenant_id=${b.tenantId}::uuid and kind='company'and subject_id=${companies[1].id}::uuid returning id`;expect(updated).toHaveLength(1);
    });
    expect(await pending).toBe(false);
   }finally{if(pending)await Promise.allSettled([pending]);await pause(companies[1].id,true);}
  }
  stateChecks.push('company pause published while native reader waits is visible after the barrier');
  for(const ddl of [original.ddl,candidate]){
   await installAction(ddl);
   const [defaultCall]=await withTenant(context(users[54]),async tx=>{
    await tx.execute(sql`set transaction read only`);await assertAssignedWorkPrincipalTx(tx,context(users[54]));
    return tx.execute<{allowed:boolean}>(sql`select app.ai_action_unpaused('hr_assistant')as allowed`);
   });
   expect(defaultCall.allowed).toBe(await check(context(users[54]),true));
  }
  stateChecks.push('omitted forced-pause argument retains the canonical false default');
  const [finalMetadata]=await owner.client`select (to_jsonb(p)-'prosrc'-'proargdefaults')||jsonb_build_object('proargdefaults',pg_get_expr(p.proargdefaults,0)) as attributes from pg_proc p where oid='app.ai_action_unpaused(text,boolean)'::regprocedure`;
  expect(finalMetadata.attributes).toEqual(original.attributes);
  const [finalRuns]=await owner.client`select count(*)::int as count from ai_model_run`;expect(finalRuns.count).toBe(0);
  measurements.push({phase:'scope-change-contracts',checks:stateChecks,exactAudience:true});

 }finally{
  await installAction(candidate);
  const [restored]=await owner.client`select pg_get_functiondef('app.ai_action_unpaused(text,boolean)'::regprocedure)as ddl`;
  expect(restored.ddl).toBe(installed.ddl);
  const [unchangedContext]=await owner.client`select pg_get_functiondef(oid)as ddl,(to_jsonb(p)-'prosrc'-'proargdefaults')||jsonb_build_object('proargdefaults',pg_get_expr(p.proargdefaults,0))as attributes from pg_proc p where oid='app._ai_control_context(text,boolean)'::regprocedure`;
  expect(unchangedContext).toEqual({ddl:contextOwner.ddl,attributes:contextOwner.attributes});
  const [sameHelper]=await owner.client`select pg_get_functiondef(oid)as ddl,proowner::regrole::text as owner,proacl as acl from pg_proc where oid='app._ai_control_context_for_purpose(text,boolean,boolean)'::regprocedure`;
  expect(sameHelper).toEqual(helperDefinition);

  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'ai-pause-company-discovery-installed.json'),JSON.stringify({kind:'INSTALLED_AI_PAUSE_DISCOVERY_COMPONENT_ONLY',releaseEligible:false,fixturePrincipals:500,companies:10,measurements,unpausedMeasurements,privateHelperPreserved:true,fullContextValuesIdentical:true,restored:restored.ddl===installed.ddl,modelCalls:0},null,2));
 }
},480000);

it('refuses unreviewed context or action predecessors and rolls every drift probe back',async()=>{
 const [context]=await owner.client<{ddl:string}[]>`select pg_get_functiondef('app._ai_control_context(text,boolean)'::regprocedure)as ddl`;
 const [action]=await owner.client<{ddl:string}[]>`select pg_get_functiondef('app.ai_action_unpaused(text,boolean)'::regprocedure)as ddl`;
 const [helper]=await owner.client<{ddl:string}[]>`select pg_get_functiondef('app._ai_control_context_for_purpose(text,boolean,boolean)'::regprocedure)as ddl`;
 const contextSource=readFileSync('db/migrations/2131_ai_read_only_metadata_locks.sql','utf8'),contextStart=contextSource.indexOf('CREATE OR REPLACE FUNCTION app._ai_control_context(');
 const legacyContext=contextSource.slice(contextStart,contextSource.indexOf('$$;',contextStart)+3);
 const actionSource=readFileSync('db/migrations/0621_ai_action_controls.sql','utf8'),actionStart=actionSource.indexOf('CREATE FUNCTION app.ai_action_unpaused(');
 const legacyAction=actionSource.slice(actionStart,actionSource.indexOf('$$;',actionStart)+3).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
 const precondition=readFileSync('db/migrations/2138_ai_pause_company_discovery.sql','utf8').split('--> statement-breakpoint')[0];
 for(const target of ['context','action']){
  await expect(owner.client.begin(async tx=>{
   await tx.unsafe(legacyContext);await tx.unsafe(legacyAction);
   await tx.unsafe('drop function app._ai_control_context_for_purpose(text,boolean,boolean)');
   const ddl=target==='context'?legacyContext:legacyAction;
   await tx.unsafe(ddl.replace('AS $$',()=> 'AS $$\n-- unreviewed predecessor probe'));
   await tx.unsafe(precondition);
  })).rejects.toMatchObject({code:'55000'});
  const [afterContext]=await owner.client`select pg_get_functiondef('app._ai_control_context(text,boolean)'::regprocedure)as ddl`;
  const [afterAction]=await owner.client`select pg_get_functiondef('app.ai_action_unpaused(text,boolean)'::regprocedure)as ddl`;
  const [afterHelper]=await owner.client`select pg_get_functiondef('app._ai_control_context_for_purpose(text,boolean,boolean)'::regprocedure)as ddl`;
  expect(afterContext).toEqual(context);expect(afterAction).toEqual(action);expect(afterHelper).toEqual(helper);
 }
});
