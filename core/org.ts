/**
 * Organizational lifecycle services (ADR-0003). Each mutation runs inside `withTenant`
 * (one transaction, RLS scoped to the session) and appends a domain event before returning.
 * Effective-dated changes CLOSE + INSERT; we never overwrite history.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf, subjectEmploymentForPerson, type MovementTag } from '../db/events';
// r285 (a3a3acd6) — `closedPeriodsTx` + `overlapsClosedPeriod` are the repo's SINGLE definition of payroll
// evidence (core/pay-components.ts:1977). setEmploymentInfo's closed-payroll gate reuses them rather than
// writing a fourth one; org.ts already imported from comp.ts, so this adds no new edge to the import graph.
import { closedPeriodsTx, nextEmployeeCode, overlapsClosedPeriod } from './comp';
import { generateEmployeeCode } from './employee-id-config';
// 06f0cb8f — "is this Employee ID free?" is a TWO-table question now (an employment may carry it, or a
// draft may be holding it). Its own module because core/employee-draft.ts imports hireEmployee from here,
// so the rule cannot live there without a cycle — and two copies of it would let an ID be issued twice.
import { findEmployeeCodeClaim } from './employee-code-claims';
import { requireEmployeeCode } from '../lib/employee-code';
import { applyMaxBalance, applyRounding, composeEntitlement, hireYearGrantDays, isAccrualUnconfigured, isEarnedMethod, leaveTypeRuleColumns } from './leave';
// 6e9a126e RELEASE TWO — the entitlement TEMPLATE resolver. Imported from its own module rather than
// re-exported through core/leave, which core/org.ts already imports: one hop, no cycle either way.
import { buildTemplateEntitlementResolver } from './entitlement-template';
import { packFor } from '../localization/registry';
import { labelUsableByCompany } from './system-labels';
import { deriveEmploymentStatus } from './employment-status';
// ae9350f2 — the coded exit reason derives the turnover classification. termination-reason.ts imports only
// the TerminationType TYPE back from this file, so the cycle is erased at compile time and there is no
// runtime import loop.
import { terminationTypeForReason } from './termination-reason';
// Company-change gate (9464bd56): the pre-transaction check lives in core/read.ts (ONE greppable set of
// module heads). Imported here so the company-change writer re-runs it as its server-side source of truth
// inside the same transaction. read.ts does not import org.ts, so this adds no import cycle.
import { employmentCompanyBlockedTx } from './read';
import { assertProfileValueAllowed, type ProfileOptionCategory } from './profile-options';
// 23ad620e — the emergency contact is a per-person register now, not five person columns.
import { writeSingleEmergencyContactInTx } from './emergency-contacts';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  person,
  employment,
  assignment,
  businessUnit,
  company,
  costCenter,
  department,
  holidayGroup,
  leaveType,
  location,
  position,
  reportingLine,
  reportingLineScope,
  leaveLedger,
  employmentTypeEnum,
  // R46 79eb7151 — read-only here, to validate the bank-transfer payment method against the person's
  // salary-payment destination. This module never WRITES the statutory row.
  employeeStatutoryMy,
} from '../db/schema';

export type EmploymentTypeValue = (typeof employmentTypeEnum.enumValues)[number];
// R81 (9cbf5e0d): `AssignmentStatusValue` is GONE with the `assignment_status` enum it aliased (migration
// 0331). Employee Status is derived — the only status vocabulary left is EmploymentStatus in
// core/employment-status.ts, and it has no stored counterpart to alias.

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
  initialTaxScheme?:'resident'|'non_resident';
  /** 35b7af0a group 8 — `nationality` joins the trio this writer already seeds on a NEW person. It belongs
   *  at creation rather than in a follow-up `updatePerson`: `setPassportProfileMY` and the SOCSO/EIS number
   *  default both read `person.nationality`, so a second write afterwards could only ever be too late, and
   *  a write that can fail AFTER the employment exists is a half-created employee. Ignored when `id` is
   *  given — an existing person's profile is edited through updatePerson, which audits the change. */
  person: { id?: string; fullName?: string; primaryEmail?: string; phone?: string; nationality?: string | null };
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
  /** The draft whose HELD Employee ID this hire is consuming (item 06f0cb8f). Set ONLY by
   *  `completeEmployeeDraft`. Since 06f0cb8f an ID can be spoken for by a draft as well as by an
   *  employment, and Activate hands `hireEmployee` the very code that draft is holding — so without this
   *  the uniqueness check would refuse every activation on the grounds that the ID is taken, by the draft
   *  being activated. It excludes exactly one row and nothing else; any OTHER draft holding the code is
   *  still a refusal. */
  fromEmployeeDraftId?: string;
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
          nationality: p.person.nationality ?? null,
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
      await assertEmployeeCodeUnique(tx, ctx.tenantId, employeeCode, undefined, p.fromEmployeeDraftId);
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
    // 8590615a — THE TWO-HOMES FIX. A contract hire's end date used to land ONLY in `provisional_end_on`,
    // while the Employment Review row wrote `contract_end_date`, so the same fact could sit in one column
    // and be missing from the other. A contract hire now seeds BOTH: contract_end_date = the end date the
    // wizard captured, contract_start_date = hiredOn (mirroring the joinDate = hiredOn seeding on the same
    // insert — at creation the contract starts the day the employment does). provisional_end_on is still
    // written unchanged, because full_time and intern hires depend on it and on the
    // computeReviewWindow fallback that reads it. Non-contract hires are byte-identical to before.
    const isContractHire = p.employmentType === 'contract';
    const [emp] = await tx
      .insert(employment)
      .values({
        tenantId: ctx.tenantId,
        personId,
        companyId: p.companyId,
        hiredOn: p.hiredOn,
        joinDate: p.hiredOn,
        employeeCode,
        gradeId: p.gradeId ?? null,
        provisionalEndOn,
        contractStartDate: isContractHire ? p.hiredOn : null,
        contractEndDate: isContractHire ? provisionalEndOn : null,
      })
      .returning({ id: employment.id });

    // R81 (9cbf5e0d): the `status` column is GONE from `assignment` (migration 0331). A hire used to write
    // 'probation' or 'active' here from the employment type + provisional end date; Employee Status is now
    // DERIVED for every employee from the lifecycle dates (core/employment-status.ts), and `provisionalEndOn`
    // — which this block already computed — is exactly what the deriver reads to return 'probation'. So the
    // hire keeps setting the FACT (the provisional end date, written on `employment` above) and stops
    // duplicating the CONCLUSION. The two can no longer disagree because there is only one of them left.
    await tx.insert(assignment).values({
      tenantId: ctx.tenantId,
      employmentId: emp.id,
      departmentId: p.departmentId,
      positionId: p.positionId ?? null,
      costCenterId: p.costCenterId ?? null,
      employmentType: p.employmentType,
      // 3c88d593 — every employment's entity history now STARTS here, on the hire, so nobody hired after
      // migration 0440 ever needs the backfill or the resolver's employment.company_id fallback.
      companyId: p.companyId,
      validFrom: p.hiredOn,
      validTo: null,
    });

    /**
     * r78c — the hire and its own reporting line are ONE event, so they share ONE movement group.
     * `reporting-line.set` is a MOVEMENT_EVENT_TYPE: emitted untagged (as it was) the hire-time line
     * projected a SECOND Employment History row, "Reporting Line Change", dated the same day as Hired.
     * Every employee hired with a manager therefore opened their history with two rows for one action —
     * the same one-event-two-rows fault the reporter raised about Promotion.
     *
     * Tagging the line `secondary` makes the projection skip it (core/movement.ts:315). The events
     * themselves are unchanged in number, type and subject — only the payload gains the classification
     * tag, so audit readers see no loss, and the Hired row's detail view still resolves the manager (it
     * reads the reporting_line table as-of, not the ledger).
     *
     * `employment.hired` is deliberately left UNTAGGED. Giving it the same groupId would pull the
     * reporting-line leg into the Hired row's correctability group, and that group is what decides
     * `stateChanging` — a hire dated inside a CLOSED payroll period would then start rendering a
     * "payroll locked" note on its Hired row. The tag would have bought nothing: the projection
     * hard-codes the Hired row's label, and it is not correctable either way.
     */
    const hireGroupId = randomUUID();

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
          movement: { type: 'hired', groupId: hireGroupId, secondary: true } satisfies MovementTag,
        },
      });
    }

    if (p.grantLeaveTypes?.length) {
      // Entitlement comes from the employee's winning ENTITLEMENT TEMPLATE band. The country pack's
      // statutory floor is still resolved, but fa3f4ccb made it ADVISORY — it flags a below-minimum
      // figure and never clamps one.
      const [co] = await tx
        .select({ country: company.country })
        .from(company)
        .where(eq(company.id, p.companyId))
        .limit(1);
      const pack = packFor(co?.country);
      if (pack) {
        // 6e9a126e — the entitlement TEMPLATE layer, resolved AT THE HIRE DATE. Release three removed the
        // two reads that stood here (the types' active `leave_policy` rows and the benefit-scheme
        // resolver), so this is the whole entitlement resolution. It runs after the assignment insert in
        // this same transaction, so the eligibility resolver's department / position / employment-type
        // read sees this hire; a brand-new employment has no earlier assignment version, so "as at the
        // hire date" and "current" coincide here by construction. No templates ⇒ `isEmpty` ⇒ nothing
        // resolves ⇒ the `days <= 0` skip below writes no row at all.
        const templates = await buildTemplateEntitlementResolver(tx, {
          employmentIds: [emp.id],
          leaveTypeIds: p.grantLeaveTypes.map((t) => t.id),
          asOf: p.hiredOn,
        });
        // Feedback 9816a5ad step 2 — the hire grant is a GRANTING ENGINE and must resolve its rules from
        // the same place openLeaveYear / accrueEarnedLeave / the recalc kernel do, or a new hire's opening
        // balance disagrees with the very next reprojection and the recalc posts a permanent delta.
        // The rules are loaded here rather than threaded through `grantLeaveTypes` deliberately: that
        // parameter is built by three separate callers (the admin hire action, the bulk importer, tests)
        // and a caller that forgot to populate them would silently fall back to the policy's rules.
        const typeRuleRows = await tx
          .select({ id: leaveType.id, ...leaveTypeRuleColumns })
          .from(leaveType)
          .where(inArray(leaveType.id, p.grantLeaveTypes.map((t) => t.id)));
        const typeRulesById = new Map(typeRuleRows.map((r) => [r.id, r]));
        for (const lt of p.grantLeaveTypes) {
          // bc36c768 — THE NOT-CONFIGURED GATE, FIRST, before any method resolution. This is the gate that
          // makes the reset safe for NEW JOINERS: a cleared type has no accrual_method, an absent method
          // has always meant the LUMP path, and the lump path would credit this new hire a full (or
          // month-prorated) year's entitlement on the spot — which nothing in this system can take back.
          // They are credited +0.00 instead and lose nothing: saving the earning method for the type runs
          // the cohort catch-up that credits everything owed (reprojectEntitlementForLeaveTypeCohort).
          if (isAccrualUnconfigured(typeRulesById.get(lt.id))) continue;
          // 9816a5ad step 2: the winning template band supplies the DAYS; the leave TYPE supplies every
          // rule. The SAME `composeEntitlement` openLeaveYear / accrueEarnedLeave / the recalc kernel use —
          // a hire grant that resolved by any other route would disagree with the very next reprojection
          // and post a permanent delta. fa3f4ccb: the EA floor is passed for the below-minimum flag only;
          // it no longer clamps the hire grant.
          const { days, policy: polFor } = composeEntitlement({
            floorDays: pack.leave.entitlement(lt.code, 0),
            // A new hire has 0 completed years of service (explicit — the argument is required so a
            // band-configured table resolves its 0-year band at hire).
            templateBand: templates.bandFor(emp.id, lt.id, 0),
            rules: typeRulesById.get(lt.id),
          });
          // 2D (ADR-0040): earned types accrue through the year via accrueEarnedLeave, not the hire lump.
          if (isEarnedMethod(polFor?.method)) continue;
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
          //
          // r193 LIFTED THIS OUT VERBATIM into `hireYearGrantDays` (core/leave.ts) — unchanged in every
          // branch — because `openLeaveYear` now reaches employments hired during the leave year and must
          // shape their first year IDENTICALLY or the recalc kernel claws the difference back. One
          // definition, two callers; see that function's header for the argument.
          const grantRaw = hireYearGrantDays({
            days,
            typeCode: lt.code,
            yearCycleOverride: lt.yearCycleOverride,
            hiredOn: p.hiredOn,
          });
          // Feedback b81d3c52 — Rounding Method: the reporter's own worked example (a 6-Jan joiner whose
          // pro-rated entitlement lands on a fraction). Tidy the CALCULATED figure to a whole day as the
          // FINAL step of the earning calculation and BEFORE the max-balance clamp — the identical point
          // and order openLeaveYear / accrueEarnedLeave / projectExpectedEntitlement apply it, so the
          // credited ledger row and the recalc kernel's projection can never disagree. The pro-ration
          // formula itself (whole months remaining) is unchanged. No method ⇒ pass-through.
          const grantRounded = applyRounding(grantRaw, polFor?.roundingMethod, polFor?.roundingThreshold, polFor?.roundingBands);
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
        // R81 (9cbf5e0d): this key used to carry the stored `assignment.status` written on the line above.
        // With the column dropped there is no stored status to record, so the event carries the DERIVED
        // status the new hire actually starts on — computed from the very dates this event already reports,
        // so the audit trail keeps a status without anything having to store one. Historical hire events
        // keep whatever value they were written with; this is not a rewrite of the past.
        assignmentStatus: deriveEmploymentStatus({ provisionalEndOn }, p.hiredOn),
        provisionalEndOn,
        // Additive only (feedback 38668d9b) — original keys above are preserved for CP22/audit readers.
      },
    });

    const [taxCompany]=await tx.select({country:company.country}).from(company).where(eq(company.id,p.companyId)).limit(1);
    await packFor(taxCompany?.country)?.statutory.initializeHiredTaxSelectionTx?.(tx,ctx,{employmentId:emp.id,companyId:p.companyId,scheme:p.initialTaxScheme??'resident'});
    return { employmentId: emp.id, personId };
  });
}

