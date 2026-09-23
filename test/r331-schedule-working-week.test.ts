/**
 * 665de026 (r331) — THE WORKING DAY / SCHEDULE PATTERN SECTION, the one genuinely new thing in the item.
 *
 * Everything else in 665de026 is relocation: three real panels and three honest placeholders moved off a
 * tabbed page onto a page per Schedule Group, and test/r301-schedule-general.test.ts follows them there.
 * THIS file is about the seventh section, which had nowhere to live until this round.
 *
 * ══ WHAT WAS ALREADY TRUE BEFORE THIS ROUND, AND WHAT WAS NOT ═════════════════════════════════════════
 * 07ebd04d (r331, migration 0483) put `weekly_pattern` / `half_pattern` / `off_pattern` onto
 * `attendance_rule` with two CHECK constraints, and core/attendance-rule.ts has exposed them
 * (`ResolvedAttendanceRule.week`) and validated them (`normalizeWeekPattern`) ever since. What did not
 * exist was a screen: every pattern control in `app/` and `components/` edits the SHIFT's week. The group
 * says WHICH DAYS are worked; the shift says WHAT HOURS. This is the group half, and
 * `saveScheduleGroupWeekAction` is its only writer.
 *
 * ══ WHAT IS PINNED, AND WHY EACH ONE ══════════════════════════════════════════════════════════════════
 *   A. THE DECODE. Seven `dayKind_<1..7>` selects → three ISO-weekday arrays, Rest the complement. Run
 *      against a real row, read back out of the database.
 *   B. THE TWO CHECK CONSTRAINTS. The disjointness one is made UNREACHABLE by the form's shape (a day
 *      posts one value, so it lands in at most one list) — asserted as a property of the decode over
 *      every one of the 4^7 = 16384 possible submissions, not by hoping. The other one IS reachable, and
 *      is refused by the service with a sentence an administrator can act on, BEFORE Postgres sees the
 *      UPDATE: the operator must never meet a constraint name.
 *   C. THE MARKER. A `<select>` is always submitted, so the seven day fields cannot go missing the way a
 *      checkbox can — but `undefined` and "three empty arrays" mean DIFFERENT things to
 *      `updateAttendanceRule`, and a submission carrying no day fields would decode to the second and
 *      CLEAR the week. `weekEditor=1` is read as a VALUE; without it nothing is written.
 *   D. NOTHING ELSE MOVES. The grace periods, the overtime ladder (boundaries, pattern, rates), the
 *      deduction switch and its service-stamped date are all carried forward verbatim. This is the same
 *      guarantee test/schedule-tab-writers.test.ts holds for the other two writers, restated for the new
 *      one, because "no Schedule data is changed" is the promise the whole item was approved on.
 *   E. THE STANDARD GROUP'S BLANK WEEK SURVIVES EVERY OTHER WRITER. This is the trap 07ebd04d's own
 *      comments name and the one that would be catastrophic in production: `attendance_rule.weekly_pattern`
 *      is NULL on every row written before 0483, including the tenant's un-deletable `is_default` rule,
 *      which is the fallback for every shift whose `rule_id` is NULL. A week on it would be imposed on
 *      every ungrouped shift in the tenant. So a rename through the rule editor, and a save from the
 *      Attendance or Overtime section, must all leave the three columns untouched.
 *   F. THE SCREEN. The Edit page renders the seven selects with the stored values; the View page renders
 *      the same week read-only; a group with no week says so in words rather than showing seven "Rest"
 *      dropdowns; and a refusal re-renders WHAT WAS TYPED, not what is on file.
 *
 * FILE-LEVEL MOCKS, the house pattern (test/schedule-tab-writers.test.ts, test/r301-schedule-general.test.ts):
 * getSession()/requireAdmin() return the module-level context; redirect() throws a recognisable error
 * carrying its path; getTranslations is a REAL translator over messages/en.json that THROWS on a missing
 * or malformed message. The service, RLS, the constraints and the rendered components are the real ones.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneElement, createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join as pathJoin, resolve as pathResolve } from 'node:path';

let ctx: import('../db/client').SessionContext | null = null;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => ctx) }));
vi.mock('../lib/authz', () => ({ requireAdmin: vi.fn(async () => ctx) }));
vi.mock('next/navigation', () => ({
  redirect: (p: string): never => {
    throw new RedirectError(p);
  },
  notFound: vi.fn(() => undefined),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const { readFileSync: rf } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const msgs = JSON.parse(rf(fileURLToPath(new URL('../messages/en.json', import.meta.url)), 'utf8'));
  return {
    getTranslations: async (ns: string | { namespace?: string }) =>
      createTranslator({
        locale: 'en',
        messages: msgs,
        namespace: (typeof ns === 'string' ? ns : ns?.namespace) as never,
        onError: (e) => {
          throw e;
        },
      }),
  };
});

import {
  createAttendanceRule,
  ensureStandardRule,
  getAttendanceRule,
  listAttendanceRules,
  type AttendanceRuleInput,
  type AttendanceRuleView,
} from '../core/attendance-rule';
import {
  saveScheduleGroupAttendanceAction,
  saveScheduleGroupWeekAction,
} from '../app/admin/attendance/schedule/actions';
import { updateAttendanceRuleAction } from '../app/admin/attendance-policy/rule-actions';
import ViewGroupPage from '../app/admin/attendance/schedule/[ruleId]/page';
import EditGroupPage from '../app/admin/attendance/schedule/[ruleId]/edit/page';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const root = pathResolve(__dirname, '..');
const en = JSON.parse(readFileSync(pathJoin(root, 'messages/en.json'), 'utf8'));
const SC = en.admin.scheduleConfig;
const SCHEDULE = '/admin/attendance/schedule';

const fd = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** Run an action that ends in redirect() and return the target, so a refusal is visible as a path. */
async function captureRedirect(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof RedirectError) return e.path;
    throw e;
  }
  throw new Error('expected the action to redirect, but it did not');
}

