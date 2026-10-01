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
  const page = read('components/leave/own-leave-history.tsx');

  it('no section above the history read touches hFrom / hTo / hType', () => {
    // The item is explicit: balances, entitlement breakdowns and the secondary groups are untouched. They
    // are all resolved ABOVE the history read on this page, so the slice is the assertion.
    const overview = read('app/leave/page.tsx');
    const balanceRead = overview.match(/const dashboard =[^;]+;/)?.[0];
    expect(balanceRead, 'dashboard read exists').toBeTruthy();
    for (const key of ['hFrom', 'hTo', 'hType']) expect(balanceRead).not.toContain(key);
    expect(overview).toContain('loadOwnLeaveHistory({ session, me, sp, locale, leaveTypes, eligibleTypeIds })');
    // The leave YEAR the dashboard owns is untouched by the history filter, and rides along as a hidden input
    // so applying a filter cannot reset it. UPDATED BY r302 (6c9802c9): this was the as-at date, which went
    // with the My balances card; the Year selector replaced it, and the carrier moved with it.
    expect(page).toContain("['leaveYear', sp.leaveYear]");
    expect(page).not.toContain("['asOf', sp.asOf]");
  });

  it('the tick-list options come from the UNFILTERED read, or they vanish on first use', () => {
    expect(page).toContain('new Map(historyAll.rows.map((r) => [r.leaveTypeId, r.leaveType]))');
    expect(page).not.toContain('new Map(historyShown.rows.map(');
  });
});

describe('a hand-edited filter in the URL degrades to no filter, never to a 500', () => {
  /**
   * WHY BOTH HALVES. The page's three history filters go straight into typed SQL predicates —
   * from/to into lte/gte against `date` columns, hType into an inArray against a `uuid` column — and
   * Postgres answers a malformed literal with an ERROR (22007 / 22P02), not an empty result. There is
   * no error.tsx anywhere under app/, so that throw surfaces as an unhandled 500 that ANY logged-in
   * employee can reach by typing /leave?hFrom=x into the address bar. Nothing about it needs a manager
   * role or a crafted session.
   *
   * The first case proves the DANGER IS REAL against a live database, so the guard in the page is
   * load-bearing rather than decorative. The second proves the page actually applies it — the defect
   * lives in the contract between the two files, so a test of either half alone passes throughout.
   */
  it('the read really does reject a malformed date or type id — the guard is load-bearing', async () => {
    await expect(
      listLeaveRequestsPage(myCtx, { employmentIds: [me.employmentId], from: 'x', limit: 10, offset: 0 }),
    ).rejects.toThrow();
    await expect(
      listLeaveRequestsPage(myCtx, { employmentIds: [me.employmentId], leaveTypeIds: ['x'], limit: 10, offset: 0 }),
    ).rejects.toThrow();
  });

  it('the page shape-checks all three before they reach the read', () => {
    const page = read('components/leave/own-leave-history.tsx');
    // Each raw param is consumed exactly once, and that use is guarded.
    expect(page).toMatch(/const hTypeIds = hArr\(sp\.hType\)\.filter\(\(v\) => UUID\.test\(v\)\)/);
    expect(page).toMatch(/const hFrom = sp\.hFrom && ISO_DATE\.test\(sp\.hFrom\) \? sp\.hFrom : undefined/);
    expect(page).toMatch(/const hTo = sp\.hTo && ISO_DATE\.test\(sp\.hTo\) \? sp\.hTo : undefined/);
    // And no path OUTSIDE those three lines touches the raw param — an unguarded second read would
    // reopen the hole while every assertion above still passed. Checked by deleting the guard lines and
    // looking at what is left, so the guards' own (repeated, in a ternary) reads do not count themselves.
    const withoutGuards = page
      .split('\n')
      .filter((l) => !/const (hTypeIds|hFrom|hTo) =/.test(l))
      .join('\n');
    for (const raw of ['sp.hFrom', 'sp.hTo', 'sp.hType']) {
      expect(withoutGuards.includes(raw), `${raw} is read outside the guard`).toBe(false);
    }
  });
});

describe('the viewer never disappears from their own Request Leave selector', () => {
  /**
   * THE ORIGINAL REGRESSION. ad965821 narrowed the selector to employees with a non-empty eligible set,
   * which was right for reports and wrong for the viewer: a line manager inside minServiceMonths on every
   * type (a recent hire, or on probation under a confirmed_only catalogue) qualified for nothing today but
   * still had qualifying reports. The trigger gate tests the TYPE options, which were the union across
   * subjects and stayed non-empty — so the button rendered, the manager was missing from the employee
   * select, and the dialog defaulted employmentId to the first option, a REPORT. They filed against someone
   * else's balance by default with nothing on screen saying so.
   *
   * UPDATED BY 5206539f (AGENTS rule 18). THE FIX IS NOW STRUCTURAL RATHER THAN COMPENSATORY. The narrowing
   * that could drop the viewer is deleted outright: a line manager gets no Employee selector at all, because
   * applying on someone else's behalf is the named permission `leave.apply_on_behalf` and having reports
   * grants nothing. The list a HOLDER of that permission sees is `active` — everyone in scope, unnarrowed —
   * with the VIEWER FIRST, so the hazard this case was written about (the dialog defaulting to somebody
   * else) still cannot happen, and now cannot happen by construction rather than by a fallback.
   */
  it('the viewer leads the selector, and no narrowing can drop them from it', () => {
    const page = read('app/leave/page.tsx');
    // The viewer heads the list the dialog defaults to.
    expect(page).toMatch(
      /const requestLeaveEmployeeOptions = \[\s*\n\s*\.\.\.active\.filter\(\(e\) => e\.employmentId === me\.employmentId\),/,
    );
    // …and the list is `active` itself, so there is no filter left that could remove anyone, viewer included.
    const opts = page.slice(page.indexOf('const requestLeaveEmployeeOptions'));
    const body = opts.slice(0, opts.indexOf('}));') + 4);
    expect(body).toContain('...active.filter((e) => e.employmentId !== me.employmentId),');
    expect(body, 'a narrowed subject list is back').not.toContain('selectableSubjects');
    expect(body, 'a narrowed subject list is back').not.toContain('requestLeaveSubjects');
  });
});