/**
 * r78c — this service now has NO production caller. Its two callers were transferAction (deleted: an
 * unreferenced `use server` endpoint) and setLocationAction (rerouted through the movement recorder, which
 * uses setEmploymentAssignment instead — that writer carries every assignment dimension forward, where this
 * one only ever carried a subset; r73's business-unit loss came from exactly that gap).
 *
 * It is kept, not deleted, because it is the ONLY writer of the `assignment.transferred` event type that
 * years of production history already contains, and core/movement.ts still projects and REVERSES that type
 * (reverseLegTx). Deleting the writer would leave the projection reading an event nothing can produce,
 * which is how a replay path silently rots. Its own regression suite
 * (test/transfer-preserves-business-unit.test.ts) stays green against it.
 *
 * Do not wire a new caller to it: a new transfer belongs on the movement recorder, tagged and grouped.
 */
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
        // 3c88d593 — carried, exactly like the business unit above and for the same reason: a department
        // transfer inside one legal entity must not silently blank the entity history. NO caller of this
        // writer moves a company (that is transferEmploymentCompanyTx's job), so there is no parameter.
        companyId: cur.companyId,
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

/**
 * The parameters of a termination. Split out so core/movement.ts's Termination movement and the
 * resignation-approval path (ADR-0042) share one shape.
 *
 * ae9350f2 adds `terminationReasonCode`, `terminationNoticeDays` and `movement`. All three are optional and
 * every pre-existing caller — imports, seeds, the resignation-approval flow, the Wave 4A tests — behaves
 * exactly as before when they are omitted.
 */
