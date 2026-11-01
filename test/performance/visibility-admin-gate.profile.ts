/** Reversible canonical coarse-admin gate experiment; no permissions or results persist between calls. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('compares mixed-principal visibility and malformed-context outcomes before, during and after a coarse gate',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),base=adminCtx(b);
 const companies=[b.companyId];
 for(let i=1;i<5;i++){const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,country:'MY',legalName:'Fictional gate company '+i}).returning();companies.push(company.id);}
 const users=Array.from({length:500},(_,i)=>({id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),companyId:companies[i%5],role:(i<2?'hr_admin':i===2?'manager':'employee') as 'hr_admin'|'manager'|'employee'}));
 await owner.db.insert(s.person).values(users.map((u,i)=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional gate person '+i,primaryEmail:u.id+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:u.companyId,hiredOn:'2025-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'gate_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map((u,i)=>({tenantId:b.tenantId,appUserId:u.id,role:u.role,companyId:i===1?null:u.companyId})));
 const reports=users.filter((u,i)=>i>2&&u.companyId===users[2].companyId).slice(0,10);
 await owner.db.insert(s.reportingLine).values(reports.map(u=>({tenantId:b.tenantId,managerEmploymentId:users[2].employmentId,subordinateEmploymentId:u.employmentId,lineType:'administrative' as const,validFrom:'2025-01-01'})));
 const [otherPerson]=await owner.db.insert(s.person).values({tenantId:foreign.tenantId,fullName:'Fictional other tenant',primaryEmail:randomUUID()+'@example.invalid'}).returning();
 await owner.db.insert(s.employment).values({tenantId:foreign.tenantId,personId:otherPerson.id,companyId:foreign.companyId,hiredOn:'2025-01-01'});
 for(const table of ['employment','person','app_user','role_assignment','reporting_line'])await owner.client.unsafe('analyze '+table);
 const [roleDefinition]=await owner.client`select pg_get_functiondef('app.grants_have_role_for(jsonb,text,uuid)'::regprocedure)as original,prosrc as body from pg_proc where oid='app.grants_have_role_for(jsonb,text,uuid)'::regprocedure`;
 const cachedRole=`CREATE OR REPLACE FUNCTION app.grants_have_role_for(grants jsonb,wanted_role text,wanted_company uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $role_plan$ BEGIN RETURN (${roleDefinition.body.trim().replace(/;$/,'')}); END; $role_plan$`;
 const [definition]=await owner.client`select pg_get_functiondef('app.visible_employment_ids()'::regprocedure)as original,prosrc as body from pg_proc where oid='app.visible_employment_ids()'::regprocedure`;
 const marker='SELECT DISTINCT e.company_id FROM employment e WHERE e.tenant_id = app.current_tenant_id()';
 expect(definition.body.split(marker)).toHaveLength(2);
 const gated=definition.body.replace('BEGIN',`DECLARE performance_has_admin boolean := false;
BEGIN
 IF EXISTS(SELECT 1 FROM employment WHERE tenant_id=app.current_tenant_id()) THEN
  -- Preserve malformed company-grant errors before short-circuiting their later company checks.
  PERFORM g.company_id FROM app.current_grants() g;
  performance_has_admin := app.is_admin();
 END IF;`).replace(marker,marker+' AND performance_has_admin');
 const ctx=(u:typeof users[number],i:number):SessionContext=>({...base,userId:u.id,personId:u.personId,roles:[u.role],grants:[{role:u.role,companyId:i===1?null:u.companyId}]});
 const phases:Record<string,unknown>={};let baselineErrors:unknown,baselineMatrix:unknown;
 const outcome=async(context:SessionContext,grants:string)=>{
  try{return {ids:(await withTenant(context,async tx=>{await tx.execute(sql`select set_config('app.grants',${grants},true)`);return tx.execute(sql`select app.visible_employment_ids() as ids`);}))[0].ids};}
  catch(error){let cause=error as {code?:string;cause?:unknown};while(cause&&!cause.code)cause=cause.cause as typeof cause;return {error:cause?.code??String(error)};}
 };
 try{
  for(const phase of ['baseline','candidate','candidate-grant-plan','baseline-after']){
   await owner.client.unsafe(phase==='candidate-grant-plan'?cachedRole:roleDefinition.original);
   await owner.client.unsafe(phase.startsWith('candidate')?`CREATE OR REPLACE FUNCTION app.visible_employment_ids() RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $gate$ ${gated} $gate$`:definition.original);
   const started=performance.now(),times:number[]=[];
   const results=await Promise.allSettled(users.map(async(u,i)=>{
    const before=performance.now(),rows=await withTenant(ctx(u,i),tx=>tx.execute(sql`select app.visible_employment_ids() as ids,app.can_admin_payroll_for(${u.companyId}::uuid) as payroll_admin,app.has_role_for('hr_admin',${u.companyId}::uuid) as hr_admin`));
    expect(rows[0].payroll_admin).toBe(i<2);expect(rows[0].hr_admin).toBe(i<2);
    const expected=i===0?users.filter(row=>row.companyId===u.companyId).map(row=>row.employmentId):i===1?users.map(row=>row.employmentId):i===2?[u.employmentId,...reports.map(row=>row.employmentId)]:[u.employmentId];
    expect(rows[0].ids).toEqual(expected.sort());times.push(performance.now()-before);
   }));
   const errors=results.flatMap(result=>result.status==='rejected'?[String(result.reason)]:[]);
   times.sort((a,b)=>a-b);
   const malformed=[await outcome(ctx(users[4],4),JSON.stringify([{role:'employee',companyId:'invalid-uuid'}])),await outcome(ctx(users[4],4),'{broken'),await outcome(adminCtx(foreign),'{broken')];
   if(phase==='baseline')baselineErrors=malformed;else expect(malformed).toEqual(baselineErrors);
   const matrix=[];
   for(const grants of [null,'null','{}','[]',JSON.stringify([{role:'hr_admin',companyId:null}]),JSON.stringify([{role:'hr_admin',companyId:companies[0]}]),JSON.stringify([{role:'employee',companyId:'invalid-uuid'}])]){
    for(const role of ['employee','hr_admin','super_admin'])for(const companyId of [companies[0],companies[1],null]){
     try{const rows=await withTenant(ctx(users[4],4),tx=>tx.execute(sql`select app.grants_have_role_for(${grants}::jsonb,${role},${companyId}::uuid) as value`));matrix.push({value:rows[0].value});}
     catch(error){let cause=error as {code?:string;cause?:unknown};while(cause&&!cause.code)cause=cause.cause as typeof cause;matrix.push({error:cause?.code??String(error)});}
    }
   }
   if(phase==='baseline')baselineMatrix=matrix;else expect(matrix).toEqual(baselineMatrix);
   expect(matrix.some(row=>row.value===true)).toBe(true);expect(matrix.some(row=>row.value===false)).toBe(true);

   phases[phase]={cases:500,elapsedMs:performance.now()-started,p50Ms:times[249],p95Ms:times[474],maxMs:times.at(-1),errors,malformed,grantCases:matrix.length};
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'visibility-admin-gate.json'),JSON.stringify({kind:'REVERSIBLE_VISIBILITY_EXPERIMENT',releaseEligible:false,phases},null,2));
   expect(errors).toEqual([]);
  }
 }finally{await owner.client.unsafe(definition.original);await owner.client.unsafe(roleDefinition.original);}
},90000);
