/** Native payroll artifact access stays distinct from the effective historical source. No money is calculated here. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {pgTable,uuid,numeric,jsonb,integer,timestamp,date} from 'drizzle-orm/pg-core';
import type {SessionContext,Tx} from '../db/client';
import type {DetachedNativeHistoryBaseline,NativeHistorySource,NativeHistoryBaselineProof} from '../lib/payroll-history-native-baseline';
export type {DetachedNativeHistoryBaseline,NativeHistorySource,NativeHistoryBaselineProof} from '../lib/payroll-history-native-baseline';
export {nativeHistoryBaselineIds} from '../lib/payroll-history-native-baseline';
/** SQL-owned, scope-checked, automatically updatable view. Use ONLY for a native run's physical artifacts, never YTD. */
const nativePayslipColumns=()=>({
 id:uuid('id').primaryKey().defaultRandom(),tenantId:uuid('tenant_id').notNull(),batchId:uuid('batch_id').notNull(),employmentId:uuid('employment_id').notNull(),
 basicSalary:numeric('basic_salary',{precision:12,scale:2}).notNull(),allowance:numeric('allowance',{precision:12,scale:2}).notNull().default('0'),overtimePay:numeric('overtime_pay',{precision:12,scale:2}).notNull().default('0'),bonus:numeric('bonus',{precision:12,scale:2}).notNull().default('0'),
 daysWorked:numeric('days_worked',{precision:5,scale:2}),coverageFrom:date('coverage_from'),coverageTo:date('coverage_to'),grossPay:numeric('gross_pay',{precision:12,scale:2}).notNull(),statutory:jsonb('statutory').notNull(),otherDeductions:numeric('other_deductions',{precision:12,scale:2}).notNull().default('0'),totalDeductions:numeric('total_deductions',{precision:12,scale:2}).notNull(),netPay:numeric('net_pay',{precision:12,scale:2}).notNull(),employerCost:numeric('employer_cost',{precision:12,scale:2}).notNull(),version:integer('version').notNull().default(1),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
});
export const nativePayrollPayslip=pgTable('payroll_history_native_payslip',nativePayslipColumns());
export const nativePayrollPayslipWrite=pgTable('payroll_history_native_payslip_write',nativePayslipColumns());
/** One set read before planning: SQL fingerprints physical source/status/version using its own JSON encoding. */
export async function nativeHistoryBaselineSourcesTx(tx:Tx,_ctx:SessionContext,payslipIds:readonly string[]):Promise<NativeHistorySource[]>{
 if(!payslipIds.length)return[];
 const rows=await tx.execute<{source:NativeHistorySource}>(sql`select value as source from app.payroll_history_native_sources(array(select jsonb_array_elements_text(${JSON.stringify([...new Set(payslipIds)])}::jsonb)::uuid)) as row(value)`);
 return rows.map(row=>row.source);
}
export async function captureNativeHistoryBaselineTx(tx:Tx,_ctx:SessionContext,input:{attemptId:string;recordId:string;row:DetachedNativeHistoryBaseline;cycleName:string}):Promise<{snapshotId:string;nativeSource:NativeHistoryBaselineProof}>{
 const valueHash=createHash('sha256').update(JSON.stringify(input.row.values,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)).digest('hex');
 const [result]=await tx.execute<{result:{snapshotId:string;nativeSource:NativeHistoryBaselineProof}}>(sql`select app.payroll_history_capture_native(${input.attemptId}::uuid,${input.recordId}::uuid,${JSON.stringify(input.row)}::jsonb,${input.cycleName},${valueHash}) result`);return result.result;
}
export async function finalizeNativeHistoryBaselinesTx(tx:Tx,_ctx:SessionContext,attemptId:string):Promise<void>{await tx.execute(sql`select app.payroll_history_finalize_native(${attemptId}::uuid)`);}
