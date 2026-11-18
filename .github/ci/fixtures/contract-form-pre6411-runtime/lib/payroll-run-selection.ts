/**
 * r372 (item f022dd70) — WHICH PAYROLL RUNS A STATUTORY DOWNLOAD COVERS, PARSED ONCE.
 *
 * Payment Submission's download pop-up gained a Payroll Cycle field. The reporter asked for it by cycle
 * NAME (Monthly / Bonus / Off-Cycle), and the name is what the operator sees — but the thing that actually
 * separates one run of a month from another is `payroll_batch.run_seq`, not the cycle name:
 * `payroll_batch.payroll_cycle_id` is NULLABLE and null on every batch created before migration 0441 and
 * on every batch created by a caller that names no cycle (see the column's own comment in db/schema.ts and
 * core/payslip-cycle-label.ts), and the default catalogue maps THREE of its six cycles to run_type
 * `off_cycle` so the type cannot tell them apart either. `run_seq` is NOT NULL and uniquely indexed on
 * `(pay_period_id, run_seq)` — core/payroll-view.ts already states the precedent: "company + period +
 * runSeq names exactly one run". So the URL carries run_seq values and the SCREEN carries the cycle name.
 *
 * ── ABSENT IS NOT EMPTY, AND THE WHOLE NO-CHANGE GUARANTEE RESTS ON IT ───────────────────────────
 * `undefined` means the operator ticked every cycle, and every read then takes its EXISTING unfiltered
 * path — identical bytes to before this feature existed, by construction rather than by a test that
 * compares two code paths. An empty array would mean "a selection that names nothing", which is a
 * different fact and is treated as a refusal by the callers rather than quietly widened back to the whole
 * month. Blanking a field you did not intend to write is how a previous round wiped a SOCSO code.
 *
 * ONE PARSER, NOT THREE. The three statutory formats reach their builders by three different doors (the
 * pack seam for CP39, `loadBorangAFile` and `loadBorang8AFile` for the other two) and each door holds the
 * raw `URLSearchParams`. Three transcriptions of "read the run parameters" is how one file starts
 * honouring a selection the other two ignore, which is the defect this whole feature is guarding against.
 */

/** The query-string key, stated once. It appears on the URL, so it is treated as attacker-controlled. */
export const RUN_PARAM = 'run';

/**
 * The run numbers the operator ticked, or `undefined` for "all of them".
 *
 * REFUSES RATHER THAN REPAIRS. `run_seq` is a small positive integer; anything else on the URL —
 * a float, a negative, a huge number, a word — makes the whole selection `'invalid'` instead of being
 * dropped. Dropping it would silently produce a file over a DIFFERENT population from the one the URL
 * asked for, which is exactly the failure mode the reporter's "must affect the actual data, not the
 * filename" acceptance criterion is about.
 */
export type RunSelection =
  | { ok: true; runSeqs: number[] | undefined }
  | { ok: false; reason: string };

/** A run number we are willing to believe: 1..9999, integral, decimal, no sign and no padding games. */
const RUN_SEQ = /^[1-9][0-9]{0,3}$/;

export function parseRunSelection(query: URLSearchParams): RunSelection {
  const raw = query.getAll(RUN_PARAM);
  // Nothing on the URL at all ⇒ the whole month, which is what every link written before this round is.
  if (raw.length === 0) return { ok: true, runSeqs: undefined };

  const seen = new Set<number>();
  for (const v of raw) {
    if (!RUN_SEQ.test(v)) {
      return { ok: false, reason: 'The payroll cycle selection on this link is not valid.' };
    }
    seen.add(Number(v));
  }
  // A control that submitted nothing cannot reach here (`getAll` would be empty), so an empty set after
  // parsing is impossible; the sort is so two links naming the same runs produce the same value.
  return { ok: true, runSeqs: [...seen].sort((a, b) => a - b) };
}

/**
 * The selection as the reads want it: a Set for membership, or `undefined` for the unfiltered path.
 *
 * A HELPER RATHER THAN A `new Set(...)` AT EACH READ, because "undefined means all" has to survive the
 * conversion. `new Set(undefined)` is an EMPTY set, which would filter every row out of a whole-month
 * download — a silent empty statutory file, which is worse than an error.
 */
export function runSelectionSet(runSeqs: readonly number[] | undefined): ReadonlySet<number> | undefined {
  return runSeqs === undefined ? undefined : new Set(runSeqs);
}
