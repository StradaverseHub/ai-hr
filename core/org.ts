/**
 * Organizational lifecycle services (ADR-0003). Each mutation runs inside `withTenant`
 * (one transaction, RLS scoped to the session) and appends a domain event before returning.
 * Effective-dated changes CLOSE + INSERT; we never overwrite history.
 */
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf, subjectEmploymentForPerson } from '../db/events';
import { nextEmployeeCode } from './comp';
import { generateEmployeeCode } from './employee-id-config';
import { requireEmployeeCode } from '../lib/employee-code';
import { applyMaxBalance, isEarnedMethod, resolveGradePolicy, type GradePolicyRow } from './leave';
import { packFor } from '../localization/registry';
import { labelUsableByCompany } from './system-labels';
import { assertProfileValueAllowed, type ProfileOptionCategory } from './profile-options';
import {
  person,
  employment,
  assignment,
  businessUnit,
  company,
  costCenter,
  department,
  holidayGroup,
  leavePolicy,
  location,
  position,
  reportingLine,
  leaveLedger,
  employmentTypeEnum,
  assignmentStatusEnum,
} from '../db/schema';

export type EmploymentTypeValue = (typeof employmentTypeEnum.enumValues)[number];
export type AssignmentStatusValue = (typeof assignmentStatusEnum.enumValues)[number];

/** Hiring enhancement: a position / cost-center / department chosen for a hire must belong to the
 *  company the employment is created under. Client filtering is not a source of truth — this is the
 *  server-side guard (positions & cost-centers carry company_id; departments carry it via hierarchy).
 *  job_grade is tenant-wide (no company_id) so it is intentionally NOT checked. */
export class CrossCompanyError extends Error {
  constructor(entity: 'position' | 'cost-center' | 'department' | 'location' | 'business-unit' | 'employment') {
    super(`The selected ${entity} does not belong to the hiring company`);
    this.name = 'CrossCompanyError';
  }
}

export class ReportingCycleError extends Error {
  constructor() {
    super('Reporting line rejected: would create an administrative cycle');
    this.name = 'ReportingCycleError';
  }
}

type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'intern';
type LineType = 'administrative' | 'functional' | 'project' | 'dotted' | 'delegate';

export type HireParams = {
  person: { id?: string; fullName?: string; primaryEmail?: string; phone?: string };
  companyId: string;
  departmentId: string;
  positionId?: string;
  costCenterId?: string;
  employmentType: EmploymentType;
  hiredOn: string; // 'YYYY-MM-DD'
  /** Employee ID keyed in by HR (feedback 38668d9b). The hire form and the bulk import both REQUIRE a
   *  value; it is validated (alphanumeric + dash, max 9 chars) and must be unique within the tenant. Left
   *  optional on the type only so the demo seed and the large test corpus keep compiling — when omitted the
   *  system falls back to the auto counter (EMP-####). Every HR-facing path passes an explicit code, so HR
   *  owns the ID in production. */
  employeeCode?: string;
  /** Seniority grade (ADR-0041 2E) — drives grade-scoped leave entitlements. Optional; null = ungraded. */
  gradeId?: string | null;
  /** Hiring enhancement: the administrative manager this new hire reports to (an employment id). When
   *  set, an open administrative reporting_line is created on hire. Optional; cross-company managers are
   *  intentionally allowed (the reporting_line schema permits cross-company lines). */
  reportingManagerEmploymentId?: string;
  /** Hiring enhancement: provisional/lifecycle end date ('YYYY-MM-DD' or null), interpreted by
   *  employmentType (probation end for full_time, contract/internship end otherwise). The server action
   *  is the source of truth: it computes the full_time default via computeProvisionalEndOn. */
  provisionalEndOn?: string | null;
  /** Standing entitlements to grant on hire (pack-driven). Pass ANNUAL / SICK /
   *  HOSPITALIZATION; situational types (maternity etc.) are claimed per event, not granted. */
  grantLeaveTypes?: { id: string; code: string }[];
};

/** Days in a given month (1-based month). */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of `month` (Date.UTC normalises month overflow).
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Hiring enhancement — the server-side single source of truth for a hire's default provisional end date.
 * full_time → hire + `probationMonths` calendar months (default 3) with clamp-to-last-day-of-month (pure
 * UTC string math, no Date TZ drift): parse Y/M/D, add the months, then clamp the day to the target month's
 * last day so 2026-11-30 + 3mo → 2027-02-28 (not an overflow into March). The probationMonths arg applies
 * ONLY to full_time — contract / intern / part_time → null (their fixed-term length is user-supplied, so
 * the configurable default does NOT touch them). Exported for unit tests and the page's default render.
 */
export function computeProvisionalEndOn(
  hiredOn: string,
  employmentType: EmploymentType,
  probationMonths = 3,
): string | null {
  if (employmentType !== 'full_time') return null;
  const y = Number(hiredOn.slice(0, 4));
  const m = Number(hiredOn.slice(5, 7));
  const d = Number(hiredOn.slice(8, 10));
  // Add probationMonths in 1-based month arithmetic.
  const total = m - 1 + probationMonths; // 0-based month index after adding the months
  const targetYear = y + Math.floor(total / 12);
  const targetMonth = (total % 12) + 1; // back to 1-based
  const clampedDay = Math.min(d, daysInMonth(targetYear, targetMonth));
  const mm = String(targetMonth).padStart(2, '0');
  const dd = String(clampedDay).padStart(2, '0');
  return `${targetYear}-${mm}-${dd}`;
}

/** Resolve a company's configured default probation length in months. Null/legacy config → 3 (the EA
 *  practice default). Any positive integer honoured; a non-positive stored value falls back to 3. */
