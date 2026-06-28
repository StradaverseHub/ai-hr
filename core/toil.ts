/**
 * Leave-in-lieu (TOIL) — ADR-0033. A contractual replacement-leave engine: elected+approved rest-day /
 * holiday / OT work becomes a REPLACEMENT-type leave credit, mutually exclusive with OT pay. Gated by
 * TOIL_ENABLED (off ⇒ every entry point refuses, nothing reads the tables). The statutory boundary is
 * welded in: a First-Schedule-eligible (≤ wage ceiling) employee can only accrue TOIL when the company
 * policy's allowFirstScheduleEligible toggle is on, and then only with a compliance warning + the intent
 * to convert unused TOIL to pay on expiry (never lapse). The same worked day is cash XOR TOIL — the OT-pay
 * prefill (core/payroll.ts) excludes any day with a non-lapsed accrual.
 */
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { assertCanDecide } from './approvals';
import { earnedCycleStart } from './leave';
import {
  attendance,
  company,
  compensation,
  domainEvent,
  employment,
  leaveLedger,
  leaveType,
  toilAccrual,
  toilPolicy,
  type ToilAccrualBasis,
  type ToilAccrualStatus,
  type ToilExpiryAction,
} from '../db/schema';
import { packFor } from '../localization/registry';

export class ToilDisabledError extends Error {
  constructor(msg = 'Time off in lieu is not enabled.') {
    super(msg);
    this.name = 'ToilDisabledError';
  }
}
export class ToilNotEligibleError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ToilNotEligibleError';
  }
}
/**
 * Phase-B #14: a First-Schedule (≤ ceiling) election was refused because explicit per-election consent was not
 * supplied (the company toggle alone must not be a blanket default). Extends `ToilNotEligibleError` so existing
 * not-eligible handling (auto-accrual swallowing, the elect-button surface) still treats it correctly, while the
 * roster action can detect it specifically and prompt the user to record the employee's agreement.
 */
export class ToilFirstScheduleConsentRequiredError extends ToilNotEligibleError {
  constructor(
    msg = 'This employee is within the First Schedule (statutory overtime pay applies). Banking time in lieu instead of the statutory cash premium requires the employee’s explicit prior agreement; record per-election consent to proceed.',
  ) {
    super(msg);
    this.name = 'ToilFirstScheduleConsentRequiredError';
  }
}
export class ToilNoOvertimeError extends Error {
  constructor(msg = 'No overtime was recorded for that day to bank in lieu.') {
    super(msg);
    this.name = 'ToilNoOvertimeError';
  }
}
export class ToilAlreadyAccruedError extends Error {
  constructor(msg = 'Time in lieu has already been banked for that day.') {
    super(msg);
    this.name = 'ToilAlreadyAccruedError';
  }
}

const STD_DAY_MINUTES = 480; // 8h — the ORP/standard-day convention (wages / 26 / 8) used across payroll
const round2 = (n: number) => Math.round(n * 100) / 100;
const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// premium_equivalent banks the worked time uplifted by the day-type OT multiplier (itself contractual for
// TOIL; the exact EA ½/1-day rest-day rule governs cash pay, not in-lieu banking).
const PREMIUM_MULT: Record<'workday' | 'rest_day' | 'holiday', number> = { workday: 1.5, rest_day: 2, holiday: 3 };

const toilEnabled = () => process.env.TOIL_ENABLED === 'true';

/** Idempotent: the tenant's REPLACEMENT leave type (created on first need; paid, working-day counted). */
async function ensureReplacementLeaveType(tx: Tx, tenantId: string): Promise<string> {
  const find = () =>
    tx
      .select({ id: leaveType.id })
      .from(leaveType)
      .where(and(eq(leaveType.tenantId, tenantId), sql`lower(${leaveType.code}) = 'replacement'`, isNull(leaveType.archivedAt)))
      .limit(1);
  const [existing] = await find();
  if (existing) return existing.id;
  const [created] = await tx
    .insert(leaveType)
    .values({ tenantId, code: 'REPLACEMENT', name: 'Replacement Leave (in lieu)', paid: true, counting: 'working_days' })
    .onConflictDoNothing()
    .returning({ id: leaveType.id });
  if (created) return created.id;
  const [again] = await find(); // lost an insert race — re-read
  return again.id;
}

// ─── policy ────────────────────────────────────────────────────────────────────────────────────────
export type ToilPolicyInput = {
  companyId: string;
  enabled: boolean;
  accrualBasis: ToilAccrualBasis;
  expiryDays: number;
  onExpiry: ToilExpiryAction;
  allowFirstScheduleEligible: boolean;
  // RL Control Engine (0113): opt-in (default false) — approving a rest-day/holiday attendance correction
  // auto-banks the RL credit (no manual roster election). Triggered ONLY by decideAttendanceCorrection.
  autoAccrueOnApproval: boolean;
  // RL Control Engine (0113): opt-in (default false) — an accrual survives the year-end close sweep instead
  // of being expired. FROZEN onto each accrual at accrual time so a mid-year flip cannot change a banked
  // entitlement's fate.
  carryForwardAtYearEnd: boolean;
};

