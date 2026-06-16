/**
 * Statutory-pack verification core (ADR-0020 §1/§2) — country-generic, crypto only. Content validation
 * (validateStatutoryRuleset, effective-date rules, monotonic packVersion) happens at ingest, not here.
 *
 * Trust chain: a build-bundled ROOT key signs a TRUST BUNDLE that certifies operational keys; operational
 * keys sign PACKS (and the pull INDEX). Every signature is over the exact UTF-8 bytes of the envelope's
 * `payload` string, which is verified and only THEN parsed (verify-then-parse the identical bytes).
 */
import { verifyEd25519, sha256Hex } from './crypto';
import { parseStrict } from './json-strict';
import { trustedRootKeys } from './trust';
import {
  PACK_SCHEMA_VERSION,
  type Envelope,
  type IndexPayload,
  type PackPayload,
  type RootKey,
  type TrustBundlePayload,
  type TrustSet,
} from './types';

export type VerifyCode =
  | 'BAD_ENVELOPE'
  | 'BAD_SCHEMA'
  | 'UNKNOWN_KEY'
  | 'REVOKED_KEY'
  | 'EXPIRED_KEY'
  | 'BAD_SIGNATURE'
  | 'BAD_CHECKSUM'
  | 'EXPIRED_ARTIFACT'
  | 'NOT_YET_ISSUED'
  | 'BAD_PAYLOAD';

export class PackVerifyError extends Error {
  constructor(
    public readonly code: VerifyCode,
    message: string,
  ) {
    super(message);
    this.name = 'PackVerifyError';
  }
}

/** Tolerate modest clock skew on the "issued in the future" check (24h). */
const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

function parseEnvelope(text: string): Envelope {
  let e: unknown;
  try {
    e = parseStrict(text);
  } catch (err) {
    throw new PackVerifyError('BAD_ENVELOPE', `Envelope is not strict JSON: ${(err as Error).message}`);
  }
  const env = e as Partial<Envelope>;
  if (
    !env ||
    typeof env !== 'object' ||
    typeof env.keyId !== 'string' ||
    typeof env.sig !== 'string' ||
    typeof env.payload !== 'string' ||
    typeof env.schemaVersion !== 'number'
  ) {
    throw new PackVerifyError('BAD_ENVELOPE', 'Envelope missing schemaVersion/keyId/sig/payload');
  }
  if (env.schemaVersion !== PACK_SCHEMA_VERSION) {
    throw new PackVerifyError('BAD_SCHEMA', `Unsupported schemaVersion ${env.schemaVersion}`);
  }
  return env as Envelope;
}

/** Verify the detached signature + optional checksum over the envelope payload bytes. */
function verifyBytes(env: Envelope, publicKey: string): void {
  const bytes = Buffer.from(env.payload, 'utf8');
  if (env.checksum && sha256Hex(bytes) !== env.checksum) {
    throw new PackVerifyError('BAD_CHECKSUM', 'Payload checksum mismatch');
  }
  if (!verifyEd25519(bytes, env.sig, publicKey)) {
    throw new PackVerifyError('BAD_SIGNATURE', `Bad signature for key ${env.keyId}`);
  }
}

function parsePayload<T>(env: Envelope): T {
  try {
    return parseStrict(env.payload) as T;
  } catch (err) {
    throw new PackVerifyError('BAD_PAYLOAD', `Payload is not strict JSON: ${(err as Error).message}`);
  }
}

/**
 * Verify a root-signed trust bundle and materialize the operational-key trust set. The bundle's `keyId`
 * must be a trusted ROOT (build-bundled). Revocations and expiry are resolved into the returned TrustSet.
 */
