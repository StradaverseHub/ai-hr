/**
 * r261 stage three (board item 9583deac) — THE TWO SETTINGS, AND THE THREE THINGS THEY MUST NEVER DO.
 *
 * The plan promises the reporter a setting that controls, FIELD BY FIELD, what an employee may ask to
 * change, and a setting that controls WHO approves. Both are configuration, and configuration that is
 * wrong in the permissive direction is a data incident rather than a bug. So this file is adversarial by
 * construction and runs against a live cluster: every case below asks whether the narrow answer holds
 * when somebody is actively trying to get the wide one.
 *
 *   1. A FIELD THAT IS SWITCHED OFF CANNOT BE ASKED ABOUT — not from the screen (no control renders at
 *      all, which is asserted rather than a disabled one) and not by posting the key by hand.
 *   2. SWITCHING A FIELD OFF NEITHER APPLIES NOR DESTROYS A REQUEST ALREADY WAITING ON IT. It is refused
 *      with a reason the employee reads on their own screen, the master record is untouched, and it can
 *      never be approved afterwards.
 *   3. THE APPROVER SETTING NEVER LETS SOMEBODY DECIDE THEIR OWN REQUEST, AND NEVER WIDENS WHO CAN SEE
 *      SOMEBODY ELSE'S. Both are asked under the WIDE setting, which is the only configuration in which
 *      they could fail.
 *
 * Each case names the shipped line it fails on if that line is reverted — see the round's non-vacuity
 * note, which reverted two of them and watched the named assertions go red.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hireEmployee, setReportingLine } from '../core/org';
import {
  decideProfileChange,
  listProfileChangeRequests,
  myProfileChangeRequests,
  pendingProfileChangeCountsByKey,
  requestProfileChange,
  withdrawProfileChangesForLockedFields,
} from '../core/profile';
import {
  TenantSettingError,
  profileChangeAllowedKeys,
  profileChangeApprover,
  setTenantSetting,
} from '../core/tenant-settings';
import {
  PROFILE_REQUESTABLE_KEYS,
  PROFILE_REQUEST_APPROVERS,
  PROFILE_REQUEST_APPROVER_SETTING_KEY,
  PROFILE_REQUEST_FIELDS_SETTING_KEY,
  offeredRequestableFieldsForTab,
  requestableFieldsForTab,
  resolveAllowedRequestKeys,
  resolveRequestApprover,
} from '../lib/profile-requestable-fields';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { employeeStatutoryMy, person, profileChangeRequest, tenantSetting } from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

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

/**
 * A GROUP-admin principal, spelled out.
 *
 * `adminCtx` carries `roles: ['hr_admin']` and no `grants`, which `withTenant` expands to a group-wide
 * grant for the DATABASE — so `app.is_group_admin()` has always answered true for it. The TypeScript
 * mirror `isGroupAdmin(s)` reads `s.grants` directly (a company-scoped hr_admin must not pass), so a
 * context that leaves it undefined is refused by the service before the policy is ever consulted. The
 * grant is therefore stated rather than inherited, which is also what a real session carries.
 */
function groupAdminCtx(): SessionContext {
  return { ...adminCtx(b), grants: [{ role: 'hr_admin', companyId: null }] };
}

/** A plain employee principal — spread from adminCtx for the entitlement snapshot, then overridden. */
async function employeeCtx(personId: string, role: 'employee' | 'manager' = 'employee'): Promise<SessionContext> {
  const userId = await createAppUser(b.tenantId, personId, role);
  return { ...adminCtx(b), userId, personId, roles: [role] };
}

/** The two master tables' columns this file can reach, read as the OWNER (no RLS). */
async function masterSnapshot(personId: string) {
  const [p] = await owner.db
    .select({ fullName: person.fullName, preferredName: person.preferredName, gender: person.gender })
    .from(person)
    .where(eq(person.id, personId));
  const [s] = await owner.db
    .select({ bankName: employeeStatutoryMy.bankName, bankAccountNo: employeeStatutoryMy.bankAccountNo })
    .from(employeeStatutoryMy)
    .where(eq(employeeStatutoryMy.personId, personId));
  return { person: p ?? null, statutory: s ?? null };
}

