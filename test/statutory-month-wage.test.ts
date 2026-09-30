/**
 * r372 (item d4f6848f) — THE MONTH'S STATUTORY WAGE, PINNED WITHOUT A DATABASE.
 *
 * `test/borang-a-report.test.ts` and `test/borang-8a-report.test.ts` pin the corrected figure against a real
 * kernel and a real Postgres, which is the evidence that matters. This file pins the FOLD: that "the latest
 * run" is an invariant and not a position, that the two agencies are flagged apart, and that the two
 * presence rules the three reads already had were carried over rather than quietly unified. Every one of
 * those is a defect a database test cannot isolate — it would show up as a wrong ringgit figure with four
 * candidate causes.
 *
 * WHY THESE ARE THE CASES. The correction replaced a SUM with a fold over `run_seq`. A fold has exactly
 * three ways to be wrong: it can pick by position instead of by key (a `[length-1]` or a reliance on the
 * caller's ORDER BY), it can pick the wrong key, or it can be right about the figure and silent about the
 * month not having one. One case each, plus the two agency flags kept separate.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  EPF_WAGE_INCONSISTENT_REASON,
  SOCSO_NOT_IN_SELECTION_REASON,
  SOCSO_WAGE_INCONSISTENT_REASON,
  WAGE_BASE_TOLERANCE,
  monthWageFor,
  monthWagesFrom,
  scopedMonthWagesFrom,
  type MonthWageSlip,
  type ScopedMonthWageSlip,
} from '../localization/my/statutory-month-wage';
// r372 (item f022dd70) — the parser that decides what "all payroll cycles" means on the wire. Pinned in
// this file because "absent, not empty" is one rule with the fold it feeds, not two.
import { parseRunSelection, runSelectionSet } from '../lib/payroll-run-selection';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Comment-stripped, because a source guard that a PROSE mention satisfies proves nothing. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const slip = (
  employmentId: string,
  runSeq: number,
  bases: { epf?: number; epfAdditional?: number; socsoEis?: number } | null,
): MonthWageSlip => ({
  employmentId,
  runSeq,
  statutory: bases === null ? { epfEmployee: 1 } : { epfEmployee: 1, bases },
});

const ONE_MONTH = 4000;

describe('the month’s statutory wage is the month’s wage ONCE', () => {
  /**
   * THE DEFECT, AS ONE ASSERTION. Two runs of one month stamp the SAME whole-month basis — that is what the
   * kernel does, because `bases.epf` is re-derived from compensation on every run — and the answer is ONE
   * month, not two. The retired behaviour was `round2(r.wage + b.epf + b.epfAdditional)` in a per-slip loop.
   */
  it('takes the month’s basis once for a two-run month, not once per run', () => {
    const w = monthWageFor(
      monthWagesFrom([
        slip('E1', 1, { epf: ONE_MONTH, epfAdditional: 0, socsoEis: ONE_MONTH }),
        slip('E1', 2, { epf: ONE_MONTH, epfAdditional: 0, socsoEis: ONE_MONTH }),
      ]),
      'E1',
    );
    expect(w.epf).toBe(ONE_MONTH);
    expect(w.socsoEis).toBe(ONE_MONTH);
    expect(w.epf).not.toBe(ONE_MONTH * 2);
    expect(w.epfRecorded).toBe(true);
    expect(w.epfInconsistent).toBe(false);
    expect(w.socsoEisInconsistent).toBe(false);
  });

  /** A month with a single run is the case almost every month is, and NOTHING about it may change. */
  it('is unchanged for a month that held a single run', () => {
    const w = monthWageFor(
      monthWagesFrom([slip('E1', 1, { epf: ONE_MONTH, epfAdditional: 250, socsoEis: ONE_MONTH })]),
      'E1',
    );
    expect(w.epf).toBe(ONE_MONTH + 250);
    expect(w.socsoEis).toBe(ONE_MONTH);
    expect(w.epfFromRunSeq).toBe(1);
  });

  /**
   * ⚠️ THE INVARIANT, NOT THE POSITION (CLAUDE.md §8). The greatest `run_seq` wins whatever order the rows
   * arrive in — all three reads `ORDER BY person.full_name`, so the run that lands last in the array is
   * decided by somebody's NAME. This is the assertion a `[length-1]` or a "the last row" fold fails.
   */
  it('takes the greatest run_seq whatever order the rows arrive in', () => {
    const rows = [
      slip('E1', 2, { epf: ONE_MONTH, epfAdditional: 1000, socsoEis: ONE_MONTH }),
      slip('E1', 1, { epf: ONE_MONTH, epfAdditional: 0, socsoEis: ONE_MONTH }),
    ];
    const forward = monthWageFor(monthWagesFrom(rows), 'E1');
    const reversed = monthWageFor(monthWagesFrom([...rows].reverse()), 'E1');
    // run_seq 2 carries the whole month's additional stream, so the month's Upah includes the bonus ONCE.
    expect(forward.epf).toBe(ONE_MONTH + 1000);
    expect(forward.epfFromRunSeq).toBe(2);
    expect(reversed).toEqual(forward);
  });

  /** Four runs, the greatest anywhere in the array: the fold is over run_seq, not over adjacency. */
  it('holds for four runs with the greatest one in the middle', () => {
    const w = monthWageFor(
      monthWagesFrom([
        slip('E1', 1, { epf: ONE_MONTH, epfAdditional: 0, socsoEis: ONE_MONTH }),
        slip('E1', 4, { epf: ONE_MONTH, epfAdditional: 900, socsoEis: ONE_MONTH }),
        slip('E1', 2, { epf: ONE_MONTH, epfAdditional: 300, socsoEis: ONE_MONTH }),
        slip('E1', 3, { epf: ONE_MONTH, epfAdditional: 600, socsoEis: ONE_MONTH }),
      ]),
      'E1',
    );
    expect(w.epf).toBe(ONE_MONTH + 900);
    expect(w.epfFromRunSeq).toBe(4);
  });

  /**
   * A RESET RUN DROPS OUT BY CONSTRUCTION, WHICH IS WHY THERE IS NO PREDICATE FOR IT HERE.
   * `resetProcessedBatch` DELETEs the run's payslips before flipping the batch to draft, so it hands in no
   * row at all. Asserted on the kernel's source (comments stripped) rather than assumed, because the whole
   * fold rests on it: were a reset run to keep its payslips, its stale basis could out-rank the real one.
   */
  it('needs no reset-run predicate, because resetProcessedBatch deletes the payslips first', () => {
    const src = code('core/payroll.ts');
    const at = src.indexOf('export async function resetProcessedBatch');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 4000);
    const del = body.indexOf('.delete(payslip)');
    const draft = body.indexOf("status: 'draft'");
    expect(del, 'resetProcessedBatch must delete the run’s payslips').toBeGreaterThan(-1);
    expect(draft).toBeGreaterThan(-1);
    expect(del, 'the delete must precede the flip to draft').toBeLessThan(draft);
    // And the fold's own half of it: a month whose reset run contributed no row reads the surviving run.
    const w = monthWageFor(monthWagesFrom([slip('E1', 1, { epf: ONE_MONTH, socsoEis: ONE_MONTH })]), 'E1');
    expect(w.epf).toBe(ONE_MONTH);
    expect(w.epfFromRunSeq).toBe(1);
  });

  /**
   * AND NOT ON `closed_at`. `unlockClosedBatch` sets only `{ status: 'processed' }` and leaves both
   * timestamps behind, so a reopened run still looks closed by those columns. Pinned on the source of the
   * derivation: it must resolve on run_seq and must not learn about either timestamp.
   */
  it('resolves on run_seq and never on a close/release timestamp', () => {
    const src = code('localization/my/statutory-month-wage.ts');
    expect(src).toContain('runSeq');
    expect(src).not.toMatch(/closedAt|closed_at|releasedAt|released_at/);
    // No positional fold anywhere in it.
    expect(src).not.toMatch(/\[\s*(?:\w+\.)*length\s*-\s*1\s*\]/);
    expect(src).not.toMatch(/\.at\(\s*-1\s*\)/);
    // And `unlockClosedBatch` really does leave the timestamps behind — the reason for the rule above.
    const kernel = code('core/payroll.ts');
    const at = kernel.indexOf('export async function unlockClosedBatch');
    expect(at).toBeGreaterThan(-1);
    expect(kernel.slice(at)).toContain("set({ status: 'processed' })");
  });
});

