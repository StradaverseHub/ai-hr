/**
 * Leave-in-lieu (TOIL) — ADR-0033. A contractual replacement-leave engine: elected+approved rest-day /
 * holiday / OT work becomes a REPLACEMENT-type leave credit, mutually exclusive with OT pay. Gated by
 * TOIL_ENABLED (off ⇒ every entry point refuses, nothing reads the tables). The statutory boundary is
 * welded in: a First-Schedule-eligible (≤ wage ceiling) employee can only accrue TOIL when the company
 * policy's allowFirstScheduleEligible toggle is on, and then only with a compliance warning + the intent
 * to convert unused TOIL to pay on expiry (never lapse). The same worked day is cash XOR TOIL — the OT-pay
 * prefill (core/payroll.ts) excludes any day with a non-lapsed accrual.
 */
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { assertCanDecide } from './approvals';
import {
  attendance,
  company,
  compensation,
  employment,
  leaveLedger,
  leaveType,
  toilAccrual,
  toilPolicy,
  type ToilAccrualBasis,
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
      })
      .onConflictDoUpdate({
        target: toilPolicy.companyId,
        set: {
          enabled: p.enabled,
          accrualBasis: p.accrualBasis,
          expiryDays: p.expiryDays,
          onExpiry: p.onExpiry,
          allowFirstScheduleEligible: p.allowFirstScheduleEligible,
        },
      })
      .returning({ id: toilPolicy.id });
    if (p.enabled) await ensureReplacementLeaveType(tx, ctx.tenantId);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'toil-policy',
      aggregateId: row.id,
      eventType: 'toil-policy.updated',
      actor: actorOf(ctx),
      payload: { ...p },
    });
    return row;
  });
}

export type ToilPolicyView = ToilPolicyInput & { isDefault: boolean };
const POLICY_DEFAULTS = {
  enabled: false,
  accrualBasis: 'hours_worked' as ToilAccrualBasis,
  expiryDays: 90,
  onExpiry: 'convert_to_pay' as ToilExpiryAction,
  allowFirstScheduleEligible: false,
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
};

/**
 * Bank time in lieu for one worked day (an elected, approved grant — `assertCanDecide` enforces manager/admin
 * authority and bans self-grant). Reads the day's `otMinutes` + `dayType`, applies the eligibility toggle,
 * writes a `toil_accrual` row + a signed `leave_ledger` credit, and appends `toil.accrued`. The OT-pay prefill
 * excludes this day thereafter, so the worked OT is compensated once.
 */
export async function accrueToil(
  ctx: SessionContext,
  p: { employmentId: string; workedDate: string },
): Promise<AccrueToilResult> {
  if (!toilEnabled()) throw new ToilDisabledError();
  return withTenant(ctx, async (tx) => {
    await assertCanDecide(tx, ctx, p.employmentId, 'time off in lieu');

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
    if (!att || !att.dayType || (att.otMinutes ?? 0) <= 0) throw new ToilNoOvertimeError();
    const otMinutes = att.otMinutes ?? 0;
    const dayType = att.dayType;

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

    // 4 · eligibility gate. s.2 wages (basic + fixed allowance) vs the First Schedule ceiling from the pack.
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

    // 5 · days credited + expiry.
    const mult = policy.accrualBasis === 'premium_equivalent' ? PREMIUM_MULT[dayType] : 1;
    const daysCredited = round2((otMinutes / STD_DAY_MINUTES) * mult);
    const expiresOn = addDays(p.workedDate, policy.expiryDays);

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
      payload: { workedDate: p.workedDate, dayType, otMinutes, daysCredited, accrualBasis: policy.accrualBasis, eligible, forcedConvertOnExpiry: eligible, expiresOn },
    });

    return {
      accrualId: acc.id,
      daysCredited,
      expiresOn,
      forcedConvertOnExpiry: eligible,
      complianceWarning: eligible
        ? 'This employee is within the First Schedule (statutory overtime pay normally applies). Unused time in lieu will convert to pay on expiry, not lapse.'
        : undefined,
    };
  });
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

