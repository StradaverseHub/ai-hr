/**
 * Custom Rounding Table — replaces the fixed rounding methods (feedback 8fec719e, migration 0358).
 *
 * The rounding choice is now TWO: No Rounding, or Custom Rounding with a table the administrator writes
 * themselves over the DECIMAL PORTION of a calculated entitlement. Nearest 0.5 Day, Round Up and Round
 * Down are gone as choices — each was a fixed table this one expresses.
 *
 * r303 (05db6aa7) — UPDATED, NOT LOOSENED. The columns are now From / To / Round To and a range includes BOTH
 * its From and its To, at two decimals (it was from <= f < to at three, under the labels From / Round To /
 * Rounded Result). Every fixture below is rewritten into that meaning with the SAME figures, and the three
 * pins this item reverses are updated to pin the new decision: the 3dp NEAREST_HALF row (0.501) is now
 * REFUSED as `decimals`, the touching SNAP_TO_HALF rows (0.50 in both) are now REFUSED as `overlap`, and a
 * single-point row (From = To) is now LEGAL. Migration 0473's conversion and the old-vs-new equivalence
 * live in test/leave-rounding-bands-0473.test.ts.
 *
 * §1 THE EVALUATOR'S ARITHMETIC. This changes how many days people are credited, so the assertions are
 *    NUMBERS, not successful saves. It includes the three retired methods rewritten as tables, because
 *    "the new thing can express the old things" is the claim the whole item rests on.
 * §2 THE VALIDATOR. Overlaps and duplicates are REFUSED (the table would have two answers for one figure);
 *    a gap only WARNS (there is a defined answer — the value is left alone — and a table has to be
 *    buildable one row at a time). The service is authoritative; the editor draws from the same function.
 * §3 THE UNRULED FALL-THROUGH GUARD. hasAnyLeaveTypeRule is a null test and applyLeaveTypeRules returns
 *    the legacy grade policy VERBATIM when it says false, so clearing rounding on a type whose ONLY rule
 *    was rounding would restore its entire legacy JSONB rule set — a balance change disguised as a
 *    rounding change. Pinned on BOTH the writer and migration 0358.
 * §4 MIGRATION 0358'S RESET, executed from the ACTUAL file: every type back to No Rounding, no type left
 *    unruled, and NOT ONE LEDGER ROW TOUCHED — closed prior years are governed by the version active at
 *    their year-open and are never rewritten by a configuration change. 6e9a126e release three narrowed
 *    this to the `leave_type` surface only; the second surface, `leave_policy.accrual`, was dropped by
 *    migration 0405 — see `runReset` for why the file-level guard on BOTH statements is still asserted.
 * §5 MIGRATION 0414'S CONVERSION TO TWO DECIMALS (4a1abc4a), executed from the ACTUAL file. Each row's
 *    From becomes the row above's To and every figure lands on 2dp. It is the one thing in this file that
 *    CHANGES a credited figure: the old 0.401 / 0.701 notches left a fraction of exactly 0.400 or 0.700
 *    matching no band at all, and those two holes close. Asserted, not described. r303: that delta was
 *    measured under the pre-r303 engine, so it is asserted against the verbatim copy of that engine
 *    (test/helpers/rounding-bands-pre-r303.ts) rather than restated under rules it was never about.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { setLeaveTypeRules, LeaveTypeRuleError } from '../core/admin';
import {
  applyLeaveTypeRules,
  applyRounding,
  applyRoundingBands,
  checkRoundingBands,
  hasAnyLeaveTypeRule,
  isWellFormedRoundingBands,
  roundingBandErrors,
  type RoundingBand,
} from '../core/leave-compute';
import { preR303ApplyRoundingBands } from './helpers/rounding-bands-pre-r303';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(here, '../db/migrations/0358_leave_type_rounding_bands.sql');

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

const annualId = async () => {
  const [t] = await owner.db
    .select({ id: schema.leaveType.id })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.code, 'ANNUAL'))
    .limit(1);
  return t!.id;
};

const typeRow = async (id: string) => {
  const [t] = await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.id, id)).limit(1);
  return t!;
};

// The three retired methods, written as the tables that reproduce them. This is the claim the item makes.
const ROUND_UP: RoundingBand[] = [{ from: 0, to: 1, result: 1 }];
const ROUND_DOWN: RoundingBand[] = [{ from: 0, to: 1, result: 0 }];
/**
 * Nearest 0.5 Day needs THREE rows, and finding that out is worth recording. Its up-branch CEILS to the
 * 0.5 grid, so a decimal of exactly 0.50 becomes 0.5 while 0.51 and above become a whole day — two
 * different answers inside what looks like one range. The table expresses it, but only by saying so
 * explicitly, which is exactly the kind of thing a fixed method hides and a written table does not.
 *
 * r303 — with inclusive ranges the middle row is simply the single point 0.50 (it used to be the 3dp sliver
 * 0.500–0.501, which is exactly what migration 0473 turns it into). NEAREST_HALF_PRE_R303 below is the old
 * spelling, kept because the validator must now refuse it.
 */
