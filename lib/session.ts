import { cache } from 'react';
import { cookies } from 'next/headers';
import { client, type Grant, type SessionContext } from '../db/client';
import { TENANT_STATUS_UNRESOLVED, resolveEntitlementsInTenantTx } from '../core/entitlements';
import { AuthRequiredError } from './auth-errors';
import { demoSwitcherEnabled } from './demo-mode';

/**
 * Session resolution (ADR-0072). Two paths, gated by NODE_ENV:
 *
 *  • DEV (NODE_ENV !== 'production'): the dev identity switcher — the active principal is the `dev_user`
 *    cookie (or DEV_USER_ID), resolved via app.principal(). Kept so `pnpm dev` and the test harness are
 *    never forced through WorkOS. This is the ONLY path that reads app.principal() by internal id.
 *
 *  • PRODUCTION: verify the WorkOS session, take its subject, resolve it to an app_user via the
 *    SECURITY DEFINER app.principal_by_subject(). SessionContext.userId is the returned INTERNAL
 *    app_user.id uuid (NOT the WorkOS subject — app.current_user_id() casts it to uuid, so a subject
 *    string would break every self-scoped RLS predicate). No/expired session, or a subject that maps to
 *    no app_user (offboarded user with a still-valid cookie) → AuthRequiredError, which the app layout
 *    catches and redirects to /login (never a 500, never a stale resolve).
 *
 * Every page/action keeps calling getSession() unchanged; only this function knows about WorkOS.
 */
const DEV_COOKIE = 'dev_user';

/** A row from `app.principal()` — `grants` may be null (defensively typed). */
type PrincipalRow = { tenant_id: string; person_id: string | null; grants: Grant[] | null };
/** A row from `app.principal_by_subject()` — additionally carries the internal app_user id. */
type SubjectPrincipalRow = PrincipalRow & { app_user_id: string };

/** Shape a principal row + a known userId into a SessionContext (shared by both paths). */
function toSession(userId: string, principal: PrincipalRow): SessionContext {
  const grants = (principal.grants ?? []) as Grant[];
  return {
    tenantId: principal.tenant_id,
    userId,
    personId: principal.person_id,
    grants,
    roles: Array.from(new Set(grants.map((g) => g.role))),
  };
}

/**
 * Resolve a dev principal id to a SessionContext, tolerant of stale/unknown ids. Tries the cookie
 * user first, then the configured fallback (DEV_USER_ID), and returns the FIRST that resolves — so a
 * stale `dev_user` cookie (a previous seed's id, or a since-deleted user) self-heals to the default
 * identity instead of throwing an uncaught `TypeError: ... reading 'grants'` on every request. Only
 * when no candidate id resolves at all (e.g. the DB isn't seeded) does it throw a CLEAR, typed error.
 *
 * BLOCKED ids fail CLOSED and must NOT use that fall-through (0279). An archived login, or one whose
 * person has left, still RESOLVES here — app.principal() is deliberately left unfiltered — so if the
 * filter lived in the SQL instead, an archived cookie identity would fall through to DEV_USER_ID, i.e.
 * normally the seeded GROUP ADMIN. Archiving a user would then ESCALATE their privileges rather than
 * block them. And this path is not dev-only: demoSwitcherEnabled() is true in a real build whenever
 * ALLOW_DEMO_SESSION is set. So: an id that resolves AND is blocked throws AuthRequiredError
 * immediately (→ /login via app/layout.tsx); an id that does not resolve at all still self-heals.
 *
 * Pure + injectable (`lookup`, `blocked`) so both paths are unit-testable without a request context.
 * `blocked` defaults to never-blocked so existing 3-arg callers keep their pinned behaviour.
 */
export async function resolveDevPrincipal(
  lookup: (id: string) => Promise<PrincipalRow[]>,
  cookieUser: string | undefined,
  fallback: string | undefined,
  blocked: (id: string) => Promise<boolean> = async () => false,
): Promise<SessionContext> {
  const ids = [...new Set([cookieUser, fallback].filter((v): v is string => Boolean(v)))];
  if (ids.length === 0) {
    throw new Error('No dev principal. Run `pnpm db:seed`, then pick an identity.');
  }
  for (const id of ids) {
    const [principal] = await lookup(id);
    // Unknown id → try the next candidate (the self-heal). Known-but-blocked → stop here, never
    // continue to the fallback identity: continuing is the privilege escalation described above.
    if (!principal) continue;
    if (await blocked(id)) {
      throw new AuthRequiredError('This login has been archived or its employment has ended.');
    }
    return toSession(id, principal);
  }
  throw new Error(
    `No valid dev principal (tried ${ids.join(', ')}) — run \`pnpm db:seed\`, then pick an identity.`,
  );
}

