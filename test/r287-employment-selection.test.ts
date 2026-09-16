/**
 * r287 (ff1c935f) — "PICK INDIVIDUALLY": TWO WAYS IN, ONE LIST OUT.
 *
 * Step ③ of Generate Entitlement now offers a PICKER (`MultiSelectPopover`, posting one hidden
 * `employmentIds` input per chosen employment) BESIDE the reference-paste box it has always had
 * (`employmentIdsRaw`). The paste box is deliberately kept: it is how a bulk run is set up today.
 *
 * THE DANGEROUS PART IS NOT THE CONTROL, IT IS THE SEAM. Two fields feeding one engine is a contract
 * between `components/leave/generate-form.tsx` (which shows the operator a matched count) and
 * `app/admin/actions.ts` `openLeaveYearAction` (which performs the grant). If those two ever parse the
 * pair differently, the screen confirms one population and the sweep writes entitlement for another —
 * and every test of either half goes on passing. CLAUDE.md §8: "when a defect lives in the contract
 * between two files, pin it across both."
 *
 * So: the rule is ONE function (`lib/employment-selection.ts`), §A pins the function, §B proves through
 * the REAL ENGINE that the two doors resolve to the same people, and §C pins that both callers use it.
 *
 * §D pins the PREMISE, which the round's plan got wrong. The plan said the old box "tries to match typed
 * text against employee REFERENCES" and that a name "resolves to nothing". It does not: the contents go
 * into `employment.id IN (…)` against a **uuid** column, so a typed name makes Postgres REJECT the
 * statement. That rejection is what the screen was rendering as a permanent "Working it out…".
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hireEmployee } from '../core/org';
import { previewLeaveGeneration } from '../core/leave-generation';
import { mergeEmploymentSelection, parsePastedEmploymentIds } from '../lib/employment-selection';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, seedEntitlement, type Base } from './harness';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

describe('r287 §A · the merge rule itself', () => {
  it('splits a pasted block on whitespace, commas and new lines — the three separators it has always taken', () => {
    expect(parsePastedEmploymentIds('a b,c\nd,  e')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(parsePastedEmploymentIds('   ')).toEqual([]);
    expect(parsePastedEmploymentIds(null)).toEqual([]);
  });

  /**
   * r289 ADDED THE THIRD ARGUMENT: the population a pasted Employee ID resolves against. `[]` here is not a
   * placeholder — it is the statement these cases are making. With NO employments in hand nothing can
   * resolve by code, so every token is handed over exactly as typed, which is r287's behaviour unchanged
   * and is also the arm that keeps a pasted internal id working. What resolution ADDS on top of it is
   * pinned in test/r289-paste-employee-code.test.ts.
   */
  it('DE-DUPLICATES ACROSS THE TWO DOORS: picked AND pasted is one person, not two', () => {
    // The case a picker-only or paste-only test cannot see. Without this the matched count double-counts
    // and the log row records a selection that never existed.
    expect(mergeEmploymentSelection(['a', 'b'], 'b c', [])).toEqual(['a', 'b', 'c']);
    expect(mergeEmploymentSelection(['a', 'a'], 'a', [])).toEqual(['a']);
  });

  it('either door alone is exactly that door', () => {
    expect(mergeEmploymentSelection(['a', 'b'], '', [])).toEqual(['a', 'b']);
    expect(mergeEmploymentSelection([], 'a b', [])).toEqual(['a', 'b']);
    expect(mergeEmploymentSelection([], '', [])).toEqual([]);
  });
});

/**
 * §B — THE SAME QUESTION ASKED OF THE REAL ENGINE, because the assertion the plan asked for is about the
 * RESOLVED population, not about string handling: "the resolved employment-id list for a given selection
 * is identical to what the paste path produces for the same people".
 *
 * `previewLeaveGeneration` is `runLeaveGeneration` with `dryRun: true` — the same call, the same
 * `resolveOrgCriteriaTargets`, the same year-boundary rules. Comparing its output for the two shapes
 * therefore compares what the SWEEP would do, not what a helper returns.
 */
