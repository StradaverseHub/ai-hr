/**
 * 296fc027 · THE EMPLOYEE REPLACEMENT-LEAVE REQUEST — submit, decide, and grant on approval.
 *
 * WHAT THIS ADDS THAT DID NOT EXIST. Until now a replacement-leave credit could only be created by a
 * MANAGER: elected off the roster (`accrueToil`), or banked automatically when a rest-day attendance
 * correction was approved (`maybeAutoAccrueOnApprovalTx`). An employee could not ask for one at all. This
 * module is the employee's path in: they declare the dates they worked, a line manager approves, and the
 * credit is minted at that moment with its expiry counted from THE APPROVAL.
 *
 * FOUR CONTROLS, AND WHERE EACH ONE LIVES — because the whole risk of a self-service button is that it
 * becomes a way around a control the manager route enforces.
 *
 *  1. THE MODULE. Replacement leave is a chargeable add-on. `assertModuleEnabled` refuses a submission
 *     without it, so the page stays visible and read-only and no new credits are granted.
 *
 *  2. THE EMPLOYEE-REQUEST SWITCH. Off by default. Checked HERE, in the service, not only in the UI —
 *     hiding the button is a courtesy, refusing the POST is the control, and a server action is one
 *     `curl` away from the hidden button being irrelevant.
 *
 *  3. ELIGIBILITY. Resolved through core/replacement-eligibility.ts AS OF the submission date, so an
 *     employee who transferred out of a qualifying department last week is judged on the assignment they
 *     actually held. Checked at submit AND re-checked at approval against the SAME date — never against
 *     the org chart as it stands on approval day, which would let a transfer invalidate a request the
 *     employee already made correctly.
 *
 *  4. THE FIRST SCHEDULE GATE, which is a LEGAL one and the reason this file is careful. An employee at
 *     or below the statutory overtime protection threshold is entitled to overtime CASH, not banked time.
 *     They may bank it only where the company has switched the override on AND their own agreement is
 *     recorded. It is checked at SUBMIT so the employee is told immediately rather than after a manager's
 *     approval, and — this is the part that matters — it is checked AGAIN at approval, inside
 *     `bankToilCreditTx`, which is shared verbatim with the manager route. The submit-time check is a
 *     courtesy; the accrual-time one is the guarantee, and it cannot be bypassed by any caller because it
 *     sits below the fork where both paths meet.
 *
 * NOT MODELLED AS A `leave_request`. See migration 0381's header: `leave_request` means TIME TAKEN in the
 * balance check, the calendar and payroll's unpaid days, and this is a claim for time already worked.
 *
 * APPROVAL IS `assertCanDecide`, NOT THE MULTI-LEVEL TEMPLATE CHAIN. The approved plan states the
 * reporter asked for line-manager approval only, and `assertCanDecide` (core/approvals.ts) is exactly
 * that — admin-or-active-administrative-manager with a self-grant ban — already shared between leave and
 * attendance corrections. `core/leave-approval-template.ts`'s workflow chain is deliberately not used;
 * if that is ever wanted it is a different ticket with a different answer for what a partial approval of
 * a multi-date request would even mean.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { assertCanDecide } from './approvals';
import {
  company,
  compensation,
  employment,
  person,
  replacementLeaveRequest,
  replacementLeaveRequestDate,
  toilAccrual,
  toilPolicy,
  type ReplacementLeaveRequestStatus,
  type ReplacementLeaveRequestUnit,
} from '../db/schema';
import { packFor } from '../localization/registry';
import { assertModuleEnabled, isModuleEnabled } from './entitlements';
import { isReplacementRequestEligibleTx } from './replacement-eligibility';
import { accrueSelfDeclaredToilTx, ToilAlreadyAccruedError } from './toil';

const STD_DAY_MINUTES = 480; // 8h — the same standard-day convention core/toil.ts and payroll use
const round2 = (n: number) => Math.round(n * 100) / 100;

export class ReplacementRequestDisabledError extends Error {
  constructor(msg = 'Employee-submitted replacement leave requests are not switched on for this company.') {
    super(msg);
    this.name = 'ReplacementRequestDisabledError';
  }
}
export class ReplacementRequestNotEligibleError extends Error {
  constructor(msg = 'You are not eligible to submit a replacement leave request.') {
    super(msg);
    this.name = 'ReplacementRequestNotEligibleError';
  }
}
export class ReplacementRequestInvalidError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ReplacementRequestInvalidError';
  }
}
export class ReplacementRequestNotPendingError extends Error {
  constructor(msg = 'That replacement leave request has already been decided.') {
    super(msg);
    this.name = 'ReplacementRequestNotPendingError';
  }
}

/** One worked-date row as the employee typed it. `days` for a Day request; `fromTime`/`toTime` for Hour. */
export type ReplacementRequestLineInput = {
  workedDate: string;
  days?: number;
  fromTime?: string;
  toTime?: string;
};

