/**
 * Leave-in-lieu (TOIL) — ADR-0033. A contractual replacement-leave engine: elected+approved rest-day /
 * holiday / OT work becomes a REPLACEMENT-type leave credit, mutually exclusive with OT pay. Gated by
 * the per-tenant `toil` MODULE ENTITLEMENT as of ADR-0077 slice 3 — not the TOIL_ENABLED env flag, and
 * NOT uniformly: ACCRUAL and configuration refuse without it, while the two WIND-DOWN sweeps
 * (`runToilExpiry`, `closeReplacementLeaveYear`) deliberately do not, because a lapsed entitlement must
 * not strand a settlement the employer already owes. Those two are admin-gated instead — see
 * `ToilSweepForbiddenError`, which replaced the check the entitlement gate had been doing by accident.
 * The statutory boundary is
 * welded in: a First-Schedule-eligible (≤ wage ceiling) employee can only accrue TOIL when the company
 * policy's allowFirstScheduleEligible toggle is on, and then only with a compliance warning + the intent
 * to convert unused TOIL to pay on expiry (never lapse). The same worked day is cash XOR TOIL — the OT-pay
 * prefill (core/payroll.ts) excludes any day with a non-lapsed accrual.
 */
import { and, asc, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { assertCanDecide } from './approvals';
import { earnedCycleStart } from './leave';
import {
  appUser,
  attendance,
  company,
  compensation,
  domainEvent,
  employment,
  leaveLedger,
  leaveRequest,
  leaveType,
  payrollBatch,
  payrollInput,
  person,
  replacementLeaveRequest,
  replacementLeaveRequestDate,
  toilAccrual,
  toilPolicy,
  type ReplacementRequestEligibility,
  type ToilAccrualBasis,
  type ToilAccrualSource,
  type ToilAccrualStatus,
  type ToilExpiryAction,
  type ToilExpiryUnit,
  type ToilReplacementLeaveFrom,
  type ToilWorkedDayKind,
} from '../db/schema';
import { cleanReplacementEligibility } from './replacement-eligibility';
import { packFor } from '../localization/registry';
// 3fb1a611 (r299) — `assertModuleEnabled` is BACK: setToilPolicy is gated on the `toil` entitlement again
// (see its header for why 1cf5b37c's removal was reversed), and so is the HR grant. `isModuleEnabled` still
// gates both accrual paths.
import { assertModuleEnabled, isModuleEnabled } from './entitlements';
import { todayInKualaLumpur } from '../lib/hr-date';
import { isAdmin } from '../lib/authz';

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
/**
 * 3fb1a611 (r299) · the date asked for is an ORDINARY WORKING DAY for this employee, so it cannot earn a
 * Leave Credit. Only a rest day, an off day or a public holiday can. Extends `ToilNotEligibleError` so every
 * existing not-eligible handler treats it the same way; carries the dates so a screen can name them.
 */
export class ToilOrdinaryWorkingDayError extends ToilNotEligibleError {
  readonly dates: string[];
  constructor(dates: string[]) {
    super(
      `Only a rest day, off day or public holiday can earn a Leave Credit. ${dates.join(', ')} ${
        dates.length === 1 ? 'is an ordinary working day' : 'are ordinary working days'
      } for this employee.`,
    );
    this.name = 'ToilOrdinaryWorkingDayError';
    this.dates = dates;
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
/**
 * A non-admin tried to run one of the two statutory sweeps (`runToilExpiry`,
 * `closeReplacementLeaveYear`).
 *
 * WHY THIS EXISTS AT ALL, AND WHY IT ARRIVED WITH ADR-0077 SLICE 3. Both sweeps are mutating,
 * tenant-scoped and reachable as bare POSTs — `app/admin/actions.ts` exports them as server actions,
 * and until slice 3 the FIRST line of each service was `if (!toilEnabled()) throw`. That gate was
 * doing double duty as the only check on the path, and since `TOIL_ENABLED` is set in no tracked env
 * file (packs/catalog.ts), it refused everyone on every deployment. Slice 3 removed it on purpose —
 * a lapsed entitlement must not be able to strand a settlement the employer already owes — which
 * left two statutory sweeps in front of an ordinary `getSession()`.
 *
 * Checked in the SERVICE and not only at the surface because the surface is one `redirect()` away
 * from being bypassed by a direct action POST, and because `closeReplacementLeaveYear` writes a
 * marker that `domain_event` REVOKEs UPDATE/DELETE on: there is no in-product undo for a wrong one.
 */
export class ToilSweepForbiddenError extends Error {
  constructor(msg = 'Only an HR administrator may run the replacement-leave sweeps.') {
    super(msg);
    this.name = 'ToilSweepForbiddenError';
  }
}

/**
 * Is this caller an admin, for a context that may carry EITHER shape?
 *
 * `isAdmin` reads `s.roles` only, and a real company-scoped session carries `grants` with no `roles`
 * array at all — `withTenant` normalises the two (`ctx.roles ?? grants.map(g => g.role)`) and
 * `core/audit-chain.ts` does the same. Checking `roles` alone would refuse exactly the delegated
 * hr_admin the per-company marker below exists to support, which is the opposite of the intent.
 */
function isAdminCtx(ctx: SessionContext): boolean {
  return isAdmin({ ...ctx, roles: ctx.roles ?? (ctx.grants ?? []).map((g) => g.role) });
}

const STD_DAY_MINUTES = 480; // 8h — the ORP/standard-day convention (wages / 26 / 8) used across payroll
const round2 = (n: number) => Math.round(n * 100) / 100;
const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * 296fc027 · CALENDAR-month addition, with the short-month clamp stated rather than inherited.
 *
 * An employee told "3 months" expects the same day-of-month three months on, so this is NOT `addDays(date,
 * n * 30)` — over a year that drifts by five days, always in the employer's favour.
 *
 * THE CLAMP IS THE PART WORTH READING. 31 January + 1 month has no correct answer; every convention picks
 * one. JavaScript's own `Date` picks the WRONG one for an expiry date: `setUTCMonth(1)` on 31 Jan rolls
 * FORWARD into 2/3 March, so an expiry period would silently lengthen for anyone whose approval landed on
 * the 29th–31st. We clamp to the LAST DAY of the target month instead (31 Jan + 1 month ⇒ 28 Feb, or 29
 * Feb in a leap year), which is the convention every statutory-period calculation in this codebase uses
 * and the only one that keeps a "1 month" period inside one month.
 *
 * Pure and UTC throughout — the caller has already reduced the approval instant to a YYYY-MM-DD string, so
 * there is no zone to get wrong here.
 */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const targetMonthIndex = m - 1 + n;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12; // 0-based, non-negative for negative n
  // Day 0 of the NEXT month is the last day of the target month — the leap-year-correct month length.
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDayOfTargetMonth);
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 296fc027 · THE ONE PLACE the expiry period is turned into a date. Three columns carry the period
 * (`expiryUnit` + `expiryDays` + `expiryMonths`) and exactly one function may read all three, so a caller
 * cannot accidentally do `addDays(grant, policy.expiryDays)` on a months-unit policy and produce a 3-day
 * expiry. `expiryUnit` defaults to 'days' on every existing row, so this reproduces the old arithmetic
 * byte-for-byte for every policy that predates the setting.
 *
 * The result is FROZEN onto the accrual by the caller and never re-derived — changing the period later
 * moves nothing already banked, which is existing behaviour this keeps deliberately.
 */
export function resolveExpiry(
  grantDate: string,
  policy: { expiryUnit?: ToilExpiryUnit | null; expiryDays: number; expiryMonths?: number | null },
): string {
  return (policy.expiryUnit ?? 'days') === 'months'
    ? addMonths(grantDate, policy.expiryMonths ?? 3)
    : addDays(grantDate, policy.expiryDays);
}
// premium_equivalent banks the worked time uplifted by the day-type OT multiplier (itself contractual for
// TOIL; the exact EA ½/1-day rest-day rule governs cash pay, not in-lieu banking).
const PREMIUM_MULT: Record<'workday' | 'rest_day' | 'holiday', number> = { workday: 1.5, rest_day: 2, holiday: 3 };

/**
 * TOIL is now a per-TENANT entitlement, not a deployment flag (ADR-0077 slice 3). Same shape as the
 * env read it replaces — a free synchronous check — because the snapshot rides on the session
 * (core/entitlements.ts explains why that is session-scoped rather than per-transaction).
 */
const toilEnabled = (ctx: SessionContext) => isModuleEnabled(ctx, 'toil');

/**
 * Idempotent: the tenant's replacement leave type (created on first need; paid, working-day counted).
 *
 * 5ff7daff — MATCHES ON `leave_type.role` FIRST, and that is a defect fix, not a tidy-up. This function
 * used to ask `lower(code) = 'replacement'` only. Production's catalogue was not seeded: the customer's own
 * replacement type is coded `RL` with `role = 'replacement'`, so the code match found nothing and this
 * function CREATED A SECOND TYPE — "Replacement Leave (in lieu)" — the instant replacement leave was
 * switched on. Every approved credit then landed on the auto-created type while the type carrying the
 * customer's own name read zero forever. Same class as EMERGENCY vs production's `EL`, which is what
 * `leaveTypeIs` (core/leave.ts) exists for; TOIL had simply never adopted the marker.
 *
 * Precedence is `leaveTypeIs`': a row with a role wins, an UNCLASSIFIED row falls back to the seeded code —
 * so a tenant nobody has classified behaves exactly as before. The ORDER BY makes that precedence explicit
 * rather than leaving it to the planner when a tenant somehow has both.
 */
async function ensureReplacementLeaveType(tx: Tx, tenantId: string): Promise<string> {
  const find = () =>
    tx
      .select({ id: leaveType.id })
      .from(leaveType)
      .where(
        and(
          eq(leaveType.tenantId, tenantId),
          sql`(${leaveType.role} = 'replacement' or (coalesce(${leaveType.role}, '') = '' and lower(${leaveType.code}) = 'replacement'))`,
          isNull(leaveType.archivedAt),
        ),
      )
      .orderBy(sql`case when ${leaveType.role} = 'replacement' then 0 else 1 end`)
      .limit(1);
  const [existing] = await find();
  if (existing) return existing.id;
  const [created] = await tx
    .insert(leaveType)
    // ADR-0077 slice 5 — `country` is left to the column default ON PURPOSE, and this is a known seam.
    // TOIL creates this type for a TENANT, and a tenant has no single country once slice 6 wires more
    // than one pack; the right answer is the country of the company the accrual belongs to, which this
    // function does not receive. Picking one here would be inventing a rule slice 6 has to live with.
    // Harmless today (one pack), and the unique index makes a wrong guess collide rather than hide.
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
  // ── 296fc027 · the Replacement Leave configuration page's four new settings ──────────────────────────
  //
  // ALL OPTIONAL, and that is a compatibility decision rather than a modelling one. `setToilPolicy` is a
  // FULL REPLACE (it always writes every column), and `ToilPolicyInput` is constructed literally by eight
  // test files and by the module-install path. Making these required would break every one of those call
  // sites into a compile error for no behavioural gain, and each has a default that reproduces today's
  // behaviour exactly — so an omitting caller gets the pre-296fc027 policy, which is what it meant.
  //
  // The form always posts all four, so the only callers that omit them are ones that genuinely do not
  // care. A caller that DOES omit them resets them to the defaults below; that is the documented meaning
  // of a full-replace upsert and matches how `enabled`/`onExpiry` already behave.
  /** 'days' (default, today's behaviour) or 'months' (calendar-month addition). */
  expiryUnit?: ToilExpiryUnit;
  /** The count when the unit is 'months'. Ignored — but preserved — when the unit is 'days'. */
  expiryMonths?: number;
  /** Employee-submitted requests. OFF by default; enforced server-side, never only in the UI. */
  employeeRequestEnabled?: boolean;
  /** RECORDED ONLY — nothing validates against it and the page says so on screen. */
  replacementLeaveFrom?: ToilReplacementLeaveFrom;
  /** Who may submit. null/absent ⇒ everyone. See core/replacement-eligibility.ts for the rule. */
  requestEligibility?: ReplacementRequestEligibility | null;
};

/**
 * Upsert one company's TOIL policy (admin-gated by RLS). Enabling ensures the REPLACEMENT leave type.
 *
 * ENTITLEMENT-GATED as of ADR-0077 slice 3 (review r2). This was the one exported TOIL entry point with
 * no `toil` check — `accrueToil` and `maybeAutoAccrueOnApprovalTx` had one, this did not — so a tenant
 * with no `toil` row could still tick "enabled", choose an accrual basis, set the expiry action and
 * allow First-Schedule staff, and have all of it written and audited. No capability leaked (both accrual
 * paths still refuse), but the customer was configuring a module they had not bought, and every field
 * here is FROZEN onto each accrual at accrual time — so the settings would take effect verbatim the
 * moment the module was later purchased.
 *
 * NOT covered by the D3 wind-down argument, which is deliberately narrow. Ungating `runToilExpiry` and
 * `closeReplacementLeaveYear` was about SETTLING a debt already incurred: an eligible employee's banked
 * days must convert to pay and may never lapse, and both sweeps read the per-accrual `expiryAction` /
 * `carryForwardAtYearEnd` frozen at accrual, not this policy. Winding down needs the ledger and the two
 * sweeps; it does not need to re-tune FUTURE accrual, which is precisely what the entitlement governs.
 *
 * ── 1cf5b37c (2026-08-05) — THE ENTITLEMENT GATE ABOVE WAS REMOVED FROM THIS WRITER, DELIBERATELY ────
 *
 * Everything the paragraphs above say is still true, so read this before putting it back.
 *
 * The reporter's complaint was that Leave Config → Replacement Leave looks like an unfinished
 * placeholder: every control disabled, no Save. It is not a placeholder — it is a complete editor that
 * the `toil` entitlement renders read-only, and `toil` is not in `tenant_module` for the tenant
 * (verified on production 2026-08-05; `toil_policy` also holds ZERO rows). The approved plan's
 * instruction is to let the new Leave Config screen become editable WITHOUT switching `toil` on, because
 * that same flag also lights up the legacy app/admin/toil page the reporter told us to leave alone.
 *
 * WHAT THIS DOES NOT DO, and it is the reason the change is safe: it does not let anybody accrue
 * anything. Saving a policy here writes CONFIGURATION and nothing else. Every path that can actually
 * bank a day still checks the entitlement on its own —
 *   • `accrueToil` (:757) throws ToilDisabledError when the module is off;
 *   • `maybeAutoAccrueOnApprovalTx` (:838) returns false before it reads the policy at all;
 *   • the employee request path is gated the same way.
 * So a tenant without `toil` can now describe how replacement leave WOULD work and cannot cause a single
 * accrual, and the two settlement sweeps are untouched in both states. That is exactly the constraint the
 * plan sets: the new screen's gate must not change sweep behaviour.
 *
 * THE ORIGINAL CONCERN SURVIVES IN ONE RESPECT and is now the customer's to hold rather than the code's:
 * these fields are FROZEN onto each accrual at accrual time, so a policy configured today takes effect
 * verbatim the day `toil` is purchased. The screen says so on its face. That was a commercial argument
 * for the gate, not a data-integrity one, and the owner has approved letting the customer configure ahead
 * of purchase. `assertAdminCtx` still applies, so this is admin-only, never employee-reachable.
 */
export async function setToilPolicy(ctx: SessionContext, p: ToilPolicyInput) {
  // Own message — the default one talks about running the sweeps, which is not what this refuses.
  if (!isAdminCtx(ctx))
    throw new ToilSweepForbiddenError('Only an HR administrator may change the replacement-leave settings.');
  // ── 3fb1a611 (r299) — THE ENTITLEMENT GATE IS BACK, and 1cf5b37c's paragraph above is superseded ──────
  // 1cf5b37c ungated this writer so a tenant without the add-on could configure ahead of purchase. r281
  // (8a494721) found the cost of that: the reporter spent days in August filling in a form that could never
  // take effect, and the Company Rules section was gated away. With the rules now living on the Leave Credit
  // screen's Rules tab — itself gated on `toil` — an ungated writer would be the one door left open behind
  // a closed screen: a direct action POST could still write configuration for a module the tenant has not
  // bought. The approved plan (3fb1a611 rev 3, gap 6) puts the check back. Saved rows are untouched: the
  // eligibility entered in August is still there for the Rules tab to show once the module is on.
  assertModuleEnabled(ctx, 'toil');
  if (!Number.isInteger(p.expiryDays) || p.expiryDays < 1 || p.expiryDays > 730)
    throw new Error('Expiry days must be a whole number between 1 and 730.');
  // 296fc027: the months count gets its OWN bound rather than sharing the days one. 24 months is the same
  // horizon 730 days expresses; validating it against 1..730 would have accepted "500 months".
  const expiryMonths = p.expiryMonths ?? 3;
  if (!Number.isInteger(expiryMonths) || expiryMonths < 1 || expiryMonths > 24)
    throw new Error('Expiry months must be a whole number between 1 and 24.');
  // Normalised BEFORE the write so the column holds exactly one representation of "no restriction"
  // (NULL), and a criteria object that is all-empty lists cannot masquerade as a restriction.
  const requestEligibility = cleanReplacementEligibility(p.requestEligibility);
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
        expiryUnit: p.expiryUnit ?? 'days',
        expiryMonths,
        employeeRequestEnabled: p.employeeRequestEnabled ?? false,
        replacementLeaveFrom: p.replacementLeaveFrom ?? 'overtime',
        requestEligibility,
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
          // 296fc027: the same rule, five more columns. An upsert that inserts a value it does not also
          // update is the single most repeatable bug on this function — 0113 left the note; this obeys it.
          expiryUnit: p.expiryUnit ?? 'days',
          expiryMonths,
          employeeRequestEnabled: p.employeeRequestEnabled ?? false,
          // 3fb1a611 (r299) — PRESERVED WHEN OMITTED, the one exception to this upsert's full-replace
          // contract. The Leave Credit Rules tab no longer shows "Replacement leave from" (nothing reads it),
          // so the form stops posting it; resetting a stored value to the default on every save would be a
          // silent edit to a setting the administrator can no longer see. A caller that passes it still sets it.
          ...(p.replacementLeaveFrom !== undefined ? { replacementLeaveFrom: p.replacementLeaveFrom } : {}),
          requestEligibility,
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

/**
 * The READ shape. 296fc027 makes the five new settings REQUIRED here even though they are optional on the
 * write shape, and the asymmetry is deliberate: a caller writing a policy may legitimately not care about
 * a setting, but a caller RENDERING one must be handed a concrete value rather than an `undefined` it
 * would have to re-default (and would eventually re-default differently from `POLICY_DEFAULTS`).
 */
export type ToilPolicyView = Omit<
  ToilPolicyInput,
  'expiryUnit' | 'expiryMonths' | 'employeeRequestEnabled' | 'replacementLeaveFrom' | 'requestEligibility'
> & {
  isDefault: boolean;
  expiryUnit: ToilExpiryUnit;
  expiryMonths: number;
  employeeRequestEnabled: boolean;
  replacementLeaveFrom: ToilReplacementLeaveFrom;
  requestEligibility: ReplacementRequestEligibility | null;
};
const POLICY_DEFAULTS = {
  enabled: false,
  accrualBasis: 'hours_worked' as ToilAccrualBasis,
  expiryDays: 90,
  onExpiry: 'convert_to_pay' as ToilExpiryAction,
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
  // 296fc027 — these MUST match the column defaults in migration 0380, or a company with no saved policy
  // would render one thing and save another.
  expiryUnit: 'days' as ToilExpiryUnit,
  expiryMonths: 3,
  employeeRequestEnabled: false,
  replacementLeaveFrom: 'overtime' as ToilReplacementLeaveFrom,
  requestEligibility: null as ReplacementRequestEligibility | null,
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
            expiryUnit: r.expiryUnit,
            expiryMonths: r.expiryMonths,
            employeeRequestEnabled: r.employeeRequestEnabled,
            replacementLeaveFrom: r.replacementLeaveFrom,
            requestEligibility: r.requestEligibility ?? null,
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
    /** 00307068: the approval instant, INJECTED — the date the expiry period is now counted from. Omitted ⇒
     *  now, which is what both production paths pass (reaching this function IS the approval). Present only
     *  so the suite can assert an expiry date rather than recompute one, the same convention `runToilExpiry`
     *  and `closeReplacementLeaveYear` already follow with `today` / `asOf`. */
    approvedOn?: Date;
    /** 00307068: the date the employee ASKED for this credit (YYYY-MM-DD). Supplied by the auto path from
     *  the attendance correction being approved — the only caller that has a real request to point at.
     *  Omitted ⇒ the worked date, which is the honest answer for a manager's roster election. */
    requestedOn?: string;
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

  // 2..6 · everything from here is SHARED with the employee-request path, which reaches it without an
  // attendance row at all. See `bankToilCreditTx`.
  return bankToilCreditTx(tx, ctx, {
    employmentId: p.employmentId,
    workedDate: p.workedDate,
    companyId: att.companyId,
    country: att.country,
    dayType,
    // 3fb1a611: the roster and auto paths only ever reach here on a rest day or public holiday (1b above),
    // and the attendance row's day type IS the kind of day that earned the credit.
    workedDayKind: dayType as ToilWorkedDayKind,
    otMinutes,
    approvedOn: p.approvedOn,
    requestedOn: p.requestedOn,
    firstScheduleConsent: p.firstScheduleConsent,
    viaAutoApproval: p.viaAutoApproval,
    source: p.viaAutoApproval ? 'auto_approval' : 'roster',
  });
}

/**
 * 296fc027 · THE SHARED ACCRUAL EXECUTOR — steps 2 to 6, and nothing above them.
 *
 * WHY THIS SPLIT EXISTS. `accrueToilTx` cannot be reused as-is for the employee-request path, and the two
 * reasons are both hard requirements of the manager route that the employee route explicitly does not
 * have. Step 1 demands an `attendance` row with `otMinutes > 0` (`ToilNoOvertimeError`); step 1b restricts
 * the day to rest_day/holiday (`RL_ELIGIBLE_DAY_TYPES`). The approved request states that there is NO
 * attendance, timesheet or overtime validation in this phase — the employee DECLARES the dates they
 * worked. So the employee path must skip 1 and 1b.
 *
 * IT MUST NOT SKIP ANYTHING ELSE, and that is what this function is for. Duplicating the write would have
 * been the obvious shortcut and the wrong one: everything below is either a legal control or a
 * double-payment control, and a second copy of it is a second copy that can drift out of step.
 *   · step 2 — the company policy must be enabled;
 *   · step 3 — the DOUBLE-BANK GUARD. An employee cannot claim a worked date a manager already banked for
 *     them, and a banked date stays excluded from overtime pay (core/payroll.ts reads `toil_accrual`
 *     per-day). Unchanged, including the unique index behind it;
 *   · step 4 — the FIRST SCHEDULE GATE. A legal one: an employee at or below the statutory overtime
 *     protection threshold is entitled to overtime CASH rather than banked time, and may bank only when
 *     the company has switched the override on AND their own agreement is recorded. A self-service button
 *     must not become a way around that, so the gate lives HERE, below the fork, where neither path can
 *     miss it;
 *   · steps 5 and 6 — the frozen expiry, the ledger credit and the register row.
 *
 * THE ONE THING THE FORK CHANGES BELOW IT is where `daysCredited` comes from. The manager path derives it
 * from measured `otMinutes` × the policy basis. The employee path DECLARES it (`declaredDays`), because
 * there is no measurement to derive it from — that is precisely what "no overtime validation in this
 * phase" means. Everything else reads identically on both paths.
 */
export async function bankToilCreditTx(
  tx: Tx,
  ctx: SessionContext,
  p: {
    employmentId: string;
    workedDate: string;
    companyId: string;
    country: string | null;
    /**
     * NULL ⇒ SELF-DECLARED: there is no attendance row, so the day type is genuinely unknown. It is
     * recorded as NULL rather than guessed at, because a guessed 'workday' would flow into the expiry
     * sweep's exact-statutory-cash calculation and produce a wrong convert-to-pay figure for a
     * First-Schedule employee. See `convertAmountFor`, which falls back to the contractual ORP basis and
     * says so on the event when the day type is unknown.
     */
    dayType: 'workday' | 'rest_day' | 'holiday' | null;
    /** 3fb1a611: the kind of day that earned the credit (rest / off / public holiday). Recorded, never guessed. */
    workedDayKind?: ToilWorkedDayKind | null;
    otMinutes: number;
    /** Employee path: the credit is this many days verbatim. Omitted ⇒ derived from otMinutes × basis. */
    declaredDays?: number;
    approvedOn?: Date;
    requestedOn?: string;
    firstScheduleConsent?: boolean;
    viaAutoApproval?: boolean;
    source: ToilAccrualSource;
    /** 3fb1a611: HR's stated reason and optional remarks on a hand-added credit. */
    note?: string;
    remarks?: string;
    /**
     * 3fb1a611: an expiry HR typed on the Add Leave Credit form, overriding the policy's period. The caller
     * validates it (never before the date worked); omitted ⇒ `resolveExpiry` from the approval, as before.
     */
    expiresOnOverride?: string;
  },
): Promise<AccrueToilResult> {
  // 2 · the company policy must be enabled.
  const [policy] = await tx.select().from(toilPolicy).where(eq(toilPolicy.companyId, p.companyId)).limit(1);
  if (!policy || !policy.enabled) throw new ToilDisabledError('Time off in lieu is not enabled for this company.');

  // 3 · no double-banking (the unique index also guards; this is the friendly error).
  //
  // THE CASH-XOR-TOIL INVARIANT IS ONE-SIDED, AND THAT IS WORTH STATING WHERE SOMEONE WILL SEE IT.
  // core/payroll.ts's `EXCLUDE_TOIL_BANKED_DAYS` closes the TOIL-then-cash ordering: BOTH reads of
  // `attendance.otMinutes` — the OT prefill and the weekly/bi-weekly cross-cycle weighting — skip any
  // day that already carries a non-lapsed accrual, and slice 3 made that clause unconditional so a
  // lapsed entitlement cannot re-monetise a banked day.
  //
  // There is NO mirror guard here: prefill a rest day's OT into `payroll_input` first, then bank the
  // same day as TOIL, and the day is compensated twice — nothing below reads `payroll_input` or
  // `payslip`. Nor is that ordering exotic. `maybeAutoAccrueOnApprovalTx` banks on approval of an
  // attendance correction (core/attendance.ts), which routinely lands after a draft batch has been
  // prefilled.
  //
  // SLICE 3 IS WHAT MAKES IT REACHABLE, and an earlier version of this comment claimed the opposite
  // ("it predates ADR-0077 and is untouched by it, so it is not a slice-3 regression"). That is the
  // same argument 0314's header refuses on the identical facts: both `accrueToil` and
  // `maybeAutoAccrueOnApprovalTx` used to open with `if (!toilEnabled()) throw`, and TOIL_ENABLED is
  // set in NO tracked env file (packs/catalog.ts), so no accrual could ever be created and the double
  // payment could not happen on any deployment. Replacing that with a per-tenant `toil` entitlement
  // means the first customer who buys the module makes this reachable for the first time. The CODE is
  // untouched by slice 3; the REACHABILITY is created by it, and only the second one matters.
  //
  // WHY IT IS NOT CLOSED HERE, concretely rather than as a deferral. The obvious mirror — "refuse if a
  // `payroll_input` OT row already exists for this employment" — cannot be written, because
  // `payroll_input.overtime_amount` is a single per-(batch, employment) AGGREGATE with no per-day
  // breakdown (db/schema.ts). It carries no attribution back to a worked date, so that test cannot
  // tell "this rest day is already in the prefill" from "this employee had overtime on some OTHER day
  // this cycle" and would refuse nearly every legitimate accrual in a month where anyone worked any
  // overtime. That asymmetry is real: payroll's `EXCLUDE_TOIL_BANKED_DAYS` works because
  // `toil_accrual` IS per-day. Closing this properly means deciding what a legitimate correction
  // (prefill, then elect TOIL instead, then re-prefill) does to a draft batch — an ADR-0033 question
  // about payroll-run state, not an entitlement one.
  //
  // test/toil.test.ts pins the double payment as a characterization test ("OT-then-TOIL"), so the next
  // change to this area starts from a fixture rather than a paragraph and closing the gap is a visible,
  // deliberate edit to a named assertion.
  // 3fb1a611: a REVERSED credit does not count — it was never banked (payroll agrees, see
  // EXCLUDE_TOIL_BANKED_DAYS), and migration 0469 made the unique index skip it for the same reason.
  const [dupe] = await tx
    .select({ id: toilAccrual.id })
    .from(toilAccrual)
    .where(
      and(
        eq(toilAccrual.employmentId, p.employmentId),
        eq(toilAccrual.workedDate, p.workedDate),
        ne(toilAccrual.status, 'reversed'),
      ),
    )
    .limit(1);
  if (dupe) throw new ToilAlreadyAccruedError();

  // 4 · First-Schedule eligibility gate. s.2 wages (basic + fixed allowance) vs the ceiling from the pack.
  const [comp] = await tx
    .select({ basic: compensation.basicSalary, allowance: compensation.monthlyAllowance })
    .from(compensation)
    .where(and(eq(compensation.employmentId, p.employmentId), isNull(compensation.validTo), isNull(compensation.supersededAt)))
    .limit(1);
  const wages = comp ? round2(Number(comp.basic) + Number(comp.allowance ?? 0)) : null;
  const pack = packFor(p.country);
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
  //
  // 296fc027 · THE ONE PLACE THE TWO PATHS DIVERGE. The manager path derives the credit from MEASURED
  // overtime uplifted by the policy basis. The employee path DECLARES it, because there is no measurement
  // to derive it from — no attendance row was required to get here. The premium multiplier is not applied
  // to a declared figure: it keys off the day type, and a self-declared credit has none, so applying it
  // would mean picking a multiplier at random.
  const dayType = p.dayType;
  const otMinutes = p.otMinutes;
  const mult = dayType != null && policy.accrualBasis === 'premium_equivalent' ? PREMIUM_MULT[dayType] : 1;
  const daysCredited = p.declaredDays != null ? round2(p.declaredDays) : round2((otMinutes / STD_DAY_MINUTES) * mult);

  // 00307068 · THE EXPIRY ANCHOR MOVES FROM THE WORKED DAY TO THE APPROVAL. This is a behaviour change, not
  // a display one, and it is the reason the item is Large. Reaching this line IS the approval: the manual
  // roster path has already run assertCanDecide above, and the auto path runs inside
  // decideAttendanceCorrection's transaction, where the correction's approver passed the same check. So
  // "now" is the decision instant on both paths and there is no third path that could disagree.
  //
  // It can only ever LENGTHEN a credit's life: approval never precedes the day worked, so approvedOn::date
  // is always on or after workedDate and the resulting expiry is always on or after the old one. Nobody
  // loses a day. Migration 0354 applies the same one-way rule to rows already banked, via GREATEST.
  //
  // 296fc027 · the period is now a NUMBER PLUS A UNIT, and `resolveExpiry` is the only reader of the three
  // columns that carry it. Still frozen onto the accrual below and never re-derived, so changing the
  // period later moves nothing already banked.
  const approvedOn = p.approvedOn ?? new Date();
  // r299 fix pass — a date from an instant goes through todayInKualaLumpur (CLAUDE.md §8): the UTC date froze
  // an expiry one day early for any approval between midnight and 08:00 in Malaysia.
  const approvedOnDate = todayInKualaLumpur(approvedOn);
  // 3fb1a611: HR may type the expiry on the Add Leave Credit form (validated by the caller); every other path
  // resolves it from the policy exactly as before.
  const expiresOn = p.expiresOnOverride ?? resolveExpiry(approvedOnDate, policy);

  // 00307068 · the REQUEST date, which is a different question with two honest answers.
  //  • auto path — the employee really did ask: the attendance correction they filed IS the request, so its
  //    creation date is the request date. It is PASSED IN by decideAttendanceCorrection rather than looked
  //    up here, and that is not a stylistic preference. A lookup would have to guess which correction for
  //    that (employment, date) produced this credit, and it would guess WRONG: the hook runs BEFORE the
  //    status flips to 'approved' (core/attendance.ts writes the status after calling it), so the row being
  //    approved is still 'pending' at this moment. The caller already holds the exact row; asking it is the
  //    only answer that cannot be wrong.
  //  • roster path — there is NO employee request. A manager elects a worked day directly off the roster
  //    (there is no submission anywhere to date), so the worked day is the only date in evidence, and
  //    inventing a "requested on" that nobody typed would be a fabrication on a screen the employee reads.
  //  • 296fc027 employee path — there IS a request, and it is the replacement-leave request the employee
  //    filed. Its submission date is passed in, for the same reason the auto path passes its own.
  const requestedOn = p.requestedOn ?? p.workedDate;
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
  const note = p.note?.trim() || null;
  const remarks = p.remarks?.trim() || null;
  const [acc] = await tx
    .insert(toilAccrual)
    .values({
      tenantId: ctx.tenantId,
      employmentId: p.employmentId,
      workedDate: p.workedDate,
      dayType,
      workedDayKind: p.workedDayKind ?? null,
      note,
      remarks,
      otMinutes,
      daysCredited: daysCredited.toFixed(2),
      accrualBasis: policy.accrualBasis,
      // 00307068: the two dates the employee's Replacement Leave table shows, recorded at the moment they
      // are known rather than re-derived later from a row that no longer remembers.
      requestedOn,
      approvedOn,
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
      // 296fc027: WHICH PATH minted this credit. NULL on every legacy row — a credit banked before this
      // column existed genuinely does not know, and back-filling a guess would make the audit trail claim
      // a precision it does not have. The expiry sweep reads `dayType IS NULL` rather than this, because
      // the valuation question is "do we know the day type", not "where did it come from".
      source: p.source,
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
      // 3fb1a611: which path minted it, the day that earned it, the ledger row it wrote and — for a
      // hand-added credit — the reason HR gave.
      source: p.source,
      workedDayKind: p.workedDayKind ?? null,
      ledgerEntryId: ledger.id,
      ...(note ? { note } : {}),
      ...(remarks ? { remarks } : {}),
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
  p: { employmentId: string; workedDate: string; firstScheduleConsent?: boolean; approvedOn?: Date },
): Promise<AccrueToilResult> {
  if (!toilEnabled(ctx)) throw new ToilDisabledError();
  return withTenant(ctx, (tx) => accrueToilTx(tx, ctx, { ...p, requireDecideAuth: true }));
}

/**
 * 296fc027 · SELF-DECLARED accrual — the employee-request path's grant, run inside the approval's tx.
 *
 * Skips exactly two things `accrueToilTx` does and nothing else: the attendance lookup (step 1) and the
 * rest-day/holiday restriction (step 1b). Both are refused for the same reason — the approved request
 * states there is no attendance, timesheet or overtime validation in this phase, so there is no attendance
 * row to read and no day type to restrict on. Everything that follows is `bankToilCreditTx`, shared
 * verbatim with the manager route: the double-bank guard, the First Schedule gate, the frozen expiry, the
 * ledger credit and the register row.
 *
 * NO `assertCanDecide` HERE, and that is not a gap. This function is only ever reached from
 * `decideReplacementLeaveRequest`, which has already run `assertCanDecide` against the same employment —
 * the identical arrangement `maybeAutoAccrueOnApprovalTx` relies on, and for the identical reason:
 * re-checking inside the approval's own transaction would hard-throw on the very manager who just passed.
 *
 * `otMinutes` is DECLARED, not measured. It is recorded so the register row is complete and so the
 * employee's Replacement Leave table can show what was claimed, but nothing computes a statutory
 * entitlement from it — the null `dayType` is what tells the expiry sweep that (see `convertAmountFor`).
 */
/**
 * 3fb1a611 (r299) · the kind of day an employee's date is — workday / rest_day / off_day / holiday — through
 * the attendance pack's own schedule resolver (see `workedDayKindForTx` there for why it is the same ladder
 * Daily Attendance and the clocking path use).
 *
 * A DYNAMIC import of the attendance facade, deliberately. That pack's engine already imports this file
 * (auto-accrual on an approved correction), so a static import here would close a module cycle through a
 * star re-export — the shape a transpiler can evaluate before its names exist. core/leave-adjustment.ts
 * reaches for core/leave the same way for the same reason.
 */
export async function resolveWorkedDayKindTx(tx: Tx, employmentId: string, date: string): Promise<ToilWorkedDayKind> {
  const { workedDayKindForTx } = await import('../packs/attendance/service');
  return workedDayKindForTx(tx, employmentId, date);
}

/**
 * The attendance-vocabulary day type a credit is VALUED from on expiry, for a resolved day kind.
 *
 * Rest day and public holiday map straight across, so a convert-to-pay reconciles to the exact statutory
 * cash for that day (`convertAmountFor`). An OFF day maps to NULL, deliberately: this repo's verified
 * statutory source (docs/architecture/STATUTORY-SOURCES.md §6) states the rest-day, public-holiday and
 * normal-workday rules and says nothing about an off day, so no exact figure is claimed for one — it stays
 * on the existing ORP fallback, with the kind recorded beside it (`worked_day_kind`) so a person can
 * reconcile it. A working day never reaches here: it cannot earn a credit.
 */

export async function accrueSelfDeclaredToilTx(
  tx: Tx,
  ctx: SessionContext,
  p: {
    employmentId: string;
    workedDate: string;
    /** The credit, in days, exactly as the employee declared it. */
    declaredDays: number;
    /** The declared minutes behind that figure (days × the standard day, or the hours claimed). */
    declaredMinutes: number;
    approvedOn: Date;
    requestedOn: string;
    firstScheduleConsent?: boolean;
  },
): Promise<AccrueToilResult> {
  // The company + country the First-Schedule ceiling is resolved from. `accrueToilTx` gets these off the
  // attendance join; with no attendance row they come straight off the employment.
  const [emp] = await tx
    .select({ companyId: employment.companyId, country: company.country })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .where(eq(employment.id, p.employmentId))
    .limit(1);
  if (!emp) throw new ToilNotEligibleError('No employment on record for this request.');
  // 3fb1a611 (r299) — THE DAY-TYPE GATE THIS PATH NEVER HAD. The roster and auto paths have always refused
  // anything but a rest day or public holiday (RL_ELIGIBLE_DAY_TYPES); this one accepted any date, so an
  // employee could claim a credit for an ordinary working day. Resolved HERE, at approval — the binding
  // moment, inside the transaction that mints the credit — as well as at submission (the courtesy half in
  // core/replacement-request.ts), because a roster can change between the two.
  const kind = await resolveWorkedDayKindTx(tx, p.employmentId, p.workedDate);
  if (kind === 'workday') throw new ToilOrdinaryWorkingDayError([p.workedDate]);
  return bankToilCreditTx(tx, ctx, {
    employmentId: p.employmentId,
    workedDate: p.workedDate,
    companyId: emp.companyId,
    country: emp.country,
    // r299 fix pass (3fb1a611) — STILL NULL, deliberately. The day KIND is resolved and stored (worked_day_kind,
    // below) so the screens and the gate can name it, but `day_type` is what the convert-to-pay valuation keys
    // on, and its exact statutory branch prices the WHOLE `otMinutes` figure — which on this path is a
    // declaration (days × 480 for a request in days), and which ignores how much of the credit was already
    // used. Stamping it turned a part-used 1-day credit into a full day's statutory cash and a 3-day claim on
    // one rest day into 384.76 where the remaining-days basis gives 230.76 (r299 verifier). The honest
    // basis for a self-declared credit remains the ORP × remaining days fallback, as 296fc027 decided.
    dayType: null,
    workedDayKind: kind,
    otMinutes: Math.max(0, Math.round(p.declaredMinutes)),
    declaredDays: p.declaredDays,
    approvedOn: p.approvedOn,
    requestedOn: p.requestedOn,
    firstScheduleConsent: p.firstScheduleConsent,
    source: 'employee_request',
  });
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
  p: {
    employmentId: string;
    workedDate: string;
    dayType: string | null;
    /** 00307068: the approved correction's own creation date — the employee's request date for the credit
     *  this approval banks. See the note in accrueToilTx for why it is passed rather than looked up. */
    requestedOn?: string;
  },
): Promise<boolean> {
  if (!toilEnabled(ctx)) return false;
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
    await accrueToilTx(tx, ctx, {
      employmentId: p.employmentId,
      workedDate: p.workedDate,
      requireDecideAuth: false,
      viaAutoApproval: true,
      requestedOn: p.requestedOn,
    });
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
  // r300 (3fb1a611) — AN EMPLOYEE WHO NEVER HELD A CREDIT HAS NO REGISTER TO KEEP IN STEP, so nothing is read,
  // written or flagged: the shortfall event below exists for a register that COULD NOT cover the leave, not for
  // one that was never used. Since finalizeLeaveApproval reads the type's role, every Replacement Leave approval
  // on a role-classified type reaches here — on a tenant without Leave Credit that is every one of them, and
  // main never ran this at all for such a type. The same probe gates restoreReplacementLeaveTx.
  if (!(await employmentHoldsCreditsTx(tx, ctx.tenantId, p.employmentId))) {
    return { allocated: 0, fullyConsumed: 0, partiallyConsumed: 0, shortfall: remaining };
  }

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
    // r299 fix pass — guarded on the state just read, the mirror of reverseLeaveCredit's guard: an approval
    // racing an HR reversal must not flip a REVERSED credit back to taken. A lot that changed underneath is
    // skipped and the next lot (or the shortfall event) covers the leave.
    const consumedRow = await tx
      .update(toilAccrual)
      .set({
        daysTaken: newTaken.toFixed(2),
        ...(fully ? { status: 'taken' as ToilAccrualStatus, takenByRequestId: p.requestId } : {}),
      })
      .where(and(eq(toilAccrual.id, a.id), eq(toilAccrual.status, 'active'), eq(toilAccrual.daysTaken, a.daysTaken)))
      .returning({ id: toilAccrual.id });
    if (consumedRow.length !== 1) continue;
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

// ─── cancellation give-back: the inverse of consumption (3fb1a611, r299) ───────────────────────────────

/**
 * A cancellation that would have to give a credit back to a lot that can no longer hold one — it expired,
 * was paid out, or was reversed since the leave used it. Typed so core/leave.ts can re-type it onto
 * `LeaveCancellationNotAllowedError` and the reason reaches the person cancelling.
 */
export type RestoreBlock = {
  /** The credit's date worked (null when the credit itself could not be read). */
  workedDate: string | null;
  expiresOn: string | null;
  state: 'expired' | 'paid_out' | 'reversed' | 'missing' | 'unreadable';
};
export class ReplacementLeaveRestoreBlockedError extends Error {
  /** Every credit that blocks the give-back, so a screen can name each one in the reader's language. */
  readonly blocked: RestoreBlock[];
  constructor(msg: string, blocked: RestoreBlock[] = []) {
    super(msg);
    this.name = 'ReplacementLeaveRestoreBlockedError';
    this.blocked = blocked;
  }
}

export type RestoreReplacementResult = {
  /** days actually given back to the register (≤ need). */
  restored: number;
  /** credit lots that took some of it back. */
  lotsRestored: number;
  /** of those, the ones that flipped 'taken' back to 'active'. */
  reactivated: number;
  /** need − restored: days the LEDGER gives back that the register never held (a ghost credit was spent). */
  shortfall: number;
};

/**
 * The request a Replacement Leave's consumption was RECORDED against.
 *
 * Consumption runs once, at final approval, against the request being approved (finalizeLeaveApproval —
 * per-date partial approval is refused for replacement leave, so there is exactly one such request). A
 * partial cancellation later SPLITS that request: the original row id is reused for the first segment and
 * the other segments become new rows. Since 3fb1a611 each new row's `leave-request.split` event names the
 * row it was split from (`splitFromRequestId`), so following that chain from any surviving segment arrives
 * back at the request the `toil.consumed` events carry. Replacement leave could not be cancelled at all
 * before this round, so no replacement split exists without that field.
 */
/**
 * Has this employment ever held a Leave Credit that could have been used? A REVERSED credit cannot have been
 * (reverseLeaveCredit refuses a used one), so it is excluded — which is also exactly the predicate of the partial
 * toil_accrual_emp_date_uq index (tenant_id, employment_id, worked_date) WHERE status <> 'reversed', so this is
 * one index probe rather than a scan.
 */
export async function employmentHoldsCreditsTx(tx: Tx, tenantId: string, employmentId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: toilAccrual.id })
    .from(toilAccrual)
    .where(and(eq(toilAccrual.tenantId, tenantId), eq(toilAccrual.employmentId, employmentId), ne(toilAccrual.status, 'reversed')))
    .limit(1);
  return row != null;
}

async function consumptionRootRequestIdTx(tx: Tx, ctx: SessionContext, requestId: string): Promise<string> {
  let current = requestId;
  // Bounded: a split chain is one hop per cancellation, and a cycle is impossible (a new row cannot be split
  // from itself), but a loop that trusts data to terminate is a loop that one day will not.
  for (let hop = 0; hop < 64; hop++) {
    const [ev] = await tx
      .select({ from: sql<string | null>`${domainEvent.payload} ->> 'splitFromRequestId'` })
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.tenantId, ctx.tenantId),
          eq(domainEvent.eventType, 'leave-request.split'),
          eq(domainEvent.aggregateId, current),
        ),
      )
      .orderBy(asc(domainEvent.sequence))
      .limit(1);
    if (!ev?.from) return current;
    current = ev.from;
  }
  return current;
}

type RestoreLot = {
  id: string;
  daysCredited: string;
  daysTaken: string;
  status: ToilAccrualStatus;
  expiresOn: string;
  workedDate: string;
};

/**
 * THE READ-ONLY HALF of `restoreReplacementLeaveTx`: which lots would take the credit back, and a refusal —
 * naming every blocking credit and its expiry date — if any of them no longer can. Writes nothing.
 *
 * Ported from build/r279-credit (13d9e3bb, cross-check 8aafa414) and changed in one respect: the allocation
 * is read against the CONSUMPTION ROOT (see `consumptionRootRequestIdTx`), not the request id handed in, so
 * a segment that survived an earlier partial cancellation gives back what its original request took.
 *
 * WHERE THE ALLOCATION COMES FROM. Consumption records the FIFO split in one place only: one `toil.consumed`
 * event per lot, `{ requestId, daysConsumed }`, the lot as aggregate. The register cannot answer "how much
 * did THIS request take from THIS lot" (`taken_by_request_id` is set only on a lot consumed in full), so the
 * events are read; `domain_event` is append-only and carries `sequence` for a deterministic order.
 *
 * REVERSE FIFO: consumption walks earliest-expiry first, the give-back walks the same list backwards, so the
 * employee gets back the credit with the most life left in it.
 */
async function planReplacementLeaveRestore(
  tx: Tx,
  ctx: SessionContext,
  p: { employmentId: string; requestId: string; need: number; asOf: string },
): Promise<{ root: string; plan: { accrualId: string; take: number }[]; byId: Map<string, RestoreLot> }> {
  // r299 fix pass — AN EMPLOYEE WHO NEVER HELD A CREDIT HAS NOTHING TO GIVE BACK, so nothing below is read. The
  // event reads that follow filter domain_event by event type and JSON payload, which no index serves, and since
  // finalizeLeaveApproval reads the type's ROLE every cancellation of a role-classified Replacement Leave reaches
  // here — including on a tenant without the module, where the register is empty.
  if (!(await employmentHoldsCreditsTx(tx, ctx.tenantId, p.employmentId))) {
    return { root: p.requestId, plan: [], byId: new Map() };
  }
  const root = await consumptionRootRequestIdTx(tx, ctx, p.requestId);

  // 1 · what the root request took, per lot, in the order it took it.
  const consumed = await tx
    .select({
      accrualId: domainEvent.aggregateId,
      days: sql<string>`${domainEvent.payload} ->> 'daysConsumed'`,
      seq: domainEvent.sequence,
    })
    .from(domainEvent)
    .where(
      and(
        eq(domainEvent.tenantId, ctx.tenantId),
        eq(domainEvent.eventType, 'toil.consumed'),
        sql`${domainEvent.payload} ->> 'requestId' = ${root}`,
      ),
    )
    .orderBy(asc(domainEvent.sequence));

  // 2 · what earlier give-backs of the same root already returned (partial cancellation is iterative).
  const restoredAlready = await tx
    .select({ accrualId: domainEvent.aggregateId, days: sql<string>`${domainEvent.payload} ->> 'daysRestored'` })
    .from(domainEvent)
    .where(
      and(
        eq(domainEvent.tenantId, ctx.tenantId),
        eq(domainEvent.eventType, 'toil.restored'),
        sql`${domainEvent.payload} ->> 'requestId' = ${root}`,
      ),
    );
  const backBy = new Map<string, number>();
  for (const r of restoredAlready) backBy.set(r.accrualId, round2((backBy.get(r.accrualId) ?? 0) + Number(r.days ?? 0)));

  // 2b · THE CROSS-CHECK (8aafa414). A caller who can see the register but not the events would find no
  // allocation, restore nothing and hand the ledger credit back with no lot behind it — the ghost credit this
  // function exists to prevent. `taken_by_request_id` is the independent witness: a lot stamped with the
  // root that the events did not account for means the event record could not be read whole, so refuse.
  const stamped = await tx
    .select({ id: toilAccrual.id, workedDate: toilAccrual.workedDate })
    .from(toilAccrual)
    .where(eq(toilAccrual.takenByRequestId, root));
  const seen = new Set(consumed.map((c) => c.accrualId));
  const unaccounted = stamped.filter((r) => !seen.has(r.id));
  if (unaccounted.length > 0) {
    throw new ReplacementLeaveRestoreBlockedError(
      `this replacement leave cannot be given back: the record of which credits it used could not be read in full (${unaccounted
        .map((r) => r.workedDate)
        .join(', ')}). An HR administrator can cancel it.`,
      unaccounted.map((r) => ({ workedDate: r.workedDate, expiresOn: null, state: 'unreadable' as const })),
    );
  }

  // 3 · the plan, built whole before any write so the refusal names every blocking lot at once.
  const plan: { accrualId: string; take: number }[] = [];
  const byId = new Map<string, RestoreLot>();
  let remaining = round2(p.need);
  for (let i = consumed.length - 1; i >= 0 && remaining > 0; i--) {
    const c = consumed[i];
    const available = round2(Number(c.days ?? 0) - (backBy.get(c.accrualId) ?? 0));
    if (available <= 0) continue;
    const take = round2(Math.min(available, remaining));
    plan.push({ accrualId: c.accrualId, take });
    // Consumed twice from the same lot is not possible (one event per lot per approval), but the running
    // back-off keeps a duplicate from being planned twice if it ever were.
    backBy.set(c.accrualId, round2((backBy.get(c.accrualId) ?? 0) + take));
    remaining = round2(remaining - take);
  }

  if (plan.length > 0) {
    const rows = await tx
      .select({
        id: toilAccrual.id,
        daysCredited: toilAccrual.daysCredited,
        daysTaken: toilAccrual.daysTaken,
        status: toilAccrual.status,
        expiresOn: toilAccrual.expiresOn,
        workedDate: toilAccrual.workedDate,
      })
      .from(toilAccrual)
      .where(inArray(toilAccrual.id, plan.map((x) => x.accrualId)));
    for (const r of rows) byId.set(r.id, r as RestoreLot);

    // 3b · THE REFUSAL, per lot, with the date. Three ways a lot stops being able to hold a credit: swept to
    // 'lapsed', settled to 'converted_to_pay', or past its frozen expiry and not yet swept (the sweep is a
    // manual admin action). Re-crediting an expired lot for a First-Schedule employee would hand the next
    // sweep a day to convert to CASH — a cancellation silently creating a payroll liability.
    const blocked: string[] = [];
    const blocks: RestoreBlock[] = [];
    for (const step of plan) {
      const row = byId.get(step.accrualId);
      if (!row) {
        blocked.push('a credit behind this leave no longer exists');
        blocks.push({ workedDate: null, expiresOn: null, state: 'missing' });
        continue;
      }
      if (row.status === 'lapsed' || row.status === 'converted_to_pay') {
        blocked.push(
          `the credit earned on ${row.workedDate} ${row.status === 'lapsed' ? 'expired' : 'was paid out when it expired'} on ${row.expiresOn}`,
        );
        blocks.push({ workedDate: row.workedDate, expiresOn: row.expiresOn, state: row.status === 'lapsed' ? 'expired' : 'paid_out' });
        continue;
      }
      if (row.status === 'reversed') {
        blocked.push(`the credit earned on ${row.workedDate} has been reversed`);
        blocks.push({ workedDate: row.workedDate, expiresOn: row.expiresOn, state: 'reversed' });
        continue;
      }
      if (row.expiresOn < p.asOf) {
        blocked.push(`the credit earned on ${row.workedDate} expired on ${row.expiresOn}`);
        blocks.push({ workedDate: row.workedDate, expiresOn: row.expiresOn, state: 'expired' });
      }
    }
    if (blocked.length > 0) {
      throw new ReplacementLeaveRestoreBlockedError(
        `this replacement leave cannot be given back: ${[...new Set(blocked)].join('; ')}`,
        blocks,
      );
    }
  }
  return { root, plan, byId };
}

/**
 * "Could this Replacement Leave be given back today?" — the read-only gate the employee's cancellation
 * REQUEST runs, so the refusal lands on the employee's own screen rather than days later under a manager's
 * approval button. Throws `ReplacementLeaveRestoreBlockedError`; returns silently otherwise, including when
 * the register holds nothing to give back (a ghost credit is cancellable: the ledger gave, the ledger takes back).
 */
export async function assertReplacementLeaveRestorableTx(
  tx: Tx,
  ctx: SessionContext,
  p: { employmentId: string; requestId: string; need: number; asOf: string },
): Promise<void> {
  if (round2(p.need) <= 0) return;
  await planReplacementLeaveRestore(tx, ctx, p);
}

/**
 * 3fb1a611 (r299) · GIVE THE CREDIT BACK when an approved Replacement Leave is cancelled — the inverse of
 * `consumeReplacementLeaveTx`, and the reason approved replacement leave could not be cancelled at all
 * before this round (core/leave.ts refused it three times over, correctly: giving the DAY back through the
 * ledger without giving the CREDIT back to the register leaves a balance with no lot behind it).
 *
 * The caller has already written the ledger give-back; this updates the register only. A lot that was fully
 * consumed returns to 'active' and releases `taken_by_request_id`. Refuses the whole give-back, naming every
 * blocking credit and its expiry date, rather than half-restoring (see `planReplacementLeaveRestore`).
 * No register rows to give back is NOT an error: it logs `toil.restore.shortfall`, mirroring consumption.
 */
export async function restoreReplacementLeaveTx(
  tx: Tx,
  ctx: SessionContext,
  p: { employmentId: string; requestId: string; need: number; effectiveOn: string; asOf: string },
): Promise<RestoreReplacementResult> {
  const need = round2(p.need);
  if (need <= 0) return { restored: 0, lotsRestored: 0, reactivated: 0, shortfall: 0 };
  // r299 fix pass — no register, no shortfall to record: the leave was never paid for with credits.
  if (!(await employmentHoldsCreditsTx(tx, ctx.tenantId, p.employmentId))) {
    return { restored: 0, lotsRestored: 0, reactivated: 0, shortfall: need };
  }
  const { root, plan, byId } = await planReplacementLeaveRestore(tx, ctx, { ...p, need });

  let restored = 0;
  let reactivated = 0;
  // Several steps can land on one lot only through a duplicate event; track the live tally so a second step
  // subtracts from what the first left, never from the stale read.
  const takenNow = new Map<string, number>();
  for (const step of plan) {
    const row = byId.get(step.accrualId)!;
    const before = takenNow.get(row.id) ?? Number(row.daysTaken);
    const newTaken = round2(Math.max(0, before - step.take));
    takenNow.set(row.id, newTaken);
    const wasTaken = row.status === 'taken';
    await tx
      .update(toilAccrual)
      .set({
        daysTaken: newTaken.toFixed(2),
        ...(wasTaken ? { status: 'active' as ToilAccrualStatus, takenByRequestId: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(toilAccrual.id, row.id));
    if (wasTaken) {
      row.status = 'active';
      reactivated += 1;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'toil-accrual',
      aggregateId: row.id,
      eventType: 'toil.restored',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: {
        // The CONSUMPTION ROOT, so a later give-back of another segment of the same leave subtracts this one.
        requestId: root,
        cancelledRequestId: p.requestId,
        daysRestored: step.take,
        daysTaken: newTaken,
        reactivated: wasTaken,
        workedDate: row.workedDate,
        expiresOn: row.expiresOn,
        effectiveOn: p.effectiveOn,
      },
    });
    restored = round2(restored + step.take);
  }

  const shortfall = round2(Math.max(0, need - restored));
  if (shortfall > 0) {
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'toil-accrual',
      aggregateId: p.requestId,
      eventType: 'toil.restore.shortfall',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { requestId: root, cancelledRequestId: p.requestId, need, restored, shortfall, effectiveOn: p.effectiveOn },
    });
  }
  return { restored, lotsRestored: plan.length, reactivated, shortfall };
}

// ─── Leave Credit: HR adds, previews and reverses credits (3fb1a611, r299) ─────────────────────────────

/** A Leave Credit action refused for a reason the screen should show as-is. */
export class LeaveCreditError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'LeaveCreditError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Is this employee within the First Schedule (s.2 wages at or below the country pack's OT wage ceiling)? */
async function firstScheduleEligibleTx(
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

/**
 * Is the caller an administrator FOR THIS EMPLOYEE'S COMPANY? (`app.can_admin_employment`, migration 0016.)
 *
 * Asked explicitly by the three HR actions below because migration 0469 WIDENED the register's write policy to
 * admit a non-self line manager (so approvals can write it). `isAdminCtx` only says "an admin somewhere": an
 * hr_admin scoped to company A who also manages someone in company B would otherwise pass it AND the widened
 * RLS for that B employee. Adding, previewing and reversing a credit are HR powers for the employee's own
 * company, so they are refused here in the service rather than left to a policy that now answers a different
 * question.
 */
async function assertAdminForEmploymentTx(tx: Tx, employmentId: string, action: string): Promise<void> {
  const res = await tx.execute(sql`SELECT app.can_admin_employment(${employmentId}::uuid) AS ok`);
  if (!(res as unknown as { ok: boolean }[])[0]?.ok) {
    throw new ToilSweepForbiddenError(`Only an HR administrator for this employee's company may ${action}.`);
  }
}

/**
 * r300 (3fb1a611) — HAS PAYROLL BEEN STARTED, ANYWHERE IN THE TENANT, FOR THE DATE'S MONTH OR THE NEXT?
 *
 * A credit and that day's overtime pay are mutually exclusive, but payroll honours that only at PREFILL time:
 * `payroll_input.overtime_amount` is a per-batch aggregate with no per-day attribution, a re-run prefill updates
 * only employees who still have overtime rows (it never zeroes a stale figure), a processed run is not
 * re-prefilled and a closed one cannot be written. The r300 verifier measured every shape of the r299 draft
 * allowance paying the day twice (add after a prefill) or not at all (reverse after one), and a transferred
 * employee's OLD company paying overtime the new company then suppressed. So HR's add and reverse are REFUSED on
 * a date with recorded overtime once any run exists for the date's month or the next (a cut-off schedule can
 * carry late-month overtime forward) — draft included, any company. Conservative by design: it can refuse a
 * sister company's employee, and HR's remedy is to act before payroll starts or delete a draft first.
 *
 * Asked through app.payroll_run_exists_for_periods (migration 0470, SECURITY DEFINER): payroll_batch RLS shows a
 * run only to an admin for its company, so asking under RLS would let a company-scoped admin miss a sister
 * company's run. The function answers yes/no for the caller's tenant and reveals nothing else.
 */
async function payrollStartedForDateTx(tx: Tx, workedDate: string): Promise<boolean> {
  const [y, m] = workedDate.slice(0, 7).split('-').map(Number);
  const month = workedDate.slice(0, 7);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const res = await tx.execute(
    sql`SELECT app.payroll_run_exists_for_periods(ARRAY[${month}, ${next}]::text[]) AS started`,
  );
  return (res as unknown as { started: boolean }[])[0]?.started === true;
}

/**
 * r299 fix pass — HR may not add or reverse a Leave Credit on THEIR OWN record. Cancelling leave (core/leave.ts)
 * and approvals already refuse the self case; a credit is worse, because for an employee within the First
 * Schedule it becomes cash on expiry and the HR form ticks the consent box. Refused in the service, whatever
 * RLS would allow.
 */
function assertNotOwnRecord(ctx: SessionContext, employeePersonId: string | null | undefined, action: string): void {
  if (ctx.personId && employeePersonId && ctx.personId === employeePersonId) {
    throw new ToilSweepForbiddenError(`You cannot ${action} on your own record. Another HR administrator must do it.`);
  }
}

/** Recorded overtime on one attendance day (0 when there is no row). */
async function overtimeMinutesOnTx(tx: Tx, employmentId: string, date: string): Promise<number> {
  const [att] = await tx
    .select({ otMinutes: attendance.otMinutes })
    .from(attendance)
    .where(and(eq(attendance.employmentId, employmentId), eq(attendance.attendanceDate, date)))
    .limit(1);
  return Math.max(0, att?.otMinutes ?? 0);
}

export type LeaveCreditPreview = {
  workedDayKind: ToilWorkedDayKind;
  /** false ⇒ an ordinary working day: the Add form refuses it. */
  eligibleDay: boolean;
  /** ⚠️ MONEY: overtime already recorded on the date. A credit suppresses its pay (EXCLUDE_TOIL_BANKED_DAYS). */
  overtimeMinutes: number;
  /** The policy's expiry counted from today — what the form pre-fills. NULL when the company has no enabled policy. */
  defaultExpiresOn: string | null;
  policyEnabled: boolean;
  /** Within the First Schedule: a credit needs the company override AND the employee's recorded agreement. */
  firstSchedule: boolean;
  allowFirstSchedule: boolean;
  /** An unreversed credit already exists for this employee and date. */
  alreadyCredited: boolean;
};

/**
 * What the Add Leave Credit form shows BEFORE save, for one employee and date: the kind of day, whether
 * overtime is already recorded on it (and so would stop being paid), the default expiry, and whether the
 * statutory floor applies. Read-only; admin-only because it reads a wage-derived fact.
 */
export async function previewLeaveCredit(
  ctx: SessionContext,
  p: { employmentId: string; workedDate: string; approvedOn?: Date },
): Promise<LeaveCreditPreview> {
  if (!isAdminCtx(ctx)) throw new ToilSweepForbiddenError('Only an HR administrator may add a Leave Credit.');
  if (!ISO_DATE.test(p.workedDate)) throw new LeaveCreditError('Enter a valid date worked.');
  return withTenant(ctx, async (tx) => {
    await assertAdminForEmploymentTx(tx, p.employmentId, 'add a Leave Credit');
    const [emp] = await tx
      .select({ companyId: employment.companyId, country: company.country, personId: employment.personId })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!emp) throw new LeaveCreditError('That employee could not be found.');
    assertNotOwnRecord(ctx, emp.personId, 'add a Leave Credit');
    const kind = await resolveWorkedDayKindTx(tx, p.employmentId, p.workedDate);
    const [policy] = await tx.select().from(toilPolicy).where(eq(toilPolicy.companyId, emp.companyId)).limit(1);
    const approvedOnDate = todayInKualaLumpur(p.approvedOn ?? new Date());
    const [dupe] = await tx
      .select({ id: toilAccrual.id })
      .from(toilAccrual)
      .where(
        and(
          eq(toilAccrual.employmentId, p.employmentId),
          eq(toilAccrual.workedDate, p.workedDate),
          ne(toilAccrual.status, 'reversed'),
        ),
      )
      .limit(1);
    return {
      workedDayKind: kind,
      eligibleDay: kind !== 'workday',
      overtimeMinutes: await overtimeMinutesOnTx(tx, p.employmentId, p.workedDate),
      // The same arithmetic bankToilCreditTx applies on save (approval instant → resolveExpiry), so the date
      // the form pre-fills is the date an untouched save freezes.
      defaultExpiresOn: policy?.enabled ? resolveExpiry(approvedOnDate, policy) : null,
      policyEnabled: policy?.enabled === true,
      firstSchedule: await firstScheduleEligibleTx(tx, { employmentId: p.employmentId, country: emp.country, asOf: p.workedDate }),
      allowFirstSchedule: policy?.allowFirstScheduleEligible === true,
      alreadyCredited: dupe != null,
    };
  });
}

