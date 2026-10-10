import { keycloakSelected } from '../lib/identity/config';
/**
 * Auth services (ADR-0072). Invitation-only account creation + password-reset + logout, all delegating
 * the security-sensitive parts (email, hashing, reset tokens, rate-limiting) to WorkOS via lib/workos.
 *
 * Two audit paths, deliberately distinct (see ADR-0072 / ADR-0006):
 *   • Admin-authenticated writes (invite / revoke) run inside withTenant() and append through the
 *     normal appendEvent substrate — they have a tenant + an actor.
 *   • Pre-auth / cross-context events (invitation.accepted before a session exists, login-failed on an
 *     un-invited email, logout) cannot pass domain_event RLS, so they go through the SECURITY DEFINER
 *     app.append_auth_event writer on the RAW client (no tenant context), mirroring app.principal /
 *     app.onboarding_*. Actor is lowercase per db/events.ts.
 *
 * WorkOS is injected as a provider seam (default = the real lib/workos wrappers) so tests can pass a
 * fake and never touch the SDK — the same shape as resolveDevPrincipal's injected `lookup`.
 */
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { client, withTenant, type SessionContext } from '../db/client';
import { appInvitation, appUser, roleAssignment } from '../db/schema';
import { appendEvent, actorOf, subjectEmploymentForPerson } from '../db/events';
import { InvalidInvitationError } from '../lib/auth-errors';

/** The WorkOS surface auth services need — injectable so tests never hit the real SDK. */
export type AuthProvider = {
  sendInvitation: (email: string, activationPath?: string) => Promise<{ invitationId: string }>;
  revokeInvitation: (invitationId: string) => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  endSession: (returnTo?: string) => Promise<void>;
};

/**
 * The real WorkOS provider — lazily loaded (dynamic import) so that importing core/auth.ts in tests
 * does NOT pull in lib/workos (which imports 'server-only' + the WorkOS SDK and would throw outside a
 * server component). Tests always inject a fake AuthProvider, so lib/workos is never loaded there.
 */
const defaultProvider: AuthProvider = {
  sendInvitation: async (email, activationPath) => keycloakSelected()
    ? (await import('../lib/identity/provider')).sendIdentityInvitation(email, activationPath ?? '')
    : (await import('../lib/workos')).sendProviderInvitation(email),
  revokeInvitation: async (id) => (await import('../lib/workos')).revokeProviderInvitation(id),
  sendPasswordReset: async (email) => {
    if (keycloakSelected()) throw new Error('Use the Keycloak hosted recovery flow.');
    await (await import('../lib/workos')).sendProviderPasswordReset(email);
  },
  endSession: async (returnTo) => (await import('../lib/identity/provider')).endProviderSession(returnTo),
};

/**
 * The CUSTOMER roles an invitation may carry — `operator` is deliberately absent (0294: operator grants
 * are written by ai_hr_owner only, never invited).
 *
 * Exported so the boundary can be checked against the code: migration 0312 repeats this list as the
 * `app_invitation_role_customer_set` CHECK constraint and again inside `app.consume_invitation`, and
 * test/invitation-privesc.test.ts reads the constraint out of pg_constraint and asserts set-equality
 * with this set. Without that pin, a role added to the enum and to this set but not to 0312 would pass
 * TypeScript validation and then fail at the invitee's activation click.
 */
export const ROLES = new Set([
  'employee',
  'manager',
  'hr_admin',
  'super_admin',
  'payroll_partner',
  'performance_comp_partner',
]);
const INVITE_TTL_DAYS = 7;

/**
 * Fail-fast group-admin guard (mirrors lib/authz isGroupAdmin + withEffectiveGrants without importing
 * authz, which would pull in next/navigation + a getSession cycle). Identity management is group-wide-
 * admin only; RLS (app_invitation_rls + app_user tenant_isolation, 0016) is the authoritative backstop.
 * A roles-only context (test adminCtx: roles:['hr_admin'], no grants) is treated as group-wide.
 */
function assertGroupAdmin(ctx: SessionContext): void {
  const grants = ctx.grants ?? (ctx.roles ?? []).map((role) => ({ role, companyId: null as string | null }));
  const ok = grants.some((g) => g.role === 'super_admin' || (g.role === 'hr_admin' && g.companyId == null));
  if (!ok) throw new Error('Only a group administrator can manage user invitations.');
}