/** The seven day selects, plus the marker the action reads as a VALUE. */
const weekForm = (ruleId: string, kinds: readonly string[], opts: { marker?: boolean } = {}) =>
  fd({
    ruleId,
    ...(opts.marker === false ? {} : { weekEditor: '1' }),
    ...Object.fromEntries(kinds.map((k, i) => [`dayKind_${i + 1}`, k])),
  });

// ── rendering (the r301 helper: async server components reached through props, not only children) ────
const isAsync = (f: unknown) =>
  typeof f === 'function' && (f as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction';
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !isValidElement(v) && Object.getPrototypeOf(v) === Object.prototype;
}
async function settle(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(settle));
  if (isValidElement(node)) {
    const el = node as ReactElement<Record<string, unknown>>;
    if (isAsync(el.type)) return settle(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
    const next: Record<string, unknown> = {};
    let touched = false;
    for (const [k, v] of Object.entries(el.props ?? {})) {
      if (k === 'children' || isValidElement(v) || Array.isArray(v) || isPlainRecord(v)) {
        next[k] = await settle(v);
        touched = true;
      }
    }
    return touched ? cloneElement(el, next) : el;
  }
  if (isPlainRecord(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = await settle(v);
    return out;
  }
  return node;
}
const toMarkup = async (tree: unknown) =>
  renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      { locale: 'en', timeZone: 'Asia/Kuala_Lumpur', messages: en } as never,
      (await settle(tree)) as never,
    ),
  ).replace(/<script[\s\S]*?<\/script>/g, '');
type GroupSP = { error?: string; section?: string; typedWeek?: string };
const renderView = async (ruleId: string, sp: GroupSP = {}) =>
  toMarkup(await ViewGroupPage({ params: Promise.resolve({ ruleId }), searchParams: Promise.resolve(sp) }));