export function resolveProbationMonths(probationMonths: number | null | undefined): number {
  return probationMonths != null && probationMonths > 0 ? probationMonths : 3;
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

    // Server-side cross-company guard (source of truth — client filtering is not). The chosen
    // department / position / cost-center must be a label the hiring company MAY use. Shared System
    // Labels (62de487d): this is now the resolver check (origin ∪ shared-in ∪ global, flag-gated) rather
    // than a strict company_id match — with the flag OFF it collapses to the old origin-only strictness,
    // so nothing changes until a company opts in. grade_id is tenant-wide (no company_id), not checked.
    if (!(await labelUsableByCompany(tx, ctx.tenantId, 'department', p.departmentId, p.companyId))) {
      throw new CrossCompanyError('department');
    }
    if (p.positionId && !(await labelUsableByCompany(tx, ctx.tenantId, 'position', p.positionId, p.companyId))) {
      throw new CrossCompanyError('position');
    }
    if (p.costCenterId && !(await labelUsableByCompany(tx, ctx.tenantId, 'cost_center', p.costCenterId, p.companyId))) {
      throw new CrossCompanyError('cost-center');
    }

    const provisionalEndOn = p.provisionalEndOn ?? null;
    // Employee ID (feedback 38668d9b): HR keys it in (hire form + bulk import always pass one). Validate +
    // normalize + tenant-uniqueness pre-check. Only when no code is supplied (seed / test corpus) do we fall
    // back to the auto counter, so HR owns the ID everywhere it is user-driven.
    let employeeCode: string;
    if (p.employeeCode != null && p.employeeCode.trim() !== '') {
      employeeCode = requireEmployeeCode(p.employeeCode);
      await assertEmployeeCodeUnique(tx, ctx.tenantId, employeeCode);
    } else {
      // Employee ID Auto Running Number Setup (feedback 3d0031e6): when an ACTIVE config resolves for this
      // hire's company (company-specific first, else the tenant-wide GLOBAL config), generate the code from it
      // and advance its running number. With NO active config the legacy EMP-#### counter still runs, keeping
      // the demo seed + test corpus byte-identical. employment_employee_code_uq is the ultimate collision net.
      const generated = await generateEmployeeCode(tx, ctx.tenantId, p.companyId);
      employeeCode = generated ?? (await nextEmployeeCode(tx, ctx.tenantId));
    }
    const [emp] = await tx
      .insert(employment)
      .values({ tenantId: ctx.tenantId, personId, companyId: p.companyId, hiredOn: p.hiredOn, employeeCode, gradeId: p.gradeId ?? null, provisionalEndOn })
      .returning({ id: employment.id });

    // A new hire serving a provisional period is on 'probation', not 'active': interns/contractors
    // always, and a full_time hire only when a probation end date applies. Storing a provisional end
    // date while claiming 'active' would contradict every downstream reader of assignment.status. The
    // probation→active completion workflow is out of scope for this slice (a follow-up).
    const assignmentStatus =
      (p.employmentType === 'full_time' && provisionalEndOn) ||
      p.employmentType === 'contract' ||
      p.employmentType === 'intern'
        ? ('probation' as const)
        : ('active' as const);

    await tx.insert(assignment).values({
      tenantId: ctx.tenantId,
      employmentId: emp.id,
      departmentId: p.departmentId,
      positionId: p.positionId ?? null,
      costCenterId: p.costCenterId ?? null,
      employmentType: p.employmentType,
      status: assignmentStatus,
      validFrom: p.hiredOn,
      validTo: null,
    });

    // Reporting line on hire (inline insert — no supersede / cycle guard needed: a brand-new
    // employment has no prior line and cannot form a cycle). Cross-company managers are allowed by design.
    if (p.reportingManagerEmploymentId) {
      const [rl] = await tx
        .insert(reportingLine)
        .values({
          tenantId: ctx.tenantId,
          subordinateEmploymentId: emp.id,
          managerEmploymentId: p.reportingManagerEmploymentId,
          lineType: 'administrative',
          validFrom: p.hiredOn,
          validTo: null,
        })
        .returning({ id: reportingLine.id });
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'reporting-line',
        aggregateId: rl.id,
        eventType: 'reporting-line.set',
        actor: actorOf(ctx),
        subjectEmploymentId: emp.id,
        payload: {
          subordinateEmploymentId: emp.id,
          managerEmploymentId: p.reportingManagerEmploymentId,
          lineType: 'administrative',
          validFrom: p.hiredOn,
        },
      });
    }

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
          .select({ leaveTypeId: leavePolicy.leaveTypeId, gradeId: leavePolicy.gradeId, companyId: leavePolicy.companyId, accrual: leavePolicy.accrual })
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
        // 2E (ADR-0041): group by type so the grant resolves the policy for the new hire's grade
        // (grade-specific → company-default → floor); with no grade this is the old most-generous pick.
        const policyByType = new Map<string, GradePolicyRow[]>();
        for (const pol of policies) {
          const arr = policyByType.get(pol.leaveTypeId);
          if (arr) arr.push(pol);
          else policyByType.set(pol.leaveTypeId, [pol]);
        }
        const month = Number(p.hiredOn.slice(5, 7));
        for (const lt of p.grantLeaveTypes) {
          // ADR-0066: scope to the new hire's company so a per-company UPFRONT entitlement reaches joiners.
          // Leave Entitlement Rules Engine: a new hire has 0 completed years of service (explicit — the
          // param is required so a band-configured policy resolves its 0-year band at hire).
          const polFor = resolveGradePolicy(policyByType.get(lt.id) ?? [], p.gradeId ?? null, p.companyId, 0);
          // 2D (ADR-0040): earned types accrue through the year via accrueEarnedLeave, not the hire lump.
          if (isEarnedMethod(polFor?.method)) continue;
          const floor = pack.leave.entitlement(lt.code, 0);
          const days = Math.max(floor, polFor?.days ?? 0);
          if (days <= 0) continue;
          // ANNUAL pro-rates by months remaining in the hire year (s.60E practice).
          // SICK / HOSPITALIZATION grant in full: s.60F is a per-calendar-year
          // entitlement and must not be prorated for mid-year joiners.
          const grantRaw =
            lt.code === 'ANNUAL'
              ? Math.round(((days * (12 - (month - 1))) / 12) * 100) / 100
              : days;
          // Feedback 9d8cf621 — Maximum Balance Days: a new hire has 0 prior balance, so clamp the initial
          // grant so it never opens above the resolved band's cap. null ⇒ pass-through (grant unchanged).
          const { grant } = applyMaxBalance(0, grantRaw, polFor?.maxBalanceDays);
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
      // Backward-compat: the original keys (personId, companyId, departmentId, hiredOn) are PRESERVED
      // unrenamed (CP22/CP22A worklist + audit view read them). The hiring enhancement only ADDS keys.
      payload: {
        personId,
        companyId: p.companyId,
        departmentId: p.departmentId,
        hiredOn: p.hiredOn,
        positionId: p.positionId ?? null,
        costCenterId: p.costCenterId ?? null,
        gradeId: p.gradeId ?? null,
        employmentType: p.employmentType,
        assignmentStatus,
        provisionalEndOn,
        // Additive only (feedback 38668d9b) — original keys above are preserved for CP22/audit readers.
        employeeCode,
      },
    });

    return { employmentId: emp.id, personId };
  });
}

export async function transferEmployee(
  ctx: SessionContext,
  p: {
    employmentId: string;
    effectiveDate: string;
    departmentId?: string;
    positionId?: string;
    costCenterId?: string;
    // Location master data (ADR-0054): `undefined` = carry the current version's location unchanged;
    // a location id = set it; `null` = clear it. A non-null id must belong to the employment's company
    // (cross-company coherence — RLS checks assignment and location independently, so it can't enforce
    // this; the service does).
    locationId?: string | null;
  },
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

    const nextLocationId = p.locationId === undefined ? cur.locationId : p.locationId;
    if (nextLocationId) {
      const [emp] = await tx
        .select({ companyId: employment.companyId })
        .from(employment)
        .where(eq(employment.id, p.employmentId))
        .limit(1);
      const [loc] = await tx
        .select({ companyId: location.companyId })
        .from(location)
        .where(eq(location.id, nextLocationId))
        .limit(1);
      if (!loc) throw new Error('Location not found');
      if (!emp || loc.companyId !== emp.companyId) {
        throw new CrossCompanyError('location');
      }
    }

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
        locationId: nextLocationId,
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
        from: { departmentId: cur.departmentId, locationId: cur.locationId },
        to: { departmentId: p.departmentId ?? cur.departmentId, locationId: nextLocationId },
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

/** The termination write, runnable inside a caller's transaction — so an accepted resignation can
 *  terminate atomically (ADR-0042). Sets the leave date + turnover classification, closes the open
 *  assignment version, and emits employment.terminated. */
export async function terminateEmploymentTx(
  tx: Tx,
  ctx: SessionContext,
  p: { employmentId: string; terminationDate: string; terminationType?: TerminationType; terminationReason?: string },
) {
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

  // Hierarchy Management (ADR-0052, Step 3): close this employment's OPEN administrative reporting-line
  // edges — both as manager and as subordinate — at the termination date, so a multi-hop visibility
  // DOWN-walk never traverses THROUGH a terminated manager (which would surface their former subtree).
  // The recursive helper also filters terminated_on at each hop (belt-and-suspenders); ending the edges
  // keeps the graph itself clean for the org chart and approver lookups. Each closure is evented.
  const endedLines = await tx
    .update(reportingLine)
    .set({ validTo: p.terminationDate })
    .where(
      and(
        eq(reportingLine.lineType, 'administrative'),
        isNull(reportingLine.validTo),
        isNull(reportingLine.supersededAt),
        or(
          eq(reportingLine.managerEmploymentId, p.employmentId),
          eq(reportingLine.subordinateEmploymentId, p.employmentId),
        ),
      ),
    )
    .returning({ id: reportingLine.id, subordinate: reportingLine.subordinateEmploymentId });
  for (const line of endedLines) {
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'reporting-line',
      aggregateId: line.id,
      eventType: 'reporting-line.ended',
      actor: actorOf(ctx),
      subjectEmploymentId: line.subordinate,
      payload: { endDate: p.terminationDate, reason: 'employment.terminated' },
    });
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
}