/** sha256(raw) hex — the only form of the token we ever persist. */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Opaque base64url token, ~256 bits (schema.ts pii-vault/ai_provider_config convention). */
function newRawToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SECURITY DEFINER auth-audit writer on the RAW client (no tenant context). Used for pre-auth /
 * cross-context events that cannot pass domain_event RLS. tenantId null → the reserved system tenant
 * (migration 0151) → admin-only-to-read (fail-closed).
 */
async function appendAuthEvent(args: {
  tenantId: string | null;
  aggregateType: 'app-user' | 'app-invitation';
  aggregateId: string;
  eventType: string;
  actorType: 'user' | 'system' | 'external';
  actorId: string | null;
  payload?: unknown;
}): Promise<void> {
  await client`
    select app.append_auth_event(
      ${args.tenantId}::uuid,
      ${args.aggregateType},
      ${args.aggregateId}::uuid,
      ${args.eventType},
      ${args.actorType},
      ${args.actorId}::uuid,
      ${JSON.stringify(args.payload ?? null)}::jsonb
    )
  `;
}

// ─────────────────────────── Admin: invitations ───────────────────────────

export type InviteUserInput = {
  email: string;
  role: string;
  companyId?: string | null;
  /** Optional: bind the invite to an already-created person (re-issuing a login for a hired employee). */
  personId?: string | null;
};

/**
 * Admin-only account creation — the ONLY path to a new login (no open self sign-up). Creates the
 * single-use app_invitation (hash only), sends the WorkOS invite email, and logs app-user.invited.
 * Returns the raw token ONCE (so a dev/test can build the activation URL); it is never re-derivable.
 */
export async function inviteUser(
  ctx: SessionContext,
  input: InviteUserInput,
  provider: AuthProvider = defaultProvider,
): Promise<{ invitationId: string; token: string }> {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('A valid email is required to invite a user.');
  if (!ROLES.has(input.role)) throw new Error(`Unknown role: ${input.role}`);
  const raw = newRawToken();
  const tokenHash = hashToken(raw);

  const invitationId = await withTenant(ctx, async (tx) => {
    // Identity management is group-wide-admin gated (RLS enforces it too; this fails fast + clearly).
    assertGroupAdmin(ctx);
    const [row] = await tx
      .insert(appInvitation)
      .values({
        tenantId: ctx.tenantId,
        companyId: input.companyId ?? null,
        email,
        role: input.role,
        personId: input.personId ?? null,
        tokenHash,
        status: 'pending',
        expiresAt: sql`now() + (${INVITE_TTL_DAYS} || ' days')::interval`,
        createdBy: ctx.userId ?? null,
      })
      .returning({ id: appInvitation.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'app-invitation',
      aggregateId: row.id,
      eventType: 'app-user.invited',
      actor: actorOf(ctx),
      // No single employment subject → admin-only to read (ADR-0015). Never log the raw token.
      payload: { email, role: input.role, companyId: input.companyId ?? null },
    });
    return row.id;
  });

  // WorkOS owns the email + one-time link + password set (delegated; failures here don't roll back the
  // row — the admin can re-send). Best-effort, outside the tenant tx.
  await provider.sendInvitation(email, `/invite/${raw}/activate`);
  return { invitationId, token: raw };
}

/** Pending invitations visible to the admin (RLS scopes rows to the companies they administer). */
export function listPendingInvitations(ctx: SessionContext) {
  return withTenant(ctx, async (tx) =>
    tx
      .select({
        id: appInvitation.id,
        email: appInvitation.email,
        role: appInvitation.role,
        companyId: appInvitation.companyId,
        expiresAt: appInvitation.expiresAt,
        createdAt: appInvitation.createdAt,
      })
      .from(appInvitation)
      .where(eq(appInvitation.status, 'pending'))
      .orderBy(appInvitation.createdAt),
  );
}

// ─────────────────────────── Admin: login lifecycle (0279) ───────────────────────────