export type TerminateEmploymentInput = {
  employmentId: string;
  terminationDate: string;
  terminationType?: TerminationType;
  terminationReason?: string;
  /**
   * ae9350f2 — the coded exit reason (core/termination-reason.ts). When present it DERIVES
   * `terminationType`, so a caller never has to keep the two in step; an explicitly passed
   * `terminationType` is only used when no code was given.
   */
  terminationReasonCode?: string | null;
  /** ae9350f2 — notice actually served, in days. */
  terminationNoticeDays?: number | null;
  /**
   * ae9350f2 — movement classification tag (db/events.ts). NOT a column: it rides on the
   * `employment.terminated` payload so Employment History renders ONE row per termination, with the
   * companion legs (last working date, notice) tagged `secondary` under the same groupId. r78's finding
   * was that an untagged companion writer is exactly how a movement grows a second history row.
   */
  movement?: MovementTag;
};

/** The termination write, runnable inside a caller's transaction — so an accepted resignation can
 *  terminate atomically (ADR-0042). Sets the leave date + turnover classification, closes the open
 *  assignment version, and emits employment.terminated. */
export async function terminateEmploymentTx(
  tx: Tx,
  ctx: SessionContext,
  p: TerminateEmploymentInput,
) {
  // ae9350f2 — the coded reason is the single source of the classification when it is present. An unknown
  // code resolves to null and falls back to whatever the caller passed, so a tampered form can neither set
  // an arbitrary code (core/movement.ts validates before reaching here) nor silently blank the enum.
  const derivedType = terminationTypeForReason(p.terminationReasonCode);
  await tx
    .update(employment)
    .set({
      terminatedOn: p.terminationDate,
      // Wave 4A: capture the turnover classification (null when not provided).
      terminationType: derivedType ?? p.terminationType ?? null,
      terminationReason: p.terminationReason?.trim() || null,
      // ae9350f2 — only written when the caller supplied them, so the resignation-approval path and the
      // importers leave both columns untouched rather than clearing a previously recorded value.
      ...(p.terminationReasonCode !== undefined ? { terminationReasonCode: p.terminationReasonCode || null } : {}),
      ...(p.terminationNoticeDays !== undefined ? { terminationNoticeDays: p.terminationNoticeDays } : {}),
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
      terminationType: derivedType ?? p.terminationType ?? null,
      terminationReason: p.terminationReason?.trim() || null,
      // ae9350f2 — the structured exit detail, on the event as well as the row so the history stays
      // truthful for a termination recorded years ago (a live column read would show today's value).
      ...(p.terminationReasonCode !== undefined ? { terminationReasonCode: p.terminationReasonCode || null } : {}),
      ...(p.terminationNoticeDays !== undefined ? { terminationNoticeDays: p.terminationNoticeDays } : {}),
      ...(p.movement ? { movement: p.movement } : {}),
    },
  });
}