/**
 * Resolve a verified WorkOS subject to a SessionContext via app.principal_by_subject(). Pure +
 * injectable (`lookup`) so the offboarded-subject path is unit-testable without a live WorkOS. Puts
 * the returned INTERNAL app_user.id into userId. Throws AuthRequiredError when the subject maps to no
 * app_user (deleted/offboarded user, still-valid cookie) — fail closed, never a stale resolve.
 */
export async function resolveWorkosPrincipal(
  lookup: (subject: string) => Promise<SubjectPrincipalRow[]>,
  subject: string,
): Promise<SessionContext> {
  const [principal] = await lookup(subject);
  if (!principal) throw new AuthRequiredError('No account is linked to this login.');
  return toSession(principal.app_user_id, principal);
}

/**
 * Attach the tenant's entitlement snapshot to a resolved session (ADR-0077 slice 2).
 *
 * Applied HERE rather than inside resolveDevPrincipal / resolveWorkosPrincipal because F19 is exactly
 * that those are two different code paths — the gated demo runs the dev switcher in production — and
 * an enforcement primitive wired into only one of them would be silently absent on the deployment we
 * actually ship. One seam, both paths, no way to add a third without passing through it.
 *
 * INSIDE A TRANSACTION, AND THAT IS THE WHOLE POINT (round 1's critical finding). This used to run
 * `client.unsafe(...)` straight on the pool. `client` is the non-privileged `ai_hr_app` role, and the
 * three tables the snapshot reads are all gated by `USING (… = app.current_tenant_id())` — which is
 * NULL outside a `withTenant`-style transaction, so the comparison is NULL, so the app role saw zero
 * rows. Every production session silently resolved to an empty snapshot: no modules, no settings, and
 * a suspended tenant reading as active. `client.begin` opens the transaction; the set_config is issued
 * inside `resolveEntitlementsInTenantTx` next to the SELECT that depends on it.
 *
 * NOT free, and the old comment saying otherwise was wrong: this is BEGIN + set_config + SELECT +
 * COMMIT on a connection getSession already holds, on every getSession call. See core/entitlements.ts.
 *
 * DEGRADES, DOES NOT 500. getSession is the entry point for every page, so an exception here — the
 * 0313 tables not yet applied on a code-ahead-of-migration deploy, a revoked grant, a connection blip
 * — would take down authentication itself, including /login, since app/layout.tsx only converts
 * AuthRequiredError into a redirect. Instead the session is returned WITHOUT a snapshot, which makes
 * every entitlement gate refuse at the point of use (fail-closed, and core modules still answer true)
 * rather than making the whole app unreachable.
 *
 * IT RECORDS THE CAUSE (round 2). Returning a bare session made a genuine outage indistinguishable
 * from a hand-built synthetic context: both produced EntitlementsUnresolvedError, whose message sends
 * the reader after a nonexistent wiring bug while the real fault goes unnamed. `entitlementsError`
 * carries the underlying message onto the session, so the gate raises
 * EntitlementsResolutionFailedError naming the tenant and the cause instead.
 *
 * LOGGED ONCE PER FAULT PER INTERVAL, not once per request. A per-request console.error during an
 * outage is one line per page render across every user — the signal that matters (something broke, for
 * this tenant, with this message) drowns in it, which is the opposite of "logged loudly".
 *
 * Exported so the test can assert the composed behaviour — transaction, GUC, RLS and all — through the
 * exact function production calls, rather than through a re-implementation of it.
 */
const FAILURE_LOG_INTERVAL_MS = 60_000;
// Bounded: the key includes the driver's message, which can vary per failure, and an unbounded map on
// the auth path would turn a database outage into a memory leak. Dropped wholesale rather than by LRU —
// the cost of forgetting is at most one extra log line.
const FAILURE_LOG_MAX_KEYS = 200;
const lastLoggedFailure = new Map<string, number>();

/** One throttled line per distinct fault, so an outage does not produce one log per page render. */
function logThrottled(key: string, message: string, detail?: unknown): void {
  const now = Date.now();
  if ((lastLoggedFailure.get(key) ?? 0) + FAILURE_LOG_INTERVAL_MS > now) return;
  if (lastLoggedFailure.size >= FAILURE_LOG_MAX_KEYS) lastLoggedFailure.clear();
  lastLoggedFailure.set(key, now);
  if (detail === undefined) console.error(message);
  else console.error(message, detail);
}

