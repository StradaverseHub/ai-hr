import {emailLocale as emailLocaleSchema} from '../lib/email-design/model';
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
import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { client, withPoolWork, withTenant, type SessionContext, type Tx } from '../db/client';
import { lockAccessConfigurationWriteTx } from './access-configuration-lock';
import { appInvitation, appUser, roleAssignment, accountEmailDelivery } from '../db/schema';
import { appendEvent, actorOf, subjectEmploymentForPerson } from '../db/events';
import { InvalidInvitationError } from '../lib/auth-errors';
import { attemptAccountEmail } from './account-email';
import { accountEmailReadiness } from '../lib/identity/account-email-readiness';
import { recoveryEmailSchema,type AccountEmailReadiness,type AccountEmailContext } from '../lib/account-email-model';
import type {IdentityEmailActor} from '../lib/identity/email-model';
import {manualSetupPersonIdsTx} from './manual-identity-setup';

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
  // ADR-0049 §2 — repeated in 5851's app_invitation_role_customer_set and app.consume_invitation guard A (restated on
  // 5000's Access-locked body by 5864).
  'recruiting_partner',
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
  await withPoolWork('authentication', () => client`
    select app.append_auth_event(
      ${args.tenantId}::uuid,
      ${args.aggregateType},
      ${args.aggregateId}::uuid,
      ${args.eventType},
      ${args.actorType},
      ${args.actorId}::uuid,
      ${JSON.stringify(args.payload ?? null)}::jsonb
    )
  `);
}

// ─────────────────────────── Admin: invitations ───────────────────────────

export type InviteUserInput = {
  /** Language selected by the authorized inviter; retries retain this invitation fact. */
  emailLocale?:string;
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
async function createInvitationTx(tx:Tx,ctx:SessionContext,input:InviteUserInput,replacesDeliveryId?:string,batchJobId?:string){
  assertGroupAdmin(ctx);
  // Invitations are authority inputs: the row trigger only tries the exclusive Access lock.
  await lockAccessConfigurationWriteTx(tx,ctx.tenantId);
  const email=input.email.trim().toLowerCase(),emailLocale=emailLocaleSchema.parse(input.emailLocale??'en');
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
    role:input.role,emailLocale,personId,tokenHash:hashToken(token),status:'pending',
    expiresAt:sql`now()+(${INVITE_TTL_DAYS}||' days')::interval`,createdBy:ctx.userId??null}).returning({id:appInvitation.id});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'app-invitation',aggregateId:row.id,
    eventType:'app-user.invited',actor:actorOf(ctx),payload:{email,role:input.role,emailLocale,companyId:input.companyId??null,...(batchJobId?{batchJobId}:{})}});
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
/** Returns the replacement invitation delivery and its attempt result (board 0735d1b7: the batch results screen),
 * or undefined for an operator recovery retry. Callers that ignore the value are unaffected. */
