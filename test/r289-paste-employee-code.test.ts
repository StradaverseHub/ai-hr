/**
 * r289 — THE PASTE BOX TAKES THE EMPLOYEE ID YOU CAN SEE.
 *
 * ── THE FAULT ─────────────────────────────────────────────────────────────────────────────────────────
 * Beside each employee picker (Generate Entitlement, Leave Adjustments, Notice Board) there is a second
 * box for naming a bulk population in one go. It accepted ONLY the internal employment uuid — a value this
 * product never displays anywhere — and not `EMP-0008`, the Employee ID a person can see on screen and
 * copy out of a spreadsheet. So the box was unusable for the one job it exists for.
 *
 * ── WHAT THIS PINS, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────────────────────────────────
 * `lib/employment-selection.ts` says in bold that it VALIDATES NOTHING, because filtering to "ids that
 * look right" would be a second, weaker authority in front of `resolveOrgCriteriaTargets`. That warning
 * STANDS. What was added is a RESOLVER — employee code → employment id, before the restriction is handed
 * over — and §A's third case is the one that keeps the two apart: a token matching NOTHING is REPORTED and
 * STILL PASSED THROUGH, so it resolves to nobody rather than being silently dropped. Dropping a typo would
 * turn a twelve-person run into a ten-person run that looked like it succeeded.
 *
 *   §A  the resolver itself, as a pure function: three arms, the fold, the nulls and the collisions
 *   §B  the SAME question asked of the REAL ENGINE: a pasted code covers exactly who the picker covers
 *   §C  NOTICE BOARD, the worst case: a mixed paste cannot produce a draft whose stated reach counts the
 *       tokens that name nobody — without dropping them from the notice
 *   §D  every call site reaches for the one rule, and hands it a population
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hireEmployee } from '../core/org';
import { createNotice, getNotice } from '../core/notice';
import { previewLeaveGeneration } from '../core/leave-generation';
import { listEmployeePickOptions } from '../core/read';
import {
  mergeEmploymentSelection,
  resolveEmploymentSelection,
  visibleEmploymentIds,
  type EmployeePickOption,
} from '../lib/employment-selection';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, seedEntitlement, type Base } from './harness';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

/**
 * §A — THE RULE ITSELF, with no database in sight.
 *
 * `lib/employment-selection.ts` is deliberately dependency-free (no React, no `next/*`, no db) so a client
 * island, a server action and a plain unit test can all import it. This section is what that buys: the
 * resolution rule pinned directly, at the level the merge itself returns, rather than through a count
 * computed further down an engine that de-duplicates again on its own.
 */