/**
 * Minutes between two HH:MM(:SS) times on the same day. Refuses a non-positive span rather than silently
 * producing zero hours — an employee who typed 17:00 to 08:00 made a mistake and should be told, not given
 * a credit of nothing.
 */
export function minutesBetween(fromTime: string, toTime: string): number {
  const parse = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
    return h * 60 + m;
  };
  const a = parse(fromTime);
  const b = parse(toTime);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new ReplacementRequestInvalidError('Enter a valid from and to time.');
  const mins = b - a;
  if (mins <= 0) throw new ReplacementRequestInvalidError('The "to" time must be later than the "from" time.');
  return mins;
}

/**
 * The totals shown at the bottom of the worked-date table. Pure, and exported so the same arithmetic backs
 * the form preview, the stored totals and the tests — three places that would otherwise drift.
 *
 * The DAYS figure is what actually gets banked. For an Hour request it is the claimed hours over the
 * standard 8-hour day, which is the same conversion `accrueToilTx` applies to measured overtime minutes.
 */
export function totalsFor(
  unit: ReplacementLeaveRequestUnit,
  lines: ReplacementRequestLineInput[],
): { totalDays: number; totalHours: number; perLine: { workedDate: string; days: number; minutes: number }[] } {
  const perLine = lines.map((l) => {
    if (unit === 'hour') {
      const minutes = minutesBetween(l.fromTime ?? '', l.toTime ?? '');
      return { workedDate: l.workedDate, days: round2(minutes / STD_DAY_MINUTES), minutes };
    }
    const days = Number(l.days ?? 0);
    if (!Number.isFinite(days) || days <= 0)
      throw new ReplacementRequestInvalidError('Enter a number of days greater than zero for every worked date.');
    return { workedDate: l.workedDate, days: round2(days), minutes: Math.round(days * STD_DAY_MINUTES) };
  });
  const totalDays = round2(perLine.reduce((s, l) => s + l.days, 0));
  const totalHours = round2(perLine.reduce((s, l) => s + l.minutes, 0) / 60);
  return { totalDays, totalHours, perLine };
}

/**
 * What the employee's My Leave surface needs to decide whether to render the request button at all.
 *
 * Returns `allowed: false` with a REASON rather than a bare boolean, because the three reasons are
 * genuinely different things to tell someone: the add-on is not bought, the company has not switched
 * employee requests on, or this particular employee is outside the criteria. The page currently only
 * needs the boolean, but a caller that wanted to explain the absence has the answer without a second read.
 *
 * THIS IS NOT THE ENFORCEMENT. `submitReplacementLeaveRequest` re-derives all three server-side; this
 * exists so the UI does not offer a button that would be refused.
 */
export type ReplacementRequestAvailability = {
  allowed: boolean;
  reason?: 'module_off' | 'not_enabled' | 'not_eligible' | 'no_employment';
  /**
   * The employee is within the First Schedule AND their company allows banking, so the form must ASK for
   * their agreement. False when they are above the wage ceiling (no statutory floor to protect) — and note
   * that a First-Schedule employee whose company has NOT switched the override on comes back
   * `allowed: false`, never `allowed: true` with a checkbox that could not help them.
   */
  requiresFirstScheduleConsent?: boolean;
};