export async function terminateEmployment(
  ctx: SessionContext,
  p: { employmentId: string; terminationDate: string; terminationType?: TerminationType; terminationReason?: string },
) {
  return withTenant(ctx, (tx) => terminateEmploymentTx(tx, ctx, p));
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

export class DelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegationError';
  }
}

/**
 * Global Delegation (Phase 1) — does `employmentId` currently HAVE a downline, i.e. is it the manager of
 * ≥1 active administrative reporting line? Delegation only makes sense for an approver: the decision-time
 * guard (app.can_decide_via_delegation) requires the DELEGATOR to be the subject's current administrative
 * manager, so an employee with no reports has no approver duty to hand over. Self-service create reuses this
 * as its gate. Read-only (no DomainEvent). Runs inside the caller's tx so the self-service action can guard
 * in the same RLS scope; RLS on reporting_line is tenant-only, so this is not a visibility widen.
 */
export async function hasDownlineTx(tx: Tx, employmentId: string, asOf: string): Promise<boolean> {
  const rows = await tx
    .select({ id: reportingLine.id })
    .from(reportingLine)
    .where(
      and(
        eq(reportingLine.managerEmploymentId, employmentId),
        eq(reportingLine.lineType, 'administrative'),
        isNull(reportingLine.supersededAt),
        lte(reportingLine.validFrom, asOf),
        or(isNull(reportingLine.validTo), gt(reportingLine.validTo, asOf)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Session-scoped wrapper for `hasDownlineTx` (opens its own tx). */
export async function hasDownline(ctx: SessionContext, employmentId: string, asOf: string): Promise<boolean> {
  return withTenant(ctx, (tx) => hasDownlineTx(tx, employmentId, asOf));
}

/**
 * The delegate-edge insert, extracted so both `setReportingLine` (lineType 'delegate') and `editDelegation`
 * (supersede + recreate) share ONE overlap guard + insert + event pair. subordinate = delegator,
 * manager = delegate. Rejects self-delegation, a window whose end precedes its start, and an OVERLAPPING
 * active delegation of the SAME delegator (rule #2 — two stand-ins can't both hold authority over one
 * window). Emits the structural `reporting-line.set` (audit) plus the delegation-specific `delegation.started`
 * (notification fan-out to the stand-in). Runs inside the caller's tx.
 */
async function insertDelegateLineTx(
  tx: Tx,
  ctx: SessionContext,
  p: { subordinateEmploymentId: string; managerEmploymentId: string; validFrom: string; validTo: string | null },
): Promise<{ reportingLineId: string }> {
  if (p.subordinateEmploymentId === p.managerEmploymentId) throw new ReportingCycleError();
  if (p.validTo != null && p.validTo < p.validFrom) {
    throw new DelegationError('The end date must be on or after the start date');
  }
  const existing = await tx
    .select({ id: reportingLine.id, validFrom: reportingLine.validFrom, validTo: reportingLine.validTo })
    .from(reportingLine)
    .where(
      and(
        eq(reportingLine.subordinateEmploymentId, p.subordinateEmploymentId),
        eq(reportingLine.lineType, 'delegate'),
        isNull(reportingLine.supersededAt),
      ),
    );
  const newFrom = p.validFrom;
  const newTo = p.validTo ?? null;
  for (const e of existing) {
    const eTo = e.validTo ?? null;
    const overlaps = (eTo === null || newFrom <= eTo) && (newTo === null || e.validFrom <= newTo);
    if (overlaps) throw new DelegationError('An overlapping active delegation already exists for this period');
  }
  const [row] = await tx
    .insert(reportingLine)
    .values({
      tenantId: ctx.tenantId,
      subordinateEmploymentId: p.subordinateEmploymentId,
      managerEmploymentId: p.managerEmploymentId,
      lineType: 'delegate',
      validFrom: p.validFrom,
      validTo: p.validTo ?? null,
    })
    .returning({ id: reportingLine.id });
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'reporting-line',
    aggregateId: row.id,
    eventType: 'reporting-line.set',
    actor: actorOf(ctx),
    subjectEmploymentId: p.subordinateEmploymentId,
    payload: { ...p, lineType: 'delegate' },
  });
  // Global Delegation (Phase 1) — a SECOND, delegation-specific event so notifications can target the
  // stand-in WITHOUT overloading the structural reporting-line.set (which fires for every line type).
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'reporting-line',
    aggregateId: row.id,
    eventType: 'delegation.started',
    actor: actorOf(ctx),
    subjectEmploymentId: p.subordinateEmploymentId,
    payload: {
      delegatorEmploymentId: p.subordinateEmploymentId,
      delegateEmploymentId: p.managerEmploymentId,
      validFrom: p.validFrom,
      validTo: p.validTo ?? null,
    },
  });
  return { reportingLineId: row.id };
}

/**
 * Global Delegation (Phase 1) — edit an existing delegation (HR management). Bitemporal: the old edge is
 * SUPERSEDED (supersededAt set, so it drops out of the active set AND the overlap guard) and a fresh edge is
 * inserted with the new stand-in / window. Emits `reporting-line.superseded` + `delegation.ended` (old) and,
 * via insertDelegateLineTx, `reporting-line.set` + `delegation.started` (new). Only a `delegate` row may be
 * edited here. The subordinate (delegator) is carried forward from the old row — HR changes the stand-in and
 * the window, never who is handing over (that is a separate delegation).
 */
