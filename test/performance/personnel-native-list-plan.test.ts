/** Explicit hosted retained-data diagnosis only; native row triggers/constraints remain enabled. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {personnelListPage} from '../../core/read';
import {withTenant,type SessionContext} from '../../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
const file='test/performance/personnel-native-list-plan.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);afterAll(closeAll);
it.skipIf(!requested)('profiles initial/search/deep Personnel pages with fifty thousand native retained employees',async()=>{
 const count=50_000,started=performance.now();
 const report:Record<string,unknown>={kind:'PERSONNEL_RETAINED_50K_QUERY_COMPONENT_ONLY',releaseEligible:false,targetEmployees:count,concurrentUsers:1,queryTargetMs:1000,fixtureBatchRows:5000,nativeTriggers:'unchanged',limitations:'Retained synthetic owner fixture, not hiring/import throughput, browser timing, one-million Personnel or500-user capacity.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-native-list-plan.json'),JSON.stringify(report,null,2));
 const phase=(name:string)=>{report.phase=name;report.elapsedMs=performance.now()-started;save();};
 const measurements:{mode:string;elapsedMs:number;total:number;pageRows:number;targetMet:boolean}[]=[];
 try{
  expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
  await resetDb();const b=await seedBase(),foreign=await seedBase();
  const ctx:SessionContext={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
  const expectedFirst:string[]=[],expectedLast:string[]=[];
  for(let offset=0;offset<count;offset+=5000){
   const end=offset+5000,personPrefix=randomUUID().slice(0,24),employmentPrefix=randomUUID().slice(0,24);
   report.currentFixtureBatch={from:offset+1,to:end};phase('fixture');
   await owner.client.begin(async tx=>{
    await tx`insert into person(id,tenant_id,full_name,primary_email)
     select (${personPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,
      'Fictional retained Personnel '||lpad(n::text,9,'0'),(${personPrefix}||lpad(n::text,12,'0'))||'@example.invalid'
     from generate_series(${offset+1}::integer,${end}::integer)n`;
    await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on,terminated_on)
     select (${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${personPrefix}||lpad(n::text,12,'0'))::uuid,
      ${b.companyId}::uuid,'PERF'||lpad(n::text,9,'0'),'2020-01-01'::date,
      case when n%5=0 then '2024-01-01'::date else null end from generate_series(${offset+1}::integer,${end}::integer)n`;
    await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
     select ${b.tenantId}::uuid,(${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,
      ${b.deptA}::uuid,'full_time','2020-01-01'::date from generate_series(${offset+1}::integer,${end}::integer)n`;
   });
   if(offset===0)for(let n=1;n<=25;n++)expectedFirst.push(employmentPrefix+String(n).padStart(12,'0'));
   if(end===count)for(let n=count-24;n<=count;n++)expectedLast.push(employmentPrefix+String(n).padStart(12,'0'));
   report.committedFixtureEmployees=end;save();
  }
  const foreignPerson=randomUUID(),foreignEmployment=randomUUID();
  await owner.client`insert into person(id,tenant_id,full_name,primary_email) values(${foreignPerson}::uuid,${foreign.tenantId}::uuid,'Fictional outside Personnel',${foreignPerson+'@example.invalid'})`;
  await owner.client`insert into employment(id,tenant_id,person_id,company_id,hired_on) values(${foreignEmployment}::uuid,${foreign.tenantId}::uuid,${foreignPerson}::uuid,${foreign.companyId}::uuid,'2020-01-01')`;
  for(const table of ['person','employment','assignment','company','department','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
  const [counts]=await owner.client`select (select count(*)::int from employment where tenant_id=${b.tenantId}::uuid) as employees,(select count(*)::int from assignment where tenant_id=${b.tenantId}::uuid)as assignments`;
  expect(counts).toEqual({employees:count,assignments:count});report.retainedCounts=counts;report.fixturePreparationMs=performance.now()-started;
  const [identity]=await withTenant(ctx,tx=>tx.execute<{role:string}>(sql`select current_user as role`));expect(identity.role).toBe('ai_hr_app');
  const companies=[b.companyId,foreign.companyId];
  for(const mode of ['initial','selective-search','deep-page']){
   const q=mode==='selective-search'?'PERF000050000':undefined,offset=mode==='deep-page'?count-25:0;
   phase(mode);const began=performance.now();
   const result=await personnelListPage(ctx,{companyIds:companies,q,limit:25,offset},{companyIds:companies,q});
   const elapsedMs=performance.now()-began,expectedTotal=q?1:count,expectedIds=q?[expectedLast.at(-1)!]:offset?expectedLast:expectedFirst;
   expect(result.total).toBe(expectedTotal);expect(result.headcount.total).toBe(expectedTotal);
   expect(Object.values(result.headcount.byStatus).reduce((sum,value)=>sum+Number(value??0),0)).toBe(expectedTotal);
   expect(result.rows.map(row=>row.employmentId)).toEqual(expectedIds);expect(result.rows.every(row=>row.employmentId!==foreignEmployment)).toBe(true);
   measurements.push({mode,elapsedMs,total:result.total,pageRows:result.rows.length,targetMet:elapsedMs<1000});report.queries=measurements;save();
  }
  phase('measured');
  expect(measurements.every(row=>row.targetMet),'Each observed retained-data Personnel native query under1000ms').toBe(true);
  phase('complete');
 }catch(error){report.errorType=(error as Error).name;phase('failed');throw error;}
 finally{report.queries=measurements;save();}
},600000);