const renderEdit = async (ruleId: string, sp: GroupSP = {}) =>
  toMarkup(await EditGroupPage({ params: Promise.resolve({ ruleId }), searchParams: Promise.resolve(sp) }));
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

/** The `defaultValue` React emits for each day select: `<option value="x" selected="">`. */
function selectedKinds(html: string): string[] {
  return [1, 2, 3, 4, 5, 6, 7].map((d) => {
    const at = html.indexOf(`name="dayKind_${d}"`);
    if (at < 0) return 'ABSENT';
    const block = html.slice(at, html.indexOf('</select>', at));
    return /<option value="([a-z]+)" selected=""/.exec(block)?.[1] ?? 'NONE';
  });
}

const ruleInput = (over: Partial<AttendanceRuleInput> = {}): AttendanceRuleInput => ({
  name: `Group ${Math.random().toString(36).slice(2, 8)}`,
  status: 'active',
  lateGracePeriodMinutes: 5,
  lateAfterMinutes: 10,
  lateDeductMinutes: 30,
  includeGraceInLateness: false,
  earlyGracePeriodMinutes: 5,
  earlyAfterMinutes: 10,
  earlyDeductMinutes: 30,
  includeGraceInEarlyOut: false,
  applyToEarlyOt: true,
  applyDeductions: true,
  otRows: [
    { fromMinutes: 0, toMinutes: 120, ratePattern: 'flat', rate: 1.5, phRate: 3, roundingMode: 'down', roundToMinutes: 15 },
    { fromMinutes: 121, toMinutes: 0, ratePattern: 'flat', rate: 2, phRate: null, roundingMode: 'none', roundToMinutes: null },
  ],
  ...over,
});

/** The whole row, as a comparable object — so "nothing else moved" is a single assertion. */
const snapshot = (r: AttendanceRuleView) => ({
  name: r.name,
  description: r.description,
  status: r.status,
  isDefault: r.isDefault,
  lateGracePeriodMinutes: r.lateGracePeriodMinutes,
  lateAfterMinutes: r.lateAfterMinutes,
  lateDeductMinutes: r.lateDeductMinutes,
  includeGraceInLateness: r.includeGraceInLateness,
  earlyGracePeriodMinutes: r.earlyGracePeriodMinutes,
  earlyAfterMinutes: r.earlyAfterMinutes,
  earlyDeductMinutes: r.earlyDeductMinutes,
  includeGraceInEarlyOut: r.includeGraceInEarlyOut,
  applyToEarlyOt: r.applyToEarlyOt,
  applyDeductions: r.applyDeductions,
  deductionsEffectiveFrom: r.deductionsEffectiveFrom,
  otRows: r.otRows
    .slice()
    .sort((a, b) => a.fromMinutes - b.fromMinutes)
    .map((o) => ({
      fromMinutes: o.fromMinutes,
      toMinutes: o.toMinutes,
      ratePattern: o.ratePattern,
      rate: String(o.rate),
      phRate: o.phRate == null ? null : String(o.phRate),
      roundingMode: o.roundingMode,
      roundToMinutes: o.roundToMinutes,
    })),
});
const week = (r: AttendanceRuleView) => ({
  weeklyPattern: r.weeklyPattern,
  halfPattern: r.halfPattern,
  offPattern: r.offPattern,
});

let b: Base;
let ruleId: string;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ctx = adminCtx(b);
  const made = await createAttendanceRule(ctx!, ruleInput({ name: 'Plant crew' }));
  ruleId = made.id;
});

// ── A ───────────────────────────────────────────────────────────────────────────────────────────────

