/**
 * Automated Probation / Contract / Internship Review Workflow (0110).
 *
 * Two-stage workflow: a manager evaluation (stage 1, pending_manager → pending_hr) then an HR decision
 * (stage 2, pending_hr → completed). All HR decisions are ADVISORY in v1: confirm/extend/terminate record
 * a decision + a domain event + a deep-link, but none mutate employment state and none write back to a
 * trigger column. The review type/end-date is resolved at RUNTIME from the employee's CURRENT open
 * assignment row (assignment.employment_type), never a cached type→column pairing.
 *
 * Substrate discipline: every write appends a DomainEvent (appendEvent + actorOf) threading ctx.tenantId.
 * RLS (employment_review, mirrors resignation_request) scopes who can read/write; stage authorization
 * (manager-only stage 1, admin-only stage 2, never-self) lives here.
 */
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  assignment,
  company,
  companyPayrollConfig,
  employment,
  employmentReview,
  employmentReviewReminder,
  employmentTypeEnum,
  person,
  resignationRequest,
  reviewDocument,
} from '../db/schema';

type EmploymentType = (typeof employmentTypeEnum.enumValues)[number];
import { assertCanDecide } from './approvals';
import { currentAdminManager } from './performance';

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewError';
  }
}

export type ReviewType = 'probation' | 'contract' | 'internship';
export type ReviewRecommendation = 'recommend_confirm' | 'recommend_extend' | 'recommend_terminate';
export type ReviewDecision = 'confirm' | 'extend' | 'terminate';

/** The single review-lead offset (§1.7). due_date = end_date − REVIEW_LEAD. Title says "3 weeks";
 *  implemented as 1 month per the explicit `IF current_date = end_date − 1 month` spec rule. */
export const REVIEW_LEAD = { months: 1 } as const;

/** Subtract REVIEW_LEAD (1 month) from an ISO date, clamping the day to the target month's last day
 *  (pure UTC string math — no Date-TZ drift). 2026-03-31 − 1mo → 2026-02-28. */
export function subtractReviewLead(endDate: string): string {
  const y = Number(endDate.slice(0, 4));
  const m = Number(endDate.slice(5, 7));
  const d = Number(endDate.slice(8, 10));
  const total = m - 1 - REVIEW_LEAD.months; // 0-based month after subtracting
  const targetYear = y + Math.floor(total / 12);
  const targetMonth = ((total % 12) + 12) % 12; // 0-based, wrapped positive
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(d, lastDay);
  const mm = String(targetMonth + 1).padStart(2, '0');
  const dd = String(clampedDay).padStart(2, '0');
  return `${targetYear}-${mm}-${dd}`;
}

type EmploymentEndDates = {
  probationEndDate: string | null;
  contractEndDate: string | null;
  internshipEndDate: string | null;
  /** The end date captured at hire (`hireEmployee` only writes this column, not the type-specific ones).
   *  Used as a fallback so a new hire's review still opens before the type-specific column is set (#20).
   *  Optional so existing callers that only pass the type-specific columns keep compiling (absent ⇒ no
   *  fallback). The live read paths (`liveTypeAndDates` / `sweepDueReviews`) always supply it. */
  provisionalEndOn?: string | null;
};

/**
 * Pure helper (§2.1). Map the live employment_type → its review type + the matching end-date column off
 * `employment`, and compute the due date. part_time → null (deliberate: no review). full_time →
 * probation, contract → contract, intern → internship. Returns null endDate if the relevant column is unset.
 */
export function computeReviewWindow(
  employmentType: EmploymentType,
  emp: EmploymentEndDates,
): { reviewType: ReviewType; endDate: string | null; dueDate: string | null } | null {
  let reviewType: ReviewType;
  let endDate: string | null;
  if (employmentType === 'full_time') {
    reviewType = 'probation';
    endDate = emp.probationEndDate;
  } else if (employmentType === 'contract') {
    reviewType = 'contract';
    endDate = emp.contractEndDate;
  } else if (employmentType === 'intern') {
    reviewType = 'internship';
    endDate = emp.internshipEndDate;
  } else {
    return null; // part_time — no review
  }
  // Fallback to the at-hire provisional end (bug #20): hireEmployee writes only `employment.provisionalEndOn`,
  // never the type-specific column, so without this a new hire's review window stays null and never opens.
  if (endDate == null) endDate = emp.provisionalEndOn ?? null;
  const dueDate = endDate ? subtractReviewLead(endDate) : null;
  return { reviewType, endDate, dueDate };
}

