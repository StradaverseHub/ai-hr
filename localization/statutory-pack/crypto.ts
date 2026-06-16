/**
 * ed25519 primitives for statutory-pack verification (ADR-0020 §1/§2). Verification only — the signing
 * (root + operational private keys) lives in the vendor release process, never in the app.
 *
 * Public keys are the base64url raw 32-byte value (JWK `x`). Verification is over the exact UTF-8 bytes of
 * the signed payload.
 */
import { createHash, createPublicKey, verify as nodeVerify, type KeyObject } from 'node:crypto';

function importPublicKey(xB64url: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: xB64url }, format: 'jwk' });
}

/** True iff `sigB64` is a valid ed25519 signature of `data` under the public key `pubXB64url`. */
export function verifyEd25519(data: Buffer, sigB64: string, pubXB64url: string): boolean {
  try {
    const key = importPublicKey(xB64urlNormalize(pubXB64url));
    return nodeVerify(null, data, key, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

/** SHA-256 hex of the bytes. */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Tolerate a base64 (vs base64url) public key by normalizing to base64url, which createPublicKey expects. */
function xB64urlNormalize(x: string): string {
  return x.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