/** Upsert one company's TOIL policy (admin-gated by RLS). Enabling ensures the REPLACEMENT leave type. */
export async function setToilPolicy(ctx: SessionContext, p: ToilPolicyInput) {
  if (!Number.isInteger(p.expiryDays) || p.expiryDays < 1 || p.expiryDays > 730)
    throw new Error('Expiry days must be a whole number between 1 and 730.');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(toilPolicy)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        enabled: p.enabled,
        accrualBasis: p.accrualBasis,
        expiryDays: p.expiryDays,
        onExpiry: p.onExpiry,
        allowFirstScheduleEligible: p.allowFirstScheduleEligible,
        autoAccrueOnApproval: p.autoAccrueOnApproval,
        carryForwardAtYearEnd: p.carryForwardAtYearEnd,
      })
      .onConflictDoUpdate({
        target: toilPolicy.companyId,
        set: {
          enabled: p.enabled,
          accrualBasis: p.accrualBasis,
          expiryDays: p.expiryDays,
          onExpiry: p.onExpiry,
          allowFirstScheduleEligible: p.allowFirstScheduleEligible,
          // 0113: new columns MUST be in the update set too, or an upsert silently drops them.
          autoAccrueOnApproval: p.autoAccrueOnApproval,
          carryForwardAtYearEnd: p.carryForwardAtYearEnd,
        },
      })
      .returning({ id: toilPolicy.id });
    if (p.enabled) await ensureReplacementLeaveType(tx, ctx.tenantId);
    // Phase-B #14: premium_equivalent banking combined with allowing First-Schedule staff can over/under-bank
    // vs the exact s.60(3) split-rule cash — surface a warning at policy save so the risk is visible (the
    // convert-to-pay path still reconciles to the exact statutory entitlement; this flags the banking choice).
    const premiumEquivalentWarning =
      p.accrualBasis === 'premium_equivalent' && p.allowFirstScheduleEligible ? PREMIUM_EQUIVALENT_FS_WARNING : undefined;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'toil-policy',
      aggregateId: row.id,
      eventType: 'toil-policy.updated',
      actor: actorOf(ctx),
      payload: { ...p, ...(premiumEquivalentWarning ? { premiumEquivalentWarning: true } : {}) },
    });
    return { ...row, premiumEquivalentWarning };
  });
}

export type ToilPolicyView = ToilPolicyInput & { isDefault: boolean };
const POLICY_DEFAULTS = {
  enabled: false,
  accrualBasis: 'hours_worked' as ToilAccrualBasis,
  expiryDays: 90,
  onExpiry: 'convert_to_pay' as ToilExpiryAction,
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
};

/** Each requested company's TOIL policy, falling back to the (disabled) defaults where none is saved. */
export function listToilPolicies(ctx: SessionContext, companyIds: string[]): Promise<ToilPolicyView[]> {
  return withTenant(ctx, async (tx) => {
    if (companyIds.length === 0) return [];
    const rows = await tx.select().from(toilPolicy);
    const byCompany = new Map(rows.map((r) => [r.companyId, r]));
    return companyIds.map((companyId) => {
      const r = byCompany.get(companyId);
      return r
        ? {
            companyId,
            enabled: r.enabled,
            accrualBasis: r.accrualBasis,
            expiryDays: r.expiryDays,
            onExpiry: r.onExpiry,
            allowFirstScheduleEligible: r.allowFirstScheduleEligible,
            autoAccrueOnApproval: r.autoAccrueOnApproval,
            carryForwardAtYearEnd: r.carryForwardAtYearEnd,
            isDefault: false,
          }
        : { companyId, ...POLICY_DEFAULTS, isDefault: true };
    });
  });
}

// ─── accrual ───────────────────────────────────────────────────────────────────────────────────────
export type AccrueToilResult = {
  accrualId: string;
  daysCredited: number;
  expiresOn: string;
  /** true ⇒ a First-Schedule-eligible employee: unused TOIL must convert to pay on expiry (floor protection). */
  forcedConvertOnExpiry: boolean;
  complianceWarning?: string;
  /** Phase-B #14: set when premium_equivalent banking is used for a First-Schedule employee — the banked
   *  credit may not reproduce the exact s.60(3)/s.60D(3) statutory cash (over/under-banks vs the split-rule). */
  premiumEquivalentWarning?: string;
};

// Phase-B #14: the premium_equivalent basis uplifts the banked time by the day-type OT multiplier, which does
// NOT reproduce the EA s.60(3) ½/1-day split-rule cash. For a First-Schedule employee the banked credit can
// therefore diverge from the exact statutory entitlement — surface this so the risk is visible (the
// convert-to-pay path still reconciles to the exact statutory cash; this warns at the banking decision).
const PREMIUM_EQUIVALENT_FS_WARNING =
  'Premium-equivalent banking uplifts time by the day-type multiplier and may not reproduce the exact statutory cash (EA s.60(3)/s.60D(3)) for this First-Schedule employee. Unused credit converts to pay at the exact statutory entitlement on expiry.';

// RL Control Engine (0113): only work on a Rest Day or Public Holiday is eligible for replacement leave.
// A plain workday's OT is cash-only (PREMIUM_MULT carries a 'workday' key for the multiplier, but banking a
// workday is not permitted). This is the "only RL for Rest Day/PH; block if no eligible attendance" rule.
const RL_ELIGIBLE_DAY_TYPES: ReadonlySet<'rest_day' | 'holiday'> = new Set(['rest_day', 'holiday']);

