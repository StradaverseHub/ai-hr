/**
 * fbf6abd0 — WHERE THE HEADER'S IDENTITY COMES FROM.
 *
 * test/r256-account-identity.dom.test.tsx proves what a person SEES once the name and the Employee ID
 * reach the corner. It cannot prove where they came from, and that is the half this item is most likely
 * to be got wrong in a later edit: `lib/principals.ts` exports { userId, name, roles } and reads like the
 * obvious source, but it is the DEV/DEMO switcher list — `demoSwitcherEnabled()` false returns [] — so a
 * header fed from it shows a name on a developer's machine and NOTHING on the deployment the reporter is
 * looking at. Which is precisely the reported fault.
 *
 * So this file executes the resolver against real rows, through RLS, for every state the shell has: an
 * employed principal, a login attached to no person at all, a NAMED principal with no employment (the
 * seeded HR administrator's shape — found by rendering, not by reading), and a leaver whose employment
 * has ended. Then it pins the wiring in the shell itself, because a correct resolver that nothing
 * renders is the same 200-with-no-identity the reporter reported.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { myPersonName } from '../core/read';
import { viewerIdentity } from '../lib/viewer';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

describe('fbf6abd0 — the topbar identity is read from the viewer’s EMPLOYMENT', () => {
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

  const selfCtx = (personId: string, userId: string): SessionContext => ({
    tenantId: base.tenantId,
    userId,
    personId,
    roles: ['employee'],
  });

  it('gives the signed-in person their own name and Employee ID', async () => {
    const e = await hireEmployee(adminCtx(base), {
      person: { fullName: 'Nurul Aisyah binti Karim', primaryEmail: 'nurul@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
      employeeCode: 'EMP-2201',
    });
    const uid = await createAppUser(base.tenantId, e.personId, 'employee');

    expect(await viewerIdentity(selfCtx(e.personId, uid))).toEqual({
      name: 'Nurul Aisyah binti Karim',
      employeeCode: 'EMP-2201',
      employed: true,
    });
  });

  it('reads the CALLER’s row, not the first employee in the tenant', async () => {
    // The HR administrator is the person this item was raised for — they spend the day inside other
    // people's records, so a header that showed the tenant's first employment would be worse than none.
    const admin = adminCtx(base);
    await hireEmployee(admin, {
      person: { fullName: 'Someone Else', primaryEmail: 'else@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
      employeeCode: 'EMP-3001',
    });
    const me = await hireEmployee(admin, {
      person: { fullName: 'Wong Mei Ling', primaryEmail: 'meiling@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-02-01',
      employeeCode: 'EMP-3002',
    });
    const uid = await createAppUser(base.tenantId, me.personId, 'employee');

    expect(await viewerIdentity(selfCtx(me.personId, uid))).toEqual({
      name: 'Wong Mei Ling',
      employeeCode: 'EMP-3002',
      employed: true,
    });
  });

  it('a login attached to NO person resolves to a nameless, unemployed viewer — never a blank', async () => {
    // adminCtx carries no personId: the platform login that is not attached to a person at all. The menu
    // renders the localized "Platform account" for it, which is all that can honestly be shown.
    expect(adminCtx(base).personId).toBeUndefined();
    expect(await viewerIdentity(adminCtx(base))).toEqual({ name: null, employeeCode: null, employed: false });
  });

  it('a NAMED principal with no employment keeps their own name (the seeded HR admin’s shape)', async () => {
    // FOUND BY RENDERING. The seeded HR administrator — the persona this item was raised for — has a
    // person row and NO employment, so an employment-only resolver would have labelled a named human
    // "Platform account". The name comes from their own person row, never from the demo switcher list.
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: base.tenantId, fullName: 'HR Admin', primaryEmail: 'hradmin@acme.test' })
      .returning({ id: schema.person.id });
    const uid = await createAppUser(base.tenantId, p.id, 'hr_admin');

    expect(await viewerIdentity({ ...adminCtx(base), userId: uid, personId: p.id })).toEqual({
      name: 'HR Admin',
      employeeCode: null,
      employed: false,
    });
  });

  it('costs NOTHING for a principal with no person — it never opens the transaction', async () => {
    // r256. The docblocks on core/read.ts and lib/viewer.ts claim the no-person path short-circuits
    // "without a query". It did not: the guard was the FIRST LINE INSIDE the withTenant callback, and
    // withTenant opens a db.transaction and issues four `select set_config(...)` statements before the
    // callback body runs (db/client.ts) — so a platform login paid a BEGIN + 4 statements + COMMIT on
    // every authenticated page render, for a lookup there was nothing to look up.
    //
    // THE PROBE, and why it discriminates the two placements exactly: withTenant REFUSES a context with
    // no tenantId, loudly. A context that is both person-less and tenant-less therefore resolves to null
    // if the guard runs first, and throws "withTenant was called without a valid session context" if it
    // runs inside the callback. Nothing else about this call is meaningful — it is a placement probe.
    await expect(myPersonName({ tenantId: '', personId: null } as SessionContext)).resolves.toBeNull();
    // And the same context DOES throw once there is a person to look up, which is the proof that the
    // probe is discriminating on the guard rather than on some other early return.
    await expect(myPersonName({ tenantId: '', personId: base.deptA } as SessionContext)).rejects.toThrow(
      /valid session context/,
    );
  });

  it('a leaver whose login still resolves keeps their name and loses the Employee ID', async () => {
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: base.tenantId, fullName: 'Ravi Kumar', primaryEmail: 'ravi@acme.test' })
      .returning({ id: schema.person.id });
    await owner.db.insert(schema.employment).values({
      tenantId: base.tenantId,
      personId: p.id,
      companyId: base.companyId,
      hiredOn: '2020-01-01',
      terminatedOn: '2026-03-31',
      employeeCode: 'EMP-9001',
    });
    const uid = await createAppUser(base.tenantId, p.id, 'employee');

    // Their name still shows — a leaver reading their own EA form should not see "Platform account" —
    // but the Employee ID and the profile link go with the employment that ended.
    expect(await viewerIdentity(selfCtx(p.id, uid))).toEqual({
      name: 'Ravi Kumar',
      employeeCode: null,
      employed: false,
    });
  });
});

describe('fbf6abd0 — the app shell actually renders it, and Log out is still reachable', () => {
  const LAYOUT = read('app/layout.tsx');
  const MENU = read('components/user-menu.tsx');
  const VIEWER = read('lib/viewer.ts');

  it('the header mounts the account menu with the viewer’s resolved name + Employee ID', () => {
    expect(LAYOUT).toContain("import { UserMenu } from '@/components/user-menu';");
    expect(LAYOUT).toContain("import { viewerIdentity } from '@/lib/viewer';");
    expect(LAYOUT).toContain('const viewer = await viewerIdentity(session);');
    expect(LAYOUT).toContain(
      '<UserMenu name={viewer.name} employeeCode={viewer.employeeCode} employed={viewer.employed} />',
    );
  });

  it('Log out MOVED into the menu — it is gone from the header row and present in the menu', () => {
    // The move is the one thing a reader might mistake for a removal, so both halves are asserted.
    expect(LAYOUT).not.toMatch(/<LogoutButton\b/);
    expect(MENU).toContain('<LogoutButton variant="menu" />');
  });

  it('the resolver imports the employment read, and NOT the dev/demo principal list', () => {
    expect(VIEWER).toContain("import { myEmployment, myPersonName } from '@/core/read';");
    // ^import, anchored per line: the docblock explains WHY principals.ts is wrong and must keep saying so.
    expect(VIEWER).not.toMatch(/^import .*principals/m);
  });
});