describe('r289 §A · the resolver, as a pure rule over a list already in hand', () => {
  const IRWIN = '11111111-1111-4111-8111-111111111111';
  const NADIA = '22222222-2222-4222-8222-222222222222';
  const NOCODE = '33333333-3333-4333-8333-333333333333';
  const people: EmployeePickOption[] = [
    { id: IRWIN, name: 'Irwin Tan', employeeCode: 'EMP-0008' },
    { id: NADIA, name: 'Nadia Rahim', employeeCode: 'EMP-0009' },
    // The column is nullable (db/schema.ts `employment.employee_code`) and a tenant that has not adopted
    // Employee IDs is full of rows like this one.
    { id: NOCODE, name: 'Wong Mei Ling', employeeCode: null },
  ];

  /**
   * ⚠️ THE THREE ARMS, AND THE THIRD IS WHERE A VACUOUS GUARD WOULD HIDE. Asserted on the MERGE'S OWN
   * OUTPUT — never on a count taken further down, because `core/leave-generation.ts` de-duplicates
   * independently on the way in and would report the right number over a broken merge.
   */
  it('ARM 1 — a pasted Employee ID resolves to the SAME id the picker produces for that person', () => {
    expect(mergeEmploymentSelection([], 'EMP-0008', people)).toEqual([IRWIN]);
    // …which is, to the letter, what the picker posts for Irwin:
    expect(mergeEmploymentSelection([IRWIN], '', people)).toEqual([IRWIN]);
    expect(mergeEmploymentSelection([], 'EMP-0008', people)).toEqual(mergeEmploymentSelection([IRWIN], '', people));
  });

  it('ARM 2 — a pasted INTERNAL id still works, untouched', () => {
    expect(mergeEmploymentSelection([], IRWIN, people)).toEqual([IRWIN]);
    expect(mergeEmploymentSelection([], `${IRWIN} ${NADIA}`, people)).toEqual([IRWIN, NADIA]);
    // …and it is not REPORTED either. A perfectly good uuid named as unrecognised would be a new lie in
    // place of the old one.
    expect(resolveEmploymentSelection([], `${IRWIN},${NADIA}`, people).unmatched).toEqual([]);
  });

  it('ARM 3 — a token matching NOTHING is REPORTED **and still passed through**, never dropped', () => {
    const r = resolveEmploymentSelection([], 'EMP-0008 NOPE-1 EMP-0009', people);
    // NAMED …
    expect(r.unmatched, 'the screen must be able to say which one was wrong').toEqual(['NOPE-1']);
    // … AND STILL HANDED OVER, in the position it was typed. This is the assertion that keeps the module's
    // "IT VALIDATES NOTHING" header true: the report is a MESSAGE, and the restriction handed to
    // `resolveOrgCriteriaTargets` still contains the typo, so it resolves to nobody rather than making a
    // three-person run look like a successful two-person one.
    expect(r.ids).toEqual([IRWIN, 'NOPE-1', NADIA]);
    expect(r.ids, 'dropping it would make a typo look like a smaller run that worked').toContain('NOPE-1');
  });

  it('the fold equivalence: EMP-0008, emp0008 and EMP 0008 all reach the same person', () => {
    for (const spelling of ['EMP-0008', 'emp0008', 'EMP 0008', 'emp-0008', 'Emp.0008', 'emp_0008']) {
      expect(mergeEmploymentSelection([], spelling, people), spelling).toEqual([IRWIN]);
      expect(resolveEmploymentSelection([], spelling, people).unmatched, spelling).toEqual([]);
    }
  });

  /**
   * The space case is the one the paste box could not have got right by folding alone: whitespace is how
   * this box has ALWAYS separated one reference from the next, so `EMP 0008` arrives as two tokens that
   * each name nobody. Rejoining them is allowed only because it can move a token out of exactly one state
   * — "matched nobody" — and only into "matched exactly one real person".
   */
  it('rejoining never takes a token away from somebody it already named', () => {
    // Two internal ids on one line: both resolve on their own, so nothing is rejoined and nobody is lost.
    expect(mergeEmploymentSelection([], `${IRWIN} ${NADIA}`, people)).toEqual([IRWIN, NADIA]);
    // Two tokens that name nobody and spell nothing when joined: BOTH are reported, BOTH pass through.
    const junk = resolveEmploymentSelection([], 'ZZZ 999', people);
    expect(junk.unmatched).toEqual(['ZZZ', '999']);
    expect(junk.ids).toEqual(['ZZZ', '999']);
  });

  it('a NULL or blank employee code names NOBODY — it is not a code, it is the absence of one', () => {
    // The unique index that makes code → id unambiguous is on (tenant_id, employee_code), and Postgres
    // treats NULLs as distinct there: many rows legitimately have no code at all. Indexing the empty
    // string would make every stray separator match whichever of them was read first.
    const r = resolveEmploymentSelection([], '""', people);
    expect(r.ids).toEqual(['""']);
    expect(r.unmatched).toEqual(['""']);
    // …and the person with no code is still perfectly reachable by id and through the picker.
    expect(mergeEmploymentSelection([NOCODE], '', people)).toEqual([NOCODE]);
  });

  /**
   * FOLDING IS LOSSY AND THE UNIQUE INDEX DOES NOT COVER IT. `EMP-0008` and `EMP0008` are two DIFFERENT
   * codes under `employment_employee_code_uq` — both legal, both storable — and they fold to one key.
   * Choosing one would quietly put a run against the wrong person, the same call
   * `core/payroll-txn-import.ts` makes when two people share a code.
   */
  it('a folded COLLISION is refused, not guessed — and the exact spelling still wins', () => {
    const twins: EmployeePickOption[] = [
      { id: IRWIN, name: 'Irwin Tan', employeeCode: 'EMP-0008' },
      { id: NADIA, name: 'Nadia Rahim', employeeCode: 'EMP0008' },
    ];
    // `EMP--0008` matches NEITHER code exactly and folds onto BOTH, which is the only way a collision can
    // actually be reached: `emp0008` is itself one of the two stored codes and therefore unambiguous.
    const loose = resolveEmploymentSelection([], 'EMP--0008', twins);
    expect(loose.ids, 'neither twin may be chosen for a token that names both').toEqual(['EMP--0008']);
    expect(loose.unmatched).toEqual(['EMP--0008']);
    // …and a REJOIN cannot pick between them either.
    const rejoined = resolveEmploymentSelection([], 'EMP-- 0008', twins);
    expect(rejoined.ids).toEqual(['EMP--', '0008']);
    expect(rejoined.unmatched).toEqual(['EMP--', '0008']);
    // An EXACT code is unambiguous by the unique index, so each twin is still reachable by its own
    // spelling — refusing those too would be the "second, weaker authority" the module header forbids.
    expect(mergeEmploymentSelection([], 'EMP-0008', twins)).toEqual([IRWIN]);
    expect(mergeEmploymentSelection([], 'emp0008', twins)).toEqual([NADIA]);
  });

  it('picked AND pasted for the same person is ONE person, because both became the same id first', () => {
    // The de-duplication trap this round had to avoid: resolve first, de-duplicate second. The other
    // order counts Irwin twice, and every count computed downstream still reads 1 because the engine
    // de-duplicates again on its own.
    expect(mergeEmploymentSelection([IRWIN], 'EMP-0008', people)).toEqual([IRWIN]);
    expect(mergeEmploymentSelection([IRWIN], `emp0008 ${IRWIN}`, people)).toEqual([IRWIN]);
    // …and a repeated bad token is named once, not once per line.
    expect(resolveEmploymentSelection([], 'NOPE-1\nNOPE-1', people).unmatched).toEqual(['NOPE-1']);
  });

  it('an empty population resolves nothing and drops nothing — r287 behaviour, exactly', () => {
    expect(mergeEmploymentSelection(['a', 'b'], 'b c', [])).toEqual(['a', 'b', 'c']);
    expect(mergeEmploymentSelection([], 'EMP-0008', [])).toEqual(['EMP-0008']);
  });
});

