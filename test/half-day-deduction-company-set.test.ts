/**
 * 10e96227 — the half-day-deduction rule is saved as a SET of companies, in one post.
 *
 * The screen changed from N rows with N Saves to one multi-select with one Save. The stored shape did not
 * change (still `company.leave_half_day_full_deduction`, one boolean per company), so the risk is not in
 * the column — it is in the new authority the write has acquired. A post now says what should be TRUE and
 * everything else becomes FALSE, and that is a far sharper instrument than the old one-row toggle.
 *
 * Three things are pinned here, and only the first is obvious:
 *
 *  1. the set semantics — selected on, unselected off, empty means nowhere;
 *  2. THE SCOPE, which is `app.is_admin_for` and not "every company in the tenant". A company-scoped admin
 *     must not be able to turn a company they cannot administer off merely by omitting it from their post.
 *     This is the assertion that would catch a well-meaning refactor replacing the SQL-resolved candidate
 *     set with the posted ids;
 *  3. the audit trail — one event per company that actually MOVED, and none for the untouched, so the
 *     trail keeps showing changes rather than saves.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { setLeaveHalfDayFullDeductionCompanies } from '../core/admin';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
/** A second company in the same tenant — the set semantics are invisible with only one. */
let companyB: string;

beforeAll(async () => {
  await migrateTestDb();
});

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [c2] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Acme Two Sdn Bhd' })
    .returning({ id: schema.company.id });
  companyB = c2.id;
});

afterAll(closeAll);

const flagOf = async (companyId: string): Promise<boolean> => {
  const [row] = await owner.db
    .select({ v: schema.company.leaveHalfDayFullDeduction })
    .from(schema.company)
    .where(eq(schema.company.id, companyId));
  return !!row?.v;
};

const changeEventsFor = async (companyId: string) =>
  owner.db
    .select({ payload: schema.domainEvent.payload })
    .from(schema.domainEvent)
    .where(
      and(
        eq(schema.domainEvent.aggregateId, companyId),
        eq(schema.domainEvent.eventType, 'company.leave-half-day-deduction.changed'),
      ),
    );

/**
 * An hr_admin scoped to ONE company.
 *
 * The scope that RLS actually reads is `ctx.grants` — db/client.ts serialises it into the `app.grants`
 * GUC, and `app.has_role_for` resolves against that, NOT against role_assignment rows. A context carrying
 * only `roles` is widened to GROUP-WIDE grants (companyId null) for backward compatibility, which is what
 * the harness's `adminCtx` is. So the grant must be stated here explicitly; seeding a scoped
 * role_assignment row alone would leave the caller group-wide and the scope assertions would pass
 * vacuously.
 */
async function scopedAdminCtx(tenantId: string, companyId: string): Promise<SessionContext> {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId, fullName: 'Scoped Admin', primaryEmail: `sa_${randomUUID().slice(0, 8)}@t.local` })
    .returning({ id: schema.person.id });
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
  return { ...adminCtx(b), userId: u.id, grants: [{ role: 'hr_admin', companyId }] };
}

describe('10e96227 · half-day deduction saved as a company set', () => {
  it('turns the selected companies on and leaves the rest off', async () => {
    const res = await setLeaveHalfDayFullDeductionCompanies(adminCtx(b), { companyIds: [b.companyId] });

    expect(await flagOf(b.companyId)).toBe(true);
    expect(await flagOf(companyB)).toBe(false);
    expect(res.enabled).toEqual([b.companyId]);
    expect(res.disabled).toEqual([]);
  });

  it('turns OFF a company omitted from a later post — the post is the whole decision', async () => {
    await setLeaveHalfDayFullDeductionCompanies(adminCtx(b), { companyIds: [b.companyId, companyB] });
    expect(await flagOf(b.companyId)).toBe(true);
    expect(await flagOf(companyB)).toBe(true);

    const res = await setLeaveHalfDayFullDeductionCompanies(adminCtx(b), { companyIds: [companyB] });

    expect(await flagOf(b.companyId)).toBe(false);
    expect(await flagOf(companyB)).toBe(true);
    expect(res.disabled).toEqual([b.companyId]);
  });

  it('an EMPTY selection turns the rule off everywhere — "applies nowhere" must stay reachable', async () => {
    await setLeaveHalfDayFullDeductionCompanies(adminCtx(b), { companyIds: [b.companyId, companyB] });

    const res = await setLeaveHalfDayFullDeductionCompanies(adminCtx(b), { companyIds: [] });

    expect(await flagOf(b.companyId)).toBe(false);
    expect(await flagOf(companyB)).toBe(false);
    expect(res.disabled.sort()).toEqual([b.companyId, companyB].sort());
  });

  it('appends ONE event per company that moved, and none for the unchanged', async () => {
    await setLeaveHalfDayFullDeductionCompanies(adminCtx(b), { companyIds: [b.companyId] });
    // Re-post the identical set: nothing moved, so nothing should be appended.
    const second = await setLeaveHalfDayFullDeductionCompanies(adminCtx(b), { companyIds: [b.companyId] });

    expect(second.enabled).toEqual([]);
    expect(second.disabled).toEqual([]);
    expect(second.unchanged).toBe(2);

    const events = await changeEventsFor(b.companyId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ before: false, after: true });
  });

  it('a company-scoped admin cannot turn OFF a company it does not administer by omitting it', async () => {
    // Both on, set by the group admin.
    await setLeaveHalfDayFullDeductionCompanies(adminCtx(b), { companyIds: [b.companyId, companyB] });

    // An admin for companyB only re-states the set as "just companyB". b.companyId is absent from the
    // post, but it is also outside this admin's authority, so it must NOT be turned off.
    const scoped = await scopedAdminCtx(b.tenantId, companyB);
    const res = await setLeaveHalfDayFullDeductionCompanies(scoped, { companyIds: [companyB] });

    expect(await flagOf(companyB)).toBe(true);
    expect(await flagOf(b.companyId), 'a company outside the caller’s admin scope was silently disabled').toBe(
      true,
    );
    expect(res.disabled).toEqual([]);
  });

  it('a company-scoped admin cannot turn ON a company it does not administer by naming it', async () => {
    const scoped = await scopedAdminCtx(b.tenantId, companyB);
    const res = await setLeaveHalfDayFullDeductionCompanies(scoped, { companyIds: [b.companyId, companyB] });

    expect(await flagOf(companyB)).toBe(true);
    expect(await flagOf(b.companyId), 'a hand-crafted post reached outside the caller’s admin scope').toBe(
      false,
    );
    expect(res.enabled).toEqual([companyB]);
  });
});