export async function terminateEmployment(ctx: SessionContext, p: TerminateEmploymentInput) {
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
 *
 * IT IS NOW A TWO-TABLE QUESTION (item 06f0cb8f). A Draft holds an Employee ID from the moment it is
 * created, so an ID can be spoken for without any employment carrying it yet. This check runs on EVERY
 * path that hands out an ID — the hire form, the bulk importer (`commitEmployeeImport` goes through
 * `hireEmployee`, so it inherits it), and `setEmployeeCode` — which is what makes the reporter's
 * "cannot be assigned to another employee, even if the employee remains in Draft status" true rather
 * than merely intended. `excludeDraftId` is how a draft's own Activate does not collide with itself.
 */
async function assertEmployeeCodeUnique(
  tx: Tx,
  tenantId: string,
  code: string,
  excludeEmploymentId?: string,
  excludeDraftId?: string,
): Promise<void> {
  const claim = await findEmployeeCodeClaim(tx, tenantId, code, { excludeEmploymentId, excludeDraftId });
  if (claim === 'employment') throw new Error(`Employee ID "${code}" is already in use`);
  // Named differently ON PURPOSE. "Already in use" sends HR looking for an employee who does not exist;
  // the ID is being held by an unfinished record, and the way out is to find that Draft in the employee
  // list and either finish it or discard it.
  if (claim === 'draft') throw new Error(`Employee ID "${code}" is reserved by a draft employee record`);
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

/**
 * 9e2a89e9 — THIS EMPLOYMENT'S JOB GRADE RIGHT NOW, as one indexed read.
 *
 * It exists for one job: a caller that is about to record a movement needs the grade as it stands BEFORE
 * the write, so the entitlement recalc that follows can name both grades on its history row. By the time
 * `reprojectEntitlementForEmployment` runs the profile write has committed, so it can only see the new
 * one, and re-deriving the old one from the `employment.grade.changed` event trail would be a second
 * reader of that history to keep in step with corrections and reversals.
 *
 * Returns null both for "no grade recorded" (47 of 74 active employments on production) and for an
 * employment this caller cannot read through RLS. Neither is an error: the audit row simply records no
 * previous grade, which is the truth in both cases.
 */
export async function employmentGradeId(ctx: SessionContext, employmentId: string): Promise<string | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ gradeId: employment.gradeId })
      .from(employment)
      .where(eq(employment.id, employmentId))
      .limit(1);
    return row?.gradeId ?? null;
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
    /**
     * 3c88d593 — THE LEGAL ENTITY this dated version belongs to (migration 0440). undefined = carry
     * forward, which is what every existing caller does and why they are all unchanged.
     *
     * Only ONE caller passes a value: the entity-transfer writer below, which is the only act in this
     * system that moves a person between companies. It is a parameter rather than a read of
     * `employment.company_id` because the transfer flips that column first (so the later legs validate
     * against the destination) — reading it here would make the OLD range look as though it had always
     * been the new entity, which is the exact fault this item exists to fix.
     *
     * The carry-forward stamps the employment's CURRENT company when the open version predates 0440 and
     * carries NULL. That is deliberate: a new version opens on `effectiveDate`, which is now or later,
     * and today's column is authoritative for now — so entity history starts accreting from the first
     * assignment change after deploy even on a tenant whose backfill has not run. It never rewrites the
     * closed range it inherited from, which stays NULL and stays served by the resolver's fallback.
     */
    companyId?: string;
    /**
     * R81 (9cbf5e0d) — the `status?: AssignmentStatusValue` (a now-deleted alias) parameter that used to sit here is REMOVED, and
     * with it the last way anything in this system could set an Employee Status by hand. It was the live
     * end of the manual path: the Personnel form behind it was already deleted (8ebabbf2) and no caller
     * passed it, but an exported service parameter is callable whether or not any UI references it, so
     * leaving it would have kept "no manual editing" a convention rather than a guarantee. The column it
     * wrote is gone too (migration 0331) — the parameter could not be re-added without re-adding the schema.
     */
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
    // 3c88d593 — the entity for the new version: what the caller named, else what the open version
    // already carries, else today's column (see the parameter note). The employment read fires ONLY on
    // the third branch — a pre-0440 row that has not been backfilled — so once the backfill has run this
    // costs nothing.
    const nextCompanyId =
      p.companyId ??
      cur.companyId ??
      (
        await tx
          .select({ companyId: employment.companyId })
          .from(employment)
          .where(eq(employment.id, p.employmentId))
          .limit(1)
      )[0]?.companyId ??
      null;

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
      // 3c88d593 — the entity is a dimension of this row like any other, so a version that changes ONLY
      // the company is a change. Without this line an entity transfer that moves nothing else (the
      // restructure case: same department, same position, new legal entity) would be swallowed by the
      // no-op guard and write no dated history at all — which is the fault, not a saving.
      //
      // ⚠️ IT ASKS WHAT THE CALLER NAMED, not what `nextCompanyId` resolved to, and the difference is
      // deliberate. The carry-forward branch above turns a pre-0440 NULL into today's company, so testing
      // the resolved value would make a save that changes NOTHING write a version — and emit an
      // Employment History row — the first time anybody touched any employee after deploy. A no-op stays
      // a no-op; the resolved value is still what gets STAMPED whenever some other dimension does move,
      // so history accretes on real changes without inventing one.
      !(p.companyId !== undefined && p.companyId !== cur.companyId);
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
        // 3c88d593 — the legal entity, effective-dated at last (migration 0440).
        companyId: nextCompanyId,
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
        },
        after: {
          departmentId: nextDepartmentId,
          positionId: nextPositionId,
          businessUnitId: nextBusinessUnitId,
          costCenterId: nextCostCenterId,
          locationId: nextLocationId,
          employmentType: nextEmploymentType,
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
/** Serialize the existing person statutory owner before employment changes can hold row locks.
 * Employment identity is immutable; tenant RLS still scopes both reads. Absent profiles need no lock.
 * Core/org already owns this table edge; no country data is copied into employment history. */
export async function lockEmploymentStatutoryOwnerTx(tx:Tx,employmentId:string){
  const [identity]=await tx.select({personId:employment.personId}).from(employment).where(eq(employment.id,employmentId)).limit(1);
  if(identity)await tx.select({id:employeeStatutoryMy.id}).from(employeeStatutoryMy).where(eq(employeeStatutoryMy.personId,identity.personId)).limit(1).for('update');
}

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
    await lockEmploymentStatutoryOwnerTx(tx,p.employmentId);
    const [emp] = await tx
      .select({ companyId: employment.companyId, hiredOn: employment.hiredOn })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1)
      .for('no key update');
    if (!emp) throw new Error('Employment not found');
    // No-op guard: moving to the same company is not a change.
    if (emp.companyId === p.newCompanyId) throw new Error('The employee is already in this company.');
    // Destination must be a live (non-archived) company in this tenant.
    const [dest] = await tx
      .select({ id: company.id, country: company.country })
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
        // 3c88d593 — a CORRECTION, not a movement: the employee was never in the old company, so the
        // whole dated range is re-homed onto the destination rather than split at a date. Dating it at
        // `hiredOn` is what makes that true — the version it opens covers the employment from day one.
        companyId: p.newCompanyId,
        departmentId: p.departmentId,
        positionId: p.positionId ?? null,
        businessUnitId: p.businessUnitId ?? null,
        costCenterId: p.costCenterId ?? null,
        // r78c — this leg used to go out UNTAGGED, so its `employment.assignment.changed` projected an
        // Employment History row with no movement behind it. The label is unchanged (an untagged
        // assignment event already fell back to `orgAssignmentChange`), but the row now carries a
        // groupId, so any future leg added to this transaction collapses into it instead of opening a
        // second row. Company corrections are gated to employments with no transactions yet, so this is
        // the one screen that re-homes an assignment outside Movement, and it stays that way.
        movement: { type: 'orgAssignmentChange', groupId: randomUUID() },
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

    await packFor(dest.country)?.statutory.initializeTransferredTaxSelectionTx?.(tx, ctx, {
      employmentId: p.employmentId, fromCompanyId: emp.companyId, companyId: p.newCompanyId,
    });

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
 * b7b22514 — ENTITY TRANSFER: move an ESTABLISHED employee between legal entities, as one dated movement.
 *
 * THIS IS THE OTHER HALF OF THE SENTENCE changeEmploymentCompany ABOVE ENDS ON. That writer is the
 * pre-transaction CORRECTION of a mis-picked company: it is gated to employments with no operational
 * activity, it is not effective-dated (it rewrites the hire-time assignment in place), it deletes the open
 * reporting line, and its event is deliberately NOT a movement. None of that is right for an employee with
 * eight years of payroll behind them. This one is the movement: dated, projected onto Employment History,
 * reversible, and it supersedes the assignment rather than overwriting it.
 *
 * IT IS A LEG, NOT AN ENTRY POINT. It takes the caller's transaction and is called only by
 * applyComparisonMovementTx, which runs it FIRST so the company flip is visible to every later leg — after
 * it, setEmploymentAssignment's own company-scoped guards read the DESTINATION company for free. There is
 * no `withTenant` fallback on purpose: a company move that is not inside the movement's transaction could
 * commit while the placement legs roll back, leaving an employee in the new company still holding the old
 * company's department. That is the exact incoherence this function exists to prevent.
 *
 * WHY THE COHERENCE CHECK IS NOT setEmploymentAssignment'S. That writer validates only the values it sees
 * CHANGE — re-supplying a stored value is a no-op and skips the guard, which is right for every other
 * caller and wrong for this one. On a company move an UNCHANGED department is precisely the dangerous
 * case: it is the old company's, nobody edited it, and it would dangle across the entities silently.
 * changeEmploymentCompany hit this and validated its required department separately; this checks the whole
 * RESULTING placement — department, position, business unit, cost centre, location and the reporting
 * manager — against the destination whether or not the id moved. RLS cannot do it: it checks assignment,
 * location and reporting_line independently of the employment, so nothing at the row level knows these six
 * facts have to agree with a seventh.
 *
 * WHAT IS DELIBERATELY NOT CHECKED, and why each is not an omission:
 *   • JOB GRADE. `job_grade` is tenant-scoped — no company_id (see CrossCompanyError's note and the schema).
 *     A grade cannot dangle across companies because it never belonged to one. Re-resolving it would be
 *     re-resolving a reference that has no company in it to be wrong about.
 *   • THE GROUP JOIN DATE (`hired_on`). Untouched here and untouchable from here. It is the anchor for leave
 *     service bands, payroll proration and EA forms, and the whole point of the two-date model is that group
 *     service survives a move between group companies. Only `groupJoinDateCorrection` writes it.
 *   • PAYROLL. Nothing recomputes or reopens a closed run. A backdated transfer moves the employment from
 *     its effective date forward; a payroll run already closed over that window is evidence and stays.
 *
 * THE JOIN DATE IS NOT WRITTEN HERE. `employment.join_date` moves to the transfer's effective date, but it
 * moves through setEmploymentInfo like every other movement-owned date (core/movement.ts's info leg), so
 * that column keeps exactly one writer. This function must not acquire a second one.
 */
export async function transferEmploymentCompanyTx(
  tx: Tx,
  ctx: SessionContext,
  p: {
    employmentId: string;
    newCompanyId: string;
    effectiveDate: string;
    /**
     * The placement DELTAS only — `undefined` means the movement does not move this field, exactly as it
     * does everywhere else in this module. The carried-forward values are read from the open assignment and
     * reporting line BELOW rather than passed in, and that is the point: the caller cannot forget to hand
     * over a field it has no control on. Cost centre is the field that proves it — nothing on the movement
     * form can move it, so it is ALWAYS carried forward, and a carried-forward old-company cost centre is
     * precisely the dangling reference the changed-only guards elsewhere cannot see.
     */
    placement: {
      departmentId?: string | null;
      positionId?: string | null;
      businessUnitId?: string | null;
      locationId?: string | null;
      managerEmploymentId?: string | null;
    };
    /**
     * 3c88d593 — the employment-type delta, when the same movement moves one. It is NOT part of
     * `placement` because placement is the set of fields this writer CHECKS against the destination
     * company, and an employment type is company-blind. It is here because the entity leg now owns the
     * assignment version (see the setEmploymentAssignment call at the end): without it, a transfer that
     * also changed contract→permanent would have its type leg written by a SECOND version on the same
     * date, leaving a zero-length row behind. Absent ⇒ carried forward, exactly as before.
     */
    employmentType?: EmploymentTypeValue;
    movement: MovementTag;
  },
) {
  await lockEmploymentStatutoryOwnerTx(tx,p.employmentId);
  const [emp] = await tx
    .select({ companyId: employment.companyId })
    .from(employment)
    .where(eq(employment.id, p.employmentId))
    .limit(1)
    .for('no key update');
  if (!emp) throw new Error('Employment not found');
  if (emp.companyId === p.newCompanyId) throw new Error('The employee is already in this company.');

  // Destination must be a live (non-archived) company in this tenant.
  const [dest] = await tx
    .select({ id: company.id, country: company.country })
    .from(company)
    .where(and(eq(company.id, p.newCompanyId), isNull(company.archivedAt)))
    .limit(1);
  if (!dest) throw new CrossCompanyError('employment');

  // Authz, up front and explicit — exactly as changeEmploymentCompany does it. Flipping company_id trips
  // employment_rls WITH CHECK is_admin_for(NEW); asking first turns an opaque row-level failure into a
  // sentence that says what to do about it.
  const adminRes = await tx.execute(sql`select app.is_admin_for(${p.newCompanyId}::uuid) as ok`);
  if (!(adminRes as unknown as { ok: boolean }[])[0]?.ok) throw new DestinationCompanyNotAdministered();

  // ── Cross-company coherence, checked BEFORE the flip so a refusal leaves nothing half-done ──
  // The state the movement starts from: the OPEN assignment version and the OPEN administrative reporting
  // line — the same rows every other writer in this module treats as "current".
  const [curAsg] = await tx
    .select({
      departmentId: assignment.departmentId,
      positionId: assignment.positionId,
      businessUnitId: assignment.businessUnitId,
      costCenterId: assignment.costCenterId,
      locationId: assignment.locationId,
    })
    .from(assignment)
    .where(
      and(
        eq(assignment.employmentId, p.employmentId),
        isNull(assignment.validTo),
        isNull(assignment.supersededAt),
      ),
    )
    .limit(1);
  const [curRl] = await tx
    .select({ managerEmploymentId: reportingLine.managerEmploymentId })
    .from(reportingLine)
    .where(
      and(
        eq(reportingLine.subordinateEmploymentId, p.employmentId),
        eq(reportingLine.lineType, 'administrative'),
        isNull(reportingLine.validTo),
        isNull(reportingLine.supersededAt),
      ),
    )
    .limit(1);
  /** The value this field will hold AFTER the movement: the delta if it moved, the stored value if not. */
  const after = (d: string | null | undefined, stored: string | null): string | null =>
    d === undefined ? stored : d;
  const pl = {
    departmentId: after(p.placement.departmentId, curAsg?.departmentId ?? null),
    positionId: after(p.placement.positionId, curAsg?.positionId ?? null),
    businessUnitId: after(p.placement.businessUnitId, curAsg?.businessUnitId ?? null),
    // Never a delta — no movement surface can move it. Always the carried-forward value.
    costCenterId: curAsg?.costCenterId ?? null,
    locationId: after(p.placement.locationId, curAsg?.locationId ?? null),
    managerEmploymentId: after(p.placement.managerEmploymentId, curRl?.managerEmploymentId ?? null),
  };
  const guardLabel = async (
    kind: 'department' | 'position' | 'cost_center' | 'business_unit',
    labelId: string | null,
    entity: 'department' | 'position' | 'cost-center' | 'business-unit',
  ) => {
    if (!labelId) return;
    if (!(await labelUsableByCompany(tx, ctx.tenantId, kind, labelId, p.newCompanyId))) {
      throw new CrossCompanyError(entity);
    }
  };
  // Department is NOT NULL on the assignment, so an entity transfer always has one to check.
  await guardLabel('department', pl.departmentId, 'department');
  await guardLabel('position', pl.positionId, 'position');
  await guardLabel('business_unit', pl.businessUnitId, 'business-unit');
  await guardLabel('cost_center', pl.costCenterId, 'cost-center');
  // Location is company-owned master data, not a shared System Label, so it gets the direct same-company
  // check the assignment writers use rather than the resolver.
  if (pl.locationId) {
    const [loc] = await tx
      .select({ companyId: location.companyId })
      .from(location)
      .where(eq(location.id, pl.locationId))
      .limit(1);
    if (!loc || loc.companyId !== p.newCompanyId) throw new CrossCompanyError('location');
  }
  /**
   * THE REPORTING MANAGER IS PART OF THE PLACEMENT, and it is the one the reporter's request does not
   * mention and the one that breaks approvals. `leave_approval_policy` scopes by company and grade group,
   * so an employee left reporting into the old company after the move has approvers the destination's
   * policy cannot route to — a leave application with nowhere to go, discovered by the employee.
   *
   * REFUSED, not silently cleared. changeEmploymentCompany deletes the open line, which is right for a
   * hire-time correction nobody has seen yet and wrong here: dropping a superior as an invisible side
   * effect of a transfer is the same class of fault as r73's vanishing business unit. The Direct Superior
   * row is on the same form, so the fix is one field away. Clearing a superior outright stays the
   * Employment tab's job — deliberately, because movementDeltas treats a null manager as "unchanged" for
   * every kind and carving an exception here would make one kind's form mean something different.
   */
  if (pl.managerEmploymentId) {
    const [mgr] = await tx
      .select({ companyId: employment.companyId })
      .from(employment)
      .where(eq(employment.id, pl.managerEmploymentId))
      .limit(1);
    if (!mgr || mgr.companyId !== p.newCompanyId) {
      throw new CrossCompanyError('employment');
    }
  }

  /**
   * The flip, plus the company-scoped defaults that would otherwise dangle on the OLD company — the same
   * two changeEmploymentCompany refreshes, for the same reasons:
   *   • payrollPolicyId → null: a company-scoped pay template; the destination resolves its own at render.
   *   • costAllocation  → null: inter-company cost-split JSON pointing at the company they just left.
   * Statutory employer numbers (EPF / SOCSO / EIS) need nothing: they are registered to the COMPANY and
   * resolve per-company at payroll time, so they follow the move by construction.
   */
  await tx
    .update(employment)
    .set({ companyId: p.newCompanyId, payrollPolicyId: null, costAllocation: null })
    .where(eq(employment.id, p.employmentId));

  /**
   * Its own event type, NOT the `employment.company.changed` the pre-transaction correction appends.
   * Reusing that one would have been the cheap move and would have broken a guard: it is deliberately
   * absent from MOVEMENT_EVENT_TYPES so a hire-time correction never shows up as a career movement, and
   * adding it there to make Entity Transfer project would have dragged every past correction onto the
   * history with it. Two acts, two event types, and the projection can tell them apart.
   *
   * The payload carries BOTH company ids because the history is read years later: the row must be able to
   * say which entity the employee left and which they joined without depending on what `employment` holds
   * today (by then they may have moved twice more).
   */
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'employment',
    aggregateId: p.employmentId,
    eventType: 'employment.company.transferred',
    actor: actorOf(ctx),
    subjectEmploymentId: p.employmentId,
    payload: {
      employmentId: p.employmentId,
      effectiveDate: p.effectiveDate,
      before: { companyId: emp.companyId },
      after: { companyId: p.newCompanyId },
      movement: p.movement,
    },
  });

  /**
   * 3c88d593 — AND THE DATED HALF, which is the whole point of the item.
   *
   * Until now this writer moved the COLUMN and nothing else. `employment.company_id` holds one value, so
   * the moment it was overwritten the fact that the employee had been somewhere else on 8 August ceased
   * to exist anywhere a reader could reach — and payroll, which had nothing to look up, paid the whole of
   * August under the destination. Reproduced on production for employee 100814 before this was written.
   *
   * The entity now closes the outgoing assignment version at `effectiveDate` and opens a new one carrying
   * the destination company, through the SAME guarded delegate every other placement change uses. Three
   * things follow from routing it through setEmploymentAssignment rather than a fourth hand-rolled
   * CLOSE+INSERT here:
   *
   *   • the placement deltas travel WITH the entity, in one version. The movement form can move the
   *     department, position, business unit, location and employment type in the same act as the company,
   *     and one version carrying all of them is the truth — two versions dated the same day, one per leg,
   *     would leave a zero-length row and an Employment History that says the person changed twice.
   *     THIS IS WHY core/movement.ts SKIPS ITS OWN ASSIGNMENT LEG WHEN THE COMPANY MOVED: the leg is not
   *     lost, it is folded in here, with the deltas the caller already handed to `placement`.
   *   • the guards it already performs (label usable by the destination, live location, dated-range
   *     sanity) run on the version that is actually written, not on a copy of them.
   *   • the ROLLBACK is free. reverseLegTx already knows how to undo an `employment.assignment.changed`
   *     (supersede the new row, reopen the previous one), so an Entity Transfer that is rolled back now
   *     restores the entity history as well as the column, with no new reversal case to write.
   *
   * It runs AFTER the flip so the delegate's own cross-company guards resolve against the DESTINATION —
   * the same ordering, and the same reason, as the note on the flip above.
   */
  await setEmploymentAssignment(
    ctx,
    {
      employmentId: p.employmentId,
      effectiveDate: p.effectiveDate,
      companyId: p.newCompanyId,
      // `pl` is the RESOLVED placement — deltas where the form moved something, carried-forward stored
      // values where it did not — so re-supplying an unchanged value is a no-op to the delegate's
      // changed-only guards and can never blank a dimension this form does not show.
      departmentId: pl.departmentId ?? undefined,
      positionId: pl.positionId,
      businessUnitId: pl.businessUnitId,
      costCenterId: pl.costCenterId,
      locationId: pl.locationId,
      ...(p.employmentType ? { employmentType: p.employmentType } : {}),
      // SECONDARY, and this is not cosmetic. `p.movement` is the tag the caller minted for the company
      // leg, and it is the PRIMARY one — the movement's history row projects from it. Forwarding it
      // unchanged puts a second primary-tagged event in the same group and Employment History renders the
      // transfer TWICE (caught by movement-entity-transfer.test.ts, "records ONE row"). Same group, same
      // remarks, companion status: exactly what the hire's own reporting-line leg does (core/org.ts:338).
      movement: { ...p.movement, secondary: true },
    },
    tx,
  );

  await packFor(dest.country)?.statutory.initializeTransferredTaxSelectionTx?.(tx, ctx, {
    employmentId: p.employmentId, fromCompanyId: emp.companyId, companyId: p.newCompanyId,
  });

  return { from: emp.companyId, to: p.newCompanyId };
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
  /** Contract Employment Information (8590615a). Maintained together in the Employment tab's Contract
   *  Information block, which renders ONLY when the current open assignment's employment_type is
   *  'contract'. `contractEndDate` is the PRE-EXISTING 0110 review column — writing it from here is
   *  deliberate (one date, one home: the employment review keeps watching what HR maintains).
   *  undefined = untouched, ''/null = clear, exactly like every other field on this input. */
  contractStartDate?: string | null;
  contractEndDate?: string | null;
  contractRemark?: string | null;
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
  // 8590615a — the contract remark. In this list so it is normalised, written and carried into the
  // before/after audit diff like every other text column; deliberately ABSENT from
  // EMPLOYMENT_INFO_FIELD_CATEGORY below so it stays FREE TEXT and never reaches assertProfileValueAllowed.
  // ("Renewable upon performance review" is not a catalog value and never will be.)
  'contractRemark',
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
  // 8590615a — the contract period. contractEndDate is the pre-existing employment-review column (0110);
  // it is accepted here so the Employment tab's Contract Information block and the Others tab's Employment
  // Review row write the SAME date rather than two copies of it.
  'contractStartDate',
  'contractEndDate',
] as const;