/**
 * §B — THE SAME QUESTION ASKED OF THE REAL ENGINE.
 *
 * The claim that matters is not "the helper returns the same array" but "the SAME PEOPLE are covered,
 * whichever way they were named". `previewLeaveGeneration` is `runLeaveGeneration` with `dryRun: true` —
 * the same call, the same `resolveOrgCriteriaTargets`, the same year-boundary rules — so comparing its
 * output for the two spellings compares what the SWEEP would do.
 *
 * The population is read with `listEmployeePickOptions`, which is the read the three SERVER ACTIONS now
 * perform: `listCompanies` → `listEmployees` → three plain fields. Driving §B through it means this
 * section also proves the write path's own input, not a fixture shaped like it.
 */
/**
 * ONE CONNECTION LIFECYCLE FOR THE WHOLE FILE, and it is a correction worth writing down: §B and §C each
 * had their own `afterAll(closeAll)`, so §B's teardown shut the pool §C was about to use and every §C case
 * died on `write CONNECTION_ENDED 127.0.0.1:5433` — an ENVIRONMENT failure with zero assertion errors,
 * which CLAUDE.md §4 names as the thing to check first on a red run.
 */
beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

describe('r289 §B · a pasted Employee ID covers exactly who the picker covers', () => {
  let b: Base;
  let irwin: string;
  let nadia: string;
  let carol: string;

  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    const hire = async (fullName: string, employeeCode: string) => {
      const r = await hireEmployee(adminCtx(b), {
        person: { fullName, primaryEmail: `r289_${randomUUID().slice(0, 8)}@t.local` },
        companyId: b.companyId,
        departmentId: b.deptA,
        employmentType: 'full_time',
        hiredOn: '2020-01-01',
        employeeCode,
      });
      return r.employmentId;
    };
    irwin = await hire('Irwin Tan', 'EMP-0008');
    nadia = await hire('Nadia Rahim', 'EMP-0009');
    carol = await hire('Carol Ng', 'EMP-0010');
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2020-01-01' });
  });

  /** Exactly what `openLeaveYearAction` builds, over the population that action reads for itself. */
  const idsFromForm = async (fd: FormData) =>
    mergeEmploymentSelection(
      fd.getAll('employmentIds').map(String),
      String(fd.get('employmentIdsRaw') ?? ''),
      await listEmployeePickOptions(adminCtx(b)),
    );

  const runFor = (employmentIds: string[]) =>
    previewLeaveGeneration(adminCtx(b), {
      year: 2026,
      leaveTypeIds: [b.annualLeaveTypeId],
      targetMode: 'individual',
      employmentIds,
    });

  /** The per-employment verdicts, ordered, so two results compare as SETS OF FACTS rather than objects. */
  const reached = (r: Awaited<ReturnType<typeof runFor>>) => [...new Set(r.lines.map((l) => l.employmentId))].sort();

  it('the population the SERVER ACTION reads carries the Employee IDs the screen shows', async () => {
    const pop = await listEmployeePickOptions(adminCtx(b));
    expect(pop.find((p) => p.id === irwin)?.employeeCode).toBe('EMP-0008');
    expect(pop.map((p) => p.id).sort()).toEqual([irwin, nadia, carol].sort());
  });

  it('pasting EMP-0008 and picking Irwin produce an IDENTICAL resolved population', async () => {
    const picker = new FormData();
    picker.append('employmentIds', irwin);
    picker.append('employmentIds', nadia);

    const paste = new FormData();
    // Deliberately the other order, with a comma, a new line and two different spellings, so the assertion
    // is about WHO, not about how the operator typed.
    paste.set('employmentIdsRaw', 'emp0009,\nEMP-0008');

    const fromPicker = await runFor(await idsFromForm(picker));
    const fromPaste = await runFor(await idsFromForm(paste));

    expect(reached(fromPicker)).toEqual([irwin, nadia].sort());
    expect(reached(fromPaste)).toEqual(reached(fromPicker));
    expect(fromPaste.employeesSelected).toBe(fromPicker.employeesSelected);
    expect(fromPaste.granted).toBe(fromPicker.granted);
    // …and neither door reaches somebody who was not named.
    expect(reached(fromPaste)).not.toContain(carol);
  });

  it('BEFORE this round that same paste reached NOBODY — the engine rejects a code outright', async () => {
    // ⚠️ THE PREMISE, pinned so a later reader cannot "correct" it. The restriction is
    // `employment.id IN (…)` against a **uuid** column, so an Employee ID does not "match nothing":
    // Postgres rejects the statement. That rejection is exactly what an operator saw as a permanent
    // "Working it out…" on two of the three screens, and as a failed Publish on the third.
    const err = await runFor(['EMP-0008']).then(
      () => null,
      (e: unknown) => e as Error & { cause?: { message?: string } },
    );
    expect(err, 'an Employee ID handed over UNRESOLVED must still be the old failure').not.toBeNull();
    expect(err!.message).toMatch(/"employment"\."id" in \(/);
    expect(err!.message).toContain('EMP-0008');
    expect(String(err!.cause?.message ?? '')).toMatch(/uuid/i);
  });

  it('a mixed paste still covers everyone it CAN resolve — and names the one it cannot', async () => {
    const pop = await listEmployeePickOptions(adminCtx(b));
    const r = resolveEmploymentSelection([], 'EMP-0008\nEMP-0009\nEMP-9999', pop);
    expect(r.unmatched).toEqual(['EMP-9999']);
    // Nothing dropped: the two good ones resolved, the bad one is still in the list.
    expect(r.ids).toEqual([irwin, nadia, 'EMP-9999']);
  });
});

