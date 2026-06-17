/**
 * Organizational lifecycle services (ADR-0003). Each mutation runs inside `withTenant`
 * (one transaction, RLS scoped to the session) and appends a domain event before returning.
 * Effective-dated changes CLOSE + INSERT; we never overwrite history.
 */
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf, subjectEmploymentForPerson } from '../db/events';
import { nextEmployeeCode } from './comp';
import { packFor } from '../localization/registry';
import {
  person,
  employment,
  assignment,
  company,
  leavePolicy,
  reportingLine,
  leaveLedger,
} from '../db/schema';

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
  /** Standing entitlements to grant on hire (pack-driven). Pass ANNUAL / SICK /
   *  HOSPITALIZATION; situational types (maternity etc.) are claimed per event, not granted. */
  grantLeaveTypes?: { id: string; code: string }[];
};

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

    const employeeCode = await nextEmployeeCode(tx, ctx.tenantId);
    const [emp] = await tx
      .insert(employment)
      .values({ tenantId: ctx.tenantId, personId, companyId: p.companyId, hiredOn: p.hiredOn, employeeCode })
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

    if (p.grantLeaveTypes?.length) {
      // Entitlement = max(statutory floor, company policy). The floor comes from the
      // company's country pack (law — not configurable); the admin-configured
      // leave_policy may be MORE generous but is clamped at the floor, never below.
      const [co] = await tx
        .select({ country: company.country })
        .from(company)
        .where(eq(company.id, p.companyId))
        .limit(1);
      const pack = packFor(co?.country);
      if (pack) {
        const policies = await tx
          .select({ leaveTypeId: leavePolicy.leaveTypeId, accrual: leavePolicy.accrual })
          .from(leavePolicy)
          .where(
            and(
              inArray(
                leavePolicy.leaveTypeId,
                p.grantLeaveTypes.map((t) => t.id),
              ),
              lte(leavePolicy.validFrom, p.hiredOn),
              or(isNull(leavePolicy.validTo), gt(leavePolicy.validTo, p.hiredOn)),
            ),
          );
        // Overlapping policies for a type: the most generous active one applies.
        const policyDays = new Map<string, number>();
        for (const pol of policies) {
          const d = Number((pol.accrual as { annualDays?: number })?.annualDays ?? 0);
          if (d > (policyDays.get(pol.leaveTypeId) ?? 0)) policyDays.set(pol.leaveTypeId, d);
        }
        const month = Number(p.hiredOn.slice(5, 7));
        for (const lt of p.grantLeaveTypes) {
          const floor = pack.leave.entitlement(lt.code, 0);
          const days = Math.max(floor, policyDays.get(lt.id) ?? 0);
          if (days <= 0) continue;
          // ANNUAL pro-rates by months remaining in the hire year (s.60E practice).
          // SICK / HOSPITALIZATION grant in full: s.60F is a per-calendar-year
          // entitlement and must not be prorated for mid-year joiners.
          const grant =
            lt.code === 'ANNUAL'
              ? Math.round(((days * (12 - (month - 1))) / 12) * 100) / 100
              : days;
          if (grant <= 0) continue;
          await tx.insert(leaveLedger).values({
            tenantId: ctx.tenantId,
            employmentId: emp.id,
            leaveTypeId: lt.id,
            entryType: 'accrual',
            days: grant.toFixed(2),
            effectiveOn: p.hiredOn,
          });
        }
      }
    }

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: emp.id,
      eventType: 'employment.hired',
      actor: actorOf(ctx),
      subjectEmploymentId: emp.id,
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
      subjectEmploymentId: p.employmentId,
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

export type TerminationType =
  | 'voluntary'
  | 'involuntary'
  | 'retired'
  | 'contract_end'
  | 'death'
  | 'other';

export async function terminateEmployment(
  ctx: SessionContext,
  p: { employmentId: string; terminationDate: string; terminationType?: TerminationType; terminationReason?: string },
) {
  return withTenant(ctx, async (tx) => {
    await tx
      .update(employment)
      .set({
        terminatedOn: p.terminationDate,
        // Wave 4A: capture the turnover classification (null when not provided).
        terminationType: p.terminationType ?? null,
        terminationReason: p.terminationReason?.trim() || null,
      })
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
      subjectEmploymentId: p.employmentId,
      payload: {
        terminationDate: p.terminationDate,
        terminationType: p.terminationType ?? null,
        terminationReason: p.terminationReason?.trim() || null,
      },
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
      subjectEmploymentId: p.subordinateEmploymentId,
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
    const [ended] = await tx
      .update(reportingLine)
      .set({ validTo: p.endDate })
      .where(eq(reportingLine.id, p.reportingLineId))
      .returning({ subordinate: reportingLine.subordinateEmploymentId });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'reporting-line',
      aggregateId: p.reportingLineId,
      eventType: 'reporting-line.ended',
      actor: actorOf(ctx),
      subjectEmploymentId: ended?.subordinate ?? null,
      payload: { endDate: p.endDate },
    });
  });
}

export type CostAllocationEntry = { companyId: string; percent: number };

/**
 * Set an employment's inter-company cost split (ADR-0009). For shared-services staff whose
 * cost is recharged across group companies — feeds consolidation/management reporting (the
 * cash payroll still runs at the employing company). Pass [] to clear.
 */
export async function setCostAllocation(
  ctx: SessionContext,
  p: { employmentId: string; allocations: CostAllocationEntry[] },
) {
  return withTenant(ctx, async (tx) => {
    await tx
      .update(employment)
      .set({ costAllocation: p.allocations })
      .where(eq(employment.id, p.employmentId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employment.cost-allocation.set',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { allocations: p.allocations },
    });
    return { id: p.employmentId };
  });
}

/**
 * Edit an employee's core person fields (name / email / phone). A person is shared across all of
 * their (possibly multi-company) employments, so this updates the single canonical record. RLS
 * requires admin (person policy WITH CHECK app.is_admin()). Appends a before/after domain event.
 */
export async function updatePerson(
  ctx: SessionContext,
  p: { personId: string; fullName: string; primaryEmail: string; phone?: string | null },
) {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({
        fullName: person.fullName,
        primaryEmail: person.primaryEmail,
        phone: person.phone,
      })
      .from(person)
      .where(eq(person.id, p.personId))
      .limit(1);
    if (!before) throw new Error('Person not found');
    const after = {
      fullName: p.fullName.trim(),
      primaryEmail: p.primaryEmail.trim(),
      phone: p.phone?.trim() || null,
    };
    if (!after.fullName) throw new Error('Name is required');
    if (!after.primaryEmail) throw new Error('Email is required');
    await tx.update(person).set(after).where(eq(person.id, p.personId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'person',
      aggregateId: p.personId,
      eventType: 'person.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
      payload: { before, after },
    });
    return { id: p.personId };
  });
}
