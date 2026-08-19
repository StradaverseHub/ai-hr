/**
 * 5f2e20fb — Start date / End date / Leave type filters on the employee's own My Leave History.
 *
 * The control and the read both already existed: components/filter-panel.tsx is in daily use on three HR
 * leave screens, and core/read.ts listLeaveRequestsPage already implements every filter this item asks for
 * (leaveTypeIds as a multi inArray, from/to with OVERLAP semantics on the leave dates). What did not exist
 * was the two of them meeting on /leave — and, underneath, a self-NARROWED history read at all: the page
 * used to load the scope-wide flat list capped at 200 rows and then keep the viewer's own, so a manager's
 * subordinates filled the cap and the manager's own older records fell off the bottom before the filter ran.
 *
 * So what is proven here is the SELF-NARROWED read behaving as the reporter's filter table says, and the
 * fence around it. test/leave-filters.test.ts already proves the same filters over the admin surface; this
 * file does not re-prove the SQL, it proves the shape /leave now calls it in.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { listLeaveRequestsPage, myEmploymentIdsAll } from '../core/read';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

let b: Base;
let me: { employmentId: string; personId: string };
let myCtx: SessionContext;
let other: { employmentId: string; personId: string };
let sickTypeId: string;
/** ANNUAL 2026-07-05→07 · ANNUAL 2026-08-10→12 · SICK 2026-06-28→07-01 (spans a month boundary). */
let annualJul: string;
let annualAug: string;
let sickJun: string;

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `hf_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

async function insertReq(p: { employmentId: string; leaveTypeId: string; start: string; end: string }) {
  const [row] = await owner.db
    .insert(schema.leaveRequest)
    .values({
      tenantId: b.tenantId,
      employmentId: p.employmentId,
      leaveTypeId: p.leaveTypeId,
      startDate: p.start,
      endDate: p.end,
      days: '1',
      status: 'approved',
    })
    .returning({ id: schema.leaveRequest.id });
  return row.id;
}

/** Exactly the call app/leave/page.tsx now makes for the rendered rows. */
const history = async (
  ctx: SessionContext,
  employmentIds: string[],
  f: { leaveTypeIds?: string[]; from?: string; to?: string } = {},
) =>
  listLeaveRequestsPage(ctx, {
    employmentIds,
    leaveTypeIds: f.leaveTypeIds?.length ? f.leaveTypeIds : undefined,
    from: f.from,
    to: f.to,
    sort: 'start',
    dir: 'desc',
    limit: 200,
    offset: 0,
  });

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  me = await hire('History Mine');
  other = await hire('History Theirs');
  const uMe = await createAppUser(b.tenantId, me.personId, 'employee');
  myCtx = { tenantId: b.tenantId, userId: uMe, roles: ['employee'], personId: me.personId };
  const [sick] = await owner.db
    .insert(schema.leaveType)
    .values({
      allowNegativeBalance: true,
      tenantId: b.tenantId,
      code: `SICK_${randomUUID().slice(0, 6).toUpperCase()}`,
      name: 'Sick',
      paid: true,
      counting: 'calendar_days',
    })
    .returning({ id: schema.leaveType.id });
  sickTypeId = sick.id;

  annualJul = await insertReq({ employmentId: me.employmentId, leaveTypeId: b.annualLeaveTypeId, start: '2026-07-05', end: '2026-07-07' });
  annualAug = await insertReq({ employmentId: me.employmentId, leaveTypeId: b.annualLeaveTypeId, start: '2026-08-10', end: '2026-08-12' });
  sickJun = await insertReq({ employmentId: me.employmentId, leaveTypeId: sickTypeId, start: '2026-06-28', end: '2026-07-01' });
  await insertReq({ employmentId: other.employmentId, leaveTypeId: b.annualLeaveTypeId, start: '2026-07-05', end: '2026-07-07' });
});

describe('5f2e20fb · the filter table the reporter wrote out, on the self-narrowed read', () => {
  it('unfiltered: every one of the viewer’s own records, newest leave first', async () => {
    const { rows, total } = await history(myCtx, [me.employmentId]);
    expect(total).toBe(3);
    expect(rows.map((r) => r.id)).toEqual([annualAug, annualJul, sickJun]);
  });

  it('Start Date only → from that date onwards', async () => {
    const { rows } = await history(myCtx, [me.employmentId], { from: '2026-07-06' });
    // annualJul (05→07) still OVERLAPS 06-Jul onwards, which is the point of overlap semantics.
    expect(rows.map((r) => r.id).sort()).toEqual([annualAug, annualJul].sort());
  });

  it('End Date only → up to that date', async () => {
    const { rows } = await history(myCtx, [me.employmentId], { to: '2026-07-01' });
    expect(rows.map((r) => r.id)).toEqual([sickJun]);
  });

  it('Start + End → inside the range, and a leave spanning the month boundary is caught', async () => {
    const { rows } = await history(myCtx, [me.employmentId], { from: '2026-07-01', to: '2026-07-31' });
    expect(rows.map((r) => r.id).sort()).toEqual([annualJul, sickJun].sort());
    expect(rows.map((r) => r.id)).not.toContain(annualAug);
  });

  it('Multiple leave types → records matching ANY of them', async () => {
    const both = await history(myCtx, [me.employmentId], { leaveTypeIds: [b.annualLeaveTypeId, sickTypeId] });
    expect(both.rows).toHaveLength(3);
    const sickOnly = await history(myCtx, [me.employmentId], { leaveTypeIds: [sickTypeId] });
    expect(sickOnly.rows.map((r) => r.id)).toEqual([sickJun]);
  });

  it('Date + Leave Type → both conditions together', async () => {
    const { rows } = await history(myCtx, [me.employmentId], {
      leaveTypeIds: [b.annualLeaveTypeId],
      from: '2026-07-01',
      to: '2026-07-31',
    });
    expect(rows.map((r) => r.id)).toEqual([annualJul]);
  });

  it('the "Showing 1 of 3" arithmetic: the unfiltered total is what the header counts against', async () => {
    const all = await history(myCtx, [me.employmentId]);
    const filtered = await history(myCtx, [me.employmentId], { leaveTypeIds: [sickTypeId] });
    expect(all.total).toBe(3);
    expect(filtered.rows).toHaveLength(1);
    // A filter that matches nothing is an empty list, not an error — the card says so in words.
    const none = await history(myCtx, [me.employmentId], { from: '2030-01-01' });
    expect(none.rows).toHaveLength(0);
    expect(none.total).toBe(0);
  });
});

describe('5f2e20fb · the fence: this is MY history', () => {
  it('another employee’s records never appear, filtered or not', async () => {
    for (const f of [{}, { from: '2026-07-01', to: '2026-07-31' }, { leaveTypeIds: [b.annualLeaveTypeId] }]) {
      const { rows } = await history(myCtx, [me.employmentId], f);
      for (const r of rows) expect(r.employmentId).toBe(me.employmentId);
    }
  });

  it('a MANAGER sees only their own rows here, even though RLS lets them read a subordinate’s', async () => {
    // This is the half the old personId post-filter did in JavaScript. Done in SQL it also fixes the
    // 200-row cap, which used to be spent on rows this list then threw away.
    const mgrRows = await history(adminCtx(b), [me.employmentId]);
    expect(mgrRows.rows.every((r) => r.employmentId === me.employmentId)).toBe(true);
    expect(mgrRows.total).toBe(3);
  });

  it('a REHIRED person keeps their earlier employment’s records — myEmploymentIdsAll, not [me.employmentId]', async () => {
    // A second employment for the same person, with a record of its own.
    const [second] = await owner.db
      .insert(schema.employment)
      .values({
        tenantId: b.tenantId,
        personId: me.personId,
        companyId: b.companyId,
        // hiredOn is the only NOT NULL date; employment_type lives on `assignment`, not here, and this
        // employment needs no assignment — the read joins employment + person, never assignment.
        hiredOn: '2020-01-01',
        terminatedOn: '2023-12-31',
      })
      .returning({ id: schema.employment.id });
    const older = await insertReq({
      employmentId: second.id,
      leaveTypeId: b.annualLeaveTypeId,
      start: '2022-03-01',
      end: '2022-03-02',
    });

    const ids = (await myEmploymentIdsAll(myCtx)).map((e) => e.employmentId);
    expect(ids).toContain(second.id);
    expect(ids).toContain(me.employmentId);
    const both = await history(myCtx, ids);
    expect(both.rows.map((r) => r.id)).toContain(older);
    // …and narrowing to the current employment alone is exactly what would have lost it.
    const currentOnly = await history(myCtx, [me.employmentId]);
    expect(currentOnly.rows.map((r) => r.id)).not.toContain(older);
  });
});

describe('5f2e20fb · only the history box is affected (source shape)', () => {
  const page = read('app/leave/page.tsx');

  it('no section above the history read touches hFrom / hTo / hType', () => {
    // The item is explicit: balances, entitlement breakdowns and the secondary groups are untouched. They
    // are all resolved ABOVE the history read on this page, so the slice is the assertion.
    const bodyAt = page.indexOf('const { s: session, scopeIds } = await scopedSession();');
    const historyAt = page.indexOf("// History: the viewer's OWN requests");
    expect(bodyAt).toBeGreaterThan(-1);
    expect(historyAt).toBeGreaterThan(bodyAt);
    const beforeHistory = page.slice(bodyAt, historyAt);
    for (const p of ['hFrom', 'hTo', 'hType']) {
      expect(beforeHistory.includes(p), `${p} must not reach the balance/entitlement reads`).toBe(false);
    }
    // The as-at date the balance table owns is untouched by the history filter, and rides along as a
    // hidden input so applying a filter cannot reset it.
    expect(page).toContain("['asOf', sp.asOf]");
  });

  it('the tick-list options come from the UNFILTERED read, or they vanish on first use', () => {
    expect(page).toContain('new Map(historyAll.rows.map((r) => [r.leaveTypeId, r.leaveType]))');
    expect(page).not.toContain('new Map(historyShown.rows.map(');
  });
});
