/**
 * f618065d (r362) — SELF OVERTIME: full width, chips with counts, a date window, and a paged list.
 *
 * The reporter raised "make it full width". Reading the screen showed the width was the smallest part of
 * it: there were no filters of any kind, no counts, no total, no page control, and the word Withdraw was
 * printed greyed-out and inert on every row where it does nothing. Three of the things the ticket asked
 * for were ALREADY right (the list sorts by overtime date descending; a withdrawn plan reads "Withdrawn"
 * and never "Cancelled"; Withdraw is already offered on exactly the rows the service still allows), and
 * the approved plan says so to the reporter rather than re-building them.
 *
 * WHAT THIS FILE PINS, in the order the risk sits:
 *
 *  A · THE COUNTS ARE A SECOND AGGREGATE, NOT A SCAN OF THE PAGE. This is the one that can silently be
 *      wrong and look right. The list is paged; a chip counted over the fetched rows says 25 when the
 *      truth is 30, and only an employee past the page size ever sees it. The fixture is therefore
 *      deliberately LARGER than the page — a five-row fixture makes this case pass whatever the code
 *      does. The same defect is documented at app/feedback/page.tsx, where it painted "All 517" over a
 *      list of 200 on production.
 *  B · ONE PREDICATE SERVES BOTH READS. Counts follow the date window and the search and IGNORE the
 *      status chip — that is what makes a chip's number describe the set the rows underneath are a page
 *      of. Two predicates is how a chip and its list come to disagree.
 *  C · THE OLD CALL STILL ANSWERS. Every new option is optional and the default order is untouched
 *      (test/plan-ot.test.ts §7 pins the behaviour; this file pins that nothing here narrowed it).
 *  D · THE SCREEN'S FOUR CORRECTIONS, each of which is invisible to tsc, to a 200 and to the rest of the
 *      suite: full width (in the shared layout guard), "Goes to" only while pending, nothing at all where
 *      Withdraw cannot be used, and a Submitted on column that is MYT rather than a UTC slice.
 *  E · THE WORDING AND THE CATALOGUE. `cancelled` reads "Withdrawn" on this screen's chip as well as its
 *      pill — the chip calls statusLabel with the overtime flag, which the sibling screen deliberately
 *      does not — and the twenty new captions exist in all six locales.
 *
 * Limits: the source cases are static and cannot see a class that never reaches the browser or a caption
 * a component swallows. The manual render walk at two locales is the backstop for those.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { resolveEntitlementsTx } from '../core/entitlements';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import {
  cancelPlannedOvertime,
  decideAttendanceCorrection,
  myOvertimePlanCounts,
  myOvertimePlans,
  requestAttendanceCorrection,
} from '../core/attendance';
import { ALL_ROW_CEILING, DEFAULT_PAGE_SIZE } from '../lib/pagination';
import type { SessionContext } from '../db/client';

const root = (p: string) => path.resolve(__dirname, '..', p);
const read = (p: string) => fs.readFileSync(root(p), 'utf8');

const LIST = read('app/attendance/plan-ot/page.tsx');
const LAYOUT_GUARD = read('test/attendance-screens-layout.test.ts');

/** Source with comments removed. A guard that reads a comment proves what somebody wrote, not what ships
 *  — and this file's header names several of the very tokens it forbids. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** …and with runs of whitespace flattened, so a Prettier line break cannot break an assertion about what
 *  a rule SAYS. */
const flat = (src: string) => code(src).replace(/\s+/g, ' ');

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const MESSAGES: Record<string, { me: Record<string, string> }> = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(read(`messages/${l}.json`)) as { me: Record<string, string> }]),
);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The reads
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

let b: Base;

// Fixed 2027 dates, like test/plan-ot.test.ts and for the same reason: the deferral discriminator is the
// real calendar day, and a test that computes its own future date drifts into the past.
const D = (n: number) => `2027-06-${String(n).padStart(2, '0')}`;

const uniqEmail = () => `selfot_${Math.random().toString(36).slice(2)}@t.local`;

async function hire() {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Self OT Worker', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: 5000,
    monthlyAllowance: 0,
    effectiveFrom: '2024-01-01',
  });
  return { a, employmentId: e.employmentId, personId: e.personId };
}

