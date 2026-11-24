/** TEMPORARY profiling probe (ADR 0181 J2, imports): where an Import Clocking Data job spends its time, per employee
 * and per line, on the populated attendance fixture padded to the shape of a real group (70 companies, 1,000
 * employments). Not for merge. Fictional fixtures only. */
import {afterAll,beforeAll,expect,it} from 'vitest';
import {client} from '../db/client';
import {BUILTIN_MAPPING_ID} from '../lib/clocking-file';
import {startClockingImportJob} from '../core/attendance-clocking-import-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {buildAttendanceFixture} from './helpers/attendance-bulk-fixture';
import {closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';

const COMPANIES=70,EMPLOYMENTS=1000,EMPLOYEES=60;
beforeAll(async()=>{await migrateTestDb();await resetDb();});
afterAll(closeAll);

it('profiles a clocking import job at the shape of a 70-company group',async()=>{
 const base=await seedBase();
 const f=await buildAttendanceFixture(base,{employees:EMPLOYEES});
 const others=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) select ${base.tenantId}::uuid,'Clock shape company '||n from generate_series(1,${COMPANIES-1}::integer)n returning id`;
 await owner.client`with people as(insert into person(tenant_id,full_name,primary_email) select ${base.tenantId}::uuid,'Clock shape person '||lpad(n::text,4,'0'),'clock-shape-'||n||'@fixture.invalid' from generate_series(1,${EMPLOYMENTS-EMPLOYEES}::integer)n returning id,full_name),ranked as(select id,row_number()over(order by full_name)::int as n from people)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${base.tenantId}::uuid,id,(${others.map(r=>r.id)}::uuid[])[1+((n-1)%${COMPANIES-1}::integer)],'CLK-'||lpad(n::text,4,'0'),'2025-01-01'::date from ranked`;
 const lines=f.uncodedFile.split('\n').filter(Boolean).length;
 const options=(client as unknown as {options:{debug?:unknown}}).options,previous=options.debug;
 const sent:{at:number;text:string}[]=[];
 options.debug=(_c:number,t:string)=>{sent.push({at:performance.now(),text:t});};
 const started=performance.now();const cpu=process.cpuUsage();let preparedAt=0,finalizingAt=0;let jobId='';
 try{
  const {job}=await startClockingImportJob(f.ctx,{mappingId:BUILTIN_MAPPING_ID,text:f.uncodedFile,fileName:'weeks-1-2.csv',fileBytes:Buffer.byteLength(f.uncodedFile)});jobId=job.id;
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
 const stepsStart=sent.findIndex(s=>s.at>=preparedAt),stepsEnd=sent.findIndex(s=>finalizingAt&&s.at>=finalizingAt);
 const stepSent=sent.slice(stepsStart,stepsEnd<0?undefined:stepsEnd);
 const byText=new Map<string,{n:number;ms:number}>();
 stepSent.forEach((s,i)=>{const key=s.text.replace(/\s+/g,' ').trim().slice(0,200);const row=byText.get(key)??{n:0,ms:0};row.n++;row.ms+=(stepSent[i+1]?.at??end)-s.at;byText.set(key,row);});
 const bookkeeping=/^(begin|commit|rollback|savepoint|release|start transaction)\b/i;
 const statements=stepSent.filter(s=>!bookkeeping.test(s.text.trim())).length;
 const employees=Number(job.counters?.employees??0);
 console.info('CLOCKING_IMPORT_PROFILE',JSON.stringify({
  lines,employees,steps:job.steps_total,state:job.state,error:job.error,counters:job.counters,wallMs:Math.round(wall),cpuMs:Math.round(cpuMs),
  prepareMs:Math.round(preparedAt-started),stepsPhaseMs:Math.round((finalizingAt||end)-preparedAt),finalizeMs:Math.round(end-(finalizingAt||end)),
  stepsPhaseMsPerEmployee:Math.round(((finalizingAt||end)-preparedAt)/Math.max(1,employees)),stepStatements:statements,stepStatementsPerEmployee:Math.round(statements/Math.max(1,employees)*10)/10,
  metrics:job.metrics,
  topByTime:[...byText].sort((a,b)=>b[1].ms-a[1].ms).slice(0,40).map(([t,r])=>({ms:Math.round(r.ms),n:r.n,t})),
 },null,1));
 expect(job.state).toBe('completed');
},900_000);
