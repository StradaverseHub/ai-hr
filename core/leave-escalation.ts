/**
 * R51 722904dc/71b9143a — leave approval ESCALATION sweep. Finds pending leave requests whose lowest
 * pending approval step has sat unanswered past the company's configured number of WORKING days
 * (company.escalation_enabled / escalate_after_days, migration 0287) and appends ONE
 * `leave-request.escalation-due` event per (group, step). The notification registry
 * (core/notifications.ts) projects that event into a bell notification for the configured target — the
 * next approver in the chain by default — re-checking at dispatch time that the step is genuinely still
 * pending, so an approver who acted in the meantime produces no alert.
 *
 * Runs inside scripts/review-sweep.ts (the existing nightly job — no second cron), shaped on
 * sweepReviewReminders (core/employment-review.ts).
 *
 * Idempotency: NO ledger table. The domain_event log is the "already chased" memory — before firing we
 * probe for an existing escalation-due event with the same (groupKey, stepIndex), the same pattern
 * closeReplacementLeaveYear (core/toil.ts) and the aged-forfeit sweep (core/leave.ts) already use.
 * groupKey = parentGroupId ?? requestId, which coalesces the ANNUAL + UNPAID pair an Emergency-Leave
 * submission decomposes into: one stuck approver ⇒ ONE alert, not two. Each step fires once EVER —
 * if the request advances and the NEXT step goes quiet, that new (group, step) gets its own single chase.
 *
 * Requests that resolve to a SINGLE-APPROVER chain generate no leave_approval_step rows
 * (generateApprovalSteps returns early), so they produce no candidates here — per the approved decision,
 * escalation is not offered for single-approver requests in this release (the sole approver is very often
 * the HR admin "escalation" would notify). r79 0322: that used to be a per-company opt-out
 * (company.leave_multi_approval); it is now the resolved chain being one level long, so the same company
 * can escalate on one leave type and not on another. Nothing here changed — this reads leave_approval_step
 * rows and knows nothing about how they came to exist. The settings themselves (company.escalation_*) are
 * untouched by r79; only the SCREEN they are edited on moved.
 *
 * Delegation is deliberately NOT special-cased: escalation triggers on nobody having decided. If a
 * stand-in decides the step in time, the step is no longer pending and nothing fires.
 */
import { and, eq, gt, isNotNull, lt, asc } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  company,
  domainEvent,
  employment,
  leaveApprovalStep,
  leaveRequest,
  leaveRequestDate,
  leaveType,
} from '../db/schema';
import { resolveWorkingDaysIso, todayInKualaLumpur, workingDays } from './leave';
import { holidayDatesFor } from './holidays';

/** The ONE place to change when a per-company timezone lands. leave_request.created_at and
 *  leave_approval_step.decided_at are timestamptz while all day-counting is ISO-date maths; at UTC+8 a
 *  timestamp before 08:00 local falls on the PREVIOUS UTC date, so every timestamptz → calendar-date
 *  conversion here goes through this zone (there is no timezone column on tenant or company today). */
export const HR_LOCAL_TZ = 'Asia/Kuala_Lumpur';

/** A timestamptz as an ISO yyyy-mm-dd calendar date in HR_LOCAL_TZ (en-CA yields yyyy-mm-dd). */
function localDate(ts: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: HR_LOCAL_TZ }).format(ts);
}

/** Pure ISO date + days (UTC string maths — no TZ drift, mirrors employment-review's subtractDays). */
function addDaysIso(isoDate: string, days: number): string {
  const t = Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)));
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

export type EscalationSweepResult = {
  escalated: number;
  /** Companies skipped because their resolved working-day roster is empty (escalation could never fire —
   *  elapsed working days is permanently zero). Counted, never fatal. */
  skippedEmptyRosterCompanies: number;
};

/**
 * One nightly pass. `today` is injectable for tests and defaults to the KL local date (the cron runs
 * 03:00 MYT, which is still "yesterday" in UTC — a UTC slice would count a day short).
 *
 * The waiting clock for a step starts at the LATEST of:
 *   - the previous step's decision (else the request's submission) — the moment the request actually
 *     landed on THIS approver's desk;
 *   - the newest per-date decision on the request (ADR-0068): an approver who has decided some of the
 *     requested dates is demonstrably working the request and must not be chased.
 * Requests whose clock started before company.escalation_updated_at are grandfathered (no day-one burst
 * when HR first flips the switch, or later shortens the threshold).
 */
