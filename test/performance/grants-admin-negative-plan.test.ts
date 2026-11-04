/** Reversible native pure-predicate experiment, not a migration or user-capacity result. */
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant} from '../../db/client';
import {pgSqlState} from '../../lib/db-error';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('compares an administrator-role necessary precheck while retaining canonical positive scope proofs',async()=>{
 await resetDb();const b=await seedBase(),other=await seedBase(),ctx=adminCtx(b),child=randomUUID(),sibling=randomUUID();
 await owner.client`insert into company(id,tenant_id,legal_name,country,parent_company_id) values
  (${child},${b.tenantId},'Fictional child','MY',${b.companyId}),(${sibling},${b.tenantId},'Fictional sibling','MY',null)`;
 const [original]=await owner.client<{ddl:string;body:string;metadata:unknown}[]>`select pg_get_functiondef(p.oid) as ddl,p.prosrc as body,
  jsonb_build_object('owner',p.proowner,'acl',p.proacl,'securityDefiner',p.prosecdef,'volatility',p.provolatile,'config',p.proconfig,'arguments',p.proargnames) as metadata
  from pg_proc p where p.oid='app.grants_admin_for(jsonb,uuid)'::regprocedure`;
 const companion=async()=>owner.client`select pg_get_functiondef('app.grants_have_role_for(jsonb,text,uuid)'::regprocedure) as role,
  pg_get_functiondef('app.is_admin_for(uuid)'::regprocedure) as current_admin,pg_get_functiondef('app.grants_payroll_admin_for(jsonb,uuid)'::regprocedure) as payroll`;
 const originalCompanion=await companion();
 expect(original.body.trim()).toBe("SELECT app.grants_have_role_for(grants,'hr_admin',wanted_company) OR app.grants_have_role_for(grants,'super_admin',wanted_company)");
 const replacement=`SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(coalesce(grants,'[]'::jsonb)) candidate
  WHERE candidate->>'role' IN ('hr_admin','super_admin')) THEN (${original.body.trim()}) ELSE false END`;
 const candidate=original.ddl.replace(original.body,replacement);expect(candidate).not.toBe(original.ddl);
 const grantCases:unknown[]=[null,[],[{role:'employee',companyId:null}],[{role:'manager',companyId:b.companyId}],
  [{role:'hr_admin',companyId:null}],[{role:'hr_admin',companyId:b.companyId}],[{role:'hr_admin',companyId:child}],
  [{role:'super_admin',companyId:sibling}],[{role:'payroll_partner',companyId:null}],
  [{role:'employee',companyId:null},{role:'hr_admin',companyId:other.companyId}],{},'invalid-json-shape',
  [{role:'employee',companyId:'invalid-company'}],[{role:'hr_admin',companyId:'invalid-company'}],
  [{role:'hr_admin',companyId:''}],[{role:null,companyId:null}]];
 const companies=[b.companyId,child,sibling,other.companyId,randomUUID(),null];
 const matrix=async()=>{
  const results=[];
  for(const grants of grantCases)for(const company of companies){
   const json=grants===null?sql`null::jsonb`:sql`${JSON.stringify(grants)}::jsonb`;
   results.push(await withTenant(ctx,async tx=>{
    await tx.execute(sql`set transaction read only`);
    const [row]=await tx.execute<{allowed:boolean}>(sql`select app.grants_admin_for(${json},${company}::uuid) as allowed`);return {allowed:row.allowed};
   }).catch(error=>({error:pgSqlState(error)??'unknown'})));
  }
  return results;
 };
 const inputs=Array.from({length:500},(_,i)=>({grants:[{role:i%50===0?'hr_admin':i%25===0?'manager':'employee',companyId:i%100===0?null:i%2===0?b.companyId:sibling}],company_id:i%3===0?child:sibling}));
 const measure=async()=>withTenant(ctx,async tx=>{
  await tx.execute(sql`set transaction read only`);const start=performance.now();
  const [row]=await tx.execute<{allowed:number;total:number}>(sql`with inputs as materialized(
   select * from jsonb_to_recordset(${JSON.stringify(inputs)}::jsonb) as input(grants jsonb,company_id uuid))
   select count(*)::int as total,count(*) filter(where app.grants_admin_for(inputs.grants,
    case when repetition.i%2=0 then inputs.company_id else ${b.companyId}::uuid end))::int as allowed
   from inputs cross join generate_series(1,50) repetition(i)`);
  return {...row,elapsedMs:performance.now()-start};
 });
 const report:{kind:string;releaseEligible:boolean;phases:Record<string,unknown>;restored:boolean;benefitObserved?:boolean}={kind:'NATIVE_GRANT_PREDICATE_COMPONENT_ONLY_NOT_500_USERS',releaseEligible:false,phases:{},restored:false};
 let reference:Awaited<ReturnType<typeof matrix>>|undefined;
 try{
  reference=await matrix();const before=await measure();report.phases.original=before;
  expect(before.total).toBe(25000);
  await owner.client.unsafe(candidate);
  const [metadata]=await owner.client<{metadata:unknown}[]>`select jsonb_build_object('owner',p.proowner,'acl',p.proacl,'securityDefiner',p.prosecdef,'volatility',p.provolatile,'config',p.proconfig,'arguments',p.proargnames) as metadata from pg_proc p where p.oid='app.grants_admin_for(jsonb,uuid)'::regprocedure`;
  expect(metadata.metadata).toEqual(original.metadata);expect(await companion()).toEqual(originalCompanion);
  expect(await matrix()).toEqual(reference);
  const proposed=await measure(),warm=await measure();report.phases.candidate=proposed;report.phases.candidateWarm=warm;
  expect(proposed.allowed).toBe(before.allowed);expect(warm.allowed).toBe(before.allowed);
 }finally{
  await owner.client.unsafe(original.ddl);
  const [restored]=await owner.client<{ddl:string}[]>`select pg_get_functiondef('app.grants_admin_for(jsonb,uuid)'::regprocedure) as ddl`;
  report.restored=restored.ddl===original.ddl;expect(report.restored).toBe(true);expect(await companion()).toEqual(originalCompanion);
  if(reference)expect(await matrix()).toEqual(reference);
  report.phases.restored=await measure();
  const before=report.phases.original as {elapsedMs:number}|undefined,after=report.phases.restored as {elapsedMs:number},proposed=report.phases.candidate as {elapsedMs:number}|undefined;
  if(before&&proposed)report.benefitObserved=proposed.elapsedMs<Math.min(before.elapsedMs,after.elapsedMs)*0.85;
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'grants-admin-negative-plan.json'),JSON.stringify({...report,matrixCases:grantCases.length*companies.length,canonicalPositiveOwnerUnchanged:true,originalDefinitionSha256:createHash('sha256').update(original.ddl).digest('hex')},null,2));
 }
},120000);
