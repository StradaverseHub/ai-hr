/**
 * Statutory-pack ingest (ADR-0020 §4, Slice 3) — owner-role verify + content-validate + atomic write, with
 * idempotency, monotonic packVersion, identity-conflict, untrusted-key, and trust-rollback guards.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrivateKey, sign, createHash, type KeyObject, type JsonWebKey as CryptoJWK } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ingestPack, ingestTrustBundle, PackIngestError } from '../localization/statutory-pack/ingest';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import { closeAll, migrateTestDb, owner, resetDb } from './harness';

const TESTDATA = join(process.cwd(), 'localization', 'statutory-pack', 'testdata');
const keys = JSON.parse(readFileSync(join(TESTDATA, 'dev-keys.json'), 'utf8')) as {
  root: { keyId: string; privateJwk: CryptoJWK };
  op: { keyId: string; privateJwk: CryptoJWK; publicKey: string };
};
const rootPriv = createPrivateKey({ key: keys.root.privateJwk, format: 'jwk' });
const opPriv = createPrivateKey({ key: keys.op.privateJwk, format: 'jwk' });
const NOW = new Date('2026-06-15T00:00:00Z');
const FAR = '2099-01-01T00:00:00.000Z';
const ISSUED = '2026-01-01T00:00:00.000Z';
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function envelope(keyId: string, payloadObj: unknown, priv: KeyObject): string {
  const payload = JSON.stringify(payloadObj);
  const sig = sign(null, Buffer.from(payload, 'utf8'), priv).toString('base64');
  return JSON.stringify({ schemaVersion: 1, keyId, sig, payload, checksum: createHash('sha256').update(payload).digest('hex') });
}
const trustBundle = (sequence: number, revoked: { keyId: string; revokedAt: string }[] = []) =>
  envelope('my-root-dev-1', { sequence, issuedAt: ISSUED, keys: [{ keyId: 'my-op-dev-1', publicKey: keys.op.publicKey, certifiedAt: ISSUED, expiresAt: FAR }], revoked }, rootPriv);
const pack = (packVersion: string, rulesets: { version: string; effectiveFrom: string; data: unknown }[]) =>
  envelope('my-op-dev-1', { country: 'MY', packVersion, issuedAt: ISSUED, validUntil: FAR, rulesets }, opPriv);

describe('ADR-0020 §4 — statutory-pack ingest', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('ingests a trust bundle then a valid pack, idempotently', async () => {
    await ingestTrustBundle(owner.db, trustBundle(1));
    const p = pack('2026.01.01', [{ version: '2026.1', effectiveFrom: '2026-01-01', data: DEFAULT_MY_STATUTORY }]);
    expect((await ingestPack(owner.db, p, { source: 't', now: NOW })).rulesets).toBe(1);
    // re-ingest identical → idempotent skip, no new row.
    const again = await ingestPack(owner.db, p, { source: 't', now: NOW });
    expect(again.rulesets).toBe(0);
    expect(again.skipped).toBe(1);
  });

  it('rejects a pack signed by a key not in the trust set', async () => {
    // no trust bundle ingested → empty trust set
    const p = pack('2026.01.01', [{ version: '2026.1', effectiveFrom: '2026-01-01', data: DEFAULT_MY_STATUTORY }]);
    await expect(ingestPack(owner.db, p, { source: 't', now: NOW })).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
  });

  it('rejects a signed-but-invalid ruleset (content validated at ingest)', async () => {
    await ingestTrustBundle(owner.db, trustBundle(1));
    const bad = clone(DEFAULT_MY_STATUTORY);
    bad.epf.employeeRate = 2; // out of [0,1]
    const p = pack('2026.01.01', [{ version: 'x', effectiveFrom: '2026-01-01', data: bad }]);
    await expect(ingestPack(owner.db, p, { source: 't', now: NOW })).rejects.toBeInstanceOf(PackIngestError);
  });

  it('rejects a non-first-of-month effective date', async () => {
    await ingestTrustBundle(owner.db, trustBundle(1));
    const p = pack('2026.01.01', [{ version: 'x', effectiveFrom: '2026-01-15', data: DEFAULT_MY_STATUTORY }]);
    await expect(ingestPack(owner.db, p, { source: 't', now: NOW })).rejects.toMatchObject({ code: 'NOT_FIRST_OF_MONTH' });
  });

  it('enforces monotonic packVersion per country', async () => {
    await ingestTrustBundle(owner.db, trustBundle(1));
    await ingestPack(owner.db, pack('2026.02.01', [{ version: 'a', effectiveFrom: '2026-02-01', data: DEFAULT_MY_STATUTORY }]), { source: 't', now: NOW });
    await expect(
      ingestPack(owner.db, pack('2026.01.01', [{ version: 'b', effectiveFrom: '2026-01-01', data: DEFAULT_MY_STATUTORY }]), { source: 't', now: NOW }),
    ).rejects.toMatchObject({ code: 'NON_MONOTONIC' });
  });

  it('rejects a reused identity with different content (IDENTITY_CONFLICT)', async () => {
    await ingestTrustBundle(owner.db, trustBundle(1));
    const a = clone(DEFAULT_MY_STATUTORY);
    const b = clone(DEFAULT_MY_STATUTORY);
    b.ot.wageCeiling = 4500; // same identity, different content
    await ingestPack(owner.db, pack('2026.03.01', [{ version: 'v1', effectiveFrom: '2026-03-01', data: a }]), { source: 't', now: NOW });
    await expect(
      ingestPack(owner.db, pack('2026.03.01', [{ version: 'v1', effectiveFrom: '2026-03-01', data: b }]), { source: 't', now: NOW }),
    ).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
  });

  it('rejects a strictly-older trust bundle but re-ingests the SAME sequence idempotently', async () => {
    await ingestTrustBundle(owner.db, trustBundle(2));
    await expect(ingestTrustBundle(owner.db, trustBundle(1))).rejects.toMatchObject({ code: 'TRUST_ROLLBACK' });
    // Re-ingesting the same sequence (a normal repeated sync / crash retry) must succeed, not error.
    await expect(ingestTrustBundle(owner.db, trustBundle(2))).resolves.toMatchObject({ sequence: 2 });
  });

  it('a revoked operational key cannot ingest a pack', async () => {
    await ingestTrustBundle(owner.db, trustBundle(2, [{ keyId: 'my-op-dev-1', revokedAt: ISSUED }]));
    const p = pack('2026.01.01', [{ version: '2026.1', effectiveFrom: '2026-01-01', data: DEFAULT_MY_STATUTORY }]);
    await expect(ingestPack(owner.db, p, { source: 't', now: NOW })).rejects.toMatchObject({ code: 'REVOKED_KEY' });
  });

  it('rejects a mis-formatted packVersion (anti-rollback soundness)', async () => {
    await ingestTrustBundle(owner.db, trustBundle(1));
    const p = pack('2026.2.01', [{ version: 'x', effectiveFrom: '2026-02-01', data: DEFAULT_MY_STATUTORY }]);
    await expect(ingestPack(owner.db, p, { source: 't', now: NOW })).rejects.toMatchObject({ code: 'BAD_PACK_VERSION' });
  });

  it('rejects a far-future effective date (> 18 months after issuedAt)', async () => {
    await ingestTrustBundle(owner.db, trustBundle(1));
    const p = pack('2026.01.01', [{ version: 'x', effectiveFrom: '2030-01-01', data: DEFAULT_MY_STATUTORY }]);
    await expect(ingestPack(owner.db, p, { source: 't', now: NOW })).rejects.toMatchObject({ code: 'EFFECTIVE_TOO_FAR' });
  });
});