export async function replacementRequestAvailability(
  ctx: SessionContext,
  employmentId: string,
  asOf: string,
): Promise<ReplacementRequestAvailability> {
  if (!isModuleEnabled(ctx, 'toil')) return { allowed: false, reason: 'module_off' };
  return withTenant(ctx, async (tx) => {
    const resolved = await resolvePolicyForTx(tx, employmentId);
    if (!resolved) return { allowed: false, reason: 'no_employment' as const };
    const { policy } = resolved;
    if (!policy || !policy.enabled || !policy.employeeRequestEnabled) return { allowed: false, reason: 'not_enabled' as const };
    const eligible = await isReplacementRequestEligibleTx(tx, {
      employmentId,
      asOf,
      eligibility: policy.requestEligibility,
    });
    if (!eligible) return { allowed: false, reason: 'not_eligible' as const };
    // The statutory floor decides whether the form shows a consent box — and, when the company has not
    // switched the override on, whether the button appears at all. Asking here rather than letting the
    // employee fill in a form that submit would refuse.
    const firstSchedule = await isFirstScheduleTx(tx, { employmentId, country: resolved.country, asOf });
    if (firstSchedule && !policy.allowFirstScheduleEligible) return { allowed: false, reason: 'not_eligible' as const };
    return { allowed: true, requiresFirstScheduleConsent: firstSchedule };
  });
}

/**
 * Is this employee within the First Schedule (s.2 wages at or below the pack's overtime wage ceiling)?
 *
 * The same comparison `bankToilCreditTx` makes at accrual time. Shared by the availability read and the
 * submit-time gate so the button, the consent checkbox and the refusal cannot disagree about who is
 * protected — the ACCRUAL-time check remains the binding one.
 */
async function isFirstScheduleTx(
  tx: Tx,
  p: { employmentId: string; country: string | null; asOf: string },
): Promise<boolean> {
  const [comp] = await tx
    .select({ basic: compensation.basicSalary, allowance: compensation.monthlyAllowance })
    .from(compensation)
    .where(and(eq(compensation.employmentId, p.employmentId), isNull(compensation.validTo), isNull(compensation.supersededAt)))
    .limit(1);
  const wages = comp ? round2(Number(comp.basic) + Number(comp.allowance ?? 0)) : null;
  const pack = packFor(p.country);
  const ceiling = pack ? (await pack.payroll.loadRuleset(tx, { asOf: p.asOf })).ot.wageCeiling : 4000;
  return wages != null && wages <= ceiling;
}

/** The employee's company policy, or null when the employment cannot be resolved. */
async function resolvePolicyForTx(tx: Tx, employmentId: string) {
  const [emp] = await tx
    .select({ companyId: employment.companyId, country: company.country })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!emp) return null;
  const [policy] = await tx.select().from(toilPolicy).where(eq(toilPolicy.companyId, emp.companyId)).limit(1);
  return { companyId: emp.companyId, country: emp.country, policy: policy ?? null };
}

export type SubmitReplacementRequestResult = { requestId: string; totalDays: number; totalHours: number };

/**
 * Submit a replacement-leave request. Writes the header + one line per worked date. GRANTS NOTHING — the
 * credit is minted only when a line manager approves (`decideReplacementLeaveRequest`), which is what
 * makes the approval date the honest anchor for the expiry period.
 */
