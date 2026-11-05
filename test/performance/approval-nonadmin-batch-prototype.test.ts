/** Reversible native experiment; no migration or production authorization contract changes. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {assertAssignedWorkPrincipalTx,filterDelegationOrgScopeTx} from '../../core/approvals';
import {AssignedWorkPrincipalUnavailableError} from '../../lib/assigned-work';
import {pgSqlState} from '../../lib/db-error';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
type Header={employment_id:string;person_id:string;employee:string;employee_code:string|null;company_id:string};
it('compares one visible set per non-admin batch against every canonical scalar result',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),base:SessionContext={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
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

 const foreignAdmin:SessionContext={...adminCtx(foreign),grants:[{role:'hr_admin',companyId:null}]};
 const foreignPerson=randomUUID(),foreignEmployment=randomUUID();
 await owner.db.insert(s.person).values({id:foreignPerson,tenantId:foreign.tenantId,fullName:'Fictional foreign approval subject',primaryEmail:foreignPerson+'@example.invalid'});
 await owner.db.insert(s.employment).values({id:foreignEmployment,tenantId:foreign.tenantId,personId:foreignPerson,companyId:foreign.companyId,hiredOn:'2020-01-01'});
 const ended=randomUUID();await owner.db.insert(s.employment).values({id:ended,tenantId:b.tenantId,personId:users[4].personId,companyId:companies[9].id,hiredOn:'2010-01-01',terminatedOn:'2015-01-01'});
 const ids=[...users.map(u=>u.employmentId),ended,foreignEmployment,randomUUID(),users[4].employmentId];
 const [original]=await owner.client<{ddl:string;acl:string|null;owner:string}[]>`select pg_get_functiondef(oid)as ddl,proacl::text as acl,proowner::text as owner from pg_proc where oid='app.delegated_approval_subject(uuid,text,text)'::regprocedure`;
 const [installed]=await owner.client<{ddl:string;acl:string|null;owner:string}[]>`select pg_get_functiondef(oid)as ddl,proacl::text as acl,proowner::text as owner from pg_proc where oid='app.delegated_approval_subjects(uuid[],text,text)'::regprocedure`;
 expect(installed.ddl).toContain('app.delegated_approval_subject');
 const nonAdmin='SELECT c.id FROM candidates c JOIN admin_companies a ON a.company_id=c.company_id WHERE a.allowed IS NOT TRUE';
 const oldTail=` FROM non_admin c JOIN LATERAL app.delegated_approval_subject(c.id,wanted_module,wanted_task) s ON true;`;
 expect(installed.ddl.split(nonAdmin)).toHaveLength(2);expect(installed.ddl.split(oldTail)).toHaveLength(2);
 let candidate=installed.ddl.replace(nonAdmin,'SELECT c.id,c.person_id,c.full_name,c.employee_code,c.company_id FROM candidates c JOIN admin_companies a ON a.company_id=c.company_id WHERE a.allowed IS NOT TRUE');
 candidate=candidate.replace(' )\n SELECT c.id,c.person_id,c.full_name,c.employee_code,c.company_id',` ), visible_set AS MATERIALIZED (
  SELECT app.visible_employment_ids() AS ids WHERE EXISTS(SELECT 1 FROM non_admin)
 ), unseen AS MATERIALIZED (
  SELECT c.id FROM non_admin c CROSS JOIN visible_set v WHERE NOT(c.id=ANY(v.ids))
 )
 SELECT c.id,c.person_id,c.full_name,c.employee_code,c.company_id`);
 const scalarSelect=` UNION ALL\n SELECT c.id,s.person_id,s.employee,s.employee_code,s.company_id\n`;
 expect(candidate.split(scalarSelect)).toHaveLength(2);
 candidate=candidate.replace(scalarSelect,` UNION ALL
 SELECT c.id,c.person_id,c.full_name,c.employee_code,c.company_id FROM non_admin c CROSS JOIN visible_set v WHERE c.id=ANY(v.ids)
`+scalarSelect).replace(oldTail,' FROM unseen c JOIN LATERAL app.delegated_approval_subject(c.id,wanted_module,wanted_task) s ON true;');
 expect(candidate).toContain('FROM non_admin c CROSS JOIN visible_set v WHERE c.id=ANY(v.ids)');
 expect(candidate).toContain('visible_set AS MATERIALIZED');expect(candidate).toContain('FROM unseen c JOIN LATERAL');
 const proposal=JSON.parse(readFileSync(new URL('./approval-nonadmin-batch-migration.proposal.json',import.meta.url),'utf8')) as {sql:string};
 expect(proposal.sql.split('AS $$')[1].split('$$;')[0]).toBe(candidate.split('AS $function$')[1].split('$function$')[0]);
 candidate=proposal.sql;
 const dependencyDefinitions=await owner.client<{identity:string;ddl:string;body:string}[]>`select oid::regprocedure::text as identity,pg_get_functiondef(oid)as ddl,prosrc as body from pg_proc where oid=any(array['app.visible_employment_ids()'::regprocedure,'app.delegated_approval_subject(uuid,text,text)'::regprocedure,'app.can_see_employment(uuid)'::regprocedure])order by 1`;
 const dependencyCatalog=await owner.client`select oid::regprocedure::text as identity,md5(prosrc)as fingerprint,proowner::regrole::text as owner,proacl::text,prosecdef,provolatile,proparallel,proisstrict,proleakproof,proconfig,prorettype::regtype::text,proretset,proargtypes::text,proallargtypes::text,proargmodes::text,proargnames from pg_proc where oid=any(array['app.delegated_approval_subjects(uuid[],text,text)'::regprocedure,'app.visible_employment_ids()'::regprocedure,'app.delegated_approval_subject(uuid,text,text)'::regprocedure,'app.can_see_employment(uuid)'::regprocedure])order by 1`;
 let improvementRatio:number|null=null;


 const measurements:unknown[]=[],controls:string[]=[],subsumptionChecks:{rows:number;elapsedMs:number}[]=[];
 const read=(ctx:SessionContext,batch:boolean,selected=ids,applyOrgFilter=true)=>withTenant(ctx,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,ctx);
  const array=sql`array[${sql.join(selected.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
  const rows=await tx.execute<Header>(batch
   ?sql`select * from app.delegated_approval_subjects(${array},'claims','claims.claim') order by employment_id`
   :sql`with requested as materialized(select distinct unnest(${array}) as id)
      select requested.id as employment_id,header.* from requested
      join lateral app.delegated_approval_subject(requested.id,'claims','claims.claim') header on true order by requested.id`);
  const result=Array.from(rows,row=>({...row}));
  if(batch&&applyOrgFilter){
   const [carrier]=await tx.execute<{isolation:string;read_only:string}>(sql`select current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')as read_only`);
   expect(carrier).toEqual({isolation:'repeatable read',read_only:'on'});
   const began=performance.now(),filtered=await filterDelegationOrgScopeTx(tx,ctx,result,row=>row.employment_id);
   expect(filtered).toEqual(result);subsumptionChecks.push({rows:result.length,elapsedMs:performance.now()-began});
   return filtered;
  }
  return result;
 },{readOnlySnapshot:true});
 const compare=async(label:string,ctx:SessionContext,expected:string[])=>{
  const reference=await read(ctx,false),current=await read(ctx,true);
  expect(reference.map(row=>row.employment_id)).toEqual([...expected].sort());expect(current).toEqual(reference);controls.push(label);
 };
 try{
  await owner.client.unsafe(candidate);
  const all=[...users.map(u=>u.employmentId),ended];
  await compare('group HR',base,all);await compare('company HR',context(users[0]),users.slice(0,50).map(u=>u.employmentId));
  await compare('employee retains active and ended own employment',context(users[4]),[users[4].employmentId,ended]);
  await compare('manager with department authority',context(users[3]),users.slice(0,50).map(u=>u.employmentId));
  await compare('reporting-derived department head',context(users[2]),users.slice(0,50).map(u=>u.employmentId));
  await compare('foreign group sees only its exact own subject',foreignAdmin,[foreignEmployment]);
  const [edge]=await owner.db.insert(s.reportingLine).values({tenantId:b.tenantId,subordinateEmploymentId:users[2].employmentId,managerEmploymentId:users[54].employmentId,lineType:'delegate',validFrom:'2020-01-01',scopeCompanyId:companies[0].id}).returning();
  await compare('one-hop delegate gains labels without Personnel inheritance',context(users[54]),[users[54].employmentId,...users.slice(4,14).map(u=>u.employmentId)]);
  await owner.db.insert(s.reportingLineScope).values({tenantId:b.tenantId,reportingLineId:edge.id,module:'leave',taskType:'leave.application'});
  await compare('wrong module excludes delegated subjects',context(users[54]),[users[54].employmentId]);
  await owner.db.delete(s.reportingLineScope).where(eq(s.reportingLineScope.reportingLineId,edge.id));
  await owner.db.update(s.reportingLine).set({validTo:'2020-01-02'}).where(eq(s.reportingLine.id,edge.id));
  await compare('expired delegation loses every delegated subject',context(users[54]),[users[54].employmentId]);
  await owner.db.update(s.reportingLine).set({supersededAt:new Date()}).where(eq(s.reportingLine.managerEmploymentId,users[2].employmentId));
  await compare('revoked reports remove department authority immediately',context(users[2]),[users[2].employmentId]);
  await owner.db.update(s.reportingLine).set({supersededAt:null}).where(eq(s.reportingLine.managerEmploymentId,users[2].employmentId));
  const stale=context(users[0]);await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,users[0].id));
  for(const batch of [false,true])await expect(read(stale,batch)).rejects.toBeInstanceOf(AssignedWorkPrincipalUnavailableError);
  await compare('fresh principal loses revoked admin grant',{...stale,roles:['employee'],grants:[{role:'employee',companyId:users[0].companyId}]},[users[0].employmentId]);
  await owner.db.update(s.roleAssignment).set({role:'hr_admin'}).where(eq(s.roleAssignment.appUserId,users[0].id));
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,users[4].id));
  for(const batch of [false,true])await expect(read(context(users[4]),batch)).rejects.toBeInstanceOf(AssignedWorkPrincipalUnavailableError);
  await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,users[4].id));
  await expect(read({...context(users[4]),tenantId:foreign.tenantId},true)).rejects.toBeInstanceOf(AssignedWorkPrincipalUnavailableError);
  const oversized=await read(base,true,Array.from({length:1001},()=>users[0].employmentId)).then(()=>null,(error:unknown)=>error);
  expect(pgSqlState(oversized)).toBe('22023');
  expect(await read(base,true,[])).toEqual([]);
  const [access]=await owner.client`select has_function_privilege('ai_hr_app','app.delegated_approval_subjects(uuid[],text,text)','EXECUTE')as app_execute,
   exists(select 1 from pg_proc p cross join lateral aclexplode(p.proacl)a where p.oid='app.delegated_approval_subjects(uuid[],text,text)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE')as public_execute`;
  expect(access).toEqual({app_execute:true,public_execute:false});
  const headerSubjects=users.slice(0,50).filter(u=>u.index!==3).map(u=>u.employmentId);
  for(const phase of ['original','candidate','candidate-warm','restored']){
   await owner.client.unsafe(installed.ddl);
   if(phase==='candidate'||phase==='candidate-warm')await owner.client.unsafe(candidate);
   const started=performance.now();for(let i=0;i<10;i++)expect((await read(context(users[3]),true,headerSubjects,false)).map(row=>row.employment_id)).toEqual([...headerSubjects].sort());
   measurements.push({phase,reads:10,subjectsPerRead:headerSubjects.length,elapsedMs:performance.now()-started});
  }
  await owner.client.unsafe(candidate);
  for(const [phase,applyOrgFilter]of [['header-with-generic-filter',true],['header-native-purpose-only',false],['header-with-generic-filter-warm',true],['header-native-purpose-only-warm',false]]as const){
   const began=performance.now();
   for(let n=0;n<5;n++)expect((await read(context(users[3]),true,headerSubjects,applyOrgFilter)).map(row=>row.employment_id)).toEqual([...headerSubjects].sort());
   measurements.push({phase,reads:5,subjectsPerRead:headerSubjects.length,elapsedMs:performance.now()-began});
  }
  await owner.client.unsafe(installed.ddl);
  const drifts:[string,string][]=[
   ['batch-body',installed.ddl.replace('BEGIN','-- controlled predecessor drift\nBEGIN')],
   ['batch-volatility','ALTER FUNCTION app.delegated_approval_subjects(uuid[],text,text) VOLATILE'],
   ['batch-app-execute','REVOKE EXECUTE ON FUNCTION app.delegated_approval_subjects(uuid[],text,text) FROM ai_hr_app'],
   ['batch-public-execute','GRANT EXECUTE ON FUNCTION app.delegated_approval_subjects(uuid[],text,text) TO PUBLIC'],
   ['batch-grant-option','GRANT EXECUTE ON FUNCTION app.delegated_approval_subjects(uuid[],text,text) TO ai_hr_app WITH GRANT OPTION'],
   ['batch-configuration','ALTER FUNCTION app.delegated_approval_subjects(uuid[],text,text) SET search_path=public'],
  ];
  for(const dependency of dependencyDefinitions)drifts.push([dependency.identity+'-body',dependency.ddl.replace(dependency.body,()=>'\n-- controlled dependency drift\n'+dependency.body)]);
  drifts.push(['visible-security','ALTER FUNCTION app.visible_employment_ids() SECURITY INVOKER'],['scalar-volatility','ALTER FUNCTION app.delegated_approval_subject(uuid,text,text) VOLATILE']);
  for(const [kind,ddl]of drifts){
   await expect(owner.client.begin(async tx=>{await tx.unsafe(ddl);await tx.unsafe(candidate);})).rejects.toMatchObject({code:'55000'});
   const [restored]=await owner.client<{ddl:string;acl:string|null;owner:string}[]>`select pg_get_functiondef(oid)as ddl,proacl::text as acl,proowner::text as owner from pg_proc where oid='app.delegated_approval_subjects(uuid[],text,text)'::regprocedure`;expect(restored).toEqual(installed);
   controls.push('drift-refused:'+kind);
  }
 }finally{
  await owner.client.unsafe(installed.ddl);
  const [after]=await owner.client<{ddl:string;acl:string|null;owner:string}[]>`select pg_get_functiondef(oid)as ddl,proacl::text as acl,proowner::text as owner from pg_proc where oid='app.delegated_approval_subjects(uuid[],text,text)'::regprocedure`;
  expect(after).toEqual(installed);
  const [restored]=await owner.client<{ddl:string;acl:string|null;owner:string}[]>`select pg_get_functiondef(oid)as ddl,proacl::text as acl,proowner::text as owner from pg_proc where oid='app.delegated_approval_subject(uuid,text,text)'::regprocedure`;
  expect(restored).toEqual(original);
  const dependenciesAfter=await owner.client<{identity:string;ddl:string;body:string}[]>`select oid::regprocedure::text as identity,pg_get_functiondef(oid)as ddl,prosrc as body from pg_proc where oid=any(array['app.visible_employment_ids()'::regprocedure,'app.delegated_approval_subject(uuid,text,text)'::regprocedure,'app.can_see_employment(uuid)'::regprocedure])order by 1`;expect(dependenciesAfter).toEqual(dependencyDefinitions);
  if(measurements.length>=4){const m=measurements as {elapsedMs:number}[];improvementRatio=Math.max(m[1].elapsedMs,m[2].elapsedMs)/Math.min(m[0].elapsedMs,m[3].elapsedMs);}
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'approval-nonadmin-batch-prototype.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_NONADMIN_BATCH_PROTOTYPE_ONLY',releaseEligible:false,improvementRatio,dependencyCatalog,fixturePrincipals:500,controls,measurements,subsumptionChecks,proofSnapshot:'native REPEATABLE READ READ ONLY',canonicalScalarUnchanged:true,installedDefinitionRestored:true,productMigrationAllocated:false},null,2));
 }
 if(improvementRatio!==null)expect(improvementRatio,'Both candidate phases must improve at least20% against the faster control').toBeLessThan(.8);
},600000);
