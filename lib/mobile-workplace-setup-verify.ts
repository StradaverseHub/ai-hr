/**
 * Server-side re-verification of a signed mobile workplace setup (ADR-0161). Node-only, no key material.
 *
 * The installed app remains the final judge: it verifies with the anchors compiled into its binary
 * (mobile/lib/company-profile.ts). The server verifies independently, against the same anchors file,
 * before it shows a link to anyone or accepts an import, so a setup that the app would refuse — or one
 * that routes employees to another server or organization — is never offered.
 */
import { createPublicKey, verify } from 'node:crypto';
import { validCompanyProfile, type CompanyProfile } from './mobile-connection';
import { setupBytes, workplaceSetupLinks } from './mobile-workplace-setup';

/** The public half the installed app trusts. `expiresAt` (unix seconds) is optional and absent today. */
export type TrustAnchor = { keyId: string; publicKey: string; expiresAt?: number };
export type SignedEnvelope = { keyId: string; payload: string; signature: string };

export const SETUP_RENEWAL_WINDOW_SECONDS = 30 * 86400;
const MAX_SETUP_LENGTH = 16_384;

export type SetupRefusal =
  | 'malformed' | 'untrusted_key' | 'bad_signature' | 'invalid_profile' | 'not_workplace'
  | 'expired' | 'not_yet_valid' | 'origin_mismatch' | 'organization_mismatch';

export class WorkplaceSetupRefusal extends Error {
  constructor(readonly code: SetupRefusal) {
    super(`mobile-setup:${code}`);
    this.name = 'WorkplaceSetupRefusal';
  }
}

function refuse(code: SetupRefusal): never { throw new WorkplaceSetupRefusal(code); }

export type VerifiedSetup = {
  envelope: SignedEnvelope;
  profile: CompanyProfile & { organization: string };
  keyId: string;
  expiresAt: number;
  /** Inside the renewal window: still valid, but due for a new setup. */
  expiresSoon: boolean;
  links: { web: string; app: string };
};

/** Parse the envelope exactly as the app's verifier and the link reader require. */
export function parseEnvelope(input: unknown): SignedEnvelope {
  let value = input;
  if (typeof value === 'string') {
    if (value.length > MAX_SETUP_LENGTH) refuse('malformed');
    try { value = JSON.parse(value); } catch { refuse('malformed'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('malformed');
  const e = value as Record<string, unknown>;
  const { keyId, payload, signature } = e;
  if (Object.keys(e).sort().join(',') !== 'keyId,payload,signature' || typeof keyId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(keyId) || typeof payload !== 'string' || typeof signature !== 'string' ||
      !/^[A-Za-z0-9_-]{86}$/.test(signature) || payload.length > MAX_SETUP_LENGTH) return refuse('malformed');
  return { keyId, payload, signature };
}

/**
 * Signature, trust anchor, profile shape, embedded-sign-in workplace and validity window. Does NOT
 * bind the setup to an installation or a customer: callers that show or accept a setup must also call
 * `assertInstallationBinding`, which `verifyWorkplaceSetup` does for them.
 */
export function verifySignedSetup(input: unknown, trust: readonly TrustAnchor[], now = Math.floor(Date.now() / 1000)): VerifiedSetup {
  const envelope = parseEnvelope(input);
  const anchor = trust.find(entry => entry?.keyId === envelope.keyId);
  if (!anchor || typeof anchor.publicKey !== 'string') return refuse('untrusted_key');
  const bytesOf = (value: string): Uint8Array => { try { return setupBytes(value); } catch { return refuse('malformed'); } };
  const payload = bytesOf(envelope.payload), signature = bytesOf(envelope.signature), publicKeyBytes = bytesOf(anchor.publicKey);
  if (signature.length !== 64 || publicKeyBytes.length !== 32) refuse('malformed');
  let valid = false;
  try {
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: anchor.publicKey }, format: 'jwk' });
    valid = verify(null, Buffer.from(payload), publicKey, Buffer.from(signature));
  } catch { valid = false; }
  if (!valid) refuse('bad_signature');
  if (typeof anchor.expiresAt === 'number' && anchor.expiresAt <= now) refuse('untrusted_key');
  const parsed = ((): Record<string, unknown> => {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); } catch { return refuse('invalid_profile'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse('invalid_profile');
    return value as Record<string, unknown>;
  })();
  const { expiresAt, notBefore } = parsed;
  if (typeof expiresAt === 'number' && expiresAt <= now) refuse('expired');
  if (typeof notBefore === 'number' && notBefore > now) refuse('not_yet_valid');
  const profile = ((): CompanyProfile => { try { return validCompanyProfile(parsed, now); } catch { return refuse('invalid_profile'); } })();
  if (profile.authProvider !== 'internal' || typeof profile.organization !== 'string' || !profile.organization) refuse('not_workplace');
  const links = ((): { web: string; app: string } => { try { return workplaceSetupLinks(JSON.stringify(envelope)); } catch { return refuse('invalid_profile'); } })();
  return {
    envelope, profile: profile as CompanyProfile & { organization: string }, keyId: envelope.keyId,
    expiresAt: profile.expiresAt, expiresSoon: profile.expiresAt - now < SETUP_RENEWAL_WINDOW_SECONDS, links,
  };
}

/**
 * The setup must route employees to THIS installation and THIS customer. The issuer is already bound
 * to the origin by validCompanyProfile (`issuer === apiOrigin + '/auth'` for embedded sign-in), which is
 * the same address /login/mobile-connection publishes.
 */
export function assertInstallationBinding(setup: VerifiedSetup, expected: { origin: string; organization: string }): void {
  if (setup.profile.apiOrigin !== expected.origin || setup.profile.issuer !== expected.origin + '/auth') refuse('origin_mismatch');
  if (setup.profile.organization !== expected.organization) refuse('organization_mismatch');
}

/** Everything a caller needs before showing a setup or accepting an import. */
export function verifyWorkplaceSetup(
  input: unknown,
  expected: { trust: readonly TrustAnchor[]; origin: string; organization: string; now?: number },
): VerifiedSetup {
  const setup = verifySignedSetup(input, expected.trust, expected.now);
  assertInstallationBinding(setup, expected);
  return setup;
}