/**
 * RL Control Engine (0113) · shared accrual executor (runs inside an open tx). Reads the day's `otMinutes`,
 * `dayType` and the company policy, applies the eligibility gates (no-attendance / no-OT / non-rest/PH day),
 * writes a `toil_accrual` row + a signed `leave_ledger` credit, freezes `expiryAction` and
 * `carryForwardAtYearEnd`, and appends `toil.accrued`. The OT-pay prefill excludes this day thereafter.
 *
 * `requireDecideAuth` controls the authorisation model:
 *  - true (manual election from the roster): runs `assertCanDecide` — manager/admin authority, self-grant ban.
 *  - false (auto path from an APPROVED attendance correction): does NOT run `assertCanDecide`. Authority is
 *    already established by the correction approver who passed `assertCanDecide` inside
 *    `decideAttendanceCorrection`; re-checking on the SYSTEM-less ctx would hard-throw on the manager.
 */
export async function accrueToilTx(
  tx: Tx,
  ctx: SessionContext,
  p: {
    employmentId: string;
    workedDate: string;
    requireDecideAuth: boolean;
    viaAutoApproval?: boolean;
    /** Phase-B #14: explicit per-election consent to substitute TOIL for the statutory cash OT premium. Only
     *  meaningful for a First-Schedule-eligible (≤ ceiling) employee — required (with the company toggle) before
     *  such an accrual is permitted; moot for > ceiling staff. */
    firstScheduleConsent?: boolean;
  },
): Promise<AccrueToilResult> {
  if (p.requireDecideAuth) await assertCanDecide(tx, ctx, p.employmentId, 'time off in lieu');

  // 1 · the worked day + its company/country (one attendance row per employee per day).
  const [att] = await tx
    .select({
      otMinutes: attendance.otMinutes,
      dayType: attendance.dayType,
      companyId: employment.companyId,
      country: company.country,
    })
    .from(attendance)
    .innerJoin(employment, eq(employment.id, attendance.employmentId))
    .innerJoin(company, eq(company.id, employment.companyId))
    .where(and(eq(attendance.employmentId, p.employmentId), eq(attendance.attendanceDate, p.workedDate)))
    .limit(1);
  // "block if no eligible attendance": no approved attendance row, or no OT recorded ⇒ nothing to bank.
  if (!att || !att.dayType || (att.otMinutes ?? 0) <= 0) throw new ToilNoOvertimeError();
  const otMinutes = att.otMinutes ?? 0;
  const dayType = att.dayType;

  // 1b · "only RL for Rest Day/PH": a plain workday's OT is cash-only, never banked.
  if (!RL_ELIGIBLE_DAY_TYPES.has(dayType as 'rest_day' | 'holiday')) {
    throw new ToilNotEligibleError('Replacement leave can only be banked for work on a rest day or public holiday.');
  }

  // 2 · the company policy must be enabled.
  const [policy] = await tx.select().from(toilPolicy).where(eq(toilPolicy.companyId, att.companyId)).limit(1);
  if (!policy || !policy.enabled) throw new ToilDisabledError('Time off in lieu is not enabled for this company.');

  // 3 · no double-banking (the unique index also guards; this is the friendly error).
  const [dupe] = await tx
    .select({ id: toilAccrual.id })
    .from(toilAccrual)
    .where(and(eq(toilAccrual.employmentId, p.employmentId), eq(toilAccrual.workedDate, p.workedDate)))
    .limit(1);
  if (dupe) throw new ToilAlreadyAccruedError();

  // 4 · First-Schedule eligibility gate. s.2 wages (basic + fixed allowance) vs the ceiling from the pack.
  const [comp] = await tx
    .select({ basic: compensation.basicSalary, allowance: compensation.monthlyAllowance })
    .from(compensation)
    .where(and(eq(compensation.employmentId, p.employmentId), isNull(compensation.validTo), isNull(compensation.supersededAt)))
    .limit(1);
  const wages = comp ? round2(Number(comp.basic) + Number(comp.allowance ?? 0)) : null;
  const pack = packFor(att.country);
  const ceiling = pack ? (await pack.payroll.loadRuleset(tx, { asOf: p.workedDate })).ot.wageCeiling : 4000;
  const eligible = wages != null && wages <= ceiling; // First-Schedule: statutory OT pay normally applies
  if (eligible && !policy.allowFirstScheduleEligible) {
    throw new ToilNotEligibleError(
      'Statutory overtime pay applies to this employee (within the First Schedule), so time in lieu is not permitted under the current policy. Enable "allow First-Schedule staff" on the company TOIL policy to override.',
    );
  }
  // Phase-B #14 (safer default): the company toggle alone must NOT be a blanket default. Substituting TOIL for
  // a First-Schedule employee's statutory cash OT (EA s.60(3)/s.60A/s.60D(3)) is lawful only by explicit prior
  // agreement, so an eligible accrual also requires per-election consent — even with the toggle ON.
  if (eligible && policy.allowFirstScheduleEligible && p.firstScheduleConsent !== true) {
    throw new ToilFirstScheduleConsentRequiredError();
  }

  // 5 · days credited + expiry.
  const mult = policy.accrualBasis === 'premium_equivalent' ? PREMIUM_MULT[dayType] : 1;
  const daysCredited = round2((otMinutes / STD_DAY_MINUTES) * mult);
  const expiresOn = addDays(p.workedDate, policy.expiryDays);
  // Phase-B #14: premium_equivalent banking for a First-Schedule employee can over/under-bank vs the exact
  // s.60(3) split-rule cash — flag the risk (the convert-to-pay path still reconciles to the exact statutory
  // entitlement; this surfaces the divergence at the banking decision).
  const premiumEquivalentWarning = eligible && policy.accrualBasis === 'premium_equivalent';

  // 6 · the leave-ledger credit (balance = Σ days, so this just works) + the register row.
  const replacementTypeId = await ensureReplacementLeaveType(tx, ctx.tenantId);
  const [ledger] = await tx
    .insert(leaveLedger)
    .values({
      tenantId: ctx.tenantId,
      employmentId: p.employmentId,
      leaveTypeId: replacementTypeId,
      entryType: 'in_lieu_accrual',
      days: daysCredited.toFixed(2),
      effectiveOn: p.workedDate,
    })
    .returning({ id: leaveLedger.id });
  const [acc] = await tx
    .insert(toilAccrual)
    .values({
      tenantId: ctx.tenantId,
      employmentId: p.employmentId,
      workedDate: p.workedDate,
      dayType,
      otMinutes,
      daysCredited: daysCredited.toFixed(2),
      accrualBasis: policy.accrualBasis,
      expiresOn,
      status: 'active',
      // Floor protection: an eligible employee's unused TOIL always converts to pay, never lapses.
      expiryAction: eligible ? 'convert_to_pay' : policy.onExpiry,
      // 0113: freeze the carry-forward decision at accrual time (mirrors expiryAction). The year-end close
      // sweep reads this per-accrual flag, so a later policy flip cannot retroactively change its fate.
      carryForwardAtYearEnd: policy.carryForwardAtYearEnd,
      // Phase-B #14: record the explicit per-election consent for a First-Schedule election (true only when
      // eligible — moot/NULL for > ceiling staff who need no statutory-floor substitution agreement).
      firstScheduleConsent: eligible ? true : null,
      policyId: policy.id,
      ledgerEntryId: ledger.id,
    })
    .returning({ id: toilAccrual.id });

  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'toil-accrual',
    aggregateId: acc.id,
    eventType: 'toil.accrued',
    actor: actorOf(ctx),
    subjectEmploymentId: p.employmentId,
    payload: {
      workedDate: p.workedDate,
      dayType,
      otMinutes,
      daysCredited,
      accrualBasis: policy.accrualBasis,
      eligible,
      forcedConvertOnExpiry: eligible,
      expiresOn,
      carryForwardAtYearEnd: policy.carryForwardAtYearEnd,
      // Phase-B #14: stamp the consent + premium-equivalent-risk flags onto the audit record.
      ...(eligible ? { firstScheduleConsent: true } : {}),
      ...(premiumEquivalentWarning ? { premiumEquivalentWarning: true } : {}),
      ...(p.viaAutoApproval ? { viaAutoApproval: true } : {}),
    },
  });

  return {
    accrualId: acc.id,
    daysCredited,
    expiresOn,
    forcedConvertOnExpiry: eligible,
    complianceWarning: eligible
      ? 'This employee is within the First Schedule (statutory overtime pay normally applies). Unused time in lieu will convert to pay on expiry, not lapse.'
      : undefined,
    premiumEquivalentWarning: premiumEquivalentWarning ? PREMIUM_EQUIVALENT_FS_WARNING : undefined,
  };
}