describe('a month whose runs disagree has no wage, and says so', () => {
  /** A mid-month pay change: the two runs were charged on different EPF wages, so neither is the month's. */
  it('flags an EPF disagreement and leaves PERKESO alone', () => {
    const w = monthWageFor(
      monthWagesFrom([
        slip('E1', 1, { epf: ONE_MONTH, epfAdditional: 0, socsoEis: ONE_MONTH }),
        slip('E1', 2, { epf: ONE_MONTH + 500, epfAdditional: 0, socsoEis: ONE_MONTH }),
      ]),
      'E1',
    );
    expect(w.epfInconsistent).toBe(true);
    // SEPARATE FLAGS ON PURPOSE: a carve-out that moves one agency's base must not hold the other agency's
    // document, which is still entirely correct. "Test the row count the form is ruled for."
    expect(w.socsoEisInconsistent).toBe(false);
  });

  it('flags a PERKESO disagreement and leaves EPF alone', () => {
    const w = monthWageFor(
      monthWagesFrom([
        slip('E1', 1, { epf: ONE_MONTH, epfAdditional: 0, socsoEis: ONE_MONTH }),
        slip('E1', 2, { epf: ONE_MONTH, epfAdditional: 0, socsoEis: ONE_MONTH + 120 }),
      ]),
      'E1',
    );
    expect(w.socsoEisInconsistent).toBe(true);
    expect(w.epfInconsistent).toBe(false);
  });

  /** Sen-level rounding noise is not a mid-month pay change. The tolerance is multicycle-worksheet's own. */
  it('does not flag a difference inside the tolerance', () => {
    expect(WAGE_BASE_TOLERANCE).toBe(0.005);
    const w = monthWageFor(
      monthWagesFrom([
        slip('E1', 1, { epf: ONE_MONTH, socsoEis: ONE_MONTH }),
        slip('E1', 2, { epf: ONE_MONTH + 0.004, socsoEis: ONE_MONTH }),
      ]),
      'E1',
    );
    expect(w.epfInconsistent).toBe(false);
  });

  /**
   * THE INVARIANT THE FOLD RELIES ON, PINNED AS A REFUSAL. `bases.epfAdditional` is cumulative for the
   * month (`statAdditional = earlierRun.additional + bonus`), so the greatest run carries the whole
   * additional stream. If it ever did not, the chosen run would UNDERSTATE the month — the opposite defect,
   * and a worse one, because nothing about the figure would look wrong.
   */
  it('refuses rather than understate when the cumulative additional stream goes DOWN', () => {
    const w = monthWageFor(
      monthWagesFrom([
        slip('E1', 1, { epf: ONE_MONTH, epfAdditional: 1000, socsoEis: ONE_MONTH }),
        slip('E1', 2, { epf: ONE_MONTH, epfAdditional: 400, socsoEis: ONE_MONTH }),
      ]),
      'E1',
    );
    expect(w.epfInconsistent).toBe(true);
  });

  /** The reasons the review screens print. One set of words, so two surfaces cannot word one refusal twice. */
  it('names the agency in each reason, and says the runs disagree rather than that nothing was recorded', () => {
    expect(EPF_WAGE_INCONSISTENT_REASON).toContain('EPF wage basis');
    expect(SOCSO_WAGE_INCONSISTENT_REASON).toContain('SOCSO/EIS wage basis');
    for (const r of [EPF_WAGE_INCONSISTENT_REASON, SOCSO_WAGE_INCONSISTENT_REASON]) {
      expect(r).toMatch(/DIFFERENT wages/);
      // It must NOT say the basis is absent: it is present twice, and the two disagree. `0.00` asserts the
      // money does not exist and "not recorded" asserts we never knew; neither is what happened here.
      expect(r).not.toMatch(/not recorded|no wage|predates/i);
    }
  });
});

