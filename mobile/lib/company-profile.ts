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
/**
 * Why a setup was refused, so the screen can say it (the walkthrough saw only "could not be verified"). The codes say
 * nothing secret: the file is public routing data, and the trust anchors are in the binary.
 */
export type CompanySetupProblem = 'too_large' | 'not_setup' | 'untrusted' | 'bad_signature' | 'expired' | 'not_yet_valid' | 'invalid';
export class CompanySetupError extends Error {
  constructor(readonly problem: CompanySetupProblem, message: string, readonly at?: number) { super(message); this.name = 'CompanySetupError'; }
}
const refuse = (problem: CompanySetupProblem, message: string, at?: number): never => { throw new CompanySetupError(problem, message, at); };
/** The trust key comes from the installed binary, never from the file being verified. */
export function verifyCompanyProfile(raw: string, trust: ConnectionTrust, now?: number): VerifiedCompanyProfile {
  if (raw.length > 16_384) refuse('too_large', 'Company setup file is too large.');
  let envelope: SignedCompanyProfile;
  try { envelope = JSON.parse(raw) as SignedCompanyProfile; } catch { return refuse('not_setup', 'Invalid company setup file.'); }
  if (!envelope || typeof envelope !== 'object' || Object.keys(envelope).sort().join(',') !== 'keyId,payload,signature' ||
      typeof envelope.keyId !== 'string' || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') refuse('not_setup', 'Invalid company setup file.');
  const key = trust.find(k => k.keyId === envelope.keyId);
  if (!key) refuse('untrusted', 'This company setup file is not approved for this app.');
  let payload: Uint8Array, signature: Uint8Array;
  try { payload = bytes(envelope.payload); signature = bytes(envelope.signature); } catch { return refuse('not_setup', 'Invalid company setup file.'); }
  const publicKey = bytes(key!.publicKey);
  if (signature.length !== 64 || publicKey.length !== 32 || !ed25519.verify(signature, payload, publicKey, { zip215: false })) refuse('bad_signature', 'The company setup signature is invalid.');
  let input: unknown;
  try { input = JSON.parse(decodeURIComponent(Array.from(payload, b => '%' + b.toString(16).padStart(2,'0')).join(''))); }
  catch { return refuse('invalid', 'Invalid company setup file.'); }
  // Signed, so its validity window can be read before the full check, to say "expired" or "not valid yet" plainly.
  const at = now ?? Date.now() / 1000, window = input && typeof input === 'object' ? input as { notBefore?: unknown; expiresAt?: unknown } : {};
  if (Number.isSafeInteger(window.expiresAt) && (window.expiresAt as number) <= at) refuse('expired', 'This company setup has expired.', window.expiresAt as number);
  if (Number.isSafeInteger(window.notBefore) && (window.notBefore as number) > at) refuse('not_yet_valid', 'This company setup is not valid yet.', window.notBefore as number);
  try { return Object.freeze(validCompanyProfile(input, now)) as VerifiedCompanyProfile; }
  catch (error) { return refuse('invalid', error instanceof Error ? error.message : 'Invalid company setup file.'); }
}