export type GrantLeaveCreditResult = AccrueToilResult & {
  workedDayKind: ToilWorkedDayKind;
  /** ⚠️ MONEY: the overtime minutes on the worked date whose pay this credit has just suppressed (0 if none). */
  overtimeSuppressedMinutes: number;
};

/**
 * 3fb1a611 (r299) · + ADD LEAVE CREDIT — HR adds a credit for a day an employee worked and never claimed.
 * Ported from build/r279-credit's grantToilCreditManually (13d9e3bb, 07a0a69a), with the approved plan's rules:
 *
 *  · ADMIN, for the employee's company. `isAdminCtx` here; the register INSERT's RLS (`can_admin_employment`
 *    or a non-self line manager, migration 0469) is the company-scoped check underneath, and an hr_admin
 *    scoped to another company cannot see the employment at all.
 *  · MODULE-GATED. Adding a credit is accrual — a new obligation — so it sits with `accrueToil`, not with the
 *    two settlement sweeps.
 *  · A DATE WORKED IS REQUIRED, not in the future, and it must be a REST DAY, OFF DAY OR PUBLIC HOLIDAY for
 *    that employee — the same rule the employee's own request now meets. An ordinary working day is refused.
 *  · THE FIRST SCHEDULE FLOOR IS NOT BYPASSED. Everything below goes through `bankToilCreditTx`, the executor
 *    every earning path shares: an employee at or below the wage ceiling needs the company override AND their
 *    own recorded agreement (`firstScheduleConsent`), exactly as on the request path.
 *  · EXPIRY defaults to the policy's period counted from today; HR may type another, never before the date
 *    worked.
 *  · ⚠️ MONEY: if the date carries recorded overtime, this credit SUPPRESSES that overtime's pay
 *    (core/payroll.ts EXCLUDE_TOIL_BANKED_DAYS, both reads, unconditional). The form says so before save
 *    (`previewLeaveCredit`); the figure comes back here too so the banner can repeat it.
 */
