/**
 * r259 stage one (board item 9583deac) — MY PROFILE READS ONE RECORD, AND THE DATABASE IS WHAT DECIDES SO.
 *
 * The plan promises the reporter: "Employees see only their own record. There is no way to search for or
 * open anybody else." test/me-profile-visibility.test.ts pins the SHAPE of that promise (no picker, no id
 * parameter). This file pins the ENFORCEMENT, against a live cluster, because the shape is the half that
 * a refactor can restore by accident and the enforcement is the half that actually protects anybody.
 *
 * The distinction that matters, and it is the one the brief asked for: the scope must be RLS, not a
 * `.where()` in a page. A filter in a page is one careless edit from being dropped and nothing fails; an
 * RLS policy refuses the row even when the caller asks for it by id. So the cases below do exactly that —
 * they call the ADMIN read (`employeeDetail`) with a COLLEAGUE'S employment id under an employee session,
 * which is the strongest form of the question, and expect nothing back.
 *
 * `app.can_see_employment` (migration 0016) is: admin-for-the-company ∪ self ∪ administrative-manager-of.
 * A plain employee is none of those for a colleague, so the row is invisible to them at the database.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hireEmployee } from '../core/org';
import { updateOwnContact } from '../core/profile';
import { employeeDetail } from '../core/read';
import {readOwnProfileWorkspace} from '../core/profile-edit';
import { myProfileRecord } from '../app/me/record';
import { ME_WITHHELD_COLUMNS } from '../app/me/visible-fields';
import { person } from '../db/schema';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

async function hire(name: string) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
}

/** A plain employee principal: linked to a person, holding only the `employee` role. */
async function employeeCtx(personId: string): Promise<SessionContext> {
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { tenantId: b.tenantId, userId, personId, roles: ['employee'] };
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('r259 — /me is scoped to the caller’s own employment', () => {
  it('returns the caller’s OWN record, resolved from the session and not from a parameter', async () => {
    const mine = await hire('Selfreader');
    const ctx = await employeeCtx(mine.personId);

    const record = await myProfileRecord(ctx);

    expect(record, 'an employed principal must get their own record').not.toBeNull();
    expect(record!.employmentId).toBe(mine.employmentId);
    expect(record!.personId).toBe(mine.personId);
    expect(record!.profile.fullName).toBe('Selfreader');
  });

  it('CANNOT reach a colleague’s record even by asking for it by id — RLS refuses the row', async () => {
    const mine = await hire('Selfreader');
    const colleague = await hire('Colleague');
    const ctx = await employeeCtx(mine.personId);

    // The strongest form of the question: the ADMIN read, handed the colleague's id, under the employee's
    // own session. Nothing in the page is between the caller and the database here — if this returns a
    // row, the scope on /me was never real and the screen is one bad refactor from a leak.
    const theirs = await employeeDetail(ctx, colleague.employmentId);
    expect(theirs, 'an employee read a colleague’s employment row').toBeNull();

    // And the admin session CAN see it, so the null above is the policy refusing — not a broken fixture,
    // an empty table, or a query that returns nothing for everyone.
    const asAdmin = await employeeDetail(adminCtx(b), colleague.employmentId);
    expect(asAdmin?.employmentId).toBe(colleague.employmentId);
  });

  it('shows canonical address blocks and retained legacy reconciliation without allowing the retired direct address writer',async()=>{
    const mine=await hire('Selfreader'),ctx=await employeeCtx(mine.personId);
    await owner.db.update(person).set({addressLine1:'ZZLEGACYLINE1',permanentAddressLine1:'ZZPERMLINE1',correspondenceAddressLine1:'ZZCORRLINE1'}).where(eq(person.id,mine.personId));
    const workspace=await readOwnProfileWorkspace(ctx,{employmentId:mine.employmentId});
    expect(workspace.values['profile.contact_and_permanent_address.permanentaddressline1']).toBe('ZZPERMLINE1');expect(workspace.values['profile.correspondence_address.correspondenceaddressline1']).toBe('ZZCORRLINE1');expect(workspace.addressReview).toBe(true);expect(workspace.legacyAddress.addressLine1).toBe('ZZLEGACYLINE1');
    await expect(updateOwnContact(ctx,{addressLine1:'ZZUNAUTHORIZED'})).rejects.toMatchObject({code:'addressReview'});
    const [master]=await owner.db.select().from(person).where(eq(person.id,mine.personId));expect(master.addressLine1).toBe('ZZLEGACYLINE1');expect(master.permanentAddressLine1).toBe('ZZPERMLINE1');expect(master.correspondenceAddressLine1).toBe('ZZCORRLINE1');
  });

  it('a principal linked to no employment gets nothing rather than somebody else’s record', async () => {
    await hire('Somebody');
    // A platform login: a real app_user with no person behind it.
    const ctx: SessionContext = {
      tenantId: b.tenantId,
      userId: b.adminUserId,
      personId: undefined,
      roles: ['employee'],
    };
    expect(await myProfileRecord(ctx)).toBeNull();
  });

  it('carries no withheld field out of the admin row', async () => {
    // The redaction is an explicit projection in app/me/record.ts. This is the runtime half of the
    // source-static check in test/me-profile-visibility.test.ts: what is actually handed to the page must
    // not contain the columns docs/me-profile-field-visibility.md promises are withheld — a promise to the
    // reporter that the object itself has to keep, not only the JSX.
    const mine = await hire('Selfreader');
    const ctx = await employeeCtx(mine.personId);
    const record = await myProfileRecord(ctx);

    // DRIVEN BY THE MANIFEST. This was a hand-written list of ten names, and a hand-written list is what
    // let `payrollPolicyStatus` and `holidayGroupName` — both named in app/me/record.ts's own comment as
    // deliberately not projected — be added to the projection with this file green. Every name now comes
    // from `ME_HIDDEN_FIELDS[].columns`, the same declaration the reporter's document is written from.
    const flat = JSON.stringify(record);
    expect(ME_WITHHELD_COLUMNS.length, 'the withheld list names no columns at all').toBeGreaterThan(20);
    for (const withheld of ME_WITHHELD_COLUMNS) {
      expect(flat.includes(`"${withheld}"`), `the employee record carries the withheld field ${withheld}`).toBe(
        false,
      );
    }
  });
});
