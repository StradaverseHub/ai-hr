/**
 * Tenant provisioning (0294/0295) — what a click-to-provision customer actually contains, and the
 * invariants that make the activation handshake work.
 *
 * The assertions here are deliberately written against the SOURCE CONSTANTS (myPack.leave.types,
 * MY_STATE_HOLIDAYS_2026, DEFAULT_PAYROLL_CYCLES, DEFAULT_PROFILE_OPTIONS) rather than hard-coded
 * counts. A hard-coded 14 would go red the day someone legitimately adds a leave type, teaching the
 * next person to edit the number instead of thinking; comparing against the pack asserts the real
 * property — "a new customer gets the whole Malaysian starter pack, whatever it currently is".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { inviteUser } from '../core/auth';
import { provisionTenant, createAdminChain, PROVISION_STEPS } from '../db/provision';
import { runProvisionTick } from '../scripts/provision-runner';
import { myPack } from '../localization/my';
import { MY_STATE_HOLIDAYS_2026 } from '../localization/my/holidays';
import { DEFAULT_PAYROLL_CYCLES } from '../core/payroll-cycle';
import { DEFAULT_PROFILE_OPTIONS } from '../core/profile-options';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';

/** Provision into a committed transaction and hand back the result. */
async function provision(name: string, email: string) {
  return owner.db.transaction((tx) => provisionTenant(tx, { name, adminEmail: email, baseUrl: 'https://hr.test' }));
}

