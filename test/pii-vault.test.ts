/**
 * #159 — ADR-0030 Layer-1 per-subject crypto-shred vault. Seal/unseal round-trip, shred-makes-unrecoverable,
 * GCM tamper rejection, fail-closed when the master key is absent, and the substrate event (no PII payload).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import {
  MasterKeyUnavailableError,
  SubjectShreddedError,
  sealForSubject,
  shredSubject,
  subjectHasActiveKey,
  unsealForSubject,
} from '../core/pii-vault';

let b: Base;
let employmentId: string;

beforeAll(async () => {
  process.env.AI_CONFIG_SECRET = 'test-pii-master-passphrase-0123456789'; // ≥16 chars → key storage enabled
  await migrateTestDb();
});
afterAll(async () => {
  delete process.env.AI_CONFIG_SECRET;
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // a real employment so the pii.key.destroyed event's subject_employment_id FK resolves
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: 'Test Subject', primaryEmail: `s_${randomUUID()}@test.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2026-01-01' })
    .returning({ id: schema.employment.id });
  employmentId = e.id;
});

describe('PII crypto-shred vault (ADR-0030 Layer 1, #159)', () => {
  it('seals then unseals round-trip; reuses the subject DEK; fresh IV per seal', async () => {
    const ctx = adminCtx(b);
    const t1 = await sealForSubject(ctx, employmentId, '880101-10-5566');
    const t2 = await sealForSubject(ctx, employmentId, '880101-10-5566');
    expect(t1).not.toBe(t2); // fresh IV → different ciphertext for the same plaintext
    expect(t1.split('.')[0]).toBe(t2.split('.')[0]); // same kid → DEK reused, not re-minted
    expect(await unsealForSubject(ctx, employmentId, t1)).toBe('880101-10-5566');
    expect(await unsealForSubject(ctx, employmentId, t2)).toBe('880101-10-5566');
    const keys = await owner.db.select().from(schema.piiKey).where(eq(schema.piiKey.subjectEmploymentId, employmentId));
    expect(keys).toHaveLength(1);
  });

  it('crypto-shred makes sealed values unrecoverable + logs a destroyed event with no PII payload', async () => {
    const ctx = adminCtx(b);
    const token = await sealForSubject(ctx, employmentId, 'MBB 5141-2233-4455');
    expect(await subjectHasActiveKey(ctx, employmentId)).toBe(true);

    const { shredded } = await shredSubject(ctx, employmentId, 'PDPA erasure DPO-2026-07');
    expect(shredded).toBe(1);
    expect(await subjectHasActiveKey(ctx, employmentId)).toBe(false);
    await expect(unsealForSubject(ctx, employmentId, token)).rejects.toBeInstanceOf(SubjectShreddedError);

    expect(await eventTypesFor(b.tenantId, employmentId)).toContain('pii.key.destroyed');
    const evs = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, employmentId));
    const blob = JSON.stringify(evs.map((e) => e.payload));
    expect(blob).not.toContain('5141'); // bank fragment never enters the log
    expect(blob).toContain('DPO-2026-07'); // the non-PII reason is fine to record
  });

  it('rejects a tampered token (GCM auth tag / AAD)', async () => {
    const ctx = adminCtx(b);
    const token = await sealForSubject(ctx, employmentId, 'secret-value');
    const parts = token.split('.');
    parts[2] = Buffer.from('tampered-ciphertext-bytes').toString('base64');
    await expect(unsealForSubject(ctx, employmentId, parts.join('.'))).rejects.toThrow();
  });

  it('fail-closed: refuses to seal when the master key is unavailable', async () => {
    const ctx = adminCtx(b);
    const saved = process.env.AI_CONFIG_SECRET;
    delete process.env.AI_CONFIG_SECRET;
    try {
      await expect(sealForSubject(ctx, employmentId, 'x')).rejects.toBeInstanceOf(MasterKeyUnavailableError);
    } finally {
      process.env.AI_CONFIG_SECRET = saved;
    }
  });

  it('shred is idempotent', async () => {
    const ctx = adminCtx(b);
    await sealForSubject(ctx, employmentId, 'v');
    expect((await shredSubject(ctx, employmentId, 'r1')).shredded).toBe(1);
    expect((await shredSubject(ctx, employmentId, 'r2')).shredded).toBe(0);
  });
});