export async function editDelegation(
  ctx: SessionContext,
  p: { reportingLineId: string; managerEmploymentId: string; validFrom: string; validTo: string | null },
) {
  return withTenant(ctx, async (tx) => {
    const [old] = await tx
      .update(reportingLine)
      .set({ supersededAt: sql`now()` })
      .where(and(eq(reportingLine.id, p.reportingLineId), eq(reportingLine.lineType, 'delegate'), isNull(reportingLine.supersededAt)))
      .returning({ subordinate: reportingLine.subordinateEmploymentId, manager: reportingLine.managerEmploymentId });
    if (!old) throw new DelegationError('That delegation no longer exists or was already changed');
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'reporting-line',
      aggregateId: p.reportingLineId,
      eventType: 'reporting-line.superseded',
      actor: actorOf(ctx),
      subjectEmploymentId: old.subordinate,
      payload: { supersededBy: { lineType: 'delegate', managerEmploymentId: p.managerEmploymentId, validFrom: p.validFrom, validTo: p.validTo } },
    });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'reporting-line',
      aggregateId: p.reportingLineId,
      eventType: 'delegation.ended',
      actor: actorOf(ctx),
      subjectEmploymentId: old.subordinate,
      payload: { delegatorEmploymentId: old.subordinate, delegateEmploymentId: old.manager, reason: 'delegation.edited' },
    });
    return insertDelegateLineTx(tx, ctx, {
      subordinateEmploymentId: old.subordinate,
      managerEmploymentId: p.managerEmploymentId,
      validFrom: p.validFrom,
      validTo: p.validTo,
    });
  });
}

export async function setReportingLine(
  ctx: SessionContext,
  p: {
    subordinateEmploymentId: string;
    managerEmploymentId: string;
    lineType: LineType;
    validFrom: string;
    /** Hierarchy Management (ADR-0052): closing date of the edge window. Required-by-convention for
     *  `delegate` lines (an absence has an end); optional for the structural types (open-ended). */
    validTo?: string | null;
  },
) {
  return withTenant(ctx, async (tx) => {
    if (p.subordinateEmploymentId === p.managerEmploymentId) throw new ReportingCycleError();
    // Window guard (ADR-0052 Step 4 rule #3): valid_to may not precede valid_from. Applies to every
    // line type but is the load-bearing guard for a delegation window.
    if (p.validTo != null && p.validTo < p.validFrom) {
      throw new DelegationError('The end date must be on or after the start date');
    }
    if (p.lineType === 'administrative') {
      if (await wouldCreateAdminCycle(tx, p.subordinateEmploymentId, p.managerEmploymentId, p.validFrom)) {
        throw new ReportingCycleError();
      }
    }
    if (p.lineType === 'delegate') {
      return insertDelegateLineTx(tx, ctx, {
        subordinateEmploymentId: p.subordinateEmploymentId,
        managerEmploymentId: p.managerEmploymentId,
        validFrom: p.validFrom,
        validTo: p.validTo ?? null,
      });
    }
    // A subordinate has at most one *active* line per type (one admin manager, one functional, …).
    // There is no DB exclusion constraint, so adding a second of the same type would silently leave
    // two open edges — the org chart would then draw two parents. Supersede the prior active line of
    // this type (CLOSE + INSERT, the same bitemporal pattern as transfer) so the new manager replaces
    // the old one cleanly. validTo can't precede the prior line's own validFrom, so clamp it.
    const [prior] = await tx
      .select({ id: reportingLine.id, validFrom: reportingLine.validFrom })
      .from(reportingLine)
      .where(
        and(
          eq(reportingLine.subordinateEmploymentId, p.subordinateEmploymentId),
          eq(reportingLine.lineType, p.lineType),
          isNull(reportingLine.validTo),
          isNull(reportingLine.supersededAt),
        ),
      )
      .limit(1);
    if (prior) {
      const closeAt = prior.validFrom > p.validFrom ? prior.validFrom : p.validFrom;
      await tx.update(reportingLine).set({ validTo: closeAt }).where(eq(reportingLine.id, prior.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'reporting-line',
        aggregateId: prior.id,
        eventType: 'reporting-line.superseded',
        actor: actorOf(ctx),
        subjectEmploymentId: p.subordinateEmploymentId,
        payload: { endDate: closeAt, supersededBy: { lineType: p.lineType, managerEmploymentId: p.managerEmploymentId } },
      });
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
      .returning({
        subordinate: reportingLine.subordinateEmploymentId,
        manager: reportingLine.managerEmploymentId,
        lineType: reportingLine.lineType,
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'reporting-line',
      aggregateId: p.reportingLineId,
      eventType: 'reporting-line.ended',
      actor: actorOf(ctx),
      subjectEmploymentId: ended?.subordinate ?? null,
      payload: { endDate: p.endDate },
    });
    // Global Delegation (Phase 1) — mirror the .started fan-out: emit a delegation-specific event ONLY when
    // the ended edge was a delegate line, so the stand-in is told their cover has ended. Structural lines
    // (administrative/functional/…) keep emitting only reporting-line.ended (no notification), unchanged.
    if (ended?.lineType === 'delegate') {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'reporting-line',
        aggregateId: p.reportingLineId,
        eventType: 'delegation.ended',
        actor: actorOf(ctx),
        subjectEmploymentId: ended.subordinate,
        payload: {
          delegatorEmploymentId: ended.subordinate,
          delegateEmploymentId: ended.manager,
          endDate: p.endDate,
        },
      });
    }
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
 * The optional profile fields the redesigned Personnel Profile tab maintains (b4682879). Every field is
 * `string | null | undefined` where `undefined` = "not on this form, leave unchanged" and `null`/'' = clear.
 * These are all low-risk instant-write fields (names, structured address, extended emergency contact,
 * demographics) — the compliance-sensitive DOB / gender / marital fields stay on setPersonComplianceFields.
 */
export type PersonProfileFields = {
  firstName?: string | null;
  lastName?: string | null;
  preferredName?: string | null;
  religion?: string | null;
  race?: string | null;
  nationality?: string | null;
  personalEmail?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  addressLine3?: string | null;
  postcode?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  // 3a25f5ee — Permanent + Correspondence structured addresses (migration 0213). Independent of the legacy
  // single address above (retained for rollback). Each is 7 fields; state/country are catalog-backed.
  permanentAddressLine1?: string | null;
  permanentAddressLine2?: string | null;
  permanentAddressLine3?: string | null;
  permanentPostcode?: string | null;
  permanentCity?: string | null;
  permanentState?: string | null;
  permanentCountry?: string | null;
  correspondenceAddressLine1?: string | null;
  correspondenceAddressLine2?: string | null;
  correspondenceAddressLine3?: string | null;
  correspondencePostcode?: string | null;
  correspondenceCity?: string | null;
  correspondenceState?: string | null;
  correspondenceCountry?: string | null;
  emergencyContactName?: string | null;
  emergencyContactRelationship?: string | null;
  emergencyContactPhone?: string | null;
  emergencyContactPhone2?: string | null;
  emergencyContactAddress?: string | null;
};

const PROFILE_FIELD_KEYS: (keyof PersonProfileFields)[] = [
  'firstName', 'lastName', 'preferredName', 'religion', 'race', 'nationality', 'personalEmail',
  'addressLine1', 'addressLine2', 'addressLine3', 'postcode', 'city', 'state', 'country',
  // 3a25f5ee — Permanent + Correspondence address fields (audited by NAME only, PDPA — values never logged).
  'permanentAddressLine1', 'permanentAddressLine2', 'permanentAddressLine3', 'permanentPostcode',
  'permanentCity', 'permanentState', 'permanentCountry',
  'correspondenceAddressLine1', 'correspondenceAddressLine2', 'correspondenceAddressLine3',
  'correspondencePostcode', 'correspondenceCity', 'correspondenceState', 'correspondenceCountry',
  'emergencyContactName', 'emergencyContactRelationship', 'emergencyContactPhone',
  'emergencyContactPhone2', 'emergencyContactAddress',
];
const trimOrNull = (v: string | null | undefined): string | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

// 7d309da7 — the profile columns governed by the profile_option catalog, mapped to their category. A save
// touching any of these validates the NEW value against the tenant's active catalog (legacy value permitted).
const CATALOG_BACKED_COLUMNS: Partial<Record<keyof PersonProfileFields, ProfileOptionCategory>> = {
  religion: 'religion',
  race: 'race',
  nationality: 'nationality',
  state: 'state',
  country: 'country',
  // 3a25f5ee — the two new address blocks' state/country are validated against the same catalog.
  permanentState: 'state',
  permanentCountry: 'country',
  correspondenceState: 'state',
  correspondenceCountry: 'country',
  emergencyContactRelationship: 'relationship',
};

/**
 * Edit an employee's core person fields (name / email / phone) plus the redesigned Profile fields
 * (b4682879). A person is shared across all of their (possibly multi-company) employments, so this updates
 * the single canonical record. RLS requires admin (person policy WITH CHECK app.is_admin()). Appends a
 * before/after domain event for the original name/email/phone trio; the new profile fields are logged by
 * NAME ONLY (never values — religion/race/address are PII and the event log is append-only, PDPA-erasure
 * cannot reach it — mirrors core/profile.ts).
 */
export async function updatePerson(
  ctx: SessionContext,
  p: { personId: string; fullName: string; primaryEmail: string; phone?: string | null; via?: string } & PersonProfileFields,
) {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({
        fullName: person.fullName,
        primaryEmail: person.primaryEmail,
        phone: person.phone,
        // Legacy values of the catalog-backed columns — needed so a save that leaves an out-of-catalog
        // value UNCHANGED is permitted (7d309da7 legacy-value tolerance), not rejected.
        religion: person.religion,
        race: person.race,
        nationality: person.nationality,
        state: person.state,
        country: person.country,
        // 3a25f5ee — legacy values of the two new address blocks' catalog columns, same tolerance rule.
        permanentState: person.permanentState,
        permanentCountry: person.permanentCountry,
        correspondenceState: person.correspondenceState,
        correspondenceCountry: person.correspondenceCountry,
        emergencyContactRelationship: person.emergencyContactRelationship,
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
    // Only the profile fields explicitly PRESENT on the caller's payload (undefined = leave unchanged).
    const profileSet: Record<string, string | null> = {};
    const profileFields: string[] = [];
    for (const k of PROFILE_FIELD_KEYS) {
      if (p[k] !== undefined) {
        profileSet[k] = trimOrNull(p[k]);
        profileFields.push(k);
      }
    }
    // 7d309da7 — the six catalog-backed columns may only take an ACTIVE catalog value, EXCEPT the legacy
    // value already stored (tolerance). Clearing to null is always allowed. Validated against the tenant's
    // profile_option catalog within this same RLS tx.
    for (const [col, category] of Object.entries(CATALOG_BACKED_COLUMNS) as [
      keyof PersonProfileFields,
      ProfileOptionCategory,
    ][]) {
      if (col in profileSet) {
        await assertProfileValueAllowed(tx, category, profileSet[col], (before as Record<string, string | null>)[col]);
      }
    }
    await tx.update(person).set({ ...after, ...profileSet }).where(eq(person.id, p.personId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'person',
      aggregateId: p.personId,
      eventType: 'person.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
      // before/after only for the non-PII core trio; profile fields recorded by name (values are PII).
      // 3a25f5ee — `via` is an optional provenance marker (e.g. 'copy-permanent' when HR used the "Same as
      // Permanent Address" convenience). It records HOW the save happened, never any address VALUE (PDPA).
      payload: {
        before,
        after,
        ...(profileFields.length > 0 ? { fields: profileFields } : {}),
        ...(p.via ? { via: p.via } : {}),
      },
    });
    return { id: p.personId };
  });
}

/**
 * Employee ID uniqueness pre-check (feedback 38668d9b). Throws a clear, user-facing error if `code`
 * (already normalized) is used by another employment in the same tenant. `excludeEmploymentId` skips the
 * employment being edited so re-saving its own unchanged code is not a false collision. The DB unique
 * index (employment_employee_code_uq on tenant + code) is the race-safety net; this gives the friendly
 * message instead of a raw 23505.
 */
async function assertEmployeeCodeUnique(
  tx: Tx,
  tenantId: string,
  code: string,
  excludeEmploymentId?: string,
): Promise<void> {
  const rows = await tx
    .select({ id: employment.id })
    .from(employment)
    .where(and(eq(employment.tenantId, tenantId), eq(employment.employeeCode, code)))
    .limit(2);
  const clash = rows.find((r) => r.id !== excludeEmploymentId);
  if (clash) throw new Error(`Employee ID "${code}" is already in use`);
}

/** Map a Postgres unique-violation on the employee-code index to the same friendly message. */
function isEmployeeCodeUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string } | undefined;
  return err?.code === '23505' && (err?.constraint?.includes('employee_code') ?? true);
}

