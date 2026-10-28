import { manualIdentityError } from '../lib/identity/manual-model';
import { internalSelected } from '../lib/internal-auth/config';
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
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { client, withTenant, type SessionContext, type Tx } from '../db/client';
import { appInvitation, appUser, roleAssignment, accountEmailDelivery } from '../db/schema';
import { appendEvent, actorOf, subjectEmploymentForPerson } from '../db/events';
import { InvalidInvitationError } from '../lib/auth-errors';
import { attemptAccountEmail } from './account-email';
import { accountEmailReadiness } from '../lib/identity/account-email-readiness';
import { recoveryEmailSchema,type AccountEmailReadiness,type AccountEmailContext } from '../lib/account-email-model';
import type {IdentityEmailActor} from '../lib/identity/email-model';

/** The WorkOS surface auth services need — injectable so tests never hit the real SDK. */
export type AuthProvider = {
  sendInvitation: (email: string, activationPath?: string, context?: AccountEmailContext) => Promise<{ invitationId: string }>;
  revokeInvitation: (invitationId: string) => Promise<void>;
  sendPasswordReset: (email: string, context?: AccountEmailContext) => Promise<void>;
  endSession: (returnTo?: string) => Promise<void>;
  emailReadiness?:()=>Promise<AccountEmailReadiness>;
};

/**
 * The real WorkOS provider — lazily loaded (dynamic import) so that importing core/auth.ts in tests
 * does NOT pull in lib/workos (which imports 'server-only' + the WorkOS SDK and would throw outside a
 * server component). Tests always inject a fake AuthProvider, so lib/workos is never loaded there.
 */
const defaultProvider: AuthProvider = {
  sendInvitation: async (email, activationPath, context) => internalSelected()
    ? (await import('../lib/internal-auth/invitations')).sendInternalInvitation(email, activationPath ?? '', context)
    : keycloakSelected()
    ? (await import('../lib/identity/provider')).sendIdentityInvitation(email, activationPath ?? '')
    : (await import('../lib/workos')).sendProviderInvitation(email),
  revokeInvitation: async (id) => { if (!internalSelected()) await (await import('../lib/workos')).revokeProviderInvitation(id); },
  sendPasswordReset: async (email, context) => {
    if (internalSelected()) return (await import('../lib/internal-auth/recovery')).sendInternalRecovery(email, context);
    if (keycloakSelected()) return (await import('../lib/identity/provider')).sendIdentityPasswordReset(email);
    await (await import('../lib/workos')).sendProviderPasswordReset(email);
  },
  emailReadiness:accountEmailReadiness,
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
  // ADR-0142 — repeated in 0611's app_invitation_role_customer_set and app.consume_invitation guard A.
  'performance_partner',
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
  /** Explicit new human login contact. Never creates an employment or matches by email. */
  fullName?: string;
  email: string;
  role: string;
  companyId?: string | null;
  /** Optional: bind the invite to an already-created person (re-issuing a login for a hired employee). */
  personId?: string | null;
};

/**
 * Admin-only account creation — the ONLY path to a new login (no open self sign-up). Creates the
 * single-use app_invitation (hash only), records email delivery separately, and logs app-user.invited.
 * Returns the raw token ONCE (so a dev/test can build the activation URL); it is never re-derivable.
 */
async function createInvitationTx(tx:Tx,ctx:SessionContext,input:InviteUserInput,replacesDeliveryId?:string){
  assertGroupAdmin(ctx);
  const email=input.email.trim().toLowerCase();
  if(!email||!email.includes('@'))throw new Error('A valid email is required to invite a user.');
  if(!ROLES.has(input.role))throw new Error(`Unknown role: ${input.role}`);
  let personId=input.personId??null;
  if(input.fullName!==undefined){
    if(personId||!input.fullName.trim()||input.fullName.trim().length>200)throw new Error('Enter the new user’s full name.');
    try {
      const rows=await tx.execute<{id:string}>(sql`select app.create_login_person(${input.fullName.trim()},${email}) id`);
      personId=rows[0].id;
    } catch(error) {
      if(manualIdentityError(error).code==='conflict')throw new Error('A person with this email already exists. Select the existing person or review existing accounts.');
      throw error;
    }
  }
  // 5e0b2154 — employee records may now share an email, but a sign-in account may not: password recovery
  // mails the account's own address, so whoever reads a shared inbox could recover the other person's login.
  // A re-invitation of the SAME person (retry, resend) is unaffected.
  const [clash]=await tx.select({id:appInvitation.id}).from(appInvitation).where(and(sql`lower(${appInvitation.email})=${email}`,
    inArray(appInvitation.status,['pending','accepted']),personId?sql`${appInvitation.personId} is distinct from ${personId}::uuid`:sql`true`)).limit(1);
  if(clash)throw new Error('Another person already has a sign-in invitation or account for this email. Each sign-in account needs its own email address.');
  const token=newRawToken(),leaseToken=randomUUID();
  const [row]=await tx.insert(appInvitation).values({tenantId:ctx.tenantId,companyId:input.companyId??null,email,
    role:input.role,personId,tokenHash:hashToken(token),status:'pending',
    expiresAt:sql`now()+(${INVITE_TTL_DAYS}||' days')::interval`,createdBy:ctx.userId??null}).returning({id:appInvitation.id});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'app-invitation',aggregateId:row.id,
    eventType:'app-user.invited',actor:actorOf(ctx),payload:{email,role:input.role,companyId:input.companyId??null}});
  const [delivery]=await tx.insert(accountEmailDelivery).values({tenantId:ctx.tenantId,kind:'invitation',invitationId:row.id,
    replacesDeliveryId:replacesDeliveryId??null,requestedBy:ctx.userId??null,leaseToken,leaseUntil:sql`now()+interval '90 seconds'`}).returning({id:accountEmailDelivery.id});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'account-email',aggregateId:delivery.id,eventType:'account-email.requested',
    actor:actorOf(ctx),payload:{kind:'invitation',...(replacesDeliveryId?{replaces:replacesDeliveryId}:{})}});
  return {invitationId:row.id,token,deliveryId:delivery.id,leaseToken};
}

