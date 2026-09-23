/**
 * e4471e3c (r287) — THE SCHEDULE TABS BECAME WRITERS, AND THE WRITER IS THE RISK.
 *
 * The reporter asked for the Schedule Group and Work Schedule settings to be editable on Attendance ›
 * Schedule, where they were already displayed. The layout was never the hard part. Making a read-only
 * surface editable adds a WRITER over a table that already had one, and the existing one
 * (`updateAttendanceRuleAction`) builds a COMPLETE rule out of whatever the submission happens to carry:
 * posting a partial form to it would have saved a blank name, turned the deduction switch OFF, and
 * DELETED every overtime band — silently, because an unchecked checkbox and an absent field are the same
 * bytes, and `parseOtRows('')` is `[]`.
 *
 * So app/admin/attendance/schedule/actions.ts re-reads the stored rule, carries every column forward
 * verbatim, and overlays ONLY the fields its own tab renders. These are the tests that make that claim
 * checkable rather than a comment: they RUN the actions against a real row and read what was stored.
 *
 * ── WHAT EACH CASE IS FOR ───────────────────────────────────────────────────────────────────────────
 *  A. ROUND TRIP. Post back exactly what the form renders; the stored row must be unchanged in every
 *     column. A screen that silently rewrites a value on an untouched save is worse than one that
 *     refuses.
 *  B. THE DEDUCTION SWITCH DOES NOT MOVE. It stays on the Schedule Group editor (its effective-from date
 *     is stamped by the service and can never be typed, and a DB CHECK from migration 0394 makes
 *     "on with no start date" unrepresentable — that is what keeps a deduction out of a closed payroll
 *     period). Neither tab may change it, INCLUDING when a crafted request body says to.
 *  C. THE BANDS AND RATES SURVIVE. Money, and an ordering the ladder validation depends on.
 *  D. SAME STORED ROW AS THE OLD SCREEN. The plan's actual promise: a save from the new tab and a save
 *     from the editor that owned the setting must land the same row.
 *  E. THE SWITCH THAT CAN BE TURNED OFF. The `bool` trap 7c834696 hit on this very setting: without the
 *     hidden marker, "off" and "this form did not carry the control" are indistinguishable.
 *
 * The harness cannot mint a request context, so `getSession` and `next/navigation` are mocked exactly as
 * test/entitlement-save-stay.test.ts does — the ACTION code under test is the real thing, and so is every
 * read and write it makes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let actionCtx: import('../db/client').SessionContext | null = null;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
const redirectSpy = vi.fn((path: string): never => {
  throw new RedirectError(path);
});
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => actionCtx) }));
vi.mock('../lib/authz', () => ({ requireAdmin: vi.fn(async () => actionCtx) }));
vi.mock('next/navigation', () => ({ redirect: (p: string) => redirectSpy(p), notFound: vi.fn(() => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
/**
 * 665de026 — these actions LOCALISE their confirmation before redirecting, so the module needs a
 * translator. A REAL one over messages/en.json that THROWS on a missing or malformed message, the same
 * mock test/r301-schedule-general.test.ts uses: a MISSING_MESSAGE or a FORMATTING_ERROR in a toast fails
 * here rather than only showing up as a raw key in the operator's confirmation. Without it, next-intl
 * resolves to its client build and every case in this file dies with "`getTranslations` is not supported
 * in Client Components" — measured, not assumed.
 */
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const { readFileSync: rf } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const messages = JSON.parse(rf(fileURLToPath(new URL('../messages/en.json', import.meta.url)), 'utf8'));
  return {
    getTranslations: async (ns: string | { namespace?: string }) =>
      createTranslator({
        locale: 'en',
        messages,
        namespace: (typeof ns === 'string' ? ns : ns?.namespace) as never,
        onError: (e) => {
          throw e;
        },
      }),
  };
});