/** Write the field allow-list the way the settings screen does — through the real, policy-fenced writer. */
async function allowOnly(keys: readonly string[]) {
  await setTenantSetting(groupAdminCtx(), { key: PROFILE_REQUEST_FIELDS_SETTING_KEY, value: keys });
}

/** Re-read the tenant's settings into a fresh snapshot, exactly as the next request would. */
async function freshCtx(base: SessionContext): Promise<SessionContext> {
  // The RESOLVER'S OWN settings subselect (core/entitlements.ts snapshotQuery), narrowed to this
  // tenant and read as the OWNER — so the fixture is about what was STORED, never about what some
  // session is allowed to see, and a test cannot pass on a value the real resolver would not fold in.
  const rows = await owner.db.execute(sql`
      SELECT coalesce(json_object_agg(ts.key, ts.value), '{}'::json) AS settings
        FROM tenant_setting ts JOIN setting_definition sd ON sd.key = ts.key
       WHERE ts.tenant_id = ${b.tenantId}::uuid AND (sd.scope = 'tenant' OR ts.source <> 'customer')`);
  const settings = (rows as unknown as { settings: Record<string, unknown> }[])[0]?.settings ?? {};
  return { ...base, entitlements: { ...base.entitlements!, settings } };
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

describe('r261 — the field allow-list, resolved', () => {
  it('an unconfigured tenant keeps stage two: every declared field, and the setting says so in one place', () => {
    // The SENTINEL, not a baked list. `'all'` is the catalog default and it means "this tenant never
    // configured it", which must resolve to the declaration itself — a tenant who has not opened the
    // screen cannot silently lose a feature they already have.
    expect([...resolveAllowedRequestKeys('all')].sort()).toEqual([...PROFILE_REQUESTABLE_KEYS].sort());
    expect([...resolveAllowedRequestKeys(undefined)].sort()).toEqual([...PROFILE_REQUESTABLE_KEYS].sort());
    // A CONFIGURED tenant is honoured exactly, including the empty configuration.
    expect([...resolveAllowedRequestKeys(['fullName', 'gender'])].sort()).toEqual(['fullName', 'gender']);
    expect([...resolveAllowedRequestKeys([])]).toEqual([]);
    // A key for a field the declaration no longer carries cannot resurrect it.
    expect([...resolveAllowedRequestKeys(['fullName', 'costCentre', 'blacklisted'])]).toEqual(['fullName']);
  });

  it('the approver value resolves to the SHIPPED DEFAULT, never to something wider', () => {
    expect(resolveRequestApprover('group_admin')).toBe('group_admin');
    expect(resolveRequestApprover('admin')).toBe('admin');
    // Anything else lands on `admin` — the catalog default and stage two's behaviour, which is neither
    // wider nor narrower than what a tenant that never configured this already has. In particular
    // `manager` is NOT a value: approving writes the master record and person_rls admits only an admin.
    for (const junk of [undefined, null, '', 'GROUP_ADMIN', 'manager', 'anyone', 42, ['group_admin']]) {
      expect(resolveRequestApprover(junk), `${JSON.stringify(junk)} must not become an approver rule`).toBe('admin');
    }
    expect(PROFILE_REQUEST_APPROVERS).toEqual(['admin', 'group_admin']);
  });

  it('a field that is not allowed is OMITTED from the tab, not offered disabled', () => {
    /**
     * THE PROPERTY THE PLAN'S SAFETY ARGUMENT RESTS ON, at the level the card renders from. A disabled
     * control still tells an employee the field exists and that somebody decided they may not touch it,
     * and it is one removed attribute away from being submittable.
     *
     * NON-VACUITY: reverting `offeredRequestableFieldsForTab` to `requestableFieldsForTab` in
     * app/me/request-change-card.tsx makes the length assertion below fail with the full declared count.
     */
    const allowed = new Set(['fullName']);
    const offered = offeredRequestableFieldsForTab('profile', allowed);
    expect(offered.map((f) => f.key)).toEqual(['fullName']);
    expect(offered.length).toBeLessThan(requestableFieldsForTab('profile').length);
    // And a tab with nothing allowed offers NOTHING — the card renders no form at all.
    expect(offeredRequestableFieldsForTab('bankStatutory', allowed)).toEqual([]);
  });
});

describe('r261 — the setting is written through the policy-fenced writer', () => {
  it('a group admin stores the array; the resolved permission is what was stored', async () => {
    await allowOnly(['fullName', 'preferredName']);
    const s = await freshCtx(adminCtx(b));
    expect([...profileChangeAllowedKeys(s)].sort()).toEqual(['fullName', 'preferredName']);
    // Provenance follows the write (0313): a customer switch must never claim the platform made it.
    const [row] = await owner.db
      .select({ value: tenantSetting.value, source: tenantSetting.source })
      .from(tenantSetting)
      .where(eq(tenantSetting.key, PROFILE_REQUEST_FIELDS_SETTING_KEY));
    expect(row.value).toEqual(['fullName', 'preferredName']);
    expect(row.source).toBe('customer');
  });

  it('refuses a NON-group admin, and refuses a value of the wrong shape', async () => {
    // A company-scoped hr_admin is deliberately not enough: this is a tenant-wide policy.
    const companyAdmin: SessionContext = { ...adminCtx(b), grants: [{ role: 'hr_admin', companyId: b.companyId }] };
    await expect(
      setTenantSetting(companyAdmin, { key: PROFILE_REQUEST_FIELDS_SETTING_KEY, value: ['fullName'] }),
    ).rejects.toBeInstanceOf(TenantSettingError);
    // A json-typed key refuses a scalar, and a string-typed key refuses a list — the same typed refusal
    // a mistyped boolean has always produced, now over the two new value shapes.
    await expect(
      setTenantSetting(groupAdminCtx(), { key: PROFILE_REQUEST_FIELDS_SETTING_KEY, value: 'fullName' }),
    ).rejects.toMatchObject({ reason: 'wrong_type' });
    await expect(
      setTenantSetting(groupAdminCtx(), { key: PROFILE_REQUEST_APPROVER_SETTING_KEY, value: ['manager'] }),
    ).rejects.toMatchObject({ reason: 'wrong_type' });
  });
});

describe('r261 — a switched-off field cannot be asked about, however you ask', () => {
  it('THE SERVICE DROPS A DISALLOWED KEY EVEN WHEN IT IS POSTED BY HAND', async () => {
    /**
     * The screen renders no control for a switched-off field, which stops an employee. This is the case
     * about somebody who is not using the screen: the key is put straight into `proposed`.
     *
     * NON-VACUITY: reverting `if (!allowed.has(key)) continue;` in core/profile.ts sanitizeProposed
     * makes the first expectation below resolve instead of reject, and the second find a stored row.
     */
    const a = adminCtx(b);
    const E = await hire('Locked');
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101010111', bankName: 'OldBank', bankAccountNo: '111122223333' });
    await allowOnly(['preferredName']); // bank is OFF
    const emp = await freshCtx(await employeeCtx(E.personId));

    await expect(
      requestProfileChange(emp, {
        employmentId: E.employmentId,
        proposed: { bankName: 'NewBank', bankAccountNo: '999988887777' },
      }),
    ).rejects.toThrow(/Nothing to change/);

    const rows = await owner.db.select().from(profileChangeRequest);
    expect(rows, 'a request for a switched-off field must not be stored at all').toEqual([]);
  });

  it('a mixed proposal keeps ONLY the allowed half, and the approver is never shown the rest', async () => {
    const a = adminCtx(b);
    const E = await hire('Mixed');
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101010112', bankName: 'OldBank', bankAccountNo: '111122223333' });
    await allowOnly(['preferredName']);
    const emp = await freshCtx(await employeeCtx(E.personId));

    const { requestId } = await requestProfileChange(emp, {
      employmentId: E.employmentId,
      proposed: { preferredName: 'Ren', gender: 'female', bankName: 'NewBank', bankAccountNo: '999988887777' },
    });
    const [row] = await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id, requestId));
    expect(Object.keys(row.proposed as Record<string, unknown>)).toEqual(['preferredName']);
  });

  it('an empty configuration means an employee may ask for nothing at all', async () => {
    const E = await hire('Nothing');
    await allowOnly([]);
    const emp = await freshCtx(await employeeCtx(E.personId));
    // `[]` is a configured value, not an absent one — the sentinel is the string 'all'.
    expect([...profileChangeAllowedKeys(emp)]).toEqual([]);
    await expect(
      requestProfileChange(emp, { employmentId: E.employmentId, proposed: { preferredName: 'Nobody' } }),
    ).rejects.toThrow(/Nothing to change/);
  });
});

