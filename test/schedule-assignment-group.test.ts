/**
 * 8cd601d0 (r329) — SCHEDULE GROUP ON THE SCHEDULE ASSIGNMENT WORKFLOW, and the BULK writer behind it.
 *
 * ⚠️ READ THIS BEFORE ADDING TO THE ITEM. Most of what the approved plan asks for was ALREADY BUILT and is
 * pinned by other files; this one covers only what r329 added.
 *   · The service-side refusal ("a shift outside the group cannot be saved even if the request is
 *     hand-crafted") is 870b79e2/r277 — core/roster.ts assertShiftsAllowedForEmploymentsTx, pinned by
 *     test/schedule-group-allowed-shifts.test.ts across all four shift writers plus copyRoster.
 *   · Putting ONE employment in a group is f513ec02/r281 — setEmploymentScheduleGroup and the personnel
 *     Attendance card, pinned by test/personnel-schedule-group-assignment.test.ts.
 *   · The Schedule Assignment screen itself, and the promise that it and the personnel card are two doors
 *     onto ONE record, are 0bade264/a485afa1 (r209/r263/r265), pinned by test/schedule-assignment.test.ts.
 *
 * WHAT WAS MISSING, and what this file is about. Measured on production 2026-09-22: ONE of 75 active
 * employments had a Schedule Group. The guard's own header says an employment in NO group "is not
 * constrained at all" — so the correct refusal was a no-op for 74 of 75 people, and seating them one
 * personnel page at a time is why nobody had. r329 adds the BULK writer, the group on the Schedule
 * Assignment screen, and the narrowed Assigned Shift list.
 *
 * THE FOUR THINGS ASSERTED HERE, and why each needs its own half:
 *   §1 THE BULK WRITER GOES THROUGH THE GUARD, and the batch is ALL OR NOTHING. A bulk path that reached
 *      the column with its own UPDATE would pass every other test in the repo — the guard's tests exercise
 *      the four SHIFT writers and the single-employment group writer, none of which a bulk loop touches.
 *   §2 THERE IS STILL ONLY ONE WRITER of employment.attendance_rule_id. That is not a property of any one
 *      file, so it is asserted over the source tree: two doors, one service.
 *   §3 THE NARROWED SHIFT LIST IS READ FROM THE DATA, not written down. Item 07ebd04d splits "Standard"
 *      into three groups; a screen holding a group name or a membership list would keep rendering the
 *      pre-split answer while tsc, the suite and `next build` all stayed green. Asserted by MOVING a shift
 *      between groups and re-rendering, which no source scan can fake.
 *   §4 THE LABELS resolve in all six locales with their ICU arguments.
 *
 * ⚠️ THE MOCKS ARE FILE-LEVEL (the same caveat test/schedule-assignment.test.ts carries): `requireAdmin`
 * is a fake returning the module-level ADMIN, `redirect()` THROWS and records instead of navigating, and
 * `getTranslations` returns the KEY rather than the sentence — so a server-side assertion on copy here is
 * an assertion on a key name. Locale VALUES are read off disk in §4. Nothing here tests authorization.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import {
  createAttendanceRule,
  ensureStandardRule,
  type AttendanceRuleInput,
} from '../core/attendance-rule';
import {
  NoEmploymentsSelectedError,
  ScheduleGroupBulkRefusedError,
  ShiftNotInScheduleGroupError,
  assignDefaultShift,
  createShift,
  setEmploymentScheduleGroup,
  setEmploymentScheduleGroupBulk,
} from '../core/roster';
import { UNGROUPED, listShiftArrangements } from '../core/shift-arrangement';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let ADMIN: ReturnType<typeof adminCtx>;
vi.mock('../lib/authz', () => ({ requireAdmin: async () => ADMIN }));
let LAST_REDIRECT = '';
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    LAST_REDIRECT = url;
    throw new Error('NEXT_REDIRECT');
  },
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import ScheduleAssignmentPage from '../app/admin/attendance/schedule-assignment/page';
import ShiftArrangementPage from '../app/admin/attendance/schedule-assignment/[employmentId]/page';
import BulkScheduleGroupPage from '../app/admin/attendance/schedule-assignment/bulk/page';
import {
  bulkAssignScheduleGroupAction,
  setScheduleGroupAssignmentAction,
} from '../app/admin/attendance/schedule-assignment/actions';

const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

let b: Base;

const ruleInput = (name: string, over: Partial<AttendanceRuleInput> = {}): AttendanceRuleInput => ({
  name,
  status: 'active',
  lateGracePeriodMinutes: 0,
  lateAfterMinutes: 0,
  lateDeductMinutes: 0,
  includeGraceInLateness: false,
  earlyGracePeriodMinutes: 0,
  earlyAfterMinutes: 0,
  earlyDeductMinutes: 0,
  includeGraceInEarlyOut: false,
  applyToEarlyOt: false,
  otRows: [],
  ...over,
});

const workdayShift = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  code: `C_${randomUUID().slice(0, 6)}`,
  startTime: '09:00:00',
  endTime: '18:00:00',
  breakMinutes: 60,
  weeklyPattern: [1, 2, 3, 4, 5],
  ...over,
});

async function makeEmp(name = 'Group Member', companyId?: string): Promise<string> {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: name, primaryEmail: `grp_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({
      tenantId: b.tenantId,
      personId: p.id,
      companyId: companyId ?? b.companyId,
      employeeCode: `E${randomUUID().slice(0, 6)}`,
      hiredOn: '2020-01-01',
    })
    .returning({ id: schema.employment.id });
  return e.id;
}

/** The stored column, read as the migration role so RLS cannot make an absent row look like a null. */
async function storedGroup(employmentId: string): Promise<string | null> {
  const [row] = await owner.db
    .select({ ruleId: schema.employment.attendanceRuleId })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return row?.ruleId ?? null;
}
async function storedGroups(ids: string[]): Promise<(string | null)[]> {
  const rows = await owner.db
    .select({ id: schema.employment.id, ruleId: schema.employment.attendanceRuleId })
    .from(schema.employment)
    .where(inArray(schema.employment.id, ids))
    .orderBy(schema.employment.id); // ORDER BY: the assertion below compares an ARRAY.
  const by = new Map(rows.map((r) => [r.id, r.ruleId ?? null]));
  return ids.map((id) => by.get(id) ?? null);
}

