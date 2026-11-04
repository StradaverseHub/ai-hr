/** Explicit real app-reader profile. Empty queues must not enumerate unrelated personnel. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {pendingProfileTaskMetadata} from '../../core/profile';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
const file='test/performance/profile-empty-task-plan.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);afterAll(closeAll);
it.skipIf(!requested)('profiles an empty profile-approval queue beside five hundred native employments',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b),count=500;
 const people=randomUUID().slice(0,24),employments=randomUUID().slice(0,24);
 await owner.client.begin(async tx=>{
  await tx`insert into person(id,tenant_id,full_name,primary_email)select (${people}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,'Fictional empty-queue Personnel '||n,(${people}||n)||'@example.invalid'from generate_series(1,${count}::integer)n`;
  await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on)select (${employments}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${people}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,'EMPTY'||lpad(n::text,6,'0'),'2020-01-01'::date from generate_series(1,${count}::integer)n`;
  await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)select ${b.tenantId}::uuid,(${employments}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,${b.deptA}::uuid,'full_time','2020-01-01'::date from generate_series(1,${count}::integer)n`;
 });
 // Match the system fixture's populated-table statistics first. Then analyze the empty queue
 // separately, to distinguish stale/default statistics from an intrinsically wasteful plan.
 for(const table of ['person','employment','assignment','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
 const [sizes]=await owner.client`select(select count(*)::int from employment where tenant_id=${b.tenantId}::uuid)as employments,(select count(*)::int from profile_change_request where tenant_id=${b.tenantId}::uuid and status='pending')as pending`;
 expect(sizes).toEqual({employments:count,pending:0});
 const observations:unknown[]=[];
 for(const statistics of ['system-fixture','analyzed-empty-queue']){
 if(statistics==='analyzed-empty-queue')await owner.client.unsafe('analyze profile_change_request');
 const [relation]=await owner.client`select reltuples::integer as estimated_rows from pg_class where oid='public.profile_change_request'::regclass`;
 for(const companyIds of [undefined,[b.companyId],[]]){
  const samples:number[]=[];
  for(let round=0;round<7;round++){
   const began=performance.now();expect(await pendingProfileTaskMetadata(ctx,companyIds)).toEqual([]);samples.push(performance.now()-began);
  }
  const sorted=[...samples].sort((a,b)=>a-b);observations.push({statistics,estimatedRows:relation.estimated_rows,scope:companyIds===undefined?'all':companyIds.length?'company':'empty',samplesMs:samples,medianMs:sorted[3],exactEmpty:true});
 }
 }
 expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
 writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'profile-empty-task-plan.json'),JSON.stringify({kind:'EMPTY_PROFILE_TASK_QUERY_COMPONENT_ONLY',releaseEligible:false,employments:count,pending:0,observations,limitations:'Synthetic native retained fixture and actual public app reader; not500-user acceptance or a nonempty decision-authority test.'},null,2));
},120000);
