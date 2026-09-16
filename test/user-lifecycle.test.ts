/**
 * Login lifecycle (0279) — archive a login, and block a leaver LIVE off their employment end dates.
 *
 * Two things are proved here, and they are different things:
 *   1. The SQL predicate (app.login_blocked / app.principal_by_subject) refuses the right rows.
 *   2. resolveDevPrincipal, exercised DIRECTLY with injected lookups, fails closed on a blocked id.
 *
 * (2) is not optional. app.principal(uuid) is deliberately left UNFILTERED, because resolveDevPrincipal
 * walks [cookieUser, DEV_USER_ID] and takes the first id that RESOLVES — so a filter in the SQL would
 * make an archived cookie identity fall through to DEV_USER_ID, normally the seeded GROUP ADMIN, and
 * archiving a user would ESCALATE their privileges instead of blocking them. Testing only the SQL is
 * exactly the test that would let that ship green.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { todayInKualaLumpur } from '../lib/hr-date';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { client, withTenant, type Grant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { closeAll, createAppUser, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { resolveDevPrincipal, resolveWorkosPrincipal } from '../lib/session';
import { AuthRequiredError } from '../lib/auth-errors';
import { setAppUserArchived } from '../core/auth';
import { listUsers } from '../core/admin';
import { hrAdminsForCompany } from '../core/notifications';
import { isLoginBlocked, type EmploymentStatusInput } from '../core/employment-status';
import { hireEmployee } from '../core/org';

const subjectLookup = (subject: string) =>
  client<{ app_user_id: string; tenant_id: string; person_id: string | null; grants: Grant[] | null }[]>`
    select app_user_id, tenant_id, person_id, grants from app.principal_by_subject(${subject})
  `;

const devLookup = (id: string) =>
  client<{ tenant_id: string; person_id: string | null; grants: Grant[] | null }[]>`
    select tenant_id, person_id, grants from app.principal(${id}::uuid)
  `;

/** The SQL predicate, straight from the DB. */
async function sqlBlocked(appUserId: string): Promise<boolean> {
  const [row] = await client<{ blocked: boolean }[]>`select app.login_blocked(${appUserId}::uuid) as blocked`;
  return Boolean(row.blocked);
}