const NEAREST_HALF: RoundingBand[] = [
  { from: 0, to: 0.49, result: 0 },
  { from: 0.5, to: 0.5, result: 0.5 },
  { from: 0.51, to: 0.99, result: 1 },
];
const NEAREST_HALF_PRE_R303: RoundingBand[] = [
  { from: 0, to: 0.5, result: 0 },
  { from: 0.5, to: 0.501, result: 0.5 },
  { from: 0.501, to: 1, result: 1 },
];

/** The simpler shape most people mean by "snap to the half day": everything from 0.50 stays at 0.50. */
const SNAP_TO_HALF: RoundingBand[] = [
  { from: 0, to: 0.49, result: 0 },
  { from: 0.5, to: 0.99, result: 0.5 },
];
/** …and its pre-r303 spelling, whose rows TOUCH at 0.50 — an overlap now that both ends are included. */
const SNAP_TO_HALF_PRE_R303: RoundingBand[] = [
  { from: 0, to: 0.5, result: 0 },
  { from: 0.5, to: 1, result: 0.5 },
];

// ── §1 ────────────────────────────────────────────────────────────────────────────────────────────────
describe('§1 the band evaluator — the arithmetic, in numbers', () => {
  it('a one-row 0.000→1.000 ⇒ 1.000 table IS Round Up, figure for figure', () => {
    for (const v of [10.9, 10.5, 10.91, 10.01, 1.17]) {
      expect(applyRoundingBands(v, ROUND_UP), `raw ${v}`).toBe(applyRounding(v, 'up'));
    }
  });

  it('a one-row 0.000→1.000 ⇒ 0.000 table IS Round Down, figure for figure', () => {
    for (const v of [10.49, 10.1, 10.9, 1.17]) {
      expect(applyRoundingBands(v, ROUND_DOWN), `raw ${v}`).toBe(applyRounding(v, 'down'));
    }
  });

  it("a three-row table IS the reporter's Nearest 0.5 Day default, figure for figure", () => {
    for (const v of [1.17, 1.5, 1.6, 1.49, 2, 0, 10.75]) {
      expect(applyRoundingBands(v, NEAREST_HALF), `raw ${v}`).toBe(applyRounding(v, 'nearest_half'));
    }
  });

  it('…and the simpler two-row table means something DIFFERENT, which the old method could not say', () => {
    // 1.60 stays at 1.50 here and became 2.00 under 'nearest_half'. Both are reasonable rules; only one of
    // them was expressible before, and the reporter could not tell from the dropdown which one they had.
    expect(applyRoundingBands(1.6, SNAP_TO_HALF)).toBe(1.5);
    expect(applyRounding(1.6, 'nearest_half')).toBe(2);
    expect(applyRoundingBands(1.17, SNAP_TO_HALF)).toBe(1);
    expect(applyRoundingBands(1.5, SNAP_TO_HALF)).toBe(1.5);
  });

  it('the WHOLE part rides through untouched — one table shapes 1.17, 10.17 and 21.17 identically', () => {
    for (const whole of [1, 10, 21, 100]) {
      expect(applyRoundingBands(whole + 0.17, SNAP_TO_HALF)).toBe(whole);
      expect(applyRoundingBands(whole + 0.6, SNAP_TO_HALF)).toBe(whole + 0.5);
    }
  });

  it('an ALREADY-WHOLE figure is never moved, even by a table whose first row would inflate it', () => {
    // Every method this replaces behaved this way (ceil, floor and nearest-half all leave 11.0 at 11.0).
    // Without the guard a first row of 0.000→0.500 ⇒ 0.500 would quietly hand half a day to everyone whose
    // entitlement came out exact — a table that reads as "round the stragglers up" inflating the tidy ones.
    const inflating: RoundingBand[] = [
      { from: 0, to: 0.49, result: 0.5 },
      { from: 0.5, to: 0.99, result: 1 },
    ];
    for (const whole of [0, 1, 11, 14]) expect(applyRoundingBands(whole, inflating)).toBe(whole);
    // …and it still moves a real decimal.
    expect(applyRoundingBands(11.2, inflating)).toBe(11.5);
  });

  it('the last band is INCLUSIVE at its To, so nothing falls off the top', () => {
    // r303 — every band is inclusive now, so a row ending at 0.99 covers the top decimal as surely as one
    // ending at 1.00, and "round up to the next whole day" is still one row.
    expect(applyRoundingBands(10.99, ROUND_UP)).toBe(11);
    expect(applyRoundingBands(10.99, [{ from: 0, to: 0.99, result: 1 }])).toBe(11);
    expect(applyRoundingBands(10.01, ROUND_UP)).toBe(11);
    // …and a range includes its From and its To, not just the decimals between them.
    const edges: RoundingBand[] = [
      { from: 0, to: 0.24, result: 0 },
      { from: 0.25, to: 0.49, result: 0.5 },
    ];
    expect(applyRoundingBands(10.24, edges)).toBe(10);
    expect(applyRoundingBands(10.25, edges)).toBe(10.5);
    expect(applyRoundingBands(10.49, edges)).toBe(10.5);
    expect(applyRoundingBands(10.5, edges), 'no row covers 0.50').toBe(10.5);
  });

  it('r303 — a figure is worked out to TWO decimals before the table is applied', () => {
    // "a figure can never fall between 0.24 and 0.25". 10.001 is 10.00 — a whole figure, never moved — and
    // 10.999 is 11.00. Under the pre-r303 engine both were looked up at three decimals and became 11.
    expect(applyRoundingBands(10.001, ROUND_UP)).toBe(10);
    expect(applyRoundingBands(10.999, ROUND_UP)).toBe(11);
    expect(applyRoundingBands(10.246, [{ from: 0.25, to: 0.49, result: 0.5 }])).toBe(10.5);
    // A decimal no row covers keeps its 2dp value, the ledger's own precision.
    expect(applyRoundingBands(10.203, [{ from: 0.5, to: 1, result: 1 }])).toBe(10.2);
  });

  it('r303 — compared in whole HUNDREDTHS, so a binary tail cannot move a figure across a band edge', () => {
    // 0.29 * 100 is 28.999999999999996 and 0.57 * 100 is 56.99999999999999 in IEEE754: a raw float `<=`
    // against a To of 0.28 or 0.56 is exactly where a figure would slip a band.
    const tight: RoundingBand[] = [
      { from: 0, to: 0.28, result: 0 },
      { from: 0.29, to: 0.56, result: 0.5 },
      { from: 0.57, to: 0.99, result: 1 },
    ];
    for (const whole of [0, 1, 7, 10, 21]) {
      expect(applyRoundingBands(whole + 0.28, tight), `${whole}.28`).toBe(whole);
      expect(applyRoundingBands(whole + 0.29, tight), `${whole}.29`).toBe(whole + 0.5);
      expect(applyRoundingBands(whole + 0.56, tight), `${whole}.56`).toBe(whole + 0.5);
      expect(applyRoundingBands(whole + 0.57, tight), `${whole}.57`).toBe(whole + 1);
    }
  });

  it('a DECIMAL A GAP DOES NOT COVER keeps its exact calculated value', () => {
    // The defined answer for "the table says nothing about this figure" is: do not touch it. Refusing to
    // round is always recoverable; inventing a rule is not.
    const topHalfOnly: RoundingBand[] = [{ from: 0.5, to: 0.99, result: 1 }];
    expect(applyRoundingBands(10.2, topHalfOnly)).toBe(10.2);
    expect(applyRoundingBands(10.7, topHalfOnly)).toBe(11);
  });

  it('a binary-float tail lands in the band an administrator reading three decimals expects', () => {
    // 0.1 + 0.2 + 1.2 is 1.5000000000000002 in IEEE754. Comparing the RAW value would drop it in the band
    // above the one the table describes — the same trap 9f5164d8 documented on the nearest-half branch.
    expect(applyRoundingBands(0.1 + 0.2 + 1.2, SNAP_TO_HALF)).toBe(1.5);
    expect(applyRoundingBands((14 / 12) * 6, SNAP_TO_HALF)).toBe(7);
  });

  it('DEFENSIVE: a malformed table, a non-finite value or a non-array leaves the figure EXACTLY alone', () => {
    // These run inside cron sweeps over hand-written rows; a bad table must not abort a tenant's sweep.
    for (const bad of [null, undefined, 'nope', [], [{ from: 0.5, to: 0.2, result: 0 }], [{ from: 0 }], 42, SNAP_TO_HALF_PRE_R303]) {
      expect(applyRoundingBands(10.7, bad), `bands ${JSON.stringify(bad)}`).toBe(10.7);
    }
    expect(Number.isNaN(applyRoundingBands(Number.NaN, ROUND_UP))).toBe(true);
    expect(applyRoundingBands(Number.POSITIVE_INFINITY, ROUND_UP)).toBe(Number.POSITIVE_INFINITY);
    expect(() => applyRoundingBands(undefined as unknown as number, ROUND_UP)).not.toThrow();
  });

  it("applyRounding only consults the table under 'custom' — it cannot move any other method's figure", () => {
    expect(applyRounding(10.7, 'custom', null, ROUND_DOWN)).toBe(10);
    // The same table passed alongside every other method changes nothing.
    for (const m of ['none', 'up', 'down', 'nearest_half', undefined, null]) {
      expect(applyRounding(10.7, m, null, ROUND_DOWN), `method ${m}`).toBe(applyRounding(10.7, m));
    }
    // …and 'custom' with NO table is byte-identical to No Rounding.
    expect(applyRounding(10.7, 'custom', null, null)).toBe(10.7);
  });
});