/** Read the employee's CURRENT open assignment employment_type + the employment end-date columns. */
async function liveTypeAndDates(
  tx: Tx,
  employmentId: string,
): Promise<{ employmentType: EmploymentType; personId: string; emp: EmploymentEndDates } | null> {
  const [row] = await tx
    .select({
      employmentType: assignment.employmentType,
      personId: employment.personId,
      probationEndDate: employment.probationEndDate,
      contractEndDate: employment.contractEndDate,
      internshipEndDate: employment.internshipEndDate,
      provisionalEndOn: employment.provisionalEndOn,
    })
    .from(assignment)
    .innerJoin(employment, eq(employment.id, assignment.employmentId))
    .where(
      and(
        eq(assignment.employmentId, employmentId),
        isNull(assignment.validTo),
        isNull(assignment.supersededAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    employmentType: row.employmentType,
    personId: row.personId,
    emp: {
      probationEndDate: row.probationEndDate,
      contractEndDate: row.contractEndDate,
      internshipEndDate: row.internshipEndDate,
      provisionalEndOn: row.provisionalEndOn,
    },
  };
}

const COLUMN_FOR: Record<ReviewType, 'probationEndDate' | 'contractEndDate' | 'internshipEndDate'> = {
  probation: 'probationEndDate',
  contract: 'contractEndDate',
  internship: 'internshipEndDate',
};

/**
 * §1.8 — admin/HR sets a review end-date for an existing employee (the smallest surface that makes the
 * feature non-inert on day one). A single nullable-date write on `employment`, by review type.
 */
export async function setReviewEndDate(
  ctx: SessionContext,
  p: { employmentId: string; reviewType: ReviewType; endDate: string | null },
) {
  const endDate = p.endDate ? String(p.endDate).trim() : null;
  if (endDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new ReviewError('A valid end date (YYYY-MM-DD) is required.');
  }
  const column = COLUMN_FOR[p.reviewType];
  return withTenant(ctx, async (tx) => {
    const updated = await tx
      .update(employment)
      .set({ [column]: endDate })
      .where(eq(employment.id, p.employmentId))
      .returning({ id: employment.id });
    if (updated.length === 0) throw new ReviewError('Employee not found (or not visible).');
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment-review',
      aggregateId: p.employmentId,
      eventType: 'employment-review.end-date-set',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { reviewType: p.reviewType, endDate },
    });
    return { employmentId: p.employmentId, reviewType: p.reviewType, endDate };
  });
}

/** Open a review for an employment (button or cron path). Resolves type/end-date from the live assignment;
 *  rejects if the relevant end-date is null. One open review per (employment, type) — SELECT + partial-unique. */
export async function startReview(
  ctx: SessionContext,
  p: { employmentId: string; auto?: boolean },
) {
  return withTenant(ctx, async (tx) => {
    return startReviewTx(tx, ctx, p);
  });
}

/** The startReview body, usable inside an existing transaction (the sweep reuses it). */
async function startReviewTx(
  tx: Tx,
  ctx: SessionContext,
  p: { employmentId: string; auto?: boolean },
) {
  const live = await liveTypeAndDates(tx, p.employmentId);
  if (!live) throw new ReviewError('Employee has no active assignment.');
  const window = computeReviewWindow(live.employmentType, live.emp);
  if (!window) throw new ReviewError('This employment type does not require a review.');
  if (!window.endDate || !window.dueDate) {
    throw new ReviewError(`No ${window.reviewType} end date set for this employee.`);
  }

  const managerEmploymentId = await currentAdminManager(tx, ctx.tenantId, p.employmentId);

  // Pre-insert SELECT for ANY existing review — open OR completed — for this (employment, type). v1 has no
  // legitimate re-trigger: the due_date derives from the unchanged *_end_date, so a completed review must
  // block re-opening, otherwise the sweep re-opens a fresh duplicate every cron run (H5). The partial-unique
  // index only forbids two OPEN rows, so this SELECT is the real gate for the completed case.
  const [existing] = await tx
    .select({ id: employmentReview.id })
    .from(employmentReview)
    .where(
      and(
        eq(employmentReview.employmentId, p.employmentId),
        eq(employmentReview.reviewType, window.reviewType),
      ),
    )
    .limit(1);
  if (existing) throw new ReviewError('A review already exists for this employee.');

  let row: { id: string };
  try {
    [row] = await tx
      .insert(employmentReview)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        personId: live.personId,
        reviewType: window.reviewType,
        status: 'pending_manager',
        endDate: window.endDate,
        dueDate: window.dueDate,
        managerEmploymentId: managerEmploymentId ?? null,
        autoTriggered: p.auto ?? false,
      })
      .returning({ id: employmentReview.id });
  } catch (e) {
    // Backstop: the partial-unique index caught a concurrent open review for this (employment, type).
    if (/employment_review_open_uq|duplicate key/i.test((e as Error).message)) {
      throw new ReviewError('A review is already in progress.');
    }
    throw e;
  }

  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'employment-review',
    aggregateId: row.id,
    eventType: 'employment-review.started',
    actor: actorOf(ctx),
    subjectEmploymentId: p.employmentId,
    payload: { reviewType: window.reviewType, auto: p.auto ?? false },
  });
  return { reviewId: row.id, reviewType: window.reviewType, dueDate: window.dueDate };
}

