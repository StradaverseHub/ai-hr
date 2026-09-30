/**
 * r371 (item d4f6848f) — THE MONTH'S STATUTORY WAGE, PINNED WITHOUT A DATABASE.
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
  SOCSO_WAGE_INCONSISTENT_REASON,
  WAGE_BASE_TOLERANCE,
  monthWageFor,
  monthWagesFrom,
  type MonthWageSlip,
} from '../localization/my/statutory-month-wage';

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