export async function grantLeaveCredit(
  ctx: SessionContext,
  p: {
    employmentId: string;
    workedDate: string;
    days: number;
    reason: string;
    remarks?: string;
    /** Typed by HR; omitted ⇒ the policy's period counted from the approval (today). */
    expiresOn?: string;
    firstScheduleConsent?: boolean;
    /** Injected for tests; the tenant-local date the "not in the future" check is judged against. */
    today?: string;
    approvedOn?: Date;
  },
): Promise<GrantLeaveCreditResult> {
  if (!isAdminCtx(ctx)) throw new ToilSweepForbiddenError('Only an HR administrator may add a Leave Credit.');
  assertModuleEnabled(ctx, 'toil');
  const today = p.today ?? todayInKualaLumpur();
  const days = round2(Number(p.days));
  if (!Number.isFinite(days) || days <= 0 || days > 366)
    throw new LeaveCreditError('The credit amount must be more than 0 and no more than 366 days.');
  const reason = p.reason?.trim();
  if (!reason) throw new LeaveCreditError('A reason is required when adding a Leave Credit.');
  if (!ISO_DATE.test(p.workedDate ?? '')) throw new LeaveCreditError('Enter the date worked.');
  if (p.workedDate > today) throw new LeaveCreditError('The date worked cannot be in the future.');
  const expiresOn = p.expiresOn?.trim() || undefined;
  if (expiresOn !== undefined) {
    if (!ISO_DATE.test(expiresOn)) throw new LeaveCreditError('Enter a valid expiry date.');
    if (expiresOn < p.workedDate) throw new LeaveCreditError('The expiry date cannot be before the date worked.');
  }

  return withTenant(ctx, async (tx) => {
    await assertAdminForEmploymentTx(tx, p.employmentId, 'add a Leave Credit');
    const [emp] = await tx
      .select({
        companyId: employment.companyId,
        country: company.country,
        personId: employment.personId,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
      })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!emp) throw new LeaveCreditError('That employee could not be found.');
    assertNotOwnRecord(ctx, emp.personId, 'add a Leave Credit');
    // r299 fix pass — a credit is for a day the employee WORKED for this employment.
    if (p.workedDate < emp.hiredOn || (emp.terminatedOn != null && p.workedDate > emp.terminatedOn)) {
      throw new LeaveCreditError(`The date worked must fall within this employee's service (${emp.hiredOn} onwards${emp.terminatedOn ? `, until ${emp.terminatedOn}` : ''}).`);
    }
    const kind = await resolveWorkedDayKindTx(tx, p.employmentId, p.workedDate);
    if (kind === 'workday') throw new ToilOrdinaryWorkingDayError([p.workedDate]);
    const overtime = await overtimeMinutesOnTx(tx, p.employmentId, p.workedDate);
    if (overtime > 0 && (await payrollStartedForDateTx(tx, p.workedDate))) {
      throw new LeaveCreditError(
        `${p.workedDate} has overtime recorded, and payroll for that month has already been started. A credit for a day with overtime can only be added before its payroll is started, or it could pay the day twice — as overtime and as leave. If that payroll is still a draft, delete it, add the credit, then start the payroll again.`,
      );
    }
    const result = await bankToilCreditTx(tx, ctx, {
      employmentId: p.employmentId,
      workedDate: p.workedDate,
      companyId: emp.companyId,
      country: emp.country,
      // r299 fix pass — NULL for the same reason as the request path: the valuation must not price HR's typed
      // credit from the day's overtime minutes (0.5 day with 8h overtime was valued as a full day's cash).
      dayType: null,
      workedDayKind: kind,
      // The measured overtime when the day has any (what a statutory convert-to-pay should be valued from);
      // otherwise the declared credit in standard-day minutes, the request path's convention.
      otMinutes: overtime > 0 ? overtime : Math.round(days * STD_DAY_MINUTES),
      declaredDays: days,
      approvedOn: p.approvedOn,
      // There is no employee request behind a hand-added credit; the worked day is the only date in evidence,
      // the same answer the roster election gives.
      requestedOn: p.workedDate,
      firstScheduleConsent: p.firstScheduleConsent === true,
      source: 'hr_manual_grant',
      note: reason,
      remarks: p.remarks,
      expiresOnOverride: expiresOn,
    });
    return { ...result, workedDayKind: kind, overtimeSuppressedMinutes: overtime };
  });
}