describe('what is KNOWN about a month is exactly what it was before', () => {
  /**
   * BORANG A'S RULE, UNCHANGED: one payslip in the month with no `bases` object makes the whole month's EPF
   * wage unknown for that person. 61 of 121 production payslips predate the r187 stamp.
   */
  it('one unstamped payslip makes the month’s EPF wage unknown', () => {
    const w = monthWageFor(
      monthWagesFrom([slip('E1', 1, { epf: ONE_MONTH, socsoEis: ONE_MONTH }), slip('E1', 2, null)]),
      'E1',
    );
    expect(w.epfRecorded).toBe(false);
  });

  /**
   * THE PERKESO READS' RULE, ALSO UNCHANGED AND DELIBERATELY DIFFERENT: a base stamped by ANY run of the
   * month is the month's base, and an unstamped sibling run does not erase it. Unifying the two rules would
   * have been a silent change to WHO can file, in a round whose whole promise is that only a wage moves.
   */
  it('an unstamped sibling run does not erase a SOCSO/EIS base another run recorded', () => {
    const w = monthWageFor(
      monthWagesFrom([slip('E1', 1, null), slip('E1', 2, { epf: ONE_MONTH, socsoEis: ONE_MONTH })]),
      'E1',
    );
    expect(w.socsoEis).toBe(ONE_MONTH);
    expect(w.epfRecorded).toBe(false);
  });

  /** NULL, NEVER ZERO. An absent box asserts nothing; a 0.00 salary box asserts the employee earned nothing. */
  it('reports a never-stamped SOCSO/EIS base as null and not as zero', () => {
    const w = monthWageFor(monthWagesFrom([slip('E1', 1, null)]), 'E1');
    expect(w.socsoEis).toBeNull();
    expect(w.epfRecorded).toBe(false);
  });

  /** Somebody the month has no payslip for is not "a zero wage that was recorded". */
  it('answers for an employee the month never paid without inventing a recorded wage', () => {
    const w = monthWageFor(monthWagesFrom([slip('E1', 1, { epf: ONE_MONTH, socsoEis: ONE_MONTH })]), 'E2');
    expect(w.epfRecorded).toBe(false);
    expect(w.socsoEis).toBeNull();
    expect(w.epfFromRunSeq).toBeNull();
  });

  /** Two employees in one month do not contaminate each other's fold. */
  it('keeps employees apart', () => {
    const wages = monthWagesFrom([
      slip('E1', 1, { epf: 4000, socsoEis: 4000 }),
      slip('E2', 1, { epf: 7000, socsoEis: 7000 }),
      slip('E1', 2, { epf: 4000, socsoEis: 4000 }),
      slip('E2', 2, { epf: 7000, socsoEis: 7000 }),
    ]);
    expect(monthWageFor(wages, 'E1').epf).toBe(4000);
    expect(monthWageFor(wages, 'E2').epf).toBe(7000);
  });
});

