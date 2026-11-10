/** Own Home hints over existing Payroll results. No amount, statutory snapshot or bank data is read.
 * A payment hint requires an actual generated result for this employment on a dated run; a company
 * cycle, draft scope or calendar-month end alone cannot establish that this person is being paid.
 */
import {and,asc,desc,eq,gte,lte,isNull,ne} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {payslip,payrollBatch} from '../db/schema';
import {withPayrollTenant} from './module-gate';
import {isOwnProfileEditEmploymentTx} from './read';
import {payrollPublicationState} from '../lib/payroll-publication';
import {todayInKualaLumpur} from '../lib/hr-date';
import {calendarWindowDates} from '../lib/calendar-window';

export class OwnPayrollSubjectUnavailableError extends Error{
 constructor(){super('The own payroll context is unavailable.');this.name='OwnPayrollSubjectUnavailableError';}
}
async function requireOwnPayrollSubjectTx(tx:Tx,ctx:SessionContext,employmentId:string){
 if(!ctx.userId||!ctx.personId||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(employmentId)
  ||!await isOwnProfileEditEmploymentTx(tx,ctx,employmentId))throw new OwnPayrollSubjectUnavailableError();
}
export type OwnPayrollHomeMetadata={
 version:1;employmentId:string;
 payslips:{id:string;period:string;runType:string;runSequence:number}[];
 nextPayment:{date:string;period:string;runType:string}|null;
};

/** The selector is always an explicit own active subject, even for a privileged employee. A fresh
 * own-row/login check runs in this transaction, so a stale card cannot survive unlink/archive/block.
 * Metadata is projected by SQL rather than stripping amounts from the existing full payslip read.
 */
export function readOwnPayrollHomeMetadata(ctx:SessionContext,employmentId:string,signal?:AbortSignal):Promise<OwnPayrollHomeMetadata>{
 return withPayrollTenant(ctx,async tx=>projectOwnPayrollHomeMetadata(employmentId,await ownPayrollResultRowsTx(tx,ctx,employmentId)),{readSignal:signal});
}

/** Every generated own result row on a dated run, newest first, bounded: the one read the three Home hints share. */
async function ownPayrollResultRowsTx(tx:Tx,ctx:SessionContext,employmentId:string){
 await requireOwnPayrollSubjectTx(tx,ctx,employmentId);
 return tx.select({id:payslip.id,period:payrollBatch.payPeriod,runType:payrollBatch.runType,
  runSequence:payrollBatch.runSeq,paymentDate:payrollBatch.batchDate,status:payrollBatch.status,releasedAt:payrollBatch.releasedAt,needsRecalcAt:payrollBatch.needsRecalcAt})
  .from(payslip).innerJoin(payrollBatch,and(eq(payrollBatch.id,payslip.batchId),eq(payrollBatch.tenantId,payslip.tenantId)))
  .where(and(isNull(payrollBatch.historyImportAttemptId),eq(payslip.tenantId,ctx.tenantId),eq(payslip.employmentId,employmentId)))
  .orderBy(desc(payrollBatch.payPeriod),desc(payrollBatch.runSeq),asc(payslip.id)).limit(1201);
}
type OwnPayrollResultRow=Awaited<ReturnType<typeof ownPayrollResultRowsTx>>[number];
const OWN_PAYROLL_ROW_LIMIT=1200;
/** A recorded scheduled payment: generated, current (not awaiting recalculation) and not a draft. */
const recordedPayment=(row:OwnPayrollResultRow)=>row.status!=='draft'&&row.needsRecalcAt===null;

function projectOwnPayrollHomeMetadata(employmentId:string,rows:OwnPayrollResultRow[]):OwnPayrollHomeMetadata{
 if(rows.length>OWN_PAYROLL_ROW_LIMIT)throw Error('Own payroll metadata exceeds its bounded history.');
 const now=new Date(),today=todayInKualaLumpur(now);
 const published=rows.filter(row=>payrollPublicationState(row,now)==='published');
 // This is a recorded scheduled payment, never a claim that money has reached a bank account.
 // Do not return an unpublished slip ID or reconstruct membership from a draft's company/scope.
 const payments=rows.filter(row=>recordedPayment(row)&&row.paymentDate>=today)
  .sort((a,b)=>a.paymentDate.localeCompare(b.paymentDate)||a.period.localeCompare(b.period)||a.runSequence-b.runSequence||a.id.localeCompare(b.id));
 const next=payments[0];
 return {version:1,employmentId,payslips:published.slice(0,12).map(row=>({id:row.id,period:row.period,runType:row.runType,runSequence:row.runSequence})),
  nextPayment:next?{date:next.paymentDate,period:next.period,runType:next.runType}:null};
}