describe('A. the seven selects decode into the three stored arrays, and Rest is the complement', () => {
  it('Mon–Thu full, Fri half, Sat off, Sun rest', async () => {
    const target = await captureRedirect(() =>
      saveScheduleGroupWeekAction(weekForm(ruleId, ['full', 'full', 'full', 'full', 'half', 'off', 'rest'])),
    );
    expect(week((await getAttendanceRule(ctx!, ruleId))!)).toEqual({
      weeklyPattern: [1, 2, 3, 4],
      halfPattern: [5],
      offPattern: [6],
      // Sunday is in none of the three: Rest is DERIVED, never stored, exactly as on `shift`.
    });
    // …and the save keeps the operator where they were, on the section they saved from, with a toast.
    expect(target.startsWith(`${SCHEDULE}/${ruleId}/edit?toast=`), target).toBe(true);
    const q = new URL(target, 'http://x').searchParams;
    expect(q.get('toast')).toBe(SC.savedToast);
    expect(q.get('section')).toBe('workingDay');
    expect(target.endsWith('#section-workingDay'), 'and the browser lands on that heading').toBe(true);
    // Exactly one `?`. The r287 → r301 defect was a parameter concatenated in FRONT of the query key.
    expect(target.split('?').length - 1, target).toBe(1);
  });

  it('a week can be deliberately CLEARED back to "declares no week" — all seven Rest', async () => {
    await captureRedirect(() => saveScheduleGroupWeekAction(weekForm(ruleId, Array(7).fill('full'))));
    expect(week((await getAttendanceRule(ctx!, ruleId))!).weeklyPattern).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await captureRedirect(() => saveScheduleGroupWeekAction(weekForm(ruleId, Array(7).fill('rest'))));
    // NULL, not [] — `shift.weekly_pattern` is nullable and the two mean the same thing to the resolver,
    // so an all-Rest week must store what a pre-0483 row holds (core/attendance-rule.ts normalizeWeekPattern).
    expect(week((await getAttendanceRule(ctx!, ruleId))!)).toEqual({
      weeklyPattern: null,
      halfPattern: [],
      offPattern: [],
    });
  });

  it('an all-HALF week is legal — it is walkable, so the service does not refuse it', async () => {
    await captureRedirect(() => saveScheduleGroupWeekAction(weekForm(ruleId, Array(7).fill('half'))));
    expect(week((await getAttendanceRule(ctx!, ruleId))!)).toEqual({
      weeklyPattern: null,
      halfPattern: [1, 2, 3, 4, 5, 6, 7],
      offPattern: [],
    });
  });
});

// ── B ───────────────────────────────────────────────────────────────────────────────────────────────

