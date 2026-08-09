/**
 * ADR-0077 slice 9 — the CLOSURE runner, `closureDecision`'s first caller.
 *
 * The decision itself is pinned in test/tenant-lifecycle.test.ts as a pure function. What is pinned
 * HERE is everything the runner adds around it, and every one of those is a way a correct decision can
 * still end in a wrongly-closed tenant:
 *
 *   - that the runner ROUTES through closureDecision rather than deciding for itself — asserted by
 *     making each of the four refusals arrive with the core module's own words;
 *   - that a refusal writes NOTHING, not "writes a bit less";
 *   - that report mode writes nothing either, which is the only reason an operator can safely run this
 *     against a live customer to see what it would do;
 *   - that --apply records WHO agreed, so the closure is auditable after the columns could be edited.
 *
 * `today` is INJECTED. A retention boundary read off the real clock passes all year and says nothing
 * about the one day the answer changes.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { runClosure, type ClosureOptions } from '../scripts/close-tenant';
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

// Two DIFFERENT platform operators. Opaque uuids on purpose — 0350 gives the columns no FK and the
// people who close an account are not users inside the tenant being closed (ADR-0077 D5).
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const opts = (over: Partial<ClosureOptions> = {}): ClosureOptions => ({
  tenantId: b.tenantId,
  requestedBy: ALICE,
  approvedBy: BOB,
  retentionHeldUntil: null,
  requestedAt: new Date('2026-08-01T09:00:00Z'),
  approvedAt: new Date('2026-08-02T09:00:00Z'),
  apply: false,
  today: '2026-08-03',
  ...over,
});

const tenantRow = async () => {
  const [t] = await owner.db.select().from(schema.tenant).where(eq(schema.tenant.id, b.tenantId));
  return t;
};

const closureEvents = () =>
  owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'tenant.closed'));

/** A person + employment in the base company; `terminatedOn` null = still employed. */
async function makeEmp(name: string, terminatedOn: string | null = null): Promise<string> {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: name, primaryEmail: `${name}_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01', terminatedOn })
    .returning({ id: schema.employment.id });
  return e.id;
}

describe('close-tenant — what closure ENDS is reported before any verdict', () => {
  it('counts the companies and employments the operator is about to end', async () => {
    await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Acme Labuan Ltd' });
    await makeEmp('Ada');
    await makeEmp('Grace');
    await makeEmp('Alan', '2025-11-30');

    const out = await runClosure(url, opts());
    expect(out.impact).not.toBeNull();
    expect(out.impact!.tenantName).toBe('Acme Group');
    expect(out.impact!.companies, 'seedBase makes one company, this test adds a second').toBe(2);
    expect(out.impact!.employments).toBe(3);
    expect(out.impact!.activeEmployments).toBe(2);
    // Advisory context for the human resolving the retention horizon — this runner never decides it.
    expect(out.impact!.latestTerminationOn).toBe('2025-11-30');
  });

  it('reports zeroes rather than failing on a tenant nobody ever used', async () => {
    const out = await runClosure(url, opts());
    expect(out.impact!.employments).toBe(0);
    expect(out.impact!.latestTerminationOn).toBeNull();
  });

  it('refuses a tenant id that does not exist, instead of closing something adjacent', async () => {
    const out = await runClosure(url, opts({ tenantId: randomUUID() }));
    expect(out.impact).toBeNull();
    expect(out.decision.action).toBe('refuse');
    expect(out.applied).toBe(false);
  });
});

describe('close-tenant — REPORT ONLY unless --apply', () => {
  it('says it would close, and changes nothing', async () => {
    const out = await runClosure(url, opts({ apply: false }));
    expect(out.decision.action).toBe('close');
    expect(out.applied, 'report mode must never write').toBe(false);

    const t = await tenantRow();
    expect(t.status).toBe('active');
    expect(t.closedAt).toBeNull();
    expect(t.closureRequestedBy).toBeNull();
    expect(await closureEvents()).toHaveLength(0);
  });
});

describe('close-tenant — every refusal arrives in words, and writes nothing', () => {
  /** Every refusal must leave the tenant exactly as it was. A partial closure is the worst outcome. */
  const expectUntouched = async () => {
    const t = await tenantRow();
    expect(t.status).toBe('active');
    expect(t.closedAt).toBeNull();
    expect(t.closureRequestedBy).toBeNull();
    expect(t.closureApprovedBy).toBeNull();
    expect(await closureEvents(), 'a refused closure is not an event').toHaveLength(0);
  };

  it('REFUSES when the requester and the approver are the same person', async () => {
    const out = await runClosure(url, opts({ requestedBy: ALICE, approvedBy: ALICE, apply: true }));
    expect(out.decision.action).toBe('refuse');
    expect(out.decision.reason).toContain('two different people');
    expect(out.applied).toBe(false);
    await expectUntouched();
  });

  it('REFUSES with no approver — one person cannot approve their own request', async () => {
    const out = await runClosure(url, opts({ approvedBy: null, apply: true }));
    expect(out.decision.action).toBe('refuse');
    expect(out.decision.reason).toContain('approved');
    await expectUntouched();
  });

  it('REFUSES with no recorded requester', async () => {
    const out = await runClosure(url, opts({ requestedBy: null, apply: true }));
    expect(out.decision.action).toBe('refuse');
    expect(out.decision.reason).toContain('requester');
    await expectUntouched();
  });

  it('REFUSES while statutory retention still runs, and names the date', async () => {
    const out = await runClosure(url, opts({ retentionHeldUntil: '2031-12-31', apply: true }));
    expect(out.decision.action).toBe('refuse');
    expect(out.decision.reason).toContain('2031-12-31');
    await expectUntouched();
  });

  it('allows the closure once that same hold has passed — the boundary, not the vibe', async () => {
    const out = await runClosure(url, opts({ retentionHeldUntil: '2026-08-03', today: '2026-08-03', apply: true }));
    expect(out.decision.action).toBe('close');
    expect(out.applied).toBe(true);
  });

  it('REFUSES an already-closed tenant rather than closing it twice', async () => {
    await runClosure(url, opts({ apply: true }));
    const first = await tenantRow();

    const second = await runClosure(url, opts({ requestedBy: BOB, approvedBy: ALICE, apply: true }));
    expect(second.decision.action).toBe('refuse');
    expect(second.decision.reason).toContain('already closed');

    const after = await tenantRow();
    expect(after.closedAt?.getTime(), 'the second run must not restamp the closure').toBe(first.closedAt?.getTime());
    expect(after.closureRequestedBy, 'nor rewrite who agreed to it').toBe(ALICE);
    expect(await closureEvents(), 'no second event for a state already reached').toHaveLength(1);
  });
});

describe('close-tenant — --apply records WHO agreed', () => {
  it('closes the tenant and stamps both halves of the dual control', async () => {
    const out = await runClosure(url, opts({ apply: true }));
    expect(out.applied).toBe(true);

    const t = await tenantRow();
    expect(t.status).toBe('closed');
    expect(t.closedAt).not.toBeNull();
    expect(t.closureRequestedBy).toBe(ALICE);
    expect(t.closureApprovedBy).toBe(BOB);
    expect(t.closureRequestedAt?.toISOString()).toBe('2026-08-01T09:00:00.000Z');
    expect(t.closureApprovedAt?.toISOString()).toBe('2026-08-02T09:00:00.000Z');
  });

  it('appends the event that survives the columns being edited later', async () => {
    await makeEmp('Ada');
    await makeEmp('Alan', '2025-11-30');
    await runClosure(url, opts({ apply: true, retentionHeldUntil: '2026-08-01' }));

    const events = await closureEvents();
    expect(events, 'a customer account ending must leave a record of why').toHaveLength(1);
    expect(events[0].aggregateType).toBe('tenant');
    expect(events[0].aggregateId).toBe(b.tenantId);
    const payload = events[0].payload as {
      requestedBy: string;
      approvedBy: string;
      statusBefore: string;
      retentionHeldUntil: string | null;
      employments: number;
      activeEmployments: number;
    };
    expect(payload.requestedBy).toBe(ALICE);
    expect(payload.approvedBy).toBe(BOB);
    expect(payload.statusBefore, 'what it was before, so the event alone tells the story').toBe('active');
    expect(payload.retentionHeldUntil).toBe('2026-08-01');
    expect(payload.employments).toBe(2);
    expect(payload.activeEmployments).toBe(1);
  });

  it('closes a SUSPENDED tenant too — closure is where a dunning dead end legitimately ends', async () => {
    await owner.db.update(schema.tenant).set({ status: 'suspended' }).where(eq(schema.tenant.id, b.tenantId));
    const out = await runClosure(url, opts({ apply: true }));
    expect(out.applied).toBe(true);
    expect((await tenantRow()).status).toBe('closed');
  });

  /**
   * The open suspension window is left OPEN on purpose. `resumed_at` means the tenant RESUMED, and a
   * tenant that was suspended and then closed never did — stamping one to tidy the row would assert
   * something that did not happen, and suspendedDaysWithin would then report a frozen period that ended.
   */
  it('does not fabricate a resumption for a tenant that was closed while suspended', async () => {
    await owner.db.update(schema.tenant).set({ status: 'suspended' }).where(eq(schema.tenant.id, b.tenantId));
    await owner.db
      .insert(schema.tenantSuspensionWindow)
      .values({ tenantId: b.tenantId, suspendedAt: '2026-06-01', reason: 'past_due' });

    await runClosure(url, opts({ apply: true }));

    const [w] = await owner.db
      .select()
      .from(schema.tenantSuspensionWindow)
      .where(eq(schema.tenantSuspensionWindow.tenantId, b.tenantId));
    expect(w.resumedAt, 'the window stays open, because the tenant never resumed').toBeNull();
  });

  it('deletes nothing — closure starts the retention clock, it is not the end of it', async () => {
    const empId = await makeEmp('Ada');
    await runClosure(url, opts({ apply: true }));
    const rows = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, empId));
    expect(rows, 'the records this account holds outlive the account').toHaveLength(1);
  });
});

/**
 * The DB backstop from migration 0350. The runner refuses first, with a readable message; this CHECK is
 * what stops a hand-written UPDATE from closing a tenant on one person's say-so, and it is the reason
 * the runner is a convenience rather than the only thing standing in the way.
 */
describe('close-tenant — the database refuses single-person closure too', () => {
  /**
   * Matched against the CAUSE, not the thrown message: drizzle wraps a driver error in
   * `Failed query: update "tenant" set …`, which is true of a NOT NULL violation and a typo'd column
   * too. Reading the underlying Postgres error is what makes this assert the CHECK and not just "the
   * statement failed somehow".
   */
  const rejectionCause = async (patch: Partial<typeof schema.tenant.$inferInsert>): Promise<string> => {
    const err = await owner.db
      .update(schema.tenant)
      .set(patch)
      .where(eq(schema.tenant.id, b.tenantId))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err, 'the database must not accept this at all').not.toBeNull();
    return String((err as { cause?: unknown })?.cause ?? err);
  };

  it('rejects a closed_at written with only one party', async () => {
    const cause = await rejectionCause({ status: 'closed', closedAt: new Date(), closureRequestedBy: ALICE });
    expect(cause).toContain('tenant_closure_dual_control_check');
  });

  it('rejects a closed_at where both ids are the same person', async () => {
    const cause = await rejectionCause({
      status: 'closed',
      closedAt: new Date(),
      closureRequestedBy: ALICE,
      closureApprovedBy: ALICE,
    });
    expect(cause).toContain('tenant_closure_dual_control_check');
  });
});
