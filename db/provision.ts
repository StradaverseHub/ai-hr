/**
 * Tenant provisioning — the shared, transaction-scoped module that creates a new customer.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY FUNCTION HERE TAKES AN ALREADY-OPEN `Tx` AND NEVER OPENS ONE.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * That is the whole design. Provisioning is ALL-OR-NOTHING: a half-created customer (a tenant with no
 * company, an admin with no invitation) is worse than no customer at all, and it is not something an
 * operator could clean up from the console. So the caller — scripts/provision-runner.ts, holding the
 * OWNER role via MIGRATION_DATABASE_URL — opens ONE transaction, runs provisionTenant in it, writes the
 * terminal request status in the SAME transaction, and commits. Any throw rolls the lot back.
 *
 * This module therefore NEVER touches the app singleton (`withTenant` from db/client). It cannot: the
 * singleton connects as ai_hr_app, which migration 0001 forbids from inserting a tenant at all, and a
 * second connection could not see the owner transaction's uncommitted rows anyway. The two catalog
 * seeders it calls (seedPayrollCycleCatalog / seedProfileOptions) were hard-bound to that singleton and
 * grew an injected-handle parameter for exactly this reason.
 *
 * WHAT IS SHARED WITH THE DEMO SEED, AND WHAT IS NOT
 * -------------------------------------------------
 * db/seed.ts calls seedTenantCatalogs / seedCompanyCatalogs / createAdminChain — the CATALOG and
 * ADMIN-CHAIN layers — so a real customer and the demo cannot drift apart on starter settings. It does
 * NOT call provisionTenant, and provisionTenant grows no demo knobs (no parent-company option, no
 * multi-approval, no statutory numbers, no demo people or transactions). The demo keeps its fixed ids,
 * its two-company ADR-0009 structure and its sample data entirely to itself. Sharing the layer, not the
 * whole path, is what keeps this function honest about what a real starter customer contains.
 */
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Tx } from './client';
import { appendEvent } from './events';
import {
  appInvitation,
  appUser,
  attendancePolicy,
  company,
  holiday,
  leaveType,
  person,
  roleAssignment,
  tenant,
} from './schema';
import { myPack } from '../localization/my';
import { MY_STATE_HOLIDAYS_2026 } from '../localization/my/holidays';
import { seedPayrollCycleCatalog } from '../core/payroll-cycle';
import { seedProfileOptions } from '../core/profile-options';
import { seedGuides } from './seed-guides';

/** Mirrors core/auth.ts INVITE_TTL_DAYS and scripts/auth/bootstrap-invite.ts — one invitation lifetime. */
export const INVITE_TTL_DAYS = 7;

/**
 * The fixed provisioning step list, as a static code-side descriptor array (the core/job-run JOBS
 * idiom). The UI renders these statically while a request is running and highlights `current_step` on
 * failure — which is why the DB stores only the failing step and never a progress log: provisioning
 * finishes in seconds inside a one-minute tick, so a 5s poll would never observe an intermediate step,
 * and a step written on a second connection would describe rows that may still roll back.
 *
 * `i18nKey` is the step key with dots avoided entirely — a dot is a namespace separator in next-intl
 * message keys, so 'seed-catalogs' resolves as a leaf while 'seed.catalogs' would resolve as an object.
 */
export const PROVISION_STEPS = [
  { key: 'tenant', i18nKey: 'tenant' },
  { key: 'company', i18nKey: 'company' },
  { key: 'catalogs', i18nKey: 'catalogs' },
  { key: 'guides', i18nKey: 'guides' },
  { key: 'admin', i18nKey: 'admin' },
  { key: 'invitation', i18nKey: 'invitation' },
] as const;

export type ProvisionStep = (typeof PROVISION_STEPS)[number]['key'];

/**
 * A failure tagged with the step that produced it, so the console can say WHICH part failed rather than
 * surfacing a bare Postgres message. The runner unwraps this to fill current_step + error.
 */
export class ProvisionStepError extends Error {
  constructor(
    readonly step: ProvisionStep,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ProvisionStepError';
  }
}

/** Run one provisioning phase, tagging any throw with its step. */
async function step<T>(key: ProvisionStep, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof ProvisionStepError ? e : new ProvisionStepError(key, e);
  }
}

/**
 * TENANT-WIDE starter catalogs: the Malaysian statutory leave types, the national + state public
 * holiday calendar, and the personnel-profile dropdown catalogs. All three are tenant-scoped tables
 * (leave_type / holiday / profile_option carry a tenant_id and NO company_id), so this runs ONCE per
 * customer no matter how many companies it has.
 *
 * Split from seedCompanyCatalogs for that reason and no other: calling a combined function per company
 * would duplicate every leave type and every public holiday on the second company, since neither table
 * has a uniqueness constraint to absorb it. The demo seed, which creates two companies, is precisely
 * the caller that would have hit it.
 *
 * Returns the leave-type ids by code, because callers need them immediately (the demo opts specific
 * types into per-date approval; a real customer's standing grants key off the same codes).
 */
