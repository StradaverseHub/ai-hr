/**
 * Statutory data-pack distribution — artifact formats (ADR-0020).
 *
 * Every distributed artifact is a signed ENVELOPE: the ed25519 signature is over the exact UTF-8 bytes of
 * the `payload` STRING, which is verified and only THEN parsed (verify-then-parse the identical bytes — no
 * JSON canonicalization, so no signature malleability). Keys are ed25519, addressed by `keyId`; a public key
 * is the base64url raw value (the JWK `x`).
 */

export const PACK_SCHEMA_VERSION = 1;

/** A signed artifact: signature is ed25519 over `Buffer.from(payload, 'utf8')`. */
export type Envelope = {
  schemaVersion: number;
  /** Which key signed `payload`. For a pack/index: an operational key (trusted via the bundle). For a
   *  trust bundle: a ROOT key (trusted via the build-bundled root set). */
  keyId: string;
  /** base64 ed25519 signature over the UTF-8 bytes of `payload`. */
  sig: string;
  /** The JSON string that is hashed, verified, and only then parsed. Never re-serialized. */
  payload: string;
  /** Optional SHA-256 (hex) of the same payload bytes — a transport redundancy check ONLY. A valid
   *  signature is always required; checksum alone is never accepted. */
  checksum?: string;
};

/** A root-certified operational signing key (lives inside a root-signed trust bundle). */
export type KeyCert = {
  keyId: string;
  /** base64url raw ed25519 public key (JWK `x`). */
  publicKey: string;
  certifiedAt: string; // ISO
  expiresAt: string; // ISO
};

/** The root-signed trust bundle: the set of currently-certified operational keys + revocations. */
export type TrustBundlePayload = {
  /** Strictly increasing; sync rejects a bundle whose sequence is below the last seen (anti-rollback). */
  sequence: number;
  issuedAt: string; // ISO
  keys: KeyCert[];
  revoked: { keyId: string; revokedAt: string }[];
};

/** A pack: one or more effective-dated rulesets for one country. `data` is a StatutoryRuleset (validated
 *  at ingest, not here — the crypto core stays country-generic). */
export type PackRuleset = {
  version: string;
  /** Must be the first day of a month (validated at ingest). */
  effectiveFrom: string; // YYYY-MM-DD
  data: unknown;
};

export type PackPayload = {
  country: string;
  /** Monotonic per country (enforced at ingest). */
  packVersion: string;
  issuedAt: string; // ISO
  /** Freshness bound; ingest rejects an expired pack. */
  validUntil: string; // ISO
  notes?: string;
  rulesets: PackRuleset[];
};

/** The remote-pull index (anti-rollback via `sequence`); each listed pack is itself a signed envelope. */
export type IndexPayload = {
  country: string;
  sequence: number;
  issuedAt: string;
  validUntil: string;
  packs: { packVersion: string; location: string; checksum: string }[];
};

/** A build-bundled trusted ROOT key (the only keys hardcoded in the app). */
export type RootKey = { keyId: string; publicKey: string };

/** A materialized, ready-to-check trust set derived from a verified trust bundle. */
export type TrustSet = {
  sequence: number;
  /** keyId → operational key, with revocation/expiry resolved. */
  keys: Map<string, { publicKey: string; expiresAt: string; revokedAt: string | null }>;
};