/**
 * Bank time in lieu for one worked day (an elected, approved grant — `assertCanDecide` enforces manager/admin
 * authority and bans self-grant). Thin wrapper over `accrueToilTx` for the manual roster-election path.
 */
export async function accrueToil(
  ctx: SessionContext,
  p: { employmentId: string; workedDate: string; firstScheduleConsent?: boolean },
): Promise<AccrueToilResult> {
  if (!toilEnabled()) throw new ToilDisabledError();
  return withTenant(ctx, (tx) => accrueToilTx(tx, ctx, { ...p, requireDecideAuth: true }));
}

/**
 * RL Control Engine (0113) · auto-accrual on attendance approval. Called from `decideAttendanceCorrection`
 * inside the same tx when a rest-day/holiday correction is approved and the company opted in
 * (`autoAccrueOnApproval`). Authority is already established by the correction approver, so `requireDecideAuth`
 * is false. Eligibility refusals are swallowed (never block the approval); a hard error still propagates.
 * Returns whether a credit was minted. No-op (returns false) when TOIL is gated off.
 */
export async function maybeAutoAccrueOnApprovalTx(
  tx: Tx,
  ctx: SessionContext,
  p: { employmentId: string; workedDate: string; dayType: string | null },
): Promise<boolean> {
  if (!toilEnabled()) return false;
  // Cheap pre-checks before any work: must be a rest-day/holiday correction.
  if (!p.dayType || !RL_ELIGIBLE_DAY_TYPES.has(p.dayType as 'rest_day' | 'holiday')) return false;
  // Resolve the company policy gate (enabled + opted-in). RLS already scopes the row to this tenant.
  const [att] = await tx
    .select({ companyId: employment.companyId })
    .from(employment)
    .where(eq(employment.id, p.employmentId))
    .limit(1);
  if (!att) return false;
  const [policy] = await tx.select().from(toilPolicy).where(eq(toilPolicy.companyId, att.companyId)).limit(1);
  if (!policy || !policy.enabled || !policy.autoAccrueOnApproval) return false;
  try {
    await accrueToilTx(tx, ctx, { employmentId: p.employmentId, workedDate: p.workedDate, requireDecideAuth: false, viaAutoApproval: true });
    return true;
  } catch (e) {
    // Swallow the expected eligibility/duplicate refusals so auto-accrual never blocks an approval; rethrow
    // anything unexpected (a real failure should not be silently lost).
    if (
      e instanceof ToilNotEligibleError ||
      e instanceof ToilAlreadyAccruedError ||
      e instanceof ToilNoOvertimeError ||
      e instanceof ToilDisabledError
    ) {
      return false;
    }
    throw e;
  }
}

