/**
 * ADR-0033 33-4 — TOIL expiry sweep. An expired active accrual follows its frozen expiry_action: convert to
 * pay (debit the replacement-leave credit + record the owed ORP value, no auto-disbursement) or lapse (debit +
 * forfeit). The floor protection is verified end-to-end: an eligible employee's TOIL converts (set at accrual),
 * never lapses. Idempotent + gated. today is injected.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
  closeAll,
  entitledCtx,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { checkIn, checkOut } from '../core/attendance';
import { setRestDay } from '../core/roster';
import { accrueToil, runToilExpiry, setToilPolicy, ToilDisabledError, type ToilPolicyInput } from '../core/toil';
import { isModuleEnabled } from '../core/entitlements';

let b: Base;
const REST_DAY = '2026-07-04';
// 00307068 moved the expiry anchor from the worked day to the line manager's APPROVAL, so the approval
// instant is now an input to every accrual here and is injected like every other date in this suite.
const APPROVED_ON = new Date('2026-07-06T02:00:00.000Z');
const AFTER_EXPIRY = '2026-10-15'; // > APPROVED_ON + 90d (2026-10-04, was REST_DAY + 90d = 2026-10-02)
const BEFORE_EXPIRY = '2026-09-01';
const uniqEmail = () => `tex_${Math.random().toString(36).slice(2)}@t.local`;

const policy = (companyId: string, over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({
  companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 90,
  onExpiry: 'convert_to_pay',
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
  ...over,
});

/** Hire at a wage, work a rest day, set the policy, and bank the TOIL (1.0 day). Returns the accrual id. */
async function accrue(basic: number, over: Partial<ToilPolicyInput> = {}) {
  // `entitledCtx`, not `adminCtx`: `accrueToil` is gated on the `toil` module, and `adminCtx` carries a
  // snapshot derived from `legacyEnabledModulesIn(process.env)` — a set `toil` is absent from
  // (LEGACY_MODULE_ENV_GATES.toil = 'TOIL_ENABLED', which no tracked env file sets). It therefore reports
  // toil DISABLED no matter what rows the tenant has, so the beforeEach grant below would be invisible to
  // it and every accrual here would throw ToilDisabledError. `entitledCtx` resolves from the actual rows.
  const a = await entitledCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Exp', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  await setToilPolicy(a, policy(b.companyId, over));
  await setRestDay(a, { employmentId: e.employmentId, shiftDate: REST_DAY });
  await checkIn(a, { employmentId: e.employmentId, date: REST_DAY, time: '08:00:00' });
  await checkOut(a, { employmentId: e.employmentId, date: REST_DAY, time: '17:00:00' });
  // Phase-B #14: pass per-election consent (moot for > ceiling employees, required for First-Schedule ones).
  const r = await accrueToil(a, { employmentId: e.employmentId, workedDate: REST_DAY, firstScheduleConsent: true, approvedOn: APPROVED_ON });
  return { a, employmentId: e.employmentId, accrualId: r.accrualId };
}

async function replacementBalance(employmentId: string): Promise<number> {
  const [row] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .innerJoin(schema.leaveType, eq(schema.leaveType.id, schema.leaveLedger.leaveTypeId))
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveType.code, 'REPLACEMENT')));
  return Number(row?.bal ?? 0);
}
const statusOf = async (accrualId: string) =>
  (await owner.db.select({ s: schema.toilAccrual.status }).from(schema.toilAccrual).where(eq(schema.toilAccrual.id, accrualId)))[0]?.s;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // ADR-0077 slice 3: TOIL is a per-tenant entitlement, not a deployment flag. `seedBase` seeds NO
  // `toil` row (it is absent from LEGACY_ENABLED_MODULE_CODES), and a missing row is DISABLED — so the
  // module has to be switched on for this tenant, which is what the old `TOIL_ENABLED = 'true'` meant.
  // No teardown counterpart is needed: `resetDb()` truncates `tenant_module` before every test.
  await setModule(b.tenantId, 'toil', 'active');
});