describe('all three statutory reads consume ONE derivation, not a copy', () => {
  /**
   * The r296 defect was TWO resolutions of one PERKESO field in two files that behaved plausibly apart. The
   * guard against its return is not a comment: it is that no read holds the arithmetic any more.
   */
  const READS = [
    'localization/my/borang-a.ts',
    'localization/my/borang-8a.ts',
    'localization/my/socso-eis-file.ts',
  ] as const;

  it('each read imports the shared derivation', () => {
    for (const p of READS) {
      expect(code(p), p).toContain("from './statutory-month-wage'");
      expect(code(p), p).toContain('monthWagesFrom(');
    }
  });

  it('no read accumulates a wage base any more', () => {
    for (const p of READS) {
      const src = code(p);
      // The exact retired shapes: `r.wage = round2(r.wage + ... )` and `round2((r.wage ?? 0) + ...)`.
      expect(src, p).not.toMatch(/r\.wage\s*=\s*round2\(\s*\(?r\.wage/);
      expect(src, p).not.toMatch(/wage\s*[+*]=/);
      // …and nothing in any of them reads `bases` directly for a wage: the derivation owns that shape.
      expect(src, p).not.toMatch(/bases[?.\s]*\.\s*socsoEis/);
      expect(src, p).not.toMatch(/b\.epfAdditional/);
    }
  });

  /**
   * ── CP39 IS UNTOUCHED, ASSERTED AND NOT ASSUMED (the reporter was promised this in writing) ──────
   *
   * The e-Data PCB / CP39 file reports one instalment per employee per month and HAS NO WAGE COLUMN OF
   * THIS KIND: `Cp39FormRow` carries `pcb` and `cp38` and no wage, gross or basis field at all. So the
   * defect could not reach it and the correction must not either. `test/cp39-form-report.test.ts`'s
   * "counts one instalment for a month that was run twice, not two" is the live proof it still holds; this
   * is the structural half — the shape that would have to change before CP39 could be affected.
   */
  it('CP39 carries no wage column and reaches none of this', () => {
    const row = read('lib/cp39-form.ts');
    const at = row.indexOf('export type Cp39FormRow');
    expect(at).toBeGreaterThan(-1);
    const body = row.slice(at, row.indexOf('};', at));
    // The two money fields it does carry, and nothing wage-shaped beside them.
    expect(body).toMatch(/\bpcb:\s*number/);
    expect(body).toMatch(/\bcp38:\s*number/);
    expect(body).not.toMatch(/^\s*(wage|gross|basis|salary|upah)\s*[?]?:/im);
    for (const p of ['lib/cp39-form.ts', 'localization/my/cp39-form.ts', 'localization/my/cp39-file.ts']) {
      expect(read(p), p).not.toContain('statutory-month-wage');
    }
  });

  it('the derivation lives inside the MY pack, which is the only thing allowed to import it', () => {
    // ADR-0080 D1: app/ reaches all of this through core/reporting's reportPreview.
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (['node_modules', '.next', '.git', 'graphify-out'].includes(e.name)) continue;
          walk(rel);
        } else if (/\.tsx?$/.test(e.name) && read(rel).includes('statutory-month-wage')) {
          hits.push(rel);
        }
      }
    };
    for (const d of ['app', 'core', 'lib', 'components', 'packs']) walk(d);
    expect(hits, 'only localization/my and its tests may name the derivation').toEqual([]);
  });
});

