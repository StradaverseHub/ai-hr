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
// 296fc027 — the employee-request path, whose credits carry a NULL day type.
import { decideReplacementLeaveRequest, submitReplacementLeaveRequest } from '../core/replacement-request';
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
    //
    // 3fb1a611 — THE REGION'S END MARKER MOVED, and the reason is worth stating because the old one
    // looked permanent. The footnote used to be the next thing on the page after the settlement card, so
    // `indexOf("{t('footnote')}")` was a serviceable proxy for "end of the wind-down region". This round
    // adds the manual-grant surface between them, and that surface IS module-gated ON PURPOSE — granting
    // creates a NEW obligation, so it belongs on the accrual side of ADR-0077 slice 3, not the settlement
    // side. Left as it was, this assertion would read the grant card and fail for the right reason in the
    // wrong place. The boundary is now the grant card itself.
    const GRANT_MARKER = '3fb1a611 · GRANT A CREDIT BY HAND';
    const grantAt = card.indexOf(GRANT_MARKER);
    expect(grantAt, 'the manual-grant surface must follow the settlement card').toBeGreaterThan(-1);
    expect(card.slice(0, grantAt)).not.toMatch(/\{\s*moduleOn\s*&&/);

    // 3b. AND THE OTHER HALF OF THE SAME SPLIT, asserted rather than left implied. Settlement discharges
    //     a debt already incurred and must survive a lapsed entitlement; granting creates a new one and
    //     must not. Pinning only the first half would let the second drift into being ungated too, which
    //     is the mirror-image hole.
    const grantCard = card.slice(grantAt);
    expect(grantCard, 'granting must be gated on the module').toMatch(/\{moduleOn && visible\.length > 0 && \(/);
    expect(grantCard).toContain('action={grantToilCreditAction}');

    // 4. THE OTHER SIDE OF THE SPLIT, which the wind-down argument does NOT extend to (review r2).
    //    Ungating the ledger and the two sweeps is about settling days already banked. The per-company
    //    POLICY EDITOR is about future accrual — every field in it is frozen onto each accrual at
    //    accrual time — so an unentitled tenant EDITING it is configuring a module it has not bought,
    //    ready to take effect the day it does. `setToilPolicy` asserts the same server-side
    //    (test/toil.test.ts covers the refusal).
    //
    //    296fc027 MOVED THE FORM, NOT THE RULE, and a6fe37fc Round 5 moved it once more: the policy
    //    editor lives on app/admin/leave-config/company-rules/page.tsx — a replacement-leave policy is a
    //    COMPANY rule (IA §2.0.3) and now shares one screen with the other three — while the ledger and
    //    the two sweeps stay HERE, precisely because the two halves are gated DIFFERENTLY and putting
    //    them on one screen is what made that easy to get wrong. So this section reads the OTHER file.
    //    Every assertion below is unchanged in substance; only the source path is.
    //    Sections 1–3 above still read this page, which is the half the wind-down argument protects.
    //
    //    READ-ONLY, NOT HIDDEN (review r3). The first version of this gate rendered `null`, and this
    //    assertion pinned that — while the banner immediately above the cards says, in all six locales,
    //    "You can review policies here, but no new time will be banked". Hiding the cards made that copy
    //    false and undercut the wind-down argument the gate belongs to: every accrual freezes
    //    `expiryAction` and `carryForwardAtYearEnd` from this policy, so the admin being asked to settle
    //    an outstanding liability could not see the settings that govern HOW it settles. `toil` is in no
    //    parity set, so every existing tenant lands in this branch at the flip. What the entitlement
    //    withholds is the write, and that is what these assert.
    const cfg = fs.readFileSync(
      path.resolve(__dirname, '..', 'app/admin/leave-config/company-rules/page.tsx'),
      'utf8',
    );
    // The sweeps must NOT have followed the form onto the configuration screen — that would re-gate a
    // statutory settlement behind a page that is read-only without the module.
    //
    // CHECKED AS INVOCATION, NOT AS A SUBSTRING. A bare `not.toContain('runToilExpiryAction')` fails on
    // the page's own header, which names both sweeps precisely to explain why they stayed on /admin/toil.
    // Forbidding the words would push the next author to delete the explanation in order to pass — the
    // exact trade this suite argues against elsewhere. What must be absent is the ability to CALL them:
    // no import, and no form bound to one.
    for (const sweep of ['runToilExpiryAction', 'closeReplacementLeaveYearAction']) {
      expect(cfg, `${sweep} must not be invoked from the configuration page`).not.toContain(`action={${sweep}}`);
      expect(
        new RegExp(`import\\s*\\{[^}]*\\b${sweep}\\b`).test(cfg),
        `${sweep} must not be imported by the configuration page — it belongs to the settlement screen`,
      ).toBe(false);
    }
    const formAt = cfg.indexOf('action={setToilPolicyAction}');
    expect(formAt, 'the policy form must still exist, on the configuration page').toBeGreaterThan(-1);
    expect(
      cfg.slice(0, formAt),
      'the policy cards must render for an unentitled tenant — the banner promises a review surface',
    ).not.toMatch(/!moduleOn\s*\?\s*null\s*:/);
    const formEnd = cfg.indexOf('</form>', formAt);
    const form = cfg.slice(formAt, formEnd);
    // ⚠️ 1cf5b37c INVERTED THIS ASSERTION, and the inversion IS the item — read before restoring it.
    //
    // It used to require every named control to carry `disabled={!moduleOn}` and the submit to render only
    // with the module on. That gate is exactly what made Leave Config → Replacement Leave look like an
    // unfinished placeholder to the reporter: a complete editor with every control dead and no Save.
    // `toil` is absent from tenant_module on production, so that is what they actually saw. The owner
    // approved letting the screen be configured ahead of purchase.
    //
    // WHAT REPLACES IT IS A STRONGER STATEMENT, not a weaker one. The old assertion protected against a
    // tenant configuring a module it had not bought — a commercial worry. The real hazard was always that
    // it might ACCRUE something, and that is now asserted directly in test/toil.test.ts: an unentitled
    // tenant with an ENABLED policy row still has accrueToil refuse. So this file checks the two facts
    // that remain its business: the form is reachable and editable, and the sweeps are still not here.
    const tags = [...form.matchAll(/<(?:input|select)\b[^>]*>/g)].map((m) => m[0]);
    expect(tags.length, 'the policy form must still have controls').toBeGreaterThan(5);
    for (const tag of tags) {
      const name = /name="([^"]+)"/.exec(tag)?.[1];
      expect(name, `a control in the policy form has no name= attribute: ${tag.slice(0, 60)}`).toBeDefined();
      expect(
        tag.includes('disabled={!'),
        `the '${name}' control is still entitlement-disabled. 1cf5b37c removed that gate so the screen ` +
          'stops reading as an unfinished placeholder; what keeps it safe is that accrual refuses ' +
          'without the module (test/toil.test.ts), not that the form is dead.',
      ).toBe(false);
    }
    expect(form, 'and the submit is always offered now').not.toContain('{moduleOn && <button');
    // The form used to have to sit ABOVE the settlement card so gating it could not drag the sweeps with
    // it. 296fc027 makes that structurally impossible instead of positionally: they are different files,
    // asserted above. The stronger statement is that this page has no policy form left at all.
    expect(src, 'the policy form must not linger on the settlement page').not.toContain('setToilPolicyAction');
    expect(guard, 'the settlement card must still be on this page').toBeGreaterThan(-1);
  });
});

