/** Reversible Attendance/Payroll candidate experiment. No lock or permission relaxation. */
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {hireEmployee} from '../../core/org';
import {setCompensation} from '../../core/comp';
import {requirePackFor} from '../../localization/registry';
import {createBatch,generatePayslips} from '../../packs/payroll/service';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
const signature='app.attendance_payroll_protection_rows(uuid)';
const previous=`PERFORM b.id FROM payroll_batch b
 WHERE b.tenant_id=subject.tenant_id AND (
  b.company_id=subject.company_id
  OR EXISTS (SELECT 1 FROM assignment a LEFT JOIN department d ON d.id=a.department_id AND d.tenant_id=a.tenant_id
             WHERE a.tenant_id=subject.tenant_id AND a.employment_id=subject.id AND coalesce(a.company_id,d.company_id)=b.company_id)
  OR EXISTS (SELECT 1 FROM payslip ps WHERE app.payroll_history_effective(ps.id) AND ps.tenant_id=subject.tenant_id AND ps.batch_id=b.id AND ps.employment_id=subject.id)
 ) ORDER BY b.id FOR UPDATE;`;
const candidate=`PERFORM b.id FROM payroll_batch b WHERE b.tenant_id=subject.tenant_id AND b.id IN (
 WITH candidate_companies AS MATERIALIZED (
  SELECT subject.company_id AS company_id
  UNION
  SELECT coalesce(a.company_id,d.company_id) FROM assignment a
   LEFT JOIN department d ON d.id=a.department_id AND d.tenant_id=a.tenant_id
   WHERE a.tenant_id=subject.tenant_id AND a.employment_id=subject.id
 ), candidate_batches AS MATERIALIZED (
  SELECT batch.id FROM payroll_batch batch WHERE batch.tenant_id=subject.tenant_id
   AND batch.company_id IN (SELECT company_id FROM candidate_companies)
  UNION
  SELECT ps.batch_id FROM payslip ps WHERE ps.tenant_id=subject.tenant_id
   AND ps.employment_id=subject.id AND app.payroll_history_effective(ps.id)
 ) SELECT id FROM candidate_batches
 ) ORDER BY b.id FOR UPDATE;`;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function catalog(){const [row]=await owner.client`select pg_get_functiondef(oid) as definition,prosrc as body,to_jsonb(p)-'prosrc' as attributes from pg_proc p where oid=${signature}::regprocedure`;return row;}