/**
 * r372 (item f022dd70) — THE SAME MONTH, WHEN THE OPERATOR PICKED WHICH OF ITS RUNS TO FILE.
 *
 * WHY THESE ARE THE CASES. The scoped fold exists because feeding the whole-month fold a SHORTER LIST
 * produces a wrong statutory figure, and there is exactly one way to prove that: build the month, run
 * both, and show they disagree in the direction that matters. Everything else here pins the two streams
 * apart (normal belongs to the regular run, additional decomposes into increments) and pins the one
 * equality the whole no-change story leans on.
 */
const scoped = (
  employmentId: string,
  runSeq: number,
  runType: string,
  bases: { epf?: number; epfAdditional?: number; socsoEis?: number } | null,
): ScopedMonthWageSlip => ({ ...slip(employmentId, runSeq, bases), runType });

/** September: the regular run pays the month, a bonus run follows it. The reporter's own example. */
const SEPTEMBER = [
  scoped('E1', 1, 'regular', { epf: ONE_MONTH, epfAdditional: 0, socsoEis: ONE_MONTH }),
  scoped('E1', 2, 'bonus', { epf: ONE_MONTH, epfAdditional: 5000, socsoEis: ONE_MONTH }),
];

describe('a payroll-cycle selection files what the selected runs were charged on', () => {
  /**
   * ⚠️ THE NON-VACUITY CASE, AND THE ONE THE FEATURE EXISTS FOR. Ticking ONLY the bonus run must file the
   * BONUS as Upah. The obvious implementation — hand `monthWagesFrom` the selected payslips — answers
   * 9,000 here, because `bases.epf` is the whole month's normal wage and the kernel stamps it on the
   * bonus run too. Both numbers are asserted, so the wrong one cannot be reached by deleting a line.
   */
  it('a Bonus-only selection files the bonus, NOT the month’s salary plus the bonus', () => {
    const w = monthWageFor(scopedMonthWagesFrom(SEPTEMBER, new Set([2])), 'E1');
    expect(w.epf).toBe(5000);

    // What the shorter-list implementation would have filed, spelled out rather than described:
    const naive = monthWageFor(monthWagesFrom(SEPTEMBER.filter((s) => s.runSeq === 2)), 'E1');
    expect(naive.epf).toBe(ONE_MONTH + 5000);
    expect(w.epf).not.toBe(naive.epf);
  });

  it('a regular-only selection files the month’s salary and none of the bonus', () => {
    const w = monthWageFor(scopedMonthWagesFrom(SEPTEMBER, new Set([1])), 'E1');
    expect(w.epf).toBe(ONE_MONTH);
  });

  /**
   * THE EQUALITY THE WHOLE NO-CHANGE STORY LEANS ON. Ticking everything telescopes the increments back to
   * the greatest run's cumulative stamp. The three reads still OMIT the parameter for "All" — so the old
   * path runs and the bytes are identical by construction — but if this ever stopped holding, the control
   * would be lying about what "All" means.
   */
  it('ticking every run agrees with the unfiltered month, to the sen', () => {
    const all = monthWageFor(monthWagesFrom(SEPTEMBER), 'E1');
    const ticked = monthWageFor(scopedMonthWagesFrom(SEPTEMBER, new Set([1, 2])), 'E1');
    expect(ticked.epf).toBe(all.epf);
    expect(ticked.socsoEis).toBe(all.socsoEis);
    expect(ticked.epfRecorded).toBe(all.epfRecorded);
    expect(ticked.epfInconsistent).toBe(all.epfInconsistent);
  });

  /**
   * THE INCREMENT IS TAKEN AGAINST THE MONTH, NOT AGAINST THE SELECTION. Three runs, two bonuses; tick
   * only the THIRD. Its cumulative stamp is 8,000 but it only added 3,000, and the run that added the
   * other 5,000 is not in the selection. A fold that computed the increment against the previous SELECTED
   * run — which is what a SQL-filtered query would force — would file 8,000.
   */
  it('an increment is measured against the previous run of the MONTH, not the previous ticked one', () => {
    const month = [
      scoped('E1', 1, 'regular', { epf: ONE_MONTH, epfAdditional: 0, socsoEis: ONE_MONTH }),
      scoped('E1', 2, 'bonus', { epf: ONE_MONTH, epfAdditional: 5000, socsoEis: ONE_MONTH }),
      scoped('E1', 3, 'bonus', { epf: ONE_MONTH, epfAdditional: 8000, socsoEis: ONE_MONTH }),
    ];
    expect(monthWageFor(scopedMonthWagesFrom(month, new Set([3])), 'E1').epf).toBe(3000);
    expect(monthWageFor(scopedMonthWagesFrom(month, new Set([2, 3])), 'E1').epf).toBe(8000);
    expect(monthWageFor(scopedMonthWagesFrom(month, new Set([1, 2, 3])), 'E1').epf).toBe(ONE_MONTH + 8000);
  });

  it('is order-independent — the rows may arrive in any order', () => {
    const forward = monthWageFor(scopedMonthWagesFrom(SEPTEMBER, new Set([2])), 'E1');
    const reversed = monthWageFor(scopedMonthWagesFrom([...SEPTEMBER].reverse(), new Set([2])), 'E1');
    expect(reversed).toEqual(forward);
  });

  it('leaves out an employee the selected runs never paid', () => {
    const month = [
      ...SEPTEMBER,
      // Paid ONLY in the regular run — absent from a bonus-only filing, not present with zeros.
      scoped('E2', 1, 'regular', { epf: 3000, epfAdditional: 0, socsoEis: 3000 }),
    ];
    const wages = scopedMonthWagesFrom(month, new Set([2]));
    expect([...wages.keys()]).toEqual(['E1']);
  });

  /**
   * THE OVERLOOKED EMPLOYEE — the reporter's headline case. Somebody missed by the regular run and paid
   * in an off-cycle run has ONE payslip in the month, on that run. Ticking it files what it paid.
   */
  it('files the catch-up run on its own for somebody the regular run missed', () => {
    const month = [
      scoped('E1', 1, 'regular', { epf: ONE_MONTH, epfAdditional: 0, socsoEis: ONE_MONTH }),
      scoped('E9', 2, 'off_cycle', { epf: 0, epfAdditional: 2200, socsoEis: 0 }),
    ];
    const wages = scopedMonthWagesFrom(month, new Set([2]));
    expect([...wages.keys()]).toEqual(['E9']);
    expect(monthWageFor(wages, 'E9').epf).toBe(2200);
  });
});