function toMarkup(tree: unknown): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: 'en',
      timeZone: 'Asia/Kuala_Lumpur',
      messages: JSON.parse(read('messages/en.json')),
      children: tree as never,
    }),
  );
}
const renderList = async (sp: Record<string, string> = {}) =>
  toMarkup(await ScheduleAssignmentPage({ searchParams: Promise.resolve(sp) }));
const renderDetail = async (employmentId: string, sp: Record<string, string> = {}) =>
  toMarkup(
    await ShiftArrangementPage({
      params: Promise.resolve({ employmentId }),
      searchParams: Promise.resolve(sp),
    }),
  );
const renderBulk = async (sp: Record<string, string> = {}) =>
  toMarkup(await BulkScheduleGroupPage({ searchParams: Promise.resolve(sp) }));

/**
 * The `error=` sentence a redirect carries, DECODED AS A QUERY PARAM.
 *
 * ⚠️ NOT `decodeURIComponent(url)`. URLSearchParams writes a space as `+`, and decodeURIComponent leaves
 * `+` alone — so a naive decode turns "That group allows: X" into "That+group+allows:+X" and every
 * assertion on a sentence silently looks for the wrong string.
 */
function errorOf(url: string): string {
  return new URLSearchParams(url.split('#')[0].split('?')[1] ?? '').get('error') ?? '';
}

async function runAction(action: (fd: FormData) => Promise<void>, fields: [string, string][]) {
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v);
  LAST_REDIRECT = '';
  await expect(action(fd)).rejects.toThrow('NEXT_REDIRECT');
  return LAST_REDIRECT;
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ADMIN = adminCtx(b);
  LAST_REDIRECT = '';
});

/** One group allowing exactly one shift, plus a shift that belongs to no group at all. */
async function scenario() {
  const a = adminCtx(b);
  await ensureStandardRule(a);
  const group = await createAttendanceRule(a, ruleInput('A02'));
  const other = await createAttendanceRule(a, ruleInput('B07'));
  const allowed = await createShift(a, workdayShift('ZzAllowedShift', { ruleId: group.id }));
  const forbidden = await createShift(a, workdayShift('ZzForbiddenShift', { ruleId: other.id }));
  return { a, group, other, allowed, forbidden };
}

