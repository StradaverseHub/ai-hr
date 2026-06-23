/**
 * Leave services. Balance is the signed sum of the append-only leave_ledger
 * (accrual +, debit −, adjustment ±). Approval checks projected balance and writes
 * the debit + status flip + event atomically in one transaction.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { assertCanDecide } from './approvals';
import { resolveApprovalChain } from './leave-approval-policy';
import { packFor } from '../localization/registry';
import {
  company,
  employment,
  holiday,
  leaveApprovalStep,
  leaveLedger,
  leavePolicy,
  leaveRequest,
  leaveRequestAttachment,
  leaveType,
  person,
  reportingLine,
} from '../db/schema';

export class InsufficientLeaveBalanceError extends Error {
  constructor() {
    super('Leave rejected: insufficient balance');
    this.name = 'InsufficientLeaveBalanceError';
  }
}

// ── Eligibility (ADR-0038 2A-1, #25) ──────────────────────────────────────────────────────────────
// A lawful gate that mirrors what the Act restricts (maternity female-only EA s.37; paternity married-
// male ≥12mo EA s.60FA). It NEVER blocks a statutory entitlement — types with no restriction carry no
// eligibility, so everyone can request them.
export type LeaveEligibility = { gender?: string; maritalStatus?: string; minServiceMonths?: number };

export class LeaveIneligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaveIneligibleError';
  }
}

// ── Mandatory documents (ADR-0038 2A-2, #25) ─────────────────────────────────────────────────────
// Some leave types need a supporting document (e.g. an MC for sick leave). When leave_type.requires_
// document is set, requestLeave rejects a request that arrives without an attachment.
export class LeaveDocumentRequiredError extends Error {
  constructor() {
    super('This leave type requires a supporting document (e.g. a medical certificate)');
    this.name = 'LeaveDocumentRequiredError';
  }
}

/** Whole completed months from `start` to `asOf` (both ISO yyyy-mm-dd). */
function monthsBetween(start: string, asOf: string): number {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = asOf.split('-').map(Number);
  let months = (ey - sy) * 12 + (em - sm);
  if (ed < sd) months -= 1; // the day-of-month hasn't come round yet
  return Math.max(0, months);
}

function assertEligible(
  elig: LeaveEligibility,
  emp: { gender: string | null; marital: string | null; hiredOn: string } | undefined,
  asOf: string,
): void {
  if (elig.gender && emp?.gender !== elig.gender) {
    throw new LeaveIneligibleError(`This leave type is available to ${elig.gender} employees only.`);
  }
  if (elig.maritalStatus && emp?.marital !== elig.maritalStatus) {
    throw new LeaveIneligibleError(`This leave type requires marital status “${elig.maritalStatus}”.`);
  }
  if (elig.minServiceMonths && (!emp || monthsBetween(emp.hiredOn, asOf) < elig.minServiceMonths)) {
    throw new LeaveIneligibleError(`This leave type requires at least ${elig.minServiceMonths} months of service.`);
  }
}

/** Boolean form of the eligibility gate (assertEligible throws; this just answers). Used by reads to
 *  show an employee only the leave types they could actually take (2F-1 / R18). */
export function isLeaveEligible(
  elig: LeaveEligibility | null | undefined,
  emp: { gender: string | null; marital: string | null; hiredOn: string } | undefined,
  asOf: string,
): boolean {
  if (!elig) return true;
  if (elig.gender && emp?.gender !== elig.gender) return false;
  if (elig.maritalStatus && emp?.marital !== elig.maritalStatus) return false;
  if (elig.minServiceMonths && (!emp || monthsBetween(emp.hiredOn, asOf) < elig.minServiceMonths)) return false;
  return true;
}

