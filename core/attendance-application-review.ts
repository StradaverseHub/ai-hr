/** Read-only request context. Historical missing evidence stays missing; no schedule re-derivation. */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { attendance, assignment, department, businessUnit, position, employment, shift } from '../db/schema';
import { isAttendanceTrace } from './attendance-trace';
import { recordedAttendanceProgress, type AttendanceProgressWorkflow } from '../lib/attendance-progress';
import type { attendanceWorkflowForTx } from './attendance-workflow';

type Workflow = Awaited<ReturnType<typeof attendanceWorkflowForTx>>;
export async function attendanceProgressTx(tx: Tx, flow: Workflow, status: string) {
  if(status!=='pending'||!flow)return recordedAttendanceProgress(flow,status);
  const rows=await tx.execute(sql`select * from app.attendance_workflow_review_participants(${flow.correctionId}::uuid)`) as unknown as {
    participant_slot:string|null;employment_id:string|null;employee_code:string|null;kind:string;eligible:boolean;acting_mode:'assigned'|'administrator';
  }[];
  const identities=new Map<string,{employeeCode:string|null;eligible:boolean}>();
  for(const row of rows)if(row.employment_id||row.kind==='hr_admin')identities.set(row.employment_id??'hr_admin',{employeeCode:row.employee_code,eligible:row.eligible});
  const progress=recordedAttendanceProgress(flow as AttendanceProgressWorkflow,status,identities);
  if(!rows.length)return {...progress,state:'unresolved' as const,next:[]};
  if(!progress.next.some(actor=>actor.eligible)&&rows.some(row=>row.acting_mode==='administrator'&&row.eligible)){
    progress.next.push({name:'',employeeCode:null,kind:'hr_admin',eligible:true,actingMode:'administrator'});
    progress.state='pending';
  }
  return progress;
}

export async function attendanceApplicationReviewTx(tx: Tx, p: { employmentId: string; date: string }) {
  const [record] = await tx.select({ id: attendance.id, checkInAt: attendance.checkInAt, checkOutAt: attendance.checkOutAt,
    status: attendance.status, dayType: attendance.dayType, workedMinutes: attendance.workedMinutes,
    underMinutes: attendance.underMinutes, calcTrace: attendance.calcTrace })
    .from(attendance).where(and(eq(attendance.employmentId, p.employmentId), eq(attendance.attendanceDate, p.date))).limit(1);
  const trace = isAttendanceTrace(record?.calcTrace) ? record.calcTrace : null;
  const [shiftReference] = trace?.schedule.shiftId ? await tx.select({ name: shift.name }).from(shift).where(eq(shift.id, trace.schedule.shiftId)).limit(1) : [];
  const assignments = await tx.select({ department: department.name, businessUnit: businessUnit.name, position: position.title })
    .from(assignment).leftJoin(department, eq(department.id, assignment.departmentId)).leftJoin(businessUnit, eq(businessUnit.id, sql`coalesce(${assignment.businessUnitId},${department.businessUnitId})`))
    .leftJoin(position, eq(position.id, assignment.positionId)).where(and(eq(assignment.employmentId, p.employmentId), isNull(assignment.supersededAt), sql`${assignment.validFrom}<=${p.date}::date`, sql`(${assignment.validTo} is null or ${assignment.validTo}>${p.date}::date)`))
    .orderBy(asc(assignment.id)).limit(2);
  return { record: record ? { id: record.id, checkInAt: record.checkInAt, checkOutAt: record.checkOutAt, status: record.status, dayType: record.dayType, workedMinutes: record.workedMinutes, underMinutes: record.underMinutes } : null,
    schedule: trace?.schedule ?? null, currentShiftName: shiftReference?.name ?? null, organisation: assignments.length === 1 ? assignments[0] : null };
}

/** Current employee codes are labelled as such; a decision's recorded name is never replaced. */
export async function attendanceApproverCodesTx(tx: Tx, ids: readonly string[]) {
  if (!ids.length) return {} as Record<string, string | null>;
  const rows = await tx.select({ id: employment.id, code: employment.employeeCode }).from(employment)
    .where(sql`${employment.id} in (${sql.join([...new Set(ids)].map(id => sql`${id}::uuid`), sql`,`)})`).orderBy(asc(employment.id));
  return Object.fromEntries(rows.map(row => [row.id, row.code]));
}