/**
 * r285 (a3a3acd6) — THE CLOSED-PAYROLL GATE ON EMPLOYMENT INFORMATION.
 *
 * Until this item `setEmploymentInfo` had NO closed-period check of any kind, so a confirmation date or a
 * resignation date could be typed over inside a payroll month that was already closed, with nothing
 * stopping it. Compensation (core/comp.ts:344/379/472), recurring pay items (core/pay-components.ts:2003)
 * and Movement corrections (core/movement.ts:2965) all refuse that; employment information did not.
 *
 * ONE DEFINITION OF "PAYROLL EVIDENCE", NOT A FOURTH. The helpers are `closedPeriodsTx` +
 * `overlapsClosedPeriod` imported from core/comp.ts — the same pair every other gate above uses, for the
 * reason core/pay-components.ts:1977 spells out: a second definition of "closed" is how two rules that are
 * supposed to agree start disagreeing.
 *
 * ⚠️ SCOPED BY FIELD, NOT BY SAVE. A blanket "this employment has a closed month ⇒ nothing may be saved"
 * would block editing a contract remark because January is closed, which is a worse bug than the hole it
 * closes. A field is gated only when BOTH hold:
 *   (a) its value answers a question AS AT A DATE that a payroll-relevant computation asks, and
 *   (b) the change therefore has a datable window, so the refusal can name a span rather than be forever.
 *
 * Exactly two thresholds qualify, and they are the two the derived Employee Status is built from
 * (core/employment-status-sql.ts:47-53 — `onProbationSql` and `least(resignation, lastWorking, terminated)`):
 *
 *   1. THE PROBATION THRESHOLD — `finalConfirmationDate ?? confirmationDate`. `onProbationAsOf`
 *      (core/leave.ts:1079) reads it to decide who may take a `confirmed_only` leave type (:1141, :1369),
 *      and `onProbationSql` reads it for the Leave Adjustments / entitlement-template org criteria
 *      (core/org-criteria.ts:404). Moving it across a closed month retroactively changes who was eligible
 *      for leave that the closed run's absence lines already priced.
 *   2. THE LIFECYCLE-END THRESHOLD — `least(resignationDate, lastWorkingDate, terminatedOn)`. It is what
 *      flips the derived status to `resigned` (core/employment-status.ts:130), which narrows org-criteria
 *      populations (core/org-criteria.ts:395) and is the status the Payroll Register prints for a closed
 *      run (core/payroll-view.ts:1181).
 *
 * DELIBERATELY NOT GATED, with the evidence:
 *   • `contractRemark` — free text, no reader but the screen. The named counter-case.
 *   • the period/unit fields (probation*, *Notice*) — grep says their only readers are core/read.ts
 *     (display) and core/import-sections.ts / core/employee-draft.ts (import). No payroll, no leave.
 *   • `tenderResignationDate` — NOT one of the three dates `least(...)` takes; display only.
 *   • `contractStartDate` / `contractEndDate` — the employment-review renewal window, no payroll reader.
 *   • the eight flat org columns — they fail test (b): they are an UNDATED snapshot, so a change has no
 *     window and the only possible rule would be "refuse forever once any month closes", i.e. exactly the
 *     blanket failure this gate exists to avoid. Their authorised writer is the dated movement leg anyway.
 *
 * AND NOT ON A MOVEMENT-TAGGED SAVE. Every tagged call arrives from core/movement.ts, which owns its own
 * closed-payroll posture and has done since 66a63bd6: a CORRECTION of a state-changing event is refused
 * (:2965), a NEW dated event inside a processed period is flagged, not refused (:2174). Repeating the
 * refusal here would silently convert an allowed movement into a rejection — a behaviour change in a
 * module this item does not touch. The hole being closed is the UNTAGGED overwrite: a save with no
 * effective date, no reason and no event of its own saying why the past moved.
 *
 * There is deliberately no UI lock to pair with this (unlike the Movement row's `payrollLocked` badge):
 * whether a save is refused depends on the SPAN between the stored value and the one being typed, which
 * does not exist until submit. A static "locked" badge would be false for every in-month correction.
 */