// ── §1 · THE BULK WRITER — through the guard, and all or nothing ──────────────────────────────────────
describe('§1 setEmploymentScheduleGroupBulk', () => {
  it('(1) seats every ticked employment in the group, with one audit event each', async () => {
    const { a, group, allowed } = await scenario();
    const emps = [await makeEmp('Ann'), await makeEmp('Bob'), await makeEmp('Cat')];
    for (const e of emps) await assignDefaultShift(a, { employmentId: e, shiftId: allowed.id });

    const r = await setEmploymentScheduleGroupBulk(a, { employmentIds: emps, attendanceRuleId: group.id });
    expect(r).toEqual({ requested: 3, changed: 3, unchanged: 0 });
    expect(await storedGroups(emps)).toEqual([group.id, group.id, group.id]);
    for (const e of emps) {
      expect(await eventTypesFor(b.tenantId, e)).toContain('employment.schedule-group.changed');
    }
  });

  /**
   * ⚠️ THE ASSERTION THE WHOLE ITEM RESTS ON. The bulk path must reach the column ONLY through the writer
   * that runs the reverse refusal, and the batch must be one transaction.
   *
   * The blocked employment is chosen at the MIDDLE of the sorted id order (the service sorts, so the order
   * is deterministic), which means employments BEFORE it were already written in the same transaction when
   * the refusal fired. If the bulk path committed per employment — a loop over the public
   * setEmploymentScheduleGroup, or a raw UPDATE with a validation pass — those earlier rows would survive
   * and this assertion fails. A whole-batch rollback is the only way the array below is all-null.
   */
  it('(2) ONE employee the group forbids refuses the WHOLE batch, and nothing is written', async () => {
    const { a, group, allowed, forbidden } = await scenario();
    const emps: string[] = [];
    for (let i = 0; i < 6; i += 1) emps.push(await makeEmp(`Member ${i}`));
    emps.sort(); // the service's own order, so "the middle one" is a fact about the run, not a guess.
    const blocked = emps[3];
    for (const e of emps) {
      await assignDefaultShift(a, { employmentId: e, shiftId: e === blocked ? forbidden.id : allowed.id });
    }

    const err = await setEmploymentScheduleGroupBulk(a, {
      employmentIds: emps,
      attendanceRuleId: group.id,
    }).catch((e) => e);
    expect(err, 'the batch is refused').toBeInstanceOf(ScheduleGroupBulkRefusedError);
    // It is MY group guard that refused, not RLS and not a uuid parse error: the cause is the shared
    // refusal, and the message carries the group's allowed list.
    expect((err as ScheduleGroupBulkRefusedError).cause).toBeInstanceOf(ShiftNotInScheduleGroupError);
    expect((err as Error).message).toMatch(/ZzForbiddenShift(.|\n)*allows: ZzAllowedShift/);
    // …and it names WHO, which the underlying refusal does not, and says nobody moved before it says why.
    expect((err as Error).message.startsWith('Nobody was moved.')).toBe(true);
    expect((err as ScheduleGroupBulkRefusedError).employeeName).toMatch(/^Member \d$/);

    expect(await storedGroups(emps), 'NOBODY moved — not even the three written before the refusal').toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    for (const e of emps) {
      expect(await eventTypesFor(b.tenantId, e)).not.toContain('employment.schedule-group.changed');
    }
  });

  it('(3) an empty selection is refused by the service, not silently accepted', async () => {
    const { a, group } = await scenario();
    await expect(
      setEmploymentScheduleGroupBulk(a, { employmentIds: [], attendanceRuleId: group.id }),
    ).rejects.toBeInstanceOf(NoEmploymentsSelectedError);
    await expect(
      setEmploymentScheduleGroupBulk(a, { employmentIds: ['  ', ''], attendanceRuleId: group.id }),
    ).rejects.toBeInstanceOf(NoEmploymentsSelectedError);
  });

  it('(4) an employment already in the group counts as unchanged and grows no second audit row', async () => {
    const { a, group, allowed } = await scenario();
    const already = await makeEmp('Ann');
    const fresh = await makeEmp('Bob');
    for (const e of [already, fresh]) await assignDefaultShift(a, { employmentId: e, shiftId: allowed.id });
    await setEmploymentScheduleGroup(a, { employmentId: already, attendanceRuleId: group.id });

    const r = await setEmploymentScheduleGroupBulk(a, {
      employmentIds: [already, fresh, already], // a duplicated id is deduplicated, not counted twice
      attendanceRuleId: group.id,
    });
    expect(r).toEqual({ requested: 2, changed: 1, unchanged: 1 });
    const events = (await eventTypesFor(b.tenantId, already)).filter(
      (e) => e === 'employment.schedule-group.changed',
    );
    expect(events.length, 'an unchanged employment appends nothing').toBe(1);
  });

  it('(5) clearing the group in bulk is NEVER refused, whatever shift anybody is on', async () => {
    const { a, group, allowed, forbidden } = await scenario();
    const emps = [await makeEmp('Ann'), await makeEmp('Bob')];
    for (const e of emps) await assignDefaultShift(a, { employmentId: e, shiftId: allowed.id });
    await setEmploymentScheduleGroupBulk(a, { employmentIds: emps, attendanceRuleId: group.id });
    // The shift is taken off the group behind their backs, so both employments are now in the state the
    // refusal exists to prevent. The way OUT must not itself be blocked.
    await owner.db.update(schema.shift).set({ ruleId: null }).where(eq(schema.shift.id, allowed.id));
    expect(forbidden.id).toBeTruthy();
    const r = await setEmploymentScheduleGroupBulk(a, { employmentIds: emps, attendanceRuleId: null });
    expect(r.changed).toBe(2);
    expect(await storedGroups(emps)).toEqual([null, null]);
  });

  /**
   * CROSS-COMPANY. Two companies in ONE tenant, one batch. This must NOT refuse: R33 f21d6eee removed the
   * same-company rule from shift assignment because the shift library is tenant-wide and shared, and a
   * Schedule Group is a rule library, not a company's property. Pinned so nobody "tightens" it back.
   */
  it('(6) CROSS-COMPANY — one batch may span two companies in the same tenant', async () => {
    const { a, group, allowed } = await scenario();
    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Acme Two Sdn Bhd' })
      .returning({ id: schema.company.id });
    const here = await makeEmp('Ann');
    const there = await makeEmp('Bob', c2.id);
    for (const e of [here, there]) await assignDefaultShift(a, { employmentId: e, shiftId: allowed.id });

    const r = await setEmploymentScheduleGroupBulk(a, {
      employmentIds: [here, there],
      attendanceRuleId: group.id,
    });
    expect(r.changed).toBe(2);
    expect(await storedGroups([here, there])).toEqual([group.id, group.id]);
  });

  /**
   * CROSS-TENANT. ⚠️ THIS GREEN IS RLS, NOT THE GROUP GUARD, and saying so is the point (CLAUDE.md §8).
   * `withTenant` scopes every read in the transaction, so the other tenant's employment simply is not
   * found and the writer's own "Employment not found" fires — the group rule is never consulted. What
   * r329 has to prove on top of that is the TRANSACTION: a foreign id in the batch must take the whole
   * batch down rather than leaving this tenant's own employments moved.
   */
  it('(7) CROSS-TENANT — a foreign employment id refuses the batch and leaves this tenant untouched', async () => {
    const { a, group, allowed } = await scenario();
    const mine = [await makeEmp('Ann'), await makeEmp('Bob')];
    for (const e of mine) await assignDefaultShift(a, { employmentId: e, shiftId: allowed.id });

    // A second tenant, and an employment inside it.
    const otherBase = await seedBase();
    const [p2] = await owner.db
      .insert(schema.person)
      .values({ tenantId: otherBase.tenantId, fullName: 'Outsider', primaryEmail: `o_${randomUUID()}@t.local` })
      .returning({ id: schema.person.id });
    const [e2] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: otherBase.tenantId, personId: p2.id, companyId: otherBase.companyId, hiredOn: '2020-01-01' })
      .returning({ id: schema.employment.id });

    await expect(
      setEmploymentScheduleGroupBulk(a, { employmentIds: [...mine, e2.id], attendanceRuleId: group.id }),
    ).rejects.toThrow(/Employment not found/);
    expect(await storedGroups(mine), 'the whole batch rolled back').toEqual([null, null]);
    expect(await storedGroup(e2.id), 'and the other tenant was never touched').toBeNull();
  });

  it('(8) the SCREEN’s bulk action reaches the same refusal, with the message intact', async () => {
    const { a, group, allowed, forbidden } = await scenario();
    const ok = await makeEmp('Ann');
    const bad = await makeEmp('Bob');
    await assignDefaultShift(a, { employmentId: ok, shiftId: allowed.id });
    await assignDefaultShift(a, { employmentId: bad, shiftId: forbidden.id });

    const refused = await runAction(bulkAssignScheduleGroupAction, [
      ['employmentId', ok],
      ['employmentId', bad],
      ['attendanceRuleId', group.id],
      ['returnTo', '/admin/attendance/schedule-assignment/bulk?scheduleGroupId=none'],
    ]);
    expect(refused).toContain('/admin/attendance/schedule-assignment/bulk?');
    expect(errorOf(refused)).toContain('Nobody was moved');
    expect(errorOf(refused), 'and the whole refusal, not a flat sentence').toContain(
      'allows: ZzAllowedShift',
    );
    expect(refused, 'the filter rides back').toContain('scheduleGroupId=none');
    expect(await storedGroups([ok, bad])).toEqual([null, null]);

    // …and the same action, with only the employee the group allows, reports the counts.
    const done = await runAction(bulkAssignScheduleGroupAction, [
      ['employmentId', ok],
      ['attendanceRuleId', group.id],
      ['returnTo', '/admin/attendance/schedule-assignment/bulk'],
    ]);
    expect(done).toContain('bulkChanged=1');
    expect(done).toContain('bulkUnchanged=0');
    expect(await storedGroup(ok)).toBe(group.id);
  });

  it('(9) a malformed employment id takes the whole batch down rather than being dropped', async () => {
    const { a, group, allowed } = await scenario();
    const ok = await makeEmp('Ann');
    await assignDefaultShift(a, { employmentId: ok, shiftId: allowed.id });
    const landed = await runAction(bulkAssignScheduleGroupAction, [
      ['employmentId', ok],
      ['employmentId', 'not-a-uuid'],
      ['attendanceRuleId', group.id],
    ]);
    expect(landed).toContain('error=');
    // The refusal is a FIELD refusal, so no query was built and nothing leaked from Postgres.
    expect(errorOf(landed)).not.toMatch(/select|from "employment"/i);
    expect(await storedGroup(ok), 'the well-formed half was not saved either').toBeNull();
  });
});

