/**
 * Statutory-pack RLS trust boundary (ADR-0020 §3, Slice 2). Proves — not asserts — that the national pack
 * tables are read-by-all / write-by-owner-only: the app role can SELECT but cannot INSERT/UPDATE/DELETE
 * (the cluster's default privileges auto-grant arwd, so this must be enforced by the explicit REVOKE).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const PACK_TABLES = ['statutory_pack', 'statutory_signing_key', 'statutory_pack_sync_log'];

describe('ADR-0020 §3 — statutory_pack RLS trust boundary', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('ai_hr_app may SELECT but NOT INSERT/UPDATE/DELETE the national pack tables', async () => {
    for (const t of PACK_TABLES) {
      const [row] = (await owner.client`
        SELECT has_table_privilege('ai_hr_app', ${t}, 'SELECT') AS s,
               has_table_privilege('ai_hr_app', ${t}, 'INSERT') AS i,
               has_table_privilege('ai_hr_app', ${t}, 'UPDATE') AS u,
               has_table_privilege('ai_hr_app', ${t}, 'DELETE') AS d
      `) as unknown as { s: boolean; i: boolean; u: boolean; d: boolean }[];
      expect(row.s, `${t} SELECT`).toBe(true);
      expect(row.i, `${t} INSERT`).toBe(false);
      expect(row.u, `${t} UPDATE`).toBe(false);
      expect(row.d, `${t} DELETE`).toBe(false);
    }
  });

  it('a tenant session reads the same national pack (USING(true), no tenant predicate)', async () => {
    // Owner ingests a national pack (no tenant_id).
    await owner.db.insert(schema.statutoryPack).values({
      country: 'MY',
      schemaVersion: 1,
      packVersion: '2026.10.01',
      rulesetVersion: 'v1',
      effectiveFrom: '2026-10-01',
      data: { ok: true },
      checksum: 'abc',
      signedKeyId: 'my-op-dev-1',
      issuedAt: new Date('2026-01-01T00:00:00Z'),
      validUntil: new Date('2099-01-01T00:00:00Z'),
      ingestedSource: 'test',
    });
    const rows = await withTenant(adminCtx(base), (tx) => tx.select().from(schema.statutoryPack));
    expect(rows.map((r) => r.packVersion)).toContain('2026.10.01');
  });

  it('a tenant session cannot write a national pack (RLS + REVOKE)', async () => {
    await expect(
      withTenant(adminCtx(base), (tx) =>
        tx.insert(schema.statutoryPack).values({
          country: 'MY',
          schemaVersion: 1,
          packVersion: 'forged',
          rulesetVersion: 'v1',
          effectiveFrom: '2026-10-01',
          data: {},
          checksum: 'x',
          signedKeyId: 'k',
          issuedAt: new Date('2026-01-01T00:00:00Z'),
          validUntil: new Date('2099-01-01T00:00:00Z'),
        }),
      ),
    ).rejects.toThrow();
  });
});
