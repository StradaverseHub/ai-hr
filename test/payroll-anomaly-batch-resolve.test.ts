/**
 * The Exceptions page's group action: `resolveAnomalyVerdicts` resolves up to 25 verdicts in ONE transaction that takes the
 * access-configuration write lock ONCE, with the same per-item authority, audit event and ledger stamp as the single
 * `resolveAnomalyVerdict`, and a per-id outcome. And the concurrency guard both share: a verdict somebody already decided
 * is reported as such, never overwritten and never audited twice. Against a real database; every person is fictional.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import * as accessLock from '../core/access-configuration-lock';
import { MAX_BATCH_RESOLVE, resolveAnomalyVerdict, resolveAnomalyVerdicts } from '../core/payroll-anomaly';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

vi.mock('../core/access-configuration-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/access-configuration-lock')>();
  return { ...actual, lockAccessConfigurationWriteTx: vi.fn(actual.lockAccessConfigurationWriteTx) };
});
const lockSpy = vi.mocked(accessLock.lockAccessConfigurationWriteTx);

let b: Base;
let a: SessionContext;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  a = await entitledCtx(b);
  lockSpy.mockClear();
});

async function batchFor(companyId: string, period = '2026-05') {
  const [pp] = await owner.db.insert(schema.payPeriod).values({ tenantId: b.tenantId, companyId, period, status: 'open' }).returning({ id: schema.payPeriod.id });
  const [batch] = await owner.db.insert(schema.payrollBatch)
    .values({ tenantId: b.tenantId, companyId, payPeriodId: pp.id, payPeriod: period, batchDate: `${period}-28`, status: 'processed' })
    .returning({ id: schema.payrollBatch.id });
  return batch.id;
}
async function verdictFor(batchId: string, companyId: string, over: Partial<typeof schema.payrollAnomalyVerdict.$inferInsert> = {}) {
  const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: `Fictional ${randomUUID().slice(0, 6)}`, primaryEmail: `${randomUUID()}@fixture.test` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db.insert(schema.employment).values({ tenantId: b.tenantId, personId: p.id, companyId, hiredOn: '2020-01-01', paymentMethod: 'bank_transfer' })
    .returning({ id: schema.employment.id });
  const [v] = await owner.db.insert(schema.payrollAnomalyVerdict).values({ tenantId: b.tenantId, batchId, employmentId: e.id, disposition: 'review', ...over })
    .returning({ id: schema.payrollAnomalyVerdict.id });
  return v.id;
}
const verdictRow = async (id: string) => (await owner.db.select().from(schema.payrollAnomalyVerdict).where(eq(schema.payrollAnomalyVerdict.id, id)))[0];
const resolvedEvents = (id: string) =>
  owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId, id), eq(schema.domainEvent.eventType, 'payroll.anomaly.resolved')));

describe('resolveAnomalyVerdicts — one lock, per-item checks, per-id outcomes', () => {
  it('resolves the open ones and reports every other id honestly, taking the write lock ONCE', async () => {
    const batchId = await batchFor(b.companyId);
    const open = [await verdictFor(batchId, b.companyId), await verdictFor(batchId, b.companyId), await verdictFor(batchId, b.companyId)];
    const decided = await verdictFor(batchId, b.companyId);
    await resolveAnomalyVerdict(a, { verdictId: decided, resolution: 'false_positive', note: 'Fictional first decision.' });
    const superseded = await verdictFor(batchId, b.companyId, { supersededAt: new Date() });
    const missing = randomUUID();
    lockSpy.mockClear();

    const out = await resolveAnomalyVerdicts(a, { verdictIds: [...open, decided, superseded, missing], resolution: 'accepted', note: 'Fictional group decision.' });

    expect(lockSpy).toHaveBeenCalledTimes(1);
    expect(out.results).toEqual([
      ...open.map((verdictId) => ({ verdictId, outcome: 'resolved' })),
      { verdictId: decided, outcome: 'already_resolved' },
      { verdictId: superseded, outcome: 'superseded' },
      { verdictId: missing, outcome: 'not_found' },
    ]);
    for (const id of open) {
      expect(await verdictRow(id)).toMatchObject({ resolution: 'accepted', resolutionNote: 'Fictional group decision.', resolvedByUserId: b.adminUserId });
      expect(await resolvedEvents(id)).toHaveLength(1);
    }
    // The first person's decision stands, with its one event.
    expect(await verdictRow(decided)).toMatchObject({ resolution: 'false_positive', resolutionNote: 'Fictional first decision.' });
    expect(await resolvedEvents(decided)).toHaveLength(1);
    expect((await verdictRow(superseded)).resolvedAt).toBeNull();
  });

  it('a verdict of a company the caller does not administer is not resolved and its existence is not disclosed', async () => {
    const [other] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Fictional Other Sdn Bhd' }).returning({ id: schema.company.id });
    const mine = await verdictFor(await batchFor(b.companyId), b.companyId);
    const theirs = await verdictFor(await batchFor(other.id), other.id);
    // An HR administrator of THIS company only.
    const [u] = await owner.db.insert(schema.appUser).values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null }).returning({ id: schema.appUser.id });
    await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId: b.companyId, role: 'hr_admin' });
    const scoped: SessionContext = { ...a, userId: u.id, personId: null, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: b.companyId }] };

    const out = await resolveAnomalyVerdicts(scoped, { verdictIds: [mine, theirs], resolution: 'accepted' });
    // Invisible under row security: reported exactly like an id that does not exist.
    expect(out.results).toEqual([{ verdictId: mine, outcome: 'resolved' }, { verdictId: theirs, outcome: 'not_found' }]);
    expect((await verdictRow(theirs)).resolvedAt).toBeNull();
    expect(await resolvedEvents(theirs)).toHaveLength(0);
  });

  it('a lock timeout is an ERROR for the whole call, never per-item skips', async () => {
    const batchId = await batchFor(b.companyId);
    const ids = [await verdictFor(batchId, b.companyId), await verdictFor(batchId, b.companyId)];
    lockSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    });
    await expect(resolveAnomalyVerdicts(a, { verdictIds: ids, resolution: 'accepted' })).rejects.toMatchObject({ code: '55P03' });
    for (const id of ids) {
      expect((await verdictRow(id)).resolvedAt).toBeNull();
      expect(await resolvedEvents(id)).toHaveLength(0);
    }
  });

  it('accepts 1 to 25 ids only', async () => {
    expect(MAX_BATCH_RESOLVE).toBe(25);
    await expect(resolveAnomalyVerdicts(a, { verdictIds: [], resolution: 'accepted' })).rejects.toThrow();
    await expect(resolveAnomalyVerdicts(a, { verdictIds: Array.from({ length: 26 }, () => randomUUID()), resolution: 'accepted' })).rejects.toThrow();
    await expect(resolveAnomalyVerdicts(a, { verdictIds: ['not-an-id'], resolution: 'accepted' })).rejects.toThrow();
  });
});

describe('the single resolve shares the concurrency guard', () => {
  it('a second decision on the same verdict reports already_resolved and neither overwrites nor audits again', async () => {
    const id = await verdictFor(await batchFor(b.companyId), b.companyId);
    expect(await resolveAnomalyVerdict(a, { verdictId: id, resolution: 'false_positive' })).toEqual({ outcome: 'resolved' });
    expect(await resolveAnomalyVerdict(a, { verdictId: id, resolution: 'accepted' })).toEqual({ outcome: 'already_resolved' });
    expect(await verdictRow(id)).toMatchObject({ resolution: 'false_positive' });
    expect(await resolvedEvents(id)).toHaveLength(1);
    // A superseded verdict is still refused outright by the single form, as before.
    const old = await verdictFor(await batchFor(b.companyId, '2026-06'), b.companyId, { supersededAt: new Date() });
    await expect(resolveAnomalyVerdict(a, { verdictId: old, resolution: 'accepted' })).rejects.toThrow(/superseded/);
  });
});
