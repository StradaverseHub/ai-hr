/**
 * Real per-user authentication (ADR-0072). Proves the identity-resolution + invitation + auth-audit
 * seam without a live WorkOS connection — the WorkOS surface is injected as a fake AuthProvider (the
 * same shape resolveDevPrincipal's `lookup` is injected), so tsc / vitest / build never need WorkOS.
 *
 * The RLS/access suite is unaffected by design: it builds SessionContext by hand and calls withTenant()
 * directly, never getSession(); as long as the SessionContext shape + the app.principal contract are
 * unchanged (they are — principal_by_subject WRAPS app.principal and preserves grants), those tests do
 * not see this slice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { client, withTenant, type Grant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { resolveDevPrincipal, resolveWorkosPrincipal } from '../lib/session';
import { AuthRequiredError } from '../lib/auth-errors';
import {
  acceptInvitation,
  inviteUser,
  logout,
  recordLoginFailed,
  type AuthProvider,
} from '../core/auth';
import { hireEmployee } from '../core/org';

const hashToken = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');

/** A fake WorkOS provider — records calls, never touches the SDK. */
function fakeProvider(): AuthProvider & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { sendInvitation: [], revokeInvitation: [], sendPasswordReset: [], endSession: [] };
  return {
    calls,
    sendInvitation: async (email: string) => {
      calls.sendInvitation.push(email);
      return { invitationId: `wos_inv_${email}` };
    },
    revokeInvitation: async (id: string) => {
      calls.revokeInvitation.push(id);
    },
    sendPasswordReset: async (email: string) => {
      calls.sendPasswordReset.push(email);
    },
    endSession: async (returnTo?: string) => {
      calls.endSession.push(returnTo);
    },
  };
}

/** Subject-lookup used by resolveWorkosPrincipal — runs the real SECURITY DEFINER fn on the raw client. */
const subjectLookup = (subject: string) =>
  client<{ app_user_id: string; tenant_id: string; person_id: string | null; grants: Grant[] | null }[]>`
    select app_user_id, tenant_id, person_id, grants from app.principal_by_subject(${subject})
  `;

/** Dev-switcher lookup used by resolveDevPrincipal — the app.principal() path, by internal id. */
const devLookup = (id: string) =>
  client<{ tenant_id: string; person_id: string | null; grants: Grant[] | null }[]>`
    select tenant_id, person_id, grants from app.principal(${id}::uuid)
  `;

async function countAuthEvents(eventType: string): Promise<number> {
  const rows = await owner.db
    .select({ id: schema.domainEvent.id })
    .from(schema.domainEvent)
    .where(eq(schema.domainEvent.eventType, eventType));
  return rows.length;
}