const code=(error:unknown):string=>{let e=error as {code?:string;cause?:unknown};for(let i=0;e&&i<8;i++){if(e.code)return e.code;e=e.cause as typeof e;}return String(error);};
it('materializes the identical native batch candidate set with exact coverage, locks and attributes',async()=>{
 await resetDb();await owner.client`create extension if not exists pg_stat_statements`;
 const b=await seedBase(),foreign=await seedBase();await setModule(b.tenantId,'payroll','active');const ctx=await entitledCtx(b);
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional protected Payroll subject',primaryEmail:randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 await setCompensation(ctx,{employmentId:hired.employmentId,basicSalary:5000,effectiveFrom:'2020-01-01'});
 await requirePackFor('MY').statutory.set(ctx,{personId:hired.personId,icNumber:'900101019665'});
 const today=todayInKualaLumpur(),prior=new Date(Date.parse(today.slice(0,7)+'-01T12:00:00Z')-86400000).toISOString().slice(0,7),current=today.slice(0,7);
 const processed=await createBatch(ctx,{companyId:b.companyId,payPeriod:prior});await generatePayslips(ctx,{batchId:processed.batchId});
 const companies=[b.companyId];
 for(let i=1;i<5;i++){const [row]=await owner.db.insert(s.company).values({tenantId:b.tenantId,country:'MY',legalName:'Fictional protection company '+i}).returning();companies.push(row.id);}
 const users=Array.from({length:499},(_,i)=>({id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),companyId:companies[i<2?1:i%5],role:(i===0?'hr_admin':i===1?'manager':'employee') as 'hr_admin'|'manager'|'employee'}));
 await owner.db.insert(s.person).values(users.map((u,i)=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional protection person '+i,primaryEmail:u.id+'@example.test'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:u.companyId,hiredOn:'2020-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'protection_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.id,role:u.role,companyId:u.companyId})));
 // Isolate three original membership arms: current company1, historical assignment2 and
 // retained effective payslip in company0 (without an assignment back to company0).
 await owner.client`delete from assignment where employment_id=${hired.employmentId}::uuid`;
 await owner.client`update employment set company_id=${companies[1]}::uuid where id=${hired.employmentId}::uuid`;
 const [historicalDepartment]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:companies[2],name:'Fictional historical protection department'}).returning();
 await owner.db.insert(s.assignment).values({tenantId:b.tenantId,employmentId:hired.employmentId,companyId:companies[2],departmentId:historicalDepartment.id,employmentType:'full_time',validFrom:'2020-01-01',validTo:'2021-01-01'});
 await owner.db.insert(s.reportingLine).values({tenantId:b.tenantId,managerEmploymentId:users[1].employmentId,subordinateEmploymentId:hired.employmentId,lineType:'administrative',validFrom:today});
 const batches:{id:string;companyIndex:number}[]=[{id:processed.batchId,companyIndex:0}];
 for(let index=0;index<companies.length;index++)for(const month of [prior,current]){
  if(index===0&&month===prior)continue;
  const [period]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:companies[index],period:month,status:'open'}).returning();
  const [batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:companies[index],payPeriodId:period.id,payPeriod:month,batchDate:month+'-28',status:'draft'}).returning();batches.push({id:batch.id,companyIndex:index});
 }
 for(const table of ['employment','assignment','payslip','payroll_batch','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
 const original=await catalog();expect(original.body.split(previous)).toHaveLength(2);expect(original.definition.split(previous)).toHaveLength(2);
 const phases:Record<string,unknown>={};let oracle:unknown;
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'attendance-payroll-candidate-work.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_ATTENDANCE_PAYROLL_QUERY_EXPERIMENT',releaseEligible:false,users:500,companies:5,batches:10,originalBodySha256:hash(original.body),phases},null,2));
 const read=(actor:SessionContext)=>withTenant(actor,tx=>tx.execute(sql`select * from app.attendance_payroll_protection(${hired.employmentId}::uuid)`));
 const actor=(u:typeof users[number]):SessionContext=>({...ctx,userId:u.id,personId:u.personId,roles:[u.role],grants:[{role:u.role,companyId:u.companyId}]});
 try{
  for(const phase of ['before','candidate','restored']){
   await owner.client.unsafe(phase==='candidate'?original.definition.replace(previous,candidate):original.definition);
   const actual=await catalog();expect(actual.attributes).toEqual(original.attributes);expect(actual.body).toBe(phase==='candidate'?original.body.replace(previous,candidate):original.body);
   await read(ctx);await owner.client`select pg_stat_statements_reset()`;
   const elapsedMs:number[]=[],rows=[];
   for(let i=0;i<5;i++){const start=performance.now(),result=await read(ctx);elapsedMs.push(performance.now()-start);rows.push([...result]);}
   expect(rows.every(result=>result.length===1&&result[0].batch_id===processed.batchId&&result[0].status==='processed')).toBe(true);
   const statements=await owner.client`select calls,total_exec_time,total_plan_time,left(query,2200) as normalized_query from pg_stat_statements where query not like '%pg_stat_%' order by total_exec_time+total_plan_time desc limit 16`;
   const outcomes=[];
   for(const principal of [ctx,actor(users[0]),actor(users[1]),actor(users[2]),adminCtx(foreign)]){
    try{outcomes.push({rows:[...await read(principal)]});}catch(error){outcomes.push({error:code(error)});}
   }
   // Same complete physical row ownership, including drafts; observe from independent native transactions.
   const locked=await withTenant(ctx,async tx=>{
    await tx.execute(sql`select * from app.attendance_payroll_protection(${hired.employmentId}::uuid)`);
    const result=[];
    for(const batch of batches){let held=false;try{await owner.client.begin(observer=>observer`select id from payroll_batch where id=${batch.id}::uuid for update nowait`);}catch(error){expect(code(error)).toBe('55P03');held=true;}
     expect(held).toBe(batch.companyIndex===1||batch.companyIndex===2||batch.id===processed.batchId);result.push({id:batch.id,held});}
    return result;
   });
   const facts={rows,outcomes,locked};if(oracle===undefined)oracle=facts;else expect(facts).toEqual(oracle);
   phases[phase]={elapsedMs,medianMs:[...elapsedMs].sort((a,b)=>a-b)[2],rows:rows[0],outcomes,locked,attributesIdentical:true,bodySha256:hash(actual.body),statements};save();
  }
 }finally{await owner.client.unsafe(original.definition);expect(await catalog()).toEqual(original);save();}
},240000);