export async function leaveBalance(tx: Tx, employmentId: string, leaveTypeId: string): Promise<number> {
  const [row] = await tx
    .select({ bal: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
    .from(leaveLedger)
    .where(and(eq(leaveLedger.employmentId, employmentId), eq(leaveLedger.leaveTypeId, leaveTypeId)));
  return Number(row?.bal ?? 0);
}

/** Inclusive whole-day count between two ISO dates (Slice 0 — no public-holiday logic yet). */
function dayCount(start: string, end: string): number {
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  return Math.floor((e - s) / 86_400_000) + 1;
}

function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Working days in [start, end]: excludes Sat/Sun and the given holiday dates. */
function workingDays(start: string, end: string, holidays: Set<string>): number {
  let n = 0;
  for (const d of eachDate(start, end)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6 || holidays.has(d)) continue;
    n++;
  }
  return n;
}

export async function requestLeave(
  ctx: SessionContext,
  p: {
    employmentId: string;
    leaveTypeId: string;
    startDate: string;
    endDate: string;
    reason?: string;
    hasDocument?: boolean; // 2A-2: asserts a supporting document accompanies this request
  },
) {
  return withTenant(ctx, async (tx) => {
    // Day count depends on the leave type: working-days (excl weekends + holidays) vs calendar.
    const [lt] = await tx
      .select({
        counting: leaveType.counting,
        eligibility: leaveType.eligibility,
        requiresDocument: leaveType.requiresDocument,
      })
      .from(leaveType)
      .where(eq(leaveType.id, p.leaveTypeId))
      .limit(1);

    // Mandatory-document gate (2A-2, #25) — fail fast before anything is created.
    if (lt?.requiresDocument && !p.hasDocument) throw new LeaveDocumentRequiredError();

    // Eligibility gate (2A-1, #25) — fail fast before anything is created.
    const elig = (lt?.eligibility ?? null) as LeaveEligibility | null;
    if (elig && (elig.gender || elig.maritalStatus || elig.minServiceMonths)) {
      const [emp] = await tx
        .select({ gender: person.gender, marital: person.maritalStatus, hiredOn: employment.hiredOn })
        .from(employment)
        .innerJoin(person, eq(person.id, employment.personId))
        .where(eq(employment.id, p.employmentId))
        .limit(1);
      assertEligible(elig, emp, p.startDate);
    }

    let days: number;
    if (lt?.counting === 'working_days') {
      // 2C (ADR-0038): holidays apply per the employee's work state — national (state null) ∪ their
      // effective state (work_state, falling back to the company default). National-only when unset.
      const [loc] = await tx
        .select({ ws: employment.workState, cds: company.defaultWorkState })
        .from(employment)
        .innerJoin(company, eq(company.id, employment.companyId))
        .where(eq(employment.id, p.employmentId))
        .limit(1);
      const effState = loc?.ws ?? loc?.cds ?? null;
      const hols = await tx
        .select({ d: holiday.holidayDate })
        .from(holiday)
        .where(
          and(
            gte(holiday.holidayDate, p.startDate),
            lte(holiday.holidayDate, p.endDate),
            effState ? or(isNull(holiday.state), eq(holiday.state, effState)) : isNull(holiday.state),
          ),
        );
      days = workingDays(p.startDate, p.endDate, new Set(hols.map((h) => h.d)));
    } else {
      days = dayCount(p.startDate, p.endDate);
    }
    if (days <= 0) throw new Error('No leave days in range (end before start, or all non-working)');
    const [row] = await tx
      .insert(leaveRequest)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        leaveTypeId: p.leaveTypeId,
        startDate: p.startDate,
        endDate: p.endDate,
        days: days.toFixed(2),
        status: 'pending',
        reason: p.reason ?? null,
      })
      .returning({ id: leaveRequest.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-request',
      aggregateId: row.id,
      eventType: 'leave-request.submitted',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { employmentId: p.employmentId, leaveTypeId: p.leaveTypeId, startDate: p.startDate, endDate: p.endDate, days },
    });
    // 2B-1/2B-2: if the company runs a multi-step chain, generate the instance approval steps.
    await generateApprovalSteps(tx, ctx.tenantId, row.id, p.employmentId, p.leaveTypeId);
    return { leaveRequestId: row.id, days };
  });
}

/** Generate the approval chain for a new request when its company opts into multi-step approval.
 *  2B-1 chain is fixed: direct manager (when one exists) then HR. 2B-2 will make this configurable. */
async function generateApprovalSteps(
  tx: Tx,
  tenantId: string,
  leaveRequestId: string,
  employmentId: string,
  leaveTypeId: string,
) {
  const [co] = await tx
    .select({ multi: company.leaveMultiApproval, companyId: company.id })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!co?.multi) return; // single-step company — no chain

  // Include a manager step only when the employee has a current administrative reporting line;
  // otherwise direct_manager levels are dropped (no dead step that nobody can clear).
  const [mgr] = await tx
    .select({ id: reportingLine.id })
    .from(reportingLine)
    .where(
      and(
        eq(reportingLine.subordinateEmploymentId, employmentId),
        eq(reportingLine.lineType, 'administrative'),
        lte(reportingLine.validFrom, sql`current_date`),
        or(isNull(reportingLine.validTo), sql`${reportingLine.validTo} > current_date`),
      ),
    )
    .limit(1);
  const hasManager = !!mgr;

  // 2B-2 (ADR-0039): the chain is data — resolve the company's configured levels.
  const chain = await resolveApprovalChain(tx, co.companyId, leaveTypeId);
  const kinds = chain.filter((k) => k !== 'direct_manager' || hasManager);
  if (kinds.length === 0) return;
  await tx.insert(leaveApprovalStep).values(
    kinds.map((approverKind, stepIndex) => ({
      tenantId,
      leaveRequestId,
      subjectEmploymentId: employmentId,
      stepIndex,
      approverKind,
    })),
  );
}