/**
 * Set / correct an employment's Employee ID (feedback 38668d9b). HR keys the company's real staff ID on
 * the admin detail page; legacy null rows get filled in here. Validates + normalizes (alphanumeric + dash,
 * max 9), pre-checks tenant-uniqueness (excluding this employment), and catches the DB unique violation as
 * the race net. No-ops when the value is unchanged so a Save that didn't touch the ID emits no event.
 * Substrate discipline: appends `employment.employee-code.set` with a before/after payload.
 */
export async function setEmployeeCode(
  ctx: SessionContext,
  p: { employmentId: string; employeeCode: string },
) {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ employeeCode: employment.employeeCode })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!before) throw new Error('Employment not found');
    const code = requireEmployeeCode(p.employeeCode);
    if (before.employeeCode === code) return { id: p.employmentId, changed: false };
    await assertEmployeeCodeUnique(tx, ctx.tenantId, code, p.employmentId);
    try {
      await tx.update(employment).set({ employeeCode: code }).where(eq(employment.id, p.employmentId));
    } catch (e) {
      if (isEmployeeCodeUniqueViolation(e)) throw new Error(`Employee ID "${code}" is already in use`);
      throw e;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employment.employee-code.set',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { before: { employeeCode: before.employeeCode }, after: { employeeCode: code } },
    });
    return { id: p.employmentId, changed: true };
  });
}

/** ADR-0038 2C — set the state an employment works in (drives which state public holidays apply). Pass
 *  null to inherit the company's default work state. */
export async function setEmploymentWorkState(
  ctx: SessionContext,
  p: { employmentId: string; workState: string | null },
) {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ workState: employment.workState })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!before) throw new Error('Employment not found');
    const workState = p.workState?.trim() || null;
    await tx.update(employment).set({ workState }).where(eq(employment.id, p.employmentId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employment.work-state.changed',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { before: before.workState, after: workState },
    });
    return { id: p.employmentId };
  });
}