export async function seedTenantCatalogs(tx: Tx, tenantId: string): Promise<Record<string, string>> {
  const leaveTypeIds: Record<string, string> = {};
  for (const lt of myPack.leave.types) {
    const [row] = await tx
      .insert(leaveType)
      .values({
        tenantId,
        code: lt.code,
        name: lt.name,
        paid: lt.paid,
        counting: lt.counting,
        eligibility: lt.eligibility ?? null,
        requiresDocument: lt.requiresDocument ?? false,
        sendToPayroll: lt.sendToPayroll ?? !lt.paid,
        i18n: lt.i18n ?? null,
      })
      .returning({ id: leaveType.id });
    leaveTypeIds[lt.code] = row.id;
  }

  // National (state null = applies everywhere) then the state-specific subset (ADR-0038 2C).
  for (const h of myPack.holidays) {
    await tx.insert(holiday).values({ tenantId, country: 'MY', state: null, holidayDate: h.date, name: h.name });
  }
  for (const h of MY_STATE_HOLIDAYS_2026) {
    await tx
      .insert(holiday)
      .values({ tenantId, country: 'MY', state: h.state ?? null, holidayDate: h.date, name: h.name });
  }

  // Profile dropdown catalogs (religion / race / nationality / state / country / relationship).
  // ctx carries only the tenant id: the injected handle is what the seeder actually writes through, and
  // actorOf() with no userId yields a 'system' actor, which is what a provisioning run is.
  await seedProfileOptions({ tenantId }, tx);

  return leaveTypeIds;
}

/**
 * PER-COMPANY starter config: the default attendance policy (all columns defaulted — 09:00-18:00,
 * Mon-Fri) and the payroll cycle catalog. Called once per company, by both this module and the demo.
 */
export async function seedCompanyCatalogs(tx: Tx, tenantId: string, companyId: string): Promise<void> {
  await tx.insert(attendancePolicy).values({ tenantId, companyId });
  await seedPayrollCycleCatalog({ tenantId }, companyId, tx);
}

export type AdminChain = { personId: string; appUserId: string };

/**
 * The back-office admin identity: a person and an app_user, and NOTHING ELSE.
 *
 * NO EMPLOYMENT ROW, deliberately (reporter decision, 2026-07-21). Two things follow, both wanted:
 *   • Headcount and payroll start at a true zero — this login is not a member of staff.
 *   • The login is never auto-blocked. app.login_blocked (0279) blocks a user whose person HAS
 *     employments and none of them is still open; a person with ZERO employment rows fails that
 *     EXISTS check and is never blocked. An employment-less admin is the one shape that is safe here.
 *     test/operator-provision.test.ts pins both halves of that predicate.
 *
 * `workosUserId` is a UUID-based placeholder (`provision:<uuid>`), NEVER derived from the email.
 * app_user.workos_user_id carries a GLOBAL unique index (0151) with no tenant dimension, so an
 * email-derived placeholder would collide the instant the same address were used again — and it would
 * collide at INSERT time inside the provisioning transaction, i.e. as an opaque 23505 rather than the
 * friendly "one login, one customer" message the runner's pre-check produces.
 *
 * `withRoleAssignment` defaults to FALSE, which is the non-obvious half of this function:
 *   • provisioning passes false. app.consume_invitation (0151/0281) UNCONDITIONALLY inserts a
 *     role_assignment when the invitation is consumed, and role_assignment has no uniqueness on
 *     (app_user_id, role, company_id) — so pre-creating the grant here would leave the activated admin
 *     holding TWO identical group-wide hr_admin rows. The test asserts exactly one, post-activation.
 *   • the demo seed passes true, because it mints no invitation and nothing else would grant the role.
 */
export async function createAdminChain(
  tx: Tx,
  tenantId: string,
  opts: {
    email: string;
    fullName?: string;
    withRoleAssignment?: boolean;
    /** Demo seed only: pin the app_user id (DEV_ADMIN_USER_ID) the dev switcher resolves. */
    appUserId?: string;
    /** Demo seed only: pin the placeholder subject ('user_dev_admin'). Provisioning never sets this —
     *  see the uuid-placeholder note above, which is a correctness requirement, not a default. */
    workosUserId?: string;
  },
): Promise<AdminChain> {
  const email = opts.email.trim().toLowerCase();
  const [p] = await tx
    .insert(person)
    .values({ tenantId, fullName: opts.fullName ?? adminDisplayName(email), primaryEmail: email })
    .returning({ id: person.id });

  const [u] = await tx
    .insert(appUser)
    .values({
      ...(opts.appUserId ? { id: opts.appUserId } : {}),
      tenantId,
      workosUserId: opts.workosUserId ?? `provision:${crypto.randomUUID()}`,
      personId: p.id,
    })
    .returning({ id: appUser.id });

  if (opts.withRoleAssignment) {
    await tx.insert(roleAssignment).values({ tenantId, appUserId: u.id, companyId: null, role: 'hr_admin' });
  }

  return { personId: p.id, appUserId: u.id };
}