/** Attach a supporting document to a pending leave request (2A-2). employment_id is denormalized from
 *  the request so the attachment's RLS matches the request (subject + manager + admin). */
export async function addLeaveAttachment(
  ctx: SessionContext,
  p: { leaveRequestId: string; fileName: string; mimeType: string; content: Buffer },
): Promise<{ id: string }> {
  if (p.content.byteLength === 0) throw new Error('Empty file');
  if (p.content.byteLength > 10 * 1024 * 1024) throw new Error('File exceeds 10 MB');
  return withTenant(ctx, async (tx) => {
    const [req] = await tx
      .select({ employmentId: leaveRequest.employmentId, status: leaveRequest.status })
      .from(leaveRequest)
      .where(eq(leaveRequest.id, p.leaveRequestId))
      .limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');
    if (req.status !== 'pending') throw new Error('Documents can only be added while the request is pending');
    const [row] = await tx
      .insert(leaveRequestAttachment)
      .values({
        tenantId: ctx.tenantId,
        leaveRequestId: p.leaveRequestId,
        employmentId: req.employmentId,
        content: p.content,
        fileName: p.fileName,
        mimeType: p.mimeType,
        sizeBytes: p.content.byteLength,
        uploadedByUserId: ctx.userId ?? null,
      })
      .returning({ id: leaveRequestAttachment.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-request',
      aggregateId: p.leaveRequestId,
      eventType: 'leave-request.document.attached',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { fileName: p.fileName, sizeBytes: p.content.byteLength },
    });
    return { id: row.id };
  });
}

/** Stream a leave request's supporting document. Runs under RLS (subject + manager + admin). */
export async function getLeaveAttachment(
  ctx: SessionContext,
  leaveRequestId: string,
): Promise<{ content: Buffer; fileName: string; mimeType: string } | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        content: leaveRequestAttachment.content,
        fileName: leaveRequestAttachment.fileName,
        mimeType: leaveRequestAttachment.mimeType,
      })
      .from(leaveRequestAttachment)
      .where(eq(leaveRequestAttachment.leaveRequestId, leaveRequestId))
      .orderBy(desc(leaveRequestAttachment.createdAt))
      .limit(1);
    return row ? { content: row.content as Buffer, fileName: row.fileName, mimeType: row.mimeType } : null;
  });
}

/** Only HR (hr_admin / super_admin) may clear an hr_admin step; an HR admin still cannot decide their
 *  own request (mirrors assertCanDecide's self-ban). */
async function assertIsHrAdmin(tx: Tx, ctx: SessionContext, subjectEmploymentId: string, label: string) {
  const roles = ctx.roles ?? [];
  const isSuper = roles.includes('super_admin');
  if (!(isSuper || roles.includes('hr_admin'))) throw new Error(`Only HR can decide this ${label}`);
  if (!isSuper && ctx.personId != null) {
    const [subj] = await tx
      .select({ personId: employment.personId })
      .from(employment)
      .where(eq(employment.id, subjectEmploymentId))
      .limit(1);
    if (subj?.personId === ctx.personId) throw new Error(`You cannot decide your own ${label}`);
  }
}

type DecidableLeave = { id: string; employmentId: string; leaveTypeId: string; days: string; startDate: string };

/** Final approval: balance gate + ledger debit + status flip + event. */
async function finalizeLeaveApproval(tx: Tx, ctx: SessionContext, req: DecidableLeave, deciderEmploymentId?: string) {
  const balance = await leaveBalance(tx, req.employmentId, req.leaveTypeId);
  const need = Number(req.days);
  if (balance - need < 0) throw new InsufficientLeaveBalanceError();
  await tx.insert(leaveLedger).values({
    tenantId: ctx.tenantId,
    employmentId: req.employmentId,
    leaveTypeId: req.leaveTypeId,
    entryType: 'debit',
    days: (-need).toFixed(2),
    sourceRequestId: req.id,
    effectiveOn: req.startDate,
  });
  await tx
    .update(leaveRequest)
    .set({ status: 'approved', decidedByEmploymentId: deciderEmploymentId ?? null, decidedAt: sql`now()` })
    .where(eq(leaveRequest.id, req.id));
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'leave-request',
    aggregateId: req.id,
    eventType: 'leave-request.approved',
    actor: actorOf(ctx),
    subjectEmploymentId: req.employmentId,
    payload: { decision: 'approved', deciderEmploymentId: deciderEmploymentId ?? null },
  });
}

