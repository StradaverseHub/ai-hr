/**
 * Apply-on-behalf is a NAMED PERMISSION (feedback 5206539f).
 *
 * WHAT WAS WRONG. Nothing in the system named the power to submit leave for somebody else. The Leave
 * screen showed its Employee selector to anyone with a direct report — an accident of the org chart, not a
 * permission — and offered every employee in the viewer's scope, not those reports. Underneath, the door
 * was simply open: app/leave/actions.ts passed the posted `employmentId` straight into requestLeave, and
 * requestLeave never asked who was posting. RLS could not fence it, because RLS here is SYMMETRIC: a
 * manager may legitimately SEE a subordinate, so every row policy passes on the write.
 *
 * THE CONTRACT SPANS TWO FILES, so both halves are pinned here (AGENTS rule 17): a unit test of either one
 * alone passes throughout. The screen must decide the selector from the permission, and the service must
 * refuse the submission — hiding the selector while the service still accepted the post would have changed
 * nothing at all, and refusing in the ACTION alone would have left every other caller of requestLeave
 * (importers, a second screen, a future API) inheriting the hole.
 *
 * Harness note (mirrors leave-duplicate-application.test.ts): requestLeave's WITH CHECK RLS is
 * app.can_see_employment(employment_id), so an applicant ctx must be able to see the employment. We hire as
 * admin, link app_users to those people, and drive each case through the role under test.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { canApplyLeaveOnBehalf, requestLeave, LeaveOnBehalfNotAllowedError } from '../core/leave';
import { listEmployees, reportingLinesFor } from '../core/read';
import { PAYROLL_PERMISSION_DEFAULTS, PAYROLL_PERMISSION_KEYS } from '../lib/payroll-permissions';
import type { SessionContext } from '../db/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

let b: Base;
/** A future span, so no backdating / advance-notice rule is in play — this file is about WHO, not WHEN. */
const START = '2026-09-01';
const END = '2026-09-02';

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

