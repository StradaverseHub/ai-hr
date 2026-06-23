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
      .select({ employmentId: employment.id, hiredOn: employment.hiredOn, country: company.country })
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

    // Most generous active policy per type as of Jan 1 — same resolution as the hire grant.
    const policies = await tx
      .select({ leaveTypeId: leavePolicy.leaveTypeId, accrual: leavePolicy.accrual })
      .from(leavePolicy)
      .where(
        and(
          inArray(leavePolicy.leaveTypeId, typeIds),
          lte(leavePolicy.validFrom, yearStart),
          or(isNull(leavePolicy.validTo), gt(leavePolicy.validTo, yearStart)),
        ),
      );
    const policyBy = new Map<string, { days: number; carryMax: number }>();
    for (const pol of policies) {
      const acc = pol.accrual as { annualDays?: number; carryForwardMax?: number } | null;
      const d = Number(acc?.annualDays ?? 0);
      const prev = policyBy.get(pol.leaveTypeId);
      if (!prev || d > prev.days) {
        policyBy.set(pol.leaveTypeId, { days: d, carryMax: Math.max(0, Number(acc?.carryForwardMax ?? 0)) });
      }
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
        const pol = policyBy.get(t.id);
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
