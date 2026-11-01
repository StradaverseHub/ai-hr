/** Reversible native query-plan reuse only: original SQL remains the permission owner. */
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
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
async function catalog(signature:string){const [row]=await owner.client`select pg_get_functiondef(oid) as definition,prosrc as body,to_jsonb(p)-'prosrc' as attributes from pg_proc p where oid=${signature}::regprocedure`;return row;}
function errorCode(error:unknown){let e=error as {code?:string;cause?:unknown};for(let i=0;e&&i<8;i++){if(e.code)return e.code;e=e.cause as typeof e;}return String(error);}
it('profiles plan reuse with live hierarchy, grant, native RLS and malformed-context oracles',async()=>{
 await resetDb();await owner.client`create extension if not exists pg_stat_statements`;
 const b=await seedBase(),foreign=await seedBase(),empty=await seedBase(),base=adminCtx(b),today=todayInKualaLumpur();
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
 const tree:string[]=[];
 for(let i=0;i<3;i++){const [co]=await owner.db.insert(s.company).values({tenantId:b.tenantId,country:'MY',legalName:'Fictional plan tree '+i,parentCompanyId:i?tree[i-1]:null}).returning();tree.push(co.id);}
 const signatures=['app.is_company_descendant(uuid,uuid)','app.is_admin_for(uuid)'];
 const originals=await Promise.all(signatures.map(catalog));
 const candidates=originals.map(original=>{
  expect(original.definition.split('LANGUAGE sql')).toHaveLength(2);
  const body='BEGIN\n RETURN (\n'+original.body.trim().replace(/;$/,'')+'\n );\nEND;';
  return {body,definition:original.definition.replace(original.body,body).replace('LANGUAGE sql','LANGUAGE plpgsql')};
 });
 const [language]=await owner.client`select oid::text as oid from pg_language where lanname='plpgsql'`;
 const phases:Record<string,unknown>={};let malformedOracle:unknown;let restoredInFinally=false;
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'native-plan-reuse-work.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_QUERY_PLAN_EXPERIMENT',releaseEligible:false,measuredPrincipals:500,originals:originals.map((o,i)=>({signature:signatures[i],bodySha256:hash(o.body),attributes:o.attributes})),restoredInFinally,phases},null,2));
 const measure=async(run:()=>Promise<unknown>,calls:number)=>{await run();const times=[];for(let i=0;i<3;i++){const start=performance.now();await run();times.push((performance.now()-start)/calls);}return times.sort((a,b)=>a-b)[1];};
 const hierarchyOracle=async()=>{
  const inputs:[string|null,string|null,boolean][]=[[tree[2],tree[0],true],[tree[2],tree[1],true],[tree[0],tree[2],false],[tree[1],companies[0],false],[tree[2],foreign.companyId,false],[null,tree[0],false],[tree[2],null,false],[null,null,false]];
  const absent=randomUUID();inputs.push([absent,absent,false],[tree[0],tree[0],true]);
  await withTenant(ctx(11),async tx=>{for(const [child,ancestor,expected] of inputs){const [row]=await tx.execute<{result:boolean}>(sql`select app.is_company_descendant(${child}::uuid,${ancestor}::uuid) as result`);expect(row.result).toBe(expected);}});
 };
 const liveOracle=async()=>{
  // Same native app-role transaction/connection: neither changed grants nor changed hierarchy
  // may reuse an earlier permission RESULT. Only executable query plans may survive.
  await withTenant(ctx(11),async tx=>{
   const ask=async()=>{const [row]=await tx.execute<{result:boolean}>(sql`select app.is_admin_for(${tree[2]}::uuid) as result`);return row.result;};
   await tx.execute(sql`select set_config('app.grants',${JSON.stringify([{role:'hr_admin',companyId:tree[0]}])},true)`);expect(await ask()).toBe(true);
   await tx.execute(sql`select set_config('app.grants','[]',true)`);expect(await ask()).toBe(false);
   await tx.execute(sql`select set_config('app.grants',${JSON.stringify([{role:'super_admin',companyId:null}])},true)`);expect(await ask()).toBe(true);
   await tx.execute(sql`select set_config('app.grants',${JSON.stringify([{role:'hr_admin',companyId:tree[0]}])},true)`);
   await owner.db.update(s.company).set({parentCompanyId:null}).where(eq(s.company.id,tree[1]));expect(await ask()).toBe(false);
   await owner.db.update(s.company).set({parentCompanyId:tree[0]}).where(eq(s.company.id,tree[1]));expect(await ask()).toBe(true);
  });
 };
 try{
  for(const phase of ['before','descendant-only','both','admin-only','restored']){
   const enabled=[phase==='descendant-only'||phase==='both',phase==='admin-only'||phase==='both'];
   for(let i=0;i<signatures.length;i++){
    await owner.client.unsafe(enabled[i]?candidates[i].definition:originals[i].definition);
    const actual=await catalog(signatures[i]);expect(actual.attributes).toEqual({...originals[i].attributes,prolang:enabled[i]?language.oid:originals[i].attributes.prolang});expect(actual.body).toBe(enabled[i]?candidates[i].body:originals[i].body);
   }
   await Promise.all(Array.from({length:20},(_,i)=>read(i)));await owner.client`select pg_stat_statements_reset()`;
   const started=performance.now(),times:number[]=[];
   const outcomes=await Promise.allSettled(users.map(async(_u,i)=>{const start=performance.now();await read(i);times.push(performance.now()-start);}));
   expect(outcomes.flatMap(o=>o.status==='rejected'?[String(o.reason)]:[])).toEqual([]);
   const elapsedMs=performance.now()-started;times.sort((a,b)=>a-b);
   const roleMedians:Record<string,number>={};
   for(const [label,index]of [['ordinary',11],['manager',2],['HOD',4],['companyHR',0],['groupHR',1]] as const){roleMedians[label]=await measure(async()=>read(index),1);}
   for(const index of [0,1,2,3,4,7,8,11]){const rows=await withTenant(ctx(index),tx=>tx.execute<{id:string}>(sql`select id from employment where tenant_id=${b.tenantId}::uuid order by id`));expect(rows.map(row=>row.id)).toEqual(expected(index));}
   const microMedians:Record<string,number>={};
   for(const [label,index]of [['ordinary',11],['manager',2],['HOD',4],['companyHR',0],['groupHR',1]] as const){
    microMedians[label]=await measure(()=>withTenant(ctx(index),async tx=>{const [row]=await tx.execute<{total:string}>(sql`select sum(cardinality(app.visible_employment_ids()))::text as total from generate_series(1,200)`);expect(Number(row.total)).toBe(expected(index).length*200);}),200);
   }
   const directMedians:Record<string,number>={};
   directMedians.descendant=await measure(()=>withTenant(ctx(0),async tx=>{const [row]=await tx.execute<{n:number}>(sql`select count(*)::int as n from generate_series(1,5000) g where app.is_company_descendant(case when g%2=0 then ${tree[2]}::uuid else ${tree[1]}::uuid end,${tree[0]}::uuid)`);expect(row.n).toBe(5000);}),5000);
   for(const [label,index]of [['employee',11],['companyHR',0],['groupHR',1]] as const){directMedians['admin-'+label]=await measure(()=>withTenant(ctx(index),async tx=>{const [row]=await tx.execute<{n:number}>(sql`select count(*)::int as n from generate_series(1,5000) g where app.is_admin_for(case when g%2=0 then ${companies[0]}::uuid else ${companies[1]}::uuid end)`);expect(row.n).toBe(index===11?0:index===0?2500:5000);}),5000);}
   await hierarchyOracle();await liveOracle();
   const bad=[];for(const grants of ['{broken','null','{}','[]',JSON.stringify([{role:'employee',companyId:'invalid-uuid'}]),JSON.stringify([{role:'hr_admin',companyId:'invalid-uuid'}])]){bad.push(await malformed(ctx(11),grants),await malformed(adminCtx(foreign),grants),await malformed(adminCtx(empty),grants));}
   if(malformedOracle===undefined)malformedOracle=bad;else expect(bad).toEqual(malformedOracle);
   const statements=await owner.client`select calls,total_exec_time,total_plan_time,left(query,1800) as normalized_query from pg_stat_statements where query not like '%pg_stat_%' order by total_exec_time+total_plan_time desc limit 20`;
   phases[phase]={mixed500ElapsedMs:elapsedMs,mixed500P95Ms:times[Math.ceil(times.length*.95)-1],roleMedians,microMsPerNativeVisibleCall:microMedians,directMsPerNativeCall:directMedians,malformedOutcomes:bad,exactAll500Sets:true,nonLanguageAttributesIdentical:true,liveGrantAndHierarchyChangesObserved:true,statements};save();
  }
 }finally{
  await owner.db.update(s.company).set({parentCompanyId:tree[0]}).where(eq(s.company.id,tree[1]));
  for(let i=signatures.length-1;i>=0;i--){await owner.client.unsafe(originals[i].definition);expect(await catalog(signatures[i])).toEqual(originals[i]);}
  restoredInFinally=true;save();
 }
},240000);