/** Withdrawal is subject-only, so it cannot be exercised through the admin fixture context. */
async function employeeCtx(personId: string): Promise<SessionContext> {
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  const entitlements = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, b.tenantId));
  return { tenantId: b.tenantId, userId, personId, roles: ['employee'], entitlements } as SessionContext;
}

const filePlan = (ctx: SessionContext, employmentId: string, date: string, minutes: number, reason: string) =>
  requestAttendanceCorrection(ctx, {
    employmentId,
    date,
    requestedOtMinutes: minutes,
    reason,
    plannedStartTime: '18:00',
    plannedEndTime: '21:00',
    otReasonCategory: 'project_deadline',
  });

/** count / requested / approved for one status out of the aggregate, 0 when the status has no rows. */
const at = (rows: Awaited<ReturnType<typeof myOvertimePlanCounts>>, status: string) =>
  rows.find((r) => r.status === status) ?? { status, count: 0, requestedMinutes: 0, approvedMinutes: 0 };

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

describe('A · the counts are an aggregate over the RECORDS, not over the page', () => {
  it('a set LARGER than one page still reports its real total — the page reports 25, the chip reports 30', async () => {
    const { a, employmentId } = await hire();
    // ⚠️ THE FIXTURE IS THE CASE. Thirty plans against a twenty-five-row page: with fewer rows than the
    // page holds, a chip counted off the fetched array would agree with the aggregate and this assertion
    // would pass over the exact defect it exists to catch.
    for (let i = 1; i <= 30; i++) await filePlan(a, employmentId, D(i), 60, `Cut-over rehearsal ${i}`);

    const page = await myOvertimePlans(a, employmentId, { limit: DEFAULT_PAGE_SIZE, offset: 0 });
    const counts = await myOvertimePlanCounts(a, employmentId);

    expect(page, 'the list really is capped at one page').toHaveLength(DEFAULT_PAGE_SIZE);
    expect(at(counts, 'pending').count, 'and the chip counts every record, not the page').toBe(30);
    expect(at(counts, 'pending').count).toBeGreaterThan(page.length);
    // The pager's total comes from the same read, so "1–25 of 30" is one query, not a second COUNT.
    expect(counts.reduce((n, c) => n + c.count, 0)).toBe(30);
    // …and the hours are summed over all thirty, not over the twenty-five that were fetched.
    expect(at(counts, 'pending').requestedMinutes).toBe(30 * 60);
  });

  it('every stored status gets its own group, and a clock correction is in none of them', async () => {
    const { a, employmentId, personId } = await hire();
    const emp = await employeeCtx(personId);
    await filePlan(a, employmentId, D(1), 60, 'pending one');
    const approved = await filePlan(a, employmentId, D(2), 120, 'approved one');
    await decideAttendanceCorrection(a, { correctionId: approved.correctionId, decision: 'approved' });
    const rejected = await filePlan(a, employmentId, D(3), 180, 'rejected one');
    await decideAttendanceCorrection(a, { correctionId: rejected.correctionId, decision: 'rejected' });
    const withdrawn = await filePlan(a, employmentId, D(4), 240, 'withdrawn one');
    await cancelPlannedOvertime(emp, { correctionId: withdrawn.correctionId, today: D(1) });
    // A clock-time correction is NOT overtime and belongs to the other screen. Mixing the two is the
    // complaint this list was split out of in the first place.
    await requestAttendanceCorrection(a, {
      employmentId,
      date: '2025-06-04',
      checkIn: '09:00',
      reason: 'forgot to clock out',
    });

    const counts = await myOvertimePlanCounts(a, employmentId);
    expect(Object.fromEntries(counts.map((c) => [c.status, c.count]))).toEqual({
      pending: 1,
      approved: 1,
      rejected: 1,
      cancelled: 1,
    });
    // Requested hours are true of every row; APPROVED hours exist only on the approved group, which is
    // the only place the screen prints them.
    expect(at(counts, 'approved').requestedMinutes).toBe(120);
    expect(at(counts, 'approved').approvedMinutes).toBe(120);
    expect(at(counts, 'pending').approvedMinutes, 'a plan nobody has decided has no approved figure').toBe(0);
    expect(at(counts, 'rejected').approvedMinutes).toBe(0);
  });

  it('counts follow the date window and the search, and IGNORE the status chip', async () => {
    const { a, employmentId } = await hire();
    const approved = await filePlan(a, employmentId, D(2), 60, 'Penang rollout support');
    await decideAttendanceCorrection(a, { correctionId: approved.correctionId, decision: 'approved' });
    await filePlan(a, employmentId, D(20), 60, 'Month-end closing run');

    // The window narrows it…
    expect((await myOvertimePlanCounts(a, employmentId, { from: D(10) })).reduce((n, c) => n + c.count, 0)).toBe(1);
    expect((await myOvertimePlanCounts(a, employmentId, { to: D(10) })).reduce((n, c) => n + c.count, 0)).toBe(1);
    // …and so does the search, case-insensitively, over the employee's own free text.
    expect((await myOvertimePlanCounts(a, employmentId, { q: 'PENANG' })).reduce((n, c) => n + c.count, 0)).toBe(1);
    expect((await myOvertimePlanCounts(a, employmentId, { q: 'nothing here' })).reduce((n, c) => n + c.count, 0)).toBe(0);
    // ⚠️ …but the STATUS never does: `myOvertimePlanCounts` takes no status, so every chip is answered by
    // one read. A counts read that accepted one would answer only the chip already chosen, and the other
    // four numbers would have to come from somewhere else.
    const unfiltered = await myOvertimePlanCounts(a, employmentId);
    expect(unfiltered.map((c) => c.status).sort()).toEqual(['approved', 'pending']);
  });
});