/**
 * Expire active TOIL accruals whose expiry date has arrived (gated). Each follows its FROZEN expiry_action:
 * `convert_to_pay` debits the replacement-leave credit and records the owed ORP value as an event — there is
 * NO auto-disbursement (the final-pay discipline: money owed is surfaced, never silently paid); `lapse` debits
 * the credit and forfeits the day. Idempotent — only `status='active'` rows are touched, so re-running is safe.
 * `today` is injected for deterministic tests.
 */
export async function runToilExpiry(ctx: SessionContext, p: { today: string }): Promise<ToilExpiryResult> {
  if (!toilEnabled()) throw new ToilDisabledError();
  return withTenant(ctx, async (tx) => {
    const due = await tx
      .select({
        id: toilAccrual.id,
        employmentId: toilAccrual.employmentId,
        daysCredited: toilAccrual.daysCredited,
        expiryAction: toilAccrual.expiryAction,
        workedDate: toilAccrual.workedDate,
      })
      .from(toilAccrual)
      .where(and(eq(toilAccrual.status, 'active'), lte(toilAccrual.expiresOn, p.today)));
    if (due.length === 0) return { processed: 0, converted: 0, lapsed: 0, convertedDays: 0, convertedAmount: 0 };

    // Current s.2 wages for the employees whose TOIL converts to pay (ORP = wages / 26 per day).
    const convertEmpIds = [...new Set(due.filter((d) => d.expiryAction === 'convert_to_pay').map((d) => d.employmentId))];
    const wagesBy = new Map<string, number>();
    if (convertEmpIds.length) {
      const comps = await tx
        .select({ employmentId: compensation.employmentId, basic: compensation.basicSalary, allowance: compensation.monthlyAllowance })
        .from(compensation)
        .where(and(inArray(compensation.employmentId, convertEmpIds), isNull(compensation.validTo), isNull(compensation.supersededAt)));
      for (const c of comps) wagesBy.set(c.employmentId, round2(Number(c.basic) + Number(c.allowance ?? 0)));
    }
    const replacementTypeId = await ensureReplacementLeaveType(tx, ctx.tenantId);

    let converted = 0;
    let lapsed = 0;
    let convertedDays = 0;
    let convertedAmount = 0;
    for (const a of due) {
      const days = Number(a.daysCredited);
      const convert = a.expiryAction === 'convert_to_pay';
      // Debit the replacement-leave credit either way — the unused in-lieu day is gone (paid out or forfeited).
      await tx.insert(leaveLedger).values({
        tenantId: ctx.tenantId,
        employmentId: a.employmentId,
        leaveTypeId: replacementTypeId,
        entryType: 'debit',
        days: (-days).toFixed(2),
        effectiveOn: p.today,
      });
      const amount = convert ? round2(days * ((wagesBy.get(a.employmentId) ?? 0) / ORP_DIVISOR)) : 0;
      await tx.update(toilAccrual).set({ status: convert ? 'converted_to_pay' : 'lapsed' }).where(eq(toilAccrual.id, a.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'toil-accrual',
        aggregateId: a.id,
        eventType: convert ? 'toil.converted' : 'toil.lapsed',
        actor: actorOf(ctx),
        subjectEmploymentId: a.employmentId,
        payload: { workedDate: a.workedDate, daysCredited: days, ...(convert ? { amountOwed: amount, orpDivisor: ORP_DIVISOR } : {}) },
      });
      if (convert) {
        converted += 1;
        convertedDays = round2(convertedDays + days);
        convertedAmount = round2(convertedAmount + amount);
      } else {
        lapsed += 1;
      }
    }
    return { processed: due.length, converted, lapsed, convertedDays, convertedAmount };
  });
}