const EMPLOYMENT_INFO_DATE_FLOOR = '0001-01-01';

/**
 * The span of days on which a THRESHOLD date's answer changes when it moves from `before` to `after`,
 * as a half-open [from, to) window `overlapsClosedPeriod` can consume (`to === null` = open-ended).
 * Returns null when the answer does not move at all.
 *
 * The two null semantics are not interchangeable and both are load-bearing:
 *   • 'floor'  — probation: `onProbation ⟺ asOf < confirmation`, and a NULL confirmation means "never on
 *     probation", i.e. a threshold at the beginning of time. So setting a confirmation date where there
 *     was none makes the employee retroactively on-probation for every day before it, and the window has
 *     to reach back far enough to catch a closed month sitting in that stretch.
 *   • 'open'   — lifecycle end: `ended ⟺ asOf >= date`, and a NULL end date means "has not ended", i.e. a
 *     threshold at the end of time. So setting or clearing one changes every day from that date ONWARD,
 *     and the window must be open-ended rather than bounded by the other (absent) value.
 */
function employmentThresholdWindow(
  before: string | null,
  after: string | null,
  nullMeans: 'floor' | 'open',
): { from: string; to: string | null } | null {
  if (before === after) return null;
  if (nullMeans === 'floor') {
    const a = before ?? EMPLOYMENT_INFO_DATE_FLOOR;
    const z = after ?? EMPLOYMENT_INFO_DATE_FLOOR;
    if (a === z) return null;
    return a < z ? { from: a, to: z } : { from: z, to: a };
  }
  if (before == null || after == null) return { from: (before ?? after) as string, to: null };
  return before < after ? { from: before, to: after } : { from: after, to: before };
}