/** Stage 1 — the manager submits their evaluation; advances pending_manager → pending_hr. */
export async function submitManagerEvaluation(
  ctx: SessionContext,
  p: { reviewId: string; recommendation: ReviewRecommendation; comments?: string | null },
) {
  return withTenant(ctx, async (tx) => {
    const [rev] = await tx.select().from(employmentReview).where(eq(employmentReview.id, p.reviewId)).limit(1);
    if (!rev) throw new ReviewError('Review not found (or not visible).');
    if (rev.status !== 'pending_manager') throw new ReviewError('This review is not awaiting a manager evaluation.');

    // Guard: the assigned manager's person, OR admin. Admin fallback covers the no-manager and
    // manager-is-subject deadlocks (§2.7). Never the subject unless admin.
    const roles = ctx.roles ?? [];
    const isAdminRole = roles.includes('super_admin') || roles.includes('hr_admin');
    const isAssignedManager =
      rev.managerEmploymentId != null && ctx.personId != null && (await isPersonOfEmployment(tx, rev.managerEmploymentId, ctx.personId));
    if (!isAdminRole && !isAssignedManager) {
      throw new ReviewError('Only the assigned manager or an admin can submit this evaluation.');
    }

    await tx
      .update(employmentReview)
      .set({
        managerRecommendation: p.recommendation,
        managerComments: p.comments?.trim() || null,
        managerSubmittedAt: sql`now()`,
        status: 'pending_hr',
      })
      .where(eq(employmentReview.id, rev.id));

    // Substrate skip-comment: the manager's recommendation stays OUT of the payload. subjectEmploymentId
    // makes this event subject-visible (db/events.ts), and the recommendation is manager-private — it lives
    // on the row (admin/manager RLS). The payload carries only non-sensitive metadata.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment-review',
      aggregateId: rev.id,
      eventType: 'employment-review.manager-evaluated',
      actor: actorOf(ctx),
      subjectEmploymentId: rev.employmentId,
      payload: { reviewType: rev.reviewType },
    });
    return { status: 'pending_hr' as const };
  });
}

/** Stage 2 — HR's final decision (advisory). Admin-only, never self. Advances pending_hr → completed. */
export async function decideReview(
  ctx: SessionContext,
  p: {
    reviewId: string;
    decision: ReviewDecision;
    extendToDate?: string | null;
    hrComments?: string | null;
    deciderEmploymentId?: string | null;
  },
) {
  return withTenant(ctx, async (tx) => {
    const [rev] = await tx.select().from(employmentReview).where(eq(employmentReview.id, p.reviewId)).limit(1);
    if (!rev) throw new ReviewError('Review not found (or not visible).');
    if (rev.status !== 'pending_hr') throw new ReviewError('This review is not awaiting an HR decision.');
    await assertCanDecide(tx, ctx, rev.employmentId, 'review'); // bans self-decide (super_admin escape honored)
    const roles = ctx.roles ?? [];
    if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
      throw new ReviewError('Only an admin can decide a review.');
    }

    let extendToDate: string | null = null;
    if (p.decision === 'extend') {
      extendToDate = p.extendToDate ? String(p.extendToDate).trim() : null;
      if (!extendToDate || !/^\d{4}-\d{2}-\d{2}$/.test(extendToDate)) {
        throw new ReviewError('An extension date (YYYY-MM-DD) is required to extend.');
      }
      // Stored on the review row ONLY — v1 does NOT write back to *_end_date and does NOT re-trigger.
    }

    await tx
      .update(employmentReview)
      .set({
        decision: p.decision,
        extendToDate,
        hrComments: p.hrComments?.trim() || null,
        decidedByEmploymentId: p.deciderEmploymentId ?? null,
        decidedAt: sql`now()`,
        status: 'completed',
      })
      .where(eq(employmentReview.id, rev.id));

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment-review',
      aggregateId: rev.id,
      eventType: 'employment-review.decided',
      actor: actorOf(ctx),
      subjectEmploymentId: rev.employmentId,
      payload: { decision: p.decision, reviewType: rev.reviewType },
    });
    return { status: 'completed' as const, decision: p.decision };
  });
}