describe('PERKESO is charged once a month, and a selection that misses it says so', () => {
  /**
   * SOCSO, EIS and SKBBK are charged on the REGULAR run; an additional run adds 0 (ADR-0024). But
   * `bases.socsoEis` is stamped on the bonus run anyway, because the kernel re-derives it from the
   * month's compensation on every run. A Bonus-only PERKESO file would therefore carry a full month's
   * salary beside contributions of nothing — so the flag is raised and the document is held.
   */
  it('flags a selection with no regular run rather than filing a full month’s salary beside zeros', () => {
    const w = monthWageFor(scopedMonthWagesFrom(SEPTEMBER, new Set([2])), 'E1');
    expect(w.socsoEisOutsideSelection).toBe(true);
    // NOT null. "No base was recorded" is a different fact and a different sentence — one was recorded.
    expect(w.socsoEis).toBe(ONE_MONTH);
  });

  it('does not flag a selection that includes the regular run', () => {
    for (const sel of [new Set([1]), new Set([1, 2])]) {
      expect(monthWageFor(scopedMonthWagesFrom(SEPTEMBER, sel), 'E1').socsoEisOutsideSelection).toBe(false);
    }
  });

  it('never raises the flag on an unfiltered month, whatever runs it held', () => {
    for (const rows of [SEPTEMBER, [SEPTEMBER[1]]]) {
      expect(monthWageFor(monthWagesFrom(rows), 'E1').socsoEisOutsideSelection).toBe(false);
    }
  });

  it('names the selection in the reason, and does not call it an absence', () => {
    expect(SOCSO_NOT_IN_SELECTION_REASON).toContain('payroll cycles you');
    expect(SOCSO_NOT_IN_SELECTION_REASON).toContain('regular payroll run');
    // The retired wording this must not collapse into — see the constant's own comment.
    expect(SOCSO_NOT_IN_SELECTION_REASON).not.toMatch(/no .*wage was recorded/i);
    expect(SOCSO_NOT_IN_SELECTION_REASON).not.toBe(SOCSO_WAGE_INCONSISTENT_REASON);
  });
});