function uniq(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

/** Calendar-counted, negative-balance-tolerant type so the only thing under test is the on-behalf gate. */
async function leaveType(): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: uniq('OBH'),
      name: uniq('OnBehalf'),
      paid: true,
      counting: 'calendar_days',
      allowNegativeBalance: true,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function hire(role: 'employee' | 'manager' | 'hr_admin') {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: uniq('P'), primaryEmail: `${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, role);
  const ctx: SessionContext = { tenantId: b.tenantId, userId, roles: [role], personId };
  return { employmentId, personId, ctx };
}

/** An administrative reporting edge — the thing that used to BE the permission. */
async function reportsTo(subordinateEmploymentId: string, managerEmploymentId: string) {
  await owner.db.insert(schema.reportingLine).values({
    tenantId: b.tenantId,
    subordinateEmploymentId,
    managerEmploymentId,
    lineType: 'administrative',
    validFrom: '2020-01-01',
  });
}

async function grant(p: { companyId?: string | null; role: string; allowed?: boolean }) {
  await owner.db.insert(schema.payrollPermissionGrant).values({
    tenantId: b.tenantId,
    companyId: p.companyId ?? null,
    permissionKey: 'leave.apply_on_behalf',
    role: p.role,
    allowed: p.allowed ?? true,
  });
}

async function requestCount(employmentId: string): Promise<number> {
  const rows = await owner.db
    .select({ id: schema.leaveRequest.id })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.employmentId, employmentId));
  return rows.length;
}

describe('requestLeave — the on-behalf gate', () => {
  it('REFUSES a line manager who posts a report’s employmentId by hand, however many reports they have', async () => {
    const typeId = await leaveType();
    const mgr = await hire('manager');
    const report = await hire('employee');
    await reportsTo(report.employmentId, mgr.employmentId);

    // The org chart says "manager", loudly — this is exactly the state that used to grant the power.
    const lines = await reportingLinesFor(mgr.ctx, mgr.employmentId);
    expect(lines.reports.length).toBeGreaterThan(0);
    // …and the screen's own question now answers NO for them.
    expect(await canApplyLeaveOnBehalf(mgr.ctx)).toBe(false);

    // THE POST THE HIDDEN SELECTOR CANNOT PREVENT. Refused by the service, not by RLS: the manager can SEE
    // this employment (the read above resolved it), so every row policy on the insert would have passed.
    const err = await requestLeave(mgr.ctx, {
      employmentId: report.employmentId,
      leaveTypeId: typeId,
      startDate: START,
      endDate: END,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaveOnBehalfNotAllowedError);
    // TYPED, and carrying a message: the screen maps the NAME to a translated sentence, and anything that
    // logs the error still reads a full English one.
    expect((err as Error).name).toBe('LeaveOnBehalfNotAllowedError');
    expect((err as Error).message).toMatch(/permission/i);
    // Nothing was written for the report — the gate runs before every other read and write.
    expect(await requestCount(report.employmentId)).toBe(0);
  });

  it('lets that same manager file for THEMSELVES — the self-service path is untouched', async () => {
    const typeId = await leaveType();
    const mgr = await hire('manager');
    const report = await hire('employee');
    await reportsTo(report.employmentId, mgr.employmentId);

    await requestLeave(mgr.ctx, {
      employmentId: mgr.employmentId,
      leaveTypeId: typeId,
      startDate: START,
      endDate: END,
    });
    expect(await requestCount(mgr.employmentId)).toBe(1);
  });

  it('accepts a DEFAULT holder (hr_admin) for an employee in scope', async () => {
    const typeId = await leaveType();
    const subject = await hire('employee');
    expect(await canApplyLeaveOnBehalf(adminCtx(b))).toBe(true);
    await requestLeave(adminCtx(b), {
      employmentId: subject.employmentId,
      leaveTypeId: typeId,
      startDate: START,
      endDate: END,
    });
    expect(await requestCount(subject.employmentId)).toBe(1);
  });

  it('a per-company grant makes a role a holder IN THAT COMPANY — and refuses it outside', async () => {
    const typeId = await leaveType();
    const [other] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: uniq('Other Sdn Bhd') })
      .returning({ id: schema.company.id });
    const mgr = await hire('manager');
    const report = await hire('employee');
    await reportsTo(report.employmentId, mgr.employmentId);

    // Granted for the OTHER company only: the resolver asks the question in the SUBJECT's company, and the
    // subject here is in the seeded one. A grant somewhere else is not a grant here.
    await grant({ companyId: other.id, role: 'manager' });
    expect(await canApplyLeaveOnBehalf(mgr.ctx, other.id)).toBe(true);
    expect(await canApplyLeaveOnBehalf(mgr.ctx, b.companyId)).toBe(false);
    await expect(
      requestLeave(mgr.ctx, { employmentId: report.employmentId, leaveTypeId: typeId, startDate: START, endDate: END }),
    ).rejects.toThrow(LeaveOnBehalfNotAllowedError);
    expect(await requestCount(report.employmentId)).toBe(0);

    // Granted for the subject's OWN company: the same manager, the same post, now accepted — and no code
    // changed to do it, which is the promise the plan made to the reporter.
    await owner.db
      .delete(schema.payrollPermissionGrant)
      .where(
        and(
          eq(schema.payrollPermissionGrant.permissionKey, 'leave.apply_on_behalf'),
          eq(schema.payrollPermissionGrant.companyId, other.id),
        ),
      );
    await grant({ companyId: b.companyId, role: 'manager' });
    expect(await canApplyLeaveOnBehalf(mgr.ctx, b.companyId)).toBe(true);
    await requestLeave(mgr.ctx, {
      employmentId: report.employmentId,
      leaveTypeId: typeId,
      startDate: START,
      endDate: END,
    });
    expect(await requestCount(report.employmentId)).toBe(1);
  });

  it('a tenant-wide deny NARROWS a default holder back out of the permission', async () => {
    const typeId = await leaveType();
    const subject = await hire('employee');
    // An override REPLACES the code default for the key, so a lone allowed=false row leaves an empty
    // allow-list: the mechanism narrows as well as widens (same semantics as the payroll keys).
    await grant({ role: 'hr_admin', allowed: false });
    expect(await canApplyLeaveOnBehalf(adminCtx(b))).toBe(false);
    await expect(
      requestLeave(adminCtx(b), { employmentId: subject.employmentId, leaveTypeId: typeId, startDate: START, endDate: END }),
    ).rejects.toThrow(LeaveOnBehalfNotAllowedError);
    expect(await requestCount(subject.employmentId)).toBe(0);
  });
});

/**
 * A SECOND COMPANY in the same tenant, with a department of its own so employees can be hired into it.
 * Nothing here is group-hierarchy: `is_company_descendant` is not exercised, so the two companies are
 * genuinely separate scopes.
 */
async function otherCompany(): Promise<{ companyId: string; deptId: string }> {
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: uniq('Beta Sdn Bhd') })
    .returning({ id: schema.company.id });
  const [d] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: c.id, name: uniq('Ops') })
    .returning({ id: schema.department.id });
  return { companyId: c.id, deptId: d.id };
}

async function hireInto(companyId: string, departmentId: string) {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: uniq('P'), primaryEmail: `${randomUUID().slice(0, 8)}@t.local` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  return { employmentId, personId };
}

/**
 * An hr_admin whose role_assignment names ONE company — a group's per-company HR administrator, which is
 * what `app.has_role_for(role, company)` exists for. `createAppUser` only ever mints tenant-wide grants, so
 * this is built by hand: the whole point of the pair of tests below is a holder whose scope has an edge.
 */
async function companyScopedAdmin(companyId: string, departmentId: string) {
  const { employmentId, personId } = await hireInto(companyId, departmentId);
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: b.tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
  const ctx: SessionContext = {
    tenantId: b.tenantId,
    userId: u.id,
    personId,
    roles: ['hr_admin'],
    grants: [{ role: 'hr_admin', companyId }],
  };
  return { employmentId, personId, ctx };
}

/**
 * THE PLAN'S THIRD GUARD: a permission holder is accepted for anyone IN SCOPE and refused OUTSIDE it.
 *
 * "Scope" is the holder's own VISIBILITY scope, not the reach of the grant row — the company-scoped GRANT is
 * covered above. For a group's per-company HR administrator the two tests below are the two sides of one
 * edge: `app.can_see_employment` consults `app.is_admin_for(company_id)`, so an hr_admin granted for Acme
 * sees every Acme employment and no Beta one. That is also exactly the list the Leave screen's Employee
 * selector is built from (`listEmployees(session, scopeIds)`), which is why it is the boundary worth pinning:
 * the screen draws it, and a hand-crafted post ignores it.
 */
describe('a HOLDER — accepted for anyone IN SCOPE, refused OUTSIDE it', () => {
  it('files for a STRANGER in scope, with NO reporting line anywhere in the tenant', async () => {
    const typeId = await leaveType();
    const holder = await companyScopedAdmin(b.companyId, b.deptA);
    const stranger = await hireInto(b.companyId, b.deptB);

    // THE ORG CHART IS EMPTY — asserted, not assumed. Under the rule this item replaced (`does anyone report
    // to you`) this holder could not have filed for a soul; under the new one the permission carries, and it
    // carries to everyone in scope rather than to a list of reports. The two halves of the reporter's
    // complaint — a manager who should not have it, and a list that was never the reports — meet here.
    const lines = await owner.db
      .select({ id: schema.reportingLine.id })
      .from(schema.reportingLine)
      .where(eq(schema.reportingLine.tenantId, b.tenantId));
    expect(lines).toEqual([]);
    expect(await canApplyLeaveOnBehalf(holder.ctx, b.companyId)).toBe(true);

    // In scope in the sense the screen means it: the selector's own source lists this person.
    const visible = await listEmployees(holder.ctx);
    expect(visible.map((e) => e.employmentId)).toContain(stranger.employmentId);

    await requestLeave(holder.ctx, {
      employmentId: stranger.employmentId,
      leaveTypeId: typeId,
      startDate: START,
      endDate: END,
    });
    expect(await requestCount(stranger.employmentId)).toBe(1);
  });

  it('is REFUSED for an employment OUTSIDE its scope — typed, and nothing written', async () => {
    const typeId = await leaveType();
    const beta = await otherCompany();
    const holder = await companyScopedAdmin(b.companyId, b.deptA);
    const outsider = await hireInto(beta.companyId, beta.deptId);

    // Out of scope, again in the screen's own terms: this employment is not in the holder's employee list,
    // so no selector could have offered it and only a hand-crafted post can name it.
    const visible = await listEmployees(holder.ctx);
    expect(visible.map((e) => e.employmentId)).not.toContain(outsider.employmentId);

    const err = await requestLeave(holder.ctx, {
      employmentId: outsider.employmentId,
      leaveTypeId: typeId,
      startDate: START,
      endDate: END,
    }).catch((e: unknown) => e);
    // TYPED, like every other refusal on this path. RLS would have blocked the INSERT at the end of a long
    // function anyway, but as a raw policy violation: a message no locale owns, thrown after the request has
    // been costed against an employment the caller may not act for. The gate answers first and answers the
    // same way it answers a line manager.
    expect(err).toBeInstanceOf(LeaveOnBehalfNotAllowedError);
    expect(await requestCount(outsider.employmentId)).toBe(0);
  });
});