async function isPersonOfEmployment(tx: Tx, employmentId: string, personId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: employment.id })
    .from(employment)
    .where(and(eq(employment.id, employmentId), eq(employment.personId, personId)))
    .limit(1);
  return !!row;
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────────────────────

export type ReviewListRow = {
  id: string;
  employmentId: string;
  personId: string;
  employee: string;
  employeeCode: string | null;
  reviewType: ReviewType;
  status: 'pending_manager' | 'pending_hr' | 'completed' | 'cancelled';
  endDate: string;
  dueDate: string;
  managerEmploymentId: string | null;
  managerRecommendation: string | null;
  managerComments: string | null;
  decision: ReviewDecision | null;
  extendToDate: string | null;
  hrComments: string | null;
  createdAt: Date;
};

/** HR inbox — RLS-scoped, recent-first (mirror listResignationRequests). */
export function listReviews(
  ctx: SessionContext,
  opts: { status?: 'pending_manager' | 'pending_hr' | 'completed' | 'cancelled' } = {},
): Promise<ReviewListRow[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: employmentReview.id,
        employmentId: employmentReview.employmentId,
        personId: employmentReview.personId,
        employee: person.fullName,
        employeeCode: employment.employeeCode,
        reviewType: employmentReview.reviewType,
        status: employmentReview.status,
        endDate: employmentReview.endDate,
        dueDate: employmentReview.dueDate,
        managerEmploymentId: employmentReview.managerEmploymentId,
        managerRecommendation: employmentReview.managerRecommendation,
        managerComments: employmentReview.managerComments,
        decision: employmentReview.decision,
        extendToDate: employmentReview.extendToDate,
        hrComments: employmentReview.hrComments,
        createdAt: employmentReview.createdAt,
      })
      .from(employmentReview)
      .innerJoin(employment, eq(employment.id, employmentReview.employmentId))
      .innerJoin(person, eq(person.id, employmentReview.personId))
      .where(opts.status ? eq(employmentReview.status, opts.status) : undefined)
      .orderBy(desc(employmentReview.createdAt))
      .limit(200),
  ) as Promise<ReviewListRow[]>;
}

/** Reviews for one employment (profile + /me). Recent-first. */
export function reviewsFor(ctx: SessionContext, employmentId: string): Promise<ReviewListRow[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: employmentReview.id,
        employmentId: employmentReview.employmentId,
        personId: employmentReview.personId,
        employee: person.fullName,
        employeeCode: employment.employeeCode,
        reviewType: employmentReview.reviewType,
        status: employmentReview.status,
        endDate: employmentReview.endDate,
        dueDate: employmentReview.dueDate,
        managerEmploymentId: employmentReview.managerEmploymentId,
        managerRecommendation: employmentReview.managerRecommendation,
        managerComments: employmentReview.managerComments,
        decision: employmentReview.decision,
        extendToDate: employmentReview.extendToDate,
        hrComments: employmentReview.hrComments,
        createdAt: employmentReview.createdAt,
      })
      .from(employmentReview)
      .innerJoin(employment, eq(employment.id, employmentReview.employmentId))
      .innerJoin(person, eq(person.id, employmentReview.personId))
      .where(eq(employmentReview.employmentId, employmentId))
      .orderBy(desc(employmentReview.createdAt))
      .limit(50),
  ) as Promise<ReviewListRow[]>;
}

export type ReviewLetterRow = {
  id: string;
  reviewType: ReviewType;
  decision: ReviewDecision;
  employee: string;
  employer: string;
  endDate: string;
  extendToDate: string | null;
  decidedOn: string;
};