/**
 * Holiday-calendar selection for an employment — the SINGLE unified input that replaces the standalone
 * work-state setter on the profile (so there are never two competing fields). `selection` is a
 * discriminated value:
 *   { kind: 'none' }        → company-default / national fallback (both columns null)
 *   { kind: 'state', state }→ a single built-in state (work_state path — current behaviour)
 *   { kind: 'group', groupId }→ an HR-defined multi-state holiday group (holiday_group_id path)
 * Exactly ONE of work_state / holiday_group_id is set and the OTHER is nulled, enforcing the XOR in the
 * service (the DB CHECK is the backstop). Admin-gated: employment writes go through the role-gated RLS
 * (migration 0002), so a self-service employee cannot pick their own calendar.
 */
export type HolidayCalendarSelection =
  | { kind: 'none' }
  | { kind: 'state'; state: string }
  | { kind: 'group'; groupId: string };

export async function setEmploymentHolidayCalendar(
  ctx: SessionContext,
  p: { employmentId: string; selection: HolidayCalendarSelection },
) {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ workState: employment.workState, holidayGroupId: employment.holidayGroupId })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!before) throw new Error('Employment not found');

    let workState: string | null = null;
    let holidayGroupId: string | null = null;
    if (p.selection.kind === 'state') {
      workState = p.selection.state.trim() || null;
    } else if (p.selection.kind === 'group') {
      const groupId = p.selection.groupId.trim();
      if (!groupId) throw new Error('A holiday group must be selected');
      // Validate the group exists in this tenant (RLS scopes the read) before assigning.
      const [g] = await tx
        .select({ id: holidayGroup.id })
        .from(holidayGroup)
        .where(eq(holidayGroup.id, groupId))
        .limit(1);
      if (!g) throw new Error('Holiday group not found');
      holidayGroupId = groupId;
    }

    await tx
      .update(employment)
      .set({ workState, holidayGroupId })
      .where(eq(employment.id, p.employmentId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employment.holiday-calendar.changed',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: {
        before: { workState: before.workState, holidayGroupId: before.holidayGroupId },
        after: { workState, holidayGroupId },
      },
    });
    return { id: p.employmentId };
  });
}

/** ADR-0041 2E: set an employment's seniority grade (drives grade-scoped leave entitlements). Pass null
 *  to clear. The grade applies to future grants/accruals; past ledger entries are untouched. */
export async function setEmploymentGrade(
  ctx: SessionContext,
  p: { employmentId: string; gradeId: string | null },
) {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ gradeId: employment.gradeId })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!before) throw new Error('Employment not found');
    await tx.update(employment).set({ gradeId: p.gradeId }).where(eq(employment.id, p.employmentId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employment.grade.changed',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { before: before.gradeId, after: p.gradeId },
    });
    return { id: p.employmentId };
  });
}

/**
 * Employment tab org-info edit (feedback 594323a6) — the single audited, effective-dated writer for the
 * four assignment-owned dimensions HR maintains from the Personnel Employment tab: Department, Position,
 * Employment Type and Employee Status. Job Grade is NOT here (it lives on `employment`, owned by
 * setEmploymentGrade). Like transferEmployee this CLOSE+INSERTs so the dated assignment history is never
 * overwritten — but it carries ALL four dimensions forward (transferEmployee only ever moved department/
 * location and left type/status frozen), and emits a dedicated `employment.assignment.changed` event with a
 * full before/after diff so the change is attributable in the audit trail.
 *
 * `undefined` on any field = carry the current value forward. Values are enum-validated by the DB column
 * types; department/position ids are FK-checked by Postgres (an invalid id throws, surfaced to the caller).
 * A no-op (nothing actually changed) returns `{ changed: false }` WITHOUT creating a spurious dated row or
 * event — so a Save that only touched Job Grade doesn't fragment the assignment history.
 */
export async function setEmploymentAssignment(
  ctx: SessionContext,
  p: {
    employmentId: string;
    effectiveDate: string;
    departmentId?: string;
    positionId?: string | null;
    // 1001ff61 — Business Unit on the assignment. undefined = carry forward; null = clear; a value must be a
    // live BU in THIS employee's company (validated below).
    businessUnitId?: string | null;
    employmentType?: EmploymentTypeValue;
    status?: AssignmentStatusValue;
  },
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
    if (!cur) throw new Error('No open assignment to change');
    // Effective date cannot predate the current version's start (would invert the dated range).
    if (p.effectiveDate < cur.validFrom) {
      throw new Error('Effective date cannot be before the current assignment start date');
    }

    const nextDepartmentId = p.departmentId ?? cur.departmentId;
    const nextPositionId = p.positionId === undefined ? cur.positionId : p.positionId || null;
    const nextBusinessUnitId =
      p.businessUnitId === undefined ? cur.businessUnitId : p.businessUnitId || null;
    const nextEmploymentType = p.employmentType ?? cur.employmentType;
    const nextStatus = p.status ?? cur.status;

    // 1001ff61 — referential integrity + company scope for a newly-selected BU: it must exist, be un-archived,
    // and belong to this employment's company. (An unchanged/cleared BU skips the check.) Defence-in-depth
    // over the nullable FK, matching the "prevent invalid dropdown selections" requirement.
    if (nextBusinessUnitId && nextBusinessUnitId !== cur.businessUnitId) {
      const [emp] = await tx
        .select({ companyId: employment.companyId })
        .from(employment)
        .where(eq(employment.id, p.employmentId))
        .limit(1);
      const [bu] = await tx
        .select({ id: businessUnit.id, companyId: businessUnit.companyId, archivedAt: businessUnit.archivedAt })
        .from(businessUnit)
        .where(eq(businessUnit.id, nextBusinessUnitId))
        .limit(1);
      if (!bu || bu.archivedAt || !emp || bu.companyId !== emp.companyId) {
        throw new Error('Selected Business Unit is not a valid option for this employee.');
      }
    }

    const unchanged =
      nextDepartmentId === cur.departmentId &&
      nextPositionId === cur.positionId &&
      nextBusinessUnitId === cur.businessUnitId &&
      nextEmploymentType === cur.employmentType &&
      nextStatus === cur.status;
    if (unchanged) return { assignmentId: cur.id, changed: false as const };

    // CLOSE current (set valid_to), then INSERT the new version — ranges don't overlap.
    await tx.update(assignment).set({ validTo: p.effectiveDate }).where(eq(assignment.id, cur.id));
    const [next] = await tx
      .insert(assignment)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        departmentId: nextDepartmentId,
        positionId: nextPositionId,
        businessUnitId: nextBusinessUnitId,
        costCenterId: cur.costCenterId,
        locationId: cur.locationId,
        employmentType: nextEmploymentType,
        status: nextStatus,
        validFrom: p.effectiveDate,
        validTo: null,
      })
      .returning({ id: assignment.id });

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'assignment',
      aggregateId: next.id,
      eventType: 'employment.assignment.changed',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: {
        employmentId: p.employmentId,
        effectiveDate: p.effectiveDate,
        before: {
          departmentId: cur.departmentId,
          positionId: cur.positionId,
          businessUnitId: cur.businessUnitId,
          employmentType: cur.employmentType,
          status: cur.status,
        },
        after: {
          departmentId: nextDepartmentId,
          positionId: nextPositionId,
          businessUnitId: nextBusinessUnitId,
          employmentType: nextEmploymentType,
          status: nextStatus,
        },
      },
    });
    return { assignmentId: next.id, changed: true as const };
  });
}