describe('B. the two CHECK constraints of migration 0483', () => {
  /**
   * `attendance_rule_day_kinds_disjoint` — no weekday in two of the three lists.
   *
   * THIS IS UNREACHABLE BY CONSTRUCTION, and the construction is the control's shape: one `<select>` per
   * weekday posting exactly one of full | half | off | rest. A checkbox triple COULD put a day in two
   * lists, which is precisely why it is not one. Asserted over every one of the 4^7 possible submissions
   * rather than over a handful, because "no submission can do it" is the claim.
   */
  it('the disjointness constraint cannot be violated by any submission the form can make', () => {
    const KINDS = ['full', 'half', 'off', 'rest'] as const;
    let checked = 0;
    for (let n = 0; n < 4 ** 7; n++) {
      const kinds = Array.from({ length: 7 }, (_, i) => KINDS[Math.floor(n / 4 ** i) % 4]);
      const buckets = { full: [] as number[], half: [] as number[], off: [] as number[] };
      kinds.forEach((k, i) => {
        if (k !== 'rest') buckets[k].push(i + 1);
      });
      const all = [...buckets.full, ...buckets.half, ...buckets.off];
      expect(new Set(all).size, `a day landed in two lists for ${kinds.join(',')}`).toBe(all.length);
      checked++;
    }
    expect(checked, 'every possible submission was checked').toBe(16384);
  });

  /**
   * `attendance_rule_off_needs_working_day` — a group that declares Off days must declare a working day.
   *
   * THIS ONE IS REACHABLE: set every day to Off, or Off and Rest. The operator must never meet a
   * constraint name, so `normalizeWeekPattern` refuses it with a sentence they can act on, BEFORE the
   * UPDATE is issued — and the stored row is untouched.
   */
  it('Off days with no working day is refused in words, before Postgres sees it, and nothing is written', async () => {
    await captureRedirect(() =>
      saveScheduleGroupWeekAction(weekForm(ruleId, ['full', 'full', 'full', 'full', 'full', 'off', 'rest'])),
    );
    const before = week((await getAttendanceRule(ctx!, ruleId))!);

    const target = await captureRedirect(() =>
      saveScheduleGroupWeekAction(weekForm(ruleId, ['off', 'off', 'off', 'off', 'off', 'off', 'rest'])),
    );
    const q = new URL(target, 'http://x').searchParams;
    const message = q.get('error')!;
    expect(message, 'a sentence, not a constraint name').not.toMatch(/attendance_rule_|constraint|violates/i);
    expect(message).toContain('working week with no working day');
    expect(message, 'and it says what to do about it').toMatch(/Tick at least one full or half working day/);
    expect(target.startsWith(`${SCHEDULE}/${ruleId}/edit?error=`), target).toBe(true);
    expect(q.get('section')).toBe('workingDay');

    expect(week((await getAttendanceRule(ctx!, ruleId))!), 'the stored week is untouched').toEqual(before);
  });

  it('“nothing you entered is lost”: the refusal carries what was typed, and the form re-renders it', async () => {
    const typed = ['off', 'off', 'off', 'off', 'off', 'off', 'rest'];
    const target = await captureRedirect(() => saveScheduleGroupWeekAction(weekForm(ruleId, typed)));
    const q = new URL(target, 'http://x').searchParams;
    // Seven characters from a four-letter alphabet, riding as a SECOND `&` parameter after `?error=`.
    expect(q.get('typedWeek')).toBe('OOOOOOR');
    expect(target.indexOf('&typedWeek='), 'after the query key, never in front of it').toBeGreaterThan(
      target.indexOf('?error='),
    );
    const html = await renderEdit(ruleId, {
      error: q.get('error')!,
      section: q.get('section')!,
      typedWeek: q.get('typedWeek')!,
    });
    expect(selectedKinds(html), 'the six Off days the operator chose are still chosen').toEqual(typed);
    expect(html, 'and the refusal is beside them').toContain(esc(q.get('error')!));
  });

  it('a junk typedWeek is DROPPED — it can never widen what the form accepts', async () => {
    await captureRedirect(() =>
      saveScheduleGroupWeekAction(weekForm(ruleId, ['full', 'full', 'full', 'full', 'half', 'off', 'rest'])),
    );
    for (const junk of ['', 'XXXXXXX', 'FFFF', 'FFFFFFFF', 'F F F F', '<script>']) {
      expect(
        selectedKinds(await renderEdit(ruleId, { typedWeek: junk })),
        `typedWeek=${JSON.stringify(junk)} must fall back to the STORED week`,
      ).toEqual(['full', 'full', 'full', 'full', 'half', 'off', 'rest']);
    }
  });
});

// ── C ───────────────────────────────────────────────────────────────────────────────────────────────