// ─── consumption → register (RL Control Engine, 0113) ────────────────────────────────────────────────
export type ConsumeReplacementResult = {
  /** days actually allocated against active accrual rows (≤ need; a shortfall logs an event, not a throw). */
  allocated: number;
  /** accruals that flipped fully to 'taken'. */
  fullyConsumed: number;
  /** the boundary accrual that took a partial debit and stayed active (at most one). */
  partiallyConsumed: number;
  /** need − allocated when there were not enough active accrual rows to cover the consumed days. */
  shortfall: number;
};

/**
 * RL Control Engine (0113) · decrement `toil_accrual` when a REPLACEMENT leave request is approved. Allocates
 * the consumed `need` days against `status='active'` rows FIFO by `expiresOn` then `workedDate`, summing
 * `daysCredited − daysTaken` until covered. Fully-consumed accruals flip to `'taken'` (and record
 * `takenByRequestId`); the boundary accrual stays `active` with its `daysTaken` incremented so the active
 * bucket nets correctly. This makes the register the authoritative active/expired source (the leave_ledger
 * debit is posted by the caller; this only updates the register). A shortfall (positive ledger balance but no
 * active rows to cover it — a legacy/ghost credit) allocates what exists and logs `toil.consumption.shortfall`
 * rather than throwing — the caller's ledger balance check already gated the request.
 */
export async function consumeReplacementLeaveTx(
  tx: Tx,
  ctx: SessionContext,
  p: { employmentId: string; requestId: string; need: number; effectiveOn: string },
): Promise<ConsumeReplacementResult> {
  let remaining = round2(p.need);
  let allocated = 0;
  let fullyConsumed = 0;
  let partiallyConsumed = 0;
  if (remaining <= 0) return { allocated: 0, fullyConsumed: 0, partiallyConsumed: 0, shortfall: 0 };

  const active = await tx
    .select({
      id: toilAccrual.id,
      daysCredited: toilAccrual.daysCredited,
      daysTaken: toilAccrual.daysTaken,
      workedDate: toilAccrual.workedDate,
      expiresOn: toilAccrual.expiresOn,
    })
    .from(toilAccrual)
    .where(and(eq(toilAccrual.employmentId, p.employmentId), eq(toilAccrual.status, 'active')))
    .orderBy(asc(toilAccrual.expiresOn), asc(toilAccrual.workedDate));

  for (const a of active) {
    if (remaining <= 0) break;
    const credited = Number(a.daysCredited);
    const alreadyTaken = Number(a.daysTaken);
    const free = round2(credited - alreadyTaken);
    if (free <= 0) continue;
    const take = round2(Math.min(free, remaining));
    const newTaken = round2(alreadyTaken + take);
    const fully = newTaken >= credited - 1e-9; // float-safe: this accrual is now fully consumed
    await tx
      .update(toilAccrual)
      .set({
        daysTaken: newTaken.toFixed(2),
        ...(fully ? { status: 'taken' as ToilAccrualStatus, takenByRequestId: p.requestId } : {}),
      })
      .where(eq(toilAccrual.id, a.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'toil-accrual',
      aggregateId: a.id,
      eventType: 'toil.consumed',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { requestId: p.requestId, daysConsumed: take, daysTaken: newTaken, fullyConsumed: fully, workedDate: a.workedDate, effectiveOn: p.effectiveOn },
    });
    allocated = round2(allocated + take);
    remaining = round2(remaining - take);
    if (fully) fullyConsumed += 1;
    else partiallyConsumed += 1;
  }

  const shortfall = round2(Math.max(0, remaining));
  if (shortfall > 0) {
    // A positive REPLACEMENT ledger balance with no active accrual to back it (legacy/ghost credit). The
    // ledger debit already covered the leave; we only flag the register bookkeeping gap, never throw.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'toil-accrual',
      aggregateId: p.requestId,
      eventType: 'toil.consumption.shortfall',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { requestId: p.requestId, need: p.need, allocated, shortfall, effectiveOn: p.effectiveOn },
    });
  }
  return { allocated, fullyConsumed, partiallyConsumed, shortfall };
}

// ─── expiry sweep (ADR-0033 33-4) ────────────────────────────────────────────────────────────────────
const ORP_DIVISOR = 26; // EA-1955 ordinary rate of pay: monthly wages / 26 per day

