import {and,desc,eq,sql} from 'drizzle-orm';
import type {SessionContext} from '../../db/client';
import {withAttendanceTenant as withTenant} from '../../core/module-gate';
import {attendanceCorrection} from '../../db/schema';
import {assertAssignedWorkPrincipalTx} from '../../core/approvals';
import {actionableAttendanceApplicationIdsTx} from '../../core/attendance-workflow';
import type {AssignedApprovalMetadata} from '../../lib/assigned-work';

// Frozen bf8056f493681afe6c9ede72b74d89f4c6d7a0ef implementation, with every native owner intact.
export function legacyPendingAttendanceTaskMetadata(ctx:SessionContext,companyIds?:string[]):Promise<AssignedApprovalMetadata[]>{
  return withTenant(ctx,async tx=>{
    await assertAssignedWorkPrincipalTx(tx,ctx);
    // A negative result proves no possible assignment source. Positives retain every native
    // request RLS and live decision proof below; this result never authorizes a command or is cached.
    const [candidate]=await tx.execute<{possible:boolean}>(sql`select app.may_have_attendance_task_metadata() as possible`);
    if(candidate?.possible===false)return [];
    const rows=await tx.select({id:attendanceCorrection.id,employmentId:attendanceCorrection.employmentId,
      personId:sql<string>`subject.person_id`,employee:sql<string|null>`subject.employee`,createdAt:attendanceCorrection.createdAt})
      .from(attendanceCorrection)
      .innerJoin(sql`LATERAL app.attendance_application_subject(${attendanceCorrection.id}) AS subject`,sql`true`)
      .where(and(eq(attendanceCorrection.tenantId,ctx.tenantId),eq(attendanceCorrection.status,'pending'),
        sql`NOT app.is_self_person(subject.person_id)`,companyIds===undefined?undefined:companyIds.length===0?sql`false`:
          sql`(subject.company_id IN (${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`,`)}) OR app.attendance_workflow_v3_decision_slot(${attendanceCorrection.id}) IS NOT NULL)`))
      .orderBy(desc(attendanceCorrection.createdAt),attendanceCorrection.id);
    const allowed=await actionableAttendanceApplicationIdsTx(tx,ctx,rows);
    return rows.filter(row=>allowed.has(row.id));
  });
}