/** Data for the completed-review letter (RLS-gated: null if foreign/invisible OR not yet completed). */
export function reviewLetterData(ctx: SessionContext, reviewId: string): Promise<ReviewLetterRow | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: employmentReview.id,
        reviewType: employmentReview.reviewType,
        status: employmentReview.status,
        decision: employmentReview.decision,
        employee: person.fullName,
        employer: company.legalName,
        endDate: employmentReview.endDate,
        extendToDate: employmentReview.extendToDate,
        decidedAt: employmentReview.decidedAt,
        createdAt: employmentReview.createdAt,
      })
      .from(employmentReview)
      .innerJoin(person, eq(person.id, employmentReview.personId))
      .innerJoin(employment, eq(employment.id, employmentReview.employmentId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(eq(employmentReview.id, reviewId))
      .limit(1);
    if (!row || row.status !== 'completed' || !row.decision) return null;
    const decidedOn = (row.decidedAt ?? row.createdAt).toISOString().slice(0, 10);
    return {
      id: row.id,
      reviewType: row.reviewType,
      decision: row.decision,
      employee: row.employee,
      employer: row.employer,
      endDate: row.endDate,
      extendToDate: row.extendToDate,
      decidedOn,
    };
  });
}

export type ReviewProfile = {
  employmentType: EmploymentType;
  reviewType: ReviewType | null; // null for part_time
  endDate: string | null;
  dueDate: string | null;
  openReview: { id: string; status: 'pending_manager' | 'pending_hr' } | null;
};

/** Profile-section read: the live type, its review window, and any open review (for the Review card). */
export function reviewProfile(ctx: SessionContext, employmentId: string): Promise<ReviewProfile | null> {
  return withTenant(ctx, async (tx) => {
    const live = await liveTypeAndDates(tx, employmentId);
    if (!live) return null;
    const window = computeReviewWindow(live.employmentType, live.emp);
    let openReview: { id: string; status: 'pending_manager' | 'pending_hr' } | null = null;
    if (window) {
      const [open] = await tx
        .select({ id: employmentReview.id, status: employmentReview.status })
        .from(employmentReview)
        .where(
          and(
            eq(employmentReview.employmentId, employmentId),
            eq(employmentReview.reviewType, window.reviewType),
            or(eq(employmentReview.status, 'pending_manager'), eq(employmentReview.status, 'pending_hr')),
          ),
        )
        .limit(1);
      if (open) openReview = { id: open.id, status: open.status as 'pending_manager' | 'pending_hr' };
    }
    return {
      employmentType: live.employmentType,
      reviewType: window?.reviewType ?? null,
      endDate: window?.endDate ?? null,
      dueDate: window?.dueDate ?? null,
      openReview,
    };
  });
}

/** The manager queue — pending_manager reviews assigned to this manager employment. */
export function pendingManagerReviewsFor(
  ctx: SessionContext,
  managerEmploymentId: string,
): Promise<ReviewListRow[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: employmentReview.id,
        employmentId: employmentReview.employmentId,
        personId: employmentReview.personId,
        employee: person.fullName,
        employeeCode: employment.employeeCode,
        reviewType: employmentReview.reviewType,
        status: employmentReview.status,
        endDate: employmentReview.endDate,
        dueDate: employmentReview.dueDate,
        managerEmploymentId: employmentReview.managerEmploymentId,
        managerRecommendation: employmentReview.managerRecommendation,
        managerComments: employmentReview.managerComments,
        decision: employmentReview.decision,
        extendToDate: employmentReview.extendToDate,
        hrComments: employmentReview.hrComments,
        createdAt: employmentReview.createdAt,
      })
      .from(employmentReview)
      .innerJoin(employment, eq(employment.id, employmentReview.employmentId))
      .innerJoin(person, eq(person.id, employmentReview.personId))
      .where(
        and(
          eq(employmentReview.managerEmploymentId, managerEmploymentId),
          eq(employmentReview.status, 'pending_manager'),
        ),
      )
      .orderBy(desc(employmentReview.createdAt))
      .limit(200),
  ) as Promise<ReviewListRow[]>;
}

// ─── Sweep (cron) ───────────────────────────────────────────────────────────────────────────────────

/**
 * §2.6 — open a review for every active employment whose computed due_date <= today AND that has no open
 * review for that type. Excludes leavers (terminated / open resignation / future-dated termination) so we
 * don't auto-open + notify for someone on their way out. Idempotent on re-run. Returns { opened }.
 */
