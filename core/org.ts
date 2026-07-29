/**
 * Organizational lifecycle services (ADR-0003). Each mutation runs inside `withTenant`
 * (one transaction, RLS scoped to the session) and appends a domain event before returning.
 * Effective-dated changes CLOSE + INSERT; we never overwrite history.
 */
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf, subjectEmploymentForPerson, type MovementTag } from '../db/events';
import { nextEmployeeCode } from './comp';
import { generateEmployeeCode } from './employee-id-config';
import { requireEmployeeCode } from '../lib/employee-code';
import { a2cFirstYearEntitledToDate, applyMaxBalance, applyRounding, buildSchemeEntitlementResolver, entitledDays, isA2cFirstYear, isEarnedMethod, resolveGradePolicy, type GradePolicyRow } from './leave';
import { packFor } from '../localization/registry';
import { labelUsableByCompany } from './system-labels';
// Company-change gate (9464bd56): the pre-transaction check lives in core/read.ts (ONE greppable set of
// module heads). Imported here so the company-change writer re-runs it as its server-side source of truth
// inside the same transaction. read.ts does not import org.ts, so this adds no import cycle.
import { employmentCompanyBlockedTx } from './read';
import { assertProfileValueAllowed, type ProfileOptionCategory } from './profile-options';
// 23ad620e — the emergency contact is a per-person register now, not five person columns.
import { writeSingleEmergencyContactInTx } from './emergency-contacts';
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
  reportingLineScope,
  leaveLedger,
  employmentTypeEnum,
  assignmentStatusEnum,
  // R46 79eb7151 — read-only here, to validate the bank-transfer payment method against the person's
  // salary-payment destination. This module never WRITES the statutory row.
  employeeStatutoryMy,
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

/** Company-change (feedback 9464bd56): the destination company is not one the actor administers. Thrown by
 *  changeEmploymentCompany BEFORE any write, so a company-scoped admin gets a friendly, actionable message
 *  instead of the opaque employment_rls WITH CHECK (is_admin_for(newCompanyId)) row-level failure — moving
 *  someone to a company you do not manage goes through the Movement / Transfer flow. */
export class DestinationCompanyNotAdministered extends Error {
  constructor() {
    super(
      'You can only move this person to a company you manage. To move them to another company, use the Movement tab to record a Transfer.',
    );
    this.name = 'DestinationCompanyNotAdministered';
  }
}

/** Company-change (feedback 9464bd56): the employee already has operational activity, so the Company is
 *  locked and the inline correction is refused — HR is steered to Movement / Transfer (which preserves
 *  history). Thrown when the server-side gate (employmentCompanyBlockedTx) trips: the gate is the source of
 *  truth and re-runs on submit, because a transaction may have landed between render and submit. */