/** Terminal rejection: status flip + event (no ledger write). */
async function finalizeLeaveRejection(
  tx: Tx,
  ctx: SessionContext,
  req: DecidableLeave,
  deciderEmploymentId?: string,
  extra?: Record<string, unknown>,
) {
  await tx
    .update(leaveRequest)
    .set({ status: 'rejected', decidedByEmploymentId: deciderEmploymentId ?? null, decidedAt: sql`now()` })
    .where(eq(leaveRequest.id, req.id));
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'leave-request',
    aggregateId: req.id,
    eventType: 'leave-request.rejected',
    actor: actorOf(ctx),
    subjectEmploymentId: req.employmentId,
    payload: { decision: 'rejected', deciderEmploymentId: deciderEmploymentId ?? null, ...(extra ?? {}) },
  });
}

/** Decide a leave request. With a multi-step chain (2B-1) this advances the current step and only
 *  finalizes when the last step clears; a rejection at any step is terminal. Without a chain it is a
 *  single approval (the original behavior). */
export async function decideLeave(
  ctx: SessionContext,
  p: { leaveRequestId: string; decision: 'approved' | 'rejected'; deciderEmploymentId?: string },
) {
  return withTenant(ctx, async (tx) => {
    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, p.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');
    if (req.status !== 'pending') throw new Error(`leave request is already ${req.status}`);

    const steps = await tx
      .select()
      .from(leaveApprovalStep)
      .where(eq(leaveApprovalStep.leaveRequestId, req.id))
      .orderBy(asc(leaveApprovalStep.stepIndex));
    const current = steps.find((s) => s.status === 'pending');

    // Multi-step chain: decide the current step.
    if (steps.length > 0 && current) {
      if (current.approverKind === 'hr_admin') await assertIsHrAdmin(tx, ctx, req.employmentId, 'leave request');
      else await assertCanDecide(tx, ctx, req.employmentId, 'leave request'); // direct_manager
      await tx
        .update(leaveApprovalStep)
        .set({ status: p.decision, decidedByEmploymentId: p.deciderEmploymentId ?? null, decidedAt: sql`now()` })
        .where(eq(leaveApprovalStep.id, current.id));
      if (p.decision === 'rejected') {
        await finalizeLeaveRejection(tx, ctx, req, p.deciderEmploymentId, { step: current.stepIndex, kind: current.approverKind });
        return { status: 'rejected' as const };
      }
      const next = steps.find((s) => s.stepIndex > current.stepIndex && s.status === 'pending');
      if (next) {
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'leave-request',
          aggregateId: req.id,
          eventType: 'leave-request.step.approved',
          actor: actorOf(ctx),
          subjectEmploymentId: req.employmentId,
          payload: { step: current.stepIndex, kind: current.approverKind, nextKind: next.approverKind },
        });
        return { status: 'pending' as const, advancedTo: next.approverKind };
      }
      await finalizeLeaveApproval(tx, ctx, req, p.deciderEmploymentId);
      return { status: 'approved' as const };
    }

    // Single-step (no chain) — original behavior.
    await assertCanDecide(tx, ctx, req.employmentId, 'leave request');
    if (p.decision === 'approved') await finalizeLeaveApproval(tx, ctx, req, p.deciderEmploymentId);
    else await finalizeLeaveRejection(tx, ctx, req, p.deciderEmploymentId);
    return { status: p.decision };
  });
}

// ───────────────────── Leave-year boundary (STATUTORY-SOURCES §5) ─────────────────────

/** Types granted as standing yearly entitlements; situational types are claimed per event. */
export const STANDING_LEAVE_CODES = ['ANNUAL', 'SICK', 'HOSPITALIZATION'] as const;

/** Completed years of service at a date (calendar-accurate, not /365.25). */
export const serviceYearsAt = (hiredOn: string, asOf: string): number => {
  const h = new Date(`${hiredOn}T00:00:00Z`);
  const a = new Date(`${asOf}T00:00:00Z`);
  let y = a.getUTCFullYear() - h.getUTCFullYear();
  if (
    a.getUTCMonth() < h.getUTCMonth() ||
    (a.getUTCMonth() === h.getUTCMonth() && a.getUTCDate() < h.getUTCDate())
  ) {
    y -= 1;
  }
  return Math.max(0, y);
};

/**
 * Open a leave year: for every active employment hired before 1 Jan of `year`, post the
 * new year's accrual per standing type at the employee's CURRENT service band — so the
 * 2y/5y band upgrades happen here — resolved as max(statutory floor, company policy).
 *
 * Carry-forward: ANNUAL carries up to the policy's `carryForwardMax` (statutory default
 * 0 — s.60E expects leave taken within the year); the rest is forfeited via a negative
 * adjustment. SICK / HOSPITALIZATION are per-calendar-year entitlements and reset.
 *
 * Idempotent: a Jan-1 accrual for an (employment, type) pair marks that pair open — a
 * Jan-1 hire grant counts too, which is exactly right. Hires during `year` are skipped
 * entirely (their hire grant covers the year). Overdrawn balances are never "forfeited"
 * (the debt simply rolls and the new grant lands on top).
 */
