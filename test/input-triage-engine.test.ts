/**
 * ADR-0084 §2.7 — input triage against a real database. The adjudicator is unit-tested without one in
 * test/input-triage.test.ts; this file owns what only a database can prove.
 *
 * NO PROVIDER IS CONFIGURED IN ANY TEST HERE, AND THAT IS THE POINT. Everything below is a property of the
 * DETERMINISTIC half — which claims are even looked at, what is recorded when nothing is proposed, and the
 * one property the whole section rests on: **nothing this layer does can change a claim.** Those must hold
 * whatever a model says, and the one path that needs a model's answer is exercised by appending the event
 * it would have appended and letting the real notification engine route it.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent } from '../db/events';
import { dispatchNotifications } from '../core/notifications';
import { TRIAGE_WINDOW_DAYS, triagePendingClaims } from '../core/input-triage';
import {
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  setSetting,
  type Base,
} from './harness';

let b: Base;
let a: SessionContext;

async function hire(name: string) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: name, primaryEmail: `${name}_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01' })
    .returning({ id: schema.employment.id });
  return { employmentId: e.id, personId: p.id };
}

async function claimType(name = 'Mileage') {
  const [t] = await owner.db
    .insert(schema.claimType)
    .values({ tenantId: b.tenantId, code: `T_${randomUUID().slice(0, 8)}`, name })
    .returning({ id: schema.claimType.id });
  return t.id;
}

/** One claim, inserted directly: this layer's contract is "read whatever is pending", not "submit one". */
async function fileClaim(
  employmentId: string,
  claimTypeId: string,
  over: Partial<typeof schema.claimRequest.$inferInsert> = {},
) {
  const [c] = await owner.db
    .insert(schema.claimRequest)
    .values({
      tenantId: b.tenantId,
      employmentId,
      claimTypeId,
      amount: '312.50',
      incurredOn: '2026-08-14',
      description: 'Drove to the client site in Shah Alam and back',
      status: 'pending',
      ...over,
    })
    .returning({ id: schema.claimRequest.id });
  return c.id;
}

const proposals = () => owner.db.select().from(schema.agentProposal);
const statusOf = async (id: string) => {
  const [r] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, id));
  return r.status;
};

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  a = await entitledCtx(b);
});

describe('the tenant switch is the kill switch', () => {
  it('does nothing at all, and records nothing, when the tenant has not switched it on', async () => {
    const e = await hire('Ali');
    await fileClaim(e.employmentId, await claimType());

    const run = await triagePendingClaims(a);
    expect(run.disabled).toBe(true);
    expect(run.candidates).toBe(0);
    expect(await proposals()).toHaveLength(0);
  });
});

describe('which claims are looked at at all', () => {
  beforeEach(async () => {
    await setSetting(b.tenantId, 'claims.input_triage_enabled', true);
    a = await entitledCtx(b);
  });

  it('counts a fresh pending claim, and records NOTHING without a provider', async () => {
    const e = await hire('Ali');
    await fileClaim(e.employmentId, await claimType());

    const run = await triagePendingClaims(a);
    expect(run.candidates).toBe(1);
    expect(run.notConfigured).toBe(true);
    expect(run.asked).toBe(0);
    // ⚠️ A TENANT WITH NO PROVIDER PROPOSED NOTHING. Recording a row here would put the absence of a
    // subscription into the adjudication-pass rate, which measures the model.
    expect(await proposals()).toHaveLength(0);
  });

  it('ignores a claim that is not pending — a decided claim is not an input problem', async () => {
    const e = await hire('Ali');
    const t = await claimType();
    await fileClaim(e.employmentId, t, { status: 'approved' });
    await fileClaim(e.employmentId, t, { status: 'rejected' });
    await fileClaim(e.employmentId, t, { status: 'draft' });

    expect((await triagePendingClaims(a)).candidates).toBe(0);
  });

  it('ignores a claim older than the window — that is an approver problem, and the wrong person to ask', async () => {
    const e = await hire('Ali');
    const old = new Date(Date.now() - (TRIAGE_WINDOW_DAYS + 2) * 24 * 60 * 60 * 1000);
    await fileClaim(e.employmentId, await claimType(), { createdAt: old });

    expect((await triagePendingClaims(a)).candidates).toBe(0);
  });

  it('looks at a claim ONCE EVER — the ledger is what remembers, not a column on the claim', async () => {
    const e = await hire('Ali');
    const id = await fileClaim(e.employmentId, await claimType());
    // The row an earlier pass would have written. Its description cannot change while it is pending, so a
    // second look would ask the same person the same question about the same words.
    await owner.db.insert(schema.agentProposal).values({
      tenantId: b.tenantId,
      proposalType: 'input_triage',
      subjectType: 'claim_request',
      subjectId: id,
      inputDigest: 'seeded',
      proposal: { verdict: 'ok' },
      adjudication: 'accepted',
    });

    expect((await triagePendingClaims(a)).candidates).toBe(0);
  });
});

describe('the invariant §2.7 rests on', () => {
  it('cannot change a claim — not its status, not anything', async () => {
    await setSetting(b.tenantId, 'claims.input_triage_enabled', true);
    a = await entitledCtx(b);
    const e = await hire('Ali');
    const t = await claimType();
    const pending = await fileClaim(e.employmentId, t);
    const thin = await fileClaim(e.employmentId, t, { description: 'x', incurredOn: '2026-08-13' });

    await triagePendingClaims(a);

    expect(await statusOf(pending)).toBe('pending');
    expect(await statusOf(thin)).toBe('pending');
  });
});

describe('the question reaches the person who filed the claim', () => {
  it('notifies the CLAIMANT, not the approver, and says nothing is wrong', async () => {
    // The event the sweep appends once a query has survived adjudication. Appending it directly is what
    // lets this assert the REGISTRY's routing — the half a model's answer does not change.
    await setModule(b.tenantId, 'notifications', 'active');
    const notifyCtx = await entitledCtx(b);
    const claimant = await hire('Ali');
    const other = await hire('Siti');
    const id = await fileClaim(claimant.employmentId, await claimType());

    await withTenant(notifyCtx, (tx) =>
      appendEvent(tx, {
        tenantId: b.tenantId,
        aggregateType: 'claim-request',
        aggregateId: id,
        eventType: 'claim-request.triage-queried',
        actor: { type: 'agent' },
        subjectEmploymentId: claimant.employmentId,
        payload: { policyRuleId: 'claim.category_mismatch', reason: 'This is filed under Mileage but reads like a meal — is that right?' },
      }),
    );
    await dispatchNotifications(notifyCtx, {});

    const mine = await owner.db
      .select({ kind: schema.notification.kind, severity: schema.notification.severity, body: schema.notification.body })
      .from(schema.notification)
      .where(eq(schema.notification.recipientEmploymentId, claimant.employmentId));
    expect(mine.map((n) => n.kind)).toContain('claim.triageQueried');
    const q = mine.find((n) => n.kind === 'claim.triageQueried')!;
    // Nothing is wrong, nothing is refused, nothing is required — a warning would say otherwise.
    expect(q.severity).toBe('info');
    // The QUESTION is the body, stored from the payload the sweep put on the event.
    expect(q.body).toContain('reads like a meal');

    // …and nobody else is told. A question about somebody's claim is between them and the system.
    const theirs = await owner.db
      .select({ kind: schema.notification.kind })
      .from(schema.notification)
      .where(eq(schema.notification.recipientEmploymentId, other.employmentId));
    expect(theirs.map((n) => n.kind)).not.toContain('claim.triageQueried');
  });
});