/**
 * Archive (switch off) or restore a login. Archiving sets app_user.archived_at, which makes
 * app.principal_by_subject refuse to resolve the subject — so the login is genuinely refused at
 * sign-in and on the next page load of an already-open session, not merely hidden from the list.
 *
 * Role assignments are left completely untouched, so Restore puts the user back exactly as they were.
 *
 * Two guards, both about not locking the group out of its own admin screen:
 *   • You cannot archive YOURSELF (an admin cannot accidentally lock themselves out).
 *   • You cannot archive the LAST login holding a group-wide super_admin / hr_admin grant that is not
 *     already blocked. This covers the manual path only. The DERIVED path (the last admin's employment
 *     being ended) cannot be guarded here — that needs a check at the point of termination, which is a
 *     separate change; the break-glass SQL is documented in the 0279 migration header.
 */
export async function setAppUserArchived(
  ctx: SessionContext,
  input: { appUserId: string; archived: boolean },
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    assertGroupAdmin(ctx);
    if (ctx.userId && input.appUserId === ctx.userId) {
      throw new Error('You cannot archive your own login.');
    }
    if (input.archived) {
      // Any OTHER group-wide admin who is not already blocked keeps the screen reachable.
      const [remaining] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(roleAssignment)
        .innerJoin(appUser, eq(appUser.id, roleAssignment.appUserId))
        .where(
          and(
            isNull(roleAssignment.companyId),
            sql`${roleAssignment.role} in ('super_admin','hr_admin')`,
            ne(roleAssignment.appUserId, input.appUserId),
            sql`not app.login_blocked(${appUser.id})`,
          ),
        );
      if (!remaining || remaining.n === 0) {
        throw new Error('This is the last group administrator — archiving it would lock everyone out.');
      }
    }
    const [row] = await tx
      .update(appUser)
      .set({ archivedAt: input.archived ? sql`now()` : null })
      .where(eq(appUser.id, input.appUserId))
      .returning({ id: appUser.id, personId: appUser.personId });
    if (!row) throw new Error('User not found.');
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'app-user',
      aggregateId: row.id,
      eventType: input.archived ? 'app-user.archived' : 'app-user.restored',
      actor: actorOf(ctx),
      // Scope to the person's own employment so this reads on their timeline, not admin-only (ADR-0015).
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, row.personId),
      // The human reason lives here rather than in a column — no archived_reason to drift or to key
      // an i18n message off (next-intl throws on a missing message).
      payload: { reason: input.archived ? 'archived-by-administrator' : 'restored-by-administrator' },
    });
  });
}

/**
 * Auth-audit for a login that presented VALID credentials but resolved to no app_user — archived, or
 * the person has left. Without this the rejection vanishes into app/callback's bare catch. Pre-auth
 * (no tenant, no user) → system tenant, admin-only to read, same writer as recordLoginFailed.
 */
export async function recordLoginBlocked(input: { subject: string }): Promise<void> {
  await appendAuthEvent({
    tenantId: null,
    aggregateType: 'app-user',
    aggregateId: randomUUID(),
    eventType: 'app-user.login-blocked',
    actorType: 'external',
    actorId: null,
    payload: { subject: input.subject },
  });
}

/** Admin-only: revoke a still-pending invitation (single conditional update; RLS gates the row). */
export async function revokeInvitation(
  ctx: SessionContext,
  input: { invitationId: string },
  provider: AuthProvider = defaultProvider,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    assertGroupAdmin(ctx);
    const [row] = await tx
      .update(appInvitation)
      .set({ status: 'revoked' })
      .where(and(eq(appInvitation.id, input.invitationId), eq(appInvitation.status, 'pending')))
      .returning({ id: appInvitation.id, email: appInvitation.email });
    if (!row) throw new Error('This invitation cannot be revoked (already accepted, expired, or revoked).');
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'app-invitation',
      aggregateId: row.id,
      eventType: 'app-user.invitation.revoked',
      actor: actorOf(ctx),
      payload: { email: row.email },
    });
  });
  // Best-effort provider revoke is a follow-up (WorkOS invitation id is not persisted in this slice).
}

/**
 * Un-authenticated invitation consume (the invitee has no session yet). Runs the SECURITY DEFINER
 * app.consume_invitation on the RAW client (single-use guarded in-DB by the conditional UPDATE), then
 * logs app-user.invitation.accepted via the auth-audit writer (now that the tenant is known). Returns
 * the resolved (userId, tenantId). Throws InvalidInvitationError for unknown/consumed/expired tokens.
 */