export async function openLeaveYear(ctx: SessionContext, p: { year: number }) {
  return withTenant(ctx, async (tx) => {
    const yearStart = `${p.year}-01-01`;

    const types = await tx
      .select({ id: leaveType.id, code: leaveType.code })
      .from(leaveType)
      .where(and(inArray(leaveType.code, [...STANDING_LEAVE_CODES]), isNull(leaveType.archivedAt)));
    const emps = await tx
      .select({
        employmentId: employment.id,
        hiredOn: employment.hiredOn,
        country: company.country,
        gradeId: employment.gradeId,
      })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(
        and(
          lt(employment.hiredOn, yearStart),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, yearStart)),
        ),
      );
    if (types.length === 0 || emps.length === 0) return { granted: 0, skipped: 0, forfeits: 0 };
    const empIds = emps.map((e) => e.employmentId);
    const typeIds = types.map((t) => t.id);

    const already = await tx
      .select({ employmentId: leaveLedger.employmentId, leaveTypeId: leaveLedger.leaveTypeId })
      .from(leaveLedger)
      .where(
        and(
          inArray(leaveLedger.employmentId, empIds),
          inArray(leaveLedger.leaveTypeId, typeIds),
          eq(leaveLedger.entryType, 'accrual'),
          eq(leaveLedger.effectiveOn, yearStart),
        ),
      );
    const openedSet = new Set(already.map((r) => `${r.employmentId}|${r.leaveTypeId}`));

    // 2E (ADR-0041): active policies per type as of Jan 1, grouped so each employee resolves the policy
    // for their grade (resolveGradePolicy) — same resolution the hire grant uses.
    const policies = await tx
      .select({ leaveTypeId: leavePolicy.leaveTypeId, gradeId: leavePolicy.gradeId, accrual: leavePolicy.accrual })
      .from(leavePolicy)
      .where(
        and(
          inArray(leavePolicy.leaveTypeId, typeIds),
          lte(leavePolicy.validFrom, yearStart),
          or(isNull(leavePolicy.validTo), gt(leavePolicy.validTo, yearStart)),
        ),
      );
    const policyByType = new Map<string, GradePolicyRow[]>();
    for (const pol of policies) {
      const arr = policyByType.get(pol.leaveTypeId);
      if (arr) arr.push(pol);
      else policyByType.set(pol.leaveTypeId, [pol]);
    }

    const balances = await tx
      .select({
        employmentId: leaveLedger.employmentId,
        leaveTypeId: leaveLedger.leaveTypeId,
        balance: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
      })
      .from(leaveLedger)
      .where(and(inArray(leaveLedger.employmentId, empIds), inArray(leaveLedger.leaveTypeId, typeIds)))
      .groupBy(leaveLedger.employmentId, leaveLedger.leaveTypeId);
    const balanceBy = new Map(balances.map((b) => [`${b.employmentId}|${b.leaveTypeId}`, Number(b.balance)]));

    let granted = 0;
    let skipped = 0;
    let forfeits = 0;
    for (const e of emps) {
      const pack = packFor(e.country);
      if (!pack) continue;
      const years = serviceYearsAt(e.hiredOn, yearStart);
      for (const t of types) {
        const key = `${e.employmentId}|${t.id}`;
        if (openedSet.has(key)) {
          skipped += 1;
          continue;
        }
        const pol = resolveGradePolicy(policyByType.get(t.id) ?? [], e.gradeId);
        // 2D (ADR-0040): earned types accrue through the year via accrueEarnedLeave, not this lump grant.
        if (isEarnedMethod(pol?.method)) continue;
        const days = Math.max(pack.leave.entitlement(t.code, years), pol?.days ?? 0);
        if (days <= 0) continue;
        const before = balanceBy.get(key) ?? 0;
        const carryMax = t.code === 'ANNUAL' ? (pol?.carryMax ?? 0) : 0;
        const carry = Math.min(Math.max(before, 0), carryMax);
        const forfeit = Math.max(0, before - carry);
        if (forfeit > 0) {
          await tx.insert(leaveLedger).values({
            tenantId: ctx.tenantId,
            employmentId: e.employmentId,
            leaveTypeId: t.id,
            entryType: 'adjustment',
            days: (-forfeit).toFixed(2),
            effectiveOn: yearStart,
          });
          forfeits += 1;
        }
        await tx.insert(leaveLedger).values({
          tenantId: ctx.tenantId,
          employmentId: e.employmentId,
          leaveTypeId: t.id,
          entryType: 'accrual',
          days: days.toFixed(2),
          effectiveOn: yearStart,
        });
        granted += 1;
      }
    }

    // One summary event; the ledger rows are the per-item audit (high-volume per-item
    // writes with their own append-only table — deliberate substrate skip).
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-year',
      aggregateId: ctx.tenantId,
      eventType: 'leave-year.opened',
      actor: actorOf(ctx),
      payload: { year: p.year, granted, skipped, forfeits },
    });
    return { granted, skipped, forfeits };
  });
}

