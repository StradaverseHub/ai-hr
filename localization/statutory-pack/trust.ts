/**
 * Build-bundled trusted ROOT keys (ADR-0020 §1). The root public key is the only key hardcoded in the app;
 * the root private key is air-gapped and only ever certifies operational keys + signs the trust bundle.
 *
 * PRODUCTION_ROOTS is EMPTY until the vendor provisions a real offline root. With no trusted root, no trust
 * bundle verifies, no pack is trusted, and the engine runs on the verified code default — exactly today's
 * behaviour. That is the correct safe pre-launch default.
 *
 * The DEV root is trusted ONLY outside production (and can be disabled with STATUTORY_PACK_DEV_TRUST=0), so
 * the committed dev keys exercise the full pipeline in dev/test without ever being trusted in a prod build.
 */
import type { RootKey } from './types';

const PRODUCTION_ROOTS: RootKey[] = [
  // { keyId: 'my-root-1', publicKey: '<base64url ed25519 public key, provisioned offline>' },
];

// Public half of the committed dev root (scripts/statutory-pack-sign.mjs). Public key only — safe to commit.
const DEV_ROOT: RootKey = {
  keyId: 'my-root-dev-1',
  publicKey: 'InE78j0iRx5x7tqzwHQ_oPo9gl1qrX27w8289xllMgU',
};

function devRootEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.STATUTORY_PACK_DEV_TRUST !== '0';
}

export function trustedRootKeys(): RootKey[] {
  return devRootEnabled() ? [...PRODUCTION_ROOTS, DEV_ROOT] : [...PRODUCTION_ROOTS];
}