// ── §2 ────────────────────────────────────────────────────────────────────────────────────────────────
describe('§2 the validator — overlaps and duplicates are refused, a gap only warns', () => {
  const kinds = (bands: unknown) => checkRoundingBands(bands).map((p) => p.kind);

  it('a complete, disjoint table has NO problems at all', () => {
    expect(checkRoundingBands(NEAREST_HALF)).toEqual([]);
    expect(checkRoundingBands(SNAP_TO_HALF)).toEqual([]);
    expect(checkRoundingBands(ROUND_UP)).toEqual([]);
    expect(isWellFormedRoundingBands(NEAREST_HALF)).toBe(true);
  });

  it('r303 REVERSES TWO PINS: the 3dp NEAREST_HALF is refused as decimals, the touching SNAP_TO_HALF as an overlap', () => {
    // Before r303 both were complete, legal tables. A third decimal is now refused rather than rounded, and
    // two rows that both include 0.50 are two answers for one figure.
    expect(checkRoundingBands(NEAREST_HALF_PRE_R303)).toEqual([
      { kind: 'decimals', index: 1 },
      { kind: 'decimals', index: 2 },
    ]);
    expect(checkRoundingBands(SNAP_TO_HALF_PRE_R303)).toEqual([{ kind: 'overlap', index: 1 }]);
    expect(isWellFormedRoundingBands(SNAP_TO_HALF_PRE_R303)).toBe(false);
  });

  it('an OVERLAP is reported against the later row and blocks the save', () => {
    const overlapping: RoundingBand[] = [
      { from: 0, to: 0.6, result: 0 },
      { from: 0.4, to: 1, result: 1 },
    ];
    expect(kinds(overlapping)).toContain('overlap');
    expect(checkRoundingBands(overlapping)).toContainEqual({ kind: 'overlap', index: 1 });
    expect(roundingBandErrors(overlapping).length).toBeGreaterThan(0);
    expect(isWellFormedRoundingBands(overlapping)).toBe(false);
  });

  it('a DUPLICATE range is its own problem, not merely an overlap', () => {
    const dup: RoundingBand[] = [
      { from: 0, to: 0.49, result: 0 },
      { from: 0, to: 0.49, result: 1 },
      { from: 0.5, to: 1, result: 0.5 },
    ];
    expect(checkRoundingBands(dup)).toContainEqual({ kind: 'duplicate', index: 1 });
    expect(kinds(dup)).not.toContain('overlap'); // reported once, as the more specific thing it is
  });

  it('a GAP is reported with its bounds and does NOT block the save', () => {
    const gapped: RoundingBand[] = [
      { from: 0, to: 0.3, result: 0 },
      { from: 0.7, to: 1, result: 1 },
    ];
    // r303 — the gap is named by the decimals it leaves out, both ends included: 0.31 to 0.69.
    expect(checkRoundingBands(gapped)).toEqual([{ kind: 'gap', from: 0.31, to: 0.69 }]);
    // A half-finished table must be SAVABLE, or an administrator cannot build one row at a time.
    expect(roundingBandErrors(gapped)).toEqual([]);
    expect(isWellFormedRoundingBands(gapped)).toBe(true);
  });

  it('an unclosed top or an unstarted bottom is a gap too', () => {
    // r303 — the table is complete once it reaches 0.99 (no worked-out decimal is larger) and starts at 0.00.
    expect(checkRoundingBands([{ from: 0, to: 0.5, result: 0 }])).toEqual([{ kind: 'gap', from: 0.51, to: 0.99 }]);
    expect(checkRoundingBands([{ from: 0.5, to: 1, result: 1 }])).toEqual([{ kind: 'gap', from: 0, to: 0.49 }]);
    expect(checkRoundingBands([{ from: 0, to: 0.98, result: 0 }])).toEqual([{ kind: 'gap', from: 0.99, to: 0.99 }]);
    expect(checkRoundingBands([{ from: 0, to: 0.99, result: 0 }])).toEqual([]);
    expect(checkRoundingBands([{ from: 0.01, to: 0.99, result: 0 }])).toEqual([{ kind: 'gap', from: 0, to: 0 }]);
  });

  it('out-of-range bounds, inverted rows, blank cells and third decimals are EACH named', () => {
    expect(kinds([{ from: 0, to: 1.5, result: 0 }])).toEqual(['range']);
    expect(kinds([{ from: 0, to: 1, result: -0.5 }])).toEqual(['range']);
    expect(kinds([{ from: 0.8, to: 0.2, result: 0 }])).toEqual(['order']);
    expect(kinds([{ from: 0, to: 'x', result: 0 }])).toEqual(['blank']);
    expect(kinds([{ from: 0, to: Number.NaN, result: 0 }])).toEqual(['blank']);
    expect(kinds([{ from: 0, to: 0.5 }])).toEqual(['blank']);
    expect(kinds([null])).toEqual(['shape']);
    expect(kinds('not an array')).toEqual(['shape']);
    // "at most two decimals — refuse, do not round": 0.245 is a problem, not 0.25.
    expect(kinds([{ from: 0, to: 0.245, result: 0 }])).toEqual(['decimals']);
    expect(kinds([{ from: 0, to: 0.5, result: 0.505 }])).toEqual(['decimals']);
    // One row breaking three rules names all three, so the editor can show a message for each.
    expect(kinds([{ from: 1.005, to: 0.5, result: 0 }])).toEqual(['decimals', 'range', 'order']);
    // Float noise is not a third decimal.
    expect(kinds([{ from: 0.1 + 0.2, to: 0.57, result: 0.29 }])).not.toContain('decimals');
  });

  it('r303 REVERSES A PIN: a single-point row (From = To) is LEGAL — it used to be an empty `order` band', () => {
    // The reporter's rule is "From not above To". 0.50–0.50 covers exactly the decimal 0.50.
    expect(roundingBandErrors([{ from: 0.5, to: 0.5, result: 0 }])).toEqual([]);
    expect(kinds([{ from: 0.5, to: 0.5, result: 0 }])).toEqual(['gap', 'gap']);
    expect(applyRoundingBands(3.5, [{ from: 0.5, to: 0.5, result: 1 }])).toBe(4);
    expect(applyRoundingBands(3.51, [{ from: 0.5, to: 0.5, result: 1 }])).toBe(3.51);
  });

  it('r303 — an overlap is INCLUSIVE: sharing a single decimal is an overlap, the next hundredth is not', () => {
    expect(checkRoundingBands([
      { from: 0, to: 0.24, result: 0 },
      { from: 0.24, to: 0.49, result: 0.5 },
    ])).toContainEqual({ kind: 'overlap', index: 1 });
    expect(roundingBandErrors([
      { from: 0, to: 0.24, result: 0 },
      { from: 0.25, to: 0.49, result: 0.5 },
    ])).toEqual([]);
    // A point row inside another row is an overlap too.
    expect(checkRoundingBands([
      { from: 0, to: 0.99, result: 0 },
      { from: 0.5, to: 0.5, result: 1 },
    ])).toEqual([{ kind: 'overlap', index: 1 }]);
  });

  it('coverage is only reported once the rows are individually sane', () => {
    // Otherwise the gaps would be an artefact of the rows we already refused, burying the real problem.
    expect(kinds([{ from: 0.8, to: 0.2, result: 0 }])).not.toContain('gap');
  });

  it('THE SERVICE IS AUTHORITATIVE: the writer refuses an overlapping table with a NAMED error', async () => {
    const id = await annualId();
    await expect(
      setLeaveTypeRules(adminCtx(b), {
        id,
        roundingMethod: 'custom',
        roundingBands: [
          { from: 0, to: 0.6, result: 0 },
          { from: 0.4, to: 1, result: 1 },
        ],
      }),
    ).rejects.toBeInstanceOf(LeaveTypeRuleError);
  });

  it('r303 — the service names EACH problem in its own sentence, row by row', async () => {
    const id = await annualId();
    const attempt = setLeaveTypeRules(adminCtx(b), {
      id,
      roundingMethod: 'custom',
      roundingBands: [
        { from: 0, to: 0.24, result: 0 },
        { from: 0.24, to: 0.49, result: 0.5 },
        { from: 0.6, to: 0.555, result: 1 },
        { from: 0.8, to: 0.7, result: 1.5 },
        { from: 0.9, to: Number.NaN, result: 1 },
      ],
    });
    await expect(attempt).rejects.toThrow(
      'The rounding table was not saved. Row 3: use at most two decimal places. Row 3: From cannot be above To. ' +
        'Row 4: keep From, To and Round To between 0.00 and 1.00. Row 4: From cannot be above To. ' +
        'Row 5: fill in From, To and Round To. Row 2: this range overlaps another row (a range includes both its From and its To).',
    );
    // Nothing was written.
    expect((await typeRow(id)).roundingBands).toBeNull();
  });

  it('r303 — a table is stored EXACTLY as typed, at two decimals, From included', async () => {
    const id = await annualId();
    const typed: RoundingBand[] = [
      { from: 0.75, to: 0.99, result: 1 },
      { from: 0, to: 0.24, result: 0 },
      { from: 0.25, to: 0.74, result: 0.5 },
    ];
    await setLeaveTypeRules(adminCtx(b), { id, roundingMethod: 'custom', roundingBands: typed });
    expect((await typeRow(id)).roundingBands).toEqual(typed);
  });

  it('…but ACCEPTS a gapped table, because the UI hints are UX and this is the guard', async () => {
    const id = await annualId();
    await expect(
      setLeaveTypeRules(adminCtx(b), {
        id,
        roundingMethod: 'custom',
        roundingBands: [{ from: 0.5, to: 1, result: 1 }],
      }),
    ).resolves.not.toThrow();
    expect((await typeRow(id)).roundingBands).toEqual([{ from: 0.5, to: 1, result: 1 }]);
  });

  it('an EMPTY table is stored as NULL, never as [] — or the type would stay "ruled" on nothing', async () => {
    const id = await annualId();
    await setLeaveTypeRules(adminCtx(b), { id, accrualMethod: 'earned_monthly', roundingMethod: 'custom', roundingBands: NEAREST_HALF });
    await setLeaveTypeRules(adminCtx(b), { id, roundingBands: [] });
    expect((await typeRow(id)).roundingBands).toBeNull();
  });

  it('the stored table round-trips through the overlay and reaches the engine', async () => {
    const id = await annualId();
    await setLeaveTypeRules(adminCtx(b), { id, roundingMethod: 'custom', roundingBands: NEAREST_HALF });
    const row = await typeRow(id);
    const pol = applyLeaveTypeRules({ days: 14, carryMax: 0 }, row)!;
    expect(pol.roundingMethod).toBe('custom');
    expect(pol.roundingBands).toEqual(NEAREST_HALF);
    // The figure the engine would credit for one earned month of a 14-day entitlement.
    expect(applyRounding(14 / 12, pol.roundingMethod, pol.roundingThreshold, pol.roundingBands)).toBe(1);
  });

  it('a self-contradictory table that bypassed the writer is IGNORED by the overlay, not acted on', async () => {
    // The last line of defence: a row written by hand or by an older release must not round a balance by
    // a rule the engine cannot resolve.
    const id = await annualId();
    await owner.db
      .update(schema.leaveType)
      .set({
        roundingMethod: 'custom',
        // r303 — and the pre-r303 touching shape a stale writer could still produce is ignored the same way.
        roundingBands: SNAP_TO_HALF_PRE_R303,
      })
      .where(eq(schema.leaveType.id, id));
    const pol = applyLeaveTypeRules({ days: 14, carryMax: 0 }, await typeRow(id))!;
    expect(pol.roundingBands).toBeNull();
    expect(applyRounding(10.7, pol.roundingMethod, pol.roundingThreshold, pol.roundingBands)).toBe(10.7);
  });
});

