/**
 * Node-only signing for mobile workplace setups (ADR-0161).
 *
 * Two callers and only two: the offline operator CLI (scripts/mobile-company-profile.ts) and the
 * owner-role provisioning runner (scripts/mobile-setup-issuance.ts). A web request path never loads a
 * signing key, and the mobile archive cannot contain this file (.easignore admits only the shared
 * contracts). test/mobile-workplace-setup-signer.test.ts pins both boundaries.
 *
 * Errors carry a code, never a key, a path or a signed payload, so a recorded or logged failure can
 * be shown to an operator without leaking custody details.
 */
import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import { validCompanyProfile, type CompanyProfile } from './mobile-connection';
import { organizationCode } from './organization-code';
import type { SignedEnvelope, TrustAnchor } from './mobile-workplace-setup-verify';

export type { SignedEnvelope, TrustAnchor };
export type SetupHosting = CompanyProfile['hosting'];

/** validCompanyProfile admits at most 366 days between notBefore and expiresAt. */
export const SETUP_LIFETIME_SECONDS = 365 * 86400;
/**
 * The app checks `notBefore <= now` against the PHONE's clock. A setup stamped with the server's exact
 * second is refused by any phone whose clock trails by a moment, so validity starts slightly earlier.
 */
export const SETUP_CLOCK_SKEW_SECONDS = 300;

export type SignerFailure =
  | 'key_not_configured' | 'key_path_invalid' | 'key_unreadable' | 'key_permissions' | 'key_type'
  | 'key_untrusted' | 'anchor_validity' | 'hosting_invalid' | 'profile_invalid';

export class WorkplaceSetupSignerError extends Error {
  constructor(readonly code: SignerFailure) {
    super(`mobile-setup:${code}`);
    this.name = 'WorkplaceSetupSignerError';
  }
}

function fail(code: SignerFailure): never { throw new WorkplaceSetupSignerError(code); }
const nowSeconds = (now?: number) => Math.floor(now ?? Date.now() / 1000);

/** `AIHR_MOBILE_SETUP_HOSTING`: blank means cloud, the only installations Stradaverse signs for today. */
export function setupHosting(value: string | undefined): SetupHosting {
  const hosting = (value ?? '').trim() || 'cloud';
  if (hosting !== 'cloud' && hosting !== 'on-premise') fail('hosting_invalid');
  return hosting as SetupHosting;
}

/**
 * Load the Ed25519 signing key. The path must be absolute, resolve outside `appDirectory` (the source
 * and build tree that deploys replace with rsync --delete), name a regular file and grant nothing to
 * group or other. Symlinks are resolved first, so a link inside the tree cannot launder the location.
 */
export function loadSigningKey(path: string | undefined, appDirectory: string): KeyObject {
  const configured = (path ?? '').trim();
  if (!configured) fail('key_not_configured');
  if (!isAbsolute(configured)) fail('key_path_invalid');
  let real = '', app = '';
  try { real = realpathSync(configured); } catch { fail('key_unreadable'); }
  try { app = realpathSync(appDirectory); } catch { fail('key_path_invalid'); }
  if (real === app || real.startsWith(app.endsWith(sep) ? app : app + sep)) fail('key_path_invalid');
  let mode = 0;
  try {
    const stat = statSync(real);
    if (!stat.isFile()) fail('key_unreadable');
    mode = stat.mode;
  } catch (error) { if (error instanceof WorkplaceSetupSignerError) throw error; fail('key_unreadable'); }
  if ((mode & 0o077) !== 0) fail('key_permissions');
  let key: KeyObject | null = null;
  try { key = createPrivateKey(readFileSync(real)); } catch { fail('key_unreadable'); }
  if (key!.type !== 'private' || key!.asymmetricKeyType !== 'ed25519') fail('key_type');
  return key!;
}

/** The trust anchor whose public key matches this signing key. A key the app does not trust is refused. */
export function approvedAnchor(key: KeyObject, trust: readonly TrustAnchor[]): TrustAnchor {
  let publicKey: string | undefined;
  try { publicKey = createPublicKey(key).export({ format: 'jwk' }).x; } catch { fail('key_type'); }
  const anchor = trust.find(entry => typeof entry?.publicKey === 'string' && entry.publicKey === publicKey);
  if (!anchor) fail('key_untrusted');
  return anchor!;
}

export type WorkplaceProfileInput = {
  /** The canonical HTTPS origin employees reach, e.g. this installation's AUTH_PUBLIC_ORIGIN. */
  origin: string;
  /** The customer's login organization code (the internal-auth namespace owner). */
  organization: string;
  /** Display name the app shows on its review screen. */
  name: string;
  hosting: SetupHosting;
  /** Stable profile identity. Defaults to the organization code so a renewal keeps app storage stable. */
  id?: string;
};

/**
 * Build the per-customer embedded-sign-in profile. Every fixed field is the only value
 * validCompanyProfile admits for an internal profile; the server's /login/mobile-connection answers the
 * same connection fields, so the app's pre-sign-in comparison holds.
 */
export function workplaceProfile(input: WorkplaceProfileInput, options: { now?: number; anchor?: TrustAnchor } = {}): CompanyProfile {
  const now = nowSeconds(options.now);
  let origin = '';
  try {
    const url = new URL(input.origin);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) fail('profile_invalid');
    origin = url.origin;
  } catch (error) { if (error instanceof WorkplaceSetupSignerError) throw error; fail('profile_invalid'); }
  let organization = '';
  try { organization = organizationCode(input.organization); } catch { fail('profile_invalid'); }
  let expiresAt = now + SETUP_LIFETIME_SECONDS;
  const anchorLimit = options.anchor?.expiresAt;
  if (typeof anchorLimit === 'number' && Number.isFinite(anchorLimit)) expiresAt = Math.min(expiresAt, Math.floor(anchorLimit));
  if (expiresAt <= now) fail('anchor_validity');
  const profile: CompanyProfile = {
    connectionVersion: 1, apiVersion: 'v1', authProvider: 'internal',
    apiOrigin: origin, issuer: origin + '/auth', clientId: 'aihr-mobile', audience: 'aihr-api',
    id: input.id ?? organization, name: input.name.trim(), organization, hosting: input.hosting,
    notBefore: now - SETUP_CLOCK_SKEW_SECONDS, expiresAt,
  };
  try { return validCompanyProfile(profile, now); } catch { return fail('profile_invalid'); }
}

/**
 * Sign the exact payload bytes. The signature covers the payload, never envelope whitespace, so the
 * envelope may be stored compactly or written pretty by the CLI.
 */
export function signCompanyProfile(profile: CompanyProfile, key: KeyObject, trust: readonly TrustAnchor[], now?: number): SignedEnvelope {
  const anchor = approvedAnchor(key, trust);
  let checked: CompanyProfile | null = null;
  try { checked = validCompanyProfile(profile, nowSeconds(now)); } catch { fail('profile_invalid'); }
  if (typeof anchor.expiresAt === 'number' && checked!.expiresAt > anchor.expiresAt) fail('anchor_validity');
  const bytes = Buffer.from(JSON.stringify(checked));
  return { keyId: anchor.keyId, payload: bytes.toString('base64url'), signature: sign(null, bytes, key).toString('base64url') };
}
