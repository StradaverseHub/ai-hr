/** TEMPORARY profiling probe (ADR 0181 J2, imports): where a staged employee import's time goes, per row, at the
 * shape of a real group (70 companies, 1,000 employments). Not for merge; it is removed before the PR. */
import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {client} from '../db/client';
import {createEmployeeImportJob} from '../core/employee-import-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {employeeImportJobHandler} from '../core/employee-import-worker';
import {sql} from 'drizzle-orm';
import type {EmployeeImportUploadInput} from '../core/employee-import-upload';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase} from './harness';

const COMPANIES=70,EMPLOYMENTS=1000,ROWS=60;
const csv=(rows:Record<string,string>[])=>{const h=Object.keys(rows[0]);return [h.join(','),...rows.map(r=>h.map(k=>r[k]).join(','))].join('\n')+'\n';};

beforeAll(async()=>{await migrateTestDb();await resetDb();});
afterAll(closeAll);

const original=employeeImportJobHandler.beginChunkTx!;
for(const variant of [{name:'trace',marker:true,budget:1000}])
it(`profiles a staged employee import at the shape of a 70-company group: ${variant.name}`,async()=>{
 employeeImportJobHandler.chunkBudgetMs=variant.budget;
 employeeImportJobHandler.beginChunkTx=async(tx,c,j)=>{await original(tx,c,j);if(variant.marker)await tx.execute(sql`select set_config('app.bank_import_point_read','on',true)`);};
 const base=await seedBase();const ctx=await entitledCtx(base);
 const others=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) select ${base.tenantId}::uuid,'Profile shape company '||n from generate_series(1,${COMPANIES-1}::integer)n returning id`;
 await owner.client`with people as(insert into person(tenant_id,full_name,primary_email) select ${base.tenantId}::uuid,'Profile shape person '||n,'profile-shape-'||n||'@fixture.invalid' from generate_series(1,${EMPLOYMENTS}::integer)n returning id),ranked as(select id,row_number()over(order by id)::int as n from people)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${base.tenantId}::uuid,id,(${others.map(r=>r.id)}::uuid[])[1+((n-1)%${COMPANIES-1}::integer)],'PROFILE-SHAPE-'||lpad(n::text,4,'0'),'2025-01-01'::date from ranked`;
 const rows=Array.from({length:ROWS},(_,i)=>({employee_code:`PRF${String(i).padStart(4,'0')}`,full_name:`Profile Person ${i}`,email:`profile-${i}@fixture.test`,department:'Finance',hired_on:'2026-03-02',employment_type:'full_time',basic_salary:String(2500+i),ic_number:`880101140${String(i).padStart(3,'0')}`}));
 const text=csv(rows);
 const input:EmployeeImportUploadInput={companyId:base.companyId,csv:text,fileName:'profile.csv',dependentsCsv:'',registers:{},allocationsCsv:''};
 let trackFunctions=false;
 try{await owner.client.unsafe(`alter system set track_functions='pl'`);await owner.client`select pg_reload_conf()`;await new Promise(r=>setTimeout(r,300));trackFunctions=true;}catch(error){console.info('EMPLOYEE_IMPORT_PROFILE track_functions unavailable',String(error).slice(0,200));}
 const options=(client as unknown as {options:{debug?:unknown}}).options,previous=options.debug;
 const ownerOptions=(owner.client as unknown as {options:{debug?:unknown}}).options,ownerPrevious=ownerOptions.debug;
 const sent:{at:number;text:string;who:'app'|'owner'}[]=[];
 const functionsBefore=trackFunctions?await owner.client<{f:string;calls:number;total:number;self:number}[]>`select schemaname||'.'||funcname as f,calls::int,total_time::float8 as total,self_time::float8 as self from pg_stat_user_functions`:[];
 options.debug=(_c:number,t:string)=>{sent.push({at:performance.now(),text:t,who:'app'});};
 ownerOptions.debug=(_c:number,t:string)=>{sent.push({at:performance.now(),text:t,who:'owner'});};
 const started=performance.now();const cpu=process.cpuUsage();
 let jobId='';
 try{
  const job=await createEmployeeImportJob(ctx,input,{name:'profile.csv',content:Buffer.from(text),operationKey:randomUUID()});
  if(!('job' in job))throw new Error('replay');jobId=job.job.id;
  for(let i=0;i<20000;i++){
   const [j]=await owner.client<{state:string}[]>`select state from bulk_job where id=${jobId}::uuid`;
   if(['completed','failed','cancelled'].includes(j.state))break;
   if(!await runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS}))await new Promise(r=>setTimeout(r,20));
  }
 }finally{options.debug=previous;ownerOptions.debug=ownerPrevious;}
 const wall=performance.now()-started,c=process.cpuUsage(cpu),cpuMs=(c.user+c.system)/1000;
 const [job]=await owner.client<{state:string;metrics:Record<string,number>;error:string|null}[]>`select state,metrics,error from bulk_job where id=${jobId}::uuid`;
 const end=performance.now();
 const byText=new Map<string,{n:number;ms:number;who:string}>();
 sent.forEach((s,i)=>{const key=s.text.replace(/\s+/g,' ').trim().slice(0,160);const row=byText.get(key)??{n:0,ms:0,who:s.who};row.n++;row.ms+=(sent[i+1]?.at??end)-s.at;byText.set(key,row);});
 const bookkeeping=/^(begin|commit|rollback|savepoint|release|start transaction)\b/i;
 const functions=trackFunctions?await owner.client<{f:string;calls:number;total:number;self:number}[]>`select schemaname||'.'||funcname as f,calls::int,total_time::float8 as total,self_time::float8 as self from pg_stat_user_functions`:[];
 if(trackFunctions){await owner.client.unsafe(`alter system reset track_functions`);await owner.client`select pg_reload_conf()`;}
 const prior=new Map(functionsBefore.map(f=>[f.f,f]));
 const fnDelta=functions.map(f=>({f:f.f,calls:f.calls-(prior.get(f.f)?.calls??0),totalMs:Math.round(f.total-(prior.get(f.f)?.total??0)),selfMs:Math.round(f.self-(prior.get(f.f)?.self??0))})).filter(f=>f.calls>0);
 const persons=sent.map((x,i)=>[x,i] as const).filter(([x])=>x.who==='app'&&/^insert into "person"/.test(x.text)).map(([,i])=>i);
 const from=persons[20],to=persons[21];
 const seq=sent.slice(from-30,to+5).map((x,i,a)=>`${i+from-30} ${x.who} ${Math.round(((a[i+1]?.at??x.at)-x.at)*100)/100} ${x.text.replace(/\s+/g,' ').slice(0,230)}`);
 console.info('EMPLOYEE_IMPORT_TRACE\n'+seq.join('\n'));
 console.info('EMPLOYEE_IMPORT_PROFILE',variant.name,JSON.stringify({
  rows:ROWS,state:job.state,error:job.error,wallMs:Math.round(wall),cpuMs:Math.round(cpuMs),msPerRow:Math.round(wall/ROWS),
  appStatements:sent.filter(s=>s.who==='app'&&!bookkeeping.test(s.text.trim())).length,ownerStatements:sent.filter(s=>s.who==='owner').length,
  appStatementsPerRow:Math.round(sent.filter(s=>s.who==='app'&&!bookkeeping.test(s.text.trim())).length/ROWS),
  bookkeeping:sent.filter(s=>bookkeeping.test(s.text.trim())).length,
  metrics:job.metrics,
  topByTime:[...byText].sort((a,b)=>b[1].ms-a[1].ms).slice(0,60).map(([t,r])=>({ms:Math.round(r.ms),n:r.n,who:r.who,t})),
  topByCount:[...byText].sort((a,b)=>b[1].n-a[1].n).slice(0,40).map(([t,r])=>({n:r.n,ms:Math.round(r.ms),t})),
  functionsBySelf:[...fnDelta].sort((a,b)=>b.selfMs-a.selfMs).slice(0,60),
  functionsByTotal:[...fnDelta].sort((a,b)=>b.totalMs-a.totalMs).slice(0,30),
 },null,1));
 expect(job.state).toBe('completed');
},900_000);