describe('leave.apply_on_behalf — the key itself', () => {
  it('exists, and defaults to the HR roles only', () => {
    expect(PAYROLL_PERMISSION_KEYS).toContain('leave.apply_on_behalf');
    // The whole point of the item: nothing widens on the day it ships. `manager` is ABSENT.
    expect([...PAYROLL_PERMISSION_DEFAULTS['leave.apply_on_behalf']].sort()).toEqual(['hr_admin', 'super_admin']);
  });

  it('needs no migration — and says so where a reader will look', () => {
    // permission_key is plain text with no enum and no foreign key, so the existing override table already
    // stores a leave key. The COST is that the table's name is now a misnomer; the declaration must say so,
    // or the next reader "fixes" it by renaming the table inside an unrelated round.
    const src = read('lib/payroll-permissions.ts');
    expect(src).toContain("'leave.apply_on_behalf'");
    expect(src.toLowerCase()).toContain('misnomer');
    const schemaSrc = read('db/schema.ts');
    const table = schemaSrc.slice(schemaSrc.indexOf("export const payrollPermissionGrant = pgTable("));
    const body = table.slice(0, table.indexOf('\n);'));
    expect(body).toContain("permissionKey: text('permission_key').notNull(),");
  });
});

describe('the key is grantable, and the screen that grants it says so', () => {
  it('the ONE screen that can hand this key to a role names leave in its own heading', () => {
    // app/admin/payroll-permissions is the only surface that writes payroll_permission_grant rows, so it is
    // the only place `leave.apply_on_behalf` can be granted. Its route, its module and its table all still
    // say "payroll" — renaming them is a migration and its own ticket — which leaves the WORDING as the only
    // thing telling an operator sent to grant a LEAVE permission that they are on the right page.
    const page = read('app/admin/payroll-permissions/page.tsx');
    expect(page, 'the admin screen no longer mentions the key it grants').toContain('leave.apply_on_behalf');
    const en = JSON.parse(read('messages/en.json')) as {
      admin: { payrollPermissions: { title: string; subtitle: string } };
    };
    const { title, subtitle } = en.admin.payrollPermissions;
    expect(title.toLowerCase(), 'the heading is payroll-only again').toContain('leave');
    expect(subtitle.toLowerCase(), 'the subtitle is payroll-only again').toContain('leave');
  });

  it('the limits a grant carries are recorded AT THE GRANT, not in a build report', () => {
    // Granting this key to a non-admin role works — requestLeave honours it everywhere — but the Leave
    // screen offers the HOLDER's own leave types for whoever they pick, and gives a holder who qualifies
    // for nothing no trigger at all. Neither bites at the shipped defaults (hr_admin / super_admin never
    // open that dialog), so the only moment anyone can act on them is when deciding to grant.
    const src = read('lib/payroll-permissions.ts').toLowerCase();
    expect(src, 'the grant-time limits left the declaration').toContain('before granting it to a non-admin role');
    expect(src).toContain("the leave types on offer are the holder's own");
  });
});