// ── Earned accrual (ADR-0040 / 2D-1) ──────────────────────────────────────────────────────────────
/** Lump-sum policies (the default) grant at hire + year-open; these earn through the year instead. */
export const EARNED_METHODS = ['earned_monthly', 'earned_quarterly'] as const;
export function isEarnedMethod(m: unknown): m is (typeof EARNED_METHODS)[number] {
  return m === 'earned_monthly' || m === 'earned_quarterly';
}
/** Accrual periods from `start` through `asOf`, inclusive of the current period (month or quarter). */
function accrualPeriods(start: string, asOf: string, method: string): number {
  const [sy, sm] = start.split('-').map(Number);
  const [ay, am] = asOf.split('-').map(Number);
  if (method === 'earned_quarterly') {
    return Math.max(0, (ay - sy) * 4 + (Math.floor((am - 1) / 3) - Math.floor((sm - 1) / 3)) + 1);
  }
  return Math.max(0, (ay - sy) * 12 + (am - sm) + 1);
}

/** ADR-0040 2D-2: the start of an employee's current earned-accrual cycle as of `asOf`.
 *  calendar → 1 Jan of asOf's year. anniversary → the most-recent hire-month anniversary on/before
 *  asOf (so each employee's cycle is anchored to their hire month; a joiner's first cycle starts at
 *  hire). Returns ISO yyyy-mm-01. */
export function earnedCycleStart(hiredOn: string, asOf: string, cycle: string | null | undefined): string {
  if (cycle !== 'anniversary') return `${asOf.slice(0, 4)}-01-01`;
  const hireMonth = hiredOn.slice(5, 7);
  const [ay, am] = asOf.split('-').map(Number);
  const cycleYear = am >= Number(hireMonth) ? ay : ay - 1;
  return `${cycleYear}-${hireMonth}-01`;
}

// ── Grade-based policy resolution (ADR-0041 / 2E) ─────────────────────────────────────────────────
export type GradePolicyRow = { gradeId: string | null; accrual: unknown };
export type ResolvedPolicy = { days: number; carryMax: number; method?: string };
/** Resolve the leave policy for an employee's grade among a type's active policies: the most-generous
 *  policy scoped to the employee's grade, else the most-generous null-grade (all-grades) policy, else
 *  null. With no grades assigned (employee + every policy null-grade) this is exactly the pre-2E
 *  "most generous active policy" pick, so existing behavior is unchanged. */
export function resolveGradePolicy(rows: GradePolicyRow[], employeeGradeId: string | null): ResolvedPolicy | null {
  const pick = (subset: GradePolicyRow[]): ResolvedPolicy | null => {
    let best: ResolvedPolicy | null = null;
    for (const r of subset) {
      const acc = r.accrual as { annualDays?: number; carryForwardMax?: number; method?: string } | null;
      const days = Number(acc?.annualDays ?? 0);
      if (!best || days > best.days) {
        best = { days, carryMax: Math.max(0, Number(acc?.carryForwardMax ?? 0)), method: acc?.method };
      }
    }
    return best;
  };
  const graded = employeeGradeId ? pick(rows.filter((r) => r.gradeId === employeeGradeId)) : null;
  return graded ?? pick(rows.filter((r) => r.gradeId == null));
}

/** ADR-0040: top every earned policy up to the amount accrued by `asOf`. Idempotent — only the
 *  shortfall is written — so it is safe to run repeatedly (admin button + monthly cron, 2D-2).
 *  The cycle is per company (`leave_cycle`): calendar (1 Jan, joiners pro-rate from their join month)
 *  or anniversary (each employee's cycle anchored to their hire-month anniversary). The full-cycle
 *  total equals max(EA-floor, policy days), so the statutory floor still holds. */
