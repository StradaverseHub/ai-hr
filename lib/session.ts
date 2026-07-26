import { cookies } from 'next/headers';
import { client, type Grant, type SessionContext } from '../db/client';
import { resolveEntitlementsRaw } from '../core/entitlements';
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
 * Costs no extra round trip on the hot path in the sense that matters: getSession already queries
 * app.principal, and this is the second statement on a connection that is already open.
 */
async function withEntitlements(session: SessionContext): Promise<SessionContext> {
  const snapshot = await resolveEntitlementsRaw(
    (q, params) => client.unsafe(q, params as never[]),
    session.tenantId,
  );
  return { ...session, entitlements: snapshot } as SessionContext;
}

export async function getSession(): Promise<SessionContext> {
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