export async function withEntitlements(session: SessionContext): Promise<SessionContext> {
  try {
    const snapshot = await client.begin((tx) =>
      resolveEntitlementsInTenantTx((q, params) => tx.unsafe(q, params as never[]), session.tenantId),
    );
    // THE SILENT FAILURE, WHICH IS THE ONE ROUND 1 ACTUALLY SHIPPED (round 3's finding). The catch below
    // covers the loud path — an exception. The dangerous state is the query SUCCEEDING and returning no
    // tenant row: `toSnapshot` records TENANT_STATUS_UNRESOLVED, every billable module closes, and until
    // now nothing was logged, so a database-side regression (an RLS policy edit, a partially-applied
    // migration, a tenant row invisible for any reason) was indistinguishable in monitoring from a
    // healthy resolve. That is exactly the shape of the defect round 1 found — an empty snapshot on
    // every session — and the instrumentation added for it did not cover it. This status is BY
    // DEFINITION a fault: a real tenant row always carries one of 0313's four statuses.
    if (snapshot.tenantStatus === TENANT_STATUS_UNRESOLVED) {
      logThrottled(
        `${session.tenantId}:unresolved`,
        `[entitlements] tenant ${session.tenantId} resolved with NO tenant row (status ` +
          `'${TENANT_STATUS_UNRESOLVED}'): the snapshot query succeeded but returned nothing, so every ` +
          `billable module will refuse. Check the 0313 tables, the tenant row and tenant_isolation. ` +
          `(further identical warnings suppressed for ${FAILURE_LOG_INTERVAL_MS / 1000}s)`,
      );
    }
    return { ...session, entitlements: snapshot };
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    logThrottled(
      `${session.tenantId}:${cause}`,
      `[entitlements] snapshot resolution FAILED for tenant ${session.tenantId}; the session carries ` +
        `no entitlements and every gated module will refuse until this is fixed. ` +
        `(further identical failures suppressed for ${FAILURE_LOG_INTERVAL_MS / 1000}s)`,
      e,
    );
    return { ...session, entitlementsError: cause };
  }
}

/**
 * MEMOISED PER REQUEST with React `cache()` (round 2).
 *
 * Two problems, one fix. The cost: `withEntitlements` reserves a pooled connection for a full
 * BEGIN/set_config/SELECT/COMMIT, and getSession is called by the root layout, by 61 of the 105
 * `page.tsx` guards, and again by every server action — so an authenticated render paid that
 * transaction several times over. The correctness half matters more: without memoisation the
 * resolution is per-CALL, not per-request, so two components in the same render could observe
 * DIFFERENT snapshots. "Session-scoped" has to mean the snapshot is stable for the request, and only
 * memoisation makes that true.
 *
 * `cache` is a no-op passthrough outside a React request scope (react's non-`react-server` build
 * returns `fn.apply(null, arguments)` unchanged), so scripts and the test suite are unaffected — they
 * get exactly today's behaviour, one resolution per call.
 */
export const getSession = cache(resolveSession);

async function resolveSession(): Promise<SessionContext> {
  // Dev switcher path: real dev, plus the gated demo (ALLOW_DEMO_SESSION — see lib/demo-mode).
  if (demoSwitcherEnabled()) {
    const cookieStore = await cookies();
    const cookieUser = cookieStore.get(DEV_COOKIE)?.value;
    const fallback = process.env.DEV_USER_ID;
    const lookup = (id: string) =>
      client<PrincipalRow[]>`
        select tenant_id, person_id, grants from app.principal(${id}::uuid)
      `;
    // Separate lookup, NOT a filter inside app.principal — see resolveDevPrincipal's header.
    const blocked = async (id: string) => {
      const [row] = await client<{ blocked: boolean }[]>`select app.login_blocked(${id}::uuid) as blocked`;
      return Boolean(row?.blocked);
    };
    return withEntitlements(await resolveDevPrincipal(lookup, cookieUser, fallback, blocked));
  }

  // Production: WorkOS is the auth. Imported lazily so the dev/test path never loads the WorkOS SDK.
  const { currentWorkosSession } = await import('./workos');
  const session = await currentWorkosSession();
  if (!session) throw new AuthRequiredError('No active session.');
  const lookup = (subject: string) =>
    client<SubjectPrincipalRow[]>`
      select app_user_id, tenant_id, person_id, grants from app.principal_by_subject(${subject})
    `;
  return withEntitlements(await resolveWorkosPrincipal(lookup, session.subject));
}