describe('r261 — switching a field off, with a request already waiting on it', () => {
  it('REFUSES THE WAITING REQUEST WITH A REASON, APPLIES NOTHING, AND DESTROYS NOTHING', async () => {
    /**
     * THE BLOCKER THIS ROUND COULD PRODUCE, asked directly. A request that quietly applied after its
     * field was locked would be the master record changed by a permission that no longer exists; a
     * request that vanished would be an employee never told what became of what they asked for.
     *
     * NON-VACUITY: deleting the `.set({ status: 'rejected', … })` update in
     * withdrawProfileChangesForLockedFields leaves the row `pending`, which fails the status assertion
     * AND makes the "cannot be approved afterwards" case below resolve instead of reject.
     */
    const a = adminCtx(b);
    const E = await hire('Waiting');
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101010113', bankName: 'OldBank', bankAccountNo: '111122223333' });
    const emp = await freshCtx(await employeeCtx(E.personId));
    const { requestId } = await requestProfileChange(emp, {
      employmentId: E.employmentId,
      proposed: { bankName: 'NewBank', bankAccountNo: '999988887777' },
    });
    const before = await masterSnapshot(E.personId);

    // The screen shows the cost BEFORE the switch is thrown, so the count is part of the contract.
    const counts = await pendingProfileChangeCountsByKey(groupAdminCtx());
    expect(counts.get('bankName')).toBe(1);
    expect(counts.get('bankAccountNo')).toBe(1);

    await allowOnly(PROFILE_REQUESTABLE_KEYS.filter((k) => k !== 'bankName' && k !== 'bankAccountNo'));
    const { withdrawn } = await withdrawProfileChangesForLockedFields(groupAdminCtx(), {
      lockedKeys: ['bankName', 'bankAccountNo'],
      reason: 'This field is no longer open to change requests.',
    });
    expect(withdrawn).toBe(1);

    const [row] = await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id, requestId));
    expect(row.status, 'refused, not left pending and not applied').toBe('rejected');
    expect(row.decisionReason).toBe('This field is no longer open to change requests.');
    // Nobody judged it, so nobody is recorded as having judged it.
    expect(row.decidedByEmploymentId).toBeNull();
    // NOTHING WAS DESTROYED: the row and what was asked for both survive, which is what makes the
    // employee's own screen able to explain what happened.
    expect(Object.keys(row.proposed as Record<string, unknown>).sort()).toEqual(['bankAccountNo', 'bankName']);
    // AND NOTHING WAS APPLIED.
    expect(await masterSnapshot(E.personId)).toEqual(before);

    // The employee reads the reason on their own screen — stage two's surface, doing this round's job.
    const mine = await myProfileChangeRequests(emp);
    expect(mine[0].status).toBe('rejected');
    expect(mine[0].decisionReason).toBe('This field is no longer open to change requests.');

    // And it can never be approved afterwards: the state machine has already closed it.
    await expect(decideProfileChange(a, { requestId, decision: 'approved' })).rejects.toThrow(/already rejected/);
    expect(await masterSnapshot(E.personId)).toEqual(before);
  });

  it('leaves a request on a field that is still open completely alone', async () => {
    const E = await hire('Untouched');
    const emp = await freshCtx(await employeeCtx(E.personId));
    const { requestId } = await requestProfileChange(emp, {
      employmentId: E.employmentId,
      proposed: { preferredName: 'Still Open' },
    });
    const { withdrawn } = await withdrawProfileChangesForLockedFields(groupAdminCtx(), {
      lockedKeys: ['bankName', 'bankAccountNo'],
      reason: 'Locked.',
    });
    expect(withdrawn).toBe(0);
    const [row] = await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id, requestId));
    expect(row.status).toBe('pending');
    expect(row.decisionReason).toBeNull();
  });

  it('only a group admin may carry out the consequence of the setting', async () => {
    const E = await hire('NotYours');
    const emp = await employeeCtx(E.personId);
    await expect(
      withdrawProfileChangesForLockedFields(emp, { lockedKeys: ['bankName'], reason: 'x' }),
    ).rejects.toThrow(/group administrator/);
  });
});

