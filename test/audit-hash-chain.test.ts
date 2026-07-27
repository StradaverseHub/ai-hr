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
  process.env.AUDIT_HASH_CHAIN_ENABLED = 'true';
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

  it("the gate is `=== 'true'`, not truthy — 'false' must NOT arm the chain", async () => {
    // THE BUG THIS PINS SHIPPED. `db/client.ts` compared this var truthily, and `.env.example` carried
    // an ACTIVE `AUDIT_HASH_CHAIN_ENABLED=false` line — and the string 'false' is truthy — so every
    // deployment built from the template had the chain ARMED while the template's own comment, the
    // catalog's parity note and 0313 all recorded it as OFF. Nothing tested the FORM of the read, so
    // nothing caught it; the drift test now asserts the form in the source, and this asserts the
    // behaviour end to end.
    const saved = process.env.AUDIT_HASH_CHAIN_ENABLED;
    try {
      for (const value of ['false', '0', 'no', '']) {
        await resetDb();
        b = await seedBase();
        process.env.AUDIT_HASH_CHAIN_ENABLED = value;
        const ctx = adminCtx(b);
        await appendN(ctx, 1);
        const rows = await owner.db
          .select({ chainSeq: schema.domainEvent.chainSeq })
          .from(schema.domainEvent)
          .where(eq(schema.domainEvent.tenantId, b.tenantId));
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.chainSeq === null), `AUDIT_HASH_CHAIN_ENABLED='${value}' must not arm the chain`).toBe(
          true,
        );
      }
    } finally {
      process.env.AUDIT_HASH_CHAIN_ENABLED = saved;
    }
  });

  it('a disarm→re-arm window is INVISIBLE to `valid` and is reported as `unchained` instead', async () => {
    // THE FAILURE THE SLICE-3 DEPLOY CAN ACTUALLY CAUSE, pinned so nobody re-asserts the comfortable
    // version of it. Correcting the gate to `=== 'true'` disarms the chain on every box that copied
    // .env.example, and both db/client.ts and DEPLOY.md originally claimed `verifyTenantChain()` would
    // "report a boundary at this deploy". It does not, and cannot: every query in core/audit-chain.ts
    // filters `chain_seq IS NOT NULL`, and the trigger takes its head from `max(chain_seq)` over those
    // same rows — so events written while the gate is off are ABSENT from the chain rather than a break
    // in it, and re-arming links straight onto the last chained event. Contiguous seq, matching
    // prev_hash, `valid: true`, over a log with an unverifiable hole in the middle.
    //
    // So `valid` staying TRUE here is the assertion, not an oversight — and `unchained` is the signal
    // that makes the hole visible. `scripts/check-audit-chain-gate.ts` is what stops a deploy creating
    // one in the first place.
    const ctx = adminCtx(b);
    await appendN(ctx, 2); // armed (beforeAll set the gate)

    const saved = process.env.AUDIT_HASH_CHAIN_ENABLED;
    process.env.AUDIT_HASH_CHAIN_ENABLED = 'false'; // the .env.example value, under the corrected read
    try {
      await appendN(ctx, 3); // the window: written with no chain columns
    } finally {
      process.env.AUDIT_HASH_CHAIN_ENABLED = saved;
    }
    await appendN(ctx, 2); // re-armed

    const rows = await owner.db
      .select({ chainSeq: schema.domainEvent.chainSeq })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.tenantId, b.tenantId));
    const chained = rows.filter((r) => r.chainSeq !== null).map((r) => Number(r.chainSeq)).sort((x, y) => x - y);
    expect(chained, 'the chain closes over the gap — this is why the verifier cannot see it').toEqual([1, 2, 3, 4]);

    const v = await verifyTenantChain(ctx);
    expect(v.valid, 'no link is broken: the unchained events are not IN the chain to break it').toBe(true);
    expect(v.checked, 'only the chained rows are verified…').toBe(4);
    expect(v.unchained, '…and the three written while the gate was off are counted, not silently dropped').toBe(3);
    // THE POSITIONAL FIGURE — the one the DPO surface renders. All three fell strictly after the first
    // chained event, so all three are inside the chain's coverage: an unambiguous hole.
    expect(v.unchainedInsideChain, 'the whole window sits inside the chain, so it is a hole, not history').toBe(3);
  });

  it('PRE-CHAIN history is reported as coverage, not as a hole — the count alone cannot tell them apart', async () => {
    // WHY THIS EXISTS (review r3). `checked > 0 && unchained > 0` was documented as "the dangerous
    // shape" and was what the admin banner rendered on. But 0074:5 defers the backfill of pre-existing
    // events by design, so every event a tenant recorded BEFORE the chain was first armed stays
    // `chain_seq IS NULL` permanently — i.e. every tenant that predates the arming matches that shape
    // forever, with or without a hole, and a real arm→disarm→re-arm window looks identical to ordinary
    // history. Position is the only thing that separates them.
    const ctx = adminCtx(b);
    const saved = process.env.AUDIT_HASH_CHAIN_ENABLED;
    delete process.env.AUDIT_HASH_CHAIN_ENABLED;
    try {
      await appendN(ctx, 3); // history from before the chain was ever switched on
    } finally {
      process.env.AUDIT_HASH_CHAIN_ENABLED = saved;
    }
    await appendN(ctx, 2); // …then the chain is armed and never disarmed again

    const v = await verifyTenantChain(ctx);
    expect(v.valid).toBe(true);
    expect(v.checked, 'the chained rows').toBe(2);
    expect(v.unchained, 'the bare count matches the "dangerous shape" — which is exactly the problem').toBe(3);
    expect(
      v.unchainedInsideChain,
      'nothing was recorded after the chain started without being chained, so there is NO hole',
    ).toBe(0);
  });

  it('reports unchained events even when the chain has never run', async () => {
    const saved = process.env.AUDIT_HASH_CHAIN_ENABLED;
    delete process.env.AUDIT_HASH_CHAIN_ENABLED;
    try {
      const ctx = adminCtx(b);
      await appendN(ctx, 2);
      const v = await verifyTenantChain(ctx);
      // checked === 0 is what the admin surface renders as "not enabled" — distinct from the partial
      // case above, where a chain exists and part of the history sits outside it.
      expect(v).toMatchObject({ valid: true, checked: 0 });
      expect(v.unchained).toBeGreaterThanOrEqual(2);
      // With no chained row at all the positional subquery is NULL, so nothing counts as inside — the
      // right answer, and the branch that would otherwise NULL-compare its way to a wrong one.
      expect(v.unchainedInsideChain, 'no chain ⇒ no hole in one').toBe(0);
    } finally {
      process.env.AUDIT_HASH_CHAIN_ENABLED = saved;
    }
  });
});