/**
 * §C — NOTICE BOARD IS THE WORST CASE AND GETS ITS OWN SECTION.
 *
 * `notice.criteria` is a **jsonb** column and `cleanNotice` (core/notice.ts) only checks the list is
 * non-empty, so a reference nothing resolves SAVES. The draft screen then reported the stored list's
 * LENGTH as the reach, the publish confirmation repeated that number, and `publishNotice` was where it
 * finally went wrong — one step later and one step worse than the ticket reported.
 *
 * WHAT IS PINNED HERE: a paste of mixed good and bad tokens cannot produce a draft whose stated reach
 * counts the bad ones — WITHOUT the bad ones being dropped from the notice.
 */
describe('r289 §C · Notice Board: a mixed paste cannot produce a draft that over-states its reach', () => {
  let b: Base;
  let irwin: string;
  let nadia: string;

  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    const hire = async (fullName: string, employeeCode: string) => {
      const r = await hireEmployee(adminCtx(b), {
        person: { fullName, primaryEmail: `r289n_${randomUUID().slice(0, 8)}@t.local` },
        companyId: b.companyId,
        departmentId: b.deptA,
        employmentType: 'full_time',
        hiredOn: '2020-01-01',
        employeeCode,
      });
      return r.employmentId;
    };
    irwin = await hire('Irwin Tan', 'EMP-0008');
    nadia = await hire('Nadia Rahim', 'EMP-0009');
  });

  it('the stated reach counts PEOPLE, while the notice still stores every token it was given', async () => {
    const audience = await listEmployeePickOptions(adminCtx(b));
    // Exactly what `inputFrom` builds for an individual notice.
    const selection = resolveEmploymentSelection([], 'EMP-0008 EMP-0009 EMP-9999', audience);
    expect(selection.unmatched, 'the screen names the one it could not read').toEqual(['EMP-9999']);

    const created = await createNotice(adminCtx(b), {
      title: 'Town hall',
      body: 'Body',
      startOn: '2026-08-01',
      endOn: '2026-08-31',
      targetMode: 'individual',
      employmentIds: selection.ids,
    });

    const stored = (await getNotice(adminCtx(b), created.id))!.criteria.employmentIds ?? [];
    // NOTHING WAS DROPPED. The typo is on the notice, visible in the paste box when it is reopened and
    // named there as unrecognised — because dropping it on Save would silently shrink an audience.
    expect(stored).toEqual([irwin, nadia, 'EMP-9999']);
    expect(stored.length, 'the OLD reach rule counted strings, and would say three').toBe(3);

    // …and the draft screen's rule now counts people. `visibleEmploymentIds` is the function
    // app/admin/notice-board/[id]/page.tsx computes `reach` with, over the list it has already read for
    // the picker — so this is the number the reach box prints and the number the publish confirmation
    // repeats, not a re-derivation of it.
    const reach = visibleEmploymentIds(stored, audience).length;
    expect(reach, 'a string that names nobody is not an employee').toBe(2);
    expect(visibleEmploymentIds(stored, audience)).toEqual([irwin, nadia]);
  });

  it('an all-good paste is unaffected — the reach is still every person named', async () => {
    const audience = await listEmployeePickOptions(adminCtx(b));
    const ids = mergeEmploymentSelection([], 'emp0008, EMP-0009', audience);
    expect(ids).toEqual([irwin, nadia]);
    expect(visibleEmploymentIds(ids, audience).length).toBe(2);
  });

  it('the draft page computes its reach through that function, not through a length', () => {
    const page = read('app/admin/notice-board/[id]/page.tsx');
    expect(page).toContain("import { visibleEmploymentIds } from '@/lib/employment-selection'");
    expect(page).toContain('visibleEmploymentIds(n.criteria.employmentIds ?? [], vocab.employees).length');
    // The rule it replaces must be GONE, or the honest count would sit beside the over-claiming one and a
    // later edit would pick whichever looked shorter.
    expect(page, 'the string count must not survive anywhere on this page').not.toContain(
      '(n.criteria.employmentIds ?? []).length',
    );
  });
});