export async function submitReplacementLeaveRequest(
  ctx: SessionContext,
  p: {
    employmentId: string;
    leaveTypeId?: string | null;
    unit: ReplacementLeaveRequestUnit;
    lines: ReplacementRequestLineInput[];
    reason?: string;
    /** The employee's recorded agreement to bank time instead of the statutory overtime cash. */
    firstScheduleConsent?: boolean;
    /** Injected for deterministic tests; the submission date and the eligibility as-of date. */
    today: string;
  },
): Promise<SubmitReplacementRequestResult> {
  // Control 1 — the chargeable add-on. No module, no new credits, and no request that would mint one.
  assertModuleEnabled(ctx, 'toil');

  if (p.lines.length === 0) throw new ReplacementRequestInvalidError('Add at least one worked date.');
  const seen = new Set<string>();
  for (const l of p.lines) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l.workedDate)) throw new ReplacementRequestInvalidError('Enter a valid worked date.');
    if (l.workedDate > p.today)
      throw new ReplacementRequestInvalidError('You cannot claim replacement leave for a date in the future.');
    if (seen.has(l.workedDate))
      throw new ReplacementRequestInvalidError('The same worked date appears more than once.');
    seen.add(l.workedDate);
  }
  // Throws on a bad row (zero days, reversed times) before anything is written.
  const { totalDays, totalHours, perLine } = totalsFor(p.unit, p.lines);
  if (totalDays <= 0) throw new ReplacementRequestInvalidError('The total must be greater than zero.');

  return withTenant(ctx, async (tx) => {
    const resolved = await resolvePolicyForTx(tx, p.employmentId);
    if (!resolved) throw new ReplacementRequestInvalidError('No employment on record for this request.');
    const { policy } = resolved;
    if (!policy || !policy.enabled) throw new ReplacementRequestDisabledError('Replacement leave is not enabled for this company.');

    // Control 2 — the employee-request switch, enforced SERVER-SIDE. The hidden button is not the control.
    if (!policy.employeeRequestEnabled) throw new ReplacementRequestDisabledError();

    // Control 3 — eligibility, as of the SUBMISSION date.
    const eligible = await isReplacementRequestEligibleTx(tx, {
      employmentId: p.employmentId,
      asOf: p.today,
      eligibility: policy.requestEligibility,
    });
    if (!eligible) throw new ReplacementRequestNotEligibleError();

    // Control 4 (submit-time half) — the First Schedule gate, so the employee finds out NOW rather than
    // after a manager has approved something that cannot legally be granted. The binding half runs inside
    // bankToilCreditTx at approval; this one only saves a wasted round trip.
    await assertFirstScheduleSubmissionAllowedTx(tx, {
      employmentId: p.employmentId,
      country: resolved.country,
      asOf: p.today,
      allowFirstScheduleEligible: policy.allowFirstScheduleEligible,
      consent: p.firstScheduleConsent === true,
    });

    // The double-bank guard, applied EARLY as a courtesy. `toil_accrual`'s unique index is the real one and
    // it is re-checked at approval — a manager could bank one of these dates off the roster in between —
    // but refusing at submit is a much better experience than an approval that half-fails.
    const dates = perLine.map((l) => l.workedDate);
    const already = await tx
      .select({ workedDate: toilAccrual.workedDate })
      .from(toilAccrual)
      .where(and(eq(toilAccrual.employmentId, p.employmentId), inArray(toilAccrual.workedDate, dates)));
    if (already.length > 0) {
      throw new ToilAlreadyAccruedError(
        `Replacement leave has already been banked for ${already.map((a) => a.workedDate).join(', ')}.`,
      );
    }

    const [header] = await tx
      .insert(replacementLeaveRequest)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        leaveTypeId: p.leaveTypeId ?? null,
        unit: p.unit,
        totalDays: totalDays.toFixed(2),
        totalHours: totalHours.toFixed(2),
        reason: p.reason?.trim() || null,
        submittedOn: p.today,
        status: 'pending',
        firstScheduleConsent: p.firstScheduleConsent === true ? true : null,
      })
      .returning({ id: replacementLeaveRequest.id });

    await tx.insert(replacementLeaveRequestDate).values(
      p.lines.map((l, i) => ({
        tenantId: ctx.tenantId,
        requestId: header.id,
        subjectEmploymentId: p.employmentId,
        workedDate: l.workedDate,
        days: perLine[i].days.toFixed(2),
        fromTime: p.unit === 'hour' ? (l.fromTime ?? null) : null,
        toTime: p.unit === 'hour' ? (l.toTime ?? null) : null,
        hours: p.unit === 'hour' ? round2(perLine[i].minutes / 60).toFixed(2) : null,
      })),
    );

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'replacement-leave-request',
      aggregateId: header.id,
      eventType: 'replacement-leave-request.submitted',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { unit: p.unit, totalDays, totalHours, dates, submittedOn: p.today },
    });

    return { requestId: header.id, totalDays, totalHours };
  });
}

