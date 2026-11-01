/** Reversible necessary-only no-manager/no-HOD fast path; no permission-result cache. */
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
const signature='app.visible_employment_ids()',boundary='  RETURN (\nWITH RECURSIVE';
const prefix=` IF NOT performance_has_admin AND NOT EXISTS (
  SELECT 1 FROM employment me JOIN app_user u ON u.person_id=me.person_id
  WHERE u.id=app.current_user_id() AND me.tenant_id=app.current_tenant_id() AND me.terminated_on IS NULL
   AND EXISTS (SELECT 1 FROM reporting_line rl WHERE rl.manager_employment_id=me.id
    AND rl.line_type='administrative' AND rl.superseded_at IS NULL
    AND rl.valid_from<=current_date AND (rl.valid_to IS NULL OR rl.valid_to>current_date))
 ) THEN
  RETURN (SELECT coalesce(array_agg(e.id ORDER BY e.id),'{}'::uuid[])
   FROM employment e JOIN app_user u ON u.person_id=e.person_id
   WHERE e.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id());
 END IF;
`;
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
async function catalog(){const [row]=await owner.client`select pg_get_functiondef(oid) as definition,prosrc as body,to_jsonb(p)-'prosrc' as attributes from pg_proc p where oid=${signature}::regprocedure`;return row;}
function errorCode(error:unknown){let e=error as {code?:string;cause?:unknown};for(let i=0;e&&i<8;i++){if(e.code)return e.code;e=e.cause as typeof e;}return String(error);}
it('preserves live exact visibility while bypassing empty recursive branches for ordinary employees',async()=>{
 await resetDb();await owner.client`create extension if not exists pg_stat_statements`;
 const b=await seedBase(),foreign=await seedBase(),base=adminCtx(b),today=todayInKualaLumpur();
 const companies=[b.companyId];for(let i=1;i<5;i++){const [co]=await owner.db.insert(s.company).values({tenantId:b.tenantId,country:'MY',legalName:'Fictional visibility company '+i}).returning();companies.push(co.id);}
 const users=Array.from({length:500},(_,i)=>({id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),companyId:companies[i%5],role:(i<2?'hr_admin':i===2?'manager':'employee') as 'hr_admin'|'manager'|'employee'}));
 await owner.db.insert(s.person).values(users.map((u,i)=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional visibility subject '+i,primaryEmail:u.id+'@example.test'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:u.companyId,hiredOn:'2020-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'self_visibility_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map((u,i)=>({tenantId:b.tenantId,appUserId:u.id,role:u.role,companyId:i===1?null:u.companyId})));
 const reports=users.filter((u,i)=>i>2&&i!==7&&u.companyId===users[2].companyId).slice(0,10);
 await owner.db.insert(s.reportingLine).values(reports.map(u=>({tenantId:b.tenantId,managerEmploymentId:users[2].employmentId,subordinateEmploymentId:u.employmentId,lineType:'administrative' as const,validFrom:'2020-01-01'})));
 const next=new Date(Date.parse(today+'T12:00:00Z')+86400000).toISOString().slice(0,10);
 for(const p of [{m:3,s:8,from:'2020-01-01',to:null},{m:4,s:9,from:'2020-01-01',to:null},{m:5,s:10,from:next,to:null},{m:6,s:11,from:'2020-01-01',to:today},{m:7,s:12,from:'2020-01-01',to:null}])await owner.db.insert(s.reportingLine).values({tenantId:b.tenantId,managerEmploymentId:users[p.m].employmentId,subordinateEmploymentId:users[p.s].employmentId,lineType:'administrative',validFrom:p.from,validTo:p.to});
 await owner.db.update(s.employment).set({terminatedOn:'2025-01-01'}).where(eq(s.employment.id,users[7].employmentId));
 const extraId=randomUUID();await owner.db.insert(s.employment).values({id:extraId,tenantId:b.tenantId,personId:users[8].personId,companyId:companies[0],hiredOn:'2020-01-01',terminatedOn:'2025-01-01'});
 const [rootDepartment]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:companies[4],name:'Fictional HOD root'}).returning();
 const [childDepartment]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:companies[4],parentDepartmentId:rootDepartment.id,name:'Fictional HOD child'}).returning();
 await owner.db.insert(s.assignment).values(users.filter(u=>u.companyId===companies[4]).map(u=>({tenantId:b.tenantId,employmentId:u.employmentId,departmentId:u.id===users[4].id?rootDepartment.id:childDepartment.id,companyId:u.companyId,employmentType:'full_time' as const,validFrom:'2020-01-01'})));
 const [foreignPerson]=await owner.db.insert(s.person).values({tenantId:foreign.tenantId,fullName:'Fictional excluded tenant',primaryEmail:randomUUID()+'@example.test'}).returning();
 await owner.db.insert(s.employment).values({tenantId:foreign.tenantId,personId:foreignPerson.id,companyId:foreign.companyId,hiredOn:'2020-01-01'});
 for(const table of ['employment','assignment','department','app_user','role_assignment','reporting_line'])await owner.client.unsafe('analyze '+table);
 const ctx=(i:number):SessionContext=>({...base,userId:users[i].id,personId:users[i].personId,roles:[users[i].role],grants:[{role:users[i].role,companyId:i===1?null:users[i].companyId}]});
 const expected=(i:number)=>{
  if(i===0)return [...users.filter(u=>u.companyId===companies[0]).map(u=>u.employmentId),extraId].sort();
  if(i===1)return [...users.map(u=>u.employmentId),extraId].sort();
  if(i===2)return [users[i].employmentId,...reports.map(u=>u.employmentId)].sort();
  if(i===3)return [users[3].employmentId,users[8].employmentId].sort();
  if(i===4)return users.filter(u=>u.companyId===companies[4]).map(u=>u.employmentId).sort();
  return (i===8?[users[8].employmentId,extraId]:[users[i].employmentId]).sort();
 };
 const read=(i:number)=>withTenant(ctx(i),async tx=>{const [row]=await tx.execute<{ids:string[]}>(sql`select app.visible_employment_ids() as ids`);expect(row.ids).toEqual(expected(i));return row.ids;});
 const malformed=async(context:SessionContext,grants:string)=>{try{return {ids:await withTenant(context,async tx=>{await tx.execute(sql`select set_config('app.grants',${grants},true)`);const [row]=await tx.execute(sql`select app.visible_employment_ids() as ids`);return row.ids;})};}catch(error){return {error:errorCode(error)};}};
 const original=await catalog();expect(original.body).toContain('performance_has_admin');expect(original.body.split(boundary)).toHaveLength(2);expect(original.definition.split(boundary)).toHaveLength(2);
 const phases:Record<string,unknown>={};let malformedOracle:unknown;
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'self-visibility-work.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_NECESSARY_ONLY_SELF_VISIBILITY_EXPERIMENT',releaseEligible:false,users:500,employments:501,originalBodySha256:hash(original.body),phases},null,2));
 try{
  for(const phase of ['before','candidate','restored']){
   await owner.client.unsafe(phase==='candidate'?original.definition.replace(boundary,prefix+boundary):original.definition);
   const actual=await catalog();expect(actual.attributes).toEqual(original.attributes);expect(actual.body).toBe(phase==='candidate'?original.body.replace(boundary,prefix+boundary):original.body);
   await Promise.all(Array.from({length:20},(_,i)=>read(i)));await owner.client`select pg_stat_statements_reset()`;
   const started=performance.now(),times:number[]=[];
   const outcomes=await Promise.allSettled(users.map(async(_u,i)=>{const start=performance.now();await read(i);times.push(performance.now()-start);}));
   expect(outcomes.flatMap(o=>o.status==='rejected'?[String(o.reason)]:[])).toEqual([]);
   const elapsedMs=performance.now()-started;times.sort((a,b)=>a-b);
   const roleMedians:Record<string,number>={};
   for(const [label,index]of [['ordinary',11],['multiEmployment',8],['manager',2],['employeeManager',3],['HOD',4],['companyHR',0],['groupHR',1]] as const){const samples=[];for(let j=0;j<5;j++){const start=performance.now();await read(index);samples.push(performance.now()-start);}roleMedians[label]=samples.sort((a,b)=>a-b)[2];}
   const bad=[];for(const grants of ['{broken','null',JSON.stringify([{role:'employee',companyId:'invalid-uuid'}])]){bad.push(await malformed(ctx(11),grants),await malformed(adminCtx(foreign),grants));}
   if(malformedOracle===undefined)malformedOracle=bad;else expect(bad).toEqual(malformedOracle);
   const statements=await owner.client`select calls,total_exec_time,total_plan_time,left(query,1800) as normalized_query from pg_stat_statements where query not like '%pg_stat_%' order by total_exec_time+total_plan_time desc limit 16`;
   phases[phase]={mixed500ElapsedMs:elapsedMs,mixed500P95Ms:times[Math.ceil(times.length*.95)-1],roleMedians,malformedOutcomes:bad,exactAll500Sets:true,attributesIdentical:true,bodySha256:hash(actual.body),statements};save();
  }
 }finally{await owner.client.unsafe(original.definition);expect(await catalog()).toEqual(original);save();}
},240000);
