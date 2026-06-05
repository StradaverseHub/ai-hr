/**
 * Organizational lifecycle services (ADR-0003). Each mutation runs inside `withTenant`
 * (one transaction, RLS scoped to the session) and appends a domain event before returning.
 * Effective-dated changes CLOSE + INSERT; we never overwrite history.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { person, employment, assignment, reportingLine, leaveLedger, leavePolicy } from '../db/schema';

export class ReportingCycleError extends Error {
  constructor() {
    super('Reporting line rejected: would create an administrative cycle');
    this.name = 'ReportingCycleError';
  }
}

type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'intern';
type LineType = 'administrative' | 'functional' | 'project' | 'dotted';

export type HireParams = {
  person: { id?: string; fullName?: string; primaryEmail?: string; phone?: string };
  companyId: string;
  departmentId: string;
  positionId?: string;
  costCenterId?: string;
  employmentType: EmploymentType;
  hiredOn: string; // 'YYYY-MM-DD'
  annualLeaveTypeId?: string; // grant pro-rated annual leave on hire if provided
};

/** Pro-rated annual grant = annualDays * (months remaining in hire year / 12). */
async function proratedAnnualGrant(
  tx: Tx,
  leaveTypeId: string,
  hiredOn: string,
): Promise<number> {
  const rows = await tx
    .select({ accrual: leavePolicy.accrual })
    .from(leavePolicy)
    .where(
      and(
        eq(leavePolicy.leaveTypeId, leaveTypeId),
        sql`${leavePolicy.validFrom} <= ${hiredOn}`,
        sql`(${leavePolicy.validTo} IS NULL OR ${leavePolicy.validTo} > ${hiredOn})`,
      ),
    )
    .limit(1);
  if (rows.length === 0) return 0;
  const annualDays = Number((rows[0].accrual as { annualDays?: number })?.annualDays ?? 0);
  const month = Number(hiredOn.slice(5, 7)); // 1..12
  const remaining = 12 - (month - 1);
  return Math.round(((annualDays * remaining) / 12) * 100) / 100;
}

export async function hireEmployee(ctx: SessionContext, p: HireParams) {
  return withTenant(ctx, async (tx) => {
    let personId = p.person.id;
    if (!personId) {
      const [row] = await tx
        .insert(person)
        .values({
          tenantId: ctx.tenantId,
          fullName: p.person.fullName!,
          primaryEmail: p.person.primaryEmail!,
          phone: p.person.phone ?? null,
        })
        .returning({ id: person.id });
      personId = row.id;
    }

    const [emp] = await tx
      .insert(employment)
      .values({ tenantId: ctx.tenantId, personId, companyId: p.companyId, hiredOn: p.hiredOn })
      .returning({ id: employment.id });

    await tx.insert(assignment).values({
      tenantId: ctx.tenantId,
      employmentId: emp.id,
      departmentId: p.departmentId,
      positionId: p.positionId ?? null,
      costCenterId: p.costCenterId ?? null,
      employmentType: p.employmentType,
      status: 'active',
      validFrom: p.hiredOn,
      validTo: null,
    });

    if (p.annualLeaveTypeId) {
      const grant = await proratedAnnualGrant(tx, p.annualLeaveTypeId, p.hiredOn);
      if (grant > 0) {
        await tx.insert(leaveLedger).values({
          tenantId: ctx.tenantId,
          employmentId: emp.id,
          leaveTypeId: p.annualLeaveTypeId,
          entryType: 'accrual',
          days: grant.toFixed(2),
          effectiveOn: p.hiredOn,
        });
      }
    }

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: emp.id,
      eventType: 'employment.hired',
      actor: actorOf(ctx),
      payload: { personId, companyId: p.companyId, departmentId: p.departmentId, hiredOn: p.hiredOn },
    });

    return { employmentId: emp.id, personId };
  });
}

export async function transferEmployee(
  ctx: SessionContext,
  p: { employmentId: string; effectiveDate: string; departmentId?: string; positionId?: string; costCenterId?: string },
) {
  return withTenant(ctx, async (tx) => {
    const [cur] = await tx
      .select()
      .from(assignment)
      .where(
        and(
          eq(assignment.employmentId, p.employmentId),
          isNull(assignment.validTo),
          isNull(assignment.supersededAt),
        ),
      )
      .limit(1);
    if (!cur) throw new Error('No open assignment to transfer');

    // CLOSE current (set valid_to), then INSERT the new version — ranges don't overlap.
    await tx.update(assignment).set({ validTo: p.effectiveDate }).where(eq(assignment.id, cur.id));
    const [next] = await tx
      .insert(assignment)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        departmentId: p.departmentId ?? cur.departmentId,
        positionId: p.positionId ?? cur.positionId,
        costCenterId: p.costCenterId ?? cur.costCenterId,
        employmentType: cur.employmentType,
        status: cur.status,
        validFrom: p.effectiveDate,
        validTo: null,
      })
      .returning({ id: assignment.id });

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'assignment',
      aggregateId: next.id,
      eventType: 'assignment.transferred',
      actor: actorOf(ctx),
      payload: {
        employmentId: p.employmentId,
        from: { departmentId: cur.departmentId },
        to: { departmentId: p.departmentId ?? cur.departmentId },
        effectiveDate: p.effectiveDate,
      },
    });
    return { assignmentId: next.id };
  });
}