export class CompanyLockedError extends Error {
  constructor(
    message = 'This employee already has recorded activity, so their Company can no longer be changed here. Use the Movement tab to record a Transfer, which keeps their history intact.',
  ) {
    super(message);
    this.name = 'CompanyLockedError';
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
   *  value; it is validated (alphanumeric + dash, max 30 chars — de2823cc) and must be unique within the tenant. Left
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
   *  HOSPITALIZATION; situational types (maternity etc.) are claimed per event, not granted.
   *  `yearCycleOverride` (f3a64d90 → adcdf215) is the type's raw leave_type.year_cycle_override — only 'a2c'
   *  is load-bearing here (it replaces the hire-month lump with the full up-front part-year figure on
   *  ANNUAL). Absent / null ⇒ byte-identical pre-existing grant behaviour. */
  grantLeaveTypes?: { id: string; code: string; yearCycleOverride?: string | null }[];
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
    // 89ea527b — the ONE-TIME Group Join Date → Join Date synchronisation. At creation the two dates are by
    // definition the same day: hiredOn is the employee's first day anywhere in the GROUP, joinDate their first
    // day with the CURRENT company, and a brand-new employment has only ever had one company. Seeding it here
    // (rather than leaving join_date NULL and relying on the `joinDate ?? hiredOn` read fallback) is what makes
    // the pair explicit, so a later internal transfer moves joinDate away from a real stored value instead of
    // materialising one. It happens ONLY here — after creation both dates are movement-only (setEmploymentInfo
    // gates them). NOTE: this is display/records-only. NOTHING reads join_date for entitlement; every service
    // band, minService gate and years-of-service figure reads hiredOn (see setEmploymentInfo's gate comment).
    const [emp] = await tx
      .insert(employment)
      .values({ tenantId: ctx.tenantId, personId, companyId: p.companyId, hiredOn: p.hiredOn, joinDate: p.hiredOn, employeeCode, gradeId: p.gradeId ?? null, provisionalEndOn })
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
        // Auto-link entitlement (ae5b84d5): resolve the new hire's benefit scheme so the FIRST balance
        // already comes from the matching Grade Group table (previously only the next year-open did).
        // Runs after the assignment insert above (same tx), so the resolver's current-assignment
        // employment-type lookup sees this hire. A brand-new employment has no manual override (null);
        // no schemes configured ⇒ `() => null` ⇒ byte-identical grade-policy/floor behaviour.
        const schemeDaysFor = await buildSchemeEntitlementResolver(
          tx,
          [{ employmentId: emp.id, companyId: p.companyId, gradeId: p.gradeId ?? null, overrideSchemeId: null }],
          p.grantLeaveTypes.map((t) => t.id),
        );
        const month = Number(p.hiredOn.slice(5, 7));
        for (const lt of p.grantLeaveTypes) {
          // ADR-0066: scope to the new hire's company so a per-company UPFRONT entitlement reaches joiners.
          // Leave Entitlement Rules Engine: a new hire has 0 completed years of service (explicit — the
          // param is required so a band-configured policy resolves its 0-year band at hire).
          const polFor = resolveGradePolicy(policyByType.get(lt.id) ?? [], p.gradeId ?? null, p.companyId, 0);
          // 2D (ADR-0040): earned types accrue through the year via accrueEarnedLeave, not the hire lump.
          if (isEarnedMethod(polFor?.method)) continue;
          const floor = pack.leave.entitlement(lt.code, 0);
          // ae5b84d5: scheme band days (0-year band) supersede the policy days; EA floor still clamps —
          // the SAME entitledDays composition openLeaveYear / accrueEarnedLeave / the recalc kernel use.
          const days = entitledDays(floor, schemeDaysFor(emp.id, lt.id, 0), polFor?.days ?? 0);
          if (days <= 0) continue;
          // ANNUAL pro-rates by months remaining in the hire year (s.60E practice).
          // SICK / HOSPITALIZATION grant in full: s.60F is a per-calendar-year
          // entitlement and must not be prorated for mid-year joiners.
          // Anniversary to Calendar (f3a64d90 → adcdf215): an a2c ANNUAL type does NOT month-lump the hire
          // year — it grants the full prorated part-year (join → 31 Dec) UP FRONT, so the hire grant opens
          // at the whole up-front figure (e.g. a 6-Jan, 20-day joiner opens at 19.73, not a growing sliver).
          // A fresh hire has no terminatedOn, so no serviceEnd is passed and it gets the full up-front value;
          // reprojectA2cEntitlement / a profile recalc keep it in sync (and would cap a later leaver at their
          // exit). Non-ANNUAL a2c types keep the existing full grant (s.60F).
          const grantRaw = isA2cFirstYear(lt.yearCycleOverride, lt.code, p.hiredOn, p.hiredOn)
            ? a2cFirstYearEntitledToDate(p.hiredOn, p.hiredOn, days)
            : lt.code === 'ANNUAL'
              ? Math.round(((days * (12 - (month - 1))) / 12) * 100) / 100
              : days;
          // Feedback b81d3c52 — Rounding Method: the reporter's own worked example (a 6-Jan joiner whose
          // pro-rated entitlement lands on a fraction). Tidy the CALCULATED figure to a whole day as the
          // FINAL step of the earning calculation and BEFORE the max-balance clamp — the identical point
          // and order openLeaveYear / accrueEarnedLeave / projectExpectedEntitlement apply it, so the
          // credited ledger row and the recalc kernel's projection can never disagree. The pro-ration
          // formula itself (whole months remaining) is unchanged. No method ⇒ pass-through.
          const grantRounded = applyRounding(grantRaw, polFor?.roundingMethod);
          // Feedback 9d8cf621 — Maximum Balance Days: a new hire has 0 prior balance, so clamp the initial
          // grant so it never opens above the resolved band's cap. null ⇒ pass-through (grant unchanged).
          const { grant } = applyMaxBalance(0, grantRounded, polFor?.maxBalanceDays);
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
    /** Movement tab redesign (78853b97): optional classification tag merged into the event payload as
     *  payload.movement (see db/events.ts). Existing callers pass nothing — payload unchanged. */
    movement?: MovementTag;
  },
  /** 08913328 — optional caller transaction (the run(outerTx) pattern setEmploymentAssignment /
   *  setEmploymentGrade / setEmploymentInfo already use). The redesigned Movement comparison form can
   *  move department, grade, flat org columns and pay in ONE submit, and those legs must commit or roll
   *  back together — a half-saved movement would leave the dated assignment and the flat columns
   *  describing two different placements. */
  outerTx?: Tx,
) {
  const run = async (tx: Tx) => {
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
    // 570e3311 — the employment's company is needed by both the location guard and the changed-only
    // label guards below, so it is fetched once up front.
    const [emp] = await tx
      .select({ companyId: employment.companyId })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);

    const nextLocationId = p.locationId === undefined ? cur.locationId : p.locationId;
    if (nextLocationId) {
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

    // 570e3311 — changed-only org-label guards (previously unvalidated on this path): a transfer naming
    // a department / position / cost centre must name a label the employment's company MAY use under the
    // Shared System Labels resolver (origin ∪ shared-in ∪ global, flag-gated — labelUsableByCompany) and
    // that is not archived (the resolver deliberately does not check archived_at, so each guard reads it
    // alongside). Only values DIFFERENT from the current version are checked, so re-supplying a stored
    // legacy value keeps working.
    const guardLabel = async (
      kind: 'department' | 'position' | 'cost_center',
      table: typeof department | typeof position | typeof costCenter,
      labelId: string,
      entity: 'department' | 'position' | 'cost-center',
    ) => {
      if (!emp || !(await labelUsableByCompany(tx, ctx.tenantId, kind, labelId, emp.companyId))) {
        throw new CrossCompanyError(entity);
      }
      const [row] = await tx
        .select({ archivedAt: table.archivedAt })
        .from(table)
        .where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, labelId)))
        .limit(1);
      if (!row || row.archivedAt) throw new CrossCompanyError(entity);
    };
    if (p.departmentId && p.departmentId !== cur.departmentId) {
      await guardLabel('department', department, p.departmentId, 'department');
    }
    if (p.positionId && p.positionId !== cur.positionId) {
      await guardLabel('position', position, p.positionId, 'position');
    }
    if (p.costCenterId && p.costCenterId !== cur.costCenterId) {
      await guardLabel('cost_center', costCenter, p.costCenterId, 'cost-center');
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
        // Carried, not settable. This line was MISSING, so every CLOSE+INSERT through this path wrote a
        // new assignment version with a NULL business unit — silently wiping it. Both live callers hit
        // it: "Set location" names only a location, "Transfer" only a department, and neither has any
        // reason to expect an unrelated field to be cleared. There is no `p.businessUnitId` because no
        // caller moves a business unit here; the bug was purely the omission of the carry-forward.
        businessUnitId: cur.businessUnitId,
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
        // 78853b97 — movement classification tag (additive; absent for legacy callers).
        ...(p.movement ? { movement: p.movement } : {}),
      },
    });
    return { assignmentId: next.id };
  };
  return outerTx ? run(outerTx) : withTenant(ctx, run);
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

// R51 (baf56348) — the approver-level ladder: the HIGHEST duty an employment holds, business_unit_head >
// department_head > manager (an active administrative downline) > none. Derived live from headship +
// reporting lines (no new data entry; stays correct as people change roles).
export type ApproverLevel = 'business_unit_head' | 'department_head' | 'manager' | 'none';

/** Wraps app.approver_level (SECURITY DEFINER — it must read headship/downlines of employments the caller's
 *  RLS session cannot see, e.g. the delegation RECIPIENT). Runs in the caller's tx. */
export async function approverLevelOfTx(tx: Tx, employmentId: string, asOf: string): Promise<ApproverLevel> {
  const res = await tx.execute(sql`SELECT app.approver_level(${employmentId}, ${asOf}) AS level`);
  return ((res as unknown as { level: string }[])[0]?.level ?? 'none') as ApproverLevel;
}

/** Session-scoped wrapper for `approverLevelOfTx` (opens its own tx). */
export async function approverLevelOf(ctx: SessionContext, employmentId: string, asOf: string): Promise<ApproverLevel> {
  return withTenant(ctx, (tx) => approverLevelOfTx(tx, employmentId, asOf));
}

/** R51 (baf56348) — org COVERAGE of a delegation: company → business unit → department, each nullable.
 *  All three null = unrestricted (the meaning of every legacy row). */