import { createAttendanceRule, getAttendanceRule, type AttendanceRuleView } from '../core/attendance-rule';
import {
  saveScheduleGroupAttendanceAction,
  saveScheduleGroupOvertimeAction,
} from '../app/admin/attendance/schedule/actions';
import { updateAttendanceRuleAction } from '../app/admin/attendance-policy/rule-actions';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { readFileSync } from 'node:fs';
import { join as pathJoin, resolve as pathResolve } from 'node:path';

const rootDir = pathResolve(__dirname, '..');

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

/**
 * Every column that matters, as a plain comparable object. `deductionsEffectiveFrom` is in here on
 * purpose: "the switch is still on" is a weaker claim than "the switch is still on AND still started on
 * the same day", and it is the DATE that decides whether a closed payroll period can be reached.
 */
const snap = (r: AttendanceRuleView) => ({
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
  otRows: r.otRows.map((o) => ({
    fromMinutes: o.fromMinutes,
    toMinutes: o.toMinutes,
    ratePattern: o.ratePattern,
    rate: o.rate == null ? null : Number(o.rate),
    phRate: o.phRate == null ? null : Number(o.phRate),
    roundingMode: o.roundingMode,
    roundToMinutes: o.roundToMinutes,
  })),
});

let b: Base;
let ruleId: string;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});

/** A rule with the deduction switch ON, two overtime bands and non-default figures everywhere. */
async function seedRule(name = 'Plant crew'): Promise<string> {
  const { id } = await createAttendanceRule(actionCtx!, {
    name,
    description: 'Shared by the two plant shifts',
    status: 'active',
    lateGracePeriodMinutes: 7,
    lateAfterMinutes: 11,
    lateDeductMinutes: 13,
    includeGraceInLateness: true,
    earlyGracePeriodMinutes: 5,
    earlyAfterMinutes: 17,
    earlyDeductMinutes: 19,
    includeGraceInEarlyOut: true,
    applyToEarlyOt: true,
    // ⚠️ ON, so every case below is testing against a rule that CAN lose its switch. A fixture with the
    // switch off would make case B pass against code that clears it.
    applyDeductions: true,
    otRows: [
      { fromMinutes: 0, toMinutes: 120, ratePattern: 'flat', rate: 1.5, phRate: null, roundingMode: 'down', roundToMinutes: 15 },
      { fromMinutes: 121, toMinutes: 0, ratePattern: 'variable', rate: 2, phRate: 3, roundingMode: 'none', roundToMinutes: null },
    ],
  });
  return id;
}

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  actionCtx = adminCtx(b);
  redirectSpy.mockClear();
  ruleId = await seedRule();
});

describe('A. round trip — posting back what the form renders changes nothing', () => {
  it('the Attendance tab’s six figures round-trip unchanged', async () => {
    const before = snap((await getAttendanceRule(actionCtx!, ruleId))!);
    // Exactly what app/admin/attendance/schedule/page.tsx renders as defaultValue on that tab.
    await captureRedirect(() =>
      saveScheduleGroupAttendanceAction(
        fd({
          ruleId,
          lateGracePeriodMinutes: String(before.lateGracePeriodMinutes),
          earlyGracePeriodMinutes: String(before.earlyGracePeriodMinutes),
          lateAfterMinutes: String(before.lateAfterMinutes),
          lateDeductMinutes: String(before.lateDeductMinutes),
          earlyAfterMinutes: String(before.earlyAfterMinutes),
          earlyDeductMinutes: String(before.earlyDeductMinutes),
        }),
      ),
    );
    expect(snap((await getAttendanceRule(actionCtx!, ruleId))!)).toEqual(before);
  });

  it('the Overtime tab’s switch and rounding round-trip unchanged', async () => {
    const rule = (await getAttendanceRule(actionCtx!, ruleId))!;
    const before = snap(rule);
    const form: Record<string, string> = { ruleId, earlyOtEditor: '1' };
    if (before.applyToEarlyOt) form.applyToEarlyOt = 'on';
    for (const row of rule.otRows) {
      form[`roundingMode_${row.fromMinutes}`] = row.roundingMode;
      form[`roundToMinutes_${row.fromMinutes}`] = row.roundToMinutes == null ? '' : String(row.roundToMinutes);
    }
    await captureRedirect(() => saveScheduleGroupOvertimeAction(fd(form)));
    expect(snap((await getAttendanceRule(actionCtx!, ruleId))!)).toEqual(before);
  });
});

