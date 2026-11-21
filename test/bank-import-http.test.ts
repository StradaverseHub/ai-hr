import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {SessionContext} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase} from './harness';
let ctx:SessionContext;
vi.mock('../lib/authz',()=>({requireAdmin:async()=>ctx}));
// d3ba1e9f: the Error Log route resolves its wording through next-intl; the real catalogue, the real formatter.
vi.mock('next-intl/server',async()=>{const {createTranslator}=await import('next-intl');const messages=(await import('../messages/en.json')).default;
 return{getTranslations:async(arg?:string|{namespace?:string})=>createTranslator({locale:'en',messages,namespace:(typeof arg==='string'?arg:arg?.namespace) as never})};});
import * as XLSX from 'xlsx';
import en from '../messages/en.json';
import {GET as errorLog} from '../app/admin/personnel/import/bank-statutory/jobs/[jobId]/error-log/route';
import {GET as problems} from '../app/admin/personnel/import/bank-statutory/jobs/[jobId]/problems/route';
import {bankStatutoryErrorLogFor} from '../core/bank-statutory-error-log';
import {createTranslator} from 'next-intl';
import {processBankImportJob} from '../core/bank-import-worker';
import {GET as errors} from '../app/admin/personnel/import/bank-statutory/jobs/[jobId]/errors/route';
import {POST as create} from '../app/admin/personnel/import/bank-statutory/jobs/route';
import {PUT as upload,POST as command,GET as status} from '../app/admin/personnel/import/bank-statutory/jobs/[jobId]/route';
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();ctx=adminCtx(await seedBase());});afterAll(closeAll);
const origin='https://hr.example.test';
const request=(url:string,method:string,body:string|Buffer,withOrigin=true)=>new Request(origin+url,{method,headers:{host:'hr.example.test',...(withOrigin?{origin}:{})},body:typeof body==='string'?body:new Uint8Array(body)});
it('admits, uploads, queues and polls a file without executing any validation in the HTTP request',async()=>{
 const bytes=Buffer.from('employee_code,tax_number\nEMP1,T1'),meta=JSON.stringify({name:'bank.csv',bytes:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')});
 const first=await create(request('/jobs','POST',meta));expect(first.status).toBe(201);const {job}=await first.json();
 const params={params:Promise.resolve({jobId:job.id})};
 expect((await upload(request('/jobs/'+job.id+'?part=0','PUT',bytes),params)).status).toBe(200);
 const queued=await command(request('/jobs/'+job.id,'POST',JSON.stringify({command:'validate'})),params);expect((await queued.json()).job).toMatchObject({state:'queued',validated:0,saved:0});
 const duplicate=await create(request('/jobs','POST',meta));expect(duplicate.status).toBe(200);expect((await duplicate.json()).job.id).toBe(job.id);
 const progress=await status(new Request(origin+'/jobs/'+job.id),params);expect(progress.headers.get('cache-control')).toBe('private, no-store');expect((await progress.json()).job.state).toBe('queued');
 const premature=await command(request('/jobs/'+job.id,'POST',JSON.stringify({command:'confirm'})),params);expect(premature.status).toBe(400);
});
/** Admit, upload, validate (every worker phase) and return the job's route params. */
async function validated(text:string){
 const bytes=Buffer.from(text);
 const admitted=await create(request('/jobs','POST',JSON.stringify({name:'bank.csv',bytes:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')})));const {job}=await admitted.json();
 const params={params:Promise.resolve({jobId:job.id})};
 for(let offset=0,part=0;offset<bytes.length;offset+=1048576,part++)expect((await upload(request('/jobs/'+job.id+'?part='+part,'PUT',bytes.subarray(offset,offset+1048576)),params)).status).toBe(200);
 await command(request('/jobs/'+job.id,'POST',JSON.stringify({command:'validate'})),params);
 for(let phase=0;phase<20;phase++){const state=(await (await status(new Request(origin+'/jobs/'+job.id),params)).json()).job.state;if(state==='ready')break;await processBankImportJob(ctx,job.id);}
 return {job,params};
}
const sheet=(bytes:ArrayBuffer,name='Errors')=>XLSX.utils.sheet_to_json<(string|number)[]>(XLSX.read(new Uint8Array(bytes),{type:'array'}).Sheets[name],{header:1,raw:true,defval:''}) as (string|number)[][];
it('d3ba1e9f: streams the complete ordered Error Log (.xlsx) from persisted validation rows, at the old address too',async()=>{
 const {job,params}=await validated('employee_code,tax_number\nMISSING1,T1\nMISSING2,T2');
 for(const get of [errorLog,errors]){
  const report=await get(new Request(origin+'/jobs/'+job.id+'/error-log'),params);
  expect(report.status).toBe(200);
  expect(report.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  expect(report.headers.get('cache-control')).toBe('private, no-store');
  const rows=sheet(await report.arrayBuffer()),h=en.importProblems.headers;
  expect(rows[0]).toEqual([h.row,h.reference,h.employeeName,h.field,h.value,h.problem,h.correction,h.stage,h.result]);
  expect(rows.slice(1).map(r=>[r[0],r[1]])).toEqual([[2,'MISSING1'],[3,'MISSING2']]);
  expect(String(rows[1][5])).toContain('No employee has Employee ID "MISSING1"');
  expect(rows[1][6]).toBe(en.importErrorLogDataBankCostInfo.corrections.existingEmployee);
  expect(rows[1][8]).toBe(en.importProblems.result.refused);
  const summary=sheet(await (await get(new Request(origin+'/jobs/'+job.id+'/error-log'),params)).arrayBuffer(),'Summary');
  expect(summary).toEqual([[en.importProblems.summary.batch,job.id],[en.importProblems.summary.file,'bank.csv'],[en.importProblems.summary.status,en.people.import.background.ready],[en.importProblems.summary.problems,2]]);
 }
 // The progress screen's first page: same rows, sensitive cells redacted before they leave the server.
 const page=await (await problems(new Request(origin+'/jobs/'+job.id+'/problems'),params)).json();
 expect(page.total).toBe(2);expect(page.rows.map((r:{ordinal:number})=>r.ordinal)).toEqual([1,2]);
 expect(page.rows[0].record).toEqual({employee_code:'MISSING1',tax_number:'*'});
 expect(JSON.stringify(page)).not.toContain('"T1"');
});
it('d3ba1e9f: streams an Error Log of 2,100 problem rows in bounded pages, in Excel row order, hiding statutory numbers',async()=>{
 const lines=Array.from({length:2100},(_,i)=>`GONE${String(i+1).padStart(5,'0')},TX${i+1}`);
 const {job,params}=await validated('employee_code,tax_number\n'+lines.join('\n'));
 const report=await errorLog(new Request(origin+'/jobs/'+job.id+'/error-log'),params);expect(report.status).toBe(200);
 const rows=sheet(await report.arrayBuffer());
 expect(rows.length).toBe(2101);
 expect(rows.slice(1).map(r=>r[0])).toEqual(Array.from({length:2100},(_,i)=>i+2));
 expect(rows[1000][1]).toBe('GONE01000');expect(rows[2100][1]).toBe('GONE02100');
 expect(JSON.stringify(rows)).not.toMatch(/TX\d/);
 // Import History's bounded first page for the same attempt is not built before the import is confirmed.
 expect(await bankStatutoryErrorLogFor(ctx,job.id,{problems:createTranslator({locale:'en',messages:en}) as never,shared:createTranslator({locale:'en',messages:en,namespace:'importProblems'}) as never})).toBeNull();
},120_000); // Not yet measured on the hosted runner: 2,100-row validation in three worker phases plus the streamed read.
it('d3ba1e9f: another tenant\'s administrator gets neither the Error Log nor the problem rows',async()=>{
 const {job,params}=await validated('employee_code,tax_number\nMISSING1,T1');
 const owner=ctx;ctx=adminCtx(await seedBase());
 try{
  expect((await errorLog(new Request(origin+'/jobs/'+job.id+'/error-log'),params)).status).toBe(404);
  expect((await errors(new Request(origin+'/jobs/'+job.id+'/errors'),params)).status).toBe(404);
  expect((await problems(new Request(origin+'/jobs/'+job.id+'/problems'),params)).status).toBe(404);
 }finally{ctx=owner;}
});
it('refuses cross-origin mutation and over-budget parts before storing them',async()=>{
 expect((await create(request('/jobs','POST','{}',false))).status).toBe(403);
 const response=await upload(request('/jobs/11111111-1111-4111-8111-111111111111?part=0','PUT',Buffer.alloc(1048577)),{params:Promise.resolve({jobId:'11111111-1111-4111-8111-111111111111'})});
 expect(response.status).toBe(413);
});