export type ReverseLeaveCreditResult = {
  accrualId: string;
  employmentId: string;
  workedDate: string;
  daysReversed: number;
  reversalLedgerEntryId: string;
  /** ⚠️ MONEY: overtime minutes on the worked date that are payable again (0 if none was recorded). */
  overtimeRestoredMinutes: number;
};

/**
 * 3fb1a611 (r299) · REVERSE A CREDIT — WITHOUT DELETING ANYTHING.
 *
 * The reporter: "the original line stays, marked Reversed, and a reversal line is added beside it". So:
 *   · an offsetting `leave_ledger` debit for the whole credit, dated the day of the reversal (the balance
 *     authority nets to zero for this credit and keeps both rows);
 *   · the register row's status → 'reversed', with when, why, and the id of that debit. The row is NOT
 *     deleted — build/r279-credit's reverseToilCredit deleted it, which the plan rejects, and it would have
 *     been the first delete path under 0314's RLS;
 *   · `toil.reversed` on the audit log, naming the actor.
 *
 * ⚠️ MONEY. core/payroll.ts EXCLUDE_TOIL_BANKED_DAYS skips a 'reversed' credit, so the worked day's overtime
 * is payable again from the next prefill. That is the point of reversing, and it is pinned by a test.
 *
 * ONLY AN UNUSED, UNEXPIRED CREDIT, of ANY source (earned through a request, the roster, attendance, or added
 * by HR — the approved mockup offers Reverse on both). A used or partly used credit is refused with "cancel
 * the leave that used it first"; an expired, paid-out or already reversed one is refused naming its state.
 *
 * NOT module-gated, like the settlement sweeps and for their reason: undoing a wrong credit must not become
 * unreachable because the add-on lapsed. Admin-only, in the service.
 */
