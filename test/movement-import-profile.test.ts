/** TEMPORARY profiling probe (ADR 0181 J2, imports): where a movement import job spends its time per employee, at the
 * shape of a real group (70 companies, 1,000 employments). Not for merge. Fictional fixtures only. */
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {client} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {previewMovementUpload} from '../core/movement-import-history';
import {startMovementImportJob} from '../core/movement-import-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {toCsv} from '../lib/csv';
import {todayInKualaLumpur} from '../lib/hr-date';
import {personnelImportLabelResolvers} from '../lib/personnel-import-labels.server';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';

vi.hoisted(()=>{process.env.AUDIT_HASH_CHAIN_ENABLED='true';});
const COMPANIES=70,EMPLOYMENTS=1000,EMPLOYEES=40;
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
const HEADER=['Company ID','Employee ID','Employee Name','Effective Date','Event Type','System Fields','Before','After'];
beforeAll(async()=>{await migrateTestDb();await resetDb();});
afterAll(closeAll);

it('profiles a movement import job at the shape of a 70-company group',async()=>{
 const b=await seedBase(),a=adminCtx(b);
 await owner.db.update(s.company).set({companyLabel:'ACME'}).where(eq(s.company.id,b.companyId));
 const codes:string[]=[];
 for(let i=0;i<EMPLOYEES;i++){
  const code=`MV${String(i).padStart(3,'0')}`;
  const id=(await hireEmployee(a,{person:{fullName:'Fictional mover '+code,primaryEmail:`${code.toLowerCase()}@example.test`},companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:day(-400),employeeCode:code})).employmentId;
  await setCompensation(a,{employmentId:id,basicSalary:3000,effectiveFrom:day(-400)});codes.push(code);
 }
 const others=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) select ${b.tenantId}::uuid,'Move shape company '||n from generate_series(1,${COMPANIES-1}::integer)n returning id`;
 await owner.client`with people as(insert into person(tenant_id,full_name,primary_email) select ${b.tenantId}::uuid,'Move shape person '||lpad(n::text,4,'0'),'move-shape-'||n||'@fixture.invalid' from generate_series(1,${EMPLOYMENTS-EMPLOYEES}::integer)n returning id,full_name),ranked as(select id,row_number()over(order by full_name)::int as n from people)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${b.tenantId}::uuid,id,(${others.map(r=>r.id)}::uuid[])[1+((n-1)%${COMPANIES-1}::integer)],'MVS-'||lpad(n::text,4,'0'),'2025-01-01'::date from ranked`;
 const rows=codes.flatMap((code,i)=>i%2===0?[['ACME',code,'',day(-1),'transfer','departmentId','','Operations']]:[['ACME',code,'',day(-1),'promotion','basicSalary','3000.00',String(3100+i)]]);
 const resolve=personnelImportLabelResolvers[0];
 const preview=await previewMovementUpload(a,{name:'movements.csv',content:Buffer.from(toCsv([HEADER,...rows])),resolve});
 const keys=preview.preview.employees.filter(e=>e.fingerprint).map(e=>e.key!);
 const options=(client as unknown as {options:{debug?:unknown}}).options,previous=options.debug;
 const sent:{at:number;text:string}[]=[];
 options.debug=(_c:number,t:string)=>{sent.push({at:performance.now(),text:t});};
 const started=performance.now();const cpu=process.cpuUsage();let preparedAt=0,finalizingAt=0;let jobId='';
 try{
  const job=await startMovementImportJob(a,{attemptId:preview.attemptId,previewHash:preview.previewHash,employees:keys,acknowledgeExcluded:true,locale:'en',operationKey:randomUUID()});
  if(!('job' in job))throw new Error('already');jobId=job.job.id;
  for(let i=0;i<20000;i++){
   const [j]=await owner.client<{state:string}[]>`select state from bulk_job where id=${jobId}::uuid`;
   if(!preparedAt&&j.state==='running')preparedAt=performance.now();
   if(!finalizingAt&&j.state==='finalizing')finalizingAt=performance.now();
   if(['completed','failed','cancelled'].includes(j.state))break;
   if(!await runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS}))await new Promise(r=>setTimeout(r,20));
  }
 }finally{options.debug=previous;}
 const end=performance.now(),wall=end-started,c=process.cpuUsage(cpu),cpuMs=(c.user+c.system)/1000;
 const [job]=await owner.client<{state:string;metrics:Record<string,number>;error:string|null;counters:Record<string,number>;steps_total:number}[]>`select state,metrics,error,counters,steps_total from bulk_job where id=${jobId}::uuid`;
 const stepSent=sent.filter(s=>s.at>=preparedAt&&(!finalizingAt||s.at<finalizingAt));
 const byText=new Map<string,{n:number;ms:number}>();
 stepSent.forEach((s,i)=>{const key=s.text.replace(/\s+/g,' ').trim().slice(0,160);const row=byText.get(key)??{n:0,ms:0};row.n++;row.ms+=(stepSent[i+1]?.at??end)-s.at;byText.set(key,row);});
 const bookkeeping=/^(begin|commit|rollback|savepoint|release|start transaction)\b/i;
 const statements=stepSent.filter(s=>!bookkeeping.test(s.text.trim())).length;
 console.info('MOVEMENT_IMPORT_PROFILE',JSON.stringify({
  employees:keys.length,steps:job.steps_total,state:job.state,error:job.error,counters:job.counters,wallMs:Math.round(wall),cpuMs:Math.round(cpuMs),
  stepsPhaseMs:Math.round((finalizingAt||end)-preparedAt),stepsPhaseMsPerEmployee:Math.round(((finalizingAt||end)-preparedAt)/Math.max(1,keys.length)),
  stepStatements:statements,stepStatementsPerEmployee:Math.round(statements/Math.max(1,keys.length)),metrics:job.metrics,
  topByTime:[...byText].sort((x,y)=>y[1].ms-x[1].ms).slice(0,30).map(([t,r])=>({ms:Math.round(r.ms),n:r.n,t})),
 },null,1));
 expect(job.state).toBe('completed');
},900_000);