describe('r287 §B · the picker and the paste box resolve to the SAME people', () => {
  let b: Base;
  let alice: string;
  let bob: string;
  let carol: string;

  beforeAll(async () => {
    await migrateTestDb();
  });
  afterAll(closeAll);

  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    const hire = async (fullName: string) => {
      const r = await hireEmployee(adminCtx(b), {
        person: { fullName, primaryEmail: `r287_${randomUUID().slice(0, 8)}@t.local` },
        companyId: b.companyId,
        departmentId: b.deptA,
        employmentType: 'full_time',
        hiredOn: '2020-01-01',
      });
      return r.employmentId;
    };
    alice = await hire('Alice Chan');
    bob = await hire('Bob Lim');
    carol = await hire('Carol Ng');
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2020-01-01' });
  });

  /**
   * Exactly what `openLeaveYearAction` builds, from a FormData shaped like the real post.
   *
   * r289 — THE POPULATION IS EMPTY ON PURPOSE. Every id in this section is an internal employment uuid, and
   * an empty population is the strongest way to say so: nothing here can have been reached by a code
   * lookup, so §B goes on comparing the two DOORS rather than accidentally comparing two spellings.
   */
  const idsFromForm = (fd: FormData) =>
    mergeEmploymentSelection(
      fd.getAll('employmentIds').map(String),
      String(fd.get('employmentIdsRaw') ?? ''),
      [],
    );

  const runFor = (employmentIds: string[]) =>
    previewLeaveGeneration(adminCtx(b), {
      year: 2026,
      leaveTypeIds: [b.annualLeaveTypeId],
      targetMode: 'individual',
      employmentIds,
    });

  /** The per-employment verdicts, ordered, so two results can be compared as SETS OF FACTS not as objects. */
  const reached = (r: Awaited<ReturnType<typeof runFor>>) =>
    [...new Set(r.lines.map((l) => l.employmentId))].sort();

  it('the SAME two people, chosen either way, produce an IDENTICAL resolved list', async () => {
    const picker = new FormData();
    picker.append('employmentIds', alice);
    picker.append('employmentIds', bob);

    const paste = new FormData();
    // Deliberately the OTHER order and with a comma + newline, so the assertion is about WHO, not about
    // the operator's typing.
    paste.set('employmentIdsRaw', `${bob},\n${alice}`);

    const fromPicker = await runFor(idsFromForm(picker));
    const fromPaste = await runFor(idsFromForm(paste));

    expect(reached(fromPicker)).toEqual([alice, bob].sort());
    expect(reached(fromPaste)).toEqual(reached(fromPicker));
    expect(fromPaste.employeesSelected).toBe(fromPicker.employeesSelected);
    expect(fromPaste.employeesReached).toBe(fromPicker.employeesReached);
    expect(fromPaste.granted).toBe(fromPicker.granted);
    // …and neither door reaches somebody who was not named. A selection that silently widened would be
    // the single most expensive bug on this screen.
    expect(reached(fromPicker)).not.toContain(carol);
  });

  it('picked AND pasted for the same person is ONE person, not a double count', async () => {
    const both = new FormData();
    both.append('employmentIds', alice);
    both.append('employmentIds', bob);
    both.set('employmentIdsRaw', `${alice} ${bob}`);

    // ⚠️ THE FIRST ASSERTION IS THE LOAD-BEARING ONE, and it is here because the second one ALONE would be
    // vacuous. `core/leave-generation.ts` calls `dedupe(p.employmentIds)` on the way in, so the engine
    // would report 2 even if this merge handed it four ids — a guard that only read `employeesSelected`
    // would go on passing with the de-duplication removed from `mergeEmploymentSelection`. Verified by
    // removing it and watching only this line fail.
    expect(idsFromForm(both), 'the merge itself must not hand the engine a duplicate').toEqual([alice, bob]);

    const mixed = await runFor(idsFromForm(both));
    const pickerOnly = new FormData();
    pickerOnly.append('employmentIds', alice);
    pickerOnly.append('employmentIds', bob);

    expect(mixed.employeesSelected).toBe((await runFor(idsFromForm(pickerOnly))).employeesSelected);
    expect(mixed.employeesSelected).toBe(2);
  });

  /**
   * §D — THE PREMISE, pinned so it cannot be quietly re-broken and so a later reader does not "correct"
   * this round's diagnosis back to the plan's wrong one.
   */
  it('a NAME in the paste box is REJECTED by the database — it does not "match nothing"', async () => {
    const err = await runFor(['Irwin']).then(
      () => null,
      (e: unknown) => e as Error & { cause?: { message?: string } },
    );
    expect(err, 'a typed name must not resolve quietly to an empty selection').not.toBeNull();
    // The restriction is `employment.id IN (…)` — an id list, never a reference lookup and never a name
    // search. drizzle prints the statement and the bound parameter, which is the evidence for both halves.
    expect(err!.message).toMatch(/"employment"\."id" in \(/);
    expect(err!.message).toContain('Irwin');
    // And the reason it is rejected rather than empty: the column is a uuid. Read off the driver's own
    // cause, because drizzle's outer message is the statement, not the verdict.
    expect(String(err!.cause?.message ?? ''), 'the driver must name the uuid cast').toMatch(/uuid/i);
  });
});