export async function sweepLeaveApprovalEscalations(
  ctx: SessionContext,
  opts: { today?: string } = {},
): Promise<EscalationSweepResult> {
  const today = opts.today ?? todayInKualaLumpur();
  return withTenant(ctx, async (tx) => {
    // Pending requests in escalation-enabled companies, each joined to its LOWEST pending step.
    const candidates = await tx
      .select({
        requestId: leaveRequest.id,
        employmentId: leaveRequest.employmentId,
        parentGroupId: leaveRequest.parentGroupId,
        createdAt: leaveRequest.createdAt,
        startDate: leaveRequest.startDate,
        endDate: leaveRequest.endDate,
        leaveTypeName: leaveType.name,
        companyId: company.id,
        escalateAfterDays: company.escalateAfterDays,
        escalationTarget: company.escalationTarget,
        escalationTargetRole: company.escalationTargetRole,
        escalationUpdatedAt: company.escalationUpdatedAt,
        stepIndex: leaveApprovalStep.stepIndex,
        stepKind: leaveApprovalStep.approverKind,
      })
      .from(leaveRequest)
      .innerJoin(employment, eq(employment.id, leaveRequest.employmentId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
      .innerJoin(
        leaveApprovalStep,
        and(
          eq(leaveApprovalStep.leaveRequestId, leaveRequest.id),
          eq(leaveApprovalStep.status, 'pending'),
          sql`${leaveApprovalStep.stepIndex} = (select min(s2.step_index) from leave_approval_step s2 where s2.leave_request_id = ${leaveRequest.id} and s2.status = 'pending')`,
        ),
      )
      .where(
        and(
          eq(leaveRequest.status, 'pending'),
          eq(company.escalationEnabled, true),
          isNotNull(company.escalateAfterDays),
        ),
      )
      .orderBy(asc(leaveRequest.createdAt));

    // Working-day roster is company-scoped (attendance_policy is one row per company) — resolve once per
    // company for the pass, not per request. Holidays stay per REQUESTER employment (holidayDatesFor is
    // employment-scoped and state holidays are real): the requester's calendar is already the one the
    // leave itself is measured against, so a requester and an approver in different states may see
    // slightly different holiday calendars — accepted, not a second calendar rule.
    const rosterByCompany = new Map<string, number[]>();
    const emptyRosterCompanies = new Set<string>();
    const firedThisRun = new Set<string>();
    let escalated = 0;

    for (const r of candidates) {
      if (r.escalateAfterDays == null) continue;
      if (emptyRosterCompanies.has(r.companyId)) continue;
      let roster = rosterByCompany.get(r.companyId);
      if (!roster) {
        roster = await resolveWorkingDaysIso(tx, r.employmentId);
        rosterByCompany.set(r.companyId, roster);
      }
      if (roster.length === 0) {
        // An attendance_policy row with NO working days: elapsed working days is permanently zero, so
        // escalation can never fire — skip the company, count it, log it, never fail the sweep.
        emptyRosterCompanies.add(r.companyId);
        console.warn(`leave-escalation: company ${r.companyId} has an empty working-day roster — skipped`);
        continue;
      }

      // Clock start = latest of (previous step decision | submission) and the newest per-date decision.
      // Raw sql`max(...)` aggregates are NOT column-mapped by drizzle — they come back as strings.
      const [prevStep] = await tx
        .select({ decidedAt: sql<Date | string | null>`max(${leaveApprovalStep.decidedAt})` })
        .from(leaveApprovalStep)
        .where(and(eq(leaveApprovalStep.leaveRequestId, r.requestId), lt(leaveApprovalStep.stepIndex, r.stepIndex)));
      const [perDate] = await tx
        .select({ decidedAt: sql<Date | string | null>`max(${leaveRequestDate.decidedAt})` })
        .from(leaveRequestDate)
        .where(eq(leaveRequestDate.leaveRequestId, r.requestId));
      let clockStart = r.createdAt;
      for (const t of [prevStep?.decidedAt, perDate?.decidedAt]) {
        if (t == null) continue;
        const d = t instanceof Date ? t : new Date(t);
        if (d.getTime() > clockStart.getTime()) clockStart = d;
      }

      // Grandfathering (approved decision 6): only requests that START waiting after the settings were
      // saved are chased — flipping the switch on must not alert for every already-old request at once.
      if (r.escalationUpdatedAt != null && clockStart.getTime() < r.escalationUpdatedAt.getTime()) continue;

      // Elapsed FULL working days the approver has sat on it: working days in (clockStart, today], both
      // as HR_LOCAL_TZ calendar dates. A request created at 01:00 local (17:00 UTC the previous day)
      // counts from the LOCAL date.
      const clockDate = localDate(clockStart);
      if (clockDate >= today) continue;
      const holidays = await holidayDatesFor(tx, {
        employmentId: r.employmentId,
        startDate: clockDate,
        endDate: today,
      });
      const elapsed = workingDays(addDaysIso(clockDate, 1), today, holidays, roster);
      if (elapsed < r.escalateAfterDays) continue;

      // Once per (group, step) EVER — the domain_event log is the dedup ledger. groupKey coalesces the
      // Emergency-Leave sibling pair into one alert.
      const groupKey = r.parentGroupId ?? r.requestId;
      const runKey = `${groupKey}:${r.stepIndex}`;
      if (firedThisRun.has(runKey)) continue;
      const [already] = await tx
        .select({ id: domainEvent.id })
        .from(domainEvent)
        .where(
          and(
            eq(domainEvent.tenantId, ctx.tenantId),
            eq(domainEvent.eventType, 'leave-request.escalation-due'),
            sql`${domainEvent.payload} ->> 'groupKey' = ${groupKey}`,
            sql`(${domainEvent.payload} ->> 'stepIndex')::int = ${r.stepIndex}`,
          ),
        )
        .limit(1);
      if (already) continue;

      // WHO to notify is snapshotted here (targetKind); WHETHER to notify is re-decided fresh at
      // dispatch time by the registry resolver (the step may have been decided since).
      const [next] = await tx
        .select({
          kind: leaveApprovalStep.approverKind,
          // r293 phase 3 — snapshotted WITH the kind, for the same reason the kind is snapshotted: a
          // fixed next level routes to a person, and the chase must reach whoever the REQUEST was
          // routed to, not whoever the template names by the time the notification is dispatched.
          employmentId: leaveApprovalStep.approverEmploymentId,
        })
        .from(leaveApprovalStep)
        .where(and(eq(leaveApprovalStep.leaveRequestId, r.requestId), gt(leaveApprovalStep.stepIndex, r.stepIndex)))
        .orderBy(asc(leaveApprovalStep.stepIndex))
        .limit(1);
      const nextKind = next?.kind ?? null;
      const targetKind =
        r.escalationTarget === 'specific_role' ? (r.escalationTargetRole ?? null) : nextKind;
      // Only a NEXT-LEVEL target can carry a person; a configured role never does.
      const targetEmploymentId = r.escalationTarget === 'specific_role' ? null : (next?.employmentId ?? null);

      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'leave-request',
        aggregateId: r.requestId,
        eventType: 'leave-request.escalation-due',
        actor: actorOf(ctx),
        subjectEmploymentId: r.employmentId,
        payload: {
          groupKey,
          leaveRequestId: r.requestId,
          stepIndex: r.stepIndex,
          currentKind: r.stepKind,
          nextKind, // null ⇒ the stuck step is the LAST one; the resolver falls back to HR admins
          targetKind,
          targetEmploymentId,
          daysWaiting: elapsed,
          leaveTypeName: r.leaveTypeName,
          startDate: r.startDate,
          endDate: r.endDate,
        },
      });
      firedThisRun.add(runKey);
      escalated += 1;
    }

    // One summary event per run that did work (the sweep convention — zero-work runs append nothing).
    if (escalated > 0) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'leave-escalation-sweep',
        aggregateId: ctx.tenantId, // tenant-level virtual aggregate (mirrors the reminder sweep)
        eventType: 'leave-approval.escalations.swept',
        actor: actorOf(ctx),
        payload: {
          today,
          escalated,
          ...(emptyRosterCompanies.size
            ? { emptyRosterCompanies: [...emptyRosterCompanies] }
            : {}),
        },
      });
    }
    return { escalated, skippedEmptyRosterCompanies: emptyRosterCompanies.size };
  });
}
