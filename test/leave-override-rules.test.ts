/**
 * Override Leave Application (feedback 56910869) — the engine, and its first two rules.
 *
 * HR configures, per leave type, what the system does when one of that type's rules is NOT met. Each rule is
 * a (trigger, action) pair with its own switch; several per type, so one type can BOTH convert on short
 * notice AND split on insufficient balance. This file pins the four things the item turns on:
 *
 *  1. DEFAULT OFF IS ABSOLUTE. A configured-but-disabled rule, and a type with no rules at all, must produce
 *     byte-identical behaviour to before the engine existed. That is the whole promise of shipping the two
 *     absorbed items switched off, and it is asserted first because everything else is a change.
 *  2. THE TRIGGERS FIRE ON THE ENGINE'S OWN CONDITIONS, not on re-implemented ones — the advance-notice gate
 *     (65f466e2) and the submit-time balance guard (fef49b9a).
 *  3. CONSENT IS A SERVICE CONCERN. A rule that CHANGES an application is refused without the employee's
 *     explicit token, before anything is persisted, exactly as UnpaidConsentRequiredError already works. A
 *     client that skips the pop-out cannot submit a silently-converted application.
 *  4. THE CONVERSION ROUTES THROUGH THE EXISTING ENGINE. A converted application deducts from the source
 *     configured on Emergency Leave (Annual) — because Emergency is a CATEGORY, not an entitlement — and it
 *     is permanently distinguishable from an application filed as Emergency Leave in the first place.
 *
 * Harness note (mirrors leave-min-advance / leave-balance-source-upl): requestLeave's WITH CHECK RLS is
 * app.can_see_employment, so the applicant ctx must OWN the employmentId. Balance is seeded with an accrual
 * leave_ledger row through the owner connection (bypasses RLS).
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  requestLeave,
  decideLeave,
  leaveBalance,
  previewLeaveDeduction,
  hasAnyLeaveTypeRule,
  leaveTypeRuleColumns,
  LeaveAdvanceNoticeRequiredError,
  LeaveOverrideConsentRequiredError,
  LeaveOverrideTargetMissingError,
  InsufficientLeaveBalanceOnSubmitError,
} from '../core/leave';
import {
  LEAVE_OVERRIDE_ACTIONS_BY_TRIGGER,
  leaveOverrideConsentToken,
  normalizeLeaveOverrideRules,
  resolveLeaveOverrideRule,
  validateLeaveOverrideRules,
  type LeaveOverrideRule,
} from '../core/leave-override';
import { updateLeaveType } from '../core/admin';
import { listLeaveTypes } from '../core/read';
import { withTenant } from '../db/client';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

/** Today, and two spans: one INSIDE the notice period and one that misses it. */
const TODAY = '2026-06-15';
/** 1 day of notice — misses a 7-day requirement. */
const SHORT_START = '2026-06-16';
const SHORT_END = '2026-06-17';
/** 30 days of notice — comfortably meets it. */
const AMPLE_START = '2026-07-15';
const AMPLE_END = '2026-07-16';

const CONVERT = leaveOverrideConsentToken('advance_notice_not_met', 'convert_to_emergency');
const SPLIT = leaveOverrideConsentToken('insufficient_balance', 'split_unpaid');