export async function reverseLeaveCredit(
  ctx: SessionContext,
  p: { accrualId: string; reason: string; today?: string },
): Promise<ReverseLeaveCreditResult> {
  if (!isAdminCtx(ctx)) throw new ToilSweepForbiddenError('Only an HR administrator may reverse a Leave Credit.');
  const reason = p.reason?.trim();
  if (!reason) throw new LeaveCreditError('A reason is required when reversing a Leave Credit.');
  const today = p.today ?? todayInKualaLumpur();

  return withTenant(ctx, async (tx) => {
    const [acc] = await tx.select().from(toilAccrual).where(eq(toilAccrual.id, p.accrualId)).limit(1);
    if (!acc) throw new LeaveCreditError('That Leave Credit could not be found.');
    await assertAdminForEmploymentTx(tx, acc.employmentId, 'reverse a Leave Credit');
    const [owner] = await tx
      .select({ personId: employment.personId })
      .from(employment)
      .where(eq(employment.id, acc.employmentId))
      .limit(1);
    assertNotOwnRecord(ctx, owner?.personId, 'reverse a Leave Credit');
    if (acc.status === 'reversed') throw new LeaveCreditError('That Leave Credit has already been reversed.');
    if (acc.status === 'taken' || (acc.status === 'active' && Number(acc.daysTaken) > 0)) {
      throw new LeaveCreditError(
        'That Leave Credit has been used by Replacement Leave, so it cannot be reversed. Cancel the leave that used it first.',
      );
    }
    if (acc.status === 'lapsed') throw new LeaveCreditError(`That Leave Credit expired on ${acc.expiresOn} and cannot be reversed.`);
    if (acc.status === 'converted_to_pay')
      throw new LeaveCreditError(`That Leave Credit was paid out when it expired on ${acc.expiresOn} and cannot be reversed.`);
    if (acc.expiresOn < today) throw new LeaveCreditError(`That Leave Credit expired on ${acc.expiresOn} and cannot be reversed.`);
    // r299 fix pass — a reversal only puts the overtime back if payroll has not already worked that date out
    // without it. See payrollRunHoldingOvertimeTx.
    if ((await overtimeMinutesOnTx(tx, acc.employmentId, acc.workedDate)) > 0 && (await payrollStartedForDateTx(tx, acc.workedDate))) {
      throw new LeaveCreditError(
        `${acc.workedDate} has overtime recorded, and payroll for that month has already been started without it. Reversing the credit now could leave that overtime unpaid. If that payroll is still a draft, delete it, reverse the credit, then start the payroll again.`,
      );
    }

    const days = round2(Number(acc.daysCredited));
    // The ledger row the credit wrote tells us which leave type it sits on; fall back to the tenant's
    // replacement type for a legacy row with no link.
    const [orig] = acc.ledgerEntryId
      ? await tx.select({ leaveTypeId: leaveLedger.leaveTypeId }).from(leaveLedger).where(eq(leaveLedger.id, acc.ledgerEntryId)).limit(1)
      : [];
    const leaveTypeId = orig?.leaveTypeId ?? (await ensureReplacementLeaveType(tx, ctx.tenantId));
    const [debit] = await tx
      .insert(leaveLedger)
      .values({
        tenantId: ctx.tenantId,
        employmentId: acc.employmentId,
        leaveTypeId,
        entryType: 'debit',
        days: (-days).toFixed(2),
        effectiveOn: today,
      })
      .returning({ id: leaveLedger.id });

    // Guarded on the state just checked, so a consumption racing this reversal cannot be overwritten.
    const updated = await tx
      .update(toilAccrual)
      .set({
        status: 'reversed',
        reversedAt: new Date(),
        reversalReason: reason,
        reversalLedgerEntryId: debit.id,
        updatedAt: new Date(),
      })
      .where(and(eq(toilAccrual.id, acc.id), eq(toilAccrual.status, 'active'), eq(toilAccrual.daysTaken, acc.daysTaken)))
      .returning({ id: toilAccrual.id });
    if (updated.length !== 1) throw new LeaveCreditError('That Leave Credit changed while it was being reversed. Reload and try again.');

    const overtime = await overtimeMinutesOnTx(tx, acc.employmentId, acc.workedDate);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'toil-accrual',
      aggregateId: acc.id,
      eventType: 'toil.reversed',
      actor: actorOf(ctx),
      subjectEmploymentId: acc.employmentId,
      payload: {
        reason,
        workedDate: acc.workedDate,
        workedDayKind: acc.workedDayKind,
        daysReversed: days,
        expiresOn: acc.expiresOn,
        source: acc.source,
        ledgerEntryId: debit.id,
        creditLedgerEntryId: acc.ledgerEntryId,
        // ⚠️ MONEY, on the audit record: the worked day's overtime is payable again.
        overtimeRestoredMinutes: overtime,
      },
    });
    return {
      accrualId: acc.id,
      employmentId: acc.employmentId,
      workedDate: acc.workedDate,
      daysReversed: days,
      reversalLedgerEntryId: debit.id,
      overtimeRestoredMinutes: overtime,
    };
  });
}