export function verifyTrustBundle(
  envelopeText: string,
  opts?: { roots?: RootKey[] },
): { bundle: TrustBundlePayload; trust: TrustSet } {
  const env = parseEnvelope(envelopeText);
  const roots = opts?.roots ?? trustedRootKeys();
  const root = roots.find((r) => r.keyId === env.keyId);
  if (!root) throw new PackVerifyError('UNKNOWN_KEY', `Trust bundle signed by untrusted root ${env.keyId}`);
  verifyBytes(env, root.publicKey);

  const bundle = parsePayload<TrustBundlePayload>(env);
  if (!bundle || !Array.isArray(bundle.keys) || !Array.isArray(bundle.revoked) || typeof bundle.sequence !== 'number') {
    throw new PackVerifyError('BAD_PAYLOAD', 'Trust bundle payload malformed');
  }
  const revokedAt = new Map(bundle.revoked.map((r) => [r.keyId, r.revokedAt]));
  const keys: TrustSet['keys'] = new Map();
  for (const k of bundle.keys) {
    if (typeof k.keyId !== 'string' || typeof k.publicKey !== 'string' || typeof k.expiresAt !== 'string') {
      throw new PackVerifyError('BAD_PAYLOAD', 'Trust bundle key cert malformed');
    }
    keys.set(k.keyId, { publicKey: k.publicKey, expiresAt: k.expiresAt, revokedAt: revokedAt.get(k.keyId) ?? null });
  }
  return { bundle, trust: { sequence: bundle.sequence, keys } };
}

/** Resolve an operational key from a trust set, enforcing revocation + expiry at time `now`. */
function resolveOperationalKey(trust: TrustSet, keyId: string, now: Date): string {
  const k = trust.keys.get(keyId);
  if (!k) throw new PackVerifyError('UNKNOWN_KEY', `No trusted operational key ${keyId}`);
  if (k.revokedAt) throw new PackVerifyError('REVOKED_KEY', `Operational key ${keyId} revoked at ${k.revokedAt}`);
  if (now.getTime() > Date.parse(k.expiresAt)) throw new PackVerifyError('EXPIRED_KEY', `Operational key ${keyId} expired`);
  return k.publicKey;
}

function assertFreshness(issuedAt: string, validUntil: string, now: Date): void {
  const issued = Date.parse(issuedAt);
  const until = Date.parse(validUntil);
  if (Number.isNaN(issued) || Number.isNaN(until)) throw new PackVerifyError('BAD_PAYLOAD', 'Bad issuedAt/validUntil');
  if (issued > now.getTime() + CLOCK_SKEW_MS) throw new PackVerifyError('NOT_YET_ISSUED', 'Artifact issued in the future');
  if (until < now.getTime()) throw new PackVerifyError('EXPIRED_ARTIFACT', 'Artifact past validUntil');
}

/** Verify an operational-key-signed pack envelope against a materialized trust set. Returns the parsed,
 *  cryptographically-trusted PackPayload (CONTENT validation still happens at ingest). */
export function verifyPack(
  envelopeText: string,
  opts: { trust: TrustSet; now: Date },
): { pack: PackPayload; keyId: string } {
  const env = parseEnvelope(envelopeText);
  const publicKey = resolveOperationalKey(opts.trust, env.keyId, opts.now);
  verifyBytes(env, publicKey);
  const pack = parsePayload<PackPayload>(env);
  if (
    !pack ||
    typeof pack.country !== 'string' ||
    typeof pack.packVersion !== 'string' ||
    !Array.isArray(pack.rulesets)
  ) {
    throw new PackVerifyError('BAD_PAYLOAD', 'Pack payload malformed');
  }
  assertFreshness(pack.issuedAt, pack.validUntil, opts.now);
  return { pack, keyId: env.keyId };
}

/** Verify an operational-key-signed pull index (ADR-0020 §5). Anti-rollback (`sequence`) is enforced by
 *  the caller against the last-seen sequence. */
export function verifyIndex(
  envelopeText: string,
  opts: { trust: TrustSet; now: Date },
): { index: IndexPayload; keyId: string } {
  const env = parseEnvelope(envelopeText);
  const publicKey = resolveOperationalKey(opts.trust, env.keyId, opts.now);
  verifyBytes(env, publicKey);
  const index = parsePayload<IndexPayload>(env);
  if (!index || typeof index.country !== 'string' || typeof index.sequence !== 'number' || !Array.isArray(index.packs)) {
    throw new PackVerifyError('BAD_PAYLOAD', 'Index payload malformed');
  }
  assertFreshness(index.issuedAt, index.validUntil, opts.now);
  return { index, keyId: env.keyId };
}
