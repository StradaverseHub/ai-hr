/** Historical Attendance Formula Builder evidence. All reads retain the original company and subject access checks. */
import {and,desc,eq,gte,lte,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {attendanceFormulaRevision,attendanceFormulaResult,attendanceFormulaResultEvent,payComponent} from '../db/schema';
import {withAttendanceTenant} from './module-gate';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function attendanceFormulaResultStateTx(tx:Tx,id:string){const [state]=await tx.select().from(attendanceFormulaResultEvent).where(eq(attendanceFormulaResultEvent.resultId,id)).orderBy(desc(attendanceFormulaResultEvent.sequence)).limit(1);return state;}

type HistoricalRevision=Pick<typeof attendanceFormulaRevision.$inferSelect,'id'|'definition'|'ordinal'>;
async function subjectRevision(tx:Tx,p:{companyId:string;employmentId:string;date:string;formulaId:string;resultId:string}){
 const [revision]=await tx.execute<HistoricalRevision>(sql`select id,definition,ordinal
   from app.attendance_formula_subject_versions(${p.companyId}::uuid,${p.employmentId}::uuid,${p.date}::date,
    ${p.formulaId}::uuid,${p.resultId}::uuid)`);
 return revision;
}
export function listAttendanceFormulaResults(ctx:SessionContext,p:{employmentId:string;date:string}){return withAttendanceTenant(ctx,async tx=>{
 if(!ctx.userId||!uuid.test(p.employmentId)||!/^\d{4}-\d{2}-\d{2}$/.test(p.date))throw Error('Choose an employee and date.');
 const rows=await tx.select({result:{id:attendanceFormulaResult.id,companyId:attendanceFormulaResult.companyId,formulaId:attendanceFormulaResult.formulaId,revisionId:attendanceFormulaResult.revisionId,employmentId:attendanceFormulaResult.employmentId,periodFrom:attendanceFormulaResult.periodFrom,periodTo:attendanceFormulaResult.periodTo,payComponentId:attendanceFormulaResult.payComponentId,quantity:attendanceFormulaResult.quantity,unit:attendanceFormulaResult.unit,rate:attendanceFormulaResult.rate,amount:attendanceFormulaResult.amount,createdAt:attendanceFormulaResult.createdAt},payCode:payComponent.code,payName:payComponent.name}).from(attendanceFormulaResult).innerJoin(payComponent,eq(payComponent.id,attendanceFormulaResult.payComponentId)).where(and(eq(attendanceFormulaResult.tenantId,ctx.tenantId),eq(attendanceFormulaResult.employmentId,p.employmentId),lte(attendanceFormulaResult.periodFrom,p.date),gte(attendanceFormulaResult.periodTo,p.date))).orderBy(desc(attendanceFormulaResult.createdAt),desc(attendanceFormulaResult.id)).limit(501);
 if(rows.length>500)throw Error('Narrow the result history.');
 return Promise.all(rows.map(async row=>{
  const result=row.result;
  const revision=await subjectRevision(tx,{companyId:result.companyId,employmentId:result.employmentId,date:result.periodTo,formulaId:result.formulaId,resultId:result.id});
  if(!revision||revision.id!==result.revisionId)throw Error('The retained formula version is unavailable.');
  return {result,code:revision.definition.code,version:revision.ordinal,
   definition:{description:revision.definition.description,period:{method:revision.definition.period.method}},payCode:row.payCode,payName:row.payName,
   state:(await attendanceFormulaResultStateTx(tx,result.id))?.kind??'calculated'};
 }));
});}

export async function readAttendanceFormulaResultTx(tx:Tx,ctx:SessionContext,id:string){if(!ctx.userId||!uuid.test(id))throw Error('Choose an Attendance result.');const [row]=await tx.select().from(attendanceFormulaResult).where(and(eq(attendanceFormulaResult.id,id),eq(attendanceFormulaResult.tenantId,ctx.tenantId)));if(!row)throw Error('Result or permission is unavailable.');return row;}

export function readAttendanceFormulaResult(ctx:SessionContext,id:string){return withAttendanceTenant(ctx,tx=>readAttendanceFormulaResultTx(tx,ctx,id));}