export type DelegationOrgScope = {
  companyId: string | null;
  businessUnitId: string | null;
  departmentId: string | null;
};

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
  p: {
    subordinateEmploymentId: string;
    managerEmploymentId: string;
    validFrom: string;
    validTo: string | null;
    // R44 delegation (Phase 2): why the hand-over (free text; nullable for legacy/whole-scope callers), and
    // the per-module/task scope. An EMPTY/absent scope list = whole-scope (all approvals) — back-compat.
    reason?: string | null;
    scopes?: { module: string; taskType: string | null }[];
    // R51 (baf56348): org COVERAGE (company → BU → department). Absent/all-null = unrestricted.
    orgScope?: DelegationOrgScope | null;
    // R51: editDelegation sets this when the recipient is UNCHANGED, so a date-only edit of a legacy row
    // whose recipient no longer (or never) shared the delegator's level still goes through. Every path that
    // picks a NEW recipient runs the guard.
    skipSameLevelGuard?: boolean;
  },
): Promise<{ reportingLineId: string }> {
  if (p.subordinateEmploymentId === p.managerEmploymentId) throw new ReportingCycleError();
  if (p.validTo != null && p.validTo < p.validFrom) {
    throw new DelegationError('The end date must be on or after the start date');
  }
  // R51 same-level guard: the recipient's HIGHEST approval level must EQUAL the delegator's — equality on
  // the ladder, NOT set intersection (intersection would let an HOD who also manages a team delegate down
  // to a plain manager). Engine-level so the HR form, the command-bar modal and a crafted POST all hit the
  // same rule. Deliberate: level is checked at WRITE time only — decide time re-validates window, live
  // delegator, admin-edge/headship, active employment, module scope and org scope, not level drift.
  if (!p.skipSameLevelGuard) {
    const [delegatorLevel, recipientLevel] = await Promise.all([
      approverLevelOfTx(tx, p.subordinateEmploymentId, p.validFrom),
      approverLevelOfTx(tx, p.managerEmploymentId, p.validFrom),
    ]);
    if (delegatorLevel !== recipientLevel) {
      throw new DelegationError('The stand-in must hold the same approval level as the person delegating');
    }
  }
  // R51 org-scope parent-chain consistency (write-time; client filtering is not a source of truth). The
  // shared-labels resolver validates company membership (origin ∪ shared-in ∪ global); the department↔BU
  // link is checked directly (a department with no BU link is usable under every BU — hire-form precedent).
  const orgScope: DelegationOrgScope = {
    companyId: p.orgScope?.companyId ?? null,
    businessUnitId: p.orgScope?.businessUnitId ?? null,
    departmentId: p.orgScope?.departmentId ?? null,
  };
  if (orgScope.businessUnitId) {
    const [bu] = await tx
      .select({ id: businessUnit.id, companyId: businessUnit.companyId })
      .from(businessUnit)
      .where(eq(businessUnit.id, orgScope.businessUnitId))
      .limit(1);
    if (!bu) throw new DelegationError('The selected business unit no longer exists');
    if (
      orgScope.companyId &&
      !(await labelUsableByCompany(tx, ctx.tenantId, 'business_unit', bu.id, orgScope.companyId))
    ) {
      throw new DelegationError('The selected business unit does not belong to the selected company');
    }
  }
  if (orgScope.departmentId) {
    const [dept] = await tx
      .select({ id: department.id, companyId: department.companyId, businessUnitId: department.businessUnitId })
      .from(department)
      .where(eq(department.id, orgScope.departmentId))
      .limit(1);
    if (!dept) throw new DelegationError('The selected department no longer exists');
    if (
      orgScope.companyId &&
      !(await labelUsableByCompany(tx, ctx.tenantId, 'department', dept.id, orgScope.companyId))
    ) {
      throw new DelegationError('The selected department does not belong to the selected company');
    }
    if (orgScope.businessUnitId && dept.businessUnitId && dept.businessUnitId !== orgScope.businessUnitId) {
      throw new DelegationError('The selected department does not belong to the selected business unit');
    }
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
  // Normalise the scope list: drop blanks, de-dupe. An empty result persists ZERO scope rows = whole-scope.
  const scopes = (p.scopes ?? [])
    .filter((s) => s.module && s.module.trim())
    .map((s) => ({ module: s.module, taskType: s.taskType && s.taskType.trim() ? s.taskType : null }));
  const reason = p.reason && p.reason.trim() ? p.reason.trim() : null;
  const [row] = await tx
    .insert(reportingLine)
    .values({
      tenantId: ctx.tenantId,
      subordinateEmploymentId: p.subordinateEmploymentId,
      managerEmploymentId: p.managerEmploymentId,
      lineType: 'delegate',
      validFrom: p.validFrom,
      validTo: p.validTo ?? null,
      reason,
      scopeCompanyId: orgScope.companyId,
      scopeBusinessUnitId: orgScope.businessUnitId,
      scopeDepartmentId: orgScope.departmentId,
    })
    .returning({ id: reportingLine.id });
  if (scopes.length > 0) {
    await tx.insert(reportingLineScope).values(
      scopes.map((s) => ({
        tenantId: ctx.tenantId,
        reportingLineId: row.id,
        module: s.module,
        taskType: s.taskType,
      })),
    );
  }
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'reporting-line',
    aggregateId: row.id,
    eventType: 'reporting-line.set',
    actor: actorOf(ctx),
    subjectEmploymentId: p.subordinateEmploymentId,
    // R51: orgScope in the payload mirrors how 0230 evented the module scope (skipSameLevelGuard is an
    // internal control flag, not state — kept out of the audit record).
    payload: { ...p, skipSameLevelGuard: undefined, lineType: 'delegate', reason, scopes, orgScope },
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
      reason,
      scopes,
      orgScope,
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
  p: {
    reportingLineId: string;
    managerEmploymentId: string;
    validFrom: string;
    validTo: string | null;
    // R44 delegation (Phase 2): the re-inserted edge carries the (possibly changed) reason + scope. Absent =
    // no reason / whole-scope on the new edge (the old edge's scope rows drop via CASCADE on supersede? No —
    // supersede keeps the row; but the new edge starts from the values passed here, which the edit form fills).
    reason?: string | null;
    scopes?: { module: string; taskType: string | null }[];
    // R51 (baf56348): the (possibly changed) org coverage. Absent/all-null = unrestricted.
    orgScope?: DelegationOrgScope | null;
  },
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
      reason: p.reason ?? null,
      scopes: p.scopes ?? [],
      orgScope: p.orgScope ?? null,
      // R51 grandfathering: the same-level rule applies only when a NEW stand-in is being chosen. A
      // date-only (or scope-only) edit of a legacy row keeps its recipient and must never fail the guard.
      skipSameLevelGuard: p.managerEmploymentId === old.manager,
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
    // R44 delegation (Phase 2): only meaningful for `delegate` lines — the reason + module/task scope of the
    // hand-over. Ignored for structural line types. Empty scope list = whole-scope (all approvals).
    reason?: string | null;
    scopes?: { module: string; taskType: string | null }[];
    // R51 (baf56348): org coverage — `delegate` lines only. Absent/all-null = unrestricted.
    orgScope?: DelegationOrgScope | null;
    /** 08913328 — movement classification tag. `payload: { ...p }` below already carries it into the
     *  reporting-line.set event, so the Movement projection can tell a Direct Superior change made as
     *  part of a Promotion from a standalone reporting-line edit. */
    movement?: MovementTag;
  },
  /** 08913328 — optional caller transaction, so a Direct Superior change submitted as one leg of a
   *  movement commits atomically with the assignment / grade / pay legs. */
  outerTx?: Tx,
) {
  const run = async (tx: Tx) => {
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
        reason: p.reason ?? null,
        scopes: p.scopes ?? [],
        orgScope: p.orgScope ?? null,
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
  };
  return outerTx ? run(outerTx) : withTenant(ctx, run);
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
  // 8c284478 — Salutation (catalog-backed like religion/race; shown before Full Name on the form).
  salutation?: string | null;
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
  // bf953339 — Mobile + Home phone pair (migration 0304). `person.phone` stays the Mobile Phone Number
  // (an ALWAYS-written core-trio field, so sibling forms carry it through as a hidden input); these three
  // are presence-gated like every other profile field — a form that omits them can never clobber them.
  homePhone?: string | null;
  correspondenceMobilePhone?: string | null;
  correspondenceHomePhone?: string | null;
  emergencyContactName?: string | null;
  emergencyContactRelationship?: string | null;
  emergencyContactPhone?: string | null;
  emergencyContactPhone2?: string | null;
  emergencyContactAddress?: string | null;
};