describe('B. the deduction switch does not move', () => {
  it('a save from the Attendance tab leaves the switch ON and its start date untouched', async () => {
    const before = snap((await getAttendanceRule(actionCtx!, ruleId))!);
    expect(before.applyDeductions, 'fixture precondition: the switch is ON').toBe(true);
    expect(before.deductionsEffectiveFrom, 'fixture precondition: it carries a start date').not.toBeNull();

    await captureRedirect(() =>
      saveScheduleGroupAttendanceAction(
        fd({ ruleId, lateGracePeriodMinutes: '2', earlyGracePeriodMinutes: '3', lateAfterMinutes: '20', lateDeductMinutes: '25', earlyAfterMinutes: '30', earlyDeductMinutes: '35' }),
      ),
    );
    const after = snap((await getAttendanceRule(actionCtx!, ruleId))!);
    expect(after.applyDeductions, 'the tab must not be able to turn the switch off').toBe(true);
    expect(after.deductionsEffectiveFrom, 'nor move the day it started').toBe(before.deductionsEffectiveFrom);
    // …and the six figures the tab DOES own really did change, so this is not passing on a no-op write.
    expect(after.lateGracePeriodMinutes).toBe(2);
    expect(after.earlyDeductMinutes).toBe(35);
  });

  it('a CRAFTED request body cannot flip it from either tab', async () => {
    // The tabs do not render this field; the point is that the action never reads it. A stale tab, a
    // copied form, or someone posting by hand must all be unable to reach the switch from here.
    const before = snap((await getAttendanceRule(actionCtx!, ruleId))!);
    await captureRedirect(() =>
      saveScheduleGroupAttendanceAction(fd({ ruleId, applyDeductions: '', lateGracePeriodMinutes: '4' })),
    );
    expect((await getAttendanceRule(actionCtx!, ruleId))!.applyDeductions, 'still on').toBe(true);
    await captureRedirect(() => saveScheduleGroupOvertimeAction(fd({ ruleId, applyDeductions: '' })));
    const after = snap((await getAttendanceRule(actionCtx!, ruleId))!);
    expect(after.applyDeductions, 'still on').toBe(true);
    expect(after.deductionsEffectiveFrom).toBe(before.deductionsEffectiveFrom);
  });

  it('the switch is still editable where it DOES live — the Schedule Group editor', async () => {
    // The other half, and it is what makes "it did not move" a relocation rather than a removal. If this
    // fails, the round did not keep the setting somewhere; it took it away.
    const rule = (await getAttendanceRule(actionCtx!, ruleId))!;
    await captureRedirect(() =>
      updateAttendanceRuleAction(
        fd({
          ruleId,
          name: rule.name,
          description: rule.description ?? '',
          status: rule.status,
          lateGracePeriodMinutes: String(rule.lateGracePeriodMinutes),
          lateAfterMinutes: String(rule.lateAfterMinutes),
          lateDeductMinutes: String(rule.lateDeductMinutes),
          includeGraceInLateness: 'on',
          earlyGracePeriodMinutes: String(rule.earlyGracePeriodMinutes),
          earlyAfterMinutes: String(rule.earlyAfterMinutes),
          earlyDeductMinutes: String(rule.earlyDeductMinutes),
          includeGraceInEarlyOut: 'on',
          applyToEarlyOt: 'on',
          // omitted ⇒ off, which is how the real form turns it off
          otRows: JSON.stringify(
            rule.otRows.map((o) => ({
              fromMinutes: o.fromMinutes,
              toMinutes: o.toMinutes,
              ratePattern: o.ratePattern,
              rate: o.rate,
              phRate: o.phRate,
              roundingMode: o.roundingMode,
              roundToMinutes: o.roundToMinutes,
            })),
          ),
        }),
      ),
    );
    const after = (await getAttendanceRule(actionCtx!, ruleId))!;
    expect(after.applyDeductions, 'the owning editor can still turn it off').toBe(false);
  });
});