/**
 * §D — EVERY CALL SITE REACHES FOR THE ONE RULE, AND HANDS IT A POPULATION.
 *
 * SOURCE SHAPE, and the reason is the one r287 §C and r288 §C already wrote down: these are `'use server'`
 * actions that call `requireAdmin()` and finish by `redirect()`ing (which works by THROWING
 * `NEXT_REDIRECT`), and rendering an async server component needs a request, a session and a database.
 * §A–§C prove the RULE; what is left to pin is that each caller reaches for it — and, new this round, that
 * each caller hands it a population, because a call site that quietly went back to two arguments would
 * stop resolving Employee IDs on one side of a submit while the other went on resolving them.
 */
describe('r289 §D · one rule, one normaliser, six call sites', () => {
  const MODULE = read('lib/employment-selection.ts');

  it('the module stays DEPENDENCY-FREE — no React, no next/*, no db', () => {
    const imports = [...MODULE.matchAll(/^import .*? from '([^']+)';$/gm)].map((m) => m[1]);
    // One import, and it is the sibling that owns the fold rule. Anything else (a `@/db/...`, a `react`, a
    // `next/...`) would stop a plain unit test, a server action and a client island all importing this.
    expect(imports, 'the only dependency may be the shared fold rule').toEqual(['./employee-search']);
    expect(MODULE).not.toMatch(/from 'react'|from 'next\/|\/db\/|drizzle/);
  });

  it('there is no SECOND normaliser — the house fold rule is imported, not copied', () => {
    expect(MODULE).toContain("import { foldEmployeeCode } from './employee-search'");
    // The fold itself must live in ONE file. A copy here is how "emp0008 finds EMP-0008" starts being true
    // in the search box and false in the box beside it, with both halves' tests green.
    expect(MODULE, 'the strip-separators regex must not be re-written here').not.toMatch(/replace\(\s*\/\[/);
    expect(read('lib/employee-search.ts')).toContain('export function foldEmployeeCode');
  });

  /**
   * THE MERGE MUST BE CALLED WITH A POPULATION. Written as a whitespace-tolerant regex because adding the
   * third argument reflowed every one of these calls onto several lines.
   */
  const MERGES_WITH_POPULATION =
    /(?:merge|resolve)EmploymentSelection\(\s*(?:\[\.\.\.picked\]|(?:fd|formData)\.getAll\('employmentIds'\)\.map\(String\)),\s*(?:pastedRaw|String\((?:fd|formData)\.get\('employmentIdsRaw'\) \?\? ''\)),\s*(?:await )?[\w.]+(?:\(\w*\))?,?\s*\)/;

  const SITES: [string, string][] = [
    ['Generate Entitlement · write', 'app/admin/actions.ts'],
    ['Generate Entitlement · screen', 'components/leave/generate-form.tsx'],
    ['Leave Adjustments · write', 'app/admin/leave/adjustments/actions.ts'],
    ['Leave Adjustments · screen', 'components/leave/adjustment-form.tsx'],
    ['Notice Board · write', 'app/admin/notice-board/actions.ts'],
    ['Notice Board · screen', 'components/notice/notice-form.tsx'],
  ];

  it.each(SITES)('%s resolves the two fields against a population', (_label, rel) => {
    const src = read(rel);
    expect(src).toMatch(/from '@\/lib\/employment-selection'/);
    expect(src).toMatch(MERGES_WITH_POPULATION);
    // The hand-rolled split must stay gone from every one of them.
    expect(src).not.toContain('.split(/[\\s,]+/)');
  });

  it('the three WRITE paths read that population themselves rather than trusting the post', () => {
    for (const rel of [
      'app/admin/actions.ts',
      'app/admin/leave/adjustments/actions.ts',
      'app/admin/notice-board/actions.ts',
    ]) {
      const src = read(rel);
      expect(src, `${rel} must read the population`).toContain('listEmployeePickOptions');
    }
    // …and it is ONE read, shared, so the three cannot drift from each other or from the pages'.
    expect(read('core/read.ts')).toContain('export async function listEmployeePickOptions');
  });

  it('the three SCREENS name what they could not read', () => {
    expect(read('components/leave/generate-form.tsx')).toContain("t('generatePasteUnmatched', { list:");
    expect(read('components/leave/adjustment-form.tsx')).toContain("t('adjustmentsPasteUnmatched', { list:");
    // Notice Board's copy crosses the boundary as a STRING, so it substitutes its own placeholder — and
    // the page must pass the placeholder back in or next-intl renders the key path behind a green 200.
    expect(read('components/notice/notice-form.tsx')).toContain("labels.pasteUnmatchedTemplate.replace('{list}'");
    for (const rel of ['app/admin/notice-board/new/page.tsx', 'app/admin/notice-board/[id]/page.tsx']) {
      expect(read(rel), rel).toContain("t('fPasteUnmatched', { list: '{list}' })");
    }
  });

  it('the new copy ships in all six locales, keeps its placeholder, and mentions the Employee ID', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as {
        admin: { leave: Record<string, string> };
        notices: Record<string, string>;
      };
      for (const v of [
        m.admin.leave.generatePasteUnmatched,
        m.admin.leave.adjustmentsPasteUnmatched,
        m.notices.fPasteUnmatched,
      ]) {
        expect(v, `${loc} unmatched copy`).toBeTruthy();
        // `String.replace` and next-intl are both silent about a placeholder that is not there: a
        // translation that dropped `{list}` would print a sentence that names nothing — the very silence
        // this round exists to remove — with no MISSING_MESSAGE and no failure anywhere else.
        expect(v, `${loc} keeps {list}`).toContain('{list}');
      }
      // The help text under the box promised "employee references", and every reference a person could
      // actually lay hands on was the wrong kind. It must now name the thing they can see.
      for (const v of [
        m.admin.leave.generatePasteAlternativeHelp,
        m.admin.leave.adjustmentsPasteAlternativeHelp,
        m.notices.fPasteAlternativeHelp,
      ]) {
        expect(v, `${loc} help text must name an Employee ID`).toContain('EMP-0008');
      }
    }
  });
});