// ── §3 ────────────────────────────────────────────────────────────────────────────────────────────────
describe('§3 the unruled fall-through — the trap this item had to walk past', () => {
  it('a BANDS-ONLY type is ruled, so its table is not silently ignored', () => {
    expect(hasAnyLeaveTypeRule({ roundingBands: ROUND_UP })).toBe(true);
    const legacy = { days: 14, carryMax: 99, method: 'earned_monthly' };
    const out = applyLeaveTypeRules(legacy, { roundingBands: ROUND_UP })!;
    // The overlay engaged: the legacy carry cap did NOT ride through.
    expect(out).not.toBe(legacy);
    expect(out.carryMax).toBe(0);
    expect(out.roundingBands).toEqual(ROUND_UP);
  });

  it("clearing the ONLY rule stores 'none', so the type never falls back to its legacy JSONB rules", async () => {
    const id = await annualId();
    await setLeaveTypeRules(adminCtx(b), { id, roundingMethod: 'custom', roundingBands: ROUND_UP });
    await setLeaveTypeRules(adminCtx(b), { id, roundingMethod: null, roundingBands: null });
    const row = await typeRow(id);
    expect(row.roundingMethod).toBe('none');
    expect(hasAnyLeaveTypeRule(row)).toBe(true);
    // 'none' is a value, not a rule the engine acts on: nothing is rounded either way.
    expect(applyLeaveTypeRules({ days: 14, carryMax: 0 }, row)!.roundingMethod).toBeUndefined();
  });

  it('…but a type that still carries ANOTHER rule clears to a plain NULL', async () => {
    const id = await annualId();
    await setLeaveTypeRules(adminCtx(b), { id, accrualMethod: 'earned_monthly', roundingMethod: 'custom', roundingBands: ROUND_UP });
    await setLeaveTypeRules(adminCtx(b), { id, roundingMethod: null, roundingBands: null });
    const row = await typeRow(id);
    expect(row.roundingMethod).toBeNull();
    expect(hasAnyLeaveTypeRule(row)).toBe(true);
  });
});