// Anchor on the MYT calendar day, not UTC: app.login_blocked() compares against SQL current_date in an
// Asia/Kuala_Lumpur database, and isLoginBlocked() now mirrors that (lib/hr-date.ts). A UTC anchor made
// this suite fail every night between 00:00 and 08:00 MYT, when the two calendars name different days.
const iso = (offsetDays: number) => {
  const d = new Date(`${todayInKualaLumpur()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};
const TODAY = iso(0);
const YESTERDAY = iso(-1);
const TOMORROW = iso(1);

describe('0279 — login archive + live leaver block', () => {
  let base: Base;
  let adminCtx: SessionContext;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    adminCtx = { tenantId: base.tenantId, userId: base.adminUserId, roles: ['hr_admin'] };
  });
  afterAll(async () => {
    await closeAll();
  });

  /** Hire someone and give them a login with a known WorkOS subject. */
  async function hireWithLogin(
    name: string,
    subject: string,
  ): Promise<{ appUserId: string; personId: string; employmentId: string }> {
    const emp = await hireEmployee(adminCtx, {
      person: { fullName: name, primaryEmail: `${subject}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: subject, personId: emp.personId })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
    return { appUserId: u.id, personId: emp.personId, employmentId: emp.employmentId };
  }

  /** Set lifecycle end dates directly on an employment (the paths that write them are elsewhere). */
  async function endEmployment(
    employmentId: string,
    dates: { terminatedOn?: string | null; lastWorkingDate?: string | null; resignationDate?: string | null; blacklistedAt?: string | null },
  ) {
    await owner.db.update(schema.employment).set(dates).where(eq(schema.employment.id, employmentId));
  }

  // ───────────────────────── Archive / restore ─────────────────────────

  it('archiving sets archived_at + appends app-user.archived; restoring clears it + appends app-user.restored', async () => {
    const { appUserId } = await hireWithLogin('Archie Val', 'wos_archive_1');

    await setAppUserArchived(adminCtx, { appUserId, archived: true });
    let [row] = await owner.db
      .select({ archivedAt: schema.appUser.archivedAt })
      .from(schema.appUser)
      .where(eq(schema.appUser.id, appUserId));
    expect(row.archivedAt).not.toBeNull();
    expect(await eventTypesFor(base.tenantId, appUserId)).toContain('app-user.archived');

    await setAppUserArchived(adminCtx, { appUserId, archived: false });
    [row] = await owner.db
      .select({ archivedAt: schema.appUser.archivedAt })
      .from(schema.appUser)
      .where(eq(schema.appUser.id, appUserId));
    expect(row.archivedAt).toBeNull();
    expect(await eventTypesFor(base.tenantId, appUserId)).toContain('app-user.restored');
  });

  it('role assignments survive an archive → restore round trip', async () => {
    const { appUserId } = await hireWithLogin('Rolo Keeper', 'wos_roles_1');
    const before = await owner.db
      .select({ id: schema.roleAssignment.id, role: schema.roleAssignment.role })
      .from(schema.roleAssignment)
      .where(eq(schema.roleAssignment.appUserId, appUserId));

    await setAppUserArchived(adminCtx, { appUserId, archived: true });
    await setAppUserArchived(adminCtx, { appUserId, archived: false });

    const after = await owner.db
      .select({ id: schema.roleAssignment.id, role: schema.roleAssignment.role })
      .from(schema.roleAssignment)
      .where(eq(schema.roleAssignment.appUserId, appUserId));
    expect(after).toEqual(before);
    expect(after).toHaveLength(1);
  });

  it('rejects self-archive, the last group-wide admin, and a non-group-admin caller', async () => {
    // Self-lockout: an admin cannot switch off the login they are using.
    await expect(setAppUserArchived(adminCtx, { appUserId: base.adminUserId, archived: true })).rejects.toThrow(
      /your own login/i,
    );

    // Last group-wide admin: base seeds exactly one group-wide hr_admin, so archiving any OTHER
    // group-wide admin is fine only while a second one exists. Make a second, then archive the first.
    const { appUserId: second } = await hireWithLogin('Second Admin', 'wos_admin_2');
    await owner.db
      .update(schema.roleAssignment)
      .set({ role: 'super_admin' })
      .where(eq(schema.roleAssignment.appUserId, second));
    // From the second admin's session, archiving the seeded admin is allowed (two exist).
    const secondCtx: SessionContext = { tenantId: base.tenantId, userId: second, roles: ['super_admin'] };
    await setAppUserArchived(secondCtx, { appUserId: base.adminUserId, archived: true });
    // Now `second` is the only unblocked group-wide admin left — the seeded admin cannot archive it,
    // and neither can anyone else, because that would leave nobody able to reach this screen.
    await expect(setAppUserArchived(adminCtx, { appUserId: second, archived: true })).rejects.toThrow(
      /last group administrator/i,
    );

    // Non-group-admin caller is refused before touching anything.
    const { appUserId: victim } = await hireWithLogin('Victim', 'wos_victim_1');
    const employeeCtx: SessionContext = { tenantId: base.tenantId, userId: victim, roles: ['employee'] };
    await expect(setAppUserArchived(employeeCtx, { appUserId: base.adminUserId, archived: false })).rejects.toThrow(
      /group administrator/i,
    );
  });

  it('row security is the backstop: a non-group-admin session cannot UPDATE archived_at directly', async () => {
    const { appUserId } = await hireWithLogin('RLS Target', 'wos_rls_1');
    const { appUserId: plain } = await hireWithLogin('Plain Employee', 'wos_rls_2');
    const employeeCtx: SessionContext = { tenantId: base.tenantId, userId: plain, roles: ['employee'] };

    // Straight through withTenant, bypassing the service guard entirely — the 0016 app_user policy's
    // WITH CHECK (… AND app.is_group_admin()) must still refuse the write.
    await expect(
      withTenant(employeeCtx, async (tx) => {
        await tx
          .update(schema.appUser)
          .set({ archivedAt: new Date() })
          .where(eq(schema.appUser.id, appUserId));
      }),
    ).rejects.toThrow();

    const [row] = await owner.db
      .select({ archivedAt: schema.appUser.archivedAt })
      .from(schema.appUser)
      .where(eq(schema.appUser.id, appUserId));
    expect(row.archivedAt).toBeNull();
  });

  // ───────────────────── The WorkOS resolve path (real access) ─────────────────────

  it('an archived login cannot resolve a session', async () => {
    const { appUserId } = await hireWithLogin('Blocked Bob', 'wos_blocked_1');
    // Sanity: it resolves before archiving.
    await expect(resolveWorkosPrincipal(subjectLookup, 'wos_blocked_1')).resolves.toMatchObject({ userId: appUserId });

    await setAppUserArchived(adminCtx, { appUserId, archived: true });

    expect(await subjectLookup('wos_blocked_1')).toHaveLength(0);
    await expect(resolveWorkosPrincipal(subjectLookup, 'wos_blocked_1')).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('THE BOUNDARY DAY: an employment ending TODAY still resolves; ending YESTERDAY does not', async () => {
    const { employmentId } = await hireWithLogin('Lasty Day', 'wos_boundary_1');

    // Final working day is TODAY — the login must still work for the whole of it (handover).
    await endEmployment(employmentId, { lastWorkingDate: TODAY });
    expect(await subjectLookup('wos_boundary_1')).toHaveLength(1);

    // A future end date obviously still resolves (serving notice).
    await endEmployment(employmentId, { lastWorkingDate: TOMORROW });
    expect(await subjectLookup('wos_boundary_1')).toHaveLength(1);

    // One day past the last working day — access is gone, with no sweep and no manual step.
    await endEmployment(employmentId, { lastWorkingDate: YESTERDAY });
    expect(await subjectLookup('wos_boundary_1')).toHaveLength(0);
    await expect(resolveWorkosPrincipal(subjectLookup, 'wos_boundary_1')).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('keeps access while a SECOND employment is still open, and drops it once that one ends too', async () => {
    const { personId, employmentId } = await hireWithLogin('Two Hats', 'wos_two_hats');
    const second = await hireEmployee(adminCtx, {
      person: { id: personId },
      companyId: base.companyId,
      departmentId: base.deptB,
      employmentType: 'full_time',
      hiredOn: '2021-01-01',
    });

    await endEmployment(employmentId, { terminatedOn: YESTERDAY });
    expect(await subjectLookup('wos_two_hats')).toHaveLength(1); // the other job is still open

    await endEmployment(second.employmentId, { terminatedOn: YESTERDAY });
    expect(await subjectLookup('wos_two_hats')).toHaveLength(0); // every employment has ended
  });

  it('blocks a blacklisted employment even with no end dates recorded', async () => {
    const { employmentId } = await hireWithLogin('Black Listed', 'wos_black_1');
    await endEmployment(employmentId, { blacklistedAt: TODAY });
    expect(await subjectLookup('wos_black_1')).toHaveLength(0);
  });

  it('never auto-blocks a login with no person linked (external / IT-admin logins)', async () => {
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: 'wos_external_1', personId: null })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'super_admin' });

    expect(await sqlBlocked(u.id)).toBe(false);
    expect(await subjectLookup('wos_external_1')).toHaveLength(1);

    // Only a manual archive touches it.
    await setAppUserArchived(adminCtx, { appUserId: u.id, archived: true });
    expect(await subjectLookup('wos_external_1')).toHaveLength(0);
  });

  // ───────────────── resolveDevPrincipal — the escalation guard ─────────────────

  it('resolveDevPrincipal fails CLOSED on a blocked id and does NOT fall through to the fallback', async () => {
    const principal = { tenant_id: base.tenantId, person_id: null, grants: [] as Grant[] };
    const tried: string[] = [];
    const lookup = async (id: string) => {
      tried.push(id);
      return [principal]; // BOTH ids resolve — this is the point: app.principal is unfiltered
    };
    const blocked = async (id: string) => id === 'cookie-id';

    await expect(resolveDevPrincipal(lookup, 'cookie-id', 'fallback-admin-id', blocked)).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
    // It must stop at the blocked cookie identity. Reaching 'fallback-admin-id' would mean an archived
    // user silently browsing as the seeded GROUP ADMIN — an escalation, not a block.
    expect(tried).toEqual(['cookie-id']);
  });

  it('resolveDevPrincipal still self-heals an UNKNOWN cookie id to the fallback identity', async () => {
    const principal = { tenant_id: base.tenantId, person_id: null, grants: [] as Grant[] };
    const lookup = async (id: string) => (id === 'fallback-admin-id' ? [principal] : []);
    const blocked = async () => false;

    const s = await resolveDevPrincipal(lookup, 'stale-cookie-id', 'fallback-admin-id', blocked);
    expect(s.userId).toBe('fallback-admin-id'); // the pinned behaviour in test/session.test.ts
  });

  it('resolveDevPrincipal against the REAL SQL: an archived id throws instead of resolving', async () => {
    const { appUserId } = await hireWithLogin('Dev Switcher', 'wos_dev_1');
    const blocked = async (id: string) => sqlBlocked(id);

    // Resolves fine before archiving.
    await expect(resolveDevPrincipal(devLookup, appUserId, base.adminUserId, blocked)).resolves.toMatchObject({
      userId: appUserId,
    });

    await setAppUserArchived(adminCtx, { appUserId, archived: true });

    // app.principal STILL returns the row (unfiltered, deliberately) …
    expect(await devLookup(appUserId)).toHaveLength(1);
    // … so the only thing standing between an archived user and the seeded admin's grants is this:
    await expect(
      resolveDevPrincipal(devLookup, appUserId, base.adminUserId, blocked),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });

  // ───────────────── SQL ↔ TypeScript agreement ─────────────────

  it('app.login_blocked and isLoginBlocked() agree across the full case matrix', async () => {
    const cases: {
      label: string;
      dates: Partial<Record<'terminatedOn' | 'lastWorkingDate' | 'resignationDate' | 'blacklistedAt', string>>[];
      archived: boolean;
      expected: boolean;
    }[] = [
      { label: 'no employment', dates: [], archived: false, expected: false },
      { label: 'ended yesterday', dates: [{ terminatedOn: YESTERDAY }], archived: false, expected: true },
      { label: 'ending today', dates: [{ terminatedOn: TODAY }], archived: false, expected: false },
      { label: 'ending tomorrow', dates: [{ terminatedOn: TOMORROW }], archived: false, expected: false },
      {
        label: 'two employments, one still open',
        dates: [{ terminatedOn: YESTERDAY }, {}],
        archived: false,
        expected: false,
      },
      {
        label: 'two employments, both ended',
        dates: [{ terminatedOn: YESTERDAY }, { lastWorkingDate: YESTERDAY }],
        archived: false,
        expected: true,
      },
      { label: 'blacklisted, no dates', dates: [{ blacklistedAt: TODAY }], archived: false, expected: true },
      { label: 'archived flag only', dates: [{}], archived: true, expected: true },
      {
        label: 'earliest of three dates wins',
        dates: [{ resignationDate: YESTERDAY, lastWorkingDate: TOMORROW, terminatedOn: TOMORROW }],
        archived: false,
        expected: true,
      },
    ];

    for (const c of cases) {
      const subject = `wos_matrix_${randomUUID()}`;
      let personId: string | null = null;
      const employments: EmploymentStatusInput[] = [];
      for (const [i, d] of c.dates.entries()) {
        const emp = await hireEmployee(adminCtx, {
          person: personId ? { id: personId } : { fullName: `Matrix ${c.label} ${i}`, primaryEmail: `${subject}-${i}@acme.test` },
          companyId: base.companyId,
          departmentId: base.deptA,
          employmentType: 'full_time',
          hiredOn: '2020-01-01',
        });
        personId = emp.personId;
        if (Object.keys(d).length > 0) await endEmployment(emp.employmentId, d);
        employments.push(d as EmploymentStatusInput);
      }
      const [u] = await owner.db
        .insert(schema.appUser)
        .values({
          tenantId: base.tenantId,
          workosUserId: subject,
          personId,
          archivedAt: c.archived ? new Date() : null,
        })
        .returning({ id: schema.appUser.id });

      const fromSql = await sqlBlocked(u.id);
      const fromTs = isLoginBlocked({ archivedAt: c.archived ? new Date() : null, employments }, TODAY);
      expect(fromSql, `SQL — ${c.label}`).toBe(c.expected);
      expect(fromTs, `TS — ${c.label}`).toBe(c.expected);
      expect(fromSql, `SQL vs TS — ${c.label}`).toBe(fromTs);
    }
  });

  // ───────────────────────── listUsers ─────────────────────────

  it('listUsers hides archived + terminated-blocked rows by default, shows them with includeArchived, and counts the hidden', async () => {
    const { appUserId: archivedId } = await hireWithLogin('Archie Hidden', 'wos_list_arch');
    const { appUserId: leaverId, employmentId: leaverEmp } = await hireWithLogin('Lee Ver', 'wos_list_leaver');
    const { appUserId: activeId } = await hireWithLogin('Ann Active', 'wos_list_active');

    await setAppUserArchived(adminCtx, { appUserId: archivedId, archived: true });
    await endEmployment(leaverEmp, { terminatedOn: YESTERDAY });

    const def = await listUsers(adminCtx);
    const defIds = def.users.map((u) => u.id);
    expect(defIds).toContain(activeId);
    expect(defIds).not.toContain(archivedId);
    expect(defIds).not.toContain(leaverId);
    expect(def.hiddenCount).toBe(2);

    const all = await listUsers(adminCtx, { includeArchived: true });
    const allIds = all.users.map((u) => u.id);
    expect(allIds).toEqual(expect.arrayContaining([activeId, archivedId, leaverId]));
    expect(all.hiddenCount).toBe(0);

    // The two causes stay distinguishable, so the UI offers Restore only for the manual one.
    const archivedRow = all.users.find((u) => u.id === archivedId)!;
    const leaverRow = all.users.find((u) => u.id === leaverId)!;
    expect(archivedRow.archivedAt).not.toBeNull();
    expect(archivedRow.blockedByTermination).toBe(false);
    expect(leaverRow.archivedAt).toBeNull();
    expect(leaverRow.blockedByTermination).toBe(true);
  });

  it('a PDPA-erased person renders as an unlinked login with no email surfaced', async () => {
    const { appUserId } = await hireWithLogin('To Be Erased', 'wos_erased_1');
    // Erasure detaches the login from the person; the person row itself is handled by the erasure path.
    // Detaching is what matters here — with no person there is no name and no email to render, and the
    // login must NOT fall back to the retained invitation email to fill the gap.
    await owner.db.update(schema.appUser).set({ personId: null }).where(eq(schema.appUser.id, appUserId));

    const { users } = await listUsers(adminCtx, { includeArchived: true });
    const row = users.find((u) => u.id === appUserId)!;
    expect(row.personId).toBeNull();
    expect(row.name).toBeNull();
    // The invitation email is NOT surfaced as a fallback — that would re-expose what erasure removed.
    expect(row.email).toBeNull();
    expect(row.workosUserId).toBe('wos_erased_1');
  });

  // ───────────────────────── Notification recipients ─────────────────────────

  it('an archived or departed hr_admin is no longer a notification recipient', async () => {
    // Two HR admins in the company, both with employments there.
    const a = await hireWithLogin('Hr Ay', 'wos_hr_a');
    const b = await hireWithLogin('Hr Bee', 'wos_hr_b');
    for (const id of [a.appUserId, b.appUserId]) {
      await owner.db
        .update(schema.roleAssignment)
        .set({ role: 'hr_admin' })
        .where(eq(schema.roleAssignment.appUserId, id));
    }
    // A third employment is the notification's subject.
    const subject = await hireWithLogin('Sub Ject', 'wos_hr_subject');

    const recipients = async () =>
      withTenant(adminCtx, (tx) => hrAdminsForCompany(tx, subject.employmentId));

    expect(await recipients()).toEqual(expect.arrayContaining([a.employmentId, b.employmentId]));

    // Archived → dropped. NOT because anything is emailed — nothing in this product is (core/notifications.ts
    // file header; there is no email transport in the repo). Because a notification row outlives the block:
    // `notification_recipient_rls` is person-scoped and role-blind and the body is frozen text about another
    // employee, so a backlog accrued while the login was off would be readable in full on restore or rehire.
    await setAppUserArchived(adminCtx, { appUserId: a.appUserId, archived: true });
    expect(await recipients()).not.toContain(a.employmentId);
    expect(await recipients()).toContain(b.employmentId);

    // Departed (the derived path) → dropped too, with no manual step.
    await endEmployment(b.employmentId, { terminatedOn: YESTERDAY });
    expect(await recipients()).not.toContain(b.employmentId);
  });

  it('listUsers still shows a login whose person has no employment at all', async () => {
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: base.tenantId, fullName: 'No Job Nancy', primaryEmail: 'nojob@acme.test' })
      .returning({ id: schema.person.id });
    const appUserId = await createAppUser(base.tenantId, p.id, 'employee');

    const { users } = await listUsers(adminCtx);
    const row = users.find((u) => u.id === appUserId);
    expect(row).toBeDefined();
    expect(row!.blockedByTermination).toBe(false);
  });
});
