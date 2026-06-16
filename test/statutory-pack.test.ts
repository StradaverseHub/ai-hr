/**
 * Statutory-pack crypto core (ADR-0020 Slice 1) — signature/trust verification, adversarial cases, and the
 * committed cross-impl test vector. Pure (no DB).
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign, createHash, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyEd25519, sha256Hex } from '../localization/statutory-pack/crypto';
import { assertNoDuplicateKeys, DuplicateKeyError, parseStrict } from '../localization/statutory-pack/json-strict';
import { PackVerifyError, verifyPack, verifyTrustBundle } from '../localization/statutory-pack/verify';
import { trustedRootKeys } from '../localization/statutory-pack/trust';

const TESTDATA = join(process.cwd(), 'localization', 'statutory-pack', 'testdata');
const read = (f: string) => readFileSync(join(TESTDATA, f), 'utf8');
const NOW = new Date('2026-06-15T00:00:00Z');

// ── in-test signing helpers (ephemeral keys) ──
function makeKey(): { x: string; priv: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { x: (publicKey.export({ format: 'jwk' }) as { x: string }).x, priv: privateKey };
}
const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
function envelope(keyId: string, payloadObj: unknown, priv: KeyObject): string {
  const payload = JSON.stringify(payloadObj);
  const sig = sign(null, Buffer.from(payload, 'utf8'), priv).toString('base64');
  return JSON.stringify({ schemaVersion: 1, keyId, sig, payload, checksum: sha(payload) });
}
const FAR = '2099-01-01T00:00:00.000Z';
const ISSUED = '2026-01-01T00:00:00.000Z';
const cert = (keyId: string, x: string, expiresAt = FAR) => ({ keyId, publicKey: x, certifiedAt: ISSUED, expiresAt });
const trustBundle = (root: { x: string; priv: KeyObject }, keys: ReturnType<typeof cert>[], revoked: { keyId: string; revokedAt: string }[] = []) =>
  envelope('root', { sequence: 1, issuedAt: ISSUED, keys, revoked }, root.priv);
const samplePack = (overrides: Record<string, unknown> = {}) => ({
  country: 'MY',
  packVersion: '2026.10.01',
  issuedAt: ISSUED,
  validUntil: FAR,
  rulesets: [{ version: 'v1', effectiveFrom: '2026-10-01', data: { ok: true } }],
  ...overrides,
});

describe('statutory-pack — strict JSON (duplicate keys)', () => {
  it('rejects duplicate object keys', () => {
    expect(() => parseStrict('{"a":1,"a":2}')).toThrow(DuplicateKeyError);
    expect(() => assertNoDuplicateKeys('{"x":{"a":1},"y":{"a":2}}')).not.toThrow(); // same key, different objects
    expect(() => assertNoDuplicateKeys('{"a":[1,2],"a":3}')).toThrow(DuplicateKeyError);
    expect(() => assertNoDuplicateKeys('{"k":"a\\"b","k2":1}')).not.toThrow(); // escaped quote in value
  });
  it('parses valid JSON normally', () => {
    expect(parseStrict('{"a":1,"b":[2,3],"c":{"d":4}}')).toEqual({ a: 1, b: [2, 3], c: { d: 4 } });
  });
});

describe('statutory-pack — committed interop test vector', () => {
  const v = JSON.parse(read('vector.json')) as { publicKey: string; payload: string; sig: string; checksum: string };
  it('verifies the fixed payload/sig/pubkey byte-for-byte', () => {
    expect(verifyEd25519(Buffer.from(v.payload, 'utf8'), v.sig, v.publicKey)).toBe(true);
    expect(sha256Hex(Buffer.from(v.payload, 'utf8'))).toBe(v.checksum);
  });
  it('rejects a tampered payload', () => {
    expect(verifyEd25519(Buffer.from(v.payload + ' ', 'utf8'), v.sig, v.publicKey)).toBe(false);
  });
});

describe('statutory-pack — committed dev trust chain', () => {
  it('verifies the dev trust bundle and the dev sample pack', () => {
    const { trust } = verifyTrustBundle(read('trust-bundle.dev.json'), { roots: trustedRootKeys() });
    expect(trust.keys.has('my-op-dev-1')).toBe(true);
    const { pack } = verifyPack(read('sample-pack.dev.json'), { trust, now: NOW });
    expect(pack.country).toBe('MY');
  });
});

describe('statutory-pack — verification (adversarial)', () => {
  const root = makeKey();
  const op = makeKey();
  const roots = [{ keyId: 'root', publicKey: root.x }];
  const { trust } = verifyTrustBundle(trustBundle(root, [cert('op', op.x)]), { roots });

  it('accepts a well-formed signed pack', () => {
    expect(verifyPack(envelope('op', samplePack(), op.priv), { trust, now: NOW }).pack.packVersion).toBe('2026.10.01');
  });

  it('rejects a trust bundle whose root keyId is not trusted (UNKNOWN_KEY)', () => {
    const evil = makeKey();
    const evilBundle = envelope('evil-root', { sequence: 1, issuedAt: ISSUED, keys: [cert('op', op.x)], revoked: [] }, evil.priv);
    expect(() => verifyTrustBundle(evilBundle, { roots })).toThrow(expect.objectContaining({ code: 'UNKNOWN_KEY' }));
  });

  it('rejects a trust bundle impersonating a trusted root keyId with a different key (BAD_SIGNATURE)', () => {
    const evil = makeKey();
    expect(() => verifyTrustBundle(trustBundle(evil, [cert('op', op.x)]), { roots })).toThrow(
      expect.objectContaining({ code: 'BAD_SIGNATURE' }),
    );
  });

  it('rejects a pack signed by a key not in the trust set', () => {
    const stranger = makeKey();
    expect(() => verifyPack(envelope('op', samplePack(), stranger.priv), { trust, now: NOW })).toThrow(PackVerifyError);
  });

  it('rejects a pack signed by a REVOKED key', () => {
    const { trust: revokedTrust } = verifyTrustBundle(
      trustBundle(root, [cert('op', op.x)], [{ keyId: 'op', revokedAt: ISSUED }]),
      { roots },
    );
    expect(() => verifyPack(envelope('op', samplePack(), op.priv), { trust: revokedTrust, now: NOW })).toThrow(
      expect.objectContaining({ code: 'REVOKED_KEY' }),
    );
  });

  it('rejects a pack signed by an EXPIRED key', () => {
    const { trust: expiredTrust } = verifyTrustBundle(trustBundle(root, [cert('op', op.x, '2026-02-01T00:00:00Z')]), { roots });
    expect(() => verifyPack(envelope('op', samplePack(), op.priv), { trust: expiredTrust, now: NOW })).toThrow(
      expect.objectContaining({ code: 'EXPIRED_KEY' }),
    );
  });

  it('rejects a tampered signature (BAD_SIGNATURE) and tampered checksum (BAD_CHECKSUM)', () => {
    const env = JSON.parse(envelope('op', samplePack(), op.priv)) as { sig: string; checksum: string };
    const badSig = JSON.stringify({ ...env, sig: Buffer.from('x'.repeat(64)).toString('base64') });
    expect(() => verifyPack(badSig, { trust, now: NOW })).toThrow(expect.objectContaining({ code: 'BAD_SIGNATURE' }));
    const badSum = JSON.stringify({ ...env, checksum: 'deadbeef' });
    expect(() => verifyPack(badSum, { trust, now: NOW })).toThrow(expect.objectContaining({ code: 'BAD_CHECKSUM' }));
  });

  it('rejects a stale (validUntil past) and not-yet-issued pack', () => {
    expect(() => verifyPack(envelope('op', samplePack({ validUntil: '2026-03-01T00:00:00Z' }), op.priv), { trust, now: NOW })).toThrow(
      expect.objectContaining({ code: 'EXPIRED_ARTIFACT' }),
    );
    expect(() => verifyPack(envelope('op', samplePack({ issuedAt: '2027-01-01T00:00:00Z' }), op.priv), { trust, now: NOW })).toThrow(
      expect.objectContaining({ code: 'NOT_YET_ISSUED' }),
    );
  });

  it('rejects an unsupported schemaVersion', () => {
    const env = JSON.parse(envelope('op', samplePack(), op.priv)) as Record<string, unknown>;
    expect(() => verifyPack(JSON.stringify({ ...env, schemaVersion: 999 }), { trust, now: NOW })).toThrow(
      expect.objectContaining({ code: 'BAD_SCHEMA' }),
    );
  });
});