export async function sweepDueReviews(
  ctx: SessionContext,
  opts: { today?: string } = {},
): Promise<{ opened: number }> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  return withTenant(ctx, async (tx) => {
    // Enumerate active employments left-joined to the current open assignment row.
    const rows = await tx
      .select({
        employmentId: employment.id,
        terminatedOn: employment.terminatedOn,
        employmentType: assignment.employmentType,
        probationEndDate: employment.probationEndDate,
        contractEndDate: employment.contractEndDate,
        internshipEndDate: employment.internshipEndDate,
        provisionalEndOn: employment.provisionalEndOn,
      })
      .from(employment)
      .innerJoin(
        assignment,
        and(
          eq(assignment.employmentId, employment.id),
          isNull(assignment.validTo),
          isNull(assignment.supersededAt),
        ),
      )
      .where(isNull(employment.terminatedOn)); // skip already-terminated (future-dated terminatedOn also excluded)

    let opened = 0;
    for (const r of rows) {
      const window = computeReviewWindow(r.employmentType, r);
      if (!window || !window.endDate || !window.dueDate) continue;
      if (window.dueDate > today) continue; // not due yet

      // Exclude leavers with an open resignation (pending) — on their way out.
      const [resign] = await tx
        .select({ id: resignationRequest.id })
        .from(resignationRequest)
        .where(
          and(
            eq(resignationRequest.employmentId, r.employmentId),
            eq(resignationRequest.status, 'pending'),
          ),
        )
        .limit(1);
      if (resign) continue;

      // Gate on "no review at all for this type" — open OR completed. due_date derives from the unchanged
      // *_end_date, so a completed review keeps dueDate <= today; gating only on OPEN reviews would re-open a
      // fresh duplicate every cron run forever (H5). v1 has no legitimate re-trigger, so one review per
      // (employment, type) is the lifetime cap.
      const [existing] = await tx
        .select({ id: employmentReview.id })
        .from(employmentReview)
        .where(
          and(
            eq(employmentReview.employmentId, r.employmentId),
            eq(employmentReview.reviewType, window.reviewType),
          ),
        )
        .limit(1);
      if (existing) continue;

      try {
        await startReviewTx(tx, ctx, { employmentId: r.employmentId, auto: true });
        opened += 1;
      } catch (e) {
        // A concurrent insert (the startReviewTx existing-review gate / partial-unique backstop) is
        // benign — keep sweeping.
        if (!/already/i.test((e as Error).message)) throw e;
      }
    }
    return { opened };
  });
}

// ─── Reminder cadence sweep (6522d26a Fn 2) ─────────────────────────────────────────────────────────

/** Default reminder cadence: days BEFORE the review end date at which the sweep nudges manager + HR.
 *  Overridable per company via company_payroll_config.review_reminder_days. */
export const DEFAULT_REVIEW_REMINDER_DAYS = [30, 14, 7] as const;

/** Normalize a configured cadence: null/empty ⇒ default; else trunc → keep 1–365 → dedupe → sort desc.
 *  Pure, exported for the config form + tests. */
export function resolveReminderDays(days: readonly (number | string)[] | null | undefined): number[] {
  const src = days && days.length ? days : DEFAULT_REVIEW_REMINDER_DAYS;
  const clean = [
    ...new Set(src.map((d) => Math.trunc(Number(d))).filter((d) => Number.isFinite(d) && d >= 1 && d <= 365)),
  ];
  return clean.length ? clean.sort((a, b) => b - a) : [...DEFAULT_REVIEW_REMINDER_DAYS];
}

/** Pure UTC string date math: isoDate − days (no Date-TZ drift). */
export function subtractDays(isoDate: string, days: number): string {
  const t = Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)));
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Reminder sweep (the deferred ADR-0034 34-4 producer, 6522d26a Fn 2). For every OPEN review
 * (pending_manager | pending_hr), fire a reminder when `today` enters a configured offset window
 * (`end_date − offsetDays <= today`) that hasn't fired yet. Each (review, offset) fires AT MOST ONCE —
 * a row in employment_review_reminder is the idempotency ledger (unique index is the hard gate).
 *
 * Catch-up coalescing: if several offsets are in-window on one run (sweep was down, or the review opened
 * late), ALL of them get dedup rows but only the MOST URGENT (smallest offset) appends the
 * `employment-review.reminder-due` event — one nudge, not a burst. The extra rows are pure dedup markers
 * (plumbing — deliberate substrate skip, documented here).
 *
 * Recipients (manager + HR admins) are resolved by the notification registry off the review row, keeping
 * this service recipient-agnostic. Excludes leavers (terminated / open resignation), mirroring
 * sweepDueReviews. Reminders key off end_date (the probation due date the reporter means), independent of
 * the 1-month auto-open lead — the auto-open fires the review, reminders chase the pending decision.
 */