describe('C. the marker — a submission that said nothing must not CLEAR the week', () => {
  it('no weekEditor marker ⇒ refused, and the stored week is untouched', async () => {
    await captureRedirect(() =>
      saveScheduleGroupWeekAction(weekForm(ruleId, ['full', 'full', 'full', 'full', 'full', 'rest', 'rest'])),
    );
    const before = week((await getAttendanceRule(ctx!, ruleId))!);
    expect(before.weeklyPattern, 'a week really is stored, so the case is not vacuous').toEqual([1, 2, 3, 4, 5]);

    const target = await captureRedirect(() =>
      saveScheduleGroupWeekAction(weekForm(ruleId, Array(7).fill('rest'), { marker: false })),
    );
    expect(new URL(target, 'http://x').searchParams.get('error')).toContain('did not carry the working-week controls');
    expect(week((await getAttendanceRule(ctx!, ruleId))!), 'nothing was cleared').toEqual(before);
  });

  /**
   * The BEHAVIOURAL half of the case below, and the one that actually distinguishes the two readings.
   *
   * A form that omits the marker and a form that sends it EMPTY are different bytes, and only a VALUE
   * comparison tells them apart: `fd.get('weekEditor') != null` is TRUE for `weekEditor=''`, so a
   * presence test would accept a submission from a form that never carried the controls and clear the
   * group's week with it. That is 7c834696's trap on `bool`, on this table, restated for this field.
   */
  it('an EMPTY marker is refused too — the case a presence test would wave through', async () => {
    await captureRedirect(() =>
      saveScheduleGroupWeekAction(weekForm(ruleId, ['full', 'full', 'full', 'full', 'full', 'rest', 'rest'])),
    );
    const before = week((await getAttendanceRule(ctx!, ruleId))!);
    expect(before.weeklyPattern, 'a week really is stored, so the case is not vacuous').toEqual([1, 2, 3, 4, 5]);

    const f = weekForm(ruleId, Array(7).fill('rest'));
    f.set('weekEditor', '');
    const target = await captureRedirect(() => saveScheduleGroupWeekAction(f));
    // The stored row FIRST, so a regression reports the damage rather than a missing error string.
    expect(week((await getAttendanceRule(ctx!, ruleId))!), 'an empty marker must not clear the week').toEqual(before);
    expect(String(new URL(target, 'http://x').searchParams.get('error'))).toContain(
      'did not carry the working-week controls',
    );
  });

  it('the marker is compared as a VALUE, never tested for presence', async () => {
    const src = readFileSync(pathJoin(root, 'app/admin/attendance/schedule/actions.ts'), 'utf8');
    expect(src, 'read as a value').toContain("fd.get('weekEditor') !== '1'");
    // A presence test would be true on EVERY submission carrying the field, which is the 7c834696 trap on
    // this very table restated: `fd.get(k) != null` was true for a hidden input that arrived empty.
    expect(src, 'never by presence').not.toMatch(/fd\.get\('weekEditor'\)\s*[!=]=\s*null/);
    // And the page really does emit it, so the contract is pinned across BOTH files (CLAUDE.md §8).
    const page = readFileSync(pathJoin(root, 'app/admin/attendance/schedule/group-sections.tsx'), 'utf8');
    expect(page, 'the form carries the marker').toContain('name="weekEditor" value="1"');
  });
});

// ── D ───────────────────────────────────────────────────────────────────────────────────────────────

describe('D. nothing else on the Schedule Group moves', () => {
  it('a working-week save carries every other column forward verbatim', async () => {
    const before = snapshot((await getAttendanceRule(ctx!, ruleId))!);
    expect(before.otRows.length, 'there are bands to lose, so the case is not vacuous').toBe(2);
    expect(before.applyDeductions, 'and a deduction switch that is ON').toBe(true);
    expect(before.deductionsEffectiveFrom, 'with a date the service stamped').not.toBeNull();

    await captureRedirect(() =>
      saveScheduleGroupWeekAction(weekForm(ruleId, ['full', 'full', 'full', 'full', 'half', 'off', 'rest'])),
    );
    const after = (await getAttendanceRule(ctx!, ruleId))!;
    expect(snapshot(after), 'only the three week columns changed').toEqual(before);
    expect(week(after), '…and they did change').toEqual({ weeklyPattern: [1, 2, 3, 4], halfPattern: [5], offPattern: [6] });
  });

  it('a CRAFTED request body cannot reach a column the section does not render', async () => {
    const before = snapshot((await getAttendanceRule(ctx!, ruleId))!);
    const f = weekForm(ruleId, ['full', 'full', 'full', 'full', 'full', 'rest', 'rest']);
    // Every field the OTHER sections post, plus the one this round was told to leave alone.
    for (const [k, v] of Object.entries({
      name: 'Renamed by a crafted post',
      status: 'inactive',
      applyDeductions: '',
      deductionsEffectiveFrom: '1999-01-01',
      lateGracePeriodMinutes: '999',
      earlyDeductMinutes: '999',
      applyToEarlyOt: '',
      earlyOtEditor: '1',
      otRows: '[]',
      roundingMode_0: 'up',
      roundToMinutes_0: '60',
    })) {
      f.set(k, v);
    }
    await captureRedirect(() => saveScheduleGroupWeekAction(f));
    expect(snapshot((await getAttendanceRule(ctx!, ruleId))!), 'the crafted fields reached nothing').toEqual(before);
  });
});