/** 3fb1a611 (dd3af33d on build/r279-credit) — "Expiring soon" means within this many days, inclusive. */
export const EXPIRING_SOON_DAYS = 30;

/**
 * The unused Replacement Leave credit that expires within `EXPIRING_SOON_DAYS` of `today` — the Apply form's
 * "Expiring soon" figure. Only active credits, only their REMAINING part (a partly used credit counts what is
 * left), and not one already past its date (that is expired, not expiring).
 */
export async function replacementExpiringSoonTx(tx: Tx, employmentId: string, today: string): Promise<number> {
  const [row] = await tx
    .select({ days: sql<string>`coalesce(sum(${toilAccrual.daysCredited} - ${toilAccrual.daysTaken}), 0)` })
    .from(toilAccrual)
    .where(
      and(
        eq(toilAccrual.employmentId, employmentId),
        eq(toilAccrual.status, 'active'),
        gte(toilAccrual.expiresOn, today),
        lte(toilAccrual.expiresOn, addDays(today, EXPIRING_SOON_DAYS)),
      ),
    );
  return round2(Math.max(0, Number(row?.days ?? 0)));
}

// ─── Leave Credit history: DERIVED from the ledger (3fb1a611, r299) ────────────────────────────────────

export const LEAVE_CREDIT_MOVEMENTS = [
  'earned_request',
  'earned_roster',
  'earned_attendance',
  'earned_other',
  'added_hr',
  'used',
  'returned',
  'reversed',
  'expired',
  'paid_out',
  'other',
] as const;
export type LeaveCreditMovement = (typeof LEAVE_CREDIT_MOVEMENTS)[number];
export type LeaveCreditStatus = 'available' | 'used' | 'reversed' | 'expired' | 'paid_out';

export type LeaveCreditMovementRow = {
  ledgerEntryId: string;
  employmentId: string;
  employeeName: string;
  employeeCode: string | null;
  leaveTypeId: string;
  /** The ledger row's effective date — the DATE column. */
  effectiveOn: string;
  /** When the row was written (ISO instant) — the "when" beside who did it. */
  recordedAt: string;
  movement: LeaveCreditMovement;
  accrualId: string | null;
  workedDate: string | null;
  workedDayKind: ToilWorkedDayKind | null;
  balanceBefore: number;
  days: number;
  balanceAfter: number;
  expiresOn: string | null;
  reason: string | null;
  actorName: string | null;
  actorIsSystem: boolean;
  status: LeaveCreditStatus | null;
  /** The Reverse action is offered: an unused, unexpired, unreversed credit line. */
  reversible: boolean;
};

const round2Days = (n: string | number) => round2(Number(n));

/**
 * 3fb1a611 (r299) · EVERY LEAVE CREDIT MOVEMENT, with balance before and after — DERIVED, not stored.
 *
 * ONE LEDGER. The rows are the Replacement Leave type's `leave_ledger` rows (the balance authority), and
 * nothing here is written anywhere. Each row is described by what it links to:
 *   · toil_accrual.ledger_entry_id          → the credit itself: earned through a request / the roster /
 *                                             attendance, or added by HR (source);
 *   · toil_accrual.reversal_ledger_entry_id → a reversal line;
 *   · toil_accrual.settled_ledger_entry_id  → the expiry sweep's line: expired, or paid out;
 *   · leave_ledger.source_request_id        → Replacement Leave: used (negative) or returned on cancellation
 *                                             (positive);
 *   · none of the above                     → other (a Leave Adjustment from before this round, an import,
 *                                             or an expiry swept before the settlement link existed).
 *
 * THE RUNNING TOTAL'S ORDER, stated because a backdated row changes "before" for every later row by design:
 * per (employee, leave type), `effective_on`, then `created_at`, then `id`. The last row's "after" equals
 * `leaveBalance` for that pair; every row's "after" is the balance of the rows up to and including it in that
 * order. The DISPLAY order is newest first; the arithmetic is not affected by it or by the filters, which are
 * applied after the totals are taken over the employee's whole history.
 *
 * WHO. `leave_ledger` has no created-by column, so the actor is the `domain_event` written IN THE SAME
 * TRANSACTION for the same employee: both default to `now()`, which is the transaction's start instant, so
 * `occurred_at = created_at` identifies it exactly. Every writer of these rows appends such an event.
 */
