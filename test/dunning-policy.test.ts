/**
 * ADR-0077 slice 9 — the dunning policy, and the sweep that applies it.
 *
 * r104 made a non-good-standing tenant read-only and nothing could reach that state: no code path set
 * tenant.status to 'suspended'. This is the trigger, and suspending a customer is the most consequential
 * automatic action this system takes — their entire tenant becomes read-only. So the decision is a PURE
 * function of the subscription row and a date, and every boundary is asserted directly rather than
 * inferred from a sweep.
 *
 * `today` is INJECTED throughout. A test that reads the real clock passes all month and says nothing
 * about the day the status flips, which is the only day that matters.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { dunningDecision, DEFAULT_GRACE_DAYS } from '../core/dunning';
import { runDunning } from '../scripts/apply-dunning';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const url = process.env.TEST_MIGRATION_DATABASE_URL!;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const decide = (o: Partial<Parameters<typeof dunningDecision>[0]>) =>
  dunningDecision({
    subscriptionStatus: 'past_due',
    periodEnd: '2026-06-30',
    tenantStatus: 'active',
    today: '2026-08-01',
    ...o,
  });

describe('dunningDecision — when a billing fact becomes a tenant state', () => {
  it('suspends once the grace period has elapsed', () => {
    // 30 days after 2026-06-30 is 2026-07-30; the 31st is past it.
    expect(decide({ today: '2026-07-31' }).action).toBe('suspend');
  });

  // On the last day of grace the customer still has the day to pay.
  it('does NOT suspend on the last day of grace', () => {
    expect(decide({ today: '2026-07-30' }).action).toBe('none');
  });

  it('leaves an active subscription alone', () => {
    expect(decide({ subscriptionStatus: 'active', today: '2027-01-01' }).action).toBe('none');
  });

  it('treats a cancelled subscription like past_due, not like closure', () => {
    expect(decide({ subscriptionStatus: 'cancelled' }).action).toBe('suspend');
  });

  /**
   * NEVER CLOSE. 'closed' starts a retention clock and ends in destruction; the plan makes closure
   * dual-controlled and explicit. A lapsed invoice must not begin deleting payroll history.
   */
  it('never decides to close a tenant', () => {
    for (const s of ['past_due', 'cancelled', 'active']) {
      expect(decide({ subscriptionStatus: s }).action).not.toBe('close' as never);
    }
  });

  /**
   * NEVER AUTO-REINSTATE. Reactivation records the suspended window and replays skipped sweeps with that
   * window excluded from expiry clocks. A sweep that silently flipped a tenant back would skip all of it.
   */
  it('does not reinstate a suspended tenant whose subscription is active again', () => {
    const d = decide({ subscriptionStatus: 'active', tenantStatus: 'suspended' });
    expect(d.action).toBe('none');
    expect(d.reason).toMatch(/already suspended/);
  });

  it('leaves a closed tenant alone entirely', () => {
    expect(decide({ tenantStatus: 'closed' }).reason).toMatch(/closed/);
  });

  // MISSING DATA IS NOT A REASON TO SUSPEND — the same rule r104 applied to a missing snapshot.
  it('refuses to suspend when there is no period end to measure from', () => {
    const d = decide({ periodEnd: null, today: '2030-01-01' });
    expect(d.action).toBe('none');
    expect(d.reason).toMatch(/nothing to measure/);
  });

  // An unrecognised billing status is not evidence of non-payment. Not suspending costs an invoice
  // chased by a human; suspending wrongly costs a payroll a customer cannot run.
  it('refuses to act on a billing status it does not understand', () => {
    expect(decide({ subscriptionStatus: 'weird_new_state' }).action).toBe('none');
  });

  it('honours a custom grace period', () => {
    expect(decide({ today: '2026-07-06', graceDays: 5 }).action).toBe('suspend');
    expect(decide({ today: '2026-07-05', graceDays: 5 }).action).toBe('none');
  });

  it('defaults the grace period to 30 days', () => {
    expect(DEFAULT_GRACE_DAYS).toBe(30);
  });
});

describe('runDunning — the sweep', () => {
  const subscribe = (status: string, periodEnd: string | null) =>
    owner.db.insert(schema.subscription).values({ tenantId: b.tenantId, plan: 'standard', status, periodEnd });

  const statusOf = async () => {
    const [t] = await owner.db.select().from(schema.tenant).where(eq(schema.tenant.id, b.tenantId));
    return t.status;
  };

  // REPORT-ONLY BY DEFAULT: a sweep that suspends unattended on its first run is the wrong default.
  it('reports without suspending unless --apply is passed', async () => {
    await subscribe('past_due', '2026-06-30');
    const out = await runDunning(url, { apply: false, today: '2026-08-01' });
    expect(out.some((r) => r.action === 'suspend')).toBe(true);
    expect(await statusOf(), 'report mode must not change anything').toBe('active');
  });

  it('suspends when applied, and records WHY', async () => {
    await subscribe('past_due', '2026-06-30');
    await runDunning(url, { apply: true, today: '2026-08-01' });
    expect(await statusOf()).toBe('suspended');

    const events = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'tenant.suspended'));
    expect(events, 'a customer losing write access must leave a record of why').toHaveLength(1);
    const payload = events[0].payload as { reason: string; graceDays: number };
    expect(payload.reason).toMatch(/past_due since 2026-06-30/);
    expect(payload.graceDays).toBe(30);
  });

  it('is idempotent — a second pass suspends nothing further', async () => {
    await subscribe('past_due', '2026-06-30');
    await runDunning(url, { apply: true, today: '2026-08-01' });
    const second = await runDunning(url, { apply: true, today: '2026-09-01' });
    expect(second.every((r) => r.action === 'none')).toBe(true);
    const events = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'tenant.suspended'));
    expect(events, 'no second event for a state already reached').toHaveLength(1);
  });

  // A tenant with no subscription has no billing fact to derive a state from.
  it('ignores a tenant with no subscription at all', async () => {
    const out = await runDunning(url, { apply: true, today: '2030-01-01' });
    expect(out).toHaveLength(0);
    expect(await statusOf()).toBe('active');
  });
});