describe('the screen and the service read ONE permission (AGENTS rule 17)', () => {
  const page = read('app/leave/page.tsx');
  const core = read('core/leave.ts');
  const actions = read('app/leave/actions.ts');

  it('the Employee selector’s visibility is the PERMISSION, not the org chart', () => {
    expect(page).toContain('const canApplyOnBehalf = await canApplyLeaveOnBehalf(session, myCompanyId);');
    expect(page).toContain('employeeOptions={canApplyOnBehalf ? requestLeaveEmployeeOptions : undefined}');
    // THE ONE-EDIT-APART CASE. The old rule and the new one differ by a single expression, so the absence of
    // the old read is asserted as flatly as the presence of the new one — a page that asks BOTH questions
    // would satisfy every other assertion in this file.
    expect(page, 'the reporting-lines read is back').not.toContain('reportingLinesFor');
    expect(page, 'the selector is counting direct reports again').not.toContain('.reports.length');
  });

  it('the gate lives in requestLeave itself, ahead of every other read and write', () => {
    const at = core.indexOf('export async function requestLeave(');
    expect(at).toBeGreaterThan(-1);
    const body = core.slice(at, core.indexOf('\nexport ', at + 10));
    expect(body).toContain('throw new LeaveOnBehalfNotAllowedError();');
    // Resolved through the same function the page calls (canApplyLeaveOnBehalf wraps it), not a second
    // spelling of the rule.
    expect(body).toContain('resolveApplyOnBehalfTx(tx, ctx,');
    // ABOVE the Emergency-Leave short-circuit, which returns into a whole separate submission path — a gate
    // below it would leave EL unfenced.
    const gateAt = body.indexOf('throw new LeaveOnBehalfNotAllowedError();');
    const elAt = body.indexOf('return requestEmergencyLeave(');
    expect(elAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(elAt);
  });

  it('the refusal reaches the employee TRANSLATED, not as a raw service string', () => {
    expect(actions).toContain('if (e instanceof LeaveOnBehalfNotAllowedError) {');
    expect(actions).toContain("tErr('applyOnBehalfNotAllowed')");
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as { leave: { errors: Record<string, string> } };
      const s = m.leave.errors.applyOnBehalfNotAllowed;
      expect(s, `messages/${loc}.json is missing the refusal`).toBeTruthy();
      if (loc !== 'en') {
        expect(s, `messages/${loc}.json still carries the English sentence`).not.toBe(
          'You do not have permission to apply for leave on behalf of another employee.',
        );
      }
    }
  });

  it('the /me self-service path still posts no employmentId at all', () => {
    // Untouched by this item, and asserted so it stays that way: /me resolves the caller's own employment
    // server-side (resolveMe) and never reads one off the form, so the gate above can only ever see `self`.
    const me = read('app/me/actions.ts');
    const fn = me.slice(me.indexOf('export async function myRequestLeave'));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    expect(body).toContain('const { s, employmentId } = await resolveMe();');
    expect(body, '/me started trusting a posted employment').not.toContain("formData.get('employmentId')");
  });
});