export async function acceptInvitation(input: {
  token: string;
  subject: string;
  issuer?: string;
  verifiedEmail?: string;
}): Promise<{ userId: string; tenantId: string }> {
  const rows = input.issuer ? await client<{ app_user_id: string; tenant_id: string }[]>`
    select app_user_id, tenant_id from app.consume_identity_invitation(${input.token},${input.issuer},${input.subject},${input.verifiedEmail ?? null})
  ` : await client<{ app_user_id: string; tenant_id: string }[]>`
    select app_user_id, tenant_id from app.consume_invitation(${input.token}, ${input.subject})
  `;
  const resolved = rows[0];
  if (!resolved) throw new InvalidInvitationError();
  await appendAuthEvent({
    tenantId: resolved.tenant_id,
    aggregateType: 'app-user',
    aggregateId: resolved.app_user_id,
    eventType: 'app-user.invitation.accepted',
    actorType: 'user',
    actorId: resolved.app_user_id,
    payload: null,
  });
  return { userId: resolved.app_user_id, tenantId: resolved.tenant_id };
}

// ─────────────────────────── Password reset (thin over WorkOS) ───────────────────────────

/**
 * Request a password reset. Delegates delivery + token to WorkOS. Always emits the audit event and
 * (deliberately) never reveals whether the email is known — the event is recorded pre-auth with no
 * tenant (system tenant, admin-only to read).
 */
export async function requestPasswordReset(
  input: { email: string },
  provider: AuthProvider = defaultProvider,
): Promise<void> {
  const email = input.email.trim().toLowerCase();
  await provider.sendPasswordReset(email).catch(() => {
    // Swallow provider errors so we never leak whether the email exists; still audit the attempt.
  });
  await appendAuthEvent({
    tenantId: null,
    aggregateType: 'app-user',
    aggregateId: randomUUID(),
    eventType: 'app-user.password-reset-requested',
    actorType: 'external',
    actorId: null,
    payload: { email },
  });
}

/** Record that a password reset completed (WorkOS performed the actual change). */
export async function recordPasswordReset(input: { tenantId: string | null; userId: string | null }): Promise<void> {
  await appendAuthEvent({
    tenantId: input.tenantId,
    aggregateType: 'app-user',
    aggregateId: input.userId ?? randomUUID(),
    eventType: 'app-user.password-reset',
    actorType: input.userId ? 'user' : 'external',
    actorId: input.userId,
    payload: null,
  });
}

// ─────────────────────────── Login / logout audit ───────────────────────────

/** Auth-audit for a successful login (tenant + user known). */
export async function recordLoginSucceeded(input: { tenantId: string; userId: string }): Promise<void> {
  await appendAuthEvent({
    tenantId: input.tenantId,
    aggregateType: 'app-user',
    aggregateId: input.userId,
    eventType: 'app-user.logged-in',
    actorType: 'user',
    actorId: input.userId,
    payload: null,
  });
}

/**
 * Auth-audit for a rejected login (wrong password / un-invited email). No tenant, no user →
 * system-tenant, admin-only to read. Proves the pre-auth audit works despite domain_event RLS.
 */
export async function recordLoginFailed(input: { email: string }): Promise<void> {
  await appendAuthEvent({
    tenantId: null,
    aggregateType: 'app-user',
    aggregateId: randomUUID(),
    eventType: 'app-user.login-failed',
    actorType: 'external',
    actorId: null,
    payload: { email: input.email.trim().toLowerCase() },
  });
}

/**
 * Clear/revoke the WorkOS session cookie AND append app-user.logged-out via the auth-audit writer.
 * The audit write happens BEFORE endSession because WorkOS's signOut redirects (throws internally).
 */
export async function logout(
  input: { tenantId: string; userId: string },
  provider: AuthProvider = defaultProvider,
  returnTo?: string,
): Promise<void> {
  await appendAuthEvent({
    tenantId: input.tenantId,
    aggregateType: 'app-user',
    aggregateId: input.userId,
    eventType: 'app-user.logged-out',
    actorType: 'user',
    actorId: input.userId,
    payload: null,
  });
  await provider.endSession(returnTo);
}