export async function retryAccountEmail(ctx:SessionContext,id:string,acknowledged:boolean,actor?:IdentityEmailActor,provider:AuthProvider=defaultProvider):Promise<{deliveryId:string;outcome:AccountEmailOutcome}|undefined>{
  if(!acknowledged||!/^([0-9a-f]{8}-)([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))throw Error('Confirm the account email retry.');
  if(actor){
    if(actor.userId!==ctx.userId||actor.tenantId!==ctx.tenantId)throw Error('Email administrator identity does not match the session.');
    const reserved=await withTenant(ctx,tx=>tx.execute<{id:string;lease_token:string}>(sql`select * from app.account_email_retry_recovery(${id}::uuid,${actor.issuer},${actor.subject})`));
    if(reserved[0]){await attemptAccountEmail(reserved[0].id,reserved[0].lease_token,provider);return undefined;}
  }
  const created=await withTenant(ctx,async tx=>{
    assertGroupAdmin(ctx);await lockAccessConfigurationWriteTx(tx,ctx.tenantId);await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`account-email-retry:${id}`},0))`);
    const [delivery]=await tx.select().from(accountEmailDelivery).where(and(eq(accountEmailDelivery.id,id),eq(accountEmailDelivery.kind,'invitation'),sql`${accountEmailDelivery.status} in ('failed','sent')`));
    if(!delivery?.invitationId)throw Error('This account email cannot be retried.');
    const [replacement]=await tx.select({id:accountEmailDelivery.id}).from(accountEmailDelivery).where(eq(accountEmailDelivery.replacesDeliveryId,id));
    if(replacement)throw Error('This account email already has a replacement.');
    const [invitation]=await tx.select().from(appInvitation).where(and(eq(appInvitation.id,delivery.invitationId),eq(appInvitation.status,'pending'))).for('update');
    if(!invitation)throw Error('This invitation is no longer pending.');
    await tx.update(appInvitation).set({status:'revoked'}).where(eq(appInvitation.id,invitation.id));
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'app-invitation',aggregateId:invitation.id,eventType:'app-user.invitation.revoked',actor:actorOf(ctx),payload:{email:invitation.email}});
    return createInvitationTx(tx,ctx,{email:invitation.email,role:invitation.role,emailLocale:invitation.emailLocale,companyId:invitation.companyId,personId:invitation.personId},id);
  });
  let outcome='uncertain' as AccountEmailOutcome;
  await attemptAccountEmail(created.deliveryId,created.leaseToken,provider,created.token,status=>{outcome=status;});
  return {deliveryId:created.deliveryId,outcome};
}

/** What one invitation email attempt ended as (core/account-email.ts attemptAccountEmail onResult). */
export type AccountEmailOutcome='sent'|'failed'|'skipped'|'uncertain';
/** Why a batch invitation was not created for a person (board 0735d1b7). Stable codes, translated by the screen. */
export const ACTIVATION_INVITE_SKIPS=['notCandidate','hasLogin','alreadyInvited','setupInProgress','leftCompany','noEmail','emailInUse'] as const;
export type ActivationInviteSkip=(typeof ACTIVATION_INVITE_SKIPS)[number];
export type ActivationInviteResult={outcome:AccountEmailOutcome;reason?:ActivationInviteSkip|string;deliveryId?:string;invitationId?:string};

/**
 * Board 0735d1b7 — one person of a By Batch Send Invitation job (core/account-invitation-batch-job.ts). In ONE
 * transaction, under the same group-admin check and exclusive Access lock as a single invitation, the person's
 * eligibility is checked again (it may have changed since the batch was admitted): still in this tenant, no login,
 * no pending invitation, no manual account setup in progress, not a leaver, a work email, and no other person's
 * login or invitation using that email. Anyone who no longer qualifies is SKIPPED with a reason code, never an
 * error. Otherwise the invitation is created exactly as a single invitation is (createInvitationTx, its audit event
 * carrying the batch job id). The email is attempted after the commit, outside every lock.
 *
 * A re-run of the same person in the same job (the worker crashed after the invitation committed) finds the pending
 * invitation whose invited event names this job and reports it as 'uncertain' with its delivery, without sending
 * again: an uncertain external effect is surfaced, never replayed. Nothing here creates or enables a login.
 */
export async function inviteActivationCandidate(ctx:SessionContext,input:{personId:string;role:string;companyId:string|null;emailLocale:string;batchJobId:string},provider:AuthProvider=defaultProvider):Promise<ActivationInviteResult>{
  const uuidRe=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!uuidRe.test(input.personId)||!uuidRe.test(input.batchJobId))return {outcome:'skipped',reason:'notCandidate'};
  type Created=Awaited<ReturnType<typeof createInvitationTx>>;
  const decided=await withTenant(ctx,async (tx):Promise<{result:ActivationInviteResult}|{created:Created}>=>{
    assertGroupAdmin(ctx);
    await lockAccessConfigurationWriteTx(tx,ctx.tenantId);
    const setup=await manualSetupPersonIdsTx(tx,ctx);
    const [p]=await tx.execute<{email:string;has_login:boolean;own_invitation:string|null;own_delivery:string|null;own_status:string|null;
      pending_invitation:boolean;has_left:boolean;email_in_use:boolean}>(sql`
      select lower(trim(p.primary_email)) as email,
       exists(select 1 from app_user u where u.tenant_id=p.tenant_id and u.person_id=p.id) as has_login,
       own.id as own_invitation,own_d.id as own_delivery,own_d.status::text as own_status,
       exists(select 1 from app_invitation i where i.tenant_id=p.tenant_id and i.person_id=p.id and i.status='pending') as pending_invitation,
       (exists(select 1 from employment e where e.tenant_id=p.tenant_id and e.person_id=p.id) and not exists(select 1 from employment e
         where e.tenant_id=p.tenant_id and e.person_id=p.id and e.blacklisted_at is null
         and (least(e.resignation_date,e.last_working_date,e.terminated_on) is null or current_date<=least(e.resignation_date,e.last_working_date,e.terminated_on)))) as has_left,
       (coalesce(trim(p.primary_email),'')<>'' and (exists(select 1 from app_invitation i where i.tenant_id=p.tenant_id and lower(i.email)=lower(trim(p.primary_email))
          and i.status in ('pending','accepted') and i.person_id is distinct from p.id)
        or exists(select 1 from app_user u join person q on q.id=u.person_id and q.tenant_id=u.tenant_id where u.tenant_id=p.tenant_id
          and lower(trim(q.primary_email))=lower(trim(p.primary_email)) and q.id<>p.id))) as email_in_use
      from person p
      left join lateral (select i.id from app_invitation i join domain_event d on d.tenant_id=i.tenant_id and d.aggregate_type='app-invitation'
        and d.aggregate_id=i.id and d.event_type='app-user.invited' and d.payload->>'batchJobId'=${input.batchJobId}
        where i.tenant_id=p.tenant_id and i.person_id=p.id and i.status='pending' order by i.created_at desc limit 1) own on true
      left join lateral (select d.id,d.status from account_email_delivery d where d.invitation_id=own.id order by d.created_at desc,d.id desc limit 1) own_d on true
      where p.tenant_id=${ctx.tenantId}::uuid and p.id=${input.personId}::uuid`);
    if(!p)return {result:{outcome:'skipped',reason:'notCandidate'} as ActivationInviteResult};
    if(p.own_invitation)return {result:{outcome:'uncertain',invitationId:p.own_invitation,...(p.own_delivery?{deliveryId:p.own_delivery}:{}),
      reason:p.own_status??'pending'} as ActivationInviteResult};
    const skip:ActivationInviteSkip|null=p.has_login?'hasLogin':p.pending_invitation?'alreadyInvited':setup.includes(input.personId)?'setupInProgress'
      :p.has_left?'leftCompany':!p.email||!p.email.includes('@')?'noEmail':p.email_in_use?'emailInUse':null;
    if(skip)return {result:{outcome:'skipped',reason:skip} as ActivationInviteResult};
    const created=await createInvitationTx(tx,ctx,{email:p.email,role:input.role,emailLocale:input.emailLocale,companyId:input.companyId,personId:input.personId},undefined,input.batchJobId);
    return {created};
  });
  if('result' in decided)return decided.result;
  const {created}=decided;
  let outcome='uncertain' as AccountEmailOutcome;
  await attemptAccountEmail(created.deliveryId,created.leaseToken,provider,created.token,status=>{outcome=status;});
  let reason:string|undefined;
  if(outcome==='failed'){
    const [row]=await withTenant(ctx,tx=>tx.select({error:accountEmailDelivery.lastError}).from(accountEmailDelivery).where(eq(accountEmailDelivery.id,created.deliveryId)));
    reason=row?.error??undefined;
  }
  return {outcome,invitationId:created.invitationId,deliveryId:created.deliveryId,...(reason?{reason}:{})};
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
        // Board 0735d1b7: the invitation's own email (one delivery per invitation), joined in the same read.
        deliveryId: accountEmailDelivery.id,
        deliveryStatus: accountEmailDelivery.status,
        deliverySentAt: accountEmailDelivery.sentAt,
      })
      .from(appInvitation)
      .leftJoin(accountEmailDelivery, and(eq(accountEmailDelivery.invitationId, appInvitation.id), eq(accountEmailDelivery.kind, 'invitation')))
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
/** The guard that keeps the group's own admin screen reachable: at least one OTHER group-wide administrator, not
 * already blocked, must remain after the listed logins are switched off. Shared by Archive and the login merge
 * (core/login-merge.ts), inside the caller's transaction under the exclusive Access lock. */
export async function assertGroupAdminRemainsTx(tx: Tx, switchedOff: readonly string[]): Promise<void> {
  const [remaining] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(roleAssignment)
    .innerJoin(appUser, eq(appUser.id, roleAssignment.appUserId))
    .where(
      and(
        isNull(roleAssignment.companyId),
        sql`${roleAssignment.role} in ('super_admin','hr_admin')`,
        switchedOff.length ? notInArray(roleAssignment.appUserId, [...switchedOff]) : sql`true`,
        sql`not app.login_blocked(${appUser.id})`,
      ),
    );
  if (!remaining || remaining.n === 0) {
    throw new Error('This is the last group administrator — archiving it would lock everyone out.');
  }
}

/** The master of a login that is currently merged away (migration 7600), or null. */
export async function activeLoginMergeMasterTx(tx: Tx, appUserId: string): Promise<string | null> {
  const rows = await tx.execute<{ master_app_user_id: string }>(
    sql`select master_app_user_id from app.login_merge_active() where merged_app_user_id=${appUserId}::uuid`,
  );
  return rows[0]?.master_app_user_id ?? null;
}

export async function setAppUserArchived(
  ctx: SessionContext,
  input: { appUserId: string; archived: boolean },
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    assertGroupAdmin(ctx);
    await lockAccessConfigurationWriteTx(tx, ctx.tenantId);
    if (ctx.userId && input.appUserId === ctx.userId) {
      throw new Error('You cannot archive your own login.');
    }
    // Board 0735d1b7 — a login merged away under a master is switched on and off only by Undo merge, which restores
    // its exact earlier state; Archive/Restore would overwrite the archived_at that undo puts back.
    if (await activeLoginMergeMasterTx(tx, input.appUserId)) {
      throw new Error('This login was merged into another login. Use Undo merge on its account page to bring it back.');
    }
    if (input.archived) await assertGroupAdminRemainsTx(tx, [input.appUserId]);
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
    await lockAccessConfigurationWriteTx(tx, ctx.tenantId);
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
  // Consumes a single-use token, so it is never retried; admission only bounds the wait.
  const rows = await withPoolWork('authentication', () => input.issuer ? client<{ app_user_id: string; tenant_id: string }[]>`
    select app_user_id, tenant_id from app.consume_identity_invitation(${input.token},${input.issuer},${input.subject},${input.verifiedEmail ?? null})
  ` : client<{ app_user_id: string; tenant_id: string }[]>`
    select app_user_id, tenant_id from app.consume_invitation(${input.token}, ${input.subject})
  `);
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
  const [delivery]=await withPoolWork('authentication',()=>client<{id:string;lease_token:string}[]>`select * from app.account_email_request_recovery(${email})`);
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