export async function sweepReviewReminders(
  ctx: SessionContext,
  opts: { today?: string } = {},
): Promise<{ reminders: number }> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        reviewId: employmentReview.id,
        employmentId: employmentReview.employmentId,
        reviewType: employmentReview.reviewType,
        endDate: employmentReview.endDate,
        terminatedOn: employment.terminatedOn,
        reminderDays: companyPayrollConfig.reviewReminderDays,
      })
      .from(employmentReview)
      .innerJoin(employment, eq(employment.id, employmentReview.employmentId))
      .leftJoin(companyPayrollConfig, eq(companyPayrollConfig.companyId, employment.companyId))
      .where(or(eq(employmentReview.status, 'pending_manager'), eq(employmentReview.status, 'pending_hr')));

    let reminders = 0;
    for (const r of rows) {
      if (r.terminatedOn != null) continue; // leaver — already terminated
      // Leaver with an open resignation — on their way out (mirrors sweepDueReviews).
      const [resign] = await tx
        .select({ id: resignationRequest.id })
        .from(resignationRequest)
        .where(and(eq(resignationRequest.employmentId, r.employmentId), eq(resignationRequest.status, 'pending')))
        .limit(1);
      if (resign) continue;

      // Offsets whose window has arrived (end_date − offset <= today) and that haven't fired.
      const offsets = resolveReminderDays(r.reminderDays);
      const eligible: number[] = [];
      for (const offsetDays of offsets) {
        if (subtractDays(r.endDate, offsetDays) > today) continue; // window not reached yet
        const [sent] = await tx
          .select({ id: employmentReviewReminder.id })
          .from(employmentReviewReminder)
          .where(
            and(
              eq(employmentReviewReminder.reviewId, r.reviewId),
              eq(employmentReviewReminder.offsetDays, offsetDays),
            ),
          )
          .limit(1);
        if (!sent) eligible.push(offsetDays);
      }
      if (eligible.length === 0) continue;

      const fireOffset = Math.min(...eligible); // most urgent
      let fired = false;
      for (const offsetDays of eligible) {
        try {
          await tx.insert(employmentReviewReminder).values({
            tenantId: ctx.tenantId,
            reviewId: r.reviewId,
            employmentId: r.employmentId,
            offsetDays,
            sentOn: today,
          });
        } catch (e) {
          // Concurrent sweep raced past the pre-check — the unique index makes this (review, offset) a no-op.
          if (/employment_review_reminder_uq|duplicate key/i.test((e as Error).message)) continue;
          throw e;
        }
        if (offsetDays !== fireOffset) continue; // superseded catch-up offset: dedup row only (plumbing skip)
        // SUBSTRATE: the reminder itself — the notification registry projects this to manager + HR.
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'employment-review',
          aggregateId: r.reviewId,
          eventType: 'employment-review.reminder-due',
          actor: actorOf(ctx),
          subjectEmploymentId: r.employmentId,
          payload: { reviewType: r.reviewType, offsetDays, dueOn: r.endDate },
        });
        fired = true;
      }
      if (fired) reminders += 1;
    }

    // One summary event per run that did work (per-item events above are the fan-out source; the summary
    // is the cron audit line, mirroring leave.aged.swept). Zero-work runs append nothing — deliberate,
    // the sweep is daily and an empty run is not a state change.
    if (reminders > 0) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'employment-review-reminder-sweep',
        aggregateId: ctx.tenantId, // tenant-level virtual aggregate (UUID-typed; mirrors leave.aged.swept)
        eventType: 'employment-review.reminders.swept',
        actor: actorOf(ctx),
        payload: { today, reminders },
      });
    }
    return { reminders };
  });
}

// ─── Letter document management (6522d26a Fn 5 + Fn 6) ─────────────────────────────────────────────

export type ReviewDocumentKind = 'system_letter' | 'signed_letter';

/** MIME allowlist for review letters (fail-closed, mirrors ALLOWED_RECEIPT_MIME): PDF / JPG / PNG.
 *  Callers sniff magic bytes BEFORE calling the service, so this checks the sniffed value. */
export const ALLOWED_REVIEW_DOC_MIME = ['application/pdf', 'image/jpeg', 'image/png'] as const;
const REVIEW_DOC_MAX_BYTES = 10 * 1024 * 1024;

