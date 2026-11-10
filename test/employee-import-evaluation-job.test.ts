/** AI-evaluation-bound employee imports run on the same background job (bulk-job kernel) and keep their receipt
 * custody: the binding is claimed when writing starts and completed in the activation transaction. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {withTenant} from '../db/client';
import {beginEmployeeImportEvaluation,prepareEmployeeImportEvaluationCommit,reopenEmployeeImportEvaluation} from '../core/personnel-import-evaluation';
import {createEmployeeImportJob,getEmployeeImportJob} from '../core/employee-import-job';
import {parseEmployeeImportUpload,type EmployeeImportUploadInput} from '../core/employee-import-upload';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import type {EmployeeImportEvaluationBinding} from '../lib/personnel-import-evaluation';
import {expectNativeSourceCapture} from './native-outcome-source-capture.helpers';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base;
beforeAll(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-evaluation-job-secret-0123456789012345');await migrateTestDb();});
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(async()=>{await closeAll();vi.unstubAllEnvs();});
const ctx=()=>adminCtx(b);
const bound=(r:{attemptId:string;attemptVersion:number}):EmployeeImportEvaluationBinding=>({attemptId:r.attemptId,attemptVersion:r.attemptVersion});
function upload(email=randomUUID()+'@fixture.test'):EmployeeImportUploadInput{
 const csv='full_name,email,department,hired_on,ic_number,basic_salary,employment_type,employee_code\n'+`Fictional Evaluation Person,${email},Finance,2026-01-05,900101105566,5000,full_time,EVALJOB1\n`;
 return{companyId:b.companyId,csv,fileName:'evaluation.csv',dependentsCsv:'',registers:{},allocationsCsv:''};
}
const effects=(input:EmployeeImportUploadInput)=>{const p=parseEmployeeImportUpload(input);return{companyId:input.companyId,records:p.records,dependentRecords:p.dependentRecords,registerRecords:p.registerRecords,allocationRecords:p.allocationRecords};};
async function prepared(input:EmployeeImportUploadInput){
 const session=await beginEmployeeImportEvaluation(ctx(),{version:1,companyId:b.companyId,operationNonce:randomUUID(),cohortId:randomUUID(),mode:'baseline',sourceRevision:'a'.repeat(64)});
 return prepareEmployeeImportEvaluationCommit(ctx(),{binding:bound(session),commitNonce:randomUUID()},effects(input));
}
async function finish(id:string){
 for(let i=0;i<300;i++){
  const [row]=await owner.client<{state:string;notified:boolean}[]>`select state,notified_at is not null as notified from bulk_job where id=${id}::uuid`;
  if(['completed','failed'].includes(row.state)&&row.notified)return row.state;
  if(!await runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS}))await new Promise(resolve=>setTimeout(resolve,60));
 }
 throw new Error('evaluation-bound job did not finish');
}

it('runs an evaluation-bound import as a background job, completes its receipt with the canonical counts and replays',async()=>{
 const input=upload(),evaluation=await prepared(input);
 const started=await createEmployeeImportJob(ctx(),input,{name:'evaluation.csv',content:Buffer.from(input.csv)},bound(evaluation));
 if(!('job' in started))throw new Error('expected a job');
 // Nothing is written by the request: the receipt is still only prepared.
 expect((await reopenEmployeeImportEvaluation(ctx(),bound(evaluation),b.companyId)).state).toBe('prepared');
 expect(await finish(started.job.id)).toBe('completed');
 expect(await getEmployeeImportJob(ctx(),started.job.id)).toMatchObject({state:'completed',imported:1});
 const receipt=await reopenEmployeeImportEvaluation(ctx(),bound(evaluation),b.companyId);
 expect(receipt).toMatchObject({state:'committed',canonicalCounts:{imported:1,failed:0,skipped:0,dependents:0,qualification:0,emergency:0}});
 expect(receipt.serverWritePhaseMilliseconds).toBeGreaterThanOrEqual(0);
 // The receipt's event is the activation's employee-import.completed event, and its erasure references are the
 // canonical rows the job actually created.
 const [stored]=await owner.client<{event_id:string}[]>`select event_id from public.employee_import_evaluation_attempt where id=${evaluation.attemptId}::uuid`;
 const [event]=await owner.client<{event_type:string}[]>`select event_type from public.domain_event where id=${stored.event_id}::uuid`;
 expect(event.event_type).toBe('employee-import.completed');
 const [created]=await owner.client<{employment_id:string;person_id:string}[]>`select e.id as employment_id,e.person_id from employment e where e.employee_code='EVALJOB1'`;
 await expectNativeSourceCapture(evaluation.attemptId,stored.event_id,[{kind:'person',id:created.person_id},{kind:'employment',id:created.employment_id}]);
 // A second submission of the same binding replays the receipt instead of starting another import.
 const replay=await createEmployeeImportJob(ctx(),input,{name:'evaluation.csv',content:Buffer.from(input.csv)},bound(evaluation));
 expect(replay).toMatchObject({replay:{state:'committed',canonicalCounts:{imported:1}}});
 expect(await owner.client`select id from bulk_job`).toHaveLength(1);
});

it('refuses a binding that does not match the submitted rows, before any job is admitted',async()=>{
 const input=upload(),evaluation=await prepared(input);
 const changed={...input,csv:input.csv.replace('Fictional Evaluation Person','Retargeted Person')};
 await expect(createEmployeeImportJob(ctx(),changed,{name:'evaluation.csv',content:Buffer.from(changed.csv)},bound(evaluation))).rejects.toThrow();
 expect(await owner.client`select id from bulk_job`).toHaveLength(0);
 expect(await withTenant(ctx(),tx=>tx.execute(sql`select count(*)::int n from employment where employee_code='EVALJOB1'`)).then(r=>r[0].n)).toBe(0);
});

it('leaves the receipt uncommitted when the bound import is rolled back',async()=>{
 const input=upload(),evaluation=await prepared(input);
 await owner.client.unsafe(`create function public.evaluation_job_refusal() returns trigger language plpgsql as $$ begin raise exception 'fictional compensation refusal'; end $$`);
 await owner.client.unsafe(`create trigger evaluation_job_refusal before insert on compensation for each row execute function public.evaluation_job_refusal()`);
 try{
  const started=await createEmployeeImportJob(ctx(),input,{name:'evaluation.csv',content:Buffer.from(input.csv)},bound(evaluation));
  if(!('job' in started))throw new Error('expected a job');
  expect(await finish(started.job.id)).toBe('failed');
  expect((await reopenEmployeeImportEvaluation(ctx(),bound(evaluation),b.companyId)).state).toBe('prepared');
  expect(await owner.client`select id from public.domain_event where event_type='employee-import.completed'`).toHaveLength(0);
 }finally{
  await owner.client.unsafe('drop trigger if exists evaluation_job_refusal on compensation');
  await owner.client.unsafe('drop function if exists public.evaluation_job_refusal()');
 }
});
