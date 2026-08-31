/**
 * ADR-0084 §2.5 — THE NUDGE AGENT, the first thing in this product that contacts a person with nobody
 * pressing send. Every property below fails in the direction of messaging MORE people, which is why each
 * is asserted in both directions.
 *
 *  1. **OFF UNLESS THE TENANT SWITCHED IT ON.** `notifications.readiness_nudge_enabled` defaults to
 *     false. A regression here does not throw or look wrong — it quietly starts mailing employees.
 *  2. **ROUTING FOLLOWS WHAT THE PRODUCT ACTUALLY LETS PEOPLE DO.** The bank account is the only gap with
 *     an ESS path (`app/me/actions.ts`), so it goes to the employee and the other five go to HR. Nudging
 *     somebody about a screen they do not have trains them to ignore the channel.
 *  3. **A GAP WITH NOBODY TO TELL IS RECORDED, NOT SKIPPED.** "This company has no HR admin" is a real
 *     operational fact that is otherwise invisible.
 *  4. **COOLDOWN AND BLAST RADIUS ARE REAL**, and the cap REPORTS that it truncated rather than reading
 *     as a completed run.
 *  5. **THE OUTCOME IS JUDGED.** A nudge whose gap closed is `approved`; one whose gap is still open after
 *     the settle window is `declined`. This is the only proposal type in the product with a real
 *     agreement rate, so it is the only place the ledger can come back unflattering — which is the point.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { dispatchNotifications } from '../core/notifications';
import { proposalRates } from '../core/agent-proposal';
import {
  MAX_NUDGES_PER_RUN,
  NUDGE_AUDIENCE,
  NUDGE_SETTING_KEY,
  NUDGE_SETTLE_DAYS,
  NUDGE_TEMPLATE,
  nudgeIsFaithful,
  sweepReadinessNudges,
} from '../core/readiness-nudge';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  setSetting,
  type Base,
} from './harness';

describe('ADR-0084 §2.5 — the readiness nudge agent', () => {
  let base: Base;
  let seq = 0;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    seq = 0;
  });
  afterAll(async () => {
    await closeAll();
  });

  const on = async () => {
    // Two switches, both required, and they are not the same thing: the MODULE gates
    // `dispatchNotifications` (a billable entitlement, ADR-0077), the SETTING gates the nudge agent
    // itself. A tenant can hold notifications and still not want an automated chaser.
    await setModule(base.tenantId, 'notifications', 'active');
    await setSetting(base.tenantId, NUDGE_SETTING_KEY, true);
    return adminCtx(base);
  };

  /** Somebody complete EXCEPT the one field named — so they carry exactly one gap. */
  async function personMissing(missing: 'bank' | 'tax' | null, opts: { hrAdmin?: boolean } = {}) {
    const a = adminCtx(base);
    seq++;
    const e = await hireEmployee(a, {
      person: { fullName: `Nudge ${seq}`, primaryEmail: `nudge.${seq}@aa.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
      paymentMethod: 'bank_transfer',
    } as never);
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, effectiveFrom: '2024-01-01' });
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: `90010101${String(5000 + seq)}`,
      epfNumber: `EPF${5000 + seq}`,
      socsoNumber: `SOC${5000 + seq}`,
      ...(missing === 'tax' ? {} : { taxNumber: `SG${5000 + seq}` }),
      ...(missing === 'bank' ? {} : { bankName: 'Maybank', bankAccountNo: `777${5000 + seq}` }),
    } as never);
    if (opts.hrAdmin) await createAppUser(base.tenantId, e.personId, 'hr_admin');
    return e;
  }

  const proposals = () =>
    owner.db
      .select({
        type: schema.agentProposal.proposalType,
        subjectId: schema.agentProposal.subjectId,
        adjudication: schema.agentProposal.adjudication,
        reason: schema.agentProposal.adjudicationReason,
        decision: schema.agentProposal.decision,
        gap: sql<string>`${schema.agentProposal.proposal} ->> 'gap'`,
        audience: sql<string>`${schema.agentProposal.proposal} ->> 'audience'`,
      })
      .from(schema.agentProposal);

  it('SENDS NOTHING until the tenant switches it on', async () => {
    await personMissing('bank');
    // Property 1, with its non-vacuity partner: the same fixture DOES produce a nudge once enabled, so
    // this is not passing because there was nothing to send.
    const off = await sweepReadinessNudges(adminCtx(base));
    expect(off).toMatchObject({ disabled: true, sent: 0 });
    expect(await proposals()).toHaveLength(0);

    const res = await sweepReadinessNudges(await on());
    expect(res.disabled).toBe(false);
    expect(res.sent).toBe(1);
  });

  it('routes the bank gap to the EMPLOYEE and a tax gap to HR', async () => {
    // Property 2. Only the bank account has an ESS path, so only it addresses the employee.
    const employee = await personMissing('bank');
    await personMissing('tax', { hrAdmin: true });

    const res = await sweepReadinessNudges(await on());
    expect(res.sent).toBe(2);

    const rows = (await proposals()).filter((r) => r.type === 'readiness_fix');
    const byGap = Object.fromEntries(rows.map((r) => [r.gap, r]));
    expect(byGap.no_bank_account).toMatchObject({ audience: 'employee', adjudication: 'accepted' });
    expect(byGap.no_bank_account!.subjectId).toBe(employee.employmentId);
    expect(byGap.no_tax_number).toMatchObject({ audience: 'hr', adjudication: 'accepted' });
  });

  it('every gap has an audience — the table cannot silently omit one', () => {
    // A gap missing from NUDGE_AUDIENCE would be `undefined`, route nowhere, and drop out in silence.
    for (const [gap, audience] of Object.entries(NUDGE_AUDIENCE)) {
      expect(['employee', 'hr'], `${gap} must route somewhere`).toContain(audience);
    }
    expect(Object.keys(NUDGE_AUDIENCE).sort()).toEqual(Object.keys(NUDGE_TEMPLATE).sort());
  });

  it('RECORDS a gap it has nobody to tell, instead of skipping it in silence', async () => {
    // Property 3. A tax gap in a company with no HR admin at all.
    await personMissing('tax');
    const res = await sweepReadinessNudges(await on());
    expect({ sent: res.sent, orphaned: res.orphaned }).toEqual({ sent: 0, orphaned: 1 });

    const [row] = await proposals();
    expect(row).toMatchObject({
      type: 'readiness_fix',
      adjudication: 'rejected',
      reason: 'no_recipient',
      decision: null,
    });
    // And nothing was raised for it — a rejected proposal must not also produce a message.
    const events = await owner.db
      .select({ id: schema.domainEvent.id })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'readiness.nudge-raised'));
    expect(events).toHaveLength(0);
  });

  it('does not nudge the same person about the same gap twice in the cooldown', async () => {
    // Property 4.
    await personMissing('bank');
    const ctx = await on();
    expect((await sweepReadinessNudges(ctx)).sent).toBe(1);

    const second = await sweepReadinessNudges(ctx);
    expect({ sent: second.sent, cooled: second.cooled }).toEqual({ sent: 0, cooled: 1 });
    expect((await proposals()).filter((r) => r.type === 'readiness_fix')).toHaveLength(1);
  });

  it('stops at the blast-radius cap and SAYS it stopped', async () => {
    // Property 4's other half. A run that truncates while reporting a clean finish reads as complete.
    const many = MAX_NUDGES_PER_RUN + 2;
    for (let i = 0; i < many; i++) await personMissing('bank');
    const res = await sweepReadinessNudges(await on());
    expect(res.sent).toBe(MAX_NUDGES_PER_RUN);
    expect(res.cappedOut, 'a truncated run must not report as a complete one').toBe(true);
  }, 120_000);

  it('JUDGES the outcome: gap closed ⇒ approved, still open ⇒ declined', async () => {
    // Property 5, and the only real agreement rate in the product.
    const fixed = await personMissing('bank');
    const ignored = await personMissing('bank');
    const ctx = await on();
    expect((await sweepReadinessNudges(ctx)).sent).toBe(2);

    // Age both nudges past the settle window.
    await owner.db
      .update(schema.agentProposal)
      .set({ proposedAt: new Date(Date.now() - (NUDGE_SETTLE_DAYS + 1) * 86_400_000) })
      .where(eq(schema.agentProposal.proposalType, 'readiness_fix'));
    // One of them actually goes and adds their bank account.
    await owner.db
      .update(schema.employeeStatutoryMy)
      .set({ bankName: 'Maybank', bankAccountNo: '7770001' })
      .where(eq(schema.employeeStatutoryMy.personId, fixed.personId));

    const res = await sweepReadinessNudges(ctx);
    expect(res.settled).toBe(2);

    // ONLY the judged rows. Ageing a nudge past the 21-day settle window also ages it past the 14-day
    // cooldown, so the same sweep legitimately raises a FRESH nudge for the person who still has the gap —
    // that second, undecided row is correct behaviour and would otherwise mask the verdict on the first.
    const judged = (await proposals()).filter((r) => r.type === 'readiness_fix' && r.decision !== null);
    const bySubject = Object.fromEntries(judged.map((r) => [r.subjectId, r.decision]));
    expect(bySubject[fixed.employmentId], 'the gap closed — the nudge worked').toBe('approved');
    expect(bySubject[ignored.employmentId], 'still open after the window — it did not').toBe('declined');

    // The rate is now a real, unflattering number rather than a structural 1.0.
    const [rate] = (await proposalRates(ctx)).filter((r) => r.type === 'readiness_fix');
    expect(rate!.agreementRate).toBeCloseTo(0.5);
  });

  it('turns a nudge into a notification that deep-links where the reader can act', async () => {
    await personMissing('bank');
    const ctx = await on();
    await sweepReadinessNudges(ctx);
    await dispatchNotifications(ctx);

    const rows = await owner.db
      // NOTE: `category` is on notification_pref (it drives the per-category opt-out), not on the
      // notification row itself — the row carries `kind`.
      .select({
        kind: schema.notification.kind,
        body: schema.notification.body,
        linkPath: schema.notification.linkPath,
      })
      .from(schema.notification)
      .where(eq(schema.notification.kind, 'readiness.nudge'));
    expect(rows, 'the sweep appends an event; dispatch is what makes it a message').toHaveLength(1);
    expect(rows[0]).toMatchObject({ linkPath: '/me' });
    // No provider is configured in the harness, so the deterministic template is what went out — and it
    // must be the real sentence, never an empty string or "undefined".
    expect(rows[0]!.body).toBe(NUDGE_TEMPLATE.no_bank_account);
  });

  it('records NO draft proposal when there is no provider — nothing was proposed', async () => {
    // The template path is not a model failure and must not be counted as one: an adjudication-pass rate
    // dragged down by tenants that never bought a provider would be measuring the wrong thing entirely.
    await personMissing('bank');
    await sweepReadinessNudges(await on());
    expect((await proposals()).filter((r) => r.type === 'readiness_nudge')).toHaveLength(0);
  });

  describe('nudgeIsFaithful — the adjudicator', () => {
    it('refuses ANY digit, because a nudge carries no figures to check one against', () => {
      expect(nudgeIsFaithful('Your bank account is missing.', 'no_bank_account')).toBe(true);
      expect(nudgeIsFaithful('Your bank account is missing, 3 days left.', 'no_bank_account')).toBe(false);
      expect(nudgeIsFaithful('We owe you RM1200 but have no bank details.', 'no_bank_account')).toBe(false);
    });

    it('refuses a body that is not about the gap it claims', () => {
      // The model drifting onto another subject is the failure this catches.
      expect(nudgeIsFaithful('Your leave balance needs attention.', 'no_bank_account')).toBe(false);
      expect(nudgeIsFaithful('No tax number is on file for this employee.', 'no_tax_number')).toBe(true);
    });

    it('refuses placeholders, links, empties and anything too long for a bell', () => {
      expect(nudgeIsFaithful('Hi {name}, your bank details are missing.', 'no_bank_account')).toBe(false);
      expect(nudgeIsFaithful('Add your bank details at https://x.test', 'no_bank_account')).toBe(false);
      expect(nudgeIsFaithful('   ', 'no_bank_account')).toBe(false);
      expect(nudgeIsFaithful(`bank ${'x'.repeat(300)}`, 'no_bank_account')).toBe(false);
    });

    it('every shipped template passes its own adjudicator', () => {
      // The fallback is what goes out when the model fails. If it could not pass the check the model is
      // held to, the check would be describing a standard the product itself does not meet.
      for (const [gap, body] of Object.entries(NUDGE_TEMPLATE)) {
        expect(nudgeIsFaithful(body, gap as keyof typeof NUDGE_TEMPLATE), gap).toBe(true);
      }
    });
  });
});
