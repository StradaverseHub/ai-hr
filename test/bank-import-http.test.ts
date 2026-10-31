import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {SessionContext} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase} from './harness';
let ctx:SessionContext;
vi.mock('../lib/authz',()=>({requireAdmin:async()=>ctx}));
import {processBankImportJob} from '../core/bank-import-worker';
import {GET as errors} from '../app/(app)/admin/personnel/import/bank-statutory/jobs/[jobId]/errors/route';
import {POST as create} from '../app/(app)/admin/personnel/import/bank-statutory/jobs/route';
import {PUT as upload,POST as command,GET as status} from '../app/(app)/admin/personnel/import/bank-statutory/jobs/[jobId]/route';
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
it('streams a complete ordered error report from persisted validation rows',async()=>{
 const bytes=Buffer.from('employee_code,tax_number\nMISSING1,T1\nMISSING2,T2');
 const admitted=await create(request('/jobs','POST',JSON.stringify({name:'bank.csv',bytes:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')})));const {job}=await admitted.json();
 const params={params:Promise.resolve({jobId:job.id})};await upload(request('/jobs/'+job.id+'?part=0','PUT',bytes),params);await command(request('/jobs/'+job.id,'POST',JSON.stringify({command:'validate'})),params);
 await processBankImportJob(ctx,job.id);await processBankImportJob(ctx,job.id);await processBankImportJob(ctx,job.id);
 const report=await errors(new Request(origin+'/jobs/'+job.id+'/errors'),params);expect(report.headers.get('content-type')).toContain('text/csv');
 const text=await report.text();expect(text.indexOf('MISSING1')).toBeGreaterThan(0);expect(text.indexOf('MISSING2')).toBeGreaterThan(text.indexOf('MISSING1'));expect(text).toContain('No employee has');
});
it('refuses cross-origin mutation and over-budget parts before storing them',async()=>{
 expect((await create(request('/jobs','POST','{}',false))).status).toBe(403);
 const response=await upload(request('/jobs/11111111-1111-4111-8111-111111111111?part=0','PUT',Buffer.alloc(1048577)),{params:Promise.resolve({jobId:'11111111-1111-4111-8111-111111111111'})});
 expect(response.status).toBe(413);
});