describe('the scoped fold keeps the two refusals the whole-month fold already made', () => {
  it('one unstamped payslip among the TICKED runs makes the EPF wage unknown', () => {
    const month = [
      scoped('E1', 1, 'regular', { epf: ONE_MONTH, epfAdditional: 0, socsoEis: ONE_MONTH }),
      scoped('E1', 2, 'bonus', null),
    ];
    expect(monthWageFor(scopedMonthWagesFrom(month, new Set([1, 2])), 'E1').epfRecorded).toBe(false);
    // …and an unstamped run the operator did NOT tick says nothing about the runs they did.
    expect(monthWageFor(scopedMonthWagesFrom(month, new Set([1])), 'E1').epfRecorded).toBe(true);
  });

  it('flags ticked runs charged on DIFFERENT normal wages', () => {
    const month = [
      scoped('E1', 1, 'regular', { epf: ONE_MONTH, epfAdditional: 0, socsoEis: ONE_MONTH }),
      scoped('E1', 2, 'regular', { epf: ONE_MONTH + 500, epfAdditional: 0, socsoEis: ONE_MONTH }),
    ];
    expect(monthWageFor(scopedMonthWagesFrom(month, new Set([1, 2])), 'E1').epfInconsistent).toBe(true);
    expect(monthWageFor(scopedMonthWagesFrom(month, new Set([2])), 'E1').epfInconsistent).toBe(false);
  });

  it('refuses rather than subtracts when the cumulative additional stream goes DOWN', () => {
    const month = [
      scoped('E1', 1, 'regular', { epf: ONE_MONTH, epfAdditional: 5000, socsoEis: ONE_MONTH }),
      scoped('E1', 2, 'bonus', { epf: ONE_MONTH, epfAdditional: 1000, socsoEis: ONE_MONTH }),
    ];
    const w = monthWageFor(scopedMonthWagesFrom(month, new Set([1, 2])), 'E1');
    expect(w.epfInconsistent).toBe(true);
    // And it does not SUBTRACT the regression out of the figure — a negative increment adds nothing.
    expect(w.epf).toBe(ONE_MONTH + 5000);
  });
});

