/**
 * r288 (8521e160) — THE SAME "PICK INDIVIDUALLY" DEFECT ON LEAVE ADJUSTMENTS AND ON NOTICE BOARD.
 *
 * r287 fixed Generate Entitlement. The reporter was told the identical box sits on two screens they did
 * not report, and this round puts the same picker on both while KEEPING the paste box on both.
 *
 * ── §A EXISTS BECAUSE THE TICKET'S DIAGNOSIS WAS WRONG ABOUT ONE OF THE TWO ───────────────────────────
 * The ticket says Notice Board "carries the typed text to the save and is rejected there". It is not.
 * `notice.criteria` is a **jsonb** column (db/schema.ts) and `cleanNotice` only checks the list is
 * non-empty, so "Irwin" SAVES. The draft page then reports a reach of one employee — it counts the stored
 * strings — the publish confirmation repeats that number, and `publishNotice` is where it dies, on
 * `employment.id IN (…)` against a **uuid** column. One step later and one step worse than reported.
 *
 * Leave Adjustments matches the ticket's mechanism but not its symptom: the preview action rejects, and
 * `AdjustmentForm`'s catch put `preview` back to null, which has always rendered as
 * `adjustmentsMatchedPending` — "Working it out…". The previous number does not stand; a PENDING sentence
 * stands in its place, forever. Both readings are the same silence, and the terminal sentence this round
 * adds replaces both (pinned in the .dom file next door).
 *
 * Every claim above is asserted against a REAL DATABASE below, not reasoned about, because a wrong premise
 * is how this exact item has now been mis-diagnosed twice.
 *
 * ── WHAT EACH SECTION IS FOR ─────────────────────────────────────────────────────────────────────────
 * §A the premise, both screens · §B the two doors resolving to ONE population, through the real services
 * that write the rows · §C the merge rule is reached for rather than re-inlined, at all four call sites ·
 * §D the help strings that were lying are gone, in all six locales.
 *
 * The TERMINAL STATES — a search with matches, a search with none that names what was searched, zero
 * selected refused before Save, and a failed count that stops claiming to be working — are claims about
 * what an operator SEES, so they live in test/r288-employee-pickers.dom.test.tsx. Neither file replaces
 * the other.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { applyLeaveAdjustmentBatch, previewLeaveAdjustmentBatch } from '../core/leave-adjustment';
import { createNotice, getNotice, publishNotice } from '../core/notice';
import { mergeEmploymentSelection } from '../lib/employment-selection';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/**
 * Exactly what BOTH server actions build from a post — `app/admin/leave/adjustments/actions.ts` `idsFrom`
 * and `app/admin/notice-board/actions.ts` `inputFrom`. Modelled here so the two doors can be driven from a
 * real FormData; that the ACTIONS actually contain this expression rather than a re-inlined split is §C's
 * job, and without §C this helper would only be testing itself.
 */
const idsFromForm = (fd: FormData): string[] =>
  mergeEmploymentSelection(fd.getAll('employmentIds').map(String), String(fd.get('employmentIdsRaw') ?? ''));

let b: Base;
let alice: string;
let bob: string;
let carol: string;