describe('C. the overtime bands and rates survive a save from either tab', () => {
  it('the Attendance tab does not touch the band table', async () => {
    const before = snap((await getAttendanceRule(actionCtx!, ruleId))!);
    expect(before.otRows, 'fixture precondition: there are bands to lose').toHaveLength(2);
    await captureRedirect(() => saveScheduleGroupAttendanceAction(fd({ ruleId, lateGracePeriodMinutes: '9' })));
    expect(snap((await getAttendanceRule(actionCtx!, ruleId))!).otRows).toEqual(before.otRows);
  });

  it('the Overtime tab changes ONLY rounding — boundaries, pattern and rates are carried forward', async () => {
    const rule = (await getAttendanceRule(actionCtx!, ruleId))!;
    const before = snap(rule);
    const first = rule.otRows[0];
    const second = rule.otRows[1];
    await captureRedirect(() =>
      saveScheduleGroupOvertimeAction(
        fd({
          ruleId,
          earlyOtEditor: '1',
          applyToEarlyOt: 'on',
          [`roundingMode_${first.fromMinutes}`]: 'up',
          [`roundToMinutes_${first.fromMinutes}`]: '30',
          [`roundingMode_${second.fromMinutes}`]: 'none',
          [`roundToMinutes_${second.fromMinutes}`]: '',
          // Crafted: the tab does not render these, and the action must ignore them. A band boundary or a
          // rate changed from this screen is the money-shaped version of this item's risk.
          [`fromMinutes_${first.fromMinutes}`]: '999',
          [`rate_${first.fromMinutes}`]: '99',
        }),
      ),
    );
    const after = snap((await getAttendanceRule(actionCtx!, ruleId))!);
    expect(after.otRows.map((o) => [o.fromMinutes, o.toMinutes, o.ratePattern, o.rate, o.phRate])).toEqual(
      before.otRows.map((o) => [o.fromMinutes, o.toMinutes, o.ratePattern, o.rate, o.phRate]),
    );
    expect(after.otRows.map((o) => [o.roundingMode, o.roundToMinutes])).toEqual([
      ['up', 30],
      ['none', null],
    ]);
  });
});