describe('r287 §C · both callers go through the one rule', () => {
  /**
   * SOURCE SHAPE, AND THE REASON IS NOT LAZINESS — write it down so a later reader does not mistake it for
   * that. `openLeaveYearAction` is a `'use server'` action that calls `requireAdmin()` and finishes by
   * `redirect()`ing, which works by THROWING `NEXT_REDIRECT`; there is no request context in vitest to
   * give it and no return value to inspect. §B above already proves the RULE against the real engine, so
   * what is left to pin is that this caller reaches for that rule rather than re-inlining the split — the
   * exact regression that would put the confirmed population and the granted population out of step.
   */
  const action = read('app/admin/actions.ts');
  const form = read('components/leave/generate-form.tsx');

  it('the write path merges both fields through mergeEmploymentSelection', () => {
    expect(action).toContain("import { mergeEmploymentSelection } from '@/lib/employment-selection'");
    expect(action).toContain("formData.getAll('employmentIds').map(String)");
    expect(action).toContain("String(formData.get('employmentIdsRaw') ?? '')");
    // The hand-rolled split that used to live here must be GONE from the leave-generation action, or the
    // picker's ids would simply be dropped on submit while the preview kept counting them.
    expect(action).not.toContain(".split(/[\\s,]+/)\n              .filter(Boolean)");
  });

  /**
   * r289 REFLOWED THIS CALL and added a third argument — the population a pasted Employee ID resolves
   * against. The assertion is therefore a whitespace-tolerant regex rather than a one-line substring, and
   * it is STRICTER than what it replaces: it pins the two field reads AND that a population is passed. A
   * preview that quietly went back to two arguments would stop resolving Employee IDs while
   * `openLeaveYearAction` went on resolving them — the exact disagreement this section exists to prevent.
   */
  it('the live preview merges the SAME two fields through the SAME function', () => {
    expect(form).toMatch(/import \{ mergeEmploymentSelection, resolveEmploymentSelection \} from '@\/lib\/employment-selection'/);
    expect(form).toMatch(
      /mergeEmploymentSelection\(\s*fd\.getAll\('employmentIds'\)\.map\(String\),\s*String\(fd\.get\('employmentIdsRaw'\) \?\? ''\),\s*(?:await )?[\w.]+(?:\(\w*\))?,?\s*\)/,
    );
  });

  it('the picker posts under the field the action reads', () => {
    // The MultiSelectPopover form contract is `name` → one hidden input per selected id. A rename here
    // is silent: the control still looks right and the run simply covers nobody.
    expect(form).toContain('name="employmentIds"');
    expect(form).toContain('name="employmentIdsRaw"');
  });

  it('no second multi-select was written — the house picker is reused', () => {
    expect(form).toContain("import { MultiSelectPopover } from '@/components/ui/multi-select-popover'");
    expect(form).not.toMatch(/function\s+\w*MultiSelect\w*\s*\(/);
    // …and the search rule is the house one too, not a second substring filter written in this file.
    expect(form).toContain("import { matchesEmployeeSearch } from '@/lib/employee-search'");
  });

  /**
   * The SERVER PAGE half. Same reason as above and no more of an excuse: rendering an async server
   * component needs a request, a session and a database, and the thing at risk is one wiring line. It was
   * verified for real once — a dev-server render of `/admin/leave-config/generate` returned 200 with the
   * eight seeded employments present in the RSC payload as `{id, name, employeeCode}` and zero
   * MISSING_MESSAGE / IntlError — and this keeps that wiring from being deleted afterwards.
   */
  it('the server page reads the employment list and hands it over as PLAIN DATA', () => {
    const page = read('app/admin/leave-config/generate/page.tsx');
    expect(page).toContain('listEmployees');
    expect(page).toContain('employees={employments.map(');
    // No function may cross this boundary (test/server-client-boundary.test.ts pins the class); the three
    // fields are exactly the serialisable row the client composes its strings from.
    expect(page).toContain('employeeCode: e.employeeCode');
    expect(page.includes("'use client'"), 'the page must stay a server component').toBe(false);
  });
});