const PROFILE_FIELD_KEYS: (keyof PersonProfileFields)[] = [
  'salutation', 'firstName', 'lastName', 'preferredName', 'religion', 'race', 'nationality', 'personalEmail',
  'addressLine1', 'addressLine2', 'addressLine3', 'postcode', 'city', 'state', 'country',
  // 3a25f5ee — Permanent + Correspondence address fields (audited by NAME only, PDPA — values never logged).
  'permanentAddressLine1', 'permanentAddressLine2', 'permanentAddressLine3', 'permanentPostcode',
  'permanentCity', 'permanentState', 'permanentCountry',
  'correspondenceAddressLine1', 'correspondenceAddressLine2', 'correspondenceAddressLine3',
  'correspondencePostcode', 'correspondenceCity', 'correspondenceState', 'correspondenceCountry',
  // bf953339 — Home + Correspondence phone pair (audited by NAME only, PDPA — values never logged).
  'homePhone', 'correspondenceMobilePhone', 'correspondenceHomePhone',
];

/**
 * 23ad620e — the five emergency-contact field names are STILL accepted by updatePerson (callers, forms and
 * tests speak them), but they are no longer person COLUMNS: they route into the highest-priority row of
 * person_emergency_contact. Kept out of PROFILE_FIELD_KEYS so the person UPDATE never touches the retired
 * columns, and listed here so the event payload still records which of them a save carried.
 */
const EMERGENCY_CONTACT_FIELD_KEYS = [
  'emergencyContactName', 'emergencyContactRelationship', 'emergencyContactPhone',
  'emergencyContactPhone2', 'emergencyContactAddress',
] as const;
const trimOrNull = (v: string | null | undefined): string | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