// ── E ───────────────────────────────────────────────────────────────────────────────────────────────

describe('E. every OTHER writer leaves the working week alone — including on the Standard group', () => {
  /**
   * ⚠️ THE TRAP 07ebd04d NAMES, AND THE ONE THAT WOULD BE WORST IN PRODUCTION.
   *
   * `AttendanceRuleInput`'s three week fields are OPTIONAL, and `undefined` means "not supplied", NOT
   * "empty". `updateAttendanceRule` writes the columns only when at least one of them is present
   * (`hasWeekInput`). Every writer except the new one supplies none of them — but a future
   * `carryForward` that spread `weeklyPattern: rule.weeklyPattern` "for completeness", or a form that
   * posted an empty day list, would turn a rename into a week WIPE. On the un-deletable Standard group
   * that is not a cosmetic bug: it is the fallback for every shift whose `rule_id` is NULL, so a week on
   * it (or the loss of one) is imposed on every ungrouped shift in the tenant.
   */
  it('the rule editor renames a group without touching its week', async () => {
    await captureRedirect(() =>
      saveScheduleGroupWeekAction(weekForm(ruleId, ['full', 'full', 'full', 'full', 'half', 'off', 'rest'])),
    );
    const before = week((await getAttendanceRule(ctx!, ruleId))!);
    expect(before.weeklyPattern, 'a week really is stored').toEqual([1, 2, 3, 4]);

    await captureRedirect(() =>
      updateAttendanceRuleAction(fd({ ruleId, name: 'Plant crew (renamed)', status: 'active' })),
    );
    const after = (await getAttendanceRule(ctx!, ruleId))!;
    expect(after.name, 'the rename landed, so the case is not vacuous').toBe('Plant crew (renamed)');
    expect(week(after), 'and the week is exactly what it was').toEqual(before);
  });

  it('the Attendance section saves six minute figures without touching the week', async () => {
    await captureRedirect(() =>
      saveScheduleGroupWeekAction(weekForm(ruleId, ['full', 'full', 'full', 'full', 'half', 'off', 'rest'])),
    );
    const before = week((await getAttendanceRule(ctx!, ruleId))!);
    await captureRedirect(() =>
      saveScheduleGroupAttendanceAction(fd({ ruleId, lateGracePeriodMinutes: '12', earlyGracePeriodMinutes: '12' })),
    );
    const after = (await getAttendanceRule(ctx!, ruleId))!;
    expect(after.lateGracePeriodMinutes, 'the save landed').toBe(12);
    expect(week(after)).toEqual(before);
  });

  it("the Standard group's blank week survives a save through the rule editor", async () => {
    await ensureStandardRule(ctx!);
    const standard = (await listAttendanceRules(ctx!)).find((r) => r.isDefault)!;
    expect(week(standard), 'it starts with no week, which is what makes it the fallback').toEqual({
      weeklyPattern: null,
      halfPattern: [],
      offPattern: [],
    });
    await captureRedirect(() =>
      updateAttendanceRuleAction(fd({ ruleId: standard.id, name: standard.name, status: 'active' })),
    );
    expect(week((await getAttendanceRule(ctx!, standard.id))!), 'still no week').toEqual({
      weeklyPattern: null,
      halfPattern: [],
      offPattern: [],
    });
  });
});