export async function accrueEarnedLeave(ctx: SessionContext, p: { asOf: string }) {
  return withTenant(ctx, async (tx) => {
    const yearStart = `${p.asOf.slice(0, 4)}-01-01`;
    const types = await tx
      .select({ id: leaveType.id, code: leaveType.code })
      .from(leaveType)
      .where(and(inArray(leaveType.code, [...STANDING_LEAVE_CODES]), isNull(leaveType.archivedAt)));
    const typeIds = types.map((t) => t.id);
    if (typeIds.length === 0) return { granted: 0, forfeits: 0 };

    const policies = await tx
      .select({ leaveTypeId: leavePolicy.leaveTypeId, gradeId: leavePolicy.gradeId, accrual: leavePolicy.accrual })
      .from(leavePolicy)
      .where(
        and(
          inArray(leavePolicy.leaveTypeId, typeIds),
          lte(leavePolicy.validFrom, p.asOf),
          or(isNull(leavePolicy.validTo), gt(leavePolicy.validTo, p.asOf)),
        ),
      );
    // 2E (ADR-0041): group active policies per type so each employee resolves the policy for their grade.
    // A type is "earned" if ANY of its active policies is earned — that tells us which ledger rows to read
    // for the already-accrued sum; the per-employee resolution below decides what actually accrues.
    const policyByType = new Map<string, GradePolicyRow[]>();
    for (const pol of policies) {
      const arr = policyByType.get(pol.leaveTypeId);
      if (arr) arr.push(pol);
      else policyByType.set(pol.leaveTypeId, [pol]);
    }
    const earnedTypeIds = [...policyByType.entries()]
      .filter(([, rows]) => rows.some((r) => isEarnedMethod((r.accrual as { method?: string } | null)?.method)))
      .map(([id]) => id);
    if (earnedTypeIds.length === 0) return { granted: 0, forfeits: 0 };

    const emps = await tx
      .select({
        employmentId: employment.id,
        hiredOn: employment.hiredOn,
        country: company.country,
        leaveCycle: company.leaveCycle,
        gradeId: employment.gradeId,
      })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(
        and(
          lte(employment.hiredOn, p.asOf),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, yearStart)),
        ),
      );
    if (emps.length === 0) return { granted: 0, forfeits: 0 };
    const empIds = emps.map((e) => e.employmentId);

    // 2D-2: the cycle start varies per employee (calendar = yearStart; anniversary = their hire-month
    // anniversary), so we can't sum "already accrued this cycle" in SQL with one bound. Fetch the
    // trailing ~12 months of accrual rows (covers any cycle start) and sum per employee in JS below.
    const accrualFrom = `${Number(p.asOf.slice(0, 4)) - 1}-${p.asOf.slice(5, 7)}-01`;
    const accrualRows = await tx
      .select({
        employmentId: leaveLedger.employmentId,
        leaveTypeId: leaveLedger.leaveTypeId,
        days: leaveLedger.days,
        effectiveOn: leaveLedger.effectiveOn,
      })
      .from(leaveLedger)
      .where(
        and(
          inArray(leaveLedger.employmentId, empIds),
          inArray(leaveLedger.leaveTypeId, earnedTypeIds),
          eq(leaveLedger.entryType, 'accrual'),
          gte(leaveLedger.effectiveOn, accrualFrom),
        ),
      );
    const accrualRowsBy = new Map<string, { days: number; effectiveOn: string }[]>();
    for (const r of accrualRows) {
      const k = `${r.employmentId}|${r.leaveTypeId}`;
      const row = { days: Number(r.days), effectiveOn: r.effectiveOn };
      const arr = accrualRowsBy.get(k);
      if (arr) arr.push(row);
      else accrualRowsBy.set(k, [row]);
    }

    // 2D-3 (ADR-0040): cap carried-forward earned leave at the cycle boundary. openLeaveYear skips earned
    // types, so this is where their carry-forward cap lands. Group employees by their cycle start (≤12
    // distinct month-starts for anniversary, 1 for calendar) so the prior-cycle balance + the "already
    // forfeited this cycle" guard stay bounded queries, not one-per-employee.
    const byCycleStart = new Map<string, string[]>();
    for (const e of emps) {
      const cs = earnedCycleStart(e.hiredOn, p.asOf, e.leaveCycle);
      const arr = byCycleStart.get(cs);
      if (arr) arr.push(e.employmentId);
      else byCycleStart.set(cs, [e.employmentId]);
    }
    const priorBalanceBy = new Map<string, number>(); // emp|type -> balance carried into the current cycle
    const forfeited = new Set<string>(); // emp|type that already has a boundary forfeit at its cycle start
    for (const [cs, ids] of byCycleStart) {
      const prior = await tx
        .select({
          employmentId: leaveLedger.employmentId,
          leaveTypeId: leaveLedger.leaveTypeId,
          sum: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
        })
        .from(leaveLedger)
        .where(
          and(
            inArray(leaveLedger.employmentId, ids),
            inArray(leaveLedger.leaveTypeId, earnedTypeIds),
            lt(leaveLedger.effectiveOn, cs),
          ),
        )
        .groupBy(leaveLedger.employmentId, leaveLedger.leaveTypeId);
      for (const r of prior) priorBalanceBy.set(`${r.employmentId}|${r.leaveTypeId}`, Number(r.sum));
      // A boundary forfeit is an adjustment dated exactly at the cycle start; its presence means we've
      // already rolled this (emp, type) over (idempotency — also skips if a manual adjustment lands there).
      const adj = await tx
        .select({ employmentId: leaveLedger.employmentId, leaveTypeId: leaveLedger.leaveTypeId })
        .from(leaveLedger)
        .where(
          and(
            inArray(leaveLedger.employmentId, ids),
            inArray(leaveLedger.leaveTypeId, earnedTypeIds),
            eq(leaveLedger.entryType, 'adjustment'),
            eq(leaveLedger.effectiveOn, cs),
          ),
        );
      for (const r of adj) forfeited.add(`${r.employmentId}|${r.leaveTypeId}`);
    }

    let granted = 0;
    let forfeits = 0;
    for (const e of emps) {
      const pack = packFor(e.country);
      if (!pack) continue;
      // 2D-2: the cycle start anchors both the entitlement band (service years measured at it) and the
      // accrual window. Calendar joiners still pro-rate from their join month; anniversary employees
      // accrue from their own cycle start (which, for a joiner, is their hire month).
      const cycleStart = earnedCycleStart(e.hiredOn, p.asOf, e.leaveCycle);
      const years = serviceYearsAt(e.hiredOn, cycleStart);
      for (const typeId of earnedTypeIds) {
        // 2E: this employee's grade may resolve to a lump (or no) policy even when the type is earned for
        // another grade — accrue only when THEIR resolved policy is earned.
        const pol = resolveGradePolicy(policyByType.get(typeId) ?? [], e.gradeId);
        if (!isEarnedMethod(pol?.method)) continue;
        const type = types.find((t) => t.id === typeId);
        if (!type) continue;
        // 2D-3: cap what carries into the new cycle. ANNUAL carries up to its policy cap; other earned
        // types reset (cap 0). Posted once per cycle, dated at the cycle start (guarded by `forfeited`).
        const carryKey = `${e.employmentId}|${typeId}`;
        if (!forfeited.has(carryKey)) {
          const priorBalance = priorBalanceBy.get(carryKey) ?? 0;
          const cap = type.code === 'ANNUAL' ? pol!.carryMax : 0;
          const carry = Math.min(Math.max(priorBalance, 0), cap);
          const forfeit = Math.round((priorBalance - carry) * 100) / 100;
          if (forfeit > 0) {
            await tx.insert(leaveLedger).values({
              tenantId: ctx.tenantId,
              employmentId: e.employmentId,
              leaveTypeId: typeId,
              entryType: 'adjustment',
              days: (-forfeit).toFixed(2),
              effectiveOn: cycleStart,
            });
            forfeited.add(carryKey);
            forfeits += 1;
          }
        }
        const entitlement = Math.max(pack.leave.entitlement(type.code, years), pol!.days);
        if (entitlement <= 0) continue;
        const totalPeriods = pol!.method === 'earned_quarterly' ? 4 : 12;
        const accrualStart =
          e.leaveCycle === 'anniversary' || e.hiredOn <= cycleStart ? cycleStart : `${e.hiredOn.slice(0, 7)}-01`;
        const elapsed = Math.min(totalPeriods, accrualPeriods(accrualStart, p.asOf, pol!.method!));
        const earnedToDate = Math.round((entitlement / totalPeriods) * elapsed * 100) / 100;
        const rows = accrualRowsBy.get(`${e.employmentId}|${typeId}`) ?? [];
        const already = rows.reduce((s, r) => (r.effectiveOn >= cycleStart ? s + r.days : s), 0);
        const toGrant = Math.round((earnedToDate - already) * 100) / 100;
        if (toGrant > 0) {
          await tx.insert(leaveLedger).values({
            tenantId: ctx.tenantId,
            employmentId: e.employmentId,
            leaveTypeId: typeId,
            entryType: 'accrual',
            days: toGrant.toFixed(2),
            effectiveOn: p.asOf,
          });
          granted += 1;
        }
      }
    }
    // One summary event; ledger rows are the per-item audit (deliberate skip, as openLeaveYear).
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-year',
      aggregateId: ctx.tenantId,
      eventType: 'leave.earned-accrual.run',
      actor: actorOf(ctx),
      payload: { asOf: p.asOf, granted, forfeits },
    });
    return { granted, forfeits };
  });
}