// 7d309da7 — the profile columns governed by the profile_option catalog, mapped to their category. A save
// touching any of these validates the NEW value against the tenant's active catalog (legacy value permitted).
const CATALOG_BACKED_COLUMNS: Partial<Record<keyof PersonProfileFields, ProfileOptionCategory>> = {
  // 8c284478 — Salutation joins the catalog-governed set (same legacy-value tolerance).
  salutation: 'salutation',
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
  // 23ad620e — emergencyContactRelationship is no longer a person column; the same 'relationship' catalog
  // rule now runs inside core/emergency-contacts.ts against the register row.
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
        salutation: person.salutation,
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
    // 23ad620e — the emergency block routes into the per-person register (highest-priority row), in this
    // same transaction so the profile save and the contact can never half-apply. Presence semantics are
    // unchanged: a form that omits the block passes nothing and the contact is left alone.
    const emergencyPatch: Record<string, string | null> = {};
    for (const k of EMERGENCY_CONTACT_FIELD_KEYS) {
      if (p[k] !== undefined) {
        emergencyPatch[k] = trimOrNull(p[k]);
        profileFields.push(k);
      }
    }
    if (Object.keys(emergencyPatch).length > 0) {
      await writeSingleEmergencyContactInTx(tx, ctx, p.personId, emergencyPatch);
    }
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
 * max 30 — de2823cc), pre-checks tenant-uniqueness (excluding this employment), and catches the DB unique violation as
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
 *  to clear. The grade applies to future grants/accruals; past ledger entries are untouched.
 *  78853b97 (Movement tab): no-ops when the grade is unchanged (returns { changed: false }, no event —
 *  matching this writer's long-documented contract at its call sites); accepts an optional caller tx
 *  (the exact run(outerTx) pattern of core/comp.ts setCompensation) so a Promotion/Demotion can change
 *  assignment + grade atomically in ONE transaction; and takes an optional movement classification tag
 *  merged into the event payload. Existing callers pass neither — behaviour unchanged for real edits. */
export async function setEmploymentGrade(
  ctx: SessionContext,
  p: { employmentId: string; gradeId: string | null; movement?: MovementTag },
  outerTx?: Tx,
) {
  const run = async (tx: Tx) => {
    const [before] = await tx
      .select({ gradeId: employment.gradeId })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!before) throw new Error('Employment not found');
    if ((before.gradeId ?? null) === (p.gradeId ?? null)) {
      return { id: p.employmentId, changed: false as const };
    }
    await tx.update(employment).set({ gradeId: p.gradeId }).where(eq(employment.id, p.employmentId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employment.grade.changed',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { before: before.gradeId, after: p.gradeId, ...(p.movement ? { movement: p.movement } : {}) },
    });
    return { id: p.employmentId, changed: true as const };
  };
  return outerTx ? run(outerTx) : withTenant(ctx, run);
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
    // 9464bd56 — Cost Centre on the assignment. undefined = carry forward; null = clear; a value must be a
    // live cost centre THIS employee's company MAY use (validated below, same resolver as the other labels).
    // Added so the company-change writer can re-home the cost centre onto the destination company through this
    // same guarded delegate; existing callers omit it, so carry-forward keeps them byte-identical.
    costCenterId?: string | null;
    // 08913328 — Work Location, added for the same reason costCenterId was (9464bd56): a new caller — the
    // Movement comparison form — must move it through this guarded delegate rather than a second writer.
    // undefined = carry forward; null = clear; a value must belong to THIS employee's company (the same
    // cross-company coherence transferEmployee enforces; RLS checks assignment and location independently).
    locationId?: string | null;
    employmentType?: EmploymentTypeValue;
    status?: AssignmentStatusValue;
    /** 78853b97 — optional movement classification tag merged into the event payload (see db/events.ts). */
    movement?: MovementTag;
  },
  /** 78853b97 — optional caller transaction (run(outerTx) pattern, as in core/comp.ts setCompensation)
   *  so a Promotion/Demotion can pair this with setEmploymentGrade atomically. */
  outerTx?: Tx,
) {
  const run = async (tx: Tx) => {
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
    const nextCostCenterId =
      p.costCenterId === undefined ? cur.costCenterId : p.costCenterId || null;
    const nextLocationId = p.locationId === undefined ? cur.locationId : p.locationId || null;
    const nextEmploymentType = p.employmentType ?? cur.employmentType;
    const nextStatus = p.status ?? cur.status;

    // 1001ff61 / 570e3311 — referential integrity + company scope for a newly-selected BU / Department /
    // Position: it must exist, be un-archived, and be a label this employment's company MAY use under the
    // Shared System Labels resolver (origin ∪ shared-in ∪ global, flag-gated — labelUsableByCompany; with
    // the flag OFF this collapses to the old strict same-company check). Unchanged/cleared values skip
    // the check, so re-supplying a stored legacy value never blocks an unrelated save. Defence-in-depth
    // over the nullable FKs, matching the "prevent invalid dropdown selections" requirement.
    const buChanged = nextBusinessUnitId && nextBusinessUnitId !== cur.businessUnitId;
    const deptChanged = nextDepartmentId && nextDepartmentId !== cur.departmentId;
    const posChanged = nextPositionId && nextPositionId !== cur.positionId;
    const ccChanged = nextCostCenterId && nextCostCenterId !== cur.costCenterId;
    // 08913328 — Location is NOT a shared System Label (it is company-owned master data), so it gets
    // transferEmployee's own same-company check rather than labelUsableByCompany.
    const locChanged = nextLocationId && nextLocationId !== cur.locationId;
    if (buChanged || deptChanged || posChanged || ccChanged || locChanged) {
      const [emp] = await tx
        .select({ companyId: employment.companyId })
        .from(employment)
        .where(eq(employment.id, p.employmentId))
        .limit(1);
      if (buChanged) {
        const [bu] = await tx
          .select({ archivedAt: businessUnit.archivedAt })
          .from(businessUnit)
          .where(eq(businessUnit.id, nextBusinessUnitId))
          .limit(1);
        if (
          !bu ||
          bu.archivedAt ||
          !emp ||
          !(await labelUsableByCompany(tx, ctx.tenantId, 'business_unit', nextBusinessUnitId, emp.companyId))
        ) {
          throw new Error('Selected Business Unit is not a valid option for this employee.');
        }
      }
      if (deptChanged) {
        const [dep] = await tx
          .select({ archivedAt: department.archivedAt })
          .from(department)
          .where(eq(department.id, nextDepartmentId))
          .limit(1);
        if (
          !dep ||
          dep.archivedAt ||
          !emp ||
          !(await labelUsableByCompany(tx, ctx.tenantId, 'department', nextDepartmentId, emp.companyId))
        ) {
          throw new Error('Selected Department is not a valid option for this employee.');
        }
      }
      if (posChanged) {
        const [pos] = await tx
          .select({ archivedAt: position.archivedAt })
          .from(position)
          .where(eq(position.id, nextPositionId))
          .limit(1);
        if (
          !pos ||
          pos.archivedAt ||
          !emp ||
          !(await labelUsableByCompany(tx, ctx.tenantId, 'position', nextPositionId, emp.companyId))
        ) {
          throw new Error('Selected Position is not a valid option for this employee.');
        }
      }
      if (ccChanged) {
        const [cc] = await tx
          .select({ archivedAt: costCenter.archivedAt })
          .from(costCenter)
          .where(eq(costCenter.id, nextCostCenterId))
          .limit(1);
        if (
          !cc ||
          cc.archivedAt ||
          !emp ||
          !(await labelUsableByCompany(tx, ctx.tenantId, 'cost_center', nextCostCenterId, emp.companyId))
        ) {
          throw new Error('Selected Cost Centre is not a valid option for this employee.');
        }
      }
      if (locChanged) {
        const [loc] = await tx
          .select({ companyId: location.companyId })
          .from(location)
          .where(eq(location.id, nextLocationId))
          .limit(1);
        if (!loc || !emp || loc.companyId !== emp.companyId) throw new CrossCompanyError('location');
      }
    }

    const unchanged =
      nextDepartmentId === cur.departmentId &&
      nextPositionId === cur.positionId &&
      nextBusinessUnitId === cur.businessUnitId &&
      nextCostCenterId === cur.costCenterId &&
      nextLocationId === cur.locationId &&
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
        costCenterId: nextCostCenterId,
        locationId: nextLocationId,
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
          costCenterId: cur.costCenterId,
          locationId: cur.locationId,
          employmentType: cur.employmentType,
          status: cur.status,
        },
        after: {
          departmentId: nextDepartmentId,
          positionId: nextPositionId,
          businessUnitId: nextBusinessUnitId,
          costCenterId: nextCostCenterId,
          locationId: nextLocationId,
          employmentType: nextEmploymentType,
          status: nextStatus,
        },
        // 78853b97 — movement classification tag (additive; absent for legacy callers).
        ...(p.movement ? { movement: p.movement } : {}),
      },
    });
    return { assignmentId: next.id, changed: true as const };
  };
  return outerTx ? run(outerTx) : withTenant(ctx, run);
}