/**
 * Employment Information enhancement (2323f671) — HR/Admin maintains the employment master-data captured on
 * the Personnel Employment tab's new "Employment Information" card. This is the single audited writer for
 * the fields added in migration 0181 plus the editable Hire Date (employment.hiredOn). Effective-dated
 * fields (department/position/employment-type/status via `assignment`, superior via reporting-line) are NOT
 * touched here — they stay owned by Transfer / Career Movement / reporting-line to preserve their history.
 *
 * Every field is OPTIONAL: `undefined` = leave as-is, so a partial save never clobbers an untouched column.
 * An explicit `null`/empty clears. Server-side validation (also enforced regardless of what the UI sends):
 *   • confirmationDate ≥ hiredOn, resignationDate ≥ hiredOn (date relationships)
 *   • all period components (probation/notice/short-notice months & days) are non-negative integers
 * Field-capture only per the CR — no downstream business rules fire yet. Admin-gated (defence-in-depth over
 * the employment RLS admin-write policy); the write appends `employment.info.updated` with a before/after diff.
 */
export type EmploymentInfoInput = {
  employmentId: string;
  hiredOn?: string;
  // "Join Date" (feedback 24c4d02e) — the current-company effective join date. Nullable; '' / null clears it.
  joinDate?: string | null;
  // Period components accept strings (raw HTML number-input values) or numbers; parsed + validated below.
  probationMonths?: number | string | null;
  probationDays?: number | string | null;
  confirmationDate?: string | null;
  resignationNoticeMonths?: number | string | null;
  resignationNoticeDays?: number | string | null;
  resignationDate?: string | null;
  shortNoticeMonths?: number | string | null;
  shortNoticeDays?: number | string | null;
  // Enhance Employment Dates (955c7de4) — value + unit ('month'|'week'|'day') per period, plus lifecycle
  // dates. All optional; undefined = untouched, ''/null = clear. finalConfirmationDate is DERIVED on save
  // (= extendedConfirmationDate ?? confirmationDate) and never accepted from the caller.
  probationValue?: number | string | null;
  probationUnit?: string | null;
  extendedProbationValue?: number | string | null;
  extendedProbationUnit?: string | null;
  noticeBeforeConfirmationValue?: number | string | null;
  noticeBeforeConfirmationUnit?: string | null;
  noticeAfterConfirmationValue?: number | string | null;
  noticeAfterConfirmationUnit?: string | null;
  extendedConfirmationDate?: string | null;
  tenderResignationDate?: string | null;
  lastWorkingDate?: string | null;
  orgBranch?: string | null;
  orgDivision?: string | null;
  orgRegion?: string | null;
  orgLine?: string | null;
  orgSection?: string | null;
  orgTeam?: string | null;
  orgBase?: string | null;
  employmentCategory?: string | null;
};

const EMPLOYMENT_INFO_TEXT_FIELDS = [
  'orgBranch',
  'orgDivision',
  'orgRegion',
  'orgLine',
  'orgSection',
  'orgTeam',
  'orgBase',
  'employmentCategory',
] as const;

// 1001ff61 — each org/job text field is now backed by a profile_option catalog category. On save the new
// value must be an ACTIVE catalog option for that category (with the same legacy-value tolerance +
// empty-catalog free-text fallback as the person-profile dropdowns — see assertProfileValueAllowed).
const EMPLOYMENT_INFO_FIELD_CATEGORY: Partial<Record<(typeof EMPLOYMENT_INFO_TEXT_FIELDS)[number], ProfileOptionCategory>> = {
  orgDivision: 'division',
  orgBranch: 'branch',
  orgRegion: 'region',
  orgLine: 'line',
  orgSection: 'section',
  orgTeam: 'team',
  orgBase: 'base',
  employmentCategory: 'category',
};

const EMPLOYMENT_INFO_PERIOD_FIELDS = [
  'probationMonths',
  'probationDays',
  'resignationNoticeMonths',
  'resignationNoticeDays',
  'shortNoticeMonths',
  'shortNoticeDays',
  // 955c7de4 — new value component of the redesigned value+unit periods (non-negative integers).
  'probationValue',
  'extendedProbationValue',
  'noticeBeforeConfirmationValue',
  'noticeAfterConfirmationValue',
] as const;

// 955c7de4 — the unit half of each redesigned period. Validated against EMPLOYMENT_PERIOD_UNITS below.
const EMPLOYMENT_INFO_UNIT_FIELDS = [
  'probationUnit',
  'extendedProbationUnit',
  'noticeBeforeConfirmationUnit',
  'noticeAfterConfirmationUnit',
] as const;

export const EMPLOYMENT_PERIOD_UNITS = ['month', 'week', 'day'] as const;

const EMPLOYMENT_INFO_DATE_FIELDS = [
  'joinDate',
  'confirmationDate',
  'resignationDate',
  // 955c7de4 — new lifecycle dates. finalConfirmationDate is DERIVED (not in this list; computed on save).
  'extendedConfirmationDate',
  'tenderResignationDate',
  'lastWorkingDate',
] as const;

