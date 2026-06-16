/**
 * Hardened remote pull (ADR-0020 §5, Slice 4): the SSRF IP guard, the safe-fetch transport validation
 * (https-only / allowlist / private-address rejection — no network), and the pull orchestration (verify
 * signed index → anti-rollback → fetch + ingest each pack), tested with an injected fetcher.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrivateKey, sign, createHash, type KeyObject, type JsonWebKey as CryptoJWK } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPublicIp } from '../localization/statutory-pack/ip-guard';
import { safeFetchText, SafeFetchError } from '../localization/statutory-pack/fetch';
import { pullAndIngest, PullError } from '../localization/statutory-pack/pull';
import { ingestTrustBundle } from '../localization/statutory-pack/ingest';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import { closeAll, migrateTestDb, owner, resetDb } from './harness';

describe('ADR-0020 §5 — SSRF IP guard', () => {
  it('classifies private / loopback / link-local / CGNAT / mapped as non-public', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '192.168.1.1', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1'])
      expect(isPublicIp(ip), ip).toBe(false);
  });
  it('classifies public addresses as public', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.200.5', '2606:4700:4700::1111']) expect(isPublicIp(ip), ip).toBe(true);
  });
});

describe('ADR-0020 §5 — safe fetch transport validation', () => {
  it('rejects non-https', async () => {
    await expect(safeFetchText('http://vendor.example/i.json')).rejects.toMatchObject({ code: 'NOT_HTTPS' });
  });
  it('rejects a host not in the allowlist', async () => {
    await expect(safeFetchText('https://evil.example/i.json', { allowedHosts: ['vendor.example'] })).rejects.toMatchObject({
      code: 'HOST_NOT_ALLOWED',
    });
  });
  it('rejects a host that resolves to a private address (SSRF)', async () => {
    await expect(safeFetchText('https://localhost/i.json')).rejects.toBeInstanceOf(SafeFetchError);
  });
});

// ── signing helpers for the pull orchestration ──
const TESTDATA = join(process.cwd(), 'localization', 'statutory-pack', 'testdata');
const keys = JSON.parse(readFileSync(join(TESTDATA, 'dev-keys.json'), 'utf8')) as {
  op: { keyId: string; privateJwk: CryptoJWK };
};
const opPriv = createPrivateKey({ key: keys.op.privateJwk, format: 'jwk' });
const NOW = new Date('2026-06-15T00:00:00Z');
const FAR = '2099-01-01T00:00:00.000Z';
const ISSUED = '2026-01-01T00:00:00.000Z';
const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
function envelope(payloadObj: unknown, priv: KeyObject = opPriv): string {
  const payload = JSON.stringify(payloadObj);
  return JSON.stringify({ schemaVersion: 1, keyId: 'my-op-dev-1', sig: sign(null, Buffer.from(payload, 'utf8'), priv).toString('base64'), payload, checksum: sha(payload) });
}
const packEnvelope = () =>
  envelope({ country: 'MY', packVersion: '2026.01.01', issuedAt: ISSUED, validUntil: FAR, rulesets: [{ version: '2026.1', effectiveFrom: '2026-01-01', data: DEFAULT_MY_STATUTORY }] });
const indexEnvelope = (sequence: number, packText: string, checksum?: string) =>
  envelope({ country: 'MY', sequence, issuedAt: ISSUED, validUntil: FAR, packs: [{ packVersion: '2026.01.01', location: 'p1.pack.json', checksum: checksum ?? sha(packText) }] });

describe('ADR-0020 §5 — pull orchestration', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    await ingestTrustBundle(owner.db, readFileSync(join(TESTDATA, 'trust-bundle.dev.json'), 'utf8'));
  });
  afterAll(async () => {
    await closeAll();
  });

  const URL = 'https://vendor.example/index.json';
  const stub = (packText: string, indexText: string) => (u: string) => Promise.resolve(u === URL ? indexText : packText);

  it('verifies the index and ingests the listed packs', async () => {
    const packText = packEnvelope();
    const r = await pullAndIngest(owner.db, { url: URL, now: NOW, lastSequence: 0, fetchText: stub(packText, indexEnvelope(3, packText)) });
    expect(r.sequence).toBe(3);
    expect(r.ingested).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('rejects an index whose sequence went backwards (anti-rollback)', async () => {
    const packText = packEnvelope();
    await expect(
      pullAndIngest(owner.db, { url: URL, now: NOW, lastSequence: 5, fetchText: stub(packText, indexEnvelope(3, packText)) }),
    ).rejects.toBeInstanceOf(PullError);
  });

  it('fails a pack whose bytes do not match the index checksum', async () => {
    const packText = packEnvelope();
    const r = await pullAndIngest(owner.db, {
      url: URL,
      now: NOW,
      lastSequence: 0,
      fetchText: stub(packText, indexEnvelope(3, packText, 'deadbeef')),
    });
    expect(r.failed).toBe(1);
    expect(r.ingested).toBe(0);
  });
});