/**
 * Company-change on a NEW employee (feedback 9464bd56) — the pre-transaction inline correction of an
 * employment's Company. HR often picks the wrong company at hire; while the employee has NO operational
 * activity (employmentCompanyBlockedTx: no payroll / attendance / leave / claim / overtime / loan / roster /
 * review / resignation / saved salary), this re-homes them onto the correct company in ONE audited
 * transaction. Once ANY activity exists the Company locks and HR is steered to Movement / Transfer (which
 * preserves history) — this writer refuses with CompanyLockedError. Moving an ESTABLISHED employee between
 * companies is NOT this path; that stays Movement's job (this deliberately does not touch transferEmployee).
 *
 * Authz: the actor must administer the DESTINATION company (is_admin_for(newCompanyId)) — a group-wide admin,
 * or an admin of BOTH companies. A company-scoped admin of only the current company is rejected up front with
 * DestinationCompanyNotAdministered (a friendly message) instead of the opaque employment_rls WITH CHECK
 * (is_admin_for(NEW)) failure it would otherwise hit. Being able to see/administer the CURRENT employment is
 * enforced by RLS on the reads below (an actor who cannot see it gets "Employment not found").
 *
 * Dependent-default refresh on the move:
 *   • payrollPolicyId → null — a company-scoped pay template; the destination resolves its own at render.
 *   • costAllocation  → null — inter-company cost-split JSON that pointed at the OLD company.
 *   • the OPEN reporting line (hireEmployee inserts one to an OLD-company manager when a manager was supplied
 *     at hire — exactly this window) is removed, so the employee does not land in the new company still
 *     reporting across it; HR re-adds a manager via the normal flow. (reporting_line is deliberately NOT a
 *     gate member — it would false-positive on this very row.)
 *   • gradeId is intentionally NOT reset — job_grade is tenant-scoped (grade_id → job_grade, no company_id),
 *     so it leaves no cross-company dangling reference.
 *   • statutory / payroll config need no recompute — they resolve per-company at render once company_id flips.
 *
 * The assignment (department REQUIRED, plus optional position / business unit / cost centre) is re-homed by
 * DELEGATING to setEmploymentAssignment inside this same transaction: after the company flip it reads the NEW
 * company, so its labelUsableByCompany + archived guards validate every label against the destination for free
 * (honouring shared / global labels), and it carries the business unit that transferEmployee drops. Position
 * and cost centre are CLEARED unless HR re-picks them (a hire-time old-company value must not dangle). Location
 * is validated directly (labelUsableByCompany has no 'location' kind): an HR-supplied location must belong to
 * the destination; a stored old-company location is cleared.
 */
export async function changeEmploymentCompany(
  ctx: SessionContext,
  p: {
    employmentId: string;
    newCompanyId: string;
    departmentId: string;
    positionId?: string | null;
    businessUnitId?: string | null;
    costCenterId?: string | null;
    locationId?: string | null;
  },
) {
  return withTenant(ctx, async (tx) => {
    const [emp] = await tx
      .select({ companyId: employment.companyId, hiredOn: employment.hiredOn })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!emp) throw new Error('Employment not found');
    // No-op guard: moving to the same company is not a change.
    if (emp.companyId === p.newCompanyId) throw new Error('The employee is already in this company.');
    // Destination must be a live (non-archived) company in this tenant.
    const [dest] = await tx
      .select({ id: company.id })
      .from(company)
      .where(and(eq(company.id, p.newCompanyId), isNull(company.archivedAt)))
      .limit(1);
    if (!dest) throw new CrossCompanyError('employment');
    // Authz (correctness, HIGH): flipping company_id trips employment_rls WITH CHECK is_admin_for(NEW).
    // Require it explicitly up front so a company-scoped admin gets DestinationCompanyNotAdministered, not an
    // opaque RLS error. Group-wide admins and admins-of-both pass; admin-of-only-the-current-company does not.
    const adminRes = await tx.execute(sql`select app.is_admin_for(${p.newCompanyId}::uuid) as ok`);
    const canAdminDest = (adminRes as unknown as { ok: boolean }[])[0]?.ok;
    if (!canAdminDest) throw new DestinationCompanyNotAdministered();
    // Server-side gate — the source of truth. Never trust the client's enabled/disabled state; a transaction
    // may have landed between render and submit.
    if (await employmentCompanyBlockedTx(tx, p.employmentId)) throw new CompanyLockedError();

    // Department MUST be usable by the destination. The delegated setEmploymentAssignment only validates a
    // department it sees CHANGE; but on a company move the hire-time department (old company) may be RE-supplied
    // unchanged, which would leave a cross-company dangling reference the delegate silently skips. So validate
    // it here explicitly against the new company (origin ∪ shared ∪ global) — the same resolver, applied to
    // the required label regardless of whether its id changed.
    if (!(await labelUsableByCompany(tx, ctx.tenantId, 'department', p.departmentId, p.newCompanyId))) {
      throw new CrossCompanyError('department');
    }

    // Flip the company FIRST so the delegated assignment write (and its RLS) resolve against the NEW company,
    // and refresh the company-scoped defaults that would otherwise dangle on the old company.
    await tx
      .update(employment)
      .set({ companyId: p.newCompanyId, payrollPolicyId: null, costAllocation: null })
      .where(eq(employment.id, p.employmentId));

    // Remove the open reporting line to an old-company manager (hireEmployee's hire-time edge).
    await tx
      .delete(reportingLine)
      .where(
        and(
          eq(reportingLine.subordinateEmploymentId, p.employmentId),
          isNull(reportingLine.validTo),
          isNull(reportingLine.supersededAt),
        ),
      );

    // Re-home the assignment onto the destination company via the guarded delegate (same tx). effectiveDate =
    // the hire date (= the open assignment's valid_from in this window) keeps the dated range valid even for a
    // future-dated hire. Position / cost centre default to null (cleared) unless HR re-picks a destination one.
    await setEmploymentAssignment(
      ctx,
      {
        employmentId: p.employmentId,
        effectiveDate: emp.hiredOn,
        departmentId: p.departmentId,
        positionId: p.positionId ?? null,
        businessUnitId: p.businessUnitId ?? null,
        costCenterId: p.costCenterId ?? null,
      },
      tx,
    );

    // Location is NOT a System Label; validate it directly against the destination company. An HR-supplied
    // location must belong to the new company; a stored old-company location is cleared.
    const [curAssign] = await tx
      .select({ id: assignment.id, locationId: assignment.locationId })
      .from(assignment)
      .where(
        and(
          eq(assignment.employmentId, p.employmentId),
          isNull(assignment.validTo),
          isNull(assignment.supersededAt),
        ),
      )
      .limit(1);
    const desiredLocationId = p.locationId === undefined ? (curAssign?.locationId ?? null) : p.locationId;
    let nextLocationId: string | null = null;
    if (desiredLocationId) {
      const [loc] = await tx
        .select({ companyId: location.companyId })
        .from(location)
        .where(eq(location.id, desiredLocationId))
        .limit(1);
      // An EXPLICIT HR choice that is not in the destination is a hard error; a carried-forward old-company
      // location just gets cleared.
      if (p.locationId != null && (!loc || loc.companyId !== p.newCompanyId)) {
        throw new CrossCompanyError('location');
      }
      nextLocationId = loc && loc.companyId === p.newCompanyId ? desiredLocationId : null;
    }
    if (curAssign && (curAssign.locationId ?? null) !== nextLocationId) {
      await tx.update(assignment).set({ locationId: nextLocationId }).where(eq(assignment.id, curAssign.id));
    }

    // Audit (SUBSTRATE): a correction, NOT a movement — appendEvent lands it in the audit trail while it stays
    // OUT of MOVEMENT_EVENT_TYPES, so it never appears in the Movement/Transfer history projection.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employment.company.changed',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { before: { companyId: emp.companyId }, after: { companyId: p.newCompanyId } },
    });

    return { employmentId: p.employmentId, from: emp.companyId, to: p.newCompanyId };
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
  /** 89ea527b — MOVEMENT-ONLY. The GROUP Join Date: the employee's first day anywhere in the corporate group,
   *  and the master reference every service-length figure reads (see the gate below for the full consumer
   *  list). Honoured solely under the `groupJoinDateCorrection` movement tag; a plain save that posts it is
   *  IGNORED, exactly like extendedConfirmationDate. Set once at hire by hireEmployee, never by this writer
   *  without a movement. */
  hiredOn?: string;
  /** "Join Date" (feedback 24c4d02e) — the current-company effective join date. Nullable; '' / null clears it.
   *  89ea527b — MOVEMENT-ONLY: honoured solely under the `joinDateChange` movement tag (an internal company
   *  transfer, a rehire into another group company, a restructure). Seeded = hiredOn at creation. */
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
  /** d27961e3 — MOVEMENT-ONLY. Probation extensions left the Employment Dates form: this field is honoured
   *  solely when the call carries the `probationExtension` movement tag (i.e. it came from
   *  createMovementEvent, the single mutator). A plain save that posts it is IGNORED (forge-proof). */
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
  /** 78853b97 — optional movement classification tag merged into the event payload (see db/events.ts).
   *  NOT a column: never enters the write set, only the audit payload. */
  movement?: MovementTag;
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
  // 89ea527b — joinDate is NOT in this list any more: it is movement-only (accepted above solely under the
  // `joinDateChange` movement tag), so the Employment Dates form can no longer set it. hiredOn was never in
  // this list (it is NOT NULL and has its own block, likewise now movement-gated).
  'confirmationDate',
  'resignationDate',
  // 955c7de4 — new lifecycle dates. finalConfirmationDate is DERIVED (not in this list; computed on save).
  // d27961e3 — extendedConfirmationDate is NOT in this list either: it is movement-only (accepted below
  // solely under the probationExtension movement tag), so the Employment Dates form can no longer set it.
  'tenderResignationDate',
  'lastWorkingDate',
] as const;