/** One Home response reads its own payroll result rows once, behind the history barrier, for the Summary hints, the
 * Today payday and the Calendar paydays. Each answer is the exact projection its own reader makes over the same
 * predicate; a history beyond the bound, or any failure of the shared read, reruns that consumer's own reader, so a
 * failure or refusal reaches each card exactly as before. The carrier is bound to one session object and one
 * employment and is never reused for another request, login or subject. */
export class OwnHomePayrollRead{
 private pending?:Promise<OwnPayrollResultRow[]>;
 constructor(private readonly session:SessionContext,private readonly employmentId:string,readonly signal?:AbortSignal){}
 private rows(session:SessionContext,employmentId:string){
  if(session!==this.session||employmentId!==this.employmentId)return Promise.reject(new OwnPayrollSubjectUnavailableError());
  return this.pending??=withPayrollTenant(session,tx=>ownPayrollResultRowsTx(tx,session,employmentId),{readSignal:this.signal});
 }
 private async shared<T>(session:SessionContext,employmentId:string,project:(rows:OwnPayrollResultRow[])=>T,own:()=>Promise<T>):Promise<T>{
  let rows:OwnPayrollResultRow[];
  try{rows=await this.rows(session,employmentId);}catch{return own();}
  if(rows.length>OWN_PAYROLL_ROW_LIMIT)return own();
  return project(rows);
 }
 homeMetadata(session:SessionContext,employmentId:string){
  return this.shared(session,employmentId,rows=>projectOwnPayrollHomeMetadata(employmentId,rows),()=>readOwnPayrollHomeMetadata(session,employmentId,this.signal));
 }
 nextPaymentDate(session:SessionContext,employmentId:string){
  return this.shared(session,employmentId,rows=>{
   const today=todayInKualaLumpur();
   return rows.filter(row=>recordedPayment(row)&&row.paymentDate>=today).map(row=>row.paymentDate).sort()[0]??null;
  },()=>readOwnNextPayrollPaymentDate(session,employmentId,this.signal));
 }
 calendarPayments(session:SessionContext,employmentId:string,from:string,to:string){
  calendarWindowDates(from,to);
  return this.shared(session,employmentId,
   rows=>[...new Set(rows.filter(row=>recordedPayment(row)&&row.paymentDate>=from&&row.paymentDate<=to).map(row=>row.paymentDate))].sort(),
   ()=>readOwnPayrollCalendarPayments(session,employmentId,from,to,this.signal));
 }
}

/** Earliest recorded payment date for the own Today card, without loading payslip history. */
export function readOwnNextPayrollPaymentDate(ctx:SessionContext,employmentId:string,signal?:AbortSignal):Promise<string|null>{
 return withPayrollTenant(ctx,async tx=>{
  await requireOwnPayrollSubjectTx(tx,ctx,employmentId);
  const [payment]=await tx.select({date:payrollBatch.batchDate})
   .from(payslip).innerJoin(payrollBatch,and(eq(payrollBatch.id,payslip.batchId),eq(payrollBatch.tenantId,payslip.tenantId)))
   .where(and(isNull(payrollBatch.historyImportAttemptId),eq(payslip.tenantId,ctx.tenantId),eq(payslip.employmentId,employmentId),
    ne(payrollBatch.status,'draft'),isNull(payrollBatch.needsRecalcAt),gte(payrollBatch.batchDate,todayInKualaLumpur())))
   .orderBy(asc(payrollBatch.batchDate)).limit(1);
  return payment?.date??null;
 },{readSignal:signal});
}

/** Recorded run dates for a bounded own calendar. Actual result membership is required; a draft,
 * stale calculation or company cycle alone supplies no payday. Never selects an amount or bank fact. */
export function readOwnPayrollCalendarPayments(ctx:SessionContext,employmentId:string,from:string,to:string,signal?:AbortSignal){
 calendarWindowDates(from,to);
 return withPayrollTenant(ctx,async tx=>{
  await requireOwnPayrollSubjectTx(tx,ctx,employmentId);
  const rows=await tx.selectDistinct({date:payrollBatch.batchDate})
   .from(payslip).innerJoin(payrollBatch,and(eq(payrollBatch.id,payslip.batchId),eq(payrollBatch.tenantId,payslip.tenantId)))
   .where(and(isNull(payrollBatch.historyImportAttemptId),eq(payslip.tenantId,ctx.tenantId),eq(payslip.employmentId,employmentId),
    ne(payrollBatch.status,'draft'),isNull(payrollBatch.needsRecalcAt),gte(payrollBatch.batchDate,from),lte(payrollBatch.batchDate,to)))
   .orderBy(asc(payrollBatch.batchDate));
  return rows.map(row=>row.date);
 },{readSignal:signal});
}