async function hireEmployeeCtx(): Promise<{ ctx: SessionContext; employmentId: string }> {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Ovr', primaryEmail: `ovr_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

function uniqCode(): string {
  return `OV_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

/** Calendar-counted type so the day math is trivial (1 calendar day == 1 leave day). */
async function leaveType(opts: {
  minAdvanceDays?: number | null;
  /** 7daac043: the UNIT the notice requirement is read in. Omitted ⇒ NULL ⇒ calendar days, which is what
   *  every case in this file assumed before that item and still assumes. */
  minAdvanceDayType?: 'calendar_days' | 'working_days' | null;
  overrideRules?: LeaveOverrideRule[] | null;
  allowNegativeBalance?: boolean;
  allowUnpaidLeave?: boolean;
  code?: string;
}): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: opts.code ?? uniqCode(),
      name: opts.code ?? 'Override Test Type',
      paid: true,
      counting: 'calendar_days',
      // Default: opt OUT of the submit-time balance gate, so a test about the NOTICE rule is never
      // accidentally answered by the balance rule. The balance tests override it.
      allowNegativeBalance: opts.allowNegativeBalance ?? true,
      allowUnpaidLeave: opts.allowUnpaidLeave ?? false,
      minAdvanceDays: opts.minAdvanceDays ?? null,
      minAdvanceDayType: opts.minAdvanceDayType ?? null,
      overrideRules: opts.overrideRules ?? null,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** The tenant's ANNUAL type (seeded by seedBase) plus a fresh EMERGENCY and UNPAID. */
async function emergencySetup(): Promise<{ el: string; upl: string; annual: string }> {
  const [el] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code: 'EMERGENCY', name: 'Emergency Leave', paid: true, counting: 'calendar_days' })
    .returning({ id: schema.leaveType.id });
  const [upl] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code: 'UNPAID', name: 'Unpaid Leave', paid: false, counting: 'calendar_days' })
    .returning({ id: schema.leaveType.id });
  const [annual] = await owner.db
    .select({ id: schema.leaveType.id })
    .from(schema.leaveType)
    .where(and(eq(schema.leaveType.tenantId, b.tenantId), eq(schema.leaveType.code, 'ANNUAL')));
  return { el: el.id, upl: upl.id, annual: annual.id };
}

async function grant(employmentId: string, leaveTypeId: string, days: number): Promise<void> {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days: days.toFixed(2),
    effectiveOn: '2020-01-01',
  });
}

async function requestRows(employmentId: string) {
  return owner.db
    .select({
      id: schema.leaveRequest.id,
      leaveTypeId: schema.leaveRequest.leaveTypeId,
      days: schema.leaveRequest.days,
      unpaidDays: schema.leaveRequest.unpaidDays,
    })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.employmentId, employmentId));
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

// ── The vocabulary ────────────────────────────────────────────────────────────────────────────────────
describe('56910869 · the rule vocabulary reads on the safe side of every ambiguity', () => {
  it('drops anything it does not recognise — an unreadable rule is NO rule, i.e. today\'s refusal', () => {
    expect(normalizeLeaveOverrideRules(null)).toEqual([]);
    expect(normalizeLeaveOverrideRules('nonsense')).toEqual([]);
    expect(normalizeLeaveOverrideRules([{ trigger: 'made_up', action: 'block', enabled: true }])).toEqual([]);
    // A pair the trigger does not admit ("split because the notice period was missed") describes no
    // arithmetic, so it is not carried as configuration the engine would silently ignore.
    expect(
      normalizeLeaveOverrideRules([{ trigger: 'advance_notice_not_met', action: 'split_unpaid', enabled: true }]),
    ).toEqual([]);
  });

  it('a missing or non-boolean `enabled` reads as OFF — the only reading that cannot invent behaviour', () => {
    expect(normalizeLeaveOverrideRules([{ trigger: 'insufficient_balance', action: 'block' }])[0].enabled).toBe(false);
    expect(
      normalizeLeaveOverrideRules([{ trigger: 'insufficient_balance', action: 'block', enabled: 'yes' }])[0].enabled,
    ).toBe(false);
  });

  it('collapses a duplicated pair to the first, so resolution cannot depend on which copy was read', () => {
    const rules = normalizeLeaveOverrideRules([
      { trigger: 'insufficient_balance', action: 'block', enabled: true },
      { trigger: 'insufficient_balance', action: 'block', enabled: false },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].enabled).toBe(true);
  });

  it('resolves only ENABLED rules', () => {
    const off = normalizeLeaveOverrideRules([
      { trigger: 'advance_notice_not_met', action: 'convert_to_emergency', enabled: false },
    ]);
    expect(resolveLeaveOverrideRule(off, 'advance_notice_not_met')).toBeNull();
    const on = normalizeLeaveOverrideRules([
      { trigger: 'advance_notice_not_met', action: 'convert_to_emergency', enabled: true },
    ]);
    expect(resolveLeaveOverrideRule(on, 'advance_notice_not_met')?.action).toBe('convert_to_emergency');
  });

  it('refuses two ENABLED actions for one trigger — a contradiction, not a precedence question', () => {
    expect(
      validateLeaveOverrideRules([
        { trigger: 'insufficient_balance', action: 'split_unpaid', enabled: true },
        { trigger: 'insufficient_balance', action: 'block', enabled: true },
      ]),
    ).toMatch(/Only one action/);
    // …but the same pair with one switched off is a legitimate saved configuration.
    expect(
      validateLeaveOverrideRules([
        { trigger: 'insufficient_balance', action: 'split_unpaid', enabled: true },
        { trigger: 'insufficient_balance', action: 'block', enabled: false },
      ]),
    ).toBeNull();
  });

  it('every trigger admits at least one action, and `block` is always one of them', () => {
    for (const [trigger, actions] of Object.entries(LEAVE_OVERRIDE_ACTIONS_BY_TRIGGER)) {
      expect(actions.length, trigger).toBeGreaterThan(0);
      // "Convert it to something else" is not always kinder than a clear refusal — blocking stays available
      // as an action on every trigger, deliberately.
      expect(actions, trigger).toContain('block');
    }
  });
});

// ── The (b) decision, pinned ──────────────────────────────────────────────────────────────────────────
describe('56910869 · override_rules is an APPLICATION rule, not a 9816a5ad ENTITLEMENT rule', () => {
  /**
   * THE DELIBERATE ANSWER, PINNED HERE BECAUSE IT IS THE ONE THAT LOOKS WRONG.
   *
   * `hasAnyLeaveTypeRule` / `leaveTypeRuleColumns` are the 9816a5ad ENTITLEMENT-rule overlay: whether a
   * type's own accrual method, carry cap, expiry, rounding and max balance REPLACE the grade policy's. A
   * type that carries none of them still resolves its entitlement from `leave_policy`.
   *
   * override_rules is not one of those. It decides what happens when an APPLICATION breaks a rule — the
   * same family as min_advance_days, allow_unpaid_leave, allow_negative_balance and
   * duplicate_application_policy, none of which are in either symbol either. Adding it would mean a type
   * whose ONLY setting is an override rule suddenly reads its entitlement rules from its own ten NULL
   * columns instead of from its policy — silently stripping its accrual method, carry cap and rounding.
   * That is the exact failure the two symbols exist to prevent, arriving from the other direction.
   *
   * So: it does NOT flip hasAnyLeaveTypeRule, and it is NOT in leaveTypeRuleColumns. Both halves are
   * asserted, because getting one right and the other wrong is the shape of the bug.
   */
  it('does not flip hasAnyLeaveTypeRule — a rule-less type stays rule-less for entitlement purposes', () => {
    expect(hasAnyLeaveTypeRule({} as never)).toBe(false);
    expect(
      hasAnyLeaveTypeRule({
        overrideRules: [{ trigger: 'advance_notice_not_met', action: 'convert_to_emergency', enabled: true }],
      } as never),
    ).toBe(false);
    // Control: a REAL entitlement rule still does flip it, so the assertion above is about this column and
    // not about a broken predicate.
    expect(hasAnyLeaveTypeRule({ roundingMethod: 'down' })).toBe(true);
  });

  it('is not part of the entitlement-rule select shape', () => {
    expect(Object.keys(leaveTypeRuleColumns)).not.toContain('overrideRules');
  });
});

// ── DEFAULT OFF ───────────────────────────────────────────────────────────────────────────────────────
describe('56910869 · DEFAULT OFF — nothing changes for any leave type until HR enables a rule', () => {
  it('no rules at all ⇒ the notice-period refusal is exactly what it was', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    await emergencySetup();
    const typeId = await leaveType({ minAdvanceDays: 7 });
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: typeId, startDate: SHORT_START, endDate: SHORT_END, today: TODAY }),
    ).rejects.toBeInstanceOf(LeaveAdvanceNoticeRequiredError);
    expect(await requestRows(employmentId)).toHaveLength(0);
  });

  it('a CONFIGURED BUT DISABLED convert rule changes nothing — same error, nothing persisted', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    await emergencySetup();
    const typeId = await leaveType({
      minAdvanceDays: 7,
      overrideRules: [{ trigger: 'advance_notice_not_met', action: 'convert_to_emergency', enabled: false }],
    });
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: typeId, startDate: SHORT_START, endDate: SHORT_END, today: TODAY }),
    ).rejects.toBeInstanceOf(LeaveAdvanceNoticeRequiredError);
    expect(await requestRows(employmentId)).toHaveLength(0);
  });

  it('a CONFIGURED BUT DISABLED split rule leaves the balance refusal in place', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const typeId = await leaveType({
      allowNegativeBalance: false,
      overrideRules: [{ trigger: 'insufficient_balance', action: 'split_unpaid', enabled: false }],
    });
    await grant(employmentId, typeId, 1);
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: typeId, startDate: AMPLE_START, endDate: AMPLE_END, today: TODAY }),
    ).rejects.toBeInstanceOf(InsufficientLeaveBalanceOnSubmitError);
    expect(await requestRows(employmentId)).toHaveLength(0);
  });
});

// ── Rule 1 (65f466e2): advance notice not met → Emergency Leave ───────────────────────────────────────
describe('56910869 rule 1 · advance notice not met (65f466e2)', () => {
  /** Annual-facing type with the conversion rule ON, and Emergency Leave pointed at ANNUAL's balance. */
  async function convertSetup() {
    const { el, annual } = await emergencySetup();
    await updateLeaveType(adminCtx(b), { id: el, name: 'Emergency Leave', balanceSourceTypeId: annual });
    const typeId = await leaveType({
      minAdvanceDays: 7,
      overrideRules: [{ trigger: 'advance_notice_not_met', action: 'convert_to_emergency', enabled: true }],
    });
    return { el, annual, typeId };
  }

  it('THE SERVICE REFUSES A CONVERTING RULE WITHOUT CONSENT, and persists nothing', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const { typeId } = await convertSetup();
    const err = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: typeId,
      startDate: SHORT_START,
      endDate: SHORT_END,
      today: TODAY,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LeaveOverrideConsentRequiredError);
    expect((err as LeaveOverrideConsentRequiredError).consentToken).toBe(CONVERT);
    expect((err as LeaveOverrideConsentRequiredError).toTypeName).toBe('Emergency Leave');
    // The employee is told WHAT they are agreeing to — the notice they gave against the notice required.
    expect((err as LeaveOverrideConsentRequiredError).minAdvanceDays).toBe(7);
    expect((err as LeaveOverrideConsentRequiredError).daysInAdvance).toBe(1);
    expect(await requestRows(employmentId)).toHaveLength(0);
  });

  it('consent for the OTHER rule is not consent for this one', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const { typeId } = await convertSetup();
    await expect(
      requestLeave(ctx, {
        employmentId,
        leaveTypeId: typeId,
        startDate: SHORT_START,
        endDate: SHORT_END,
        today: TODAY,
        overrideConsent: [SPLIT],
      }),
    ).rejects.toBeInstanceOf(LeaveOverrideConsentRequiredError);
    expect(await requestRows(employmentId)).toHaveLength(0);
  });

  it('WITH consent: ONE Emergency Leave application, and it still deducts the CONFIGURED SOURCE (Annual)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const { el, annual, typeId } = await convertSetup();
    await grant(employmentId, annual, 10);
    const { leaveRequestId } = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: typeId,
      startDate: SHORT_START,
      endDate: SHORT_END,
      today: TODAY,
      overrideConsent: [CONVERT],
    });
    const rows = await requestRows(employmentId);
    // ONE application, not two — the employee applied once and there is no second request to chase.
    expect(rows).toHaveLength(1);
    expect(rows[0].leaveTypeId).toBe(el);
    // THE DEDUCTION SOURCE IS THE POINT: Emergency is a CATEGORY, not an entitlement, so the 2 days come
    // off ANNUAL while the record itself says Emergency Leave.
    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    expect(await withTenant(adminCtx(b), (tx) => leaveBalance(tx, employmentId, annual))).toBe(8);
    expect(await withTenant(adminCtx(b), (tx) => leaveBalance(tx, employmentId, el))).toBe(0);
  });

  it('THE TRIGGER DOES NOT FIRE when the notice period IS met — an ordinary application on the chosen type', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const { typeId } = await convertSetup();
    await requestLeave(ctx, {
      employmentId,
      leaveTypeId: typeId,
      startDate: AMPLE_START,
      endDate: AMPLE_END,
      today: TODAY,
    });
    const rows = await requestRows(employmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].leaveTypeId).toBe(typeId);
    const payload = await latestEventPayload(b.tenantId, rows[0].id, 'leave-request.submitted');
    expect(payload?.leaveOverrideApplied).toBeUndefined();
  });

  it('THE AUDIT STAMP distinguishes a CONVERTED application from a natively-Emergency one', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const { el, annual, typeId } = await convertSetup();
    await grant(employmentId, annual, 20);

    const converted = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: typeId,
      startDate: SHORT_START,
      endDate: SHORT_END,
      today: TODAY,
      overrideConsent: [CONVERT],
    });
    const c = await latestEventPayload(b.tenantId, converted.leaveRequestId, 'leave-request.submitted');
    expect(c?.leaveOverrideApplied).toBe(true);
    expect(c?.overrideTrigger).toBe('advance_notice_not_met');
    expect(c?.overrideAction).toBe('convert_to_emergency');
    expect(c?.convertedFromLeaveTypeId).toBe(typeId);
    // The SAME trio the HR-side override stamps, because it is an override of the SAME rule — an auditor
    // querying "what went through despite the notice period" must find this one too.
    expect(c?.advanceNoticeOverride).toBe(true);
    expect(c?.daysInAdvance).toBe(1);
    expect(c?.minAdvanceDays).toBe(7);
    expect(typeof c?.overrideConsentAt).toBe('string');

    // …and an application the employee filed AS Emergency Leave carries none of it.
    const native = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: el,
      startDate: '2026-06-20',
      endDate: '2026-06-21',
      today: TODAY,
    });
    const n = await latestEventPayload(b.tenantId, native.leaveRequestId, 'leave-request.submitted');
    expect(n?.leaveOverrideApplied).toBeUndefined();
    expect(n?.convertedFromLeaveTypeId).toBeUndefined();
    expect(n?.advanceNoticeOverride).toBeUndefined();
  });

  it('BLOCK is a first-class action: the application is refused, clearly, and nothing is persisted', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    await emergencySetup();
    const typeId = await leaveType({
      minAdvanceDays: 7,
      overrideRules: [{ trigger: 'advance_notice_not_met', action: 'block', enabled: true }],
    });
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: typeId, startDate: SHORT_START, endDate: SHORT_END, today: TODAY }),
    ).rejects.toBeInstanceOf(LeaveAdvanceNoticeRequiredError);
    expect(await requestRows(employmentId)).toHaveLength(0);
  });

  it('a conversion rule with no Emergency Leave type to convert TO fails loudly, not silently', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const typeId = await leaveType({
      minAdvanceDays: 7,
      overrideRules: [{ trigger: 'advance_notice_not_met', action: 'convert_to_emergency', enabled: true }],
    });
    await expect(
      requestLeave(ctx, {
        employmentId,
        leaveTypeId: typeId,
        startDate: SHORT_START,
        endDate: SHORT_END,
        today: TODAY,
        overrideConsent: [CONVERT],
      }),
    ).rejects.toBeInstanceOf(LeaveOverrideTargetMissingError);
    expect(await requestRows(employmentId)).toHaveLength(0);
  });

  it('WITHOUT a balance source on EL the conversion re-enters the EXISTING cascade (Annual, then Unpaid)', async () => {
    // The cascade is the split behaviour fef49b9a describes, scoped today to Emergency applications. The
    // conversion routes INTO it rather than around it, so there is exactly one deduction path.
    const { ctx, employmentId } = await hireEmployeeCtx();
    const { annual } = await emergencySetup(); // EL left with NO balance source ⇒ it decomposes
    await grant(employmentId, annual, 10);
    const typeId = await leaveType({
      minAdvanceDays: 7,
      overrideRules: [{ trigger: 'advance_notice_not_met', action: 'convert_to_emergency', enabled: true }],
    });
    const res = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: typeId,
      startDate: SHORT_START,
      endDate: SHORT_END,
      today: TODAY,
      overrideConsent: [CONVERT],
    });
    expect(res.parentGroupId).not.toBeNull();
    const rows = await requestRows(employmentId);
    // The cascade's ANNUAL child — the deduction still lands on the configured source type.
    expect(rows.every((r) => r.leaveTypeId === annual)).toBe(true);
    // …and every child carries the conversion stamp, because the decomposition leaves no single row to look at.
    const payload = await latestEventPayload(b.tenantId, rows[0].id, 'leave-request.submitted');
    expect(payload?.leaveOverrideApplied).toBe(true);
    expect(payload?.convertedFromLeaveTypeId).toBe(typeId);
  });
});

// ── Rule 2 (fef49b9a): insufficient balance → unpaid split ────────────────────────────────────────────
describe('56910869 rule 2 · insufficient balance (fef49b9a)', () => {
  async function splitSetup() {
    return leaveType({
      allowNegativeBalance: false,
      overrideRules: [{ trigger: 'insufficient_balance', action: 'split_unpaid', enabled: true }],
    });
  }

  it('THE SERVICE REFUSES THE SPLIT WITHOUT CONSENT, and persists nothing', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const typeId = await splitSetup();
    await grant(employmentId, typeId, 1);
    const err = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: typeId,
      startDate: AMPLE_START,
      endDate: AMPLE_END,
      today: TODAY,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LeaveOverrideConsentRequiredError);
    expect((err as LeaveOverrideConsentRequiredError).consentToken).toBe(SPLIT);
    expect((err as LeaveOverrideConsentRequiredError).paidDays).toBe(1);
    expect((err as LeaveOverrideConsentRequiredError).unpaidDays).toBe(1);
    expect(await requestRows(employmentId)).toHaveLength(0);
  });

  it('WITH consent: ONE application carrying the unpaid remainder — no second splitter', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const typeId = await splitSetup();
    await grant(employmentId, typeId, 1);
    await requestLeave(ctx, {
      employmentId,
      leaveTypeId: typeId,
      startDate: AMPLE_START,
      endDate: AMPLE_END,
      today: TODAY,
      overrideConsent: [SPLIT],
    });
    const rows = await requestRows(employmentId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].days)).toBe(2);
    // The SAME leave_request.unpaid_days measurement a7fab30b already ships — the rule adds the question,
    // not a second arithmetic.
    expect(Number(rows[0].unpaidDays)).toBe(1);
  });

  it('THE TRIGGER DOES NOT FIRE when the balance covers the application', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const typeId = await splitSetup();
    await grant(employmentId, typeId, 10);
    await requestLeave(ctx, {
      employmentId,
      leaveTypeId: typeId,
      startDate: AMPLE_START,
      endDate: AMPLE_END,
      today: TODAY,
    });
    const rows = await requestRows(employmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].unpaidDays).toBeNull();
  });

  it('BLOCK refuses even where allow_negative_balance would have let it through', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const typeId = await leaveType({
      // The switch says "may go negative" — an ENABLED block rule is HR's later, more specific decision and
      // it wins. An explicit block is an explicit block.
      allowNegativeBalance: true,
      overrideRules: [{ trigger: 'insufficient_balance', action: 'block', enabled: true }],
    });
    await grant(employmentId, typeId, 1);
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: typeId, startDate: AMPLE_START, endDate: AMPLE_END, today: TODAY }),
    ).rejects.toBeInstanceOf(InsufficientLeaveBalanceOnSubmitError);
    expect(await requestRows(employmentId)).toHaveLength(0);
  });
});

// ── Several rules per leave type ──────────────────────────────────────────────────────────────────────
describe('56910869 · several rules per leave type, each firing on its own trigger', () => {
  it('ONE leave type carries TWO enabled rules and BOTH apply, each to its own situation', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    await emergencySetup();
    const typeId = await leaveType({
      minAdvanceDays: 7,
      allowNegativeBalance: false,
      overrideRules: [
        { trigger: 'advance_notice_not_met', action: 'block', enabled: true },
        { trigger: 'insufficient_balance', action: 'split_unpaid', enabled: true },
      ],
    });
    await grant(employmentId, typeId, 1);
    // Rule 1's situation: short notice ⇒ blocked, and the balance rule does not rescue it.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: typeId, startDate: SHORT_START, endDate: SHORT_END, today: TODAY }),
    ).rejects.toBeInstanceOf(LeaveAdvanceNoticeRequiredError);
    // Rule 2's situation: notice met, balance short ⇒ split, on the same type, with its own confirmation.
    await requestLeave(ctx, {
      employmentId,
      leaveTypeId: typeId,
      startDate: AMPLE_START,
      endDate: AMPLE_END,
      today: TODAY,
      overrideConsent: [SPLIT],
    });
    const rows = await requestRows(employmentId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].unpaidDays)).toBe(1);
  });

  it('a CONVERTED application can ALSO split, and the audit keeps both facts', async () => {
    // The reporter's compound case: short notice AND not enough balance. The conversion happens first and
    // the split then applies to the converted application, so both consents are required and both are
    // recorded — either fact alone misdescribes what the employee agreed to.
    const { ctx, employmentId } = await hireEmployeeCtx();
    const { el, annual } = await emergencySetup();
    await updateLeaveType(adminCtx(b), { id: el, name: 'Emergency Leave', balanceSourceTypeId: annual });
    await updateLeaveType(adminCtx(b), {
      id: el,
      name: 'Emergency Leave',
      overrideRules: [{ trigger: 'insufficient_balance', action: 'split_unpaid', enabled: true }],
    });
    const typeId = await leaveType({
      minAdvanceDays: 7,
      overrideRules: [{ trigger: 'advance_notice_not_met', action: 'convert_to_emergency', enabled: true }],
    });
    await grant(employmentId, annual, 1);

    // Neither consent alone is enough.
    await expect(
      requestLeave(ctx, {
        employmentId,
        leaveTypeId: typeId,
        startDate: SHORT_START,
        endDate: SHORT_END,
        today: TODAY,
        overrideConsent: [CONVERT],
      }),
    ).rejects.toBeInstanceOf(LeaveOverrideConsentRequiredError);
    expect(await requestRows(employmentId)).toHaveLength(0);

    const { leaveRequestId } = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: typeId,
      startDate: SHORT_START,
      endDate: SHORT_END,
      today: TODAY,
      overrideConsent: [CONVERT, SPLIT],
    });
    const rows = await requestRows(employmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].leaveTypeId).toBe(el);
    expect(Number(rows[0].unpaidDays)).toBe(1);
    const payload = await latestEventPayload(b.tenantId, leaveRequestId, 'leave-request.submitted');
    expect(payload?.leaveOverrideApplied).toBe(true);
    expect(payload?.overrideTrigger).toBe('advance_notice_not_met');
    expect(payload?.overrideAlsoSplitUnpaid).toBe(true);
    expect(payload?.overrideUnpaidDays).toBe(1);
  });
});

// ── Telling the employee ──────────────────────────────────────────────────────────────────────────────
describe('56910869 · the employee is TOLD before being asked', () => {
  it('the preview reports the rule that will fire, with the figures the pop-out needs', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const { el, annual } = await emergencySetup();
    await updateLeaveType(adminCtx(b), { id: el, name: 'Emergency Leave', balanceSourceTypeId: annual });
    const typeId = await leaveType({
      minAdvanceDays: 7,
      overrideRules: [{ trigger: 'advance_notice_not_met', action: 'convert_to_emergency', enabled: true }],
    });
    const preview = await previewLeaveDeduction(ctx, {
      employmentId,
      leaveTypeId: typeId,
      startDate: SHORT_START,
      endDate: SHORT_END,
      today: TODAY,
    });
    expect(preview.overrides).toHaveLength(1);
    expect(preview.overrides![0]).toMatchObject({
      trigger: 'advance_notice_not_met',
      action: 'convert_to_emergency',
      consentToken: CONVERT,
      needsConsent: true,
      minAdvanceDays: 7,
      daysInAdvance: 1,
    });
  });

  it('the preview says nothing at all when no rule fires — no other leave type gains a line', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const typeId = await leaveType({ minAdvanceDays: 7 });
    const preview = await previewLeaveDeduction(ctx, {
      employmentId,
      leaveTypeId: typeId,
      startDate: AMPLE_START,
      endDate: AMPLE_END,
      today: TODAY,
    });
    expect(preview.overrides).toBeUndefined();
  });

  // ── 7daac043: the trigger fires on the type's CONFIGURED UNIT, and both sides agree on it ───────────
  //
  // TODAY is Monday 2026-06-15 and the roster is Mon–Fri, so 2026-06-23 (Tue) is 8 CALENDAR days out and
  // 6 WORKING days out. Against a requirement of 7 the two readings disagree, and that is exactly the pair
  // that catches a preview which re-implements the rule instead of asking the same helper.
  const TUE_8_CAL_6_WORK = '2026-06-23';

  it('a working-days type fires the rule on a date the calendar reading lets through', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    // Same dates, same requirement, same rule — only the unit differs.
    const calendarType = await leaveType({
      minAdvanceDays: 7,
      overrideRules: [{ trigger: 'advance_notice_not_met', action: 'block', enabled: true }],
    });
    const workingType = await leaveType({
      minAdvanceDays: 7,
      minAdvanceDayType: 'working_days',
      overrideRules: [{ trigger: 'advance_notice_not_met', action: 'block', enabled: true }],
    });
    const previewOf = (leaveTypeId: string) =>
      previewLeaveDeduction(ctx, {
        employmentId,
        leaveTypeId,
        startDate: TUE_8_CAL_6_WORK,
        endDate: TUE_8_CAL_6_WORK,
        today: TODAY,
      });

    // 8 calendar days ≥ 7 ⇒ the rule does not fire, so the form says nothing.
    expect((await previewOf(calendarType)).overrides).toBeUndefined();

    // 6 working days < 7 ⇒ it does, and the figure quoted is in the unit the rule was judged in.
    const working = await previewOf(workingType);
    expect(working.overrides).toHaveLength(1);
    expect(working.overrides![0]).toMatchObject({
      trigger: 'advance_notice_not_met',
      action: 'block',
      needsConsent: false,
      minAdvanceDays: 7,
      daysInAdvance: 6,
      minAdvanceDayType: 'working_days',
    });

    // …AND THE SUBMISSION AGREES. A preview that promised a refusal the submission does not make (or stayed
    // silent about one it does) is the drift this pair exists to catch.
    await expect(
      requestLeave(ctx, {
        employmentId,
        leaveTypeId: workingType,
        startDate: TUE_8_CAL_6_WORK,
        endDate: TUE_8_CAL_6_WORK,
        today: TODAY,
      }),
    ).rejects.toBeInstanceOf(LeaveAdvanceNoticeRequiredError);
    const allowed = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: calendarType,
      startDate: TUE_8_CAL_6_WORK,
      endDate: TUE_8_CAL_6_WORK,
      today: TODAY,
    });
    expect(allowed.leaveRequestId).toBeTruthy();
  });
});

// ── The admin write path ──────────────────────────────────────────────────────────────────────────────
describe('56910869 · HR configures it in the product, and the screen reads back what was saved', () => {
  it('saves a rule set, projects it for the panel, and refuses a contradiction', async () => {
    const typeId = await leaveType({ minAdvanceDays: 7 });
    await updateLeaveType(adminCtx(b), {
      id: typeId,
      name: 'Override Test Type',
      overrideRules: [{ trigger: 'advance_notice_not_met', action: 'convert_to_emergency', enabled: true }],
    });
    const listed = (await listLeaveTypes(adminCtx(b))).find((t) => t.id === typeId);
    expect(listed?.overrideRules).toEqual([
      { trigger: 'advance_notice_not_met', action: 'convert_to_emergency', enabled: true },
    ]);

    // Clearing every rule stores NULL, not `[]` — one representation of "nothing configured".
    await updateLeaveType(adminCtx(b), { id: typeId, name: 'Override Test Type', overrideRules: [] });
    expect((await listLeaveTypes(adminCtx(b))).find((t) => t.id === typeId)?.overrideRules).toBeNull();

    await expect(
      updateLeaveType(adminCtx(b), {
        id: typeId,
        name: 'Override Test Type',
        overrideRules: [
          { trigger: 'insufficient_balance', action: 'split_unpaid', enabled: true },
          { trigger: 'insufficient_balance', action: 'block', enabled: true },
        ],
      }),
    ).rejects.toThrow(/Only one action/);
  });

  it('an unrelated save leaves the rules alone (the tri-state guard)', async () => {
    const typeId = await leaveType({ minAdvanceDays: 7 });
    await updateLeaveType(adminCtx(b), {
      id: typeId,
      name: 'Override Test Type',
      overrideRules: [{ trigger: 'insufficient_balance', action: 'block', enabled: true }],
    });
    await updateLeaveType(adminCtx(b), { id: typeId, name: 'Override Test Type', minAdvanceDays: 3 });
    const listed = (await listLeaveTypes(adminCtx(b))).find((t) => t.id === typeId);
    expect(listed?.minAdvanceDays).toBe(3);
    expect(listed?.overrideRules).toEqual([{ trigger: 'insufficient_balance', action: 'block', enabled: true }]);
  });
});