export async function setEmploymentInfo(
  ctx: SessionContext,
  p: EmploymentInfoInput,
  /** c5ac75fa — optional caller transaction (the same run(outerTx) pattern setEmploymentGrade and
   *  setEmploymentAssignment already use). The consolidated Organisation Assignment save on the Personnel
   *  Employment tab drives grade + effective-dated assignment + these flat org columns from ONE button, so
   *  all three must commit or roll back together — a half-save would leave the dated assignment history and
   *  the flat columns disagreeing with each other. */
  outerTx?: Tx,
) {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new Error('Only an admin can edit employment information.');
  }

  // Build the write set: only columns the caller actually provided. `undefined` = untouched; a period/text
  // field passed as '' or null clears to NULL. Validate + normalise as we go.
  const set: Record<string, string | number | null> = {};

  // 89ea527b — the GROUP Join Date (hiredOn) is MOVEMENT-ONLY. It is the single date every service-length
  // consumer reads — core/leave.ts serviceYearsAt (leave service bands via resolveGradePolicy), servedFor
  // (minimum-service eligibility), maternityAllowanceEligibility, earnedCycleStart / first-year proration,
  // core/read.ts + core/analytics.ts band resolution, core/performance.ts serviceMonths — so a free edit on a
  // screen silently re-prices an employee's leave entitlement with no dated record of why. Accepting it only
  // under the `groupJoinDateCorrection` movement tag means every move of that date carries an effective date,
  // a reason and a history row. An untagged save posting it is silently IGNORED (forge-proof, as with
  // extendedConfirmationDate) rather than rejected, so a stale/tampered form cannot mutate it either.
  if (p.hiredOn !== undefined && p.movement?.type === 'groupJoinDateCorrection') {
    const v = String(p.hiredOn).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('Hire date is required and must be a valid date.');
    set.hiredOn = v;
  }
  // 89ea527b — the current-company Join Date is MOVEMENT-ONLY too (`joinDateChange`): it is what changes when
  // an employee moves between companies inside the group, and that is a movement, not an edit. Unlike hiredOn
  // it drives NO entitlement — only the Employment tab's current-company length-of-service figure.
  if (p.joinDate !== undefined && p.movement?.type === 'joinDateChange') {
    const v = p.joinDate == null ? null : String(p.joinDate).trim();
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('Enter a valid date (YYYY-MM-DD).');
    set.joinDate = v || null;
  }
  for (const f of EMPLOYMENT_INFO_DATE_FIELDS) {
    const raw = p[f];
    if (raw === undefined) continue;
    const v = raw == null ? null : String(raw).trim();
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('Enter a valid date (YYYY-MM-DD).');
    set[f] = v || null;
  }
  // d27961e3 — Extended Confirmation Date left the Employment Dates form: probation extensions are managed
  // EXCLUSIVELY through the Movement module (createMovementEvent 'probationExtension' delegates here with the
  // movement tag). Without that tag the field is silently IGNORED — a forged form submission cannot mutate it —
  // so the movement writer stays the single mutator. Derivation + ordering guards below are unchanged.
  if (p.extendedConfirmationDate !== undefined && p.movement?.type === 'probationExtension') {
    const v = p.extendedConfirmationDate == null ? null : String(p.extendedConfirmationDate).trim();
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('Enter a valid date (YYYY-MM-DD).');
    set.extendedConfirmationDate = v || null;
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

  const run = async (tx: Tx) => {
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

    // 89ea527b — a Group Join Date Correction on an employment whose two dates are still SYNCHRONISED carries
    // the Join Date with it. The dates start identical (hireEmployee seeds joinDate = hiredOn) and only
    // diverge when a joinDateChange movement records a move to another group company. So join_date === the
    // OLD hired_on means "this employee has never transferred", and correcting their group join date without
    // moving their company join date would invent a divergence that never happened.
    //
    // It is also what keeps the correction usable at all. The invariant below (join ≥ hire) is real, but for a
    // never-transferred employee join EQUALS hire, so ANY forward correction would trip it and there would be
    // no way to fix a group join date that was keyed a day late — the caller cannot pre-move the join date
    // either, because that needs the other tag. Carrying it resolves the correction in one movement.
    // A DIVERGED employment is deliberately left alone: there the two dates mean different things, and the
    // guard rejecting a correction that would post-date the real company join date is the correct answer.
    if (set.hiredOn !== undefined && !('joinDate' in set) && before.joinDate === before.hiredOn) {
      set.joinDate = set.hiredOn;
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
      payload: { fields: Object.keys(set), before, after, ...(p.movement ? { movement: p.movement } : {}) },
    });
    return { id: p.employmentId };
  };
  return outerTx ? run(outerTx) : withTenant(ctx, run);
}