export async function listLeaveCreditMovements(
  ctx: SessionContext,
  p: {
    companyIds?: string[];
    employmentId?: string;
    movement?: LeaveCreditMovement;
    from?: string;
    to?: string;
    today?: string;
    limit?: number;
  } = {},
): Promise<{ rows: LeaveCreditMovementRow[]; matched: number; truncated: boolean }> {
  const today = p.today ?? todayInKualaLumpur();
  const limit = p.limit ?? 500;
  return withTenant(ctx, async (tx) => {
    if (p.companyIds && p.companyIds.length === 0) return { rows: [], matched: 0, truncated: false };
    const types = await tx
      .select({ id: leaveType.id })
      .from(leaveType)
      .where(
        sql`(${leaveType.role} = 'replacement' or (coalesce(${leaveType.role}, '') = '' and upper(${leaveType.code}) = 'REPLACEMENT'))`,
      );
    if (types.length === 0) return { rows: [], matched: 0, truncated: false };

    const ledger = await tx
      .select({
        id: leaveLedger.id,
        employmentId: leaveLedger.employmentId,
        leaveTypeId: leaveLedger.leaveTypeId,
        days: leaveLedger.days,
        effectiveOn: leaveLedger.effectiveOn,
        createdAt: leaveLedger.createdAt,
        sourceRequestId: leaveLedger.sourceRequestId,
        ledgerReason: leaveLedger.reason,
        employeeName: person.fullName,
        employeeCode: employment.employeeCode,
        actorType: sql<string | null>`(
          select de.actor_type::text from domain_event de
           where de.tenant_id = ${leaveLedger.tenantId}
             and de.subject_employment_id = ${leaveLedger.employmentId}
             and de.occurred_at = ${leaveLedger.createdAt}
           order by de.sequence limit 1)`,
        actorId: sql<string | null>`(
          select de.actor_id::text from domain_event de
           where de.tenant_id = ${leaveLedger.tenantId}
             and de.subject_employment_id = ${leaveLedger.employmentId}
             and de.occurred_at = ${leaveLedger.createdAt}
           order by de.sequence limit 1)`,
      })
      .from(leaveLedger)
      .innerJoin(employment, eq(employment.id, leaveLedger.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          inArray(leaveLedger.leaveTypeId, types.map((t) => t.id)),
          p.companyIds && p.companyIds.length ? inArray(employment.companyId, p.companyIds) : undefined,
          p.employmentId ? eq(leaveLedger.employmentId, p.employmentId) : undefined,
        ),
      )
      .orderBy(
        asc(leaveLedger.employmentId),
        asc(leaveLedger.leaveTypeId),
        asc(leaveLedger.effectiveOn),
        asc(leaveLedger.createdAt),
        asc(leaveLedger.id),
      );
    if (ledger.length === 0) return { rows: [], matched: 0, truncated: false };

    const empIds = [...new Set(ledger.map((r) => r.employmentId))];
    const accruals = await tx
      .select({
        id: toilAccrual.id,
        workedDate: toilAccrual.workedDate,
        workedDayKind: toilAccrual.workedDayKind,
        dayType: toilAccrual.dayType,
        expiresOn: toilAccrual.expiresOn,
        status: toilAccrual.status,
        source: toilAccrual.source,
        daysTaken: toilAccrual.daysTaken,
        note: toilAccrual.note,
        reversalReason: toilAccrual.reversalReason,
        ledgerEntryId: toilAccrual.ledgerEntryId,
        reversalLedgerEntryId: toilAccrual.reversalLedgerEntryId,
        settledLedgerEntryId: toilAccrual.settledLedgerEntryId,
      })
      .from(toilAccrual)
      .where(inArray(toilAccrual.employmentId, empIds));
    type Acc = (typeof accruals)[number];
    const byCredit = new Map<string, Acc>();
    const byReversal = new Map<string, Acc>();
    const bySettled = new Map<string, Acc>();
    for (const a of accruals) {
      if (a.ledgerEntryId) byCredit.set(a.ledgerEntryId, a);
      if (a.reversalLedgerEntryId) byReversal.set(a.reversalLedgerEntryId, a);
      if (a.settledLedgerEntryId) bySettled.set(a.settledLedgerEntryId, a);
    }

    // The employee's stated reason on an earned-through-a-request credit.
    const requestReasonByAccrual = new Map<string, string | null>();
    if (accruals.length) {
      const reqs = await tx
        .select({ accrualId: replacementLeaveRequestDate.accrualId, reason: replacementLeaveRequest.reason })
        .from(replacementLeaveRequestDate)
        .innerJoin(replacementLeaveRequest, eq(replacementLeaveRequest.id, replacementLeaveRequestDate.requestId))
        .where(inArray(replacementLeaveRequestDate.accrualId, accruals.map((a) => a.id)));
      for (const r of reqs) if (r.accrualId) requestReasonByAccrual.set(r.accrualId, r.reason ?? null);
    }
    // The leave's own reason on a used / returned line.
    const requestIds = [...new Set(ledger.map((r) => r.sourceRequestId).filter((x): x is string => x != null))];
    const leaveReasonById = new Map<string, string | null>();
    if (requestIds.length) {
      const lrs = await tx
        .select({ id: leaveRequest.id, reason: leaveRequest.reason })
        .from(leaveRequest)
        .where(inArray(leaveRequest.id, requestIds));
      for (const r of lrs) leaveReasonById.set(r.id, r.reason ?? null);
    }
    // Actor names: app_user → person.
    const userIds = [...new Set(ledger.map((r) => r.actorId).filter((x): x is string => x != null))];
    const nameByUser = new Map<string, string>();
    if (userIds.length) {
      const us = await tx
        .select({ id: appUser.id, name: person.fullName })
        .from(appUser)
        .leftJoin(person, eq(person.id, appUser.personId))
        .where(inArray(appUser.id, userIds));
      for (const u of us) if (u.name) nameByUser.set(u.id, u.name);
    }

    const statusOf = (a: Acc): LeaveCreditStatus =>
      a.status === 'taken'
        ? 'used'
        : a.status === 'lapsed'
          ? 'expired'
          : a.status === 'converted_to_pay'
            ? 'paid_out'
            : a.status === 'reversed'
              ? 'reversed'
              : 'available';
    const kindOf = (a: Acc): ToilWorkedDayKind | null => a.workedDayKind ?? (a.dayType as ToilWorkedDayKind | null) ?? null;

    const all: LeaveCreditMovementRow[] = [];
    let runKey = '';
    let running = 0;
    for (const r of ledger) {
      const key = `${r.employmentId}|${r.leaveTypeId}`;
      if (key !== runKey) {
        runKey = key;
        running = 0;
      }
      const days = round2Days(r.days);
      const before = running;
      running = round2(running + days);

      let movement: LeaveCreditMovement = 'other';
      let acc: Acc | undefined;
      let reason: string | null = null;
      let status: LeaveCreditStatus | null = null;
      let reversible = false;
      if ((acc = byCredit.get(r.id))) {
        movement =
          acc.source === 'employee_request'
            ? 'earned_request'
            : acc.source === 'hr_manual_grant'
              ? 'added_hr'
              : acc.source === 'roster'
                ? 'earned_roster'
                : acc.source === 'auto_approval'
                  ? 'earned_attendance'
                  : 'earned_other';
        reason = acc.source === 'hr_manual_grant' ? acc.note : (requestReasonByAccrual.get(acc.id) ?? null);
        status = statusOf(acc);
        reversible = acc.status === 'active' && Number(acc.daysTaken) === 0 && acc.expiresOn >= today;
      } else if ((acc = byReversal.get(r.id))) {
        movement = 'reversed';
        reason = acc.reversalReason;
        status = 'reversed';
      } else if ((acc = bySettled.get(r.id))) {
        movement = acc.status === 'converted_to_pay' ? 'paid_out' : 'expired';
        status = acc.status === 'converted_to_pay' ? 'paid_out' : 'expired';
      } else if (r.sourceRequestId) {
        movement = days < 0 ? 'used' : 'returned';
        reason = leaveReasonById.get(r.sourceRequestId) ?? null;
        status = days < 0 ? 'used' : null;
      } else {
        // A machine code (`sys:…`) is not a reason a person gave.
        reason = r.ledgerReason && !r.ledgerReason.startsWith('sys:') ? r.ledgerReason : null;
      }
      all.push({
        ledgerEntryId: r.id,
        employmentId: r.employmentId,
        employeeName: r.employeeName,
        employeeCode: r.employeeCode ?? null,
        leaveTypeId: r.leaveTypeId,
        effectiveOn: r.effectiveOn,
        recordedAt: r.createdAt.toISOString(),
        movement,
        accrualId: acc?.id ?? null,
        workedDate: acc?.workedDate ?? null,
        workedDayKind: acc ? kindOf(acc) : null,
        balanceBefore: before,
        days,
        balanceAfter: running,
        expiresOn: movement === 'reversed' || movement === 'used' || movement === 'returned' ? null : (acc?.expiresOn ?? null),
        reason,
        actorName: r.actorId ? (nameByUser.get(r.actorId) ?? null) : null,
        actorIsSystem: r.actorType === 'system',
        status,
        reversible,
      });
    }

    const filtered = all.filter(
      (row) =>
        (!p.movement || row.movement === p.movement) &&
        (!p.from || row.effectiveOn >= p.from) &&
        (!p.to || row.effectiveOn <= p.to),
    );
    // Newest first for reading; ties broken the same way the running total is, reversed.
    filtered.sort((a, b) =>
      a.effectiveOn !== b.effectiveOn
        ? b.effectiveOn.localeCompare(a.effectiveOn)
        : a.recordedAt !== b.recordedAt
          ? b.recordedAt.localeCompare(a.recordedAt)
          : b.ledgerEntryId.localeCompare(a.ledgerEntryId),
    );
    return { rows: filtered.slice(0, limit), matched: filtered.length, truncated: filtered.length > limit };
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
  /**
   * Accruals that were DUE and VISIBLE to this caller but that `SETTLEABLE_BY_CALLER` left behind
   * because the caller cannot administer their company (review r3). Zero for a platform-wide admin.
   *
   * Reported rather than inferred because the alternative is indistinguishable from success. Narrowing
   * the read to the write set is what stops a dual-scoped operator rolling the whole transaction back —
   * but it also turns "three employees' statutory convert-to-pay obligations were skipped" into the same
   * `processed: 0` an admin sees when nothing was due. `closeReplacementLeaveYear` has never had this
   * problem: it writes a per-company `replacement-leave-year.closed` marker naming exactly what it
   * swept, so a partial run is legible in the event log. This is that signal, for the sweep that
   * discharges an already-incurred statutory liability.
   *
   * WHAT IT DELIBERATELY DOES NOT COUNT, because a figure that overstated its own reach would be worse
   * than no figure. The counting query runs inside the same `withTenant` transaction as the sweep, so
   * both are bounded by `toil_accrual`'s base READ policy. It therefore measures exactly the rows
   * `SETTLEABLE_BY_CALLER` removes ON TOP of what the caller could already see — the predicate slice 3
   * added, and the only new blindness. Rows the base policy hides (an hr_admin scoped to company A
   * simply cannot see company B's accruals at all) were never visible to this sweep before slice 3
   * either; counting them would require a privilege this session does not hold, and pretending to
   * would be the reassuring-figure failure this slice keeps finding. So: non-zero means "you can see
   * work you may not do"; zero means "nothing was hidden from you by the settle predicate", NOT
   * "nothing is outstanding anywhere in the tenant".
   */
  skippedOutOfScope: number;
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
  /** 296fc027: NULL on a self-declared (employee-request) credit — no attendance row, so no day type. */
  dayType: 'workday' | 'rest_day' | 'holiday' | null;
  otMinutes: number;
  /** 3fb1a611: the kind of day that earned it — lets the valuation note name an OFF day rather than call it unknown. */
  workedDayKind?: ToilWorkedDayKind | null;
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
  if (rows.length === 0)
    return { processed: 0, converted: 0, lapsed: 0, convertedDays: 0, convertedAmount: 0, skippedOutOfScope: 0 };

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

  // Phase-B #14: resolve the OT body per distinct country once (the eligibility ceiling + the two configurable
  // excess-hours multipliers). The exact statutory entitlement only governs a First-Schedule employee (wages ≤
  // ceiling); above it, OT comp is contractual and the generic ORP × banked-days basis is kept unchanged.
  type OtBody = { wageCeiling: number; restDayExcessMultiplier?: number; holidayExcessMultiplier?: number };
  const otByCountry = new Map<string | null, OtBody>();
  for (const country of new Set(countryBy.values())) {
    const pack = packFor(country);
    const ot = pack ? (await pack.payroll.loadRuleset(tx, { asOf })).ot : { wageCeiling: 4000 };
    otByCountry.set(country, ot);
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
    const ot = otByCountry.get(country) ?? { wageCeiling: 4000 };
    const ceiling = ot.wageCeiling;
    const pack = packFor(country);
    // 296fc027 · AN UNKNOWN DAY TYPE CANNOT BE VALUED STATUTORILY, so it is not pretended otherwise. A
    // self-declared credit (the employee-request path) has no attendance row behind it and therefore no
    // day type, and the exact s.60(3)/s.60D(3) cash is a FUNCTION of the day type — rest day and public
    // holiday pay at different multiples. Guessing one would produce a confident, wrong statutory figure
    // on a legal obligation. Falling back to the contractual ORP × banked-days basis is the honest answer,
    // and `valuationNote` on the event says the day type was self-declared so the admin reconciles it by
    // hand at pay time rather than trusting a number the system could not derive.
    if (a.dayType != null && pack && wages > 0 && wages <= ceiling) {
      // Exact statutory cash for the worked day-type (s.60(3) rest day, s.60D(3) holiday, s.60A workday OT).
      // The two configurable excess-hours multipliers (ADR-0019 ot ruleset) are threaded so TOIL cash-out
      // never diverges from what the same day would earn in payroll.
      const otp = pack.payroll.overtimePay({
        monthlyWages: wages,
        days: [{ dayType: a.dayType, minutes: a.otMinutes }],
        wageCeiling: ceiling,
        restDayExcessMultiplier: ot.restDayExcessMultiplier,
        holidayExcessMultiplier: ot.holidayExcessMultiplier,
      });
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
    // 3fb1a611: the debit's id is recorded on the credit (`settled_ledger_entry_id`) so the Leave Credit
    // history can say which credit an Expired / Paid out line belongs to.
    const [settled] = await tx
      .insert(leaveLedger)
      .values({
        tenantId: ctx.tenantId,
        employmentId: a.employmentId,
        leaveTypeId: replacementTypeId,
        entryType: 'debit',
        days: (-days).toFixed(2),
        effectiveOn: asOf,
      })
      .returning({ id: leaveLedger.id });
    // Phase-B #14: exact s.60(3)/s.60D(3) cash for a First-Schedule employee (statutory_exact); generic
    // ORP × banked-days for > ceiling staff (generic_orp). Basis is recorded on the event for auditability.
    const owed = convert ? convertAmountFor(a) : { amount: 0, basis: 'generic_orp' as const };
    const amount = owed.amount;
    await tx
      .update(toilAccrual)
      .set({ status: convert ? 'converted_to_pay' : 'lapsed', settledLedgerEntryId: settled.id })
      .where(eq(toilAccrual.id, a.id));
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
        ledgerEntryId: settled.id,
        ...(a.workedDayKind ? { workedDayKind: a.workedDayKind } : {}),
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
                  : a.workedDayKind === 'off_day'
                    ? // 3fb1a611: an OFF day IS recorded, but this repo's verified statutory sources
                      // (docs/architecture/STATUTORY-SOURCES.md §6) state no rule for off-day work, so no
                      // exact figure is claimed — ORP basis, named as an off day for the person reconciling.
                      'Off day: ORP computed at close-run wages. No exact statutory figure for off-day work is recorded in this system — verify before paying.'
                    : a.dayType == null
                      ? // 296fc027: a self-declared credit. The day type was never recorded, so the exact
                        // statutory cash for it cannot be computed — this is the contractual ORP basis and
                        // needs a human to reconcile it if the employee is within the First Schedule.
                        'Self-declared replacement leave with no recorded day type: ORP computed at close-run wages. The exact statutory overtime cash could not be derived — verify the worked day before paying.'
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
  // `skippedOutOfScope: 0` — this helper is handed the rows to sweep and knows nothing about which ones
  // a caller could not see. `runToilExpiry` owns that question and overlays the real figure.
  return { processed: converted + lapsed, converted, lapsed, convertedDays, convertedAmount, skippedOutOfScope: 0 };
}

/**
 * SELECT WHAT YOU MAY WRITE. Both statutory sweeps below read a set of `status='active'` accruals and
 * then UPDATE every row they got back, i.e. they assume visibility implies writability. On
 * `toil_accrual` those are two DIFFERENT predicates and always have been: the read side is
 * `app.can_see_employment` (admin-for-company OR SELF OR the recursive administrative-manager chain,
 * 0109) while the write side is `app.can_admin_employment` (admin-for-company only, 0016), and 0314
 * adds `app.can_admin_payroll_employment` to the read side as well.
 *
 * So a caller who clears `isAdminCtx` but holds hr_admin in company A while ALSO being an employee of,
 * or a manager in, or a payroll partner for, company B selects B's rows and cannot update them. The
 * UPDATE does not skip those rows — it raises "new row violates row-level security policy" and rolls
 * the whole transaction back, taking company A's settlement with it. G5 claims the TOIL statutory floor
 * is reachable when the module is revoked; for a dual-scoped operator it would not have been reachable
 * at all, and the failure is an unhandled 500 rather than a partial result.
 *
 * Slice 3 is what makes this live, exactly as with the payroll-partner read gap: both functions used to
 * open with `if (!toilEnabled()) throw`, and TOIL_ENABLED is set in no tracked env file, so the path
 * refused everyone. Adding the write predicate to the read makes the two sets identical, so a row this
 * caller cannot settle is never picked up and the companies they CAN settle still settle.
 */
const SETTLEABLE_BY_CALLER = sql`app.can_admin_employment(${toilAccrual.employmentId})`;

/**
 * Expire active TOIL accruals whose expiry date has arrived. Each follows its FROZEN expiry_action via
 * `expireAccrualsTx`. Only the still-unspent remainder (`daysCredited − daysTaken`) is debited — consumed days
 * already flipped to 'taken' on consumption. Idempotent — only `status='active'` rows are touched, so
 * re-running is safe. `today` is injected for deterministic tests.
 *
 * UNGATED as of ADR-0077 slice 3 (F15), deliberately, and for the same reason as payroll's
 * `excludeToilDays`. This sweep is how an ALREADY-INCURRED liability gets discharged: for a
 * First-Schedule-eligible employee, unused TOIL must convert to pay and may never lapse (see
 * ELIGIBLE_FLOOR / `onExpiry: 'convert_to_pay'` above) — that is statutory, not a product feature.
 *
 * Gating it on the entitlement would have meant a tenant whose TOIL module lapses (trial end,
 * downgrade, non-payment) can no longer settle the days its employees already banked: the sweep
 * throws, and app/admin/toil/page.tsx hides the button that calls it, so the obligation becomes
 * unreachable through every path while the debt stays on the books. Under the old deployment flag
 * that took an operator editing .env; a per-tenant entitlement makes it an ordinary commercial event.
 *
 * What the entitlement still governs is NEW accrual and the UI — you can stop banking TOIL, you
 * cannot strand what was already banked. Safe when the module is off and always was: with no accrual
 * rows there is nothing due and this returns zeros.
 *
 * UNGATED IS NOT UNGUARDED. Removing the entitlement check removed the only check that was on this
 * path, so an explicit admin assertion replaces it — see `ToilSweepForbiddenError`. The two are
 * different questions ("did this tenant buy TOIL?" vs. "may this caller settle it?") and only the
 * second one should have been answered here all along.
 */
export async function runToilExpiry(ctx: SessionContext, p: { today: string }): Promise<ToilExpiryResult> {
  if (!isAdminCtx(ctx)) throw new ToilSweepForbiddenError();
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
        workedDayKind: toilAccrual.workedDayKind,
      })
      .from(toilAccrual)
      .where(and(eq(toilAccrual.status, 'active'), lte(toilAccrual.expiresOn, p.today), SETTLEABLE_BY_CALLER));
    const rows: SweepRow[] = due.map((d) => ({
      id: d.id,
      employmentId: d.employmentId,
      remaining: round2(Number(d.daysCredited) - Number(d.daysTaken)),
      expiryAction: d.expiryAction,
      workedDate: d.workedDate,
      dayType: d.dayType as 'workday' | 'rest_day' | 'holiday',
      otMinutes: d.otMinutes,
      workedDayKind: d.workedDayKind,
    }));
    // THE RESIDUE, COUNTED (review r3). Identical predicate MINUS `SETTLEABLE_BY_CALLER`, so the
    // difference is exactly the accruals that were due and that this caller's company scope hid. Both
    // reads run inside the same `withTenant` transaction, so tenant RLS still applies to both and this
    // can never count another tenant's rows. Without it a company-scoped admin sees the same
    // `processed: 0` for "nothing was due" and for "someone else's statutory convert-to-pay obligations
    // are three days overdue and I am not allowed to settle them" — and a sweep that silently settles a
    // subset should say which subset.
    const [dueAll] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(toilAccrual)
      .where(and(eq(toilAccrual.status, 'active'), lte(toilAccrual.expiresOn, p.today)));
    const result = await expireAccrualsTx(tx, ctx, rows, p.today);
    return { ...result, skippedOutOfScope: Math.max(0, Number(dueAll?.n ?? 0) - rows.length) };
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
 * Idempotency beyond "no active rows left": a `replacement-leave-year.closed` marker event per
 * (boundary, COMPANY) makes a re-fire (or a race against `runToilExpiry`) a true no-op rather than
 * incidentally safe.
 */
/**
 * UNGATED for the same reason as `runToilExpiry` — the year-end floor settles an incurred statutory
 * liability, so a lapsed entitlement must not be able to strand it. See that function's note. And
 * ADMIN-ONLY for the same reason too: the entitlement gate was the only check on this path, so removing
 * it needed an authorization check to replace it, not nothing.
 *
 * THE MARKER IS PER COMPANY, AND THE GRAIN IS THE WHOLE POINT (ADR-0077 slice 3 review). It used to be
 * one tenant-wide marker keyed on `payload->>'asOf'` alone, while the accrual SELECT below runs under
 * `toil_accrual_rls` → `can_see_employment` → `is_admin_for(company)`, which is COMPANY-SCOPED. Those
 * two grains do not match, and the mismatch is not academic: an hr_admin delegated to one company of a
 * group swept only that company's accruals and wrote a marker that claimed the entire tenant. Every
 * later close for that boundary — including the group admin's — returned `alreadyClosed: true` and
 * settled nothing, and `domain_event` has UPDATE/DELETE REVOKEd from `ai_hr_app`, so there is no way
 * back through the product. The First-Schedule convert-to-pay obligation that ungating this function
 * exists to protect would have been permanently unreachable for every other company in the group.
 *
 * So a marker now claims exactly what it swept: one per company that had visible active accruals at
 * this boundary, carrying `companyId` in the payload. A marker with NO `companyId` is a pre-slice-3
 * tenant-wide one and is still honoured as closing everything, so an already-closed boundary on a live
 * deployment does not silently re-open.
 */
export async function closeReplacementLeaveYear(
  ctx: SessionContext,
  p: { asOf: string },
): Promise<CloseReplacementYearResult> {
  if (!isAdminCtx(ctx)) throw new ToilSweepForbiddenError();
  return withTenant(ctx, async (tx) => {
    const empty: CloseReplacementYearResult = {
      processed: 0, converted: 0, lapsed: 0, convertedDays: 0, convertedAmount: 0, skippedOutOfScope: 0,
      alreadyClosed: false, carriedForward: 0,
    };

    // Idempotency guard beyond "no active rows left": a prior close marker for this exact boundary ⇒ true
    // no-op (so a re-fire, or a race against runToilExpiry, is genuinely idempotent, not incidentally safe).
    // Read ALL of them, not `limit(1)`, because the grain is per company now.
    const markers = await tx
      .select({ companyId: sql<string | null>`${domainEvent.payload} ->> 'companyId'` })
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.tenantId, ctx.tenantId),
          eq(domainEvent.eventType, 'replacement-leave-year.closed'),
          sql`${domainEvent.payload} ->> 'asOf' = ${p.asOf}`,
        ),
      );
    const closedCompanies = new Set(markers.map((m) => m.companyId).filter((c): c is string => c != null));
    // A legacy marker (no companyId) closed the whole tenant. Honour it verbatim rather than re-opening
    // a boundary an earlier release already recorded as closed.
    const closedTenantWide = markers.some((m) => m.companyId == null);
    if (closedTenantWide) return { ...empty, alreadyClosed: true };

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
        workedDayKind: toilAccrual.workedDayKind,
        hiredOn: employment.hiredOn,
        companyId: employment.companyId,
        leaveCycle: company.leaveCycle,
      })
      .from(toilAccrual)
      .innerJoin(employment, eq(employment.id, toilAccrual.employmentId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(and(eq(toilAccrual.status, 'active'), SETTLEABLE_BY_CALLER));

    // Companies this caller can actually see accruals for. A company with no visible active accrual is
    // NOT in scope and gets no marker — that is what stops a partial sweep from claiming the group.
    const inScope = active.filter((a) => !closedCompanies.has(a.companyId));
    const scopeCompanies = [...new Set(inScope.map((a) => a.companyId))].sort();
    // Everything this caller could close at this boundary already carries a marker ⇒ a genuine
    // idempotent re-fire.
    //
    // DECIDED FROM THE MARKERS, NOT FROM THE LEFTOVER ACCRUALS (slice 3 review r2). This used to read
    // `active.length > 0 && scopeCompanies.length === 0`, which silently skipped the ORDINARY re-fire:
    // once a close has actually settled everything, `expireAccrualsTx` has flipped every row to
    // 'converted_to_pay'/'lapsed', so `active` is EMPTY, the condition never fires, no marker is
    // consulted, and the function returns `alreadyClosed: false` — the marker guard this docblock calls
    // "a true no-op rather than incidentally safe" was back to being incidentally safe on the one path
    // that matters. app/admin/toil/page.tsx branches on exactly this field, so a re-run of a completed
    // close reported "closed 0 accruals" instead of "already closed".
    if (markers.length > 0 && scopeCompanies.length === 0) return { ...empty, alreadyClosed: true };

    let carriedForward = 0;
    // Each row carries its own per-company boundary; calendar rows resolve to `asOf`, anniversary rows to the
    // employee's own cycle start. We branch per row so a mixed-cycle tenant closes every company correctly.
    const rows: (SweepRow & { boundary: string; companyId: string })[] = [];
    for (const a of inScope) {
      if (a.carryForwardAtYearEnd) {
        carriedForward += 1;
        continue; // survives the close — frozen opt-in carry-forward
      }
      const boundary = a.leaveCycle === 'anniversary' ? earnedCycleStart(a.hiredOn, p.asOf, 'anniversary') : p.asOf;
      rows.push({
        id: a.id,
        employmentId: a.employmentId,
        companyId: a.companyId,
        remaining: round2(Number(a.daysCredited) - Number(a.daysTaken)),
        expiryAction: a.expiryAction,
        workedDate: a.workedDate,
        dayType: a.dayType as 'workday' | 'rest_day' | 'holiday',
        otMinutes: a.otMinutes,
        workedDayKind: a.workedDayKind,
        boundary,
      });
    }

    // Sweep each row at its own per-company boundary, accumulating a PER-COMPANY subtotal as well as the
    // run total: the marker each company gets below must describe what was settled for THAT company, or
    // it is the same overstatement one grain down.
    const zero = (): ToilExpiryResult => ({ processed: 0, converted: 0, lapsed: 0, convertedDays: 0, convertedAmount: 0, skippedOutOfScope: 0 });
    const add = (x: ToilExpiryResult, y: ToilExpiryResult): ToilExpiryResult => ({
      processed: x.processed + y.processed,
      converted: x.converted + y.converted,
      lapsed: x.lapsed + y.lapsed,
      convertedDays: round2(x.convertedDays + y.convertedDays),
      convertedAmount: round2(x.convertedAmount + y.convertedAmount),
      // Always 0 on this path, and that is a statement rather than an oversight: this sweep already
      // reports its scope truthfully, by writing one `replacement-leave-year.closed` marker per company
      // it actually swept. `runToilExpiry` has no such marker, which is why it needs the count.
      skippedOutOfScope: x.skippedOutOfScope + y.skippedOutOfScope,
    });
    let agg = zero();
    const perCompany = new Map<string, ToilExpiryResult>();
    for (const r of rows) {
      const part = await expireAccrualsTx(tx, ctx, [r], r.boundary);
      agg = add(agg, part);
      perCompany.set(r.companyId, add(perCompany.get(r.companyId) ?? zero(), part));
    }

    // ONE MARKER PER COMPANY SWEPT; the per-accrual toil.converted/toil.lapsed rows are the audit (mirrors
    // the leave-year.opened skip comment). `aggregateId` is the COMPANY, so the event log reads as "this
    // company's replacement-leave year was closed" — which is the fact, and which the previous version's
    // tenant aggregateId overstated.
    for (const companyId of scopeCompanies) {
      const ofCompany = inScope.filter((a) => a.companyId === companyId);
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'replacement-leave-year',
        aggregateId: companyId,
        eventType: 'replacement-leave-year.closed',
        actor: actorOf(ctx),
        // leaveCycle is per-company (bug #19), so with the marker per company it is a single value rather
        // than a set. `companyId` is the idempotency key alongside `asOf`.
        payload: {
          asOf: p.asOf,
          companyId,
          leaveCycle: ofCompany[0]?.leaveCycle ?? null,
          carriedForward: ofCompany.filter((a) => a.carryForwardAtYearEnd).length,
          ...(perCompany.get(companyId) ?? zero()),
        },
      });
    }
    return { ...agg, alreadyClosed: false, carriedForward };
  });
}