// ── §2 · ONE WRITER — a property of the tree, not of any one file ─────────────────────────────────────
describe('§2 employment.attendance_rule_id still has exactly one writer', () => {
  /** Every source file the app ships, excluding tests (which write the column as the migration role). */
  function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.next') continue;
          walk(rel);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          out.push(rel);
        }
      }
    };
    for (const d of ['app', 'components', 'core', 'db', 'lib', 'packs', 'scripts']) walk(d);
    return out.sort();
  }

  it('(10) only core/roster.ts UPDATEs the column, and only once', () => {
    const writers = sourceFiles().filter((f) => /\.set\(\{[^}]*attendanceRuleId/.test(read(f)));
    expect(writers, 'two writers of one column is how two doors come to disagree').toEqual(['core/roster.ts']);
    const roster = read('core/roster.ts');
    expect(roster.match(/\.set\(\{[^}]*attendanceRuleId/g)?.length).toBe(1);
    // …and that one write lives inside the shared Tx writer, above the reverse check that guards it.
    const body = roster.slice(
      roster.indexOf('export async function setEmploymentScheduleGroupTx'),
      roster.indexOf('export class NoEmploymentsSelectedError'),
    );
    expect(body).toContain('.set({ attendanceRuleId: ruleId })');
    expect(body).toContain('assertShiftsAllowedForEmploymentsTx(');
  });

  it('(11) the bulk service is N calls of that writer in ONE transaction — never its own UPDATE', () => {
    const roster = read('core/roster.ts');
    // Bounded at the next section header: an unbounded slice runs to the end of the file and would be
    // matching every roster writer below it rather than this one.
    const from = roster.indexOf('export async function setEmploymentScheduleGroupBulk');
    const bulk = roster.slice(from, roster.indexOf('// \u2500\u2500 Per-employee default shift', from));
    expect(bulk.length, 'the bulk writer was found and bounded').toBeGreaterThan(200);
    expect(bulk).toContain('setEmploymentScheduleGroupTx(tx, ctx,');
    expect(bulk, 'one withTenant for the whole batch').toContain('return withTenant(ctx, async (tx) => {');
    expect(bulk).not.toMatch(/\.update\(employment\)/);
  });

  it('(12) BOTH doors go through the service — the personnel card and the Attendance screens', () => {
    const personnel = read('app/admin/personnel/[employmentId]/actions.ts');
    const attendance = read('app/admin/attendance/schedule-assignment/actions.ts');
    expect(personnel).toContain('setEmploymentScheduleGroup(s, {');
    expect(attendance).toContain('setEmploymentScheduleGroup(s, { employmentId, attendanceRuleId }');
    expect(attendance).toContain('setEmploymentScheduleGroupBulk(s, {');
    // Neither file may know how the column is decided.
    for (const src of [personnel, attendance]) {
      expect(src).not.toMatch(/\.set\(\{[^}]*attendanceRuleId/);
    }
  });
});

// ── §3 · THE SCREENS — the group is read from the data, never written down ────────────────────────────
describe('§3 the Schedule Assignment screens', () => {
  it('(13) the LIST carries a Schedule Group column and a Schedule Group filter', async () => {
    const { a, group, allowed } = await scenario();
    const emp = await makeEmp('Ann');
    await assignDefaultShift(a, { employmentId: emp, shiftId: allowed.id });
    await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: group.id });

    const html = await renderList();
    expect(html).toContain('colScheduleGroup'); // the server key (getTranslations is mocked to the key)
    // The group NAME is resolved server-side and rendered in the row's own cell — a uuid is not an answer.
    // (The id does appear once, as the FILTER option's value, which is what a filter has to post.)
    expect(html).toContain('>A02</td>');
    // The filter narrows on the resolved row, both ways.
    const grouped = await listShiftArrangements(a, { scheduleGroupId: group.id });
    expect(grouped.map((r) => r.employmentId)).toEqual([emp]);
    const ungrouped = await listShiftArrangements(a, { scheduleGroupId: UNGROUPED });
    expect(ungrouped.map((r) => r.employmentId)).toEqual([]);
    // And the link into the bulk screen carries the filters the operator is working under.
    const filtered = await renderList({ scheduleGroupId: UNGROUPED });
    expect(filtered).toContain('/admin/attendance/schedule-assignment/bulk?scheduleGroupId=none');
  });

  /**
   * ⚠️ THE 07ebd04d TEST. The allowed list is read from `shift.rule_id` at render time, so MOVING a shift
   * from one group to another changes what the screen offers with no code change. A screen that had the
   * membership written down would render identically both times and pass every static check.
   */
  it('(14) the DETAIL page offers only the group’s shifts, and follows the data when they move', async () => {
    const { a, group, other, allowed, forbidden } = await scenario();
    const emp = await makeEmp('Ann');
    await assignDefaultShift(a, { employmentId: emp, shiftId: allowed.id });

    // No group yet ⇒ the whole library is offered, which is the release-day behaviour.
    const before = await renderDetail(emp);
    expect(before).toContain('ZzAllowedShift');
    expect(before).toContain('ZzForbiddenShift');

    await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: group.id });
    const narrowed = await renderDetail(emp);
    expect(narrowed).toContain('ZzAllowedShift');
    expect(narrowed, 'a shift outside the group is not offered').not.toContain('ZzForbiddenShift');
    expect(narrowed).toContain('narrowedByGroup');
    // The group itself is shown and editable at this door.
    expect(narrowed).toContain('<select name="attendanceRuleId"');
    expect(narrowed).toContain('A02');

    // ⚠️ NOW MOVE A SHIFT BETWEEN THE GROUPS. Not one byte of source changes; the offered list must.
    // This is the 07ebd04d rehearsal: the split will do exactly this to five shifts at once.
    expect(other.id).toBeTruthy();
    await owner.db.update(schema.shift).set({ ruleId: group.id }).where(eq(schema.shift.id, forbidden.id));
    const afterMove = await renderDetail(emp);
    expect(afterMove, 'the shift that joined the group is now offered').toContain('ZzForbiddenShift');
    expect(afterMove).toContain('ZzAllowedShift');
  });

  /**
   * THE SHIFT ON FILE IS ALWAYS OFFERED, even when the group forbids it — the same rule that keeps an
   * archived-but-assigned shift in the list. A select that cannot render what is stored shows a
   * placeholder and silently re-poses "which shift is this person on" as "choose one". Saving it again is
   * refused by the service, which is the honest outcome.
   */
  it('(15) a stored shift outside the group is still rendered, and the note says one is hidden', async () => {
    const { a, group, other, allowed, forbidden } = await scenario();
    const emp = await makeEmp('Ann');
    await assignDefaultShift(a, { employmentId: emp, shiftId: allowed.id });
    await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: group.id });
    // The shift leaves the group behind the employee's back (setRuleShifts does not re-examine members).
    await owner.db.update(schema.shift).set({ ruleId: other.id }).where(eq(schema.shift.id, allowed.id));

    const html = await renderDetail(emp);
    expect(html, 'what is on file is still selectable').toContain('ZzAllowedShift');
    expect(html).not.toContain('ZzForbiddenShift');
    expect(html).toContain('narrowedByGroup');
  });

  it('(16) an EMPTY group offers nothing and names the screen that fixes it', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const empty = await createAttendanceRule(a, ruleInput('C09'));
    await createShift(a, workdayShift('ZzSomeShift'));
    // No shift on file at all, so nothing is force-included — the state a brand-new employment is in.
    const emp = await makeEmp('Ann');
    await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: empty.id });

    const html = await renderDetail(emp);
    expect(html).toContain('groupAllowsNothing');
    expect(html).not.toContain('ZzSomeShift');
  });

  it('(17) the BULK page lists the filtered employees, the active groups, and posts one group per batch', async () => {
    const { a, group, allowed } = await scenario();
    const emp = await makeEmp('Ann');
    const other = await makeEmp('Bob');
    for (const e of [emp, other]) await assignDefaultShift(a, { employmentId: e, shiftId: allowed.id });
    await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: group.id });

    const all = await renderBulk();
    expect(all).toContain('Ann');
    expect(all).toContain('Bob');
    expect(all).toContain('A02');
    // ONE group select for the batch, and a checkbox per row.
    expect(all.match(/name="attendanceRuleId"/g)?.length).toBe(1);
    expect(all).toContain('type="checkbox"');

    // The list's filters are the selection: "no schedule group" leaves exactly the ungrouped employee.
    const ungrouped = await renderBulk({ scheduleGroupId: UNGROUPED });
    expect(ungrouped).toContain('Bob');
    expect(ungrouped).not.toContain('>Ann<');
  });

  it('(18) the DETAIL page’s group form goes through the service and comes back to the same page', async () => {
    const { a, group, allowed, forbidden } = await scenario();
    const emp = await makeEmp('Ann');
    await assignDefaultShift(a, { employmentId: emp, shiftId: allowed.id });

    const saved = await runAction(setScheduleGroupAssignmentAction, [
      ['employmentId', emp],
      ['attendanceRuleId', group.id],
      ['returnTo', `/admin/attendance/schedule-assignment/${emp}?status=current`],
    ]);
    expect(saved).toBe(`/admin/attendance/schedule-assignment/${emp}?status=current&groupSaved=1`);
    expect(await storedGroup(emp)).toBe(group.id);

    // And the refusal reaches the screen with the allowed list intact, leaving the stored group alone.
    await owner.db
      .update(schema.employment)
      .set({ defaultShiftId: forbidden.id })
      .where(eq(schema.employment.id, emp));
    await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: null });
    const refused = await runAction(setScheduleGroupAssignmentAction, [
      ['employmentId', emp],
      ['attendanceRuleId', group.id],
      ['returnTo', `/admin/attendance/schedule-assignment/${emp}`],
    ]);
    expect(errorOf(refused)).toContain('allows: ZzAllowedShift');
    expect(await storedGroup(emp)).toBeNull();
  });

  /**
   * BOTH DOORS NARROW THE SAME WAY. The personnel Shift arrangement card and the Attendance module's
   * arrangement page are two doors onto ONE record; §2 pins that they share a writer, and this pins that
   * they share the courtesy too — a picker that offers a different list at each door is how an
   * administrator learns to trust one screen and distrust the other.
   */
  it('(19) the PERSONNEL card narrows to the same group, by the same rule', async () => {
    const { a, group, allowed, forbidden } = await scenario();
    const emp = await makeEmp('Ann');
    await assignDefaultShift(a, { employmentId: emp, shiftId: allowed.id });
    const card = read('app/admin/personnel/[employmentId]/page.tsx');
    const line = card.slice(card.indexOf('const assignableShifts'), card.indexOf(');', card.indexOf('const assignableShifts')));
    expect(line, 'it reads shift.rule_id, not a written-down membership').toContain('sh.ruleId === scheduleGroupCurrentId');
    expect(line, 'and keeps the shift on file, as it already does for an archived one').toContain(
      'sh.id === emp.defaultShiftId',
    );
    // …and it is the SAME rule the Attendance page applies, written once each but stated identically.
    const detail = read('app/admin/attendance/schedule-assignment/[employmentId]/page.tsx');
    expect(detail).toContain('sh.ruleId === groupId || sh.id === row.shiftId');
    expect(forbidden.id).toBeTruthy();
    expect(group.id).toBeTruthy();
  });

  it('(20) no screen writes a group NAME, a group COUNT or a shift’s membership into its source', () => {
    const files = [
      'app/admin/attendance/schedule-assignment/page.tsx',
      'app/admin/attendance/schedule-assignment/[employmentId]/page.tsx',
      'app/admin/attendance/schedule-assignment/bulk/page.tsx',
      'app/admin/attendance/schedule-assignment/bulk/bulk-form.tsx',
      'app/admin/attendance/schedule-assignment/actions.ts',
    ];
    for (const f of files) {
      // Comments are allowed to discuss the split; CODE may not name a group. Strip block + line comments.
      const code = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      for (const name of ['Standard', 'A02', '5-day', '5.5-day']) {
        expect(code, `${f} must not name the group "${name}" — 07ebd04d splits Standard into three`).not.toContain(
          `'${name}'`,
        );
        expect(code).not.toContain(`"${name}"`);
      }
      // And no file decides membership for itself: the only narrowing key is shift.rule_id.
      expect(code).not.toMatch(/ruleId\s*===\s*['"]/);
    }
  });
});