// ── §4 ────────────────────────────────────────────────────────────────────────────────────────────────
describe('§4 migration 0358 — the reset, executed from the ACTUAL file', () => {
  /**
   * Re-executes the migration's `leave_type` UPDATE, from the real file, inside ONE transaction. Reading
   * the file rather than restating the SQL is the point: a reset that stops matching what ships is a reset
   * that only the test believes in. The guard assertions below refuse a file that no longer resets.
   *
   * ── 6e9a126e RELEASE THREE: THE FILE STILL CARRIES TWO RESETS; ONLY ONE IS STILL EXECUTABLE ─────────
   * 0358 resets rounding on BOTH storage surfaces — `leave_type` and `leave_policy.accrual`. Migration
   * 0405 later DROPS `leave_policy`, so by the time `migrateTestDb()` has run the whole chain the second
   * statement targets a table that no longer exists and would abort the transaction.
   *
   * The FILE-LEVEL guard is deliberately NOT weakened: 0358 is a shipped historical migration that still
   * replays in order on a fresh database (where leave_policy is very much alive at 0358), so it must still
   * contain both statements and `toHaveLength(2)` still asserts exactly that. What narrows is only which
   * statement this test EXECUTES against a fully-migrated schema. Filtering by target table rather than by
   * position keeps the guard honest: if the leave_type reset were the one that disappeared, the filter
   * would find nothing and the explicit length check below would fail rather than pass vacuously.
   */
  async function runReset(): Promise<void> {
    const text = readFileSync(MIGRATION, 'utf8');
    expect(text).toContain('UPDATE "leave_type" SET');
    expect(text).toContain("THEN 'none'");
    expect(text).toContain(`("accrual" - 'roundingMethod')`);
    const stmts = text
      .split('--> statement-breakpoint')
      // Strip the leading comment block: every statement in this file is preceded by the reasoning for it,
      // and a naive startsWith('UPDATE') would silently match nothing and make §4 vacuously green.
      .map((s) => s.replace(/^(?:\s*--[^\n]*\n)+/, '').trim().replace(/;$/, ''))
      .filter((s) => /^UPDATE\b/.test(s));
    expect(stmts, 'the migration must carry BOTH resets — leave_type and leave_policy').toHaveLength(2);
    const typeStmts = stmts.filter((s) => /^UPDATE\s+"leave_type"/.test(s));
    expect(typeStmts, 'the leave_type reset is the one this test replays').toHaveLength(1);
    await owner.db.transaction(async (tx) => {
      for (const s of typeStmts) await tx.execute(sql.raw(s));
    });
  }

  it('resets a rounding type to No Rounding and clears its threshold', async () => {
    const id = await annualId();
    // The production shape: Round Up, alongside other rules (so it does not go unruled).
    await owner.db
      .update(schema.leaveType)
      .set({ roundingMethod: 'up', roundingThreshold: '0.750', accrualMethod: 'earned_monthly' })
      .where(eq(schema.leaveType.id, id));
    await runReset();
    const row = await typeRow(id);
    expect(row.roundingMethod).toBeNull();
    expect(row.roundingThreshold).toBeNull();
    // The other rules are untouched — this is a rounding change, and only a rounding change.
    expect(row.accrualMethod).toBe('earned_monthly');
    expect(hasAnyLeaveTypeRule(row)).toBe(true);
  });

  it("a type whose ONLY rule is rounding is reset to 'none', NOT to NULL — the fall-through guard", async () => {
    // THE TRAP. A NULL here would flip the type to unruled and applyLeaveTypeRules would hand back the
    // legacy grade policy verbatim: a different earning method, a different carry cap, a different balance,
    // all under the heading of a rounding change. This is the assertion the plan asked to be re-checked at
    // build time rather than assumed from a production snapshot.
    const id = await annualId();
    await owner.db
      .update(schema.leaveType)
      .set({
        roundingMethod: 'up',
        accrualMethod: null,
        carryForwardMax: null,
        carryForwardPercent: null,
        carryForwardEnabled: null,
        carryForwardExpiryMode: null,
        carryForwardExpiryMonths: null,
        carryForwardExpiryMonth: null,
        carryForwardExpiryDay: null,
        maxBalanceDays: null,
        roundingBands: null,
      })
      .where(eq(schema.leaveType.id, id));
    await runReset();
    const row = await typeRow(id);
    expect(row.roundingMethod).toBe('none');
    expect(hasAnyLeaveTypeRule(row)).toBe(true);
    expect(applyLeaveTypeRules({ days: 14, carryMax: 0 }, row)!.roundingMethod).toBeUndefined();
  });

  // ── 6e9a126e RELEASE THREE RETIRED THE TWO `leave_policy.accrual` TESTS THAT SAT HERE ──────────────
  // They were "clears the LEGACY JSONB copy on every policy, and touches nothing else in it" and "leaves a
  // policy that never had a rounding key byte-identical" — both inserted a `leave_policy` row, replayed
  // 0358's second UPDATE and asserted on the resulting JSONB. Migration 0405 dropped `leave_policy`, so
  // there is no second storage surface left for the reset to clear and no row for it to leave alone. The
  // statement they exercised is still IN the migration file and is still asserted to be there by
  // `runReset` above; it simply has no table to run against once the chain reaches 0405.
  //
  // Nothing was loosened to achieve this: the surviving §4 tests below still pin the leave_type reset, the
  // unruled fall-through guard, ledger immutability and idempotence, on their original figures.

  it('DOES NOT TOUCH A SINGLE LEDGER ROW — closed prior years are not rewritten by a config change', async () => {
    // The reset moves CONFIGURATION. Balances follow through the ordinary engines, every one of which is
    // guarded to the current open cycle; a prior year was governed by the version active at its year-open
    // and is never revisited. A migration that reached into leave_ledger would bypass all of that.
    const id = await annualId();
    await owner.db.update(schema.leaveType).set({ roundingMethod: 'up' }).where(eq(schema.leaveType.id, id));
    const countLedger = async () => {
      const [r] = await owner.db.select({ n: sql<number>`count(*)::int` }).from(schema.leaveLedger);
      return r!.n;
    };
    const before = await countLedger();
    const [snapshot] = await owner.db
      .select({ digest: sql<string>`coalesce(md5(string_agg(id::text || ':' || days::text, ',' ORDER BY id)), '')` })
      .from(schema.leaveLedger);
    await runReset();
    expect(await countLedger()).toBe(before);
    const [after] = await owner.db
      .select({ digest: sql<string>`coalesce(md5(string_agg(id::text || ':' || days::text, ',' ORDER BY id)), '')` })
      .from(schema.leaveLedger);
    expect(after!.digest).toBe(snapshot!.digest);
  });

  it('is idempotent — running it twice changes nothing the second time', async () => {
    const id = await annualId();
    await owner.db
      .update(schema.leaveType)
      .set({ roundingMethod: 'up', accrualMethod: 'earned_monthly' })
      .where(eq(schema.leaveType.id, id));
    await runReset();
    const first = await typeRow(id);
    await runReset();
    expect(await typeRow(id)).toEqual(first);
  });
});