describe('C2. the rounding form survives the band ids CHURNING, because it is not keyed on them', () => {
  /**
   * ⚠️ THIS CASE EXISTS BECAUSE THE FIRST IMPLEMENTATION HAD THE BUG, AND ONLY A LIVE SAVE FOUND IT.
   *
   * `updateAttendanceRule` replaces the overtime-band table WHOLESALE — delete, then insert — so every
   * `attendance_rule_ot_row.id` changes on every save of the rule, from any screen. The rounding form was
   * first keyed on `row.id`, which reads as the careful choice (ids, not positions) and is wrong here: a
   * page rendered before any other save would post field names that match nothing, the action would take
   * every band as "this submission said nothing about it", and the operator's rounding edit would be
   * discarded in silence behind a 303 back to a screen still showing the old value. tsc, eslint and every
   * other guard in this file stayed green through it.
   *
   * The key is the band's "From" boundary now — unique per rule by the continuous-ladder validation, and
   * stable across the re-insert. The sequence below is the one that exposed it: save once from the
   * ATTENDANCE tab (which churns the ids), then post rounding from a form rendered BEFORE that save.
   */
  it('a rounding edit still lands after another save has re-created the rows', async () => {
    const rendered = (await getAttendanceRule(actionCtx!, ruleId))!;
    const idsAtRender = rendered.otRows.map((o) => o.id);

    // Something else saves the rule — here, the Attendance tab, but the rule editor does the same thing.
    await captureRedirect(() => saveScheduleGroupAttendanceAction(fd({ ruleId, lateGracePeriodMinutes: '5' })));

    const afterChurn = (await getAttendanceRule(actionCtx!, ruleId))!;
    expect(
      afterChurn.otRows.map((o) => o.id),
      'precondition: the band ids really do churn — if this ever stops being true, say so here rather ' +
        'than deleting the case, because the KEYING decision below was made for this reason',
    ).not.toEqual(idsAtRender);
    expect(afterChurn.otRows.map((o) => o.fromMinutes), 'and the boundaries do NOT').toEqual(
      rendered.otRows.map((o) => o.fromMinutes),
    );

    // The stale page posts, keyed the way the page renders it: by boundary.
    const form: Record<string, string> = { ruleId, earlyOtEditor: '1', applyToEarlyOt: 'on' };
    for (const row of rendered.otRows) {
      form[`roundingMode_${row.fromMinutes}`] = 'up';
      form[`roundToMinutes_${row.fromMinutes}`] = '6';
    }
    await captureRedirect(() => saveScheduleGroupOvertimeAction(fd(form)));

    const after = snap((await getAttendanceRule(actionCtx!, ruleId))!);
    expect(
      after.otRows.map((o) => [o.roundingMode, o.roundToMinutes]),
      'the rounding edit must land, not be silently dropped',
    ).toEqual([
      ['up', 6],
      ['up', 6],
    ]);
  });

  it('the PAGE keys its fields the same way the action reads them', () => {
    /**
     * A contract between two files, so it is pinned across both (CLAUDE.md §8). Nothing else would catch
     * the page and the action drifting apart on the key: the form would submit, the action would find no
     * matching field, and every band would keep its stored value — a 303 and no change, which is exactly
     * what a successful save looks like from the outside.
     *
     * Source-shaped because the field NAME is what is under test, and a name is only observable in the
     * markup the page emits. The behavioural half is the case above.
     */
    // 665de026 — the fields moved off the list page onto the per-group screen, so the source this case
    // reads moved with them. The contract it pins is identical and still pinned across BOTH files.
    const page = readFileSync(
      pathJoin(rootDir, 'app/admin/attendance/schedule/group-sections.tsx'),
      'utf8',
    );
    expect(page, 'the rounding select is keyed on the band boundary').toContain('roundingMode_${row.fromMinutes}');
    expect(page, 'and so is the step input').toContain('roundToMinutes_${row.fromMinutes}');
    expect(page, 'never on the row id — it changes on every save of the rule').not.toContain('roundingMode_${row.id}');
    expect(page, 'never on the row id — it changes on every save of the rule').not.toContain('roundToMinutes_${row.id}');
  });
});