describe('"all" is absent, not a set of everything', () => {
  it('the parser answers undefined for a URL with no run parameters', () => {
    const r = parseRunSelection(new URLSearchParams('companyId=x&periodKey=2026-09'));
    expect(r.ok && r.runSeqs).toBeUndefined();
  });

  it('reads repeated run parameters, de-duplicated and sorted', () => {
    const r = parseRunSelection(new URLSearchParams('run=3&run=1&run=3'));
    expect(r.ok && r.runSeqs).toEqual([1, 3]);
  });

  it('REFUSES a malformed run rather than dropping it', () => {
    for (const q of ['run=0', 'run=-1', 'run=1.5', 'run=abc', 'run=1&run=x', 'run=', 'run=01']) {
      expect(parseRunSelection(new URLSearchParams(q)).ok, q).toBe(false);
    }
  });

  it('`runSelectionSet(undefined)` is undefined and NOT an empty set', () => {
    // `new Set(undefined)` is empty, and an empty set used as a filter removes every row — a silently
    // empty statutory file. This is the one line that stops that.
    expect(runSelectionSet(undefined)).toBeUndefined();
    expect(runSelectionSet([2, 4])).toEqual(new Set([2, 4]));
  });
});

describe('the wage-bearing reads take the whole month and scope it; CP39 filters its query', () => {
  /**
   * THE ARCHITECTURAL INVARIANT, AS A SOURCE GUARD. An increment cannot be read off a run whose
   * predecessor was filtered out in SQL, so Borang A and Borang 8A must NOT narrow their payslip query by
   * run. CP39 has no wage column and may. A future edit that "optimises" either read by pushing the
   * selection into the WHERE clause is the defect this whole module was written to prevent.
   */
  it('neither EPF nor PERKESO read narrows its SQL by run_seq', () => {
    for (const p of ['localization/my/borang-a.ts', 'localization/my/borang-8a.ts']) {
      const src = code(p);
      expect(src, p).toContain('scopedMonthWagesFrom(');
      expect(src, p).not.toMatch(/inArray\(\s*payrollBatch\.runSeq/);
      expect(src, p).not.toMatch(/eq\(\s*payrollBatch\.runSeq/);
    }
  });

  it('CP39 does narrow its SQL, and reaches no wage derivation', () => {
    const src = code('localization/my/cp39-file.ts');
    expect(src).toMatch(/inArray\(payrollBatch\.runSeq, p\.runSeqs\)/);
    expect(src).not.toContain('statutory-month-wage');
  });
});