/**
 * 296fc027 · A SELF-DECLARED CREDIT HAS NO DAY TYPE, AND THE SWEEP MUST NOT INVENT ONE.
 *
 * The employee-request path banks a credit with no attendance row behind it, so `toil_accrual.day_type` is
 * NULL. That matters here and nowhere else: for a First-Schedule employee the convert-to-pay amount is the
 * EXACT s.60(3)/s.60D(3) statutory cash, and that figure is a function OF THE DAY TYPE — a rest day and a
 * public holiday pay at different multiples. Guessing one would put a confident, wrong number on a
 * statutory obligation. The sweep must fall back to the contractual ORP basis and say so.
 */
describe('Expiry of a self-declared credit (296fc027)', () => {
  it('values a NULL-day-type credit on the generic ORP basis and flags it for human reconciliation', async () => {
    const a = await entitledCtx(b);
    const e = await hireEmployee(a, {
      person: { fullName: 'Self Declared', primaryEmail: uniqEmail() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    // BELOW the ceiling — the case where a fabricated day type would have produced a wrong statutory figure.
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 2000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
    await setToilPolicy(a, policy(b.companyId, { allowFirstScheduleEligible: true, employeeRequestEnabled: true }));

    const { requestId } = await submitReplacementLeaveRequest(a, {
      employmentId: e.employmentId,
      unit: 'day',
      lines: [{ workedDate: REST_DAY, days: 1 }],
      today: '2026-07-06',
      firstScheduleConsent: true,
    });
    await decideReplacementLeaveRequest(a, { requestId, decision: 'approved', decidedAt: APPROVED_ON });

    const [acc] = await owner.db
      .select()
      .from(schema.toilAccrual)
      .where(eq(schema.toilAccrual.employmentId, e.employmentId));
    expect(acc.dayType).toBeNull();
    // Floor protection still applies — an eligible employee's credit converts, it never lapses.
    expect(acc.expiryAction).toBe('convert_to_pay');

    const res = await runToilExpiry(a, { today: AFTER_EXPIRY });
    expect(res.converted).toBe(1);
    expect(await statusOf(acc.id)).toBe('converted_to_pay');

    const [ev] = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, acc.id), eq(schema.domainEvent.eventType, 'toil.converted')));
    const payload = ev.payload as Record<string, unknown>;
    // NOT 'statutory_exact': the day type it would need is not known.
    expect(payload.valuationBasis).toBe('generic_orp');
    expect(String(payload.valuationNote)).toMatch(/self-declared/i);
    // ORP × banked days = 2000/26 × 1 day.
    expect(payload.amountOwed).toBeCloseTo(76.92, 2);
  });
});