export type ToilExpiryResult = {
  processed: number;
  converted: number;
  lapsed: number;
  convertedDays: number;
  convertedAmount: number;
};

/** One accrual to sweep. `remaining` = daysCredited − daysTaken (only the still-unspent in-lieu days).
 *  Phase-B #14 adds the worked-day shape (`dayType`, `otMinutes`) so a First-Schedule convert-to-pay can
 *  reconcile to the EXACT s.60(3)/s.60D(3) cash for that day-type rather than a generic ORP × banked-days. */
type SweepRow = {
  id: string;
  employmentId: string;
  remaining: number;
  expiryAction: ToilExpiryAction;
  workedDate: string;
  dayType: 'workday' | 'rest_day' | 'holiday';
  otMinutes: number;
};

/**
 * RL Control Engine (0113) · shared sweep executor. For each row: debit the replacement-leave credit by the
 * REMAINING `daysCredited − daysTaken` (never the already-consumed portion — those days flipped to 'taken' on
 * consumption and must not be re-debited), follow the FROZEN `expiryAction` (convert_to_pay records the owed
 * ORP as an event with NO auto-disbursement; lapse forfeits), set the terminal status, and append
 * `toil.converted`/`toil.lapsed`. ORP is valued from CURRENT wages with `asOf` noted on the payload (the admin
 * reconciles to the correct period at pay time — no silent contemporaneous-wage assumption). Shared by
 * `runToilExpiry` (natural expiry) and `closeReplacementLeaveYear` (year-end forfeit); only the SELECT differs.
 */