/**
 * The submit-time First Schedule check.
 *
 * Deliberately a SEPARATE function from the one inside `bankToilCreditTx` rather than a shared helper, and
 * that is worth being explicit about: the accrual-time gate reads the policy row it is already holding and
 * throws the canonical `ToilNotEligibleError` / `ToilFirstScheduleConsentRequiredError`. Sharing one
 * implementation would mean the submit path pulling the whole accrual context in just to reuse two
 * comparisons. What must not diverge is the RULE, and the rule is asserted in both places by the same
 * test — a First-Schedule employee refused without the override plus recorded consent, at submit AND at
 * approval.
 */
async function assertFirstScheduleSubmissionAllowedTx(
  tx: Tx,
  p: { employmentId: string; country: string | null; asOf: string; allowFirstScheduleEligible: boolean; consent: boolean },
): Promise<void> {
  const eligible = await isFirstScheduleTx(tx, p);
  if (!eligible) return; // above the ceiling: overtime comp is contractual, no statutory floor to protect
  if (!p.allowFirstScheduleEligible) {
    throw new ReplacementRequestNotEligibleError(
      'Statutory overtime pay applies to you (within the First Schedule), so replacement leave is not permitted under your company’s current policy.',
    );
  }
  if (!p.consent) {
    throw new ReplacementRequestNotEligibleError(
      'Statutory overtime pay applies to you (within the First Schedule). Banking time in lieu instead of the statutory cash premium requires your explicit agreement — confirm it to proceed.',
    );
  }
}

export type DecideReplacementRequestResult = {
  status: ReplacementLeaveRequestStatus;
  /** Credits minted (0 on a rejection). */
  granted: number;
  daysCredited: number;
  /** The expiry frozen onto every credit this approval minted — counted from the APPROVAL date. */
  expiresOn?: string;
};

/**
 * Decide a replacement-leave request. On approval, mints ONE credit per worked-date line in the SAME
 * transaction, with the expiry counted from THIS DECISION.
 *
 * `decidedAt` is injected (defaulting to now) for the same reason every other date in this engine is: so
 * the suite can assert an expiry rather than recompute one, and so "the approval instant" is a single
 * value shared by the header, every credit, and the event — rather than three `new Date()` calls that
 * disagree by milliseconds across a midnight boundary.
 */