describe('0295 — tenant provisioning', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeAll();
  });

  // ── (a) What a starter customer contains ────────────────────────────────────────────────────────

  it('creates one company and the full Malaysian starter catalog set', async () => {
    const r = await provision('Nusantara Foods Sdn Bhd', 'ops@nusantara.test');

    const companies = await owner.db
      .select()
      .from(schema.company)
      .where(eq(schema.company.tenantId, r.tenantId));
    expect(companies).toHaveLength(1);
    expect(companies[0].legalName).toBe('Nusantara Foods Sdn Bhd');
    expect(companies[0].country).toBe('MY');
    expect(companies[0].currency).toBe('MYR');
    // ONE company, flat: no holding/parent structure. That is the demo's shape, not a customer's.
    expect(companies[0].parentCompanyId).toBeNull();

    const leaveTypes = await owner.db
      .select({ code: schema.leaveType.code })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.tenantId, r.tenantId));
    expect(leaveTypes.map((l) => l.code).sort()).toEqual(myPack.leave.types.map((t) => t.code).sort());

    const holidays = await owner.db
      .select({ id: schema.holiday.id, state: schema.holiday.state })
      .from(schema.holiday)
      .where(eq(schema.holiday.tenantId, r.tenantId));
    expect(holidays).toHaveLength(myPack.holidays.length + MY_STATE_HOLIDAYS_2026.length);
    // Both axes present: national days (state null) and the state-specific subset.
    expect(holidays.filter((h) => h.state === null)).toHaveLength(myPack.holidays.length);

    const cycles = await owner.db
      .select({ name: schema.payrollCycle.name })
      .from(schema.payrollCycle)
      .where(eq(schema.payrollCycle.tenantId, r.tenantId));
    expect(cycles.map((c) => c.name).sort()).toEqual(DEFAULT_PAYROLL_CYCLES.map((c) => c.name).sort());

    const options = await owner.db
      .select({ id: schema.profileOption.id })
      .from(schema.profileOption)
      .where(eq(schema.profileOption.tenantId, r.tenantId));
    expect(options).toHaveLength(DEFAULT_PROFILE_OPTIONS.length);

    const policies = await owner.db
      .select({ companyId: schema.attendancePolicy.companyId })
      .from(schema.attendancePolicy)
      .where(eq(schema.attendancePolicy.tenantId, r.tenantId));
    expect(policies).toEqual([{ companyId: r.companyId }]);

    const guides = await owner.db
      .select({ id: schema.kbDocument.id })
      .from(schema.kbDocument)
      .where(eq(schema.kbDocument.tenantId, r.tenantId));
    expect(guides.length).toBeGreaterThan(0);
  });

  it('starts the customer at zero headcount: the first admin has NO employment and NO transactions', async () => {
    const r = await provision('Zero Start Bhd', 'boss@zerostart.test');

    // The reporter's decision, pinned: back-office login only.
    const employments = await owner.db
      .select({ id: schema.employment.id })
      .from(schema.employment)
      .where(eq(schema.employment.tenantId, r.tenantId));
    expect(employments).toHaveLength(0);

    // Exactly one person (the admin) and one app_user — no demo people came along for the ride.
    const people = await owner.db
      .select({ id: schema.person.id, email: schema.person.primaryEmail })
      .from(schema.person)
      .where(eq(schema.person.tenantId, r.tenantId));
    expect(people).toHaveLength(1);
    expect(people[0].email).toBe('boss@zerostart.test');

    const users = await owner.db
      .select({ id: schema.appUser.id, subject: schema.appUser.workosUserId, personId: schema.appUser.personId })
      .from(schema.appUser)
      .where(eq(schema.appUser.tenantId, r.tenantId));
    expect(users).toHaveLength(1);
    expect(users[0].personId).toBe(r.personId);

    // The placeholder subject is UUID-based, NEVER email-derived: app_user.workos_user_id has a GLOBAL
    // unique index (0151), so an email-derived placeholder collides the moment the address is reused.
    expect(users[0].subject).toMatch(/^provision:[0-9a-f-]{36}$/);
    expect(users[0].subject).not.toContain('zerostart');
  });

  it('creates NO role_assignment before activation (consume_invitation inserts the only one)', async () => {
    const r = await provision('Pre Grant Bhd', 'admin@pregrant.test');
    const grants = await owner.db
      .select({ id: schema.roleAssignment.id })
      .from(schema.roleAssignment)
      .where(eq(schema.roleAssignment.tenantId, r.tenantId));
    expect(grants).toHaveLength(0);
  });

  it('stores only the invitation HASH — the raw token exists solely in the returned URL', async () => {
    const r = await provision('Hash Only Bhd', 'admin@hashonly.test');
    const token = r.activationUrl.split('/invite/')[1];
    expect(token).toBeTruthy();
    expect(r.activationUrl.startsWith('https://hr.test/invite/')).toBe(true);

    const [inv] = await owner.db
      .select()
      .from(schema.appInvitation)
      .where(eq(schema.appInvitation.tenantId, r.tenantId));
    expect(inv.role).toBe('hr_admin');
    expect(inv.companyId).toBeNull(); // group-wide
    expect(inv.personId).toBe(r.personId); // the REBIND binding
    expect(inv.status).toBe('pending');
    // The stored value is the sha256, and the raw token appears nowhere in the row.
    expect(inv.tokenHash).toHaveLength(64);
    expect(inv.tokenHash).not.toBe(token);
    expect(JSON.stringify(inv)).not.toContain(token);

    // Nor in the audit trail — appendEvent deliberately omits it.
    const events = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.tenantId, r.tenantId));
    expect(JSON.stringify(events)).not.toContain(token);
    expect(events.some((e) => JSON.stringify(e.payload).includes('provision'))).toBe(true);
  });

  // ── (b) The activation handshake ────────────────────────────────────────────────────────────────

  it('activation REBINDS the provisioned app_user and yields EXACTLY ONE group-wide hr_admin grant', async () => {
    const r = await provision('Rebind Bhd', 'admin@rebind.test');
    const token = r.activationUrl.split('/invite/')[1];

    const rows = await owner.client<{ app_user_id: string; tenant_id: string }[]>`
      select app_user_id, tenant_id from app.consume_invitation(${token}, ${'wos_real_subject_rebind'})
    `;
    // Same app_user id — rebound, not duplicated. This is the property the person_id binding buys.
    expect(rows[0].app_user_id).toBe(r.appUserId);
    expect(rows[0].tenant_id).toBe(r.tenantId);

    const [u] = await owner.db
      .select({ subject: schema.appUser.workosUserId })
      .from(schema.appUser)
      .where(eq(schema.appUser.id, r.appUserId));
    expect(u.subject).toBe('wos_real_subject_rebind');

    const users = await owner.db
      .select({ id: schema.appUser.id })
      .from(schema.appUser)
      .where(eq(schema.appUser.tenantId, r.tenantId));
    expect(users).toHaveLength(1); // no second identity was created

    // EXACTLY ONE grant. This is what skipping the pre-created role_assignment buys: consume_invitation
    // inserts unconditionally and role_assignment has no uniqueness on (app_user_id, role, company_id),
    // so pre-creating it would leave the activated admin holding two identical grants.
    const grants = await owner.db
      .select({ role: schema.roleAssignment.role, companyId: schema.roleAssignment.companyId })
      .from(schema.roleAssignment)
      .where(eq(schema.roleAssignment.tenantId, r.tenantId));
    expect(grants).toEqual([{ role: 'hr_admin', companyId: null }]);
  });

  it('the token is single-use: a second consume yields no rows', async () => {
    const r = await provision('Single Use Bhd', 'admin@singleuse.test');
    const token = r.activationUrl.split('/invite/')[1];
    await owner.client`select app_user_id from app.consume_invitation(${token}, ${'wos_first'})`;
    const second = await owner.client`select app_user_id from app.consume_invitation(${token}, ${'wos_second'})`;
    expect(second).toHaveLength(0);
  });

  // ── (c) 0279 regression: the employment-less admin must not be login-blocked ─────────────────────

  it('0279: the fresh no-employment admin is NOT login-blocked, but a fully-ended login IS', async () => {
    const r = await provision('Login Gate Bhd', 'admin@logingate.test');
    const [fresh] = await owner.client<{ blocked: boolean }[]>`
      select app.login_blocked(${r.appUserId}::uuid) as blocked
    `;
    // A person with ZERO employment rows fails login_blocked's EXISTS check and is never blocked.
    // This is exactly why createAdminChain creates no employment — the two decisions are coupled.
    expect(fresh.blocked).toBe(false);

    // The other half of the predicate, so this test proves a behaviour rather than an absence: a login
    // whose every employment has ended IS blocked.
    const base: Base = await seedBase();
    const adminCtx: SessionContext = { tenantId: base.tenantId, userId: base.adminUserId, roles: ['hr_admin'] };
    const emp = await hireEmployee(adminCtx, {
      person: { fullName: 'Left Already', primaryEmail: 'left@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });
    const [leaver] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: 'wos_leaver', personId: emp.personId })
      .returning({ id: schema.appUser.id });
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2021-01-01' })
      .where(eq(schema.employment.id, emp.employmentId));

    const [blocked] = await owner.client<{ blocked: boolean }[]>`
      select app.login_blocked(${leaver.id}::uuid) as blocked
    `;
    expect(blocked.blocked).toBe(true);
  });

  // ── (f) All-or-nothing ──────────────────────────────────────────────────────────────────────────

  it('a failing step rolls back EVERYTHING and records the step + error; re-submitting then succeeds', async () => {
    // Fault injection with a real DB failure at a known step: a CHECK constraint that rejects one
    // sentinel company name. This exercises the true production path — ProvisionStepError tagging,
    // the rollback, and markFailed's separate transaction — rather than a hand-rolled throw.
    await owner.db.execute(
      sql`alter table company add constraint tmp_provision_fault check (legal_name <> 'Doomed Bhd')`,
    );

    const [req] = await owner.db
      .insert(schema.tenantProvisionRequest)
      .values({ customerName: 'Doomed Bhd', adminEmail: 'admin@doomed.test' })
      .returning({ id: schema.tenantProvisionRequest.id });

    await runProvisionTick(owner);

    const [failed] = await owner.db
      .select()
      .from(schema.tenantProvisionRequest)
      .where(eq(schema.tenantProvisionRequest.id, req.id));
    expect(failed.status).toBe('failed');
    // The step comes from the code-side descriptor array, so the console can name what broke.
    expect(failed.currentStep).toBe('company');
    expect(PROVISION_STEPS.map((s) => s.key)).toContain(failed.currentStep);
    expect(failed.error).toBeTruthy();
    expect(failed.tenantId).toBeNull();
    expect(failed.activationUrl).toBeNull();

    // NOTHING half-created survives — not the tenant that had already been inserted before the company
    // step ran. This is the property the single owner transaction exists to guarantee.
    expect(await owner.db.select({ id: schema.tenant.id }).from(schema.tenant)).toHaveLength(1); // system tenant only
    expect(await owner.db.select({ id: schema.company.id }).from(schema.company)).toHaveLength(0);
    expect(await owner.db.select({ id: schema.person.id }).from(schema.person)).toHaveLength(0);

    // Retry is just a fresh request with the same details — and it works, with no duplicate left over.
    await owner.db.execute(sql`alter table company drop constraint tmp_provision_fault`);
    await owner.db
      .insert(schema.tenantProvisionRequest)
      .values({ customerName: 'Doomed Bhd', adminEmail: 'admin@doomed.test' });
    await runProvisionTick(owner);

    const rows = await owner.db.select().from(schema.tenantProvisionRequest);
    expect(rows.filter((r) => r.status === 'done')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'failed')).toHaveLength(1);
    const tenants = await owner.db.select({ name: schema.tenant.name }).from(schema.tenant);
    expect(tenants.filter((t) => t.name === 'Doomed Bhd')).toHaveLength(1);
  });

  // ── (h) One login, one customer ─────────────────────────────────────────────────────────────────

  it('refuses an admin email that already has a login in ANY tenant, with a friendly error', async () => {
    const first = await provision('First Customer Bhd', 'shared@both.test');
    expect(first.tenantId).toBeTruthy();

    const [req] = await owner.db
      .insert(schema.tenantProvisionRequest)
      .values({ customerName: 'Second Customer Bhd', adminEmail: 'shared@both.test' })
      .returning({ id: schema.tenantProvisionRequest.id });
    await runProvisionTick(owner);

    const [row] = await owner.db
      .select()
      .from(schema.tenantProvisionRequest)
      .where(eq(schema.tenantProvisionRequest.id, req.id));
    expect(row.status).toBe('failed');
    expect(row.error).toContain('only one customer');
    // The cross-tenant collision is caught BEFORE anything is created, not after a "successful" run.
    expect(row.tenantId).toBeNull();
    const tenants = await owner.db.select({ name: schema.tenant.name }).from(schema.tenant);
    expect(tenants.filter((t) => t.name === 'Second Customer Bhd')).toHaveLength(0);
  });

  it('refuses an admin email that has a live pending invitation', async () => {
    await provision('Invite Holder Bhd', 'pending@holder.test');
    await owner.db
      .insert(schema.tenantProvisionRequest)
      .values({ customerName: 'Another Bhd', adminEmail: 'pending@holder.test' });
    await runProvisionTick(owner);
    const [row] = await owner.db
      .select()
      .from(schema.tenantProvisionRequest)
      .where(eq(schema.tenantProvisionRequest.customerName, 'Another Bhd'));
    expect(row.status).toBe('failed');
    expect(row.error).toContain('only one customer');
  });

  // ── (g) Stale reclaim ───────────────────────────────────────────────────────────────────────────

  it('reclaims a request abandoned by a killed runner instead of leaving an eternal spinner', async () => {
    const [req] = await owner.db
      .insert(schema.tenantProvisionRequest)
      .values({
        customerName: 'Abandoned Bhd',
        adminEmail: 'admin@abandoned.test',
        status: 'running',
        claimedAt: sql`now() - interval '30 minutes'`,
      })
      .returning({ id: schema.tenantProvisionRequest.id });

    await runProvisionTick(owner);

    const [row] = await owner.db
      .select()
      .from(schema.tenantProvisionRequest)
      .where(eq(schema.tenantProvisionRequest.id, req.id));
    expect(row.status).toBe('failed');
    expect(row.error).toBe('provisioning interrupted, submit again');
  });

  it('does NOT reclaim a request claimed moments ago', async () => {
    const [req] = await owner.db
      .insert(schema.tenantProvisionRequest)
      .values({
        customerName: 'In Flight Bhd',
        adminEmail: 'admin@inflight.test',
        status: 'running',
        claimedAt: new Date(),
      })
      .returning({ id: schema.tenantProvisionRequest.id });
    await runProvisionTick(owner);
    const [row] = await owner.db
      .select()
      .from(schema.tenantProvisionRequest)
      .where(eq(schema.tenantProvisionRequest.id, req.id));
    expect(row.status).toBe('running');
  });

  // ── (k) Reissue ─────────────────────────────────────────────────────────────────────────────────

  it('reissue mints a fresh usable link and kills the old token', async () => {
    const [req] = await owner.db
      .insert(schema.tenantProvisionRequest)
      .values({ customerName: 'Lost Link Bhd', adminEmail: 'admin@lostlink.test' })
      .returning({ id: schema.tenantProvisionRequest.id });
    await runProvisionTick(owner);

    const [done] = await owner.db
      .select()
      .from(schema.tenantProvisionRequest)
      .where(eq(schema.tenantProvisionRequest.id, req.id));
    expect(done.status).toBe('done');
    const oldToken = done.activationUrl!.split('/invite/')[1];

    // The operator reveals it (nulling the column), then loses it and asks for a reissue.
    await owner.db
      .update(schema.tenantProvisionRequest)
      .set({ activationUrl: null, reissueRequestedAt: new Date() })
      .where(eq(schema.tenantProvisionRequest.id, req.id));

    await runProvisionTick(owner);

    const [reissued] = await owner.db
      .select()
      .from(schema.tenantProvisionRequest)
      .where(eq(schema.tenantProvisionRequest.id, req.id));
    expect(reissued.activationUrl).toBeTruthy();
    expect(reissued.reissueRequestedAt).toBeNull(); // flag cleared, so it does not re-fire every tick
    const newToken = reissued.activationUrl!.split('/invite/')[1];
    expect(newToken).not.toBe(oldToken);

    // The OLD token is dead (its invitation was revoked) …
    const oldTry = await owner.client`select app_user_id from app.consume_invitation(${oldToken}, ${'wos_old'})`;
    expect(oldTry).toHaveLength(0);

    // … and the NEW one still rebinds the original app_user, with exactly one grant.
    const newTry = await owner.client<{ app_user_id: string }[]>`
      select app_user_id from app.consume_invitation(${newToken}, ${'wos_new'})
    `;
    expect(newTry).toHaveLength(1);
    const grants = await owner.db
      .select({ role: schema.roleAssignment.role })
      .from(schema.roleAssignment)
      .where(eq(schema.roleAssignment.tenantId, done.tenantId!));
    expect(grants).toEqual([{ role: 'hr_admin' }]);
  });

  // ── (j) The operator role is not invitable ──────────────────────────────────────────────────────

  it('inviteUser rejects role "operator" — the tier cannot be handed out from the users screen', async () => {
    const base = await seedBase();
    const adminCtx: SessionContext = {
      tenantId: base.tenantId,
      userId: base.adminUserId,
      roles: ['hr_admin'],
      grants: [{ role: 'hr_admin', companyId: null }],
    };
    await expect(
      inviteUser(adminCtx, { email: 'sneaky@acme.test', role: 'operator' }),
    ).rejects.toThrow(/Unknown role/);
  });

  // ── The shared catalog layer is the same code the demo seed runs ────────────────────────────────

  it('createAdminChain with a role assignment is the demo shape (one grant, still no employment)', async () => {
    const [t] = await owner.db
      .insert(schema.tenant)
      .values({ workosOrgId: `org_${crypto.randomUUID()}`, name: 'Chain Only' })
      .returning({ id: schema.tenant.id });
    const chain = await owner.db.transaction((tx) =>
      createAdminChain(tx, t.id, { email: 'demo@chain.test', fullName: 'HR Admin', withRoleAssignment: true }),
    );
    const grants = await owner.db
      .select({ role: schema.roleAssignment.role, companyId: schema.roleAssignment.companyId })
      .from(schema.roleAssignment)
      .where(eq(schema.roleAssignment.appUserId, chain.appUserId));
    expect(grants).toEqual([{ role: 'hr_admin', companyId: null }]);
    const employments = await owner.db
      .select({ id: schema.employment.id })
      .from(schema.employment)
      .where(and(eq(schema.employment.tenantId, t.id)));
    expect(employments).toHaveLength(0);
  });
});
