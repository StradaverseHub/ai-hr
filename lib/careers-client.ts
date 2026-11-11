/**
 * Recruitment slice 8 — who is submitting, for the per-client limits (5 careers submissions an hour, D-027; a read
 * budget for the public pages), without storing or logging who they are.
 *
 * The client address: only a reviewed ingress may name it. lib/request-budget.ts trustedRequestSource() returns the
 * verified source from X-Aihr-Request-Source when the operator has set AIHR_TRUST_REQUEST_SOURCE=1 after installing
 * deploy/internal-auth/abuse-careers-location.conf (the proxy OVERWRITES that header from the connection's address);
 * arbitrary X-Forwarded-For is never trusted. Trust enabled but no valid header: it throws, and the submission is
 * refused as unavailable.
 *
 * Trust disabled — the default until an installation's web server step is done — means there is no per-visitor
 * address, so online applications are NOT accepted (503, "unavailable"; the pages stay readable). The one exception is
 * local development (`next dev`): a development-only bucket lets the form be rendered and tried. The check reads
 * process.env.NODE_ENV literally, which a production build replaces with "production" at build time, so the exception
 * cannot exist in a built server.
 *
 * The hash: HMAC-SHA-256 under a key derived (HKDF, purpose-bound info string) from an existing server secret —
 * AUTH_SESSION_KEY (32 random bytes; required by the embedded HR login and Keycloak, ADR-0117), else the legacy
 * WORKOS_COOKIE_PASSWORD. Neither is ever used directly, so no other feature's tokens can be derived from these hashes.
 * Without either (a local demo), a random per-process key is used: hashes then stop matching after a restart, which only
 * relaxes the limits across a restart. No new required setting. The raw address is never returned, stored or logged.
 * An IPv6 address counts by its /64 network, so rotating addresses inside one allocation do not reset the limit.
 */
import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { trustedRequestSource } from './request-budget';

const INFO = 'ai-hr/recruitment-careers/client-address/v1';
let processKey: Buffer | null = null;

function careersClientKey(env: NodeJS.ProcessEnv): Buffer {
  const secret = env.AUTH_SESSION_KEY?.trim() || env.WORKOS_COOKIE_PASSWORD?.trim();
  if (secret) return Buffer.from(hkdfSync('sha256', secret, 'ai-hr-careers', INFO, 32));
  processKey ??= randomBytes(32);
  return processKey;
}

/** The part of an address the limit counts: the whole IPv4 address, or the /64 network of an IPv6 address. */
export function careersClientSubject(address: string): string {
  const family = isIP(address);
  if (family === 4) return `v4:${address}`;
  if (family !== 6) throw new Error('Invalid client address');
  let text = address.toLowerCase();
  // An IPv4-mapped IPv6 address is the IPv4 client.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped) return `v4:${mapped[1]}`;
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `v6:${groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}`;
}

export type CareersClient = { hash: string; verified: boolean };

/** Local development only (see the file header): replaced by a constant false in a production build. */
const developmentServer = () => process.env.NODE_ENV === 'development';

/** Whether this installation accepts online applications: a verified request source, or local development. */
export function careersApplicationsAccepted(): boolean {
  return process.env.AIHR_TRUST_REQUEST_SOURCE === '1' || developmentServer();
}

export class CareersSourceUnavailable extends Error {
  constructor() { super('Careers request source unavailable'); this.name = 'CareersSourceUnavailable'; }
}

/**
 * The keyed hash of the request's client (see the file header). Throws CareersSourceUnavailable when there is no
 * verified source (trust off outside development, or trust on and the header missing or malformed).
 */
export function careersClientHash(request: Request, env: NodeJS.ProcessEnv = process.env): CareersClient {
  let source: string | null;
  try {
    source = trustedRequestSource(request);
  } catch {
    throw new CareersSourceUnavailable();
  }
  if (source === null && !developmentServer()) throw new CareersSourceUnavailable();
  const subject = source ? careersClientSubject(source) : 'development-only';
  return { hash: createHmac('sha256', careersClientKey(env)).update(subject).digest('hex'), verified: source !== null };
}

/** The request-budget key for public page reads by this client, or null when the client cannot be told apart. */
export function careersReadBudgetKey(request: Request, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const { hash } = careersClientHash(request, env);
    return createHash('sha256').update(JSON.stringify(['recruitment-careers-read', hash])).digest('hex');
  } catch {
    return null;
  }
}
