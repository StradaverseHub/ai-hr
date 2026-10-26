import { ed25519 } from '@noble/curves/ed25519.js';
import { validCompanyProfile, type CompanyProfile } from '../../lib/mobile-connection';
import { setupBytes } from '../../lib/mobile-workplace-setup';

export type SignedCompanyProfile = { keyId: string; payload: string; signature: string };
export type ConnectionTrust = { keyId: string; publicKey: string }[];
declare const verifiedProfile: unique symbol;
export type VerifiedCompanyProfile = CompanyProfile & { readonly [verifiedProfile]: true };
function bytes(value: string): Uint8Array {
  return setupBytes(value);
}
/** The trust key comes from the installed binary, never from the file being verified. */
export function verifyCompanyProfile(raw: string, trust: ConnectionTrust, now?: number): VerifiedCompanyProfile {
  if (raw.length > 16_384) throw new Error('Company setup file is too large.');
  const envelope = JSON.parse(raw) as SignedCompanyProfile;
  if (!envelope || typeof envelope !== 'object' || Object.keys(envelope).sort().join(',') !== 'keyId,payload,signature' ||
      typeof envelope.keyId !== 'string' || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('Invalid company setup file.');
  const key = trust.find(k => k.keyId === envelope.keyId);
  if (!key) throw new Error('This company setup file is not approved for this app.');
  const payload = bytes(envelope.payload), signature = bytes(envelope.signature), publicKey = bytes(key.publicKey);
  if (signature.length !== 64 || publicKey.length !== 32 || !ed25519.verify(signature, payload, publicKey, { zip215: false })) throw new Error('The company setup signature is invalid.');
  const json = decodeURIComponent(Array.from(payload, b => '%' + b.toString(16).padStart(2,'0')).join(''));
  return Object.freeze(validCompanyProfile(JSON.parse(json), now)) as VerifiedCompanyProfile;
}