describe('TOIL expiry sweep (ADR-0033 33-4)', () => {
  it('converts an eligible employee to pay (forced), debits the credit, records the owed ORP', async () => {
    const { employmentId, accrualId } = await accrue(3000, { allowFirstScheduleEligible: true }); // ≤ ceiling ⇒ convert forced
    expect(await replacementBalance(employmentId)).toBe(1);
    const r = await runToilExpiry(await entitledCtx(b), { today: AFTER_EXPIRY });
    expect(r).toMatchObject({ processed: 1, converted: 1, lapsed: 0, convertedDays: 1 });
    expect(r.convertedAmount).toBe(115.38); // 1 day × (3000 / 26)
    expect(await statusOf(accrualId)).toBe('converted_to_pay');
    expect(await replacementBalance(employmentId)).toBe(0); // credit debited
    expect(await eventTypesFor(b.tenantId, accrualId)).toContain('toil.converted');
  });

  it('lapses when the policy says lapse for a non-First-Schedule employee', async () => {
    const { employmentId, accrualId } = await accrue(5000, { onExpiry: 'lapse' }); // > ceiling ⇒ policy applies
    const r = await runToilExpiry(await entitledCtx(b), { today: AFTER_EXPIRY });
    expect(r).toMatchObject({ processed: 1, converted: 0, lapsed: 1, convertedAmount: 0 });
    expect(await statusOf(accrualId)).toBe('lapsed');
    expect(await replacementBalance(employmentId)).toBe(0); // forfeited
    expect(await eventTypesFor(b.tenantId, accrualId)).toContain('toil.lapsed');
  });

  it('converts a non-eligible employee when the policy says convert_to_pay', async () => {
    const { accrualId } = await accrue(5000, { onExpiry: 'convert_to_pay' });
    const r = await runToilExpiry(await entitledCtx(b), { today: AFTER_EXPIRY });
    expect(r).toMatchObject({ processed: 1, converted: 1, lapsed: 0 });
    expect(await statusOf(accrualId)).toBe('converted_to_pay');
  });

  it('leaves a not-yet-expired accrual untouched', async () => {
    const { employmentId, accrualId } = await accrue(5000, { onExpiry: 'lapse' });
    const r = await runToilExpiry(await entitledCtx(b), { today: BEFORE_EXPIRY });
    expect(r.processed).toBe(0);
    expect(await statusOf(accrualId)).toBe('active');
    expect(await replacementBalance(employmentId)).toBe(1);
  });

  it('is idempotent — a second run processes nothing', async () => {
    await accrue(5000, { onExpiry: 'lapse' });
    // One snapshot, reused: the entitlement does not change between the two runs, and re-resolving would
    // test the resolver rather than the sweep's idempotency.
    const ctx = await entitledCtx(b);
    expect((await runToilExpiry(ctx, { today: AFTER_EXPIRY })).processed).toBe(1);
    expect((await runToilExpiry(ctx, { today: AFTER_EXPIRY })).processed).toBe(0);
  });

  it('still settles banked days after the toil entitlement is revoked — the statutory floor is not switchable', async () => {
    // The obligation this sweep discharges is EA First Schedule, not a product feature: an eligible
    // employee's unused TOIL must convert to pay and may never lapse. So revoking the module must not
    // be able to strand it.
    //
    // This test replaces one that asserted the opposite (`rejects.toBeInstanceOf(ToilDisabledError)`).
    // That test was carefully built and passed honestly — it just encoded the wrong requirement. Under
    // the old deployment flag the scenario was unreachable (nobody edits .env mid-month), but a
    // per-tenant entitlement lapses on a trial ending, a downgrade, or non-payment, and at that moment
    // the employee is still owed the day they worked. app/admin/toil/page.tsx ALSO hid the button that
    // calls this — see the surface test at the bottom of this file, which is the half that makes
    // ungating the service mean anything in production.
    const { employmentId, accrualId } = await accrue(3000, { allowFirstScheduleEligible: true });
    expect(await replacementBalance(employmentId)).toBe(1);

    // Revoke the entitlement (no row ⇒ disabled, C7) and re-resolve — the snapshot is point-in-time,
    // so this context genuinely answers `toil: false`.
    await setModule(b.tenantId, 'toil', null);
    const revoked = await entitledCtx(b);
    expect(isModuleEnabled(revoked, 'toil'), 'the fixture must actually be disabled, or this proves nothing').toBe(false);

    // The money still moves. Asserted on the AMOUNT, not just `processed` — a sweep that ran but
    // converted nothing would satisfy a count-only assertion while still stranding the liability.
    const r = await runToilExpiry(revoked, { today: AFTER_EXPIRY });
    expect(r).toMatchObject({ processed: 1, converted: 1, lapsed: 0, convertedDays: 1 });
    expect(r.convertedAmount).toBe(115.38); // 1 day × (3000 / 26) — the ORP owed
    expect(await statusOf(accrualId)).toBe('converted_to_pay');
    expect(await replacementBalance(employmentId)).toBe(0);
    expect(await eventTypesFor(b.tenantId, accrualId)).toContain('toil.converted');
  });

  it('still refuses NEW accrual once the entitlement is revoked', async () => {
    // The other half of the rule, and the reason the test above is not simply "the gate was deleted":
    // revoking TOIL must still stop the tenant BANKING more days. Settling a debt already incurred and
    // incurring a new one are different acts, and only the second is a purchased capability. Without
    // this, "make the sweep unconditional" could be over-applied into ungating accrual too.
    // 5000 is above the First Schedule wage ceiling, so the default policy permits banking without the
    // `allowFirstScheduleEligible` override — this test is about the entitlement gate, not eligibility.
    const { employmentId } = await accrue(5000); // banked while entitled
    await setModule(b.tenantId, 'toil', null);
    const revoked = await entitledCtx(b);
    await expect(
      accrueToil(revoked, { employmentId, workedDate: REST_DAY, firstScheduleConsent: true }),
    ).rejects.toBeInstanceOf(ToilDisabledError);
  });

  it('the ADMIN SURFACE stays reachable with the module off — a service-level test cannot see this', () => {
    /*
     * WHY A SOURCE-LEVEL TEST, AND WHY IT IS THE IMPORTANT ONE.
     *
     * Ungating `runToilExpiry` / `closeReplacementLeaveYear` changed NOTHING in production on its own.
     * app/admin/toil/page.tsx is their only caller — there is no cron; app/admin/actions.ts says so
     * ("manual; a scheduled job will do this later") and deploy/DEPLOY.md's crontab lists four jobs,
     * none of them a TOIL sweep. The page rendered both buttons, and the outstanding-liability ledger,
     * inside `{envOn && …}` where `envOn` was the very predicate that used to throw. So a tenant whose
     * `toil` entitlement lapsed still could not SEE the debt, let alone settle it: the service no longer
     * refused a call that no surface could make.
     *
     * The two service tests above pass by calling the function directly, which is exactly the blind spot
     * — they cannot distinguish "reachable" from "reachable only by a test". Reading the page is the
     * same ratchet this suite already applies to migrations and to the operator form.
     */
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'app/admin/toil/page.tsx'), 'utf8');

    // 1. The ledger read is UNCONDITIONAL — an admin can always see what is outstanding.
    expect(src, 'the replacement-leave summary must not be gated on the module').toContain(
      'const summary = await replacementLeaveSummary(',
    );
    expect(src, 'the old `moduleOn ? … : null` read hid the outstanding liability').not.toMatch(
      /(moduleOn|envOn)\s*\?\s*await replacementLeaveSummary/,
    );

    // 2. Settlement is shown when the module is on OR a banked credit is still outstanding.
    expect(src).toContain('const showSettlement = moduleOn || outstanding;');
    expect(src).toContain('const outstanding = summary.activeAccruals > 0;');

    // 3. …and BOTH settle actions live inside that block, not inside a module-only one.
    const guard = src.indexOf('{showSettlement && visible.length > 0 && (');
    expect(guard, 'the settlement card must be guarded by showSettlement').toBeGreaterThan(-1);
    const card = src.slice(guard);
    expect(card).toContain('action={runToilExpiryAction}');
    expect(card).toContain('action={closeReplacementLeaveYearAction}');
    // The wind-down region must contain no module-only gate of its own — that would restore the hole
    // one level down, which is precisely how the original fix came to be illusory.
    const cardEnd = card.indexOf('{t(\'footnote\')}');
    expect(card.slice(0, cardEnd)).not.toMatch(/\{\s*moduleOn\s*&&/);

    // 4. THE OTHER SIDE OF THE SPLIT, which the wind-down argument does NOT extend to (review r2).
    //    Ungating the ledger and the two sweeps is about settling days already banked. The per-company
    //    POLICY EDITOR is about future accrual — every field in it is frozen onto each accrual at
    //    accrual time — so an unentitled tenant EDITING it is configuring a module it has not bought,
    //    ready to take effect the day it does. `setToilPolicy` asserts the same server-side
    //    (test/toil.test.ts covers the refusal).
    //
    //    READ-ONLY, NOT HIDDEN (review r3). The first version of this gate rendered `null`, and this
    //    assertion pinned that — while the banner immediately above the cards says, in all six locales,
    //    "You can review policies here, but no new time will be banked". Hiding the cards made that copy
    //    false and undercut the wind-down argument the gate belongs to: every accrual freezes
    //    `expiryAction` and `carryForwardAtYearEnd` from this policy, so the admin being asked to settle
    //    an outstanding liability could not see the settings that govern HOW it settles. `toil` is in no
    //    parity set, so every existing tenant lands in this branch at the flip. What the entitlement
    //    withholds is the write, and that is what these assert.
    const formAt = src.indexOf('action={setToilPolicyAction}');
    expect(formAt, 'the policy form must still exist').toBeGreaterThan(-1);
    expect(
      src.slice(0, formAt),
      'the policy cards must render for an unentitled tenant — the banner promises a review surface',
    ).not.toMatch(/!moduleOn\s*\?\s*null\s*:/);
    const formEnd = src.indexOf('</form>', formAt);
    const form = src.slice(formAt, formEnd);
    // Every named control in the form is disabled without the module — asserted PER CONTROL, by name.
    //
    // This used to be arithmetic: `disabled === controls - 1`, with the -1 explained as "the hidden
    // companyId input" (review r2). That encodes "there is exactly one hidden field", so adding a second
    // one — or rendering a control through a component instead of a raw tag — fails the test for a reason
    // that has nothing to do with the entitlement gate. A guard that cries wolf is a guard people
    // weaken, which this same file argues against two assertions up. Naming the exemptions says the
    // actual rule, and a new ungated field now fails with a message naming the field.
    const EXEMPT_CONTROLS = new Set([
      'companyId', // hidden, carries the row identity — not something the user edits
    ]);
    // No `s` flag needed (and tsconfig's target forbids it): `[^>]` is a negated class, so it already
    // crosses newlines — which multi-line JSX controls like `allowFirstScheduleEligible` require.
    const tags = [...form.matchAll(/<(?:input|select)\b[^>]*>/g)].map((m) => m[0]);
    expect(tags.length, 'the policy form must still have controls').toBeGreaterThan(5);
    let gated = 0;
    for (const tag of tags) {
      const name = /name="([^"]+)"/.exec(tag)?.[1];
      expect(name, `a control in the policy form has no name= attribute: ${tag.slice(0, 60)}`).toBeDefined();
      if (EXEMPT_CONTROLS.has(name!)) continue;
      gated += 1;
      expect(
        tag.includes('disabled={!moduleOn}'),
        `the '${name}' control in the TOIL policy form is not disabled without the module. Every field ` +
          'here is frozen onto each accrual at accrual time, so an unentitled tenant editing it is ' +
          'configuring a module it has not bought.',
      ).toBe(true);
    }
    expect(gated, 'the control scan found no editable fields — the regex has drifted').toBeGreaterThan(4);
    expect(form, 'and the submit must not be offered at all').toContain('{moduleOn && <button');
    // …and the form must sit ABOVE the settlement card, so gating it cannot drag the sweeps with it.
    expect(formAt, 'the policy form is expected before the settlement card').toBeLessThan(guard);
  });
});