export async function inviteUser(ctx:SessionContext,input:InviteUserInput,provider:AuthProvider=defaultProvider):Promise<{invitationId:string;token:string}>{
  const created=await withTenant(ctx,tx=>createInvitationTx(tx,ctx,input));
  await attemptAccountEmail(created.deliveryId,created.leaseToken,provider,created.token);
  return {invitationId:created.invitationId,token:created.token};
}

/** Explicit retry reissues an immutable invitation, or reserves a fresh operator-authorized recovery. */
export async function retryAccountEmail(ctx:SessionContext,id:string,acknowledged:boolean,actor?:IdentityEmailActor,provider:AuthProvider=defaultProvider):Promise<void>{
  if(!acknowledged||!/^([0-9a-f]{8}-)([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))throw Error('Confirm the account email retry.');
  if(actor){
    if(actor.userId!==ctx.userId||actor.tenantId!==ctx.tenantId)throw Error('Email administrator identity does not match the session.');
    const reserved=await withTenant(ctx,tx=>tx.execute<{id:string;lease_token:string}>(sql`select * from app.account_email_retry_recovery(${id}::uuid,${actor.issuer},${actor.subject})`));
    if(reserved[0]){await attemptAccountEmail(reserved[0].id,reserved[0].lease_token,provider);return;}
  }
  const created=await withTenant(ctx,async tx=>{
    assertGroupAdmin(ctx);await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`account-email-retry:${id}`},0))`);
    const [delivery]=await tx.select().from(accountEmailDelivery).where(and(eq(accountEmailDelivery.id,id),eq(accountEmailDelivery.kind,'invitation'),sql`${accountEmailDelivery.status} in ('failed','sent')`));
    if(!delivery?.invitationId)throw Error('This account email cannot be retried.');
    const [replacement]=await tx.select({id:accountEmailDelivery.id}).from(accountEmailDelivery).where(eq(accountEmailDelivery.replacesDeliveryId,id));
    if(replacement)throw Error('This account email already has a replacement.');
    const [invitation]=await tx.select().from(appInvitation).where(and(eq(appInvitation.id,delivery.invitationId),eq(appInvitation.status,'pending'))).for('update');
    if(!invitation)throw Error('This invitation is no longer pending.');
    await tx.update(appInvitation).set({status:'revoked'}).where(eq(appInvitation.id,invitation.id));
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'app-invitation',aggregateId:invitation.id,eventType:'app-user.invitation.revoked',actor:actorOf(ctx),payload:{email:invitation.email}});
    return createInvitationTx(tx,ctx,{email:invitation.email,role:invitation.role,companyId:invitation.companyId,personId:invitation.personId},id);
  });
  await attemptAccountEmail(created.deliveryId,created.leaseToken,provider,created.token);
}

/** Pending invitations visible to the admin (RLS scopes rows to the companies they administer). */
export function listPendingInvitations(ctx: SessionContext) {
  return withTenant(ctx, async (tx) =>
    tx
      .select({
        id: appInvitation.id,
        personId: appInvitation.personId,
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
 * Record password recovery and attempt provider delivery separately. Always emits the audit event and
 * (deliberately) never reveals whether the email is known — the event is recorded pre-auth with no
 * tenant (system tenant, admin-only to read).
 */
export async function requestPasswordReset(
  input: { email: string },
  provider: AuthProvider = defaultProvider,
): Promise<void> {
  if (internalSelected()) return; // Embedded recovery requires an exact organization + username.
  const parsed=recoveryEmailSchema.safeParse(input.email.trim());
  if(!parsed.success)return;
  const email=parsed.data;
  const [delivery]=await client<{id:string;lease_token:string}[]>`select * from app.account_email_request_recovery(${email})`;
  if(delivery)await attemptAccountEmail(delivery.id,delivery.lease_token,provider);
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
  await recordLogout(input);
  await provider.endSession(returnTo);
}

export async function recordLogout(input: { tenantId: string; userId: string }): Promise<void> {
  await appendAuthEvent({
    tenantId: input.tenantId,
    aggregateType: 'app-user',
    aggregateId: input.userId,
    eventType: 'app-user.logged-out',
    actorType: 'user',
    actorId: input.userId,
    payload: null,
  });
}