async function expireAccrualsTx(
  tx: Tx,
  ctx: SessionContext,
  rows: SweepRow[],
  asOf: string,
): Promise<ToilExpiryResult> {
  if (rows.length === 0) return { processed: 0, converted: 0, lapsed: 0, convertedDays: 0, convertedAmount: 0 };

  // Current s.2 wages for the employees whose TOIL converts to pay (ORP = wages / 26 per day).
  const convertEmpIds = [...new Set(rows.filter((d) => d.expiryAction === 'convert_to_pay').map((d) => d.employmentId))];
  const wagesBy = new Map<string, number>();
  // Phase-B #14: the employee's company/country so a First-Schedule (≤ ceiling) convert can reconcile to the
  // exact s.60(3)/s.60D(3) cash for the worked day-type via the localization OT math (not a generic ORP×days).
  const countryBy = new Map<string, string | null>();
  if (convertEmpIds.length) {
    const comps = await tx
      .select({
        employmentId: compensation.employmentId,
        basic: compensation.basicSalary,
        allowance: compensation.monthlyAllowance,
        country: company.country,
      })
      .from(compensation)
      .innerJoin(employment, eq(employment.id, compensation.employmentId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(and(inArray(compensation.employmentId, convertEmpIds), isNull(compensation.validTo), isNull(compensation.supersededAt)));
    for (const c of comps) {
      wagesBy.set(c.employmentId, round2(Number(c.basic) + Number(c.allowance ?? 0)));
      countryBy.set(c.employmentId, c.country);
    }
  }
  const replacementTypeId = await ensureReplacementLeaveType(tx, ctx.tenantId);

  // Phase-B #14: resolve the wage ceiling per distinct country once (the OT-eligibility threshold). The exact
  // statutory entitlement only governs a First-Schedule employee (wages ≤ ceiling); above it, OT comp is
  // contractual and the generic ORP × banked-days basis is kept unchanged.
  const ceilingByCountry = new Map<string | null, number>();
  for (const country of new Set(countryBy.values())) {
    const pack = packFor(country);
    const ceiling = pack ? (await pack.payroll.loadRuleset(tx, { asOf })).ot.wageCeiling : 4000;
    ceilingByCountry.set(country, ceiling);
  }

  /**
   * The cash a convert-to-pay row owes. For a First-Schedule employee (wages ≤ ceiling) this is the EXACT
   * s.60(3)/s.60D(3) statutory entitlement for the original worked day-type — reusing the localization
   * `overtimePay` math — NOT the generic `daysCredited × ORP` (which over/under-pays under premium_equivalent
   * banking). Above the ceiling (no statutory floor), the generic ORP × banked-days basis is preserved.
   * Returns the amount + which basis was used (recorded on the event for auditability).
   */
  const convertAmountFor = (a: SweepRow): { amount: number; basis: 'statutory_exact' | 'generic_orp' } => {
    const wages = wagesBy.get(a.employmentId) ?? 0;
    const country = countryBy.get(a.employmentId) ?? null;
    const ceiling = ceilingByCountry.get(country) ?? 4000;
    const pack = packFor(country);
    if (pack && wages > 0 && wages <= ceiling) {
      // Exact statutory cash for the worked day-type (s.60(3) rest day, s.60D(3) holiday, s.60A workday OT).
      const otp = pack.payroll.overtimePay({ monthlyWages: wages, days: [{ dayType: a.dayType, minutes: a.otMinutes }], wageCeiling: ceiling });
      if (otp.eligible) return { amount: round2(otp.total), basis: 'statutory_exact' };
    }
    // Not First-Schedule (or no pack): contractual ORP × remaining banked days.
    return { amount: round2(a.remaining * (wages / ORP_DIVISOR)), basis: 'generic_orp' };
  };

  let converted = 0;
  let lapsed = 0;
  let convertedDays = 0;
  let convertedAmount = 0;
  for (const a of rows) {
    const days = round2(a.remaining);
    if (days <= 0) continue; // nothing left to forfeit (fully consumed already) — defensive, SELECT filters it
    const convert = a.expiryAction === 'convert_to_pay';
    // Debit the replacement-leave credit either way — the unused in-lieu day is gone (paid out or forfeited).
    await tx.insert(leaveLedger).values({
      tenantId: ctx.tenantId,
      employmentId: a.employmentId,
      leaveTypeId: replacementTypeId,
      entryType: 'debit',
      days: (-days).toFixed(2),
      effectiveOn: asOf,
    });
    // Phase-B #14: exact s.60(3)/s.60D(3) cash for a First-Schedule employee (statutory_exact); generic
    // ORP × banked-days for > ceiling staff (generic_orp). Basis is recorded on the event for auditability.
    const owed = convert ? convertAmountFor(a) : { amount: 0, basis: 'generic_orp' as const };
    const amount = owed.amount;
    await tx.update(toilAccrual).set({ status: convert ? 'converted_to_pay' : 'lapsed' }).where(eq(toilAccrual.id, a.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'toil-accrual',
      aggregateId: a.id,
      eventType: convert ? 'toil.converted' : 'toil.lapsed',
      actor: actorOf(ctx),
      subjectEmploymentId: a.employmentId,
      payload: {
        workedDate: a.workedDate,
        daysCredited: days,
        asOf,
        ...(convert
          ? {
              amountOwed: amount,
              orpDivisor: ORP_DIVISOR,
              // Phase-B #14: 'statutory_exact' ⇒ reconciled to the exact EA s.60(3)/s.60D(3) cash for the
              // worked day-type (First Schedule); 'generic_orp' ⇒ contractual ORP × banked days (> ceiling).
              valuationBasis: owed.basis,
              dayType: a.dayType,
              valuationNote:
                owed.basis === 'statutory_exact'
                  ? 'Exact s.60(3)/s.60D(3) cash for the worked day-type, valued at close-run wages; reconcile to the correct pay period.'
                  : 'ORP computed at close-run wages; reconcile to the correct pay period.',
            }
          : {}),
      },
    });
    if (convert) {
      converted += 1;
      convertedDays = round2(convertedDays + days);
      convertedAmount = round2(convertedAmount + amount);
    } else {
      lapsed += 1;
    }
  }
  return { processed: converted + lapsed, converted, lapsed, convertedDays, convertedAmount };
}

/**
 * Expire active TOIL accruals whose expiry date has arrived (gated). Each follows its FROZEN expiry_action via
 * `expireAccrualsTx`. Only the still-unspent remainder (`daysCredited − daysTaken`) is debited — consumed days
 * already flipped to 'taken' on consumption. Idempotent — only `status='active'` rows are touched, so
 * re-running is safe. `today` is injected for deterministic tests.
 */
export async function runToilExpiry(ctx: SessionContext, p: { today: string }): Promise<ToilExpiryResult> {
  if (!toilEnabled()) throw new ToilDisabledError();
  return withTenant(ctx, async (tx) => {
    const due = await tx
      .select({
        id: toilAccrual.id,
        employmentId: toilAccrual.employmentId,
        daysCredited: toilAccrual.daysCredited,
        daysTaken: toilAccrual.daysTaken,
        expiryAction: toilAccrual.expiryAction,
        workedDate: toilAccrual.workedDate,
        // Phase-B #14: the worked-day shape so a First-Schedule convert reconciles to the exact statutory cash.
        dayType: toilAccrual.dayType,
        otMinutes: toilAccrual.otMinutes,
      })
      .from(toilAccrual)
      .where(and(eq(toilAccrual.status, 'active'), lte(toilAccrual.expiresOn, p.today)));
    const rows: SweepRow[] = due.map((d) => ({
      id: d.id,
      employmentId: d.employmentId,
      remaining: round2(Number(d.daysCredited) - Number(d.daysTaken)),
      expiryAction: d.expiryAction,
      workedDate: d.workedDate,
      dayType: d.dayType as 'workday' | 'rest_day' | 'holiday',
      otMinutes: d.otMinutes,
    }));
    return expireAccrualsTx(tx, ctx, rows, p.today);
  });
}

// ─── year-end rollover (RL Control Engine, 0113) ─────────────────────────────────────────────────────
export type CloseReplacementYearResult = ToilExpiryResult & {
  /** true ⇒ this boundary was already closed (idempotent re-fire); nothing was swept. */
  alreadyClosed: boolean;
  /** accruals that survived because their frozen carryForwardAtYearEnd is true. */
  carriedForward: number;
};

/**
 * Year-end rollover for replacement leave (gated). Expire-unless-configured: each `status='active'` accrual
 * whose FROZEN `carryForwardAtYearEnd` is false is forfeited at the cycle boundary (via the shared
 * `expireAccrualsTx`, debiting only the unspent remainder and following the frozen expiryAction); accruals with
 * carry-forward true survive untouched. Kept OUT of `openLeaveYear` (REPLACEMENT is register-backed, matching
 * the earned-leave precedent), and MUST run before `openLeaveYear` for the same boundary.
 *
 * Boundary, not a calendar constant: `asOf` is the calendar close date (`${year}-12-31` for calendar tenants);
 * for `anniversary` leave-cycle tenants each employment's boundary is computed from `earnedCycleStart` so RL
 * expiry stays in sync with the rest of that employee's balance roll.
 *
 * Idempotency beyond "no active rows left": a `replacement-leave-year.closed` marker event per (boundary key)
 * makes a re-fire (or a race against `runToilExpiry`) a true no-op rather than incidentally safe.
 */
export async function closeReplacementLeaveYear(
  ctx: SessionContext,
  p: { asOf: string },
): Promise<CloseReplacementYearResult> {
  if (!toilEnabled()) throw new ToilDisabledError();
  return withTenant(ctx, async (tx) => {
    const empty: CloseReplacementYearResult = {
      processed: 0, converted: 0, lapsed: 0, convertedDays: 0, convertedAmount: 0, alreadyClosed: false, carriedForward: 0,
    };

    // Idempotency guard beyond "no active rows left": a prior close marker for this exact boundary ⇒ true
    // no-op (so a re-fire, or a race against runToilExpiry, is genuinely idempotent, not incidentally safe).
    const [marker] = await tx
      .select({ id: domainEvent.id })
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.tenantId, ctx.tenantId),
          eq(domainEvent.eventType, 'replacement-leave-year.closed'),
          sql`${domainEvent.payload} ->> 'asOf' = ${p.asOf}`,
        ),
      )
      .limit(1);
    if (marker) return { ...empty, alreadyClosed: true };

    // The leave cycle drives the boundary, and it is PER-COMPANY: a mixed-cycle tenant must sweep each
    // company at its OWN boundary. Join `company` so each accrual carries its own employment's leave cycle
    // (the previous single-company SELECT applied one arbitrary company's cycle tenant-wide — bug #19).
    const active = await tx
      .select({
        id: toilAccrual.id,
        employmentId: toilAccrual.employmentId,
        daysCredited: toilAccrual.daysCredited,
        daysTaken: toilAccrual.daysTaken,
        expiryAction: toilAccrual.expiryAction,
        carryForwardAtYearEnd: toilAccrual.carryForwardAtYearEnd,
        workedDate: toilAccrual.workedDate,
        // Phase-B #14: the worked-day shape so a First-Schedule convert reconciles to the exact statutory cash.
        dayType: toilAccrual.dayType,
        otMinutes: toilAccrual.otMinutes,
        hiredOn: employment.hiredOn,
        leaveCycle: company.leaveCycle,
      })
      .from(toilAccrual)
      .innerJoin(employment, eq(employment.id, toilAccrual.employmentId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(eq(toilAccrual.status, 'active'));

    let carriedForward = 0;
    // Each row carries its own per-company boundary; calendar rows resolve to `asOf`, anniversary rows to the
    // employee's own cycle start. We branch per row so a mixed-cycle tenant closes every company correctly.
    const rows: (SweepRow & { boundary: string })[] = [];
    for (const a of active) {
      if (a.carryForwardAtYearEnd) {
        carriedForward += 1;
        continue; // survives the close — frozen opt-in carry-forward
      }
      const boundary = a.leaveCycle === 'anniversary' ? earnedCycleStart(a.hiredOn, p.asOf, 'anniversary') : p.asOf;
      rows.push({
        id: a.id,
        employmentId: a.employmentId,
        remaining: round2(Number(a.daysCredited) - Number(a.daysTaken)),
        expiryAction: a.expiryAction,
        workedDate: a.workedDate,
        dayType: a.dayType as 'workday' | 'rest_day' | 'holiday',
        otMinutes: a.otMinutes,
        boundary,
      });
    }

    // Sweep each row at its own per-company boundary.
    let agg: ToilExpiryResult = { processed: 0, converted: 0, lapsed: 0, convertedDays: 0, convertedAmount: 0 };
    for (const r of rows) {
      const part = await expireAccrualsTx(tx, ctx, [r], r.boundary);
      agg = {
        processed: agg.processed + part.processed,
        converted: agg.converted + part.converted,
        lapsed: agg.lapsed + part.lapsed,
        convertedDays: round2(agg.convertedDays + part.convertedDays),
        convertedAmount: round2(agg.convertedAmount + part.convertedAmount),
      };
    }

    // One summary marker event; the per-accrual toil.converted/toil.lapsed rows are the audit (mirrors the
    // leave-year.opened skip comment). The fixed aggregateId is the idempotency key for this boundary.
    // The marker is keyed to the tenant (like leave-year.opened) with the boundary in the payload; the
    // idempotency guard above matches on payload->>'asOf', so a re-fire for the same boundary is a no-op.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'replacement-leave-year',
      aggregateId: ctx.tenantId,
      eventType: 'replacement-leave-year.closed',
      actor: actorOf(ctx),
      // leaveCycle is now per-company (bug #19): record the distinct cycles swept rather than one arbitrary
      // company's value. The idempotency guard keys on payload->>'asOf', so this field is descriptive only.
      payload: { asOf: p.asOf, leaveCycles: [...new Set(active.map((a) => a.leaveCycle))].sort(), ...agg, carriedForward },
    });
    return { ...agg, alreadyClosed: false, carriedForward };
  });
}