describe('D. a save from the new tab lands the SAME stored row as a save from the old screen', () => {
  it('the two writers agree, column for column', async () => {
    // Two rules seeded identically. One is edited through the Schedule tab's action with the six figures
    // the tab renders; the other through the Schedule Group editor's action carrying the SAME six values
    // in a complete submission, as that form posts them. Every column must match afterwards.
    const viaTabId = ruleId;
    const viaEditorId = await seedRule('Plant crew B');

    const SIX = {
      lateGracePeriodMinutes: '3',
      earlyGracePeriodMinutes: '4',
      lateAfterMinutes: '21',
      lateDeductMinutes: '22',
      earlyAfterMinutes: '23',
      earlyDeductMinutes: '24',
    };

    await captureRedirect(() => saveScheduleGroupAttendanceAction(fd({ ruleId: viaTabId, ...SIX })));

    const editorRule = (await getAttendanceRule(actionCtx!, viaEditorId))!;
    await captureRedirect(() =>
      updateAttendanceRuleAction(
        fd({
          ruleId: viaEditorId,
          name: editorRule.name,
          description: editorRule.description ?? '',
          status: editorRule.status,
          ...SIX,
          includeGraceInLateness: 'on',
          includeGraceInEarlyOut: 'on',
          applyToEarlyOt: 'on',
          applyDeductions: 'on',
          otRows: JSON.stringify(
            editorRule.otRows.map((o) => ({
              fromMinutes: o.fromMinutes,
              toMinutes: o.toMinutes,
              ratePattern: o.ratePattern,
              rate: o.rate,
              phRate: o.phRate,
              roundingMode: o.roundingMode,
              roundToMinutes: o.roundToMinutes,
            })),
          ),
        }),
      ),
    );

    const viaTab = snap((await getAttendanceRule(actionCtx!, viaTabId))!);
    const viaEditor = snap((await getAttendanceRule(actionCtx!, viaEditorId))!);
    // The two rules differ by NAME on purpose (a tenant-unique index forbids two of the same), so that is
    // the one field normalised away. Everything else — including the deduction switch and its start date —
    // must be identical, which is the plan's promise stated as an assertion.
    expect({ ...viaTab, name: '', description: '' }).toEqual({ ...viaEditor, name: '', description: '' });
  });
});

describe('E. the before-shift overtime switch can be turned OFF from the tab', () => {
  it('unticking it stores false — the marker is what makes that possible', async () => {
    // A browser omits an unchecked checkbox, so without the hidden `earlyOtEditor` marker this save and a
    // submission that never carried the control would be identical bytes, and the switch could never be
    // turned off. That is exactly the defect 7c834696 had to fix on this setting in the other editor.
    expect((await getAttendanceRule(actionCtx!, ruleId))!.applyToEarlyOt, 'fixture: it starts ON').toBe(true);
    await captureRedirect(() => saveScheduleGroupOvertimeAction(fd({ ruleId, earlyOtEditor: '1' })));
    expect((await getAttendanceRule(actionCtx!, ruleId))!.applyToEarlyOt).toBe(false);
  });

  it('a submission with NO marker leaves it alone, rather than clearing it', async () => {
    await captureRedirect(() => saveScheduleGroupOvertimeAction(fd({ ruleId })));
    expect(
      (await getAttendanceRule(actionCtx!, ruleId))!.applyToEarlyOt,
      'a form that did not carry the control must not be read as "off"',
    ).toBe(true);
  });
});

describe('F. a missing group refuses instead of writing against nothing', () => {
  /**
   * 665de026 — THE ONE REFUSAL THAT STILL LANDS ON THE LIST, and it is the exception that proves the rule.
   *
   * Every other save on this screen now stays on the Schedule Group it was made from ("Saving KEEPS YOU
   * WHERE YOU ARE with a confirmation"). This one cannot: the group named by the submission does not
   * exist, so there is no record page to stay on — a redirect to `/admin/attendance/schedule/<gone>/edit`
   * would answer a refusal with a second "this Schedule Group is not on the list" screen. It goes to the
   * list, where the operator can pick a group that does exist, which is what the message tells them to do.
   */
  it('redirects to the LIST with a message, because the record it names is gone', async () => {
    const target = await captureRedirect(() =>
      saveScheduleGroupAttendanceAction(fd({ ruleId: '00000000-0000-0000-0000-000000000000' })),
    );
    expect(target.startsWith('/admin/attendance/schedule?error='), target).toBe(true);
    // Not onto a per-group page: that is the distinction this case exists to hold.
    expect(target, 'no record path for a record that does not exist').not.toMatch(/\/schedule\/[^?]/);
    expect(decodeURIComponent(target)).toContain('no longer exists');
  });
});