/**
 * Employee Status redesign (R43 c26c3ce5) — set/clear the Blacklist override. Employee Status is otherwise
 * SYSTEM-DERIVED read-time from the lifecycle dates (core/employment-status.ts); Blacklist is the ONE stored,
 * event-driven exception status, set by authorised HR. Admin-gated (defence-in-depth over the employment RLS
 * admin-write policy). Idempotent: setting an already-blacklisted employment (or clearing an already-clear
 * one) is a no-op with no event. Emits `employment.blacklisted` / `employment.blacklist.cleared` with a
 * before/after diff so every transition is audited (substrate discipline).
 */
export async function setEmploymentBlacklist(
  ctx: SessionContext,
  p: { employmentId: string; blacklisted: boolean; reason?: string | null },
) {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new Error('Only an admin can change the blacklist status.');
  }
  const today = new Date().toISOString().slice(0, 10);
  const reason = p.reason == null ? null : String(p.reason).trim() || null;
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ blacklistedAt: employment.blacklistedAt, blacklistReason: employment.blacklistReason })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!before) throw new Error('Employment not found');

    const alreadyBlacklisted = before.blacklistedAt != null;
    // No-op guards: nothing to do when the on/off state (and, when staying on, the reason) is unchanged.
    if (!p.blacklisted && !alreadyBlacklisted) return { id: p.employmentId, blacklisted: false as const, changed: false as const };
    if (p.blacklisted && alreadyBlacklisted && reason === (before.blacklistReason ?? null)) {
      return { id: p.employmentId, blacklisted: true as const, changed: false as const };
    }

    const set = p.blacklisted
      ? { blacklistedAt: before.blacklistedAt ?? today, blacklistReason: reason }
      : { blacklistedAt: null, blacklistReason: null };
    await tx.update(employment).set(set).where(eq(employment.id, p.employmentId));

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: p.blacklisted ? 'employment.blacklisted' : 'employment.blacklist.cleared',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: {
        before: { blacklistedAt: before.blacklistedAt, reason: before.blacklistReason },
        after: { blacklistedAt: set.blacklistedAt, reason: set.blacklistReason },
      },
    });
    return { id: p.employmentId, blacklisted: p.blacklisted, changed: true as const };
  });
}

/** R46 79eb7151 — the disbursement channels an employee can be paid through. */
export const PAYMENT_METHODS = ['bank_transfer', 'cheque', 'cash'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** R46 79eb7151 — Payment Method is 'bank_transfer' but the employee has no usable bank destination. */
export class MissingBankForTransferError extends Error {
  constructor(message = 'Bank Transfer requires both a bank name and an account number for this employee.') {
    super(message);
    this.name = 'MissingBankForTransferError';
  }
}

/**
 * R46 79eb7151 — set HOW this employee is paid (bank transfer / cheque / cash). Pass `null` to clear back to
 * "not specified". Admin-gated (defence-in-depth over the employment RLS admin-write policy) and idempotent:
 * re-setting the same value is a no-op with no event.
 *
 * The bank-transfer invariant is enforced HERE rather than in the DB because the bank details live on a
 * different, PERSON-keyed table (employee_statutory_my) — a CHECK constraint cannot reach across it. We
 * require BOTH bankName and bankAccountNo: half a destination is not a payable one, and letting it through
 * would surface as an unroutable row in the bank file long after the person who set it moved on. This is the
 * same both-or-neither posture the bank card already takes on the custom-holder pair.
 *
 * NOTE what this function deliberately does NOT touch: Pay Mode (payroll_policy.policy_type) and Payment Term
 * (PayrollPolicyConfig.frequency). Those belong to the assigned policy and stay there — see ADR-0064.
 */
export async function setEmploymentPaymentMethod(
  ctx: SessionContext,
  p: { employmentId: string; paymentMethod: PaymentMethod | null },
) {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new Error('Only an admin can change the payment method.');
  }
  const next = p.paymentMethod;
  if (next != null && !(PAYMENT_METHODS as readonly string[]).includes(next)) {
    throw new Error('Payment method is invalid.');
  }
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ paymentMethod: employment.paymentMethod, personId: employment.personId })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!before) throw new Error('Employment not found');
    // Idempotent — no write, no event, when nothing moved.
    if ((before.paymentMethod ?? null) === (next ?? null)) {
      return { id: p.employmentId, paymentMethod: next, changed: false as const };
    }

    if (next === 'bank_transfer') {
      const [bank] = await tx
        .select({
          bankName: employeeStatutoryMy.bankName,
          bankAccountNo: employeeStatutoryMy.bankAccountNo,
        })
        .from(employeeStatutoryMy)
        .where(eq(employeeStatutoryMy.personId, before.personId))
        .limit(1);
      if (!bank?.bankName?.trim() || !bank?.bankAccountNo?.trim()) {
        throw new MissingBankForTransferError();
      }
    }

    await tx.update(employment).set({ paymentMethod: next }).where(eq(employment.id, p.employmentId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employment.payment-method.changed',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // How someone is paid is a disbursement-routing decision an auditor must be able to reconstruct —
      // same rationale as the bank/custom-holder before/after on employee.bank.updated.
      payload: { before: before.paymentMethod ?? null, after: next },
    });
    return { id: p.employmentId, paymentMethod: next, changed: true as const };
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
