/** Read-only stored OT projections for already RLS-visible Attendance records. Never resolves policy. */
import type {SessionContext,Tx} from '../../db/client';
import {readOvertimeDurationsTx} from './overtime-patterns';
import {formulaOvertimeRecord,type FormulaOvertimeRecord} from '../../lib/overtime-records';
export async function formulaOvertimeForRowsTx(tx:Tx,ctx:SessionContext,rows:readonly {employmentId:string;date:string;calcTrace:unknown}[]):Promise<Map<string,FormulaOvertimeRecord|null>>{
 if(rows.length>50000)throw new Error('Narrow the overtime record selection.');
 const unique=[...new Map(rows.map(row=>[row.employmentId+'|'+row.date,row])).values()],result=new Map<string,FormulaOvertimeRecord|null>();
 for(let start=0;start<unique.length;start+=5000){const part=unique.slice(start,start+5000),stored=await readOvertimeDurationsTx(tx,ctx,{entries:part.map(({employmentId,date})=>({employmentId,date}))});const byKey=new Map(stored.map(row=>[row.employmentId+'|'+row.date,row]));for(const row of part){const key=row.employmentId+'|'+row.date;result.set(key,formulaOvertimeRecord(row.calcTrace,byKey.get(key)));}}
 return result;
}

import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import * as s from '../../db/schema';
export type FormulaOvertimeCashRecord={status:'ready'|'ineligible'|'refused'|'unavailable';amountMinorUnits:string|null;currency:string;minorScale:number;calculationId:string;versionId:string|null;settlement:'cash'|'toil'|'unsettled'};
/** Bulk immutable cash projection. RLS on private lines/evidence stays in force; no salary is selected. */
export async function formulaOvertimeCashForRowsTx(tx:Tx,ctx:SessionContext,rows:readonly {employmentId:string;date:string}[]):Promise<Map<string,FormulaOvertimeCashRecord>>{
 if(rows.length>50000)throw new Error('Narrow the overtime cash selection.');
 const result=new Map<string,FormulaOvertimeCashRecord>();
 for(let start=0;start<rows.length;start+=5000){const entries=rows.slice(start,start+5000),sources=await tx.select({sourceId:s.attendanceOvertimeSource.id,employmentId:s.attendanceOvertimeSource.employmentId,date:s.attendanceOvertimeSource.attendanceDate,calculationId:s.attendanceOvertimeCalculation.id,versionId:s.attendanceOvertimeCalculation.versionId,status:s.attendanceOvertimeCalculation.outcome,currency:s.attendanceOvertimeCalculation.currency,minorScale:s.attendanceOvertimeCalculation.minorScale,expectedAmount:sql<string|null>`${s.attendanceOvertimeCalculationEvidence.evidence}->'evaluation'->>'amountMinorUnits'`}).from(s.attendanceOvertimeSource).innerJoin(s.attendanceOvertimeCalculation,eq(s.attendanceOvertimeCalculation.id,s.attendanceOvertimeSource.currentCalculationId)).leftJoin(s.attendanceOvertimeCalculationEvidence,eq(s.attendanceOvertimeCalculationEvidence.calculationId,s.attendanceOvertimeCalculation.id)).where(and(eq(s.attendanceOvertimeSource.tenantId,ctx.tenantId),sql`(app.can_admin_payroll_for(${s.attendanceOvertimeSource.companyId}) or exists(select 1 from employment e where e.id=${s.attendanceOvertimeSource.employmentId} and e.tenant_id=${s.attendanceOvertimeSource.tenantId} and app.is_self_person(e.person_id)))`,sql`exists(select 1 from jsonb_to_recordset(${JSON.stringify(entries)}::jsonb) wanted("employmentId" uuid,date date) where wanted."employmentId"=${s.attendanceOvertimeSource.employmentId} and wanted.date=${s.attendanceOvertimeSource.attendanceDate})`));
  const ids=sources.map(row=>row.calculationId),sourceIds=sources.map(row=>row.sourceId);if(!ids.length)continue;
  const lines=await tx.select({calculationId:s.attendanceOvertimeLine.calculationId,amount:s.attendanceOvertimeLine.amountMinorUnits}).from(s.attendanceOvertimeLine).where(inArray(s.attendanceOvertimeLine.calculationId,ids)).orderBy(asc(s.attendanceOvertimeLine.calculationId),asc(s.attendanceOvertimeLine.sequence),asc(s.attendanceOvertimeLine.id)).limit(50001);if(lines.length>50000)throw new Error('Narrow the overtime report line selection.');
  const settlements=await tx.select({sourceId:s.overtimeSourceSettlement.sourceId,mode:s.overtimeSourceSettlement.mode}).from(s.overtimeSourceSettlement).where(and(inArray(s.overtimeSourceSettlement.sourceId,sourceIds),sql`${s.overtimeSourceSettlement.releasedAt} is null`));const settlementBy=new Map(settlements.map(row=>[row.sourceId,row.mode]));
  const amounts=new Map<string,bigint>();for(const line of lines){if(!/^-?[0-9]{1,78}$/.test(line.amount))throw new Error('Invalid stored overtime amount');amounts.set(line.calculationId,(amounts.get(line.calculationId)??BigInt('0'))+BigInt(line.amount));}
  for(const row of sources){const expected=row.expectedAmount,amount=amounts.get(row.calculationId)??BigInt('0'),validExpected=typeof expected==='string'&&/^[0-9]{1,78}$/.test(expected);const known=row.status==='ineligible'||row.status==='ready'&&validExpected&&amount===BigInt(expected!);result.set(row.employmentId+'|'+row.date,{status:row.status==='refused'?'refused':known?row.status:'unavailable',amountMinorUnits:known?row.status==='ineligible'?'0':amount!.toString():null,currency:row.currency,minorScale:row.minorScale,calculationId:row.calculationId,versionId:row.versionId,settlement:settlementBy.get(row.sourceId)??'unsettled'});}
 }
 return result;
}
