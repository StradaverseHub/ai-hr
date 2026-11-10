/** Durable admission and creator-scoped progress for background employee imports (migration 9001). No HR changes occur in an HTTP request. */
import {sql} from 'drizzle-orm';
import {createHash,randomUUID} from 'node:crypto';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {EMPLOYEE_IMPORT_ALREADY_RUNNING,type EmployeeImportProgress,type EmployeeImportRowError,type EmployeeImportState,type EmployeeImportResultSummary,type EmployeeImportPhase} from '../lib/employee-import-job';
import {IMPORT_SOURCE_MAX_BYTES,importSourceName} from './import-history';
import {assertWorkforceCompanyTx} from './workforce-access';
import type {EmployeeImportUploadInput} from './employee-import-upload';
export class EmployeeImportJobError extends Error{constructor(message:string,readonly status=400){super(message);}}
export type EmployeeImportJobRow={id:string;tenant_id:string;created_by:string;context:SessionContext;operation_key:string;company_id:string;company_ids:string[];source_name:string;source_hash:string;source_bytes:number;source_content:Buffer|null;input:EmployeeImportUploadInput|null;attempt_id:string|null;state:EmployeeImportState;phase:EmployeeImportPhase|null;total:number;valid:number;invalid:number;steps_total:number;steps_done:number;imported:number;transient_retries:number;chunks:number;max_chunk_ms:number;activation_ms:number|null;plan:Record<string,unknown>|null;result:EmployeeImportResultSummary|null;error:string|null;errors:EmployeeImportRowError[];created_at:Date;updated_at:Date};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const employeeJobId=(id:string)=>{if(!uuid.test(id))throw new EmployeeImportJobError('Import unavailable.',404);return id;};
export async function employeeJobTx(tx:Tx,id:string,lock=false){
 const [row]=await tx.execute<EmployeeImportJobRow>(sql`select * from employee_import_job where id=${employeeJobId(id)}::uuid ${lock?sql`for update`:sql``}`);
 if(!row)throw new EmployeeImportJobError('Import unavailable.',404);return row;
}
export function employeeImportProgress(row:EmployeeImportJobRow):EmployeeImportProgress{return{id:row.id,sourceName:row.source_name,state:row.state,phase:row.phase,total:row.total,valid:row.valid,invalid:row.invalid,stepsTotal:row.steps_total,stepsDone:row.steps_done,imported:row.imported,attemptId:row.attempt_id,error:row.error,errors:row.errors??[],result:row.result,updatedAt:new Date(row.updated_at).toISOString(),createdAt:new Date(row.created_at).toISOString()};}
/** Start an import from the browser's preview-confirmed inputs. The request only enqueues; the worker validates and writes. */
export async function createEmployeeImportJob(ctx:SessionContext,input:EmployeeImportUploadInput,source:{name:string;content:Buffer;operationKey?:string}){
 if(!ctx.userId)throw new EmployeeImportJobError('Sign in again to import employees.',401);
 if(source.content.length<1||source.content.length>IMPORT_SOURCE_MAX_BYTES)throw new EmployeeImportJobError('Choose a file no larger than 10 MB.');
 if(!uuid.test(input.companyId))throw new EmployeeImportJobError('Choose a company before importing.');
 const operationKey=source.operationKey&&uuid.test(source.operationKey)?source.operationKey:randomUUID();
 const hash=createHash('sha256').update(source.content).digest('hex');
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'employee-import-admit:'+ctx.tenantId},0))`);
  // Same permission the synchronous import enforced when it was requested: fail here, not later in the worker.
  await assertWorkforceCompanyTx(tx,ctx,input.companyId,'maintain');
  const [existing]=await tx.execute<EmployeeImportJobRow>(sql`select * from employee_import_job where created_by=${ctx.userId!}::uuid and operation_key=${operationKey}::uuid`);
  if(existing)return{job:employeeImportProgress(existing),existing:true};
  const [active]=await tx.execute<{id:string}>(sql`select id from employee_import_job where state in ('queued','validating','importing','activating','discarding') limit 1`);
  if(active)throw new EmployeeImportJobError(EMPLOYEE_IMPORT_ALREADY_RUNNING,409);
  const [row]=await tx.execute<EmployeeImportJobRow>(sql`insert into employee_import_job(tenant_id,created_by,context,operation_key,company_id,source_name,source_hash,source_bytes,source_content,input)
   values(${ctx.tenantId}::uuid,${ctx.userId!}::uuid,'{}'::jsonb,${operationKey}::uuid,${input.companyId}::uuid,${importSourceName(source.name,'employees.csv')},${hash},${source.content.length},${source.content},${JSON.stringify(input)}::jsonb) on conflict do nothing returning *`);
  if(!row)throw new EmployeeImportJobError(EMPLOYEE_IMPORT_ALREADY_RUNNING,409);
  return{job:employeeImportProgress(row),existing:false};
 });
}
export async function getEmployeeImportJob(ctx:SessionContext,id:string){return withTenant(ctx,async tx=>employeeImportProgress(await employeeJobTx(tx,id)));}
/** The signed-in user's most recent jobs, active first (the page uses this to resume after navigation). */
export async function listEmployeeImportJobs(ctx:SessionContext){return withTenant(ctx,async tx=>{
 const rows=await tx.execute<EmployeeImportJobRow>(sql`select * from employee_import_job order by created_at desc limit 10`);
 return rows.map(employeeImportProgress);
});}