function assertValidReviewDocument(mimeType: string, content: Buffer): void {
  if (content.byteLength === 0) throw new ReviewError('Empty file');
  if (content.byteLength > REVIEW_DOC_MAX_BYTES) throw new ReviewError('File exceeds 10 MB');
  if (!(ALLOWED_REVIEW_DOC_MIME as readonly string[]).includes(mimeType)) {
    throw new ReviewError('Only PDF, JPG, or PNG files are allowed');
  }
}

/**
 * Store a probation-letter document against a COMPLETED review (admin-only — RLS also enforces
 * is_admin on write; the subject can read but never write). kind 'system_letter' = the persisted
 * system-generated letter (at most one per review — the canonical record); 'signed_letter' = HR's
 * uploaded final signed copy (several allowed, e.g. a re-signed correction).
 */
export async function uploadReviewDocument(
  ctx: SessionContext,
  p: { reviewId: string; kind: ReviewDocumentKind; fileName: string; mimeType: string; content: Buffer },
): Promise<{ id: string }> {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new ReviewError('Only an admin can manage review documents.');
  }
  assertValidReviewDocument(p.mimeType, p.content);
  return withTenant(ctx, async (tx) => {
    const [rev] = await tx
      .select({ id: employmentReview.id, employmentId: employmentReview.employmentId, status: employmentReview.status })
      .from(employmentReview)
      .where(eq(employmentReview.id, p.reviewId))
      .limit(1);
    if (!rev) throw new ReviewError('Review not found (or not visible).');
    if (rev.status !== 'completed') throw new ReviewError('Documents can only be added once the review is completed.');
    if (p.kind === 'system_letter') {
      const [existing] = await tx
        .select({ id: reviewDocument.id })
        .from(reviewDocument)
        .where(and(eq(reviewDocument.reviewId, rev.id), eq(reviewDocument.kind, 'system_letter')))
        .limit(1);
      if (existing) throw new ReviewError('The letter is already saved to this review.');
    }
    const [row] = await tx
      .insert(reviewDocument)
      .values({
        tenantId: ctx.tenantId,
        reviewId: rev.id,
        employmentId: rev.employmentId,
        kind: p.kind,
        content: p.content,
        fileName: p.fileName,
        mimeType: p.mimeType,
        sizeBytes: p.content.byteLength,
        uploadedByUserId: ctx.userId ?? null,
      })
      .returning({ id: reviewDocument.id });
    // SUBSTRATE: a new state-changing write — the DomainEvent is mandatory. File bytes stay out of the payload.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment-review',
      aggregateId: rev.id,
      eventType: 'employment-review.document-uploaded',
      actor: actorOf(ctx),
      subjectEmploymentId: rev.employmentId,
      payload: { kind: p.kind, fileName: p.fileName, sizeBytes: p.content.byteLength },
    });
    return { id: row.id };
  });
}

export type ReviewDocumentMeta = {
  id: string;
  reviewId: string;
  kind: ReviewDocumentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
};

/** All review documents for one employment (metadata only, no content) — the profile section AND the
 *  ESS /me card share this read; RLS scopes it (subject sees own, manager their line, admin all). */
export function reviewDocumentsFor(ctx: SessionContext, employmentId: string): Promise<ReviewDocumentMeta[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: reviewDocument.id,
        reviewId: reviewDocument.reviewId,
        kind: reviewDocument.kind,
        fileName: reviewDocument.fileName,
        mimeType: reviewDocument.mimeType,
        sizeBytes: reviewDocument.sizeBytes,
        createdAt: reviewDocument.createdAt,
      })
      .from(reviewDocument)
      .where(eq(reviewDocument.employmentId, employmentId))
      .orderBy(desc(reviewDocument.createdAt)),
  ) as Promise<ReviewDocumentMeta[]>;
}

/** One document's bytes for the download routes. RLS-gated: foreign/invisible id → null → 404. Read-only — no event. */
export function getReviewDocument(
  ctx: SessionContext,
  documentId: string,
): Promise<{ content: Buffer; fileName: string; mimeType: string; reviewId: string } | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        content: reviewDocument.content,
        fileName: reviewDocument.fileName,
        mimeType: reviewDocument.mimeType,
        reviewId: reviewDocument.reviewId,
      })
      .from(reviewDocument)
      .where(eq(reviewDocument.id, documentId))
      .limit(1);
    return row ? { content: row.content as Buffer, fileName: row.fileName, mimeType: row.mimeType, reviewId: row.reviewId } : null;
  });
}