// ── §4 · THE LABELS ───────────────────────────────────────────────────────────────────────────────────
describe('§4 every new string resolves in all six locales', () => {
  const TOP = [
    'colScheduleGroup',
    'noScheduleGroup',
    'groupTitle',
    'groupSave',
    'groupHint',
    'groupManage',
    'groupInactiveOption',
    'groupLibraryEmpty',
    'groupSavedNote',
    'narrowedByGroup',
    'groupAllowsNothing',
    'bulkLink',
    'bulkTitle',
    'bulkDescription',
    'bulkSelected',
    'bulkSelectAll',
    'bulkSelectAria',
    'bulkApply',
    'bulkClear',
    'bulkConfirmTitle',
    'bulkConfirmSubject',
    'bulkConfirmBody',
    'bulkDoneNote',
    'bulkHint',
  ];
  const FILTERS = ['scheduleGroup', 'allScheduleGroups', 'noScheduleGroup'];
  /** An ICU placeholder called without its argument THROWS at render, so each one is pinned per locale. */
  const ARGS: Record<string, string[]> = {
    groupInactiveOption: ['{name}'],
    narrowedByGroup: ['{group}', '{hidden,'],
    groupAllowsNothing: ['{group}'],
    bulkSelected: ['{count,'],
    bulkSelectAria: ['{name}'],
    bulkConfirmSubject: ['{count,', '{group}'],
    bulkDoneNote: ['{changed,', '{unchanged,'],
  };

  it('(21) keys exist, are non-empty, and keep their ICU arguments', () => {
    for (const loc of LOCALES) {
      const s = JSON.parse(read(`messages/${loc}.json`)).admin.scheduleAssignment as Record<string, unknown>;
      for (const k of TOP) {
        expect(typeof s[k], `${loc}.admin.scheduleAssignment.${k} exists`).toBe('string');
        expect(String(s[k]).length, `${loc}.${k} is not empty`).toBeGreaterThan(0);
      }
      const filters = s.filters as Record<string, string>;
      for (const k of FILTERS) {
        expect(typeof filters[k], `${loc}.admin.scheduleAssignment.filters.${k} exists`).toBe('string');
        expect(filters[k].length).toBeGreaterThan(0);
      }
      for (const [k, args] of Object.entries(ARGS)) {
        for (const arg of args) {
          expect(String(s[k]), `${loc}.${k} keeps ${arg}`).toContain(arg);
        }
      }
    }
  });

  it('(22) the bulk screen is registered on the permission matrix', () => {
    expect(read('lib/permissions.ts')).toContain("'/admin/attendance/schedule-assignment/bulk'");
  });
});