/**
 * A readable display name from an email local part: `siti.rahman@acme.com` → "Siti Rahman". Falls back
 * to "HR Admin" for anything that does not yield letters. Cosmetic only — the admin renames themselves
 * once they are in — but it beats showing a raw address in the audit trail.
 */
function adminDisplayName(email: string): string {
  const local = email.split('@')[0] ?? '';
  const words = local
    .split(/[._-]+/)
    .filter((w) => /[a-z]/i.test(w))
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return words.length ? words.join(' ') : 'HR Admin';
}

/** sha256(raw) hex — the only form of an invitation token that is ever persisted (core/auth.ts rule). */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Mint the first admin's one-time activation invitation, exactly as scripts/auth/bootstrap-invite.ts
 * does — same 32-byte base64url token, same sha256-only storage, same person_id binding so that
 * app.consume_invitation takes its REBIND branch (`UPDATE app_user SET workos_user_id = <real subject>`)
 * and the provisioned app_user keeps its id rather than a duplicate being created.
 *
 * Returns the RAW url to the caller and to nobody else: it is never logged, never in the domain event
 * payload, and the runner writes it to a column the app role cannot read.
 */
async function mintActivationInvitation(
  tx: Tx,
  tenantId: string,
  args: { email: string; personId: string; baseUrl: string },
): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  const [inv] = await tx
    .insert(appInvitation)
    .values({
      tenantId,
      companyId: null,
      email: args.email,
      role: 'hr_admin',
      personId: args.personId,
      tokenHash: hashToken(raw),
      status: 'pending',
      expiresAt: sql`now() + (${INVITE_TTL_DAYS} || ' days')::interval`,
      createdBy: null,
    })
    .returning({ id: appInvitation.id });

  // Substrate discipline: the state change and its audit record commit together. Actor is 'system' —
  // provisioning runs out-of-band with no session. The raw token is deliberately NOT in the payload.
  await appendEvent(tx, {
    tenantId,
    aggregateType: 'app-invitation',
    aggregateId: inv.id,
    eventType: 'app-user.invited',
    actor: { type: 'system' },
    payload: { email: args.email, role: 'hr_admin', companyId: null, personId: args.personId, via: 'provision' },
  });

  const base = args.baseUrl.replace(/\/$/, '');
  return base ? `${base}/invite/${raw}` : `/invite/${raw}`;
}

export type ProvisionInput = { name: string; adminEmail: string; baseUrl?: string };
export type ProvisionResult = {
  tenantId: string;
  companyId: string;
  personId: string;
  appUserId: string;
  /** The raw one-time /invite/<token> URL. Returned to the caller ONLY; never logged. */
  activationUrl: string;
};

/**
 * Create one complete starter customer inside the caller's transaction.
 *
 * Contents are fixed (reporter decision, 2026-07-21): ONE company named after the customer (MY, MYR),
 * the Malaysian statutory leave types, national + state public holidays, the payroll cycle catalog, the
 * profile-option catalogs, and the built-in help guides. No demo people, no demo transactions.
 *
 * `workosOrgId` is a unique placeholder (`org_pending_<uuid>`). Linking each customer to a real WorkOS
 * organization is documented future work: sign-in resolves per USER today (app.principal_by_subject),
 * so this column is inert and a placeholder breaks nothing. It is unique because the column is, and
 * because a shared constant would make the second customer fail on the unique index.
 */
export async function provisionTenant(tx: Tx, input: ProvisionInput): Promise<ProvisionResult> {
  const name = input.name.trim();
  const adminEmail = input.adminEmail.trim().toLowerCase();
  const baseUrl = input.baseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? '';

  const tenantId = await step('tenant', async () => {
    const [t] = await tx
      .insert(tenant)
      .values({ workosOrgId: `org_pending_${crypto.randomUUID()}`, name })
      .returning({ id: tenant.id });
    return t.id;
  });

  const companyId = await step('company', async () => {
    const [c] = await tx
      .insert(company)
      .values({ tenantId, legalName: name, country: 'MY', currency: 'MYR' })
      .returning({ id: company.id });
    return c.id;
  });

  await step('catalogs', async () => {
    await seedTenantCatalogs(tx, tenantId);
    await seedCompanyCatalogs(tx, tenantId, companyId);
  });

  await step('guides', async () => {
    await seedGuides(tx, tenantId);
  });

  const chain = await step('admin', () =>
    createAdminChain(tx, tenantId, { email: adminEmail, withRoleAssignment: false }),
  );

  const activationUrl = await step('invitation', () =>
    mintActivationInvitation(tx, tenantId, { email: adminEmail, personId: chain.personId, baseUrl }),
  );

  return { tenantId, companyId, personId: chain.personId, appUserId: chain.appUserId, activationUrl };
}
