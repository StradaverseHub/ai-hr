/**
 * ADR-0077 D5 / slice 7 — the CONTROL PLANE's database connection.
 *
 * A SEPARATE POOL, on a SEPARATE ROLE (`ai_hr_platform`, BYPASSRLS). This is the privilege boundary the
 * whole platform plane rests on, and the reason it is a distinct module rather than a flag on
 * `db/client.ts`:
 *
 *   `ai_hr_app` must never gain cross-tenant read. If the platform view ran on the application's
 *   connection, a single routing bug would leak one customer's payroll onto another customer's screen.
 *   With a distinct role a leak needs TWO independent mistakes — reaching platform code AND holding
 *   the platform pool. ADR-0077 considered and rejected a separate APPLICATION for this; the database
 *   role is what carries the isolation instead, so it has to be real.
 *
 * ── THE RULES THIS FILE ENFORCES ──────────────────────────────────────────────────────────────────
 *
 * 1. NO FALLBACK. If `PLATFORM_DATABASE_URL` is unset this throws. It must never quietly fall back to
 *    `DATABASE_URL` or `MIGRATION_DATABASE_URL` — a fallback turns a missing configuration into either
 *    a silently powerless plane (app role, RLS still on, "why is the tenant list empty?") or a silently
 *    over-privileged one (owner role, which can also ALTER the schema). Both are worse than a crash on
 *    boot, which is loud and happens before anyone is looking at data.
 *
 * 2. IT MUST NOT BE THE SAME URL AS THE APP'S. Pointing PLATFORM_DATABASE_URL at the app credentials
 *    would satisfy rule 1 while defeating the entire boundary, and it is an easy copy-paste to make in
 *    an env file. Checked explicitly.
 *
 * 3. EVERY READ IS AN AUDIT EVENT — Stradaverse looking at a customer's data is itself an event
 *    (ADR-0077 D5). That belongs to the callers, not to the pool, but it is stated here because this
 *    is the file someone reads when they add the first caller.
 */
import { createDb } from './client';

/** Thrown at construction, never at query time — a misconfigured plane must fail before it is used. */
export class PlatformConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformConnectionError';
  }
}

/**
 * Validate the platform connection string against the app's. Exported for the test, because the rule
 * matters more than the plumbing: this is the assertion that stops the boundary being defeated by an
 * env file rather than by code.
 */
export function assertPlatformUrl(
  platformUrl: string | undefined | null,
  appUrl: string | undefined | null,
  ownerUrl?: string | undefined | null,
): string {
  if (!platformUrl || platformUrl.trim() === '') {
    throw new PlatformConnectionError(
      'PLATFORM_DATABASE_URL is not set. The control plane has no fallback by design — it must not ' +
        'borrow the application role (RLS would hide every tenant) or the owner role (which can alter ' +
        'the schema). Set it to the ai_hr_platform credentials, or leave the platform plane off.',
    );
  }
  if (appUrl && platformUrl === appUrl) {
    throw new PlatformConnectionError(
      'PLATFORM_DATABASE_URL is identical to DATABASE_URL. That satisfies the setting while defeating ' +
        'the privilege boundary it exists to create — the control plane must connect as ai_hr_platform, ' +
        'not as ai_hr_app.',
    );
  }
  if (ownerUrl && platformUrl === ownerUrl) {
    throw new PlatformConnectionError(
      'PLATFORM_DATABASE_URL is identical to MIGRATION_DATABASE_URL. The owner role can ALTER the ' +
        'schema and drop policies; the control plane is a reader of tenancy and billing, and must not ' +
        'hold that power.',
    );
  }
  return platformUrl;
}

let cached: ReturnType<typeof createDb> | null = null;

/**
 * The platform pool. Constructed lazily and cached, so importing this module costs nothing in a
 * request that never touches the control plane — and so a deployment with no platform credentials
 * boots normally right up until something actually asks for the plane.
 */
export function platformDb() {
  if (cached) return cached;
  const url = assertPlatformUrl(
    process.env.PLATFORM_DATABASE_URL,
    process.env.DATABASE_URL,
    process.env.MIGRATION_DATABASE_URL,
  );
  // A small pool on purpose: this serves a handful of Stradaverse staff, not tenant traffic, and a
  // large one would sit on connections the application needs.
  cached = createDb(url, { max: 2 });
  return cached;
}

/** True when the control plane is configured at all. Lets a caller render "not available" rather than
 *  crash a page, without ever tempting anyone into a fallback. */
export function platformPlaneConfigured(): boolean {
  const url = process.env.PLATFORM_DATABASE_URL;
  if (!url || url.trim() === '') return false;
  try {
    assertPlatformUrl(url, process.env.DATABASE_URL, process.env.MIGRATION_DATABASE_URL);
    return true;
  } catch {
    // A MISCONFIGURED plane reports as not configured here, and still throws from platformDb(). The
    // page renders "unavailable"; the operator gets the real reason the moment they try to use it.
    return false;
  }
}

/** Reset the cached pool. Tests only — production has exactly one platform pool per process. */
export function __resetPlatformDbForTests() {
  cached = null;
}
