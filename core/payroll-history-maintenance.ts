/** Authorised item/edit/removal previews on the existing immutable import attempt and staged writer. */
import {and,eq,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext} from '../db/client';
import {payrollHistoryImportRecord as record,payrollHistoryImportRevision as revision,payrollHistoryImportAttempt as attempt,payrollHistoryImportEvent as event} from '../db/schema';
import {assertModuleGate} from './module-gate';
import {personnelFormulaPermissionsTx} from './pay-formula-personnel-permissions';
import {toCsv} from '../lib/csv';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import type {PayrollHistoryMaintenanceRequest,PayrollHistoryMaintenancePreview} from '../lib/payroll-history-maintenance';
const reason=z.string().trim().min(1).max(2000),reference={version:z.literal(1),recordId:z.uuid(),expectedRevisionId:z.uuid(),reason};
const requestSchema=z.discriminatedUnion('operation',[
 z.object({...reference,operation:z.literal('edit'),items:z.array(z.object({key:z.string().min(1).max(200),amount:z.string().regex(/^\d+(?:\.\d{1,2})?$/)}).strict()).min(1).max(1000)}).strict(),
 z.object({...reference,operation:z.literal('remove_items'),itemKeys:z.array(z.string().min(1).max(200)).min(1).max(1000)}).strict(),
 z.object({version:z.literal(1),operation:z.literal('remove_batch'),attemptId:z.uuid(),reason}).strict(),
]);
const fail=(message:string):never=>{throw new Error(message);};
export async function previewPayrollHistoryMaintenance(ctx:SessionContext,input:PayrollHistoryMaintenanceRequest):Promise<PayrollHistoryMaintenancePreview>{
 assertModuleGate(ctx,'payroll');const request=requestSchema.parse(input);
 const rows=await withTenant(ctx,async tx=>{
  const [principal]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() as ok`);if(!ctx.userId||principal?.ok!==true)fail('Your current payroll history access is unavailable.');
  let records:typeof record.$inferSelect[];
  if(request.operation==='remove_batch'){
   const [source]=await tx.select({id:attempt.id,companyIds:attempt.companyIds}).from(attempt).where(eq(attempt.id,request.attemptId));if(!source)fail('This import batch is unavailable in your current scope.');
   const permissions=await personnelFormulaPermissionsTx(tx,ctx,source.companyIds,['payroll.history.revert']);if(source.companyIds.some(id=>!permissions.get('payroll.history.revert')?.has(id)))fail('Payroll history removal permission is unavailable for a company in this batch.');
   const confirmed=await tx.select({id:event.id}).from(event).where(and(eq(event.attemptId,source.id),eq(event.kind,'confirmed')));if(!confirmed.length)fail('This batch has no accepted import to remove.');
   const ids=await tx.selectDistinct({id:revision.recordId}).from(revision).where(eq(revision.attemptId,source.id));records=ids.length?await tx.select().from(record).where(inArray(record.id,ids.map(row=>row.id))):[];
  }else{records=await tx.select().from(record).where(eq(record.id,request.recordId));}
  if(!records.length)fail('The original history record is unavailable.');if(records.length>50000)fail('Remove this large batch through a smaller reviewed selection.');
  const permission=request.operation==='edit'?'payroll.history.import':'payroll.history.revert';
  const permitted=await personnelFormulaPermissionsTx(tx,ctx,[...new Set(records.map(row=>row.companyId))],[permission]);if(records.some(row=>!permitted.get(permission)?.has(row.companyId)))fail('Your current payroll history permission does not allow this operation.');
  const metadata: {recordId:string;companyId:string;employmentId:string;employeeNo:string;period:string;cycleId:string}[]=[];
  const ids=sql`ARRAY[${sql.join(records.map(row=>sql`${row.id}::uuid`),sql`, `)}]::uuid[]`;
  for(let offset=0;;offset+=500){const page=await tx.execute<typeof metadata[number]>(sql`select * from app.payroll_history_maintenance_identity(${ids},${offset},500)`);metadata.push(...page);if(page.length<500)break;}
  if(metadata.length!==records.length)fail('The original record identity is unavailable in your current scope.');
  return metadata.map(row=>[row.employeeNo,row.period,row.cycleId,'BASIC',row.companyId,'0.00']);
 },{readOnlySnapshot:true});
 const {previewPayrollHistoryMaintenanceSource}=await import('./payroll-history-revisions');
 return previewPayrollHistoryMaintenanceSource(ctx,{name:'payroll-history-maintenance.csv',content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows])),maintenance:{version:1,mode:request.operation,reason:request.reason,request}});
}
/** Bind compatibility Revert to its actor's actual new removal preview, never posted source/row contents. */
export async function payrollHistoryMaintenanceRevertReceipt(ctx:SessionContext,attemptId:string,previewHash:string){
 return withTenant(ctx,async tx=>{
  const [source]=await tx.execute<{id:string;plan:import('../lib/payroll-history-revisions').HistoryRevisionPlan}>(sql`select id,plan from payroll_history_import_attempt where created_by=${ctx.userId??null}::uuid and plan->>'previewHash'=${previewHash} and plan->'maintenance'->>'mode'='remove_batch' and plan->'maintenance'->'request'->>'attemptId'=${attemptId} order by created_at desc,id desc limit 1`);return source??null;
 },{readOnlySnapshot:true});
}