// ── F ───────────────────────────────────────────────────────────────────────────────────────────────

describe('F. the screen — Edit edits it, View shows it, and "no week" is a sentence', () => {
  it('the Edit page renders seven selects preset to the stored week', async () => {
    await captureRedirect(() =>
      saveScheduleGroupWeekAction(weekForm(ruleId, ['full', 'full', 'half', 'off', 'rest', 'full', 'rest'])),
    );
    const html = await renderEdit(ruleId);
    expect(selectedKinds(html)).toEqual(['full', 'full', 'half', 'off', 'rest', 'full', 'rest']);
    // Each select offers all four kinds, which is what makes the disjointness constraint unreachable.
    for (const kind of ['full', 'half', 'off', 'rest']) {
      expect(html, `every day can be set to ${kind}`).toContain(`<option value="${kind}"`);
    }
    // The words come from the namespace that already owns them, not a second copy under this screen's.
    for (const word of [en.roster.dayKindFull, en.roster.dayKindHalf, en.roster.dayKindOff, en.roster.dayKindRest]) {
      expect(html).toContain(esc(word));
    }
  });

  it('the View page shows the same week and offers no control over it', async () => {
    await captureRedirect(() =>
      saveScheduleGroupWeekAction(weekForm(ruleId, ['full', 'full', 'half', 'off', 'rest', 'full', 'rest'])),
    );
    const html = await renderView(ruleId);
    expect(html, 'no editable day control on a read-only page').not.toContain('name="dayKind_1"');
    expect(html, 'nor the marker that would let one post').not.toContain('name="weekEditor"');
    // …and it still SAYS the week, so "read-only" is not "absent".
    const section = html.slice(html.indexOf('id="section-workingDay"'));
    expect(section).toContain(esc(en.admin.attendancePolicy.dayMon));
    expect(section).toContain(esc(en.roster.dayKindHalf));
  });

  it('a group that declares no week says so in words, on both pages', async () => {
    // The state every row written before migration 0483 is in, and the one the Standard group must keep.
    expect(week((await getAttendanceRule(ctx!, ruleId))!).weeklyPattern).toBeNull();
    expect(await renderView(ruleId), 'the View page explains it rather than showing seven "Rest" boxes').toContain(
      esc(SC.weekNone),
    );
    // On the Edit page the seven dropdowns ARE the answer, all preset to Rest — the sentence would be a
    // second, contradicting explanation beside a control that already says it.
    expect(selectedKinds(await renderEdit(ruleId))).toEqual(Array(7).fill('rest'));
  });

  it('the list column tells two groups apart by their week, and names the "no week" state', async () => {
    const { default: ListPage } = await import('../app/admin/attendance/schedule/page');
    await captureRedirect(() =>
      saveScheduleGroupWeekAction(weekForm(ruleId, ['full', 'full', 'full', 'full', 'half', 'rest', 'rest'])),
    );
    await createAttendanceRule(ctx!, ruleInput({ name: 'Office staff' }));
    const html = await toMarkup(await ListPage({ searchParams: Promise.resolve({}) }));
    expect(html, 'the column exists').toContain(esc(SC.colWeek));
    // Half days carry the marker: "Mon, Tue, Wed, Thu, Fri" with Friday a half day would be wrong in the
    // way that matters to somebody reading the list to tell two groups apart.
    expect(html).toContain(esc(SC.weekHalfMark.replace('{day}', en.admin.attendancePolicy.dayFri)));
    expect(html, 'and a group with no week says so rather than showing a blank cell').toContain(esc(SC.weekNoneShort));
  });
});