export async function decideReplacementLeaveRequest(
  ctx: SessionContext,
  p: { requestId: string; decision: 'approved' | 'rejected'; note?: string; decidedAt?: Date },
): Promise<DecideReplacementRequestResult> {
  // The module gate applies to APPROVAL too, because approval is what mints the credit. Rejection is left
  // reachable on purpose — refusing to let an admin clear a pending queue after the module lapses would
  // strand the request, and a rejection grants nothing.
  return withTenant(ctx, async (tx) => {
    const [req] = await tx
      .select()
      .from(replacementLeaveRequest)
      .where(eq(replacementLeaveRequest.id, p.requestId))
      .limit(1);
    if (!req) throw new ReplacementRequestInvalidError('Replacement leave request not found.');
    if (req.status !== 'pending') throw new ReplacementRequestNotPendingError();

    // Line-manager-or-admin, with the self-grant ban. The plan is explicit that this is the whole approval
    // model — NOT core/leave-approval-template.ts's multi-level chain.
    await assertCanDecide(tx, ctx, req.employmentId, 'replacement leave request');

    const decidedAt = p.decidedAt ?? new Date();

    if (p.decision === 'rejected') {
      await tx
        .update(replacementLeaveRequest)
        .set({ status: 'rejected', decidedAt, decidedByUserId: ctx.userId ?? null, decisionNote: p.note?.trim() || null })
        .where(eq(replacementLeaveRequest.id, p.requestId));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'replacement-leave-request',
        aggregateId: p.requestId,
        eventType: 'replacement-leave-request.rejected',
        actor: actorOf(ctx),
        subjectEmploymentId: req.employmentId,
        payload: { note: p.note ?? null },
      });
      return { status: 'rejected' as const, granted: 0, daysCredited: 0 };
    }

    // Approving MINTS credits, so the add-on must be live for this half.
    assertModuleEnabled(ctx, 'toil');

    const lines = await tx
      .select()
      .from(replacementLeaveRequestDate)
      .where(eq(replacementLeaveRequestDate.requestId, p.requestId))
      .orderBy(replacementLeaveRequestDate.workedDate);

    let granted = 0;
    let daysCredited = 0;
    let expiresOn: string | undefined;
    for (const line of lines) {
      const days = Number(line.days ?? 0);
      const minutes = line.hours != null ? Math.round(Number(line.hours) * 60) : Math.round(days * STD_DAY_MINUTES);
      // The shared executor: skips the attendance lookup and the rest-day/holiday restriction, KEEPS the
      // double-bank guard, the First Schedule gate, the ledger credit and the register row. A refusal here
      // (a date banked in the meantime, a First-Schedule employee whose company override was switched off
      // between submission and approval) rolls the WHOLE approval back — a request is approved as a unit,
      // and a half-granted one would leave the employee unable to tell what they had been given.
      const res = await accrueSelfDeclaredToilTx(tx, ctx, {
        employmentId: req.employmentId,
        workedDate: line.workedDate,
        declaredDays: days,
        declaredMinutes: minutes,
        // THE ANCHOR. Not the submission date, not the date worked — the moment of this decision.
        approvedOn: decidedAt,
        // The employee's own request date, so the register can show both without guessing either.
        requestedOn: req.submittedOn,
        firstScheduleConsent: req.firstScheduleConsent === true,
      });
      await tx
        .update(replacementLeaveRequestDate)
        .set({ accrualId: res.accrualId })
        .where(eq(replacementLeaveRequestDate.id, line.id));
      granted += 1;
      daysCredited = round2(daysCredited + res.daysCredited);
      expiresOn = res.expiresOn;
    }

    await tx
      .update(replacementLeaveRequest)
      .set({ status: 'approved', decidedAt, decidedByUserId: ctx.userId ?? null, decisionNote: p.note?.trim() || null })
      .where(eq(replacementLeaveRequest.id, p.requestId));

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'replacement-leave-request',
      aggregateId: p.requestId,
      eventType: 'replacement-leave-request.approved',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { granted, daysCredited, expiresOn, decidedAt: decidedAt.toISOString(), submittedOn: req.submittedOn },
    });

    return { status: 'approved' as const, granted, daysCredited, expiresOn };
  });
}

/**
 * 5ff7daff · THE APPROVER'S QUEUE — one pending replacement-leave request per row, with the employee's
 * name and every worked-date line.
 *
 * WHY THIS DID NOT EXIST UNTIL NOW, which is the whole defect this round fixes. `decideReplacementLeaveRequest`
 * above was written, tested and deployed with NO CALLER: no screen anywhere reached it, so a request could
 * be submitted and then simply sat, seen by nobody. Production had 0 rows in `toil_accrual`,
 * `replacement_leave_request` and `replacement_leave_request_date` for exactly that reason — the employee's
 * half worked, and the manager's half did not exist. A unit test of either half passes throughout; the
 * missing thing was the EDGE between them (AGENTS.md rule 17), which is why this round also adds a
 * source-shape guard that /approvals mounts the section and posts to the decide action.
 *
 * SCOPED LIKE ITS SIBLINGS. `companyIds` is the same reporting-line scope /approvals already computes for
 * leave, corrections and travel, and RLS remains the row-visibility authority beneath it. The SELF-GRANT
 * BAN is NOT applied here: `assertCanDecide` refuses the viewer's own request at decide time, and the
 * approvals page renders it (like the leave queue does) with the buttons replaced by "Your request" — a row
 * hidden from its own subject reads as a lost request, which is the failure this whole round is about.
 */
export type PendingReplacementRequestRow = {
  id: string;
  employmentId: string;
  personId: string;
  employee: string;
  employeeCode: string | null;
  unit: ReplacementLeaveRequestUnit;
  totalDays: number;
  totalHours: number;
  submittedOn: string;
  createdAt: Date;
  reason: string | null;
  dates: { workedDate: string; days: number | null; fromTime: string | null; toTime: string | null; hours: number | null }[];
};