export async function terminateEmployment(
  ctx: SessionContext,
  p: { employmentId: string; terminationDate: string },
) {
  return withTenant(ctx, async (tx) => {
    await tx
      .update(employment)
      .set({ terminatedOn: p.terminationDate })
      .where(eq(employment.id, p.employmentId));
    const [cur] = await tx
      .select()
      .from(assignment)
      .where(
        and(
          eq(assignment.employmentId, p.employmentId),
          isNull(assignment.validTo),
          isNull(assignment.supersededAt),
        ),
      )
      .limit(1);
    if (cur) {
      await tx.update(assignment).set({ validTo: p.terminationDate }).where(eq(assignment.id, cur.id));
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employment.terminated',
      actor: actorOf(ctx),
      payload: { terminationDate: p.terminationDate },
    });
  });
}

/** Walk the administrative graph UP from `manager`; cycle if we reach `subordinate`. */
async function wouldCreateAdminCycle(
  tx: Tx,
  subordinateId: string,
  managerId: string,
  asOf: string,
): Promise<boolean> {
  const res = await tx.execute(sql`
    WITH RECURSIVE ancestors AS (
      SELECT manager_employment_id AS mgr
      FROM reporting_line
      WHERE subordinate_employment_id = ${managerId}
        AND line_type = 'administrative' AND superseded_at IS NULL
        AND valid_from <= ${asOf} AND (valid_to IS NULL OR valid_to > ${asOf})
      UNION
      SELECT rl.manager_employment_id
      FROM reporting_line rl
      JOIN ancestors a ON rl.subordinate_employment_id = a.mgr
      WHERE rl.line_type = 'administrative' AND rl.superseded_at IS NULL
        AND rl.valid_from <= ${asOf} AND (rl.valid_to IS NULL OR rl.valid_to > ${asOf})
    )
    SELECT 1 FROM ancestors WHERE mgr = ${subordinateId} LIMIT 1
  `);
  return res.length > 0;
}

export async function setReportingLine(
  ctx: SessionContext,
  p: { subordinateEmploymentId: string; managerEmploymentId: string; lineType: LineType; validFrom: string },
) {
  return withTenant(ctx, async (tx) => {
    if (p.subordinateEmploymentId === p.managerEmploymentId) throw new ReportingCycleError();
    if (p.lineType === 'administrative') {
      if (await wouldCreateAdminCycle(tx, p.subordinateEmploymentId, p.managerEmploymentId, p.validFrom)) {
        throw new ReportingCycleError();
      }
    }
    const [row] = await tx
      .insert(reportingLine)
      .values({
        tenantId: ctx.tenantId,
        subordinateEmploymentId: p.subordinateEmploymentId,
        managerEmploymentId: p.managerEmploymentId,
        lineType: p.lineType,
        validFrom: p.validFrom,
        validTo: null,
      })
      .returning({ id: reportingLine.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'reporting-line',
      aggregateId: row.id,
      eventType: 'reporting-line.set',
      actor: actorOf(ctx),
      payload: { ...p },
    });
    return { reportingLineId: row.id };
  });
}

/** Reconstruct the assignment in force for an employment as of `asOf` (ADR-0001). */
export async function getAssignmentAsOf(ctx: SessionContext, employmentId: string, asOf: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(assignment)
      .where(
        and(
          eq(assignment.employmentId, employmentId),
          isNull(assignment.supersededAt),
          sql`${assignment.validFrom} <= ${asOf}`,
          sql`(${assignment.validTo} IS NULL OR ${assignment.validTo} > ${asOf})`,
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function endReportingLine(
  ctx: SessionContext,
  p: { reportingLineId: string; endDate: string },
) {
  return withTenant(ctx, async (tx) => {
    await tx.update(reportingLine).set({ validTo: p.endDate }).where(eq(reportingLine.id, p.reportingLineId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'reporting-line',
      aggregateId: p.reportingLineId,
      eventType: 'reporting-line.ended',
      actor: actorOf(ctx),
      payload: { endDate: p.endDate },
    });
  });
}
