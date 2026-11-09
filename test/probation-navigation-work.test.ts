/** Installed native migration with independently frozen predecessor comparison and exact restoration. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);
it('compares a necessary tenant-capability probe against the installed navigation owner',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');
 const admin=adminCtx(b);
 const staff=await hireEmployee(admin,{person:{fullName:'Fictional navigation employee',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const employee:SessionContext={...admin,userId:await createAppUser(b.tenantId,staff.personId,'employee'),personId:staff.personId,roles:['employee'],grants:undefined};
 await owner.db.execute(sql`insert into company(tenant_id,legal_name)select ${b.tenantId}::uuid,'Fictional navigation company '||n from generate_series(1,4)n`);
 const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');
 const catalog=async()=>owner.db.execute(sql`select p.proowner::text,p.proacl::text,p.prosecdef,p.provolatile,p.proparallel,p.proisstrict,p.proleakproof,p.proconfig,p.prorettype::text,p.proargtypes::text,p.procost,p.prorows from pg_proc p where p.oid='app.probation_navigation_access()'::regprocedure`);
 const metadata=await catalog();
 const [definition]=await owner.db.execute<{ddl:string;body:string}>(sql`select pg_get_functiondef(oid) as ddl,prosrc as body from pg_proc where oid='app.probation_navigation_access()'::regprocedure`);
 const predecessorSql=readFileSync(new URL('../db/migrations/2107_probation_module_permission.sql',import.meta.url),'utf8');
 const predecessorBody=predecessorSql.split('CREATE OR REPLACE FUNCTION app.probation_navigation_access()')[1].split('AS $$')[1].split('$$;')[0];
 const original=definition.ddl.replace(definition.body,()=>predecessorBody);
 const candidate=readFileSync(new URL('../db/migrations/2252_probation_navigation_capability_probe.sql',import.meta.url),'utf8');
 expect(definition.body).toBe(candidate.split('AS $$')[1].split('$$;')[0]);
 expect(definition.body).not.toBe(predecessorBody);
 const read=(ctx:SessionContext)=>withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{data:{page:boolean;configure:boolean;intake:boolean}}>(sql`select app.probation_navigation_access() as data`);return row.data;
 });
 const compare=async(ctx:SessionContext)=>{
  await owner.client.unsafe(original);const before=await read(ctx);
  await owner.client.unsafe(candidate);expect(await read(ctx)).toEqual(before);expect(await catalog()).toEqual(metadata);return before;
 };
 const measurements:{phase:string;reads:number;elapsedMs:number}[]=[];
 const controls:Record<string,unknown>={};
 try{
  controls.employee=await compare(employee);expect(controls.employee).toEqual({page:false,configure:false,intake:false});
  controls.groupAdmin=await compare(admin);controls.foreign=await compare(adminCtx(foreign));
  controls.foreignPrincipal=await compare({...adminCtx(foreign),userId:admin.userId});expect(controls.foreignPrincipal).toEqual(controls.employee);
  for(const phase of ['original','candidate','candidate-warm','restored']){
   await owner.client.unsafe(original);
   if(phase==='candidate'||phase==='candidate-warm')await owner.client.unsafe(candidate);
   await read(employee);const began=performance.now();
   for(let index=0;index<50;index++)expect(await read(employee)).toEqual(controls.employee);
   measurements.push({phase,reads:50,elapsedMs:performance.now()-began});
  }
  await owner.db.execute(sql`insert into access_configuration(tenant_id,initialized)
    values(${b.tenantId}::uuid,true) on conflict(tenant_id) do update set initialized=true`);
  // A current tenant capability grant works without any legacy administrator mapping.
  await owner.db.execute(sql`insert into access_user_override(tenant_id,user_id,capability_id,effect)
    values(${b.tenantId}::uuid,${employee.userId}::uuid,'probation.module','allow')`);
  controls.granted=await compare(employee);
  expect(controls.granted).toEqual({page:true,configure:true,intake:true});
  await owner.db.execute(sql`update access_user_override set retired_at=now()
    where tenant_id=${b.tenantId}::uuid and user_id=${employee.userId}::uuid and capability_id='probation.module'`);
  controls.retiredGrant=await compare(employee);expect(controls.retiredGrant).toEqual(controls.employee);
  await owner.db.execute(sql`update app_user set archived_at=now() where id=${employee.userId}::uuid`);
  controls.archived=await compare(employee);
  const forged={...employee,userId:randomUUID()};
  const outcome=async(ddl:string)=>{await owner.client.unsafe(ddl);try{return {value:await read(forged)}}catch{return {refused:true}}};
  controls.forged=await outcome(original);expect(await outcome(candidate)).toEqual(controls.forged);
  await setModule(b.tenantId,'lifecycle','disabled');controls.disabled=await compare(admin);
  await owner.client.unsafe(original);
  const drifts:[string,string][]=[
   ['body',original.replace('DECLARE configuration','-- controlled predecessor drift\nDECLARE configuration')],
   ['volatility','ALTER FUNCTION app.probation_navigation_access() VOLATILE'],
   ['app-execute','REVOKE EXECUTE ON FUNCTION app.probation_navigation_access() FROM ai_hr_app'],
   ['public-execute','GRANT EXECUTE ON FUNCTION app.probation_navigation_access() TO PUBLIC'],
   ['app-grant-option','GRANT EXECUTE ON FUNCTION app.probation_navigation_access() TO ai_hr_app WITH GRANT OPTION'],
   ['configuration','ALTER FUNCTION app.probation_navigation_access() SET search_path=public'],
   ['security','ALTER FUNCTION app.probation_navigation_access() SECURITY INVOKER'],
  ];
  for(const [,ddl]of drifts){
   await expect(owner.client.begin(async tx=>{await tx.unsafe(ddl);await tx.unsafe(candidate);})).rejects.toMatchObject({code:'55000'});
   expect(await catalog()).toEqual(metadata);
  }
  controls.predecessorDriftsRefused=drifts.map(([kind])=>kind);
 }finally{
  await owner.client.unsafe(definition.ddl);expect(await catalog()).toEqual(metadata);
  const [restored]=await owner.db.execute<{ddl:string}>(sql`select pg_get_functiondef('app.probation_navigation_access()'::regprocedure) as ddl`);expect(restored.ddl).toBe(definition.ddl);
 }
 const control=Math.min(measurements[0].elapsedMs,measurements[3].elapsedMs),fast=Math.max(measurements[1].elapsedMs,measurements[2].elapsedMs);
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'probation-navigation-work.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_PROBATION_NAVIGATION_ONLY',releaseEligible:false,companies:5,measurements,controls,improvementRatio:fast/control,ownerAclAndFunctionRestored:true,installedFunctionRestored:true,limitations:'componentonly; no500acceptance; participant/PBP/GBSqualificationstillrequired'},null,2));
 expect(fast,'Both candidate phases must be at least20% faster than the faster native control').toBeLessThan(control*.8);
},600000);