export async function listPendingReplacementLeaveRequests(
  ctx: SessionContext,
  opts: { companyIds?: string[] } = {},
): Promise<PendingReplacementRequestRow[]> {
  return withTenant(ctx, async (tx) => {
    const heads = await tx
      .select({
        id: replacementLeaveRequest.id,
        employmentId: replacementLeaveRequest.employmentId,
        personId: employment.personId,
        employee: person.fullName,
        employeeCode: employment.employeeCode, // Employee ID left-of-name (feedback 38668d9b)
        unit: replacementLeaveRequest.unit,
        totalDays: replacementLeaveRequest.totalDays,
        totalHours: replacementLeaveRequest.totalHours,
        submittedOn: replacementLeaveRequest.submittedOn,
        createdAt: replacementLeaveRequest.createdAt,
        reason: replacementLeaveRequest.reason,
      })
      .from(replacementLeaveRequest)
      .innerJoin(employment, eq(employment.id, replacementLeaveRequest.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          eq(replacementLeaveRequest.status, 'pending'),
          opts.companyIds && opts.companyIds.length ? inArray(employment.companyId, opts.companyIds) : undefined,
        ),
      )
      .orderBy(desc(replacementLeaveRequest.createdAt))
      .limit(200);
    if (heads.length === 0) return [];
    const lines = await tx
      .select()
      .from(replacementLeaveRequestDate)
      .where(inArray(replacementLeaveRequestDate.requestId, heads.map((h) => h.id)))
      .orderBy(replacementLeaveRequestDate.workedDate);
    const byRequest = new Map<string, PendingReplacementRequestRow['dates']>();
    for (const l of lines) {
      const arr = byRequest.get(l.requestId) ?? [];
      arr.push({
        workedDate: l.workedDate,
        days: l.days != null ? Number(l.days) : null,
        fromTime: l.fromTime ?? null,
        toTime: l.toTime ?? null,
        hours: l.hours != null ? Number(l.hours) : null,
      });
      byRequest.set(l.requestId, arr);
    }
    return heads.map((h) => ({
      ...h,
      totalDays: Number(h.totalDays),
      totalHours: Number(h.totalHours),
      reason: h.reason ?? null,
      dates: byRequest.get(h.id) ?? [],
    }));
  });
}

export type ReplacementRequestRow = {
  id: string;
  unit: ReplacementLeaveRequestUnit;
  totalDays: number;
  totalHours: number;
  status: ReplacementLeaveRequestStatus;
  submittedOn: string;
  decidedAt: string | null;
  reason: string | null;
  dates: { workedDate: string; days: number | null; fromTime: string | null; toTime: string | null; hours: number | null }[];
};

/** One employee's replacement-leave requests, newest first, with their worked-date lines. */
export async function listReplacementLeaveRequests(
  ctx: SessionContext,
  employmentId: string,
): Promise<ReplacementRequestRow[]> {
  return withTenant(ctx, async (tx) => {
    const heads = await tx
      .select()
      .from(replacementLeaveRequest)
      .where(eq(replacementLeaveRequest.employmentId, employmentId))
      .orderBy(desc(replacementLeaveRequest.submittedOn), desc(replacementLeaveRequest.createdAt));
    if (heads.length === 0) return [];
    const lines = await tx
      .select()
      .from(replacementLeaveRequestDate)
      .where(inArray(replacementLeaveRequestDate.requestId, heads.map((h) => h.id)))
      .orderBy(replacementLeaveRequestDate.workedDate);
    const byRequest = new Map<string, ReplacementRequestRow['dates']>();
    for (const l of lines) {
      const arr = byRequest.get(l.requestId) ?? [];
      arr.push({
        workedDate: l.workedDate,
        days: l.days != null ? Number(l.days) : null,
        fromTime: l.fromTime ?? null,
        toTime: l.toTime ?? null,
        hours: l.hours != null ? Number(l.hours) : null,
      });
      byRequest.set(l.requestId, arr);
    }
    return heads.map((h) => ({
      id: h.id,
      unit: h.unit,
      totalDays: Number(h.totalDays),
      totalHours: Number(h.totalHours),
      status: h.status,
      submittedOn: h.submittedOn,
      decidedAt: h.decidedAt ? h.decidedAt.toISOString() : null,
      reason: h.reason ?? null,
      dates: byRequest.get(h.id) ?? [],
    }));
  });
}
