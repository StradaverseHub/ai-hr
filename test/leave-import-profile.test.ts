/** TEMPORARY profiling probe (ADR 0181 J2, imports): where a leave ledger import job's time goes, per row, at the
 * shape of a real group (70 companies, 1,000 employments). Not for merge. Fictional fixtures only. */
import {afterAll,beforeAll,expect,it} from 'vitest';
import {client} from '../db/client';
import {createLeaveImportJob} from '../core/leave-import-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import type {LeaveImportRecord} from '../lib/leave-import-schema';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase} from './harness';

const COMPANIES=70,EMPLOYMENTS=1000,ROWS=200;

beforeAll(async()=>{await migrateTestDb();await resetDb();});
afterAll(closeAll);

it('profiles a leave ledger import job at the shape of a 70-company group',async()=>{
 const base=await seedBase();const ctx=await entitledCtx(base);
 const others=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) select ${base.tenantId}::uuid,'Profile shape company '||n from generate_series(1,${COMPANIES-1}::integer)n returning id`;
 const all=[base.companyId,...others.map(r=>r.id)];
 await owner.client`with people as(insert into person(tenant_id,full_name,primary_email) select ${base.tenantId}::uuid,'Profile shape person '||n,'profile-shape-'||n||'@fixture.invalid' from generate_series(1,${EMPLOYMENTS}::integer)n returning id,primary_email),ranked as(select id,row_number()over(order by primary_email)::int as n from people)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${base.tenantId}::uuid,id,(${all}::uuid[])[1+((n-1)%${COMPANIES}::integer)],'LV-SHAPE-'||lpad(n::text,4,'0'),'2025-01-01'::date from ranked`;
 // Some existing ledger history, so the per-row duplicate read has rows to look at.
 await owner.client`insert into leave_ledger(tenant_id,employment_id,leave_type_id,entry_type,days,effective_on,reason)
  select ${base.tenantId}::uuid,e.id,${base.annualLeaveTypeId}::uuid,'accrual',14,'2026-01-01'::date,'Fixture grant' from employment e where e.tenant_id=${base.tenantId}::uuid`;
 const records:LeaveImportRecord[]=Array.from({length:ROWS},(_,i)=>({employee_id:`LV-SHAPE-${String(1+(i*7)%EMPLOYMENTS).padStart(4,'0')}`,leave_type:'ANNUAL',transaction_type:'adjustment',days:String(1+(i%5)/4),effective_date:`2026-0${1+(i%6)}-1${i%9}`}));
 const options=(client as unknown as {options:{debug?:unknown}}).options,previous=options.debug;
 const ownerOptions=(owner.client as unknown as {options:{debug?:unknown}}).options,ownerPrevious=ownerOptions.debug;
 const sent:{at:number;text:string;who:'app'|'owner'}[]=[];
 options.debug=(_c:number,t:string)=>{sent.push({at:performance.now(),text:t,who:'app'});};
 ownerOptions.debug=(_c:number,t:string)=>{sent.push({at:performance.now(),text:t,who:'owner'});};
 const started=performance.now();const cpu=process.cpuUsage();
 let jobId='';let preparedAt=0;
 try{
  const job=await createLeaveImportJob(ctx,{records,source:{kind:'paste'}});jobId=job.id;
  for(let i=0;i<20000;i++){
   const [j]=await owner.client<{state:string}[]>`select state from bulk_job where id=${jobId}::uuid`;
   if(!preparedAt&&j.state==='running')preparedAt=performance.now();
   if(['completed','failed','cancelled'].includes(j.state))break;
   if(!await runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS}))await new Promise(r=>setTimeout(r,20));
  }
 }finally{options.debug=previous;ownerOptions.debug=ownerPrevious;}
 const wall=performance.now()-started,c=process.cpuUsage(cpu),cpuMs=(c.user+c.system)/1000;
 const [job]=await owner.client<{state:string;metrics:Record<string,number>;error:string|null;counters:Record<string,number>;result:unknown}[]>`select state,metrics,error,counters,result from bulk_job where id=${jobId}::uuid`;
 const end=performance.now();
 const byText=new Map<string,{n:number;ms:number;who:string}>();
 sent.forEach((s,i)=>{const key=s.text.replace(/\s+/g,' ').trim().slice(0,200);const row=byText.get(key)??{n:0,ms:0,who:s.who};row.n++;row.ms+=(sent[i+1]?.at??end)-s.at;byText.set(key,row);});
 const bookkeeping=/^(begin|commit|rollback|savepoint|release|start transaction)\b/i;
 const inserts=sent.map((x,i)=>[x,i] as const).filter(([x])=>x.who==='app'&&/^insert into "leave_ledger"/.test(x.text)).map(([,i])=>i);
 const from=inserts[60],to=inserts[61];
 const seq=sent.slice(from-5,to+3).map((x,i,a)=>`${i+from-5} ${x.who} ${Math.round(((a[i+1]?.at??x.at)-x.at)*100)/100} ${x.text.replace(/\s+/g,' ').slice(0,300)}`);
 console.info('LEAVE_IMPORT_TRACE\n'+seq.join('\n'));
 const appStatements=sent.filter(s=>s.who==='app'&&!bookkeeping.test(s.text.trim())).length;
 console.info('LEAVE_IMPORT_PROFILE',JSON.stringify({
  rows:ROWS,state:job.state,error:job.error,counters:job.counters,wallMs:Math.round(wall),cpuMs:Math.round(cpuMs),msPerRow:Math.round(wall/ROWS),
  rowsPhaseMs:Math.round(end-preparedAt),rowsPhaseMsPerRow:Math.round((end-preparedAt)/ROWS),
  appStatements,ownerStatements:sent.filter(s=>s.who==='owner').length,appStatementsPerRow:Math.round(appStatements/ROWS*10)/10,
  bookkeeping:sent.filter(s=>bookkeeping.test(s.text.trim())).length,
  metrics:job.metrics,
  topByTime:[...byText].sort((a,b)=>b[1].ms-a[1].ms).slice(0,40).map(([t,r])=>({ms:Math.round(r.ms),n:r.n,who:r.who,t})),
  topByCount:[...byText].sort((a,b)=>b[1].n-a[1].n).slice(0,30).map(([t,r])=>({n:r.n,ms:Math.round(r.ms),t})),
 },null,1));
 expect(job.state).toBe('completed');
},900_000);