// ── §5 ────────────────────────────────────────────────────────────────────────────────────────────────
describe('§5 migration 0414 — the table moves to 2dp and its rows are joined up', () => {
  /**
   * 4a1abc4a. The reporter's screenshot re-opened this table: it showed three decimals while everything
   * else in Leave Configuration now shows two. What the three production tables actually held was
   * multiples of 0.01 plus 0.401 and 0.701 — a notch above 0.400 and 0.700, typed because each row stops
   * just BEFORE its Round To and the next row had to start somewhere.
   *
   * ⚠️ THE NOTCHES LEFT TWO HOLES, AND CLOSING THEM IS A REAL BEHAVIOUR CHANGE. A fraction of exactly
   * 0.400 sat past the end of row 1 and below the start of row 2, so it matched NO band and was left
   * unrounded. Same at 0.700. That is stated in the migration header and was stated to the reporter in
   * the plan before approval, and it is asserted here rather than described: this is the only assertion
   * in this file that changes how many days somebody is credited.
   *
   * Executed from the ACTUAL file for the same reason §4 is: a conversion that stops matching what ships
   * is a conversion only the test believes in. NO ENGINE CHANGE accompanied 0414, which is why its
   * assertions ran the real evaluator over the converted rows.
   *
   * r303 — THAT EVALUATOR IS NO LONGER THE REAL ONE. r303 made ranges inclusive, and migration 0473 (which
   * runs AFTER 0414 in the journal) rewrites 0414's output into the new meaning. So the delta 0414 made is
   * asserted against `preR303ApplyRoundingBands`, the verbatim copy of the engine 0414 shipped under — the
   * assertion is unchanged in what it claims, and it still runs over the rows the real 0414 file writes.
   */
  const CONVERT = resolve(here, '../db/migrations/0414_rounding_bands_two_decimals.sql');

  /** Production's table, verbatim, on all three of the leave types that carry one. */
  const STORED: RoundingBand[] = [
    { from: 0, to: 0.4, result: 0 },
    { from: 0.401, to: 0.7, result: 0.5 },
    { from: 0.701, to: 1, result: 1 },
  ];

  async function runConvert(): Promise<void> {
    const text = readFileSync(CONVERT, 'utf8');
    // The From is DERIVED from the row above, over whatever tables exist — not a hardcoded rewrite of the
    // nine rows we happen to know about. A tenant on another database has to be converted too.
    expect(text, 'the conversion must derive From from the row above').toContain('lag(to_v)');
    expect(text, 'and rebuild the array rather than patch known rows').toContain('jsonb_agg(');
    const stmts = text
      .split('--> statement-breakpoint')
      .map((s) => s.replace(/^(?:\s*--[^\n]*\n)+/, '').trim().replace(/;$/, ''))
      .filter((s) => /^WITH\b/.test(s));
    expect(stmts, 'one statement, and it must actually be there').toHaveLength(1);
    await owner.db.transaction(async (tx) => {
      for (const s of stmts) await tx.execute(sql.raw(s));
    });
  }

  const bandsOf = async (id: string) => (await typeRow(id)).roundingBands as RoundingBand[] | null;

  it("each row's From becomes the row above's To, and every figure lands on 2dp", async () => {
    const id = await annualId();
    await owner.db
      .update(schema.leaveType)
      .set({ roundingMethod: 'custom', roundingBands: STORED })
      .where(eq(schema.leaveType.id, id));
    await runConvert();
    expect(await bandsOf(id)).toEqual([
      { from: 0, to: 0.4, result: 0 },
      { from: 0.4, to: 0.7, result: 0.5 },
      { from: 0.7, to: 1, result: 1 },
    ]);
  });

  it('THE DELTA: a fraction of exactly 0.400 was left alone and now rounds to half a day', async () => {
    const id = await annualId();
    await owner.db
      .update(schema.leaveType)
      .set({ roundingMethod: 'custom', roundingBands: STORED })
      .where(eq(schema.leaveType.id, id));
    // Before: the two holes. Nothing matched, so the value came back exactly as calculated.
    expect(preR303ApplyRoundingBands(10.4, STORED)).toBe(10.4);
    expect(preR303ApplyRoundingBands(10.7, STORED)).toBe(10.7);
    await runConvert();
    const after = (await bandsOf(id))!;
    expect(preR303ApplyRoundingBands(10.4, after)).toBe(10.5);
    expect(preR303ApplyRoundingBands(10.7, after)).toBe(11);
    // …and NOTHING ELSE MOVES. Only the two boundaries shifted, and only across the holes.
    for (const v of [10, 10.001, 10.39, 10.401, 10.5, 10.69, 10.701, 10.999]) {
      expect(preR303ApplyRoundingBands(v, after), `fraction of ${v}`).toBe(preR303ApplyRoundingBands(v, STORED));
    }
  });

  it('leaves a table the engine could never read ALONE, rather than inventing figures for it', async () => {
    // `applyRoundingBands` already ignores a malformed table and returns the value as calculated. Repairing
    // one here would turn a rule nobody can read into a rule that silently starts moving days.
    const id = await annualId();
    const junk = [{ from: 0, to: 'half', result: 0 }] as unknown as RoundingBand[];
    await owner.db
      .update(schema.leaveType)
      .set({ roundingMethod: 'custom', roundingBands: junk })
      .where(eq(schema.leaveType.id, id));
    await runConvert();
    expect(await bandsOf(id)).toEqual(junk);
  });

  it('a type with no table at all is untouched', async () => {
    const id = await annualId();
    await owner.db
      .update(schema.leaveType)
      .set({ roundingMethod: 'none', roundingBands: null })
      .where(eq(schema.leaveType.id, id));
    await runConvert();
    expect(await bandsOf(id)).toBeNull();
  });

  it('is idempotent — running it twice changes nothing the second time', async () => {
    const id = await annualId();
    await owner.db
      .update(schema.leaveType)
      .set({ roundingMethod: 'custom', roundingBands: STORED })
      .where(eq(schema.leaveType.id, id));
    await runConvert();
    const first = await typeRow(id);
    await runConvert();
    expect(await typeRow(id)).toEqual(first);
  });
});