describe('B · the list read: filters, sort and the page window', () => {
  it('the status filter narrows the rows the chips count', async () => {
    const { a, employmentId } = await hire();
    await filePlan(a, employmentId, D(1), 60, 'still waiting');
    const approved = await filePlan(a, employmentId, D(2), 60, 'agreed');
    await decideAttendanceCorrection(a, { correctionId: approved.correctionId, decision: 'approved' });

    expect(await myOvertimePlans(a, employmentId, { status: 'approved' })).toHaveLength(1);
    expect((await myOvertimePlans(a, employmentId, { status: 'approved' }))[0].attendanceDate).toBe(D(2));
    expect(await myOvertimePlans(a, employmentId, { status: 'rejected' })).toHaveLength(0);
  });

  it('search matches the reason case-insensitively, and % typed into the box is a literal per cent', async () => {
    const { a, employmentId } = await hire();
    await filePlan(a, employmentId, D(1), 60, 'UAT support for the Penang rollout');
    await filePlan(a, employmentId, D(2), 60, 'Cut 100% of the batch over');

    expect(await myOvertimePlans(a, employmentId, { q: 'penang' })).toHaveLength(1);
    expect(await myOvertimePlans(a, employmentId, { q: 'PENANG ROLLOUT' })).toHaveLength(1);
    // A bare `%` reaching LIKE unescaped would match BOTH rows — a search box that silently accepts
    // wildcards answers a question nobody asked.
    expect(await myOvertimePlans(a, employmentId, { q: '%' })).toHaveLength(1);
    expect((await myOvertimePlans(a, employmentId, { q: '%' }))[0].attendanceDate).toBe(D(2));
  });

  it('sorting is a whitelist, and the DEFAULT is the untouched overtime-date-descending order', async () => {
    const { a, employmentId } = await hire();
    await filePlan(a, employmentId, D(1), 180, 'three hours');
    await filePlan(a, employmentId, D(2), 60, 'one hour');
    await filePlan(a, employmentId, D(3), 120, 'two hours');

    // Default — no sort, no dir. This is the call the screen made before this round and the one
    // test/plan-ot.test.ts §7 pins; every new option had to be optional for it to stay true.
    expect((await myOvertimePlans(a, employmentId, {})).map((p) => p.attendanceDate)).toEqual([D(3), D(2), D(1)]);
    expect((await myOvertimePlans(a, employmentId, { sort: 'hours', dir: 'asc' })).map((p) => p.requestedOtMinutes)).toEqual([60, 120, 180]);
    expect((await myOvertimePlans(a, employmentId, { sort: 'hours', dir: 'desc' })).map((p) => p.requestedOtMinutes)).toEqual([180, 120, 60]);
    // `submitted` orders by when it was FILED, which is a different question from the overtime date —
    // the three above were filed in ascending date order in the same transaction sequence.
    expect((await myOvertimePlans(a, employmentId, { sort: 'submitted', dir: 'asc' })).map((p) => p.attendanceDate)).toEqual([D(1), D(2), D(3)]);
  });

  it('the window is open at the top by default, because overtime is filed BEFORE the day', async () => {
    const { a, employmentId } = await hire();
    await filePlan(a, employmentId, D(28), 60, 'next month, already planned');

    // `from` with no `to` — the screen's default preset. A closed three-month window would hide exactly
    // the plan this screen exists to file in advance.
    expect(await myOvertimePlans(a, employmentId, { from: '2027-03-01' })).toHaveLength(1);
    expect(await myOvertimePlans(a, employmentId, { from: '2027-03-01', to: '2027-06-01' })).toHaveLength(0);
  });

  it('the row ceiling is the pager’s "All" ceiling, so "All" cannot be a silent partial list', async () => {
    const { a, employmentId } = await hire();
    await filePlan(a, employmentId, D(1), 60, 'one');
    // A read that stopped at a private 200 under a pager whose PageState calls a 250-row list complete
    // is a partial list presented as a whole one. Asked for more than the ceiling, the read clamps to
    // the ceiling the pager already assumes — and asked for nothing, it still answers the old default.
    expect(await myOvertimePlans(a, employmentId, { limit: ALL_ROW_CEILING })).toHaveLength(1);
    expect(await myOvertimePlans(a, employmentId, { limit: ALL_ROW_CEILING + 5000 })).toHaveLength(1);
    expect(read('core/attendance.ts')).toContain(
      'const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 25)), ALL_ROW_CEILING);',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('C · the screen: what the approved plan changed, and what it deliberately did not', () => {
  it('is FULL WIDTH, and is listed in the guard that keeps it that way', () => {
    expect(LIST, 'the named constant, not a hand-written width').toContain('pageWideCls');
    expect(
      LAYOUT_GUARD,
      'WIDE_LIST_SCREENS must list this screen — otherwise a cap can come back with nothing failing',
    ).toContain("'app/attendance/plan-ot/page.tsx',");
    // The not-linked notice stays centred and narrow. `max-w-md`, not `max-w-2xl`, because the layout
    // guard reads this file for `mx-auto` + `max-w-…xl` — the very shape this round took off the screen.
    expect(LIST).toContain('<div className="mx-auto max-w-md">');
  });

  it('the CHIP COUNTS come from the aggregate and the page of rows is never scanned', () => {
    const src = flat(LIST);
    expect(src, 'the counts read is the second query on the screen').toContain('myOvertimePlanCounts(s, me.employmentId, filter)');
    expect(src, 'indexed by status…').toContain('const byStatus = new Map(counts.map((c) => [c.status, c]));');
    expect(src, '…and every chip reads it').toContain(
      'const chipCount = (st: RequestStatus | null) => st ? (byStatus.get(st)?.count ?? 0) : counts.reduce((n, c) => n + c.count, 0);',
    );
    // ⚠️ THE ASSERTION THAT ACTUALLY BITES. Counting the fetched page is the defect, and it is one line
    // of plausible-looking code away: `plans.filter(p => p.status === st).length`.
    expect(/\bplans\.(filter|reduce|some|every)\(/.test(src), 'nothing on this screen counts the fetched page').toBe(
      false,
    );
    // The pager's total and the summary hours ride on the same read, so they cannot disagree with a chip.
    expect(src).toContain('const total = chipCount(statusFilter);');
    expect(src).toContain('pageState(pq, total, plans.length)');
    expect(src).toContain('<Pager basePath={LIST_PATH} params={viewParams} state={state} />');
  });

  it('the counts follow the same filter the rows do, minus the status', () => {
    const src = flat(LIST);
    expect(src, 'one filter object, built once').toContain(
      'const filter = { from: dateWindow.from, to: dateWindow.to, q: q || undefined };',
    );
    expect(src, 'the rows add the chip on top of it').toContain('...filter, status: statusFilter ?? undefined,');
    expect(src, 'and the counts read is handed the same object with no status').toContain(
      'myOvertimePlanCounts(s, me.employmentId, filter)',
    );
  });

  it('"Goes to" is drawn only while the request is still with somebody', () => {
    // It printed the employee's CURRENT administrative manager on every row including rejected and
    // withdrawn ones — a statement that the request is still with that person when it was decided weeks
    // ago, and possibly not even the right name. The sibling screen already took this decision.
    expect(flat(LIST)).toContain("{p.status === 'pending' ? approver : '—'}");
  });

  it('an ineligible row renders NOTHING where the dead greyed-out Withdraw used to be', () => {
    const src = code(LIST);
    const cell = src.slice(src.indexOf('{canWithdraw ?'));
    const closes = cell.indexOf(') : null}');
    expect(closes, 'the ineligible branch is `null` — no inert word, no disabled control').toBeGreaterThan(-1);
    expect(cell.slice(0, closes), 'and the whole control lives in the eligible branch').toContain("t('otWithdraw')");
    // ⚠️ THE RULE ITSELF IS UNCHANGED AND IS DELIBERATELY WIDER THAN PENDING. The ticket asked for
    // pending-only; that would remove a capability `cancelPlannedOvertime` still allows, so the plan
    // refused it. Pinning both halves, because "the control is drawn from one rule" says nothing about
    // what the rule SAYS — the sibling guard learned that the hard way.
    expect(flat(LIST)).toContain(
      "const canWithdraw = p.status === 'pending' || (p.status === 'approved' && p.appliedAt == null && p.attendanceDate >= today);",
    );
  });

  it('EVERY date this screen prints is the MALAYSIAN day — neither of them is a UTC slice', () => {
    const src = flat(LIST);
    expect(src, 'the Submitted on column').toContain('todayInKualaLumpur(p.createdAt)');
    // r362 — `appliedAt` TOO. This screen printed its "counted on" sub-line as
    // `p.appliedAt.toISOString().slice(0, 10)`, so a plan counted before 08:00 MYT named the previous
    // day, on the same screen whose other date was correct. Two dates resolved by two different rules
    // is the state this case exists to prevent; it was fixed rather than left as the odd one out.
    expect(src, 'and the counted-on sub-line, which was a UTC slice until r362').toContain(
      'todayInKualaLumpur(p.appliedAt)',
    );
    // ⚠️ THE GUARD THAT DOES NOT COVER THIS. test/today-in-myt-drift.test.ts matches only the ARGLESS
    // `new Date().toISOString()` form, on purpose — `new Date(iso).toISOString()` date-only arithmetic
    // is correct in UTC and must stay there, and over-broad source guards have cost this repo whole
    // gate runs. A STORED INSTANT rendered as a calendar day is neither of those two things and falls
    // in the gap, so this screen pins it by name.
    expect(src.includes('p.createdAt.toISOString()'), 'no UTC slice of the filing time').toBe(false);
    expect(src.includes('p.appliedAt.toISOString()'), 'no UTC slice of the counted-on time').toBe(false);
  });

  it('the chips are the DATABASE’s statuses, and a withdrawn plan’s chip reads "Withdrawn"', () => {
    expect(LIST, 'derived from the one tuple, never restated').toContain(
      'const STATUS_FILTERS = [null, ...REQUEST_STATUSES] as const',
    );
    expect(LIST, 'and the URL whitelist is that same tuple').toContain('REQUEST_STATUSES.includes(');
    // ⚠️ `true`, NOT `false`. The overtime flag is the whole naming point the reporter raised: the
    // sibling screen's chips call statusLabel(f, t, false) and therefore read "Cancelled" beside rows
    // whose pill reads "Withdrawn". On a screen that is overtime and nothing else, the chip must match
    // the pill.
    expect(flat(LIST)).toContain('statusLabel(f, t, true)');
    expect(flat(LIST)).toContain('statusLabel(p.status, t, true)');
  });

  it('the default date window is open at the top, and no page size is invented', () => {
    expect(LIST, 'the default preset has no upper bound — see the header').toContain(
      "recent: { from: start.toISOString().slice(0, 10), to: undefined },",
    );
    // The ticket asked for 20 rows a page. `lib/pagination.ts` is a product-wide contract offering
    // 25/50/100/200 and starting at 25, the reporter was told so in the approved plan, and this screen
    // must not be the one list in the product that behaves differently.
    expect(/\b20\b/.test(code(LIST)), 'no hand-rolled page size on this screen').toBe(false);
    expect(code(LIST).includes('PAGE_SIZE_OPTIONS'), 'the size options are the pager’s, not this screen’s').toBe(false);
  });

  it('stays server-rendered: a GET form and links, no client island', () => {
    const src = code(LIST);
    expect(src.includes("'use client'"), 'the overtime list must not become a client island').toBe(false);
    expect(src, 'no state, no viewport measuring — the URL is the state').not.toMatch(
      /\buseState\b|\buseEffect\b|\bmatchMedia\b|\bwindow\./,
    );
    expect(src, 'the filters are a plain GET form, so a filtered view is a shareable address').toContain(
      'method="get"',
    );
  });

  it('the approver’s rejection remark is NOT invented — but what we DO hold is shown', () => {
    // decideAttendanceCorrection takes no reason, the update writes status/decidedBy/decidedAt only, and
    // the event payload carries none. The approved plan says so to the reporter in plain words AND
    // promises the two things that exist instead — so a screen that quietly showed neither would have
    // kept the refusal and dropped the compensation.
    const core = code(read('core/attendance.ts'));
    expect(core.includes('rejectReason'), 'attendance has no stored approver reason').toBe(false);
    expect(code(LIST).toLowerCase().includes('rejectreason')).toBe(false);
    // The EMPLOYEE's own note — the `remark` column, written only by requestAttendanceCorrection.
    // ⚠️ THE OBVIOUS ASSERTION HERE IS VACUOUS AND A MUTATION PROVED IT: `myAttendanceCorrections`
    // selects `remark: attendanceCorrection.remark,` too, so a plain `toContain` of that line passes
    // with THIS read's copy deleted. The neighbours are what tell the two selects apart — the other one
    // has `requestKind` between the remark and the status.
    expect(flat(read('core/attendance.ts')), 'myOvertimePlans selects the remark').toContain(
      'remark: attendanceCorrection.remark, status: attendanceCorrection.status, appliedAt: attendanceCorrection.appliedAt,',
    );
    expect(flat(LIST), 'and the row prints it, underneath and italic, never as the reason').toContain(
      '{p.remark && <span className="block text-[11px] italic text-muted-foreground">{p.remark}</span>}',
    );
    // …and WHEN it was answered, on the rejected rows the reason was asked for.
    expect(flat(LIST)).toContain("{p.status === 'rejected' && p.decidedAt && (");
    expect(flat(LIST), 'in MYT, like the Submitted on column beside it').toContain(
      "t('decidedOn', { date: todayInKualaLumpur(p.decidedAt) })",
    );
  });
});

describe('D · the catalogue: twenty new captions, six locales, and one key retired rather than deleted', () => {
  const NEW_KEYS = [
    'otPresetRecent',
    'otPresetThisMonth',
    'otPresetLastMonth',
    'otPresetCustom',
    'otDateFilterLabel',
    'otSearchLabel',
    'otSearchPlaceholder',
    'otFilterApply',
    'otResetFilters',
    'otSortBy',
    'otSummaryRequests',
    'otSummaryHoursRequested',
    'otSummaryHoursApproved',
    'otWindowFrom',
    'otWindowRange',
    'otEmptyAll',
    'otEmptyPending',
    'otEmptyApproved',
    'otEmptyRejected',
    'otEmptyWithdrawn',
  ] as const;

  it.each(NEW_KEYS)('me.%s exists and is non-blank in all six locales', (key) => {
    for (const l of LOCALES) {
      const v = MESSAGES[l].me[key];
      expect(typeof v === 'string' && v.trim() !== '', `me.${key} missing or blank in ${l}.json`).toBe(true);
    }
  });

  it('every filter has its OWN empty message — one generic line was the complaint', () => {
    const src = flat(LIST);
    for (const key of ['otEmptyPending', 'otEmptyApproved', 'otEmptyRejected', 'otEmptyWithdrawn', 'otEmptyAll']) {
      expect(src, `the screen renders ${key}`).toContain(`t('${key}')`);
    }
    // The map is keyed by the status type, so a status added to the tuple without a message is a type
    // error rather than an empty screen.
    expect(src).toContain('const EMPTY: Record<RequestStatus, string> = {');
  });

  it('otNoPlans is RETIRED, not deleted, and says the same thing in all six files', () => {
    // "You have not filed any overtime plans yet" became false the moment a date window was applied by
    // default: an employee whose only plan is four months old would have been told they had never filed
    // one. Retired rather than deleted — the house rule — with identical English in every catalogue so a
    // translator is not asked to render a tombstone.
    const en = MESSAGES.en.me.otNoPlans;
    expect(en.startsWith('[retired r362 — ')).toBe(true);
    for (const l of LOCALES) expect(MESSAGES[l].me.otNoPlans, `${l}.json`).toBe(en);
    expect(code(LIST).includes('otNoPlans'), 'and nothing renders it any more').toBe(false);
  });
});