const hire = async (fullName: string) => {
  const r = await hireEmployee(adminCtx(b), {
    person: { fullName, primaryEmail: `r288_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  return r.employmentId;
};

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  alice = await hire('Alice Chan');
  bob = await hire('Bob Lim');
  carol = await hire('Carol Ng');
});

/** The employments a written batch actually adjusted, read off the ledger rows it stamped. */
async function adjustedBy(batchId: string): Promise<string[]> {
  const rows = await owner.db
    .select({ e: schema.leaveLedger.employmentId })
    .from(schema.leaveLedger)
    .where(eq(schema.leaveLedger.adjustmentBatchId, batchId));
  return [...new Set(rows.map((r) => r.e))].sort();
}

/** Who a published notice actually reached. ORDER BY via sort — never "the last row" (CLAUDE.md §8). */
async function recipientsOf(noticeId: string): Promise<string[]> {
  const rows = await owner.db
    .select({ e: schema.noticeRecipient.employmentId })
    .from(schema.noticeRecipient)
    .where(eq(schema.noticeRecipient.noticeId, noticeId));
  return rows.map((r) => r.e).sort();
}

const draft = (employmentIds: string[], title = 'Town hall') =>
  createNotice(adminCtx(b), {
    title,
    body: 'Body',
    startOn: '2026-08-01',
    endOn: '2026-08-31',
    targetMode: 'individual',
    employmentIds,
  });

const adjust = (employmentIds: string[], reason: string) =>
  applyLeaveAdjustmentBatch(adminCtx(b), {
    leaveTypeIds: [b.annualLeaveTypeId],
    days: 1,
    effectiveOn: '2026-08-05',
    reason,
    targetMode: 'individual',
    employmentIds,
  });

describe('r288 §A · the premise, on both screens, against a real database', () => {
  /**
   * The rejection the reporter saw as silence. `employment.id` is a uuid column, so the contents of the
   * paste box are not "matched against references and found wanting" — the statement never runs.
   */
  it('ADJUSTMENTS: a typed name makes the live count REJECT — it does not resolve to an empty selection', async () => {
    const err = await previewLeaveAdjustmentBatch(adminCtx(b), {
      leaveTypeIds: [b.annualLeaveTypeId],
      effectiveOn: '2026-08-05',
      targetMode: 'individual',
      employmentIds: ['Irwin'],
    }).then(
      () => null,
      (e: unknown) => e as Error & { cause?: { message?: string } },
    );

    expect(err, 'a typed name must not resolve quietly to an empty selection').not.toBeNull();
    // The restriction is `employment.id IN (…)` — an id list, never a reference lookup and never a name
    // search. drizzle prints the statement and the bound parameter, which is the evidence for both halves.
    expect(err!.message).toMatch(/"employment"\."id" in \(/);
    expect(err!.message).toContain('Irwin');
    // And the reason it is rejected rather than empty: the column is a uuid. Read off the DRIVER's cause,
    // because drizzle's outer message is the statement, not the verdict.
    expect(String(err!.cause?.message ?? ''), 'the driver must name the uuid cast').toMatch(/uuid/i);
  });

  /**
   * ⚠️ THE CORRECTION. Pinned so that a later reader does not "fix" this round's diagnosis back to the
   * ticket's wrong one, and so that nobody adds a uuid guard at Save believing it is the place this fails.
   */
  it('NOTICE BOARD: a typed name SAVES, is counted as one employee, and is refused at PUBLISH — not at Save', async () => {
    const created = await draft(['Irwin']);
    expect(created.id, 'the ticket says Save refuses this; the jsonb column happily stores it').toBeTruthy();

    const stored = await getNotice(adminCtx(b), created.id);
    expect(stored?.criteria.employmentIds).toEqual(['Irwin']);
    // The draft page's reach for individual targeting is `(n.criteria.employmentIds ?? []).length`
    // (app/admin/notice-board/[id]/page.tsx), and the publish confirmation repeats that number. So the
    // screen promises ONE EMPLOYEE for a string that is not an employee at all.
    expect((stored?.criteria.employmentIds ?? []).length).toBe(1);

    const err = await publishNotice(adminCtx(b), created.id).then(
      () => null,
      (e: unknown) => e as Error & { cause?: { message?: string } },
    );
    expect(err, 'publish is where it actually dies').not.toBeNull();
    expect(err!.message).toMatch(/"employment"\."id" in \(/);
    expect(String(err!.cause?.message ?? '')).toMatch(/uuid/i);
  });

  it('NOTICE BOARD: the same notice built from REAL ids publishes — so the uuid cast is the whole difference', async () => {
    const good = await draft([alice], 'Town hall (real ids)');
    expect((await publishNotice(adminCtx(b), good.id)).recipients).toBe(1);
    expect(await recipientsOf(good.id)).toEqual([alice]);
  });
});

describe('r288 §B · two ways in, ONE population — through the services that write the rows', () => {
  /**
   * The assertion the brief asked for, made where it cannot be faked: not "the helper returns the same
   * array" but "the SAME PEOPLE end up adjusted / reached, whichever door named them".
   */
  it('ADJUSTMENTS: picking two people and pasting the same two adjust an IDENTICAL set', async () => {
    const picker = new FormData();
    picker.append('employmentIds', alice);
    picker.append('employmentIds', bob);

    const paste = new FormData();
    // Deliberately the OTHER order, with a comma and a new line, so the assertion is about WHO, not about
    // how the operator typed.
    paste.set('employmentIdsRaw', `${bob},\n${alice}`);

    const fromPicker = await adjust(idsFromForm(picker), 'r288 picker');
    const fromPaste = await adjust(idsFromForm(paste), 'r288 paste');

    expect(await adjustedBy(fromPicker.batchId)).toEqual([alice, bob].sort());
    expect(await adjustedBy(fromPaste.batchId)).toEqual(await adjustedBy(fromPicker.batchId));
    expect(fromPaste.targeted).toBe(fromPicker.targeted);
    expect(fromPaste.written).toBe(fromPicker.written);
    // …and neither door reaches somebody who was not named. A selection that silently widened would be the
    // single most expensive bug on a screen that moves days on and off balances in bulk.
    expect(await adjustedBy(fromPicker.batchId)).not.toContain(carol);
  });

  it('NOTICE BOARD: the two doors store the same audience and publish to the same people', async () => {
    const picker = new FormData();
    picker.append('employmentIds', alice);
    picker.append('employmentIds', bob);

    const paste = new FormData();
    paste.set('employmentIdsRaw', `${bob} ${alice}`);

    const a = await draft(idsFromForm(picker), 'picked');
    const c = await draft(idsFromForm(paste), 'pasted');

    const storedA = (await getNotice(adminCtx(b), a.id))!.criteria.employmentIds ?? [];
    const storedC = (await getNotice(adminCtx(b), c.id))!.criteria.employmentIds ?? [];
    expect([...storedA].sort()).toEqual([alice, bob].sort());
    expect([...storedC].sort()).toEqual([...storedA].sort());

    expect((await publishNotice(adminCtx(b), a.id)).recipients).toBe(2);
    expect((await publishNotice(adminCtx(b), c.id)).recipients).toBe(2);
    expect(await recipientsOf(c.id)).toEqual(await recipientsOf(a.id));
    expect(await recipientsOf(a.id)).not.toContain(carol);
  });

  /**
   * ⚠️ THE DE-DUPLICATION IS ASSERTED ON THE MERGE, NOT ON THE ENGINE, AND THAT DISTINCTION IS THE WHOLE
   * POINT OF THIS TEST.
   *
   * Both services de-duplicate again on the way in — `applyLeaveAdjustmentBatch` does
   * `Array.from(new Set(...))` on `p.employmentIds`, and `cleanNotice` does the same — so a guard that only
   * read `targeted`, `written` or `recipients` would go on passing with the de-duplication REMOVED from
   * `mergeEmploymentSelection`. That is exactly how a guard here goes vacuous, and it is why the first
   * assertion in each half below is on the merged list itself.
   *
   * It matters beyond tidiness: the count this screen SHOWS is computed from what is merged here, so a
   * merge that double-counted would promise "2 employees" for one person.
   */
  it('the MERGE ITSELF de-duplicates across the two doors — not the engine behind it', async () => {
    const both = new FormData();
    both.append('employmentIds', alice);
    both.append('employmentIds', bob);
    both.set('employmentIdsRaw', `${alice} ${bob}`);

    expect(idsFromForm(both), 'the merge must not hand a service a duplicate').toEqual([alice, bob]);
    // Pure-rule cases the database cannot express: the same id twice in one door, and either door alone.
    expect(mergeEmploymentSelection([alice, alice], alice)).toEqual([alice]);
    expect(mergeEmploymentSelection([alice, bob], '')).toEqual([alice, bob]);
    expect(mergeEmploymentSelection([], `${alice},${bob}`)).toEqual([alice, bob]);

    // And the population is the same as either door alone — the half that would still pass without the
    // line above, kept because it proves the merged list is not merely duplicate-free but CORRECT.
    const mixed = await adjust(idsFromForm(both), 'r288 both doors');
    expect(await adjustedBy(mixed.batchId)).toEqual([alice, bob].sort());

    const notice = await draft(idsFromForm(both), 'both doors');
    expect((await publishNotice(adminCtx(b), notice.id)).recipients).toBe(2);
  });

  /**
   * THE EDIT SCREEN'S ROUND TRIP. `NoticeForm` splits a saved audience back across the two doors — known
   * ids become chips, anything else stays in the paste box — so a plain Save on an untouched audience must
   * store exactly what was there. Dropping the unknown half would silently shrink a notice's audience.
   */
  it('NOTICE BOARD: a saved audience survives a re-save whichever door it is split across', async () => {
    const stray = '00000000-0000-4000-8000-0000000000ff'; // well-formed, not this tenant's — the "unknown" half
    const original = await draft([alice, stray], 'mixed audience');

    // The re-post the edit screen would make: `alice` returns through the picker, `stray` through the box.
    const resave = new FormData();
    resave.append('employmentIds', alice);
    resave.set('employmentIdsRaw', stray);
    expect([...idsFromForm(resave)].sort()).toEqual(
      [...((await getNotice(adminCtx(b), original.id))!.criteria.employmentIds ?? [])].sort(),
    );
  });
});

describe('r288 §C · all four call sites reach for the ONE rule', () => {
  /**
   * SOURCE SHAPE, AND THE REASON IS NOT LAZINESS — written down so a later reader does not mistake it for
   * that. These are `'use server'` actions that call `requireAdmin()` and finish by `redirect()`ing (which
   * works by THROWING `NEXT_REDIRECT`); there is no request context in vitest to give them and no return
   * value to inspect. §B above already proves the RULE against the real services, so what is left to pin is
   * that each caller REACHES FOR that rule rather than re-inlining the split — the exact regression that
   * would put the population a screen confirms out of step with the population it writes, with both halves'
   * tests still green.
   */
  const adjAction = read('app/admin/leave/adjustments/actions.ts');
  const adjForm = read('components/leave/adjustment-form.tsx');
  const noticeAction = read('app/admin/notice-board/actions.ts');
  const noticeForm = read('components/notice/notice-form.tsx');

  it('the Adjustments write path merges both fields through mergeEmploymentSelection', () => {
    expect(adjAction).toContain("import { mergeEmploymentSelection } from '@/lib/employment-selection'");
    expect(adjAction).toContain("mergeEmploymentSelection(fd.getAll('employmentIds').map(String)");
    // The hand-rolled split that used to live here must be GONE, or the picker's ids would simply be
    // dropped on submit while the matched count kept counting them.
    expect(adjAction).not.toContain('.split(/[\\s,]+/)');
  });

  it("the Adjustments live count merges the SAME two fields through the SAME function", () => {
    expect(adjForm).toContain("import { mergeEmploymentSelection } from '@/lib/employment-selection'");
    expect(adjForm).toContain("mergeEmploymentSelection(fd.getAll('employmentIds').map(String)");
    expect(adjForm).not.toContain('.split(/[\\s,]+/)');
  });

  it('the Notice Board write path merges both fields through mergeEmploymentSelection', () => {
    expect(noticeAction).toContain("import { mergeEmploymentSelection } from '@/lib/employment-selection'");
    expect(noticeAction).toContain("mergeEmploymentSelection(fd.getAll('employmentIds').map(String)");
    expect(noticeAction).not.toContain('.split(/[\\s,]+/)');
  });

  it('both forms post under the field name the actions read, and keep the paste field', () => {
    // The MultiSelectPopover form contract is `name` → one hidden input per selected id. A rename here is
    // silent: the control still looks right and the run simply covers nobody.
    for (const [label, src] of [
      ['adjustment-form', adjForm],
      ['notice-form', noticeForm],
    ] as const) {
      expect(src, `${label} posts the picked ids`).toContain('name="employmentIds"');
      expect(src, `${label} keeps the paste box`).toContain('name="employmentIdsRaw"');
    }
  });

  it('no third or fourth picker was written — r287s house control is reused on both screens', () => {
    for (const [label, src] of [
      ['adjustment-form', adjForm],
      ['notice-form', noticeForm],
    ] as const) {
      expect(src, `${label} must mount the shared popover`).toMatch(
        /import \{ MultiSelectPopover \} from '@\/components\/ui\/multi-select-popover'/,
      );
      expect(src, `${label} must not declare a local multi-select`).not.toMatch(/function\s+\w*MultiSelect\w*\s*\(/);
      // …and the search rule is the house one too (lib/employee-search.ts), not a second substring filter
      // written per screen: "emp0008" must find "EMP-0008" on all three screens or the promise the row
      // makes by printing an Employee ID is broken one layer down.
      expect(src, `${label} must use the house search rule`).toContain(
        "import { matchesEmployeeSearch } from '@/lib/employee-search'",
      );
      // Both opt-in props r287 added must be passed. `emptyLabelFor` in particular is the terminal state
      // this whole round is about: omitting it renders an EMPTY PANEL, which asserts nothing.
      expect(src, `${label} must pass matchOption`).toContain('matchOption={matchEmployee}');
      expect(src, `${label} must pass emptyLabelFor`).toContain('emptyLabelFor={(query) =>');
    }
  });

  /**
   * THE SERVER-PAGE HALF. Same reason as above and no more of an excuse: rendering an async server
   * component needs a request, a session and a database, and the thing at risk is one wiring line. It was
   * verified for real — a dev-server render of both routes returned 200 with the seeded employments in the
   * RSC payload as `{id, name, employeeCode}` and zero MISSING_MESSAGE / IntlError — and this keeps that
   * wiring from being deleted afterwards.
   */
  it('both server pages read the employment list and hand it over as PLAIN DATA', () => {
    const adjPage = read('app/admin/leave-config/adjustments/page.tsx');
    expect(adjPage).toContain('listEmployees');
    expect(adjPage).toContain('employees={employments.map(');
    expect(adjPage).toContain('employeeCode: e.employeeCode');
    expect(adjPage.includes("'use client'"), 'the page must stay a server component').toBe(false);

    // Notice Board reads it ONCE in the shared vocabulary module, because two pages mount the same form and
    // a second `listEmployees` call is a second thing to keep in step.
    const vocab = read('app/admin/notice-board/criteria-options.ts');
    expect(vocab).toContain('listEmployees');
    expect(vocab).toContain('employeeCode: e.employeeCode');
    for (const rel of ['app/admin/notice-board/new/page.tsx', 'app/admin/notice-board/[id]/page.tsx']) {
      const page = read(rel);
      expect(page, `${rel} must hand the list over`).toContain('employees={vocab.employees}');
      expect(page.includes("'use client'"), `${rel} must stay a server component`).toBe(false);
    }
  });

  /**
   * NOTICE BOARD'S BOUNDARY IS THE STRICTER ONE and is worth its own assertion. `NoticeForm` takes its copy
   * as a plain `labels` object rather than a `t` function, so the three FUNCTION props
   * `MultiSelectPopover` requires have to be built on the CLIENT side of the boundary from strings that
   * crossed it. r272 shipped a 500 doing the opposite with tsc, eslint and thirteen guards green.
   */
  it('Notice Board builds the popovers callbacks from STRINGS that crossed the boundary', () => {
    expect(noticeForm).toContain("labels.employeeSelectedCountTemplate.replace('{count}'");
    expect(noticeForm).toContain("labels.employeeNoMatchTemplate.replace('{query}'");
    expect(noticeForm).toContain("labels.employeeRemoveTemplate.replace('{name}'");
    // …and no label may arrive as a function. The two pages pass `t('…')` CALLS, whose results are strings.
    for (const rel of ['app/admin/notice-board/new/page.tsx', 'app/admin/notice-board/[id]/page.tsx']) {
      expect(read(rel), `${rel} must not send a translator across`).not.toMatch(/employee\w*=\{t\}/);
    }
  });

  /**
   * ⚠️ FOUND BY RENDERING, NOT BY REASONING — and written down here because nothing else in this repo
   * could have caught it.
   *
   * The three template labels carry an ICU VARIABLE that the client substitutes. A bare
   * `t('fEmployeeNoMatch')` does not return the raw message: next-intl FORMATS it, finds no `query`,
   * throws FORMATTING_ERROR, and falls back to rendering the KEY PATH. The first dev-server render of
   * /admin/notice-board/new in this round returned **200** with
   *
   *     "employeeNoMatchTemplate":"notices.fEmployeeNoMatch"
   *
   * in the RSC payload, and three `Error: FORMATTING_ERROR` lines in the dev log. tsc, eslint and every
   * jsdom guard in this round were green over it, because a jsdom guard builds these labels straight out
   * of messages/en.json and never goes through next-intl at all. That is CLAUDE.md §8's "a 200 is not a
   * render check", verbatim, and it is the r272 class this round was briefed to avoid.
   *
   * SOURCE SHAPE, DELIBERATELY: the defect lives in how a SERVER component calls `t`, and rendering an
   * async server component needs a request, a session and a database. What is checkable here — and what
   * would actually regress — is that each template key is given its own placeholder back as the value.
   */
  it('the three ICU template labels pass their placeholder back in, or they render as a key path', () => {
    for (const rel of ['app/admin/notice-board/new/page.tsx', 'app/admin/notice-board/[id]/page.tsx']) {
      const page = read(rel);
      expect(page, `${rel} fEmployeeNoMatch`).toContain("t('fEmployeeNoMatch', { query: '{query}' })");
      expect(page, `${rel} fEmployeeSelectedCount`).toContain("t('fEmployeeSelectedCount', { count: '{count}' })");
      expect(page, `${rel} fEmployeeRemove`).toContain("t('fEmployeeRemove', { name: '{name}' })");
    }
  });
});

describe('r288 §D · the help strings that were lying are gone, in all six locales', () => {
  /**
   * `adjustmentsEmploymentIdsHelp` ("Paste employee references, separated by spaces, commas or new lines")
   * and its Notice Board twin `fEmploymentIdsHelp` were the copy the reporter read before typing a name
   * into a box that could never take one. They are RETIRED rather than reworded, because both screens now
   * have two controls and one sentence cannot honestly describe both. Retired only now that nothing
   * references them — which is asserted here, not assumed.
   */
  const RETIRED: [string, (m: Record<string, unknown>) => Record<string, unknown>][] = [
    ['adjustmentsEmploymentIdsHelp', (m) => (m.admin as Record<string, Record<string, unknown>>).leave],
    ['adjustmentsEmploymentIds', (m) => (m.admin as Record<string, Record<string, unknown>>).leave],
    ['fEmploymentIdsHelp', (m) => m.notices as Record<string, unknown>],
    ['fEmploymentIds', (m) => m.notices as Record<string, unknown>],
  ];

  it('no source file still references either retired key', () => {
    for (const rel of [
      'components/leave/adjustment-form.tsx',
      'components/notice/notice-form.tsx',
      'app/admin/notice-board/new/page.tsx',
      'app/admin/notice-board/[id]/page.tsx',
      'app/admin/leave-config/adjustments/page.tsx',
    ]) {
      const src = read(rel);
      for (const [key] of RETIRED) expect(src, `${rel} still uses ${key}`).not.toContain(`'${key}'`);
    }
  });

  it('the keys are gone from every locale, and the honest ones are present in every locale', () => {
    for (const loc of LOCALES) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as Record<string, unknown>;
      for (const [key, at] of RETIRED) expect(at(m), `${loc}.${key}`).not.toHaveProperty(key);

      const leave = (m.admin as Record<string, Record<string, string>>).leave;
      const notices = m.notices as Record<string, string>;
      for (const k of [
        'adjustmentsEmployeePicker',
        'adjustmentsEmployeeNoneChosen',
        'adjustmentsEmployeeSearchPlaceholder',
        'adjustmentsEmployeeNoMatch',
        'adjustmentsEmployeeNonePicked',
        'adjustmentsPasteAlternative',
        'adjustmentsPasteAlternativeHelp',
        'adjustmentsMatchedUnknown',
      ]) {
        expect(leave[k], `${loc}.admin.leave.${k}`).toBeTruthy();
      }
      for (const k of [
        'fEmployeePicker',
        'fEmployeeNoneChosen',
        'fEmployeeSearch',
        'fEmployeeNoMatch',
        'fEmployeeNonePicked',
        'fEmployeeSelectedCount',
        'fEmployeeSelectAll',
        'fEmployeeClearAll',
        'fEmployeeRemove',
        'fPasteAlternative',
        'fPasteAlternativeHelp',
      ]) {
        expect(notices[k], `${loc}.notices.${k}`).toBeTruthy();
      }
      // The three TEMPLATES must keep their placeholder in every locale: `String.replace` is silent, so a
      // translation that dropped `{query}` would render a sentence that names nothing — the very silence
      // this round is removing — with no MISSING_MESSAGE and no test failure anywhere else.
      expect(notices.fEmployeeNoMatch, `${loc} fEmployeeNoMatch`).toContain('{query}');
      expect(notices.fEmployeeSelectedCount, `${loc} fEmployeeSelectedCount`).toContain('{count}');
      expect(notices.fEmployeeRemove, `${loc} fEmployeeRemove`).toContain('{name}');
      expect(leave.adjustmentsEmployeeNoMatch, `${loc} adjustmentsEmployeeNoMatch`).toContain('{query}');
    }
  });

  it('every locale still carries the SAME set of keys — nothing was retired from five files out of six', () => {
    const paths = (o: Record<string, unknown>, p = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? paths(v as Record<string, unknown>, `${p}${k}.`)
          : [`${p}${k}`],
      );
    const en = paths(JSON.parse(read('messages/en.json'))).sort();
    for (const loc of LOCALES) {
      expect(paths(JSON.parse(read(`messages/${loc}.json`))).sort(), `${loc} key set`).toEqual(en);
    }
  });
});