/** The earliest of the given dates, ignoring nulls — the TypeScript twin of the SQL `least(...)` that
 *  core/employment-status-sql.ts:53 builds the lifecycle-end threshold from. */
function earliestEmploymentDate(...dates: (string | null | undefined)[]): string | null {
  const present = dates.filter((d): d is string => d != null);
  return present.length === 0 ? null : present.reduce((a, b) => (a < b ? a : b));
}

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
  //
  // b7b22514 — `entityTransfer` IS THE SECOND AUTHORISED TAG, and it is the case 89ea527b's comment above
  // describes without being able to perform: "an employee moves between companies inside the group". Until
  // now that move had to be recorded as two events — a Join Date Change typed by hand, and nothing at all for
  // the company, because no writer could change it. An Entity Transfer is the single dated event, and its
  // effective date IS the new Join Date, so the two can no longer be keyed in disagreement. The gate is
  // WIDENED, not weakened: the rule was never "only this one tag", it was "only under a movement, so every
  // move of this date carries an effective date, a reason and a history row" — which this satisfies exactly.
  // An untagged save posting joinDate is still silently ignored.
  if (
    p.joinDate !== undefined &&
    (p.movement?.type === 'joinDateChange' || p.movement?.type === 'entityTransfer')
  ) {
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
        // 8590615a — the contract group, in the before projection so the change-history diff carries all
        // three (the payload's `before`/`after` are built from exactly this select).
        contractStartDate: employment.contractStartDate,
        contractEndDate: employment.contractEndDate,
        contractRemark: employment.contractRemark,
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

    // 8590615a — the contract period, resolved against the RESULTING values like every check above.
    const contractStart =
      'contractStartDate' in set ? (set.contractStartDate as string | null) : before.contractStartDate;
    const contractEnd = 'contractEndDate' in set ? (set.contractEndDate as string | null) : before.contractEndDate;
    if (contractStart && hire && contractStart < hire) {
      throw new Error('Contract start date cannot be earlier than the hire date.');
    }
    if (contractStart && contractEnd && contractEnd <= contractStart) {
      throw new Error('Contract end date must be later than the contract start date.');
    }
    // Both dates are mandatory FOR A CONTRACT EMPLOYEE — but only when the submit actually carries the
    // contract block. Two reasons this is gated rather than unconditional:
    //   1. It must never retro-block a save that only touches probation or notice. Those submits do not
    //      carry the contract fields at all (an absent field is `undefined`, never enters `set`), so they
    //      skip this entirely — which also means we do not run the extra assignment query on every save.
    //   2. Only the CURRENT open assignment knows whether this employee is on contract. `employment` has
    //      no employment_type column — a query against employment.employment_type ERRORS — so the type is
    //      resolved through `assignment`, with the same shape core/employment-review.ts:liveTypeAndDates
    //      uses. Same tx, so it shares the RLS session and a violation aborts before the write.
    if ('contractStartDate' in set || 'contractEndDate' in set) {
      const [live] = await tx
        .select({ employmentType: assignment.employmentType })
        .from(assignment)
        .where(
          and(
            eq(assignment.employmentId, p.employmentId),
            isNull(assignment.validTo),
            isNull(assignment.supersededAt),
          ),
        )
        .limit(1);
      if (live?.employmentType === 'contract' && !(contractStart && contractEnd)) {
        throw new Error('Contract start date and contract end date are required for a contract employee.');
      }
    }

    // finalConfirmationDate is DERIVED, never accepted from the caller: = extendedConfirmation ?? confirmation.
    // Recompute from the resulting values on every save and persist only when it actually changes, so the
    // before/after diff stays meaningful and the column is always consistent with its inputs.
    const derivedFinal = (extendedConfirmation ?? confirmation) ?? null;
    if (derivedFinal !== (before.finalConfirmationDate ?? null)) {
      set.finalConfirmationDate = derivedFinal;
    }

    // r285 (a3a3acd6) — the closed-payroll gate. Scoped by FIELD, and only on an UNTAGGED save; the long
    // comment above EMPLOYMENT_INFO_DATE_FLOOR carries the whole reasoning and the per-field evidence.
    // Runs last, on the RESULTING values, so it asks the only question that matters: does the answer this
    // employment gives for some day inside a closed payroll month change because of this save?
    if (!p.movement) {
      const windows: { from: string; to: string | null }[] = [];

      // 1. The probation threshold, compared as the value its readers actually read
      //    (`finalConfirmationDate ?? confirmationDate`). Comparing the effective value rather than the raw
      //    column is what keeps a legacy row — final NULL, confirmation set — from tripping the gate on a
      //    save that only back-fills the derived column without moving anybody's probation status.
      if ('confirmationDate' in set || 'finalConfirmationDate' in set) {
        const w = employmentThresholdWindow(
          before.finalConfirmationDate ?? before.confirmationDate ?? null,
          derivedFinal ?? confirmation ?? null,
          'floor',
        );
        if (w) windows.push(w);
      }

      // 2. The lifecycle-end threshold. terminatedOn is read fresh rather than added to the `before`
      //    projection above, because that projection IS the audit event's before/after diff and this column
      //    has no business appearing in it. It is the third operand of the same `least(...)`, so leaving it
      //    out would refuse saves that cannot move the threshold at all (an already-terminated employment
      //    whose termination date precedes both dates being edited).
      if ('resignationDate' in set || 'lastWorkingDate' in set) {
        const [lifecycle] = await tx
          .select({ terminatedOn: employment.terminatedOn })
          .from(employment)
          .where(eq(employment.id, p.employmentId))
          .limit(1);
        const terminatedOn = lifecycle?.terminatedOn ?? null;
        const w = employmentThresholdWindow(
          earliestEmploymentDate(before.resignationDate, before.lastWorkingDate, terminatedOn),
          earliestEmploymentDate(resignation, lastWorking, terminatedOn),
          'open',
        );
        if (w) windows.push(w);
      }

      if (windows.length > 0) {
        const closed = await closedPeriodsTx(tx, p.employmentId);
        if (closed.length > 0 && windows.some((w) => overlapsClosedPeriod(closed, w.from, w.to))) {
          // Same sentence pattern, and the same reopen instruction, the Movement correction gives
          // (core/movement.ts:2967) — one rule the user meets in one shape. Only the two nouns move: there
          // is no movement and no event on this screen, and naming one would be a lie about what was saved.
          throw new Error(
            'A closed payroll run relied on this date. Reopen that payroll before correcting the employment information.',
          );
        }
      }
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
  const today = todayInKualaLumpur();
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