export async function setEmploymentInfo(ctx: SessionContext, p: EmploymentInfoInput) {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new Error('Only an admin can edit employment information.');
  }

  // Build the write set: only columns the caller actually provided. `undefined` = untouched; a period/text
  // field passed as '' or null clears to NULL. Validate + normalise as we go.
  const set: Record<string, string | number | null> = {};

  if (p.hiredOn !== undefined) {
    const v = String(p.hiredOn).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('Hire date is required and must be a valid date.');
    set.hiredOn = v;
  }
  for (const f of EMPLOYMENT_INFO_DATE_FIELDS) {
    const raw = p[f];
    if (raw === undefined) continue;
    const v = raw == null ? null : String(raw).trim();
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('Enter a valid date (YYYY-MM-DD).');
    set[f] = v || null;
  }
  for (const f of EMPLOYMENT_INFO_PERIOD_FIELDS) {
    const raw = p[f];
    if (raw === undefined) continue;
    if (raw == null || raw === '') {
      set[f] = null;
      continue;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error('Period months/days must be whole numbers of 0 or more.');
    set[f] = n;
  }
  for (const f of EMPLOYMENT_INFO_UNIT_FIELDS) {
    const raw = p[f];
    if (raw === undefined) continue;
    if (raw == null || raw === '') {
      set[f] = null;
      continue;
    }
    const v = String(raw).trim().toLowerCase();
    if (!(EMPLOYMENT_PERIOD_UNITS as readonly string[]).includes(v)) {
      throw new Error('Period unit must be Month, Week or Day.');
    }
    set[f] = v;
  }
  for (const f of EMPLOYMENT_INFO_TEXT_FIELDS) {
    const raw = p[f];
    if (raw === undefined) continue;
    const v = raw == null ? null : String(raw).trim();
    set[f] = v || null;
  }

  if (Object.keys(set).length === 0) throw new Error('Nothing to change.');

  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({
        hiredOn: employment.hiredOn,
        joinDate: employment.joinDate,
        probationMonths: employment.probationMonths,
        probationDays: employment.probationDays,
        confirmationDate: employment.confirmationDate,
        resignationNoticeMonths: employment.resignationNoticeMonths,
        resignationNoticeDays: employment.resignationNoticeDays,
        resignationDate: employment.resignationDate,
        shortNoticeMonths: employment.shortNoticeMonths,
        shortNoticeDays: employment.shortNoticeDays,
        probationValue: employment.probationValue,
        probationUnit: employment.probationUnit,
        extendedProbationValue: employment.extendedProbationValue,
        extendedProbationUnit: employment.extendedProbationUnit,
        noticeBeforeConfirmationValue: employment.noticeBeforeConfirmationValue,
        noticeBeforeConfirmationUnit: employment.noticeBeforeConfirmationUnit,
        noticeAfterConfirmationValue: employment.noticeAfterConfirmationValue,
        noticeAfterConfirmationUnit: employment.noticeAfterConfirmationUnit,
        extendedConfirmationDate: employment.extendedConfirmationDate,
        finalConfirmationDate: employment.finalConfirmationDate,
        tenderResignationDate: employment.tenderResignationDate,
        lastWorkingDate: employment.lastWorkingDate,
        orgBranch: employment.orgBranch,
        orgDivision: employment.orgDivision,
        orgRegion: employment.orgRegion,
        orgLine: employment.orgLine,
        orgSection: employment.orgSection,
        orgTeam: employment.orgTeam,
        orgBase: employment.orgBase,
        employmentCategory: employment.employmentCategory,
      })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!before) throw new Error('Employment not found');

    // 1001ff61 — the org/job fields are now catalog-backed dropdowns. Reject a value that is not an ACTIVE
    // profile_option for its category (empty-catalog tenants keep free-text; the unchanged legacy value is
    // always tolerated). Runs in this tx so it shares the RLS session; a violation aborts before the write.
    for (const f of EMPLOYMENT_INFO_TEXT_FIELDS) {
      if (!(f in set)) continue;
      const category = EMPLOYMENT_INFO_FIELD_CATEGORY[f];
      if (!category) continue;
      await assertProfileValueAllowed(
        tx,
        category,
        set[f] as string | null,
        (before as Record<string, string | null>)[f],
      );
    }

    // Date-relationship checks resolve against the RESULTING values (incoming override → existing), so a save
    // that changes only the confirmation date is still validated against the stored hire date, and vice-versa.
    const hire = (set.hiredOn as string | undefined) ?? before.hiredOn;
    const join = 'joinDate' in set ? (set.joinDate as string | null) : before.joinDate;
    const confirmation = 'confirmationDate' in set ? (set.confirmationDate as string | null) : before.confirmationDate;
    const resignation = 'resignationDate' in set ? (set.resignationDate as string | null) : before.resignationDate;
    // The current-company Join Date can never precede the Group Join Date (you cannot join a company inside the
    // group before joining the group). Resolves against the RESULTING values so a save of either date is checked.
    if (join && hire && join < hire) {
      throw new Error('Join date cannot be earlier than the group join date.');
    }
    if (confirmation && hire && confirmation < hire) {
      throw new Error('Confirmation date cannot be earlier than the hire date.');
    }
    if (resignation && hire && resignation < hire) {
      throw new Error('Resignation date cannot be earlier than the hire date.');
    }

    // 955c7de4 — lifecycle date-ordering, all resolved against the RESULTING values (incoming override →
    // existing), so a save of any single date is still validated against the stored siblings.
    const extendedConfirmation =
      'extendedConfirmationDate' in set
        ? (set.extendedConfirmationDate as string | null)
        : before.extendedConfirmationDate;
    const tender =
      'tenderResignationDate' in set ? (set.tenderResignationDate as string | null) : before.tenderResignationDate;
    const lastWorking = 'lastWorkingDate' in set ? (set.lastWorkingDate as string | null) : before.lastWorkingDate;

    // An extended confirmation (after a probation extension) can never precede the normal confirmation date.
    if (extendedConfirmation && confirmation && extendedConfirmation < confirmation) {
      throw new Error('Extended confirmation date cannot be earlier than the confirmation date.');
    }
    // Resignation lifecycle ordering: tender ≤ resignation ≤ last working (only pairs that are both present).
    if (tender && resignation && tender > resignation) {
      throw new Error('Tender resignation date cannot be later than the resignation date.');
    }
    if (resignation && lastWorking && resignation > lastWorking) {
      throw new Error('Resignation date cannot be later than the last working date.');
    }
    if (tender && lastWorking && tender > lastWorking) {
      throw new Error('Tender resignation date cannot be later than the last working date.');
    }
    // Tender/last-working, like the other lifecycle dates, cannot precede the group join date.
    if (tender && hire && tender < hire) {
      throw new Error('Tender resignation date cannot be earlier than the hire date.');
    }
    if (lastWorking && hire && lastWorking < hire) {
      throw new Error('Last working date cannot be earlier than the hire date.');
    }

    // finalConfirmationDate is DERIVED, never accepted from the caller: = extendedConfirmation ?? confirmation.
    // Recompute from the resulting values on every save and persist only when it actually changes, so the
    // before/after diff stays meaningful and the column is always consistent with its inputs.
    const derivedFinal = (extendedConfirmation ?? confirmation) ?? null;
    if (derivedFinal !== (before.finalConfirmationDate ?? null)) {
      set.finalConfirmationDate = derivedFinal;
    }

    await tx.update(employment).set(set).where(eq(employment.id, p.employmentId));
    const after = { ...before, ...set };
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employment.info.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { fields: Object.keys(set), before, after },
    });
    return { id: p.employmentId };
  });
}

/**
 * ADR-0029 scope-out — designate the single "paymaster" employment through which a person's taxable
 * remuneration runs for PCB when they hold concurrent employments across the group. The paymaster must be
 * one of the person's own ACTIVE employments. Pass `null` to clear. App-validated soft reference (no DB FK).
 */
export async function setDesignatedPaymaster(
  ctx: SessionContext,
  p: { personId: string; designatedPaymasterEmploymentId: string | null },
) {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ current: person.designatedPaymasterEmploymentId })
      .from(person)
      .where(eq(person.id, p.personId))
      .limit(1);
    if (!before) throw new Error('Person not found');
    if (p.designatedPaymasterEmploymentId != null) {
      const [emp] = await tx
        .select({ id: employment.id })
        .from(employment)
        .where(
          and(
            eq(employment.id, p.designatedPaymasterEmploymentId),
            eq(employment.personId, p.personId),
            isNull(employment.terminatedOn),
          ),
        )
        .limit(1);
      if (!emp) throw new Error("The paymaster must be one of this person's active employments");
    }
    await tx
      .update(person)
      .set({ designatedPaymasterEmploymentId: p.designatedPaymasterEmploymentId })
      .where(eq(person.id, p.personId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'person',
      aggregateId: p.personId,
      eventType: 'person.paymaster.designated',
      actor: actorOf(ctx),
      subjectEmploymentId:
        p.designatedPaymasterEmploymentId ?? (await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId)),
      payload: { before: before.current, after: p.designatedPaymasterEmploymentId },
    });
    return { id: p.personId, designatedPaymasterEmploymentId: p.designatedPaymasterEmploymentId };
  });
}
