/** TEMPORARY profiling probe (ADR 0181 J2, imports): where section (Profile, Family) and register (Qualification,
 * Emergency Contact) import jobs spend their time, per row, at the shape of a real group (70 companies, 1,000
 * employments). Not for merge. Fictional fixtures only. */
import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {client,type SessionContext} from '../db/client';
import {createSectionImportJob} from '../core/section-import-job';
import {createProfileOption} from '../core/profile-options';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import type {ImportRecord} from '../lib/import-schema';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const COMPANIES=70,EMPLOYMENTS=1000;
let base:Base,ctx:SessionContext;
beforeAll(async()=>{
 await migrateTestDb();await resetDb();
 base=await seedBase();ctx=await entitledCtx(base);
 const others=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) select ${base.tenantId}::uuid,'Profile shape company '||n from generate_series(1,${COMPANIES-1}::integer)n returning id`;
 const all=[base.companyId,...others.map(r=>r.id)];
 await owner.client`with people as(insert into person(tenant_id,full_name,primary_email) select ${base.tenantId}::uuid,'Profile shape person '||lpad(n::text,4,'0'),'sec-shape-'||n||'@fixture.invalid' from generate_series(1,${EMPLOYMENTS}::integer)n returning id,full_name),ranked as(select id,row_number()over(order by full_name)::int as n from people)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${base.tenantId}::uuid,id,(${all}::uuid[])[1+((n-1)%${COMPANIES}::integer)],'SEC-'||lpad(n::text,4,'0'),'2025-01-01'::date from ranked`;
 for(const value of ['Diploma','Bachelor','Master'])await createProfileOption(ctx,{category:'qualificationLevel',value,label:value}).catch(()=>undefined);
},600_000);
afterAll(closeAll);
const code=(n:number)=>`SEC-${String(n).padStart(4,'0')}`;

async function profileJob(label:string,section:string,records:ImportRecord[]){
 const options=(client as unknown as {options:{debug?:unknown}}).options,previous=options.debug;
 const sent:{at:number;text:string}[]=[];
 options.debug=(_c:number,t:string)=>{sent.push({at:performance.now(),text:t});};
 const started=performance.now();const cpu=process.cpuUsage();let preparedAt=0;
 let jobId='';
 try{
  const csv=[Object.keys(records[0]).join(','),...records.map(r=>Object.values(r).join(','))].join('\n');
  const {job}=await createSectionImportJob(ctx,{section,records,fileName:`${label}.csv`,csv,operationKey:randomUUID()});jobId=job.id;
  for(let i=0;i<20000;i++){
   const [j]=await owner.client<{state:string}[]>`select state from bulk_job where id=${jobId}::uuid`;
   if(!preparedAt&&['running','finalizing'].includes(j.state))preparedAt=performance.now();
   if(['completed','failed','cancelled'].includes(j.state))break;
   if(!await runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS}))await new Promise(r=>setTimeout(r,20));
  }
 }finally{options.debug=previous;}
 const end=performance.now(),wall=end-started,c=process.cpuUsage(cpu),cpuMs=(c.user+c.system)/1000;
 const [job]=await owner.client<{state:string;metrics:Record<string,number>;error:string|null;counters:Record<string,number>;steps_total:number}[]>`select state,metrics,error,counters,steps_total from bulk_job where id=${jobId}::uuid`;
 const byText=new Map<string,{n:number;ms:number}>();
 sent.forEach((s,i)=>{const key=s.text.replace(/\s+/g,' ').trim().slice(0,200);const row=byText.get(key)??{n:0,ms:0};row.n++;row.ms+=(sent[i+1]?.at??end)-s.at;byText.set(key,row);});
 const bookkeeping=/^(begin|commit|rollback|savepoint|release|start transaction)\b/i;
 const statements=sent.filter(s=>!bookkeeping.test(s.text.trim())).length;
 console.info('SECTION_IMPORT_PROFILE',label,JSON.stringify({
  rows:records.length,steps:job.steps_total,state:job.state,error:job.error,counters:job.counters,wallMs:Math.round(wall),cpuMs:Math.round(cpuMs),msPerRow:Math.round(wall/records.length),
  rowsPhaseMs:Math.round(end-preparedAt),statements,statementsPerRow:Math.round(statements/records.length*10)/10,metrics:job.metrics,
  topByTime:[...byText].sort((a,b)=>b[1].ms-a[1].ms).slice(0,25).map(([t,r])=>({ms:Math.round(r.ms),n:r.n,t})),
 },null,1));
 expect(job.state).toBe('completed');
}

it('profiles a Profile section import (phone numbers)',async()=>{
 await profileJob('profile','profile',Array.from({length:150},(_,i)=>({employee_code:code(1+(i*7)%EMPLOYMENTS),phone:`01${String(30000000+i)}`})));
},900_000);
it('profiles a Family section import (children)',async()=>{
 await profileJob('family','family',Array.from({length:100},(_,i)=>({employee_code:code(1+(i*11)%EMPLOYMENTS),full_name:`Fictional child ${i}`,relationship:'child',date_of_birth:`2015-0${1+i%9}-1${i%9}`})));
},900_000);
it('profiles a Qualification register import',async()=>{
 await profileJob('qualification','qualification',Array.from({length:100},(_,i)=>({employee_code:code(1+(i*13)%EMPLOYMENTS),record_id:'',qualification:'Bachelor',institute:`Fictional institute ${i}`,from_ym:'2010-01',to_ym:'2013-12',graduation_date:'',major:'Fictional major',result:'',description:'',is_highest:'Yes'})));
},900_000);
it('profiles an Emergency Contact register import',async()=>{
 await profileJob('emergency','emergency',Array.from({length:100},(_,i)=>({employee_code:code(1+(i*17)%EMPLOYMENTS),record_id:'',full_name:`Fictional contact ${i}`,relationship:'Spouse',mobile_phone:`0121${String(100000+i)}`,home_phone:'',priority:'primary',address:'',remarks:''})));
},900_000);