describe('ADR-0072 — real auth (WorkOS AuthKit)', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  // (a) principal_by_subject returns EXACTLY the same SessionContext as the dev switcher for the same
  //     seeded user — DIFF the grants jsonb (and tenantId, personId, roles), not just tenantId/roles.
  it('principal_by_subject yields the identical SessionContext as the dev switcher (grants diffed)', async () => {
    // Give the seeded admin a WorkOS subject.
    await owner.db
      .update(schema.appUser)
      .set({ workosUserId: 'wos_admin_subject' })
      .where(eq(schema.appUser.id, base.adminUserId));

    const viaSwitcher = await resolveDevPrincipal(devLookup, base.adminUserId, undefined);
    const viaWorkos = await resolveWorkosPrincipal(subjectLookup, 'wos_admin_subject');

    // userId must be the INTERNAL app_user.id in both (never the subject string).
    expect(viaWorkos.userId).toBe(base.adminUserId);
    expect(viaSwitcher.userId).toBe(base.adminUserId);
    // The RLS-relevant fields must be byte-identical.
    expect(viaWorkos.tenantId).toBe(viaSwitcher.tenantId);
    expect(viaWorkos.personId).toBe(viaSwitcher.personId);
    expect(viaWorkos.roles).toEqual(viaSwitcher.roles);
    // The core "RLS output identical" gate: diff the grants jsonb.
    expect(viaWorkos.grants).toEqual(viaSwitcher.grants);
    expect(viaWorkos.grants).toEqual([{ role: 'hr_admin', companyId: null }]);
  });

  // (b) userId is the internal uuid, and a withTenant round-trip using it satisfies self-scoped RLS.
  it('the WorkOS-resolved userId satisfies app.current_user_id()-keyed self-scoped RLS', async () => {
    const emp = await hireEmployee(
      { tenantId: base.tenantId, userId: base.adminUserId, roles: ['hr_admin'] },
      {
        person: { fullName: 'Self Scope', primaryEmail: 'self@acme.test' },
        companyId: base.companyId,
        departmentId: base.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      },
    );
    // App user for that person, with a WorkOS subject, role = employee (no admin).
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: 'wos_emp_subject', personId: emp.personId })
      .returning({ id: schema.appUser.id });
    await owner.db.insert(schema.roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, role: 'employee', companyId: null });

    const session = await resolveWorkosPrincipal(subjectLookup, 'wos_emp_subject');
    expect(session.userId).toBe(u.id);

    // Self-scoped read: an employee can see their own employment via can_see_employment (self branch,
    // which is keyed on app.current_user_id()). A subject string in userId would throw on the uuid cast.
    const seen = await withTenant(session, (tx) =>
      tx.select({ id: schema.employment.id }).from(schema.employment).where(eq(schema.employment.id, emp.employmentId)),
    );
    expect(seen.map((r) => r.id)).toContain(emp.employmentId);
  });

  // (c) Invitation is single-use + expiring; two concurrent consumes → exactly one succeeds.
  it('invitation token is single-use, expiring, and atomic under concurrency', async () => {
    const admin: SessionContext = { tenantId: base.tenantId, userId: base.adminUserId, roles: ['hr_admin'] };
    const provider = fakeProvider();

    const { token } = await inviteUser(admin, { email: 'newbie@acme.test', role: 'employee' }, provider);
    expect(provider.calls.sendInvitation).toContain('newbie@acme.test');

    // Two concurrent consumes of the SAME pending token — exactly one wins, the other gets 0 rows.
    const results = await Promise.allSettled([
      acceptInvitation({ token, subject: 'wos_new_1' }),
      acceptInvitation({ token, subject: 'wos_new_2' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);

    // A third consume of the now-accepted token is rejected.
    await expect(acceptInvitation({ token, subject: 'wos_new_3' })).rejects.toThrow();

    // Exactly one app_user was created and bound to the winning subject.
    const users = await owner.db
      .select({ subject: schema.appUser.workosUserId })
      .from(schema.appUser)
      .where(eq(schema.appUser.tenantId, base.tenantId));
    const newSubjects = users.map((u) => u.subject).filter((s) => s.startsWith('wos_new_'));
    expect(newSubjects).toHaveLength(1);

    // Expired token: seed a pending-but-expired invitation and confirm it is rejected.
    const raw = 'expired-token-xyz';
    await owner.db.insert(schema.appInvitation).values({
      tenantId: base.tenantId,
      email: 'late@acme.test',
      role: 'employee',
      tokenHash: hashToken(raw),
      status: 'pending',
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(acceptInvitation({ token: raw, subject: 'wos_late' })).rejects.toThrow();
  });

  // (d) Dev switcher still resolves post-migration (resolveDevPrincipal + app.dev_principals()).
  it('the dev identity switcher still resolves after the auth migration', async () => {
    const session = await resolveDevPrincipal(devLookup, base.adminUserId, undefined);
    expect(session.tenantId).toBe(base.tenantId);
    expect(session.roles).toEqual(['hr_admin']);

    const principals = await client<{ user_id: string; name: string; roles: string[] }[]>`
      select user_id, name, roles from app.dev_principals()
    `;
    expect(principals.some((p) => p.user_id === base.adminUserId)).toBe(true);
  });

  // (e) Wrong password / un-invited email is rejected AND app-user.login-failed is written via the
  //     SECURITY DEFINER auth-audit path (proves pre-auth audit works despite domain_event RLS).
  it('a failed login on an un-invited email is audited via the pre-auth auth-audit writer', async () => {
    const before = await countAuthEvents('app-user.login-failed');
    await recordLoginFailed({ email: 'nobody@nowhere.test' });
    const after = await countAuthEvents('app-user.login-failed');
    expect(after).toBe(before + 1);

    // The event lives under the reserved system tenant (no real tenant, no subjectEmploymentId → admin-only).
    const rows = await owner.db
      .select({ tenantId: schema.domainEvent.tenantId, subject: schema.domainEvent.subjectEmploymentId, actorType: schema.domainEvent.actorType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'app-user.login-failed'));
    expect(rows[0].tenantId).toBe('00000000-0000-0000-0000-000000000000');
    expect(rows[0].subject).toBeNull();
    expect(rows[0].actorType).toBe('external');
  });

  // (f) Session resolution failure modes: missing session, offboarded subject → AuthRequiredError.
  it('fails closed to AuthRequiredError when a subject maps to no app_user (offboarded / unknown)', async () => {
    // Offboarded / never-invited subject → 0 rows → AuthRequiredError (never a stale resolve, never 500).
    await expect(resolveWorkosPrincipal(subjectLookup, 'wos_unknown_subject')).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
    // An empty lookup (models a valid cookie whose user was deleted) → same fail-closed behaviour.
    await expect(resolveWorkosPrincipal(async () => [], 'any')).rejects.toBeInstanceOf(AuthRequiredError);
  });

  // (g) Logout appends app-user.logged-out AND clears/revokes the WorkOS cookie (via the provider).
  it('logout appends app-user.logged-out and revokes the WorkOS session', async () => {
    const provider = fakeProvider();
    const before = await countAuthEvents('app-user.logged-out');
    await logout({ tenantId: base.tenantId, userId: base.adminUserId }, provider, '/login');
    const after = await countAuthEvents('app-user.logged-out');
    expect(after).toBe(before + 1);
    expect(provider.calls.endSession).toEqual(['/login']);
  });

  // (h) A user with ZERO role_assignments (empty grants) still gets a valid session (matches the
  //     dev switcher's null-grants tolerance in session.test.ts).
  it('a user with no role assignments still resolves to a valid (empty-grants) session', async () => {
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: 'wos_norole', personId: null })
      .returning({ id: schema.appUser.id });
    const session = await resolveWorkosPrincipal(subjectLookup, 'wos_norole');
    expect(session.userId).toBe(u.id);
    expect(session.tenantId).toBe(base.tenantId);
    expect(session.grants).toEqual([]);
    expect(session.roles).toEqual([]);
  });

  // Global uniqueness: one WorkOS subject = one app_user (the /select-tenant cut is enforced in-DB).
  it('workos_user_id is globally unique — the same subject cannot map to two app_users', async () => {
    await owner.db.insert(schema.appUser).values({ tenantId: base.tenantId, workosUserId: 'wos_dupe', personId: null });
    await expect(
      owner.db.insert(schema.appUser).values({ tenantId: base.tenantId, workosUserId: 'wos_dupe', personId: null }),
    ).rejects.toThrow();
  });
});
