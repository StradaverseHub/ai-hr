/** Reversible native experiment only: no installed migration or production function changes. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);
it('compares a necessary admin-mapping probe against the installed navigation owner',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');
 const admin=adminCtx(b);
 const staff=await hireEmployee(admin,{person:{fullName:'Fictional navigation employee',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const employee:SessionContext={...admin,userId:await createAppUser(b.tenantId,staff.personId,'employee'),personId:staff.personId,roles:['employee'],grants:undefined};
 await owner.db.execute(sql`insert into company(tenant_id,legal_name)select ${b.tenantId}::uuid,'Fictional navigation company '||n from generate_series(1,4)n`);
 const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');
 const catalog=async()=>owner.db.execute(sql`select p.proowner::text,p.proacl::text,p.prosecdef,p.provolatile,p.proparallel,p.proisstrict,p.proleakproof,p.proconfig,p.prorettype::text,p.proargtypes::text,p.procost,p.prorows from pg_proc p where p.oid='app.probation_navigation_access()'::regprocedure`);
 const metadata=await catalog();
 const [definition]=await owner.db.execute<{ddl:string}>(sql`select pg_get_functiondef('app.probation_navigation_access()'::regprocedure) as ddl`);
 const original=definition.ddl;
 let proposedDefinition=original.replace('DECLARE configuration boolean;participant boolean;intake boolean;','DECLARE configuration boolean;participant boolean;intake boolean;has_admin_mapping boolean;');
 const entry="IF app.probation_active_user() IS NOT TRUE THEN RETURN jsonb_build_object('page',false,'configure',false,'intake',false);END IF;";
 expect(proposedDefinition.split(entry)).toHaveLength(2);
 proposedDefinition=proposedDefinition.replace(entry,entry+"\n SELECT EXISTS(SELECT 1 FROM public.probation_access a WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id() AND a.role='admin') INTO has_admin_mapping;");
 for(const alias of ['c','co']){
  const call='app.probation_config_admin('+alias+'.id)';expect(proposedDefinition.split(call)).toHaveLength(2);
  proposedDefinition=proposedDefinition.replace(call,'CASE WHEN has_admin_mapping THEN '+call+' ELSE false END');
 }
 expect(proposedDefinition).not.toBe(original);
 const proposal=JSON.parse(readFileSync(new URL('./performance/probation-navigation-migration.proposal.json',import.meta.url),'utf8')) as {sql:string};
 const candidate=proposal.sql;
 expect(candidate.split('AS $$')[1].split('$$;')[0]).toBe(proposedDefinition.split('AS $function$')[1]?.split('$function$')[0]??proposedDefinition.split('AS $$')[1].split('$$;')[0]);
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
  // Positive mappings must continue through the canonical admin owner, including expired rows.
  await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) values(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'admin','2020-01-01','Fictional native mapping')`);
  controls.namedAdmin=await compare(admin);expect(controls.namedAdmin).toEqual({page:true,configure:true,intake:true});
  await owner.db.execute(sql`update probation_access set valid_to='2020-01-02' where tenant_id=${b.tenantId}::uuid`);
  controls.expiredAdmin=await compare(admin);
  await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) values(${b.tenantId}::uuid,${employee.userId}::uuid,${b.companyId}::uuid,'admin','2020-01-01','Fictional nonadmin mapping')`);
  controls.nonAdminMapping=await compare(employee);expect(controls.nonAdminMapping).toEqual(controls.employee);
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
  await owner.client.unsafe(original);expect(await catalog()).toEqual(metadata);
  const [restored]=await owner.db.execute<{ddl:string}>(sql`select pg_get_functiondef('app.probation_navigation_access()'::regprocedure) as ddl`);expect(restored.ddl).toBe(original);
 }
 const control=Math.min(measurements[0].elapsedMs,measurements[3].elapsedMs),fast=Math.max(measurements[1].elapsedMs,measurements[2].elapsedMs);
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'probation-navigation-work.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_PROBATION_NAVIGATION_ONLY',releaseEligible:false,companies:5,measurements,controls,improvementRatio:fast/control,ownerAclAndFunctionRestored:true,limitations:'componentonly; no500acceptance; participant/PBP/GBSqualificationstillrequired'},null,2));
 expect(fast,'Both candidate phases must be at least20% faster than the faster native control').toBeLessThan(control*.8);
},600000);