describe('r261 — who approves, and the two things that setting must never do', () => {
  /** A company-scoped HR administrator: an admin, but NOT a group admin. */
  async function companyAdminCtx(personId: string): Promise<SessionContext> {
    const userId = await createAppUser(b.tenantId, personId, 'hr_admin');
    return {
      ...adminCtx(b),
      userId,
      personId,
      roles: ['hr_admin'],
      grants: [{ role: 'hr_admin', companyId: b.companyId }],
    };
  }

  /** ICs are uniquely indexed per tenant, so each fixture needs its own valid 12-digit number. */
  let icSeq = 0;
  const nextIc = () => `90010101${String(1000 + (icSeq += 1)).slice(-4)}`;

  async function pendingRequestFor(name: string) {
    const a = adminCtx(b);
    const E = await hire(name);
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: nextIc(), bankName: 'OldBank', bankAccountNo: '111122223333' });
    const emp = await freshCtx(await employeeCtx(E.personId));
    const { requestId } = await requestProfileChange(emp, {
      employmentId: E.employmentId,
      proposed: { preferredName: 'Renamed' },
    });
    return { E, emp, requestId };
  }

  it("DEFAULT: any HR administrator decides — stage two's authority, unchanged", async () => {
    const { E, requestId } = await pendingRequestFor('Default');
    const localAdmin = await freshCtx(await companyAdminCtx((await hire('LocalHr')).personId));
    expect(profileChangeApprover(localAdmin)).toBe('admin');
    await decideProfileChange(localAdmin, { requestId, decision: 'approved' });
    const [p] = await owner.db.select().from(person).where(eq(person.id, E.personId));
    expect(p.preferredName).toBe('Renamed');
  });

  it("'group_admin' NARROWS it: the company-scoped administrator is refused, and nothing applies", async () => {
    /**
     * NON-VACUITY: deleting the `profileChangeApprover(ctx) === 'group_admin' && !isGroupAdmin(ctx)`
     * branch in core/profile.ts makes this decide RESOLVE, and the master column below reads 'Renamed'
     * instead of null — i.e. the setting would be a switch that changes nothing.
     */
    const { E, requestId } = await pendingRequestFor('Narrowed');
    await setTenantSetting(groupAdminCtx(), { key: PROFILE_REQUEST_APPROVER_SETTING_KEY, value: 'group_admin' });
    const localAdmin = await freshCtx(await companyAdminCtx((await hire('LocalHr2')).personId));
    expect(profileChangeApprover(localAdmin)).toBe('group_admin');

    await expect(decideProfileChange(localAdmin, { requestId, decision: 'approved' })).rejects.toThrow(
      /group administrator/,
    );
    const [p] = await owner.db.select().from(person).where(eq(person.id, E.personId));
    expect(p.preferredName, 'a refused decide applies nothing').toBeNull();
    const [row] = await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id, requestId));
    expect(row.status, 'and leaves the request waiting for someone who may decide it').toBe('pending');

    // …and the group administrator the tenant nominated still can.
    const groupAdmin = await freshCtx(groupAdminCtx());
    await decideProfileChange(groupAdmin, { requestId, decision: 'approved' });
    const [after] = await owner.db.select().from(person).where(eq(person.id, E.personId));
    expect(after.preferredName).toBe('Renamed');
  });

  it('IT CAN ONLY NARROW — no configuration lets a manager or an employee decide', async () => {
    /**
     * The adversarial form of the setting's own claim. Approving WRITES the master record and
     * `person_rls` admits only `app.is_admin()`, so a non-admin approver would pass a service guard and
     * then be refused by Postgres mid-transaction. Both values of the setting are therefore
     * administrators, and this case asks the question under BOTH of them.
     */
    const { E, requestId } = await pendingRequestFor('NeverWider');
    const boss = await hire('Boss');
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: boss.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    const bossCtx = await freshCtx(await employeeCtx(boss.personId, 'manager'));
    const colleague = await freshCtx(await employeeCtx((await hire('Colleague')).personId));

    for (const value of ['admin', 'group_admin'] as const) {
      await setTenantSetting(groupAdminCtx(), { key: PROFILE_REQUEST_APPROVER_SETTING_KEY, value });
      const boss2 = await freshCtx(bossCtx);
      const colleague2 = await freshCtx(colleague);
      // The subject's own administrative manager: visible to them, and still not theirs to decide.
      await expect(
        decideProfileChange(boss2, { requestId, decision: 'approved' }),
        `manager must not decide under '${value}'`,
      ).rejects.toThrow(/Only an admin can approve/);
      // A colleague: refused before the row is even readable.
      await expect(
        decideProfileChange(colleague2, { requestId, decision: 'approved' }),
        `a colleague must not decide under '${value}'`,
      ).rejects.toThrow();
    }
    const [p] = await owner.db.select().from(person).where(eq(person.id, E.personId));
    expect(p.preferredName).toBeNull();
  });

  it('NOBODY DECIDES THEIR OWN REQUEST, under either setting', async () => {
    /**
     * `assertCanDecide`'s self-ban runs BEFORE any role or setting is consulted, which is why it is the
     * floor rather than a branch of the ceiling — and why the answer cannot depend on the configuration.
     * (The one documented exception, untouched by this round, is `super_admin`'s sole-admin escape
     * hatch, which exists so a one-person company is not locked out of its own approvals.)
     */
    const selfPerson = await hire('SelfServing');
    const selfAdmin: SessionContext = {
      ...adminCtx(b),
      userId: await createAppUser(b.tenantId, selfPerson.personId, 'hr_admin'),
      personId: selfPerson.personId,
      roles: ['hr_admin'],
      grants: [{ role: 'hr_admin', companyId: null }],
    };
    const { requestId } = await requestProfileChange(await freshCtx(selfAdmin), {
      employmentId: selfPerson.employmentId,
      proposed: { preferredName: 'Myself' },
    });
    for (const value of ['admin', 'group_admin'] as const) {
      await setTenantSetting(groupAdminCtx(), { key: PROFILE_REQUEST_APPROVER_SETTING_KEY, value });
      await expect(
        decideProfileChange(await freshCtx(selfAdmin), { requestId, decision: 'approved' }),
        `self-approval must be banned under '${value}'`,
      ).rejects.toThrow(/cannot decide your own/);
    }
    const [p] = await owner.db.select().from(person).where(eq(person.id, selfPerson.personId));
    expect(p.preferredName, 'nothing applied').toBeNull();
  });

  it('NEITHER SETTING WIDENS WHO CAN SEE SOMEBODY ELSE\'S REQUEST', async () => {
    /**
     * The visibility half, asked under BOTH values. The setting moves the AUTHORITY line and must leave
     * the VISIBILITY line exactly where `profile_change_request_rls` (0029, `app.can_see_employment`)
     * put it — asserted through the queue AND by asking for the row by its own id, which is the stronger
     * form of the question because it bypasses every filter a screen applies.
     */
    const { requestId } = await pendingRequestFor('Private');
    const colleague = await freshCtx(await employeeCtx((await hire('Nosy')).personId));
    for (const value of ['admin', 'group_admin'] as const) {
      await setTenantSetting(groupAdminCtx(), { key: PROFILE_REQUEST_APPROVER_SETTING_KEY, value });
      const c = await freshCtx(colleague);
      expect(await listProfileChangeRequests(c, { status: 'pending' }), `queue under '${value}'`).toEqual([]);
      const direct = await withTenant(c, (tx) =>
        tx.select().from(profileChangeRequest).where(eq(profileChangeRequest.id, requestId)),
      );
      expect(direct, `RLS, not a filter on a screen ('${value}')`).toEqual([]);
      // Their OWN history is still their own, and it is empty rather than everybody's.
      expect(await myProfileChangeRequests(c)).toEqual([]);
    }
  });

  it('ONE approver, not a first level — the decision ends the request', async () => {
    // The plan sold single-level approval and invited a rejection if the reporter wanted multi-level.
    const { requestId } = await pendingRequestFor('Single');
    await setTenantSetting(groupAdminCtx(), { key: PROFILE_REQUEST_APPROVER_SETTING_KEY, value: 'group_admin' });
    await decideProfileChange(await freshCtx(groupAdminCtx()), { requestId, decision: 'approved' });
    const [row] = await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id, requestId));
    expect(row.status, 'approved outright — no second step, no intermediate state').toBe('approved');
    await expect(
      decideProfileChange(await freshCtx(groupAdminCtx()), { requestId, decision: 'rejected', reason: 'again' }),
    ).rejects.toThrow(/already approved/);
  });
});
