/**
 * #159 — ADR-0030 Layer-2 per-tenant tamper-evidence hash chain. With the gate on, appended events chain
 * (contiguous chain_seq, GENESIS root, prev_hash links, 64-hex sha256); the verifier detects a mutated
 * payload and a deleted row; with the gate off the columns stay NULL (byte-identical).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { withTenant } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { verifyTenantChain } from '../core/audit-chain';

let b: Base;

async function appendN(ctx: ReturnType<typeof adminCtx>, n: number) {
  await withTenant(ctx, async (tx) => {
    for (let i = 0; i < n; i++) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'test',
        aggregateId: randomUUID(),
        eventType: `test.event.${i}`,
        actor: actorOf(ctx),
        payload: { i },
      });
    }
  });
}

beforeAll(async () => {
  process.env.AUDIT_HASH_CHAIN_ENABLED = '1';
  await migrateTestDb();
});
afterAll(async () => {
  delete process.env.AUDIT_HASH_CHAIN_ENABLED;
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('domain_event hash chain (ADR-0030 Layer 2, #159)', () => {
  it('chains appended events and verifies an intact chain', async () => {
    const ctx = adminCtx(b);
    await appendN(ctx, 3);
    const rows = await owner.db
      .select({ chainSeq: schema.domainEvent.chainSeq, hash: schema.domainEvent.hash, prevHash: schema.domainEvent.prevHash })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.tenantId, b.tenantId))
      .orderBy(schema.domainEvent.chainSeq);
    expect(rows.map((r) => r.chainSeq)).toEqual([1, 2, 3]);
    expect(rows[0].prevHash).toBe('GENESIS');
    expect(rows[1].prevHash).toBe(rows[0].hash); // links to the prior row
    expect(rows[2].prevHash).toBe(rows[1].hash);
    expect(rows.every((r) => r.hash && r.hash.length === 64)).toBe(true); // sha256 hex
    expect(await verifyTenantChain(ctx)).toMatchObject({ valid: true, checked: 3, firstBadSeq: null });
  });

  it('detects a mutated payload', async () => {
    const ctx = adminCtx(b);
    await appendN(ctx, 3);
    const [first] = await owner.db
      .select({ id: schema.domainEvent.id })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.tenantId, b.tenantId))
      .orderBy(schema.domainEvent.chainSeq)
      .limit(1);
    await owner.db.update(schema.domainEvent).set({ payload: { i: 999, tampered: true } }).where(eq(schema.domainEvent.id, first.id));
    const v = await verifyTenantChain(ctx);
    expect(v.valid).toBe(false);
    expect(v.firstBadSeq).toBe(1);
    expect(v.issues.some((i) => i.problem === 'mutated')).toBe(true);
  });

  it('detects a deleted row (chain gap)', async () => {
    const ctx = adminCtx(b);
    await appendN(ctx, 3);
    await owner.db.delete(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.chainSeq, 2)));
    const v = await verifyTenantChain(ctx);
    expect(v.valid).toBe(false);
    expect(v.firstBadSeq).toBe(3); // the row after the gap fails the contiguity check
    expect(v.issues.some((i) => i.problem === 'gap')).toBe(true);
  });

  it('flag OFF leaves chain columns NULL (byte-identical)', async () => {
    const saved = process.env.AUDIT_HASH_CHAIN_ENABLED;
    delete process.env.AUDIT_HASH_CHAIN_ENABLED;
    try {
      const ctx = adminCtx(b);
      await appendN(ctx, 2);
      const rows = await owner.db
        .select({ chainSeq: schema.domainEvent.chainSeq, hash: schema.domainEvent.hash })
        .from(schema.domainEvent)
        .where(eq(schema.domainEvent.tenantId, b.tenantId));
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.chainSeq === null && r.hash === null)).toBe(true);
    } finally {
      process.env.AUDIT_HASH_CHAIN_ENABLED = saved;
    }
  });
});
