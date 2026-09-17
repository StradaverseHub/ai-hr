/**
 * r303 (05db6aa7) "Custom Rounding Table Configuration" — MIGRATION 0473 AND THE EQUIVALENCE IT PROMISES.
 *
 * The reporter approved a table read the way it is labelled: From / To / Round To, BOTH ENDS INCLUDED, two
 * decimals. The engine used to match  from <= f < to  at three decimals. The plan told the reporter:
 * "Tables you have already saved keep giving exactly the same results." This file is that sentence, run.
 *
 * ⚠️ THE TRAP. Inclusive bounds WITHOUT converted data turn production's touching table (0.00–0.40,
 * 0.40–0.70, 0.70–1.00) into an OVERLAPPING one; an overlapping table is malformed; a malformed table is
 * passed straight through — and rounding silently stops on every leave type that has one. §1 pins the trap
 * and its cure together.
 *
 * §1 EQUIVALENCE IS THE ACCEPTANCE TEST. Every fixture table is stored, the REAL 0473 file is executed
 *    against it (not a TypeScript re-implementation), and for EVERY 2dp decimal 0.00–0.99 at whole parts 0,
 *    1 and 7:  preR303(oldTable) === applyRoundingBands(convertedTable). The oracle is a verbatim copy of
 *    the shipped pre-r303 engine (test/helpers/rounding-bands-pre-r303.ts).
 * §2 WHAT IT LEAVES ALONE, AND WHAT IT TELLS THE DEPLOY LOG. Malformed tables untouched and named; the one
 *    class of those the NEW rules accept is a WARNING; a third-decimal result on an exact half is rounded
 *    half-up and named; the summary counts; not one ledger row.
 * §3 THE REPORTER'S TABLE, AS TYPED — the eleven figures, through the real service and the real engine.
 * §4 THE "INPUTS ARE ALREADY 2dp" PREMISE, CHECKED RATHER THAN ASSUMED. It holds for every caller except the
 *    full grant of a configured template figure, which the service lets carry a third decimal. That caller
 *    is exercised here with a 3dp figure, and what changes for it is pinned.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { setLeaveTypeRules, LeaveTypeRuleError } from '../core/admin';
import {
  applyLeaveTypeRules,
  applyRounding,
  applyRoundingBands,
  checkRoundingBands,
  composeEntitlement,
  isWellFormedRoundingBands,
  validateServiceBands,
  type RoundingBand,
} from '../core/leave-compute';
import { hireYearGrantDays } from '../core/leave';
import { preR303ApplyRoundingBands, preR303IsWellFormedRoundingBands } from './helpers/rounding-bands-pre-r303';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILE = '0473_rounding_bands_inclusive_ranges';
const MIGRATION = resolve(here, `../db/migrations/${MIGRATION_FILE}.sql`);

let b: Base;
type Notice = { severity: string; message: string };
let notices: Notice[] = [];
const noticeClient = postgres(process.env.TEST_MIGRATION_DATABASE_URL!, {
  max: 1,
  onnotice: (n) => notices.push({ severity: String(n.severity), message: String(n.message) }),
});

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  notices = [];
});
afterAll(async () => {
  await noticeClient.end();
  await closeAll();
});

/** The migration's statements, split exactly as drizzle's migrator splits a file, run in ONE transaction. */
async function runMigration(): Promise<void> {
  const stmts = readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  expect(stmts, '0473 is one DO block').toHaveLength(1);
  expect(stmts[0]).toMatch(/DO \$\$[\s\S]*UPDATE leave_type SET rounding_bands[\s\S]*END \$\$;$/);
  await noticeClient.begin(async (tx) => {
    for (const s of stmts) await tx.unsafe(s);
  });
}

/** Store each table on its own leave type, straight into the column (these are tables the pre-r303 writer
 *  stored, or hand-written rows no writer would accept today). */
async function storeTables(tables: Record<string, unknown>): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [code, bands] of Object.entries(tables)) {
    const [row] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code, name: code, roundingMethod: 'custom', roundingBands: bands })
      .returning({ id: schema.leaveType.id });
    ids[code] = row!.id;
  }
  return ids;
}

async function bandsById(ids: Record<string, string>): Promise<Record<string, unknown>> {
  const rows = await owner.db
    .select({ id: schema.leaveType.id, bands: schema.leaveType.roundingBands })
    .from(schema.leaveType)
    .where(inArray(schema.leaveType.id, Object.values(ids)));
  const byId = new Map(rows.map((r) => [r.id, r.bands]));
  return Object.fromEntries(Object.entries(ids).map(([code, id]) => [code, byId.get(id)]));
}

const WHOLE_PARTS = [0, 1, 7];
/** Every 2dp figure at the whole parts above, built from integer hundredths so the double is the nearest one. */
const every2dpFigure = () => WHOLE_PARTS.flatMap((w) => Array.from({ length: 100 }, (_, h) => (w * 100 + h) / 100));
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── The fixture tables, as the pre-r303 engine read them ──────────────────────────────────────────────
/** Production after 0414: ANNUAL, CGL and CPL all hold this (0414 header, measured 2026-08-07). */
const PRODUCTION: RoundingBand[] = [
  { from: 0, to: 0.4, result: 0 },
  { from: 0.4, to: 0.7, result: 0.5 },
  { from: 0.7, to: 1, result: 1 },
];
/** Production BEFORE 0414 — the third-decimal notches. A tenant 0414 somehow missed would still hold it. */
const PRODUCTION_PRE_0414: RoundingBand[] = [
  { from: 0, to: 0.4, result: 0 },
  { from: 0.401, to: 0.7, result: 0.5 },
  { from: 0.701, to: 1, result: 1 },
];

const EXACT_SHAPES: Record<string, RoundingBand[]> = {
  PRODUCTION,
  PRODUCTION_PRE_0414,
  // test/leave-rounding-bands.test.ts's pre-r303 fixtures, verbatim.
  ROUND_UP: [{ from: 0, to: 1, result: 1 }],
  ROUND_DOWN: [{ from: 0, to: 1, result: 0 }],
  NEAREST_HALF: [
    { from: 0, to: 0.5, result: 0 },
    { from: 0.5, to: 0.501, result: 0.5 },
    { from: 0.501, to: 1, result: 1 },
  ],
  SNAP_TO_HALF: [
    { from: 0, to: 0.5, result: 0 },
    { from: 0.5, to: 1, result: 0.5 },
  ],
  INFLATING: [
    { from: 0, to: 0.5, result: 0.5 },
    { from: 0.5, to: 1, result: 1 },
  ],
  // Gaps: bottom, middle, top — and a single row in the middle that reaches neither end.
  TOP_HALF_ONLY: [{ from: 0.5, to: 1, result: 1 }],
  GAPPED: [
    { from: 0, to: 0.3, result: 0 },
    { from: 0.7, to: 1, result: 1 },
  ],
  BOTTOM_HALF_ONLY: [{ from: 0, to: 0.5, result: 0 }],
  MIDDLE_ONLY: [{ from: 0.25, to: 0.75, result: 0.5 }],
  // Rows typed out of order — the engine matches whichever row covers the decimal, not the first.
  UNORDERED: [
    { from: 0.7, to: 1, result: 1 },
    { from: 0, to: 0.4, result: 0 },
    { from: 0.4, to: 0.7, result: 0.5 },
  ],
  // Third-decimal bounds everywhere, including a row covering NO 2dp decimal (0.401–0.409), which is dropped.
  THREE_DP: [
    { from: 0.004, to: 0.401, result: 0 },
    { from: 0.401, to: 0.409, result: 0.5 },
    { from: 0.409, to: 0.996, result: 1 },
  ],
  // Every row covers no 2dp decimal: the converted table is [] and rounds nothing, exactly as before.
  COVERS_NOTHING: [{ from: 0.001, to: 0.009, result: 1 }],
  // Results with a third decimal that is NOT on a half: the 2dp result is the same for every whole part.
  THREE_DP_RESULTS: [
    { from: 0, to: 0.5, result: 0.254 },
    { from: 0.5, to: 1, result: 0.756 },
  ],
  // A bound on an exact half-thousandth that IEEE-754 rounds DOWN: 0.5005 * 1000 is 500.49999999999994, so
  // the old engine read it as 0.500. Plain numeric rounding would read 0.501 and move 0.50 into row 1.
  HALF_THOUSANDTH_DOWN: [
    { from: 0, to: 0.5005, result: 0 },
    { from: 0.5005, to: 1, result: 1 },
  ],
  // …and one IEEE-754 rounds UP (0.4005 * 1000 is exactly 400.5): read as 0.401.
  HALF_THOUSANDTH_UP: [
    { from: 0, to: 0.4005, result: 0 },
    { from: 0.4005, to: 1, result: 1 },
  ],
  // A negative zero-ish lower bound the old validator accepted (Math.round(-0.5) is -0).
  NEGATIVE_HALF_THOUSANDTH: [{ from: -0.0005, to: 0.5, result: 0.5 }],
};

describe('§1 0473 converts every stored table with identical results for every 2dp figure', () => {
  it('THE TRAP: the new engine reads an unconverted production table as malformed and stops rounding', () => {
    // Why the code and the migration are one change. Not asserted as "desirable" — asserted so nobody
    // ships the engine without the data.
    expect(preR303IsWellFormedRoundingBands(PRODUCTION)).toBe(true);
    expect(isWellFormedRoundingBands(PRODUCTION)).toBe(false);
    expect(checkRoundingBands(PRODUCTION).map((p) => p.kind)).toEqual(['overlap', 'overlap']);
    expect(applyRoundingBands(10.3, PRODUCTION)).toBe(10.3);
    expect(preR303ApplyRoundingBands(10.3, PRODUCTION)).toBe(10);
  });

  it("production's table becomes 0.00–0.39 / 0.40–0.69 / 0.70–0.99, the plan's own example", async () => {
    const ids = await storeTables({ ANNUAL_X: PRODUCTION });
    await runMigration();
    const after = (await bandsById(ids)).ANNUAL_X;
    expect(after).toEqual([
      { from: 0, to: 0.39, result: 0 },
      { from: 0.4, to: 0.69, result: 0.5 },
      { from: 0.7, to: 0.99, result: 1 },
    ]);
    // …and the overlay the engines use no longer filters it away: rounding did not silently stop.
    const [row] = await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.id, ids.ANNUAL_X));
    const pol = applyLeaveTypeRules({ days: 14, carryMax: 0 }, row!)!;
    expect(pol.roundingBands).toEqual(after);
    expect(applyRounding(10.3, pol.roundingMethod, pol.roundingThreshold, pol.roundingBands)).toBe(10);
  });

  it('EVERY FIXTURE SHAPE: old engine on the old table === new engine on the migrated table, for every 2dp figure', async () => {
    const ids = await storeTables(EXACT_SHAPES);
    await runMigration();
    const converted = await bandsById(ids);
    const figures = every2dpFigure();
    expect(figures).toHaveLength(300);
    for (const [code, oldTable] of Object.entries(EXACT_SHAPES)) {
      const newTable = converted[code];
      // Every one of these was well-formed under the old rules, so every one was converted — and lands
      // well-formed under the new rules too (or as [] when no row covered a 2dp decimal).
      expect(preR303IsWellFormedRoundingBands(oldTable), `${code} was a live table`).toBe(true);
      expect(newTable, `${code} was rewritten`).not.toEqual(oldTable);
      if ((newTable as unknown[]).length > 0) {
        expect(checkRoundingBands(newTable).filter((p) => p.kind !== 'gap'), `${code} converted is valid`).toEqual([]);
      }
      for (const v of figures) {
        expect(applyRoundingBands(v, newTable), `${code} at ${v}`).toBe(preR303ApplyRoundingBands(v, oldTable));
      }
    }
    // The rule, spot-checked on the shapes where getting it wrong is easiest.
    expect(converted.PRODUCTION_PRE_0414).toEqual([
      { from: 0, to: 0.39, result: 0 },
      { from: 0.41, to: 0.69, result: 0.5 },
      { from: 0.71, to: 0.99, result: 1 },
    ]);
    expect(converted.NEAREST_HALF).toEqual([
      { from: 0, to: 0.49, result: 0 },
      { from: 0.5, to: 0.5, result: 0.5 },
      { from: 0.51, to: 0.99, result: 1 },
    ]);
    expect(converted.THREE_DP, 'the 0.401–0.409 row covered no 2dp decimal and is dropped').toEqual([
      { from: 0.01, to: 0.4, result: 0 },
      { from: 0.41, to: 0.99, result: 1 },
    ]);
    expect(converted.COVERS_NOTHING).toEqual([]);
    expect(converted.THREE_DP_RESULTS).toEqual([
      { from: 0, to: 0.49, result: 0.25 },
      { from: 0.5, to: 0.99, result: 0.76 },
    ]);
    expect(converted.HALF_THOUSANDTH_DOWN, '0.5005 was 0.500 to the old engine').toEqual([
      { from: 0, to: 0.49, result: 0 },
      { from: 0.5, to: 0.99, result: 1 },
    ]);
    expect(converted.HALF_THOUSANDTH_UP, '0.4005 was 0.401 to the old engine').toEqual([
      { from: 0, to: 0.4, result: 0 },
      { from: 0.41, to: 0.99, result: 1 },
    ]);
    expect(converted.UNORDERED, 'row order is kept').toEqual([
      { from: 0.7, to: 0.99, result: 1 },
      { from: 0, to: 0.39, result: 0 },
      { from: 0.4, to: 0.69, result: 0.5 },
    ]);
  });

  it('keeps any other key a row carried, and touches no other column', async () => {
    const ids = await storeTables({ EXTRA: [{ from: 0, to: 1, result: 1, note: 'round up' }] });
    await runMigration();
    expect((await bandsById(ids)).EXTRA).toEqual([{ from: 0, to: 0.99, result: 1, note: 'round up' }]);
    const [row] = await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.id, ids.EXTRA));
    expect(row!.roundingMethod).toBe('custom');
  });
});

describe('§2 what 0473 leaves alone, and what it writes to the deploy log', () => {
  const MALFORMED: Record<string, unknown> = {
    JUNK: [{ from: 0, to: 'half', result: 0 }],
    EMPTY: [],
    OVERLAPPING: [
      { from: 0, to: 0.6, result: 0 },
      { from: 0.4, to: 1, result: 1 },
    ],
    INVERTED: [{ from: 0.8, to: 0.2, result: 0 }],
    OUT_OF_RANGE: [{ from: 0, to: 1.0005, result: 1 }],
    NOT_A_ROW: [[0, 1, 1]],
  };

  it('a table the old engine could never read is LEFT UNTOUCHED and named — both engines ignore it', async () => {
    const ids = await storeTables(MALFORMED);
    await runMigration();
    const after = await bandsById(ids);
    for (const [code, table] of Object.entries(MALFORMED)) {
      expect(after[code], `${code} untouched`).toEqual(table);
      expect(preR303IsWellFormedRoundingBands(table), `${code} was malformed`).toBe(false);
      expect(isWellFormedRoundingBands(table), `${code} is still malformed`).toBe(false);
      for (const v of every2dpFigure()) expect(applyRoundingBands(v, table)).toBe(preR303ApplyRoundingBands(v, table));
      expect(
        notices.some((n) => n.message.includes('left untouched') && n.message.includes(ids[code])),
        `${code} is named in the log`,
      ).toBe(true);
    }
    expect(notices.some((n) => n.severity === 'WARNING')).toBe(false);
  });

  it('THE ONE NON-PRESERVING CLASS is a WARNING: a single-point row the old rules refused and the new rules accept', async () => {
    // From = To was an `order` error before r303 (the old writer refused it), so only a hand-written row can
    // hold one. The reporter's rule "From not above To" makes it legal, so this untouched table STARTS
    // rounding. It is left alone as instructed — and shouted about rather than hidden.
    const POINT: RoundingBand[] = [
      { from: 0, to: 0.49, result: 0 },
      { from: 0.5, to: 0.5, result: 1 },
    ];
    const ids = await storeTables({ POINT });
    await runMigration();
    expect((await bandsById(ids)).POINT).toEqual(POINT);
    const warning = notices.find((n) => n.severity === 'WARNING');
    expect(warning?.message).toContain(ids.POINT);
    expect(warning?.message).toContain('WILL START ROUNDING');
    // The delta, stated: before, nothing rounded; now 10.30 → 10.00 and 10.50 → 11.00.
    expect(preR303ApplyRoundingBands(10.3, POINT)).toBe(10.3);
    expect(applyRoundingBands(10.3, POINT)).toBe(10);
    expect(applyRoundingBands(10.5, POINT)).toBe(11);
    expect(notices.find((n) => n.message.startsWith('0473 summary'))?.message).toContain(
      `1 of those accepted by the new rules [POINT (${ids.POINT})]`,
    );
  });

  it('a third-decimal RESULT on an exact half cannot be exact for every whole part: rounded half-up and named', async () => {
    // Old: round2dp(whole + 0.505) in binary float, which is 0.51 at whole 0 and 1.50 at whole 1. No 2dp
    // result reproduces both, so the conversion takes the decimal rule (half-up) and the log names the type.
    const HALF_RESULT: RoundingBand[] = [{ from: 0, to: 1, result: 0.505 }];
    const ids = await storeTables({ HALF_RESULT });
    await runMigration();
    const after = (await bandsById(ids)).HALF_RESULT;
    expect(after).toEqual([{ from: 0, to: 0.99, result: 0.51 }]);
    for (const v of every2dpFigure()) {
      expect(Math.abs(applyRoundingBands(v, after) - preR303ApplyRoundingBands(v, HALF_RESULT))).toBeLessThanOrEqual(0.0100001);
    }
    expect(notices.find((n) => n.message.startsWith('0473 summary'))?.message).toContain(
      `1 converted result(s) on an exact half-hundredth, rounded half-up [HALF_RESULT (${ids.HALF_RESULT})]`,
    );
  });

  it('prints every conversion before -> after, and one summary with the counts production will be judged by', async () => {
    const ids = await storeTables({
      ANNUAL_X: PRODUCTION,
      CGL_X: PRODUCTION,
      NOTCHED: PRODUCTION_PRE_0414,
      DROPS: [{ from: 0.001, to: 0.009, result: 1 }],
      JUNK: [{ from: 0, to: 'half', result: 0 }],
    });
    await runMigration();
    const converted = notices.filter((n) => n.message.startsWith('0473 converted'));
    expect(converted.map((n) => n.message.match(/leave_type (\S+)/)?.[1]).sort()).toEqual(['ANNUAL_X', 'CGL_X', 'DROPS', 'NOTCHED']);
    const annual = converted.find((n) => n.message.includes(ids.ANNUAL_X))!.message;
    expect(annual).toContain('[{"to": 0.4, "from": 0, "result": 0}');
    expect(annual).toContain('-> [{"to": 0.39, "from": 0.00, "result": 0.00}');
    const summary = notices.filter((n) => n.message.startsWith('0473 summary'));
    expect(summary).toHaveLength(1);
    expect(summary[0]!.message).toContain('5 leave type(s) carry a rounding table; 4 converted (10 rows in, 9 rows out, 1 dropped as covering no 2dp decimal)');
    // 0.401, 0.701 on NOTCHED and 0.001, 0.009 on DROPS.
    expect(summary[0]!.message).toContain(`4 figure(s) with more than two decimals [DROPS (${ids.DROPS}), NOTCHED (${ids.NOTCHED})]`);
    expect(summary[0]!.message).toContain(`1 malformed table(s) left untouched [JUNK (${ids.JUNK})]`);
    expect(summary[0]!.message).toContain('0 of those accepted by the new rules []');
  });

  it('a type with no table is untouched and not counted; NOT ONE LEDGER ROW is touched', async () => {
    const digest = async () =>
      (
        await owner.db
          .select({ d: sql<string>`coalesce(md5(string_agg(id::text || ':' || days::text, ',' ORDER BY id)), '')` })
          .from(schema.leaveLedger)
      )[0]!.d;
    const before = await digest();
    await owner.db.update(schema.leaveType).set({ roundingBands: null }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    await runMigration();
    const [row] = await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    expect(row!.roundingBands).toBeNull();
    expect(await digest()).toBe(before);
    expect(notices.find((n) => n.message.startsWith('0473 summary'))?.message).toContain('0 leave type(s) carry a rounding table');
  });

  it('is journaled once, at idx 473, strictly after 0472', () => {
    const journal = JSON.parse(readFileSync(resolve(here, '../db/migrations/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const mine = journal.entries.filter((e) => e.tag === MIGRATION_FILE);
    expect(mine).toEqual([expect.objectContaining({ idx: 473, when: 1781862573000 })]);
    // Another branch holds 0472 at 1781862572000: a lower `when` merged later is a silent skip.
    expect(mine[0]!.when).toBeGreaterThan(1781862572000);
  });
});

describe("§3 the reporter's table works exactly as typed", () => {
  const REPORTER: RoundingBand[] = [
    { from: 0, to: 0.24, result: 0 },
    { from: 0.25, to: 0.49, result: 0.5 },
    { from: 0.5, to: 0.74, result: 0.5 },
    { from: 0.75, to: 0.99, result: 1 },
  ];
  /** The eleven figures, and what the plan told the reporter each becomes. */
  const FIGURES: [number, number][] = [
    [0.0, 0.0],
    [0.1, 0.0],
    [0.24, 0.0],
    [0.25, 0.5],
    [0.3, 0.5],
    [0.49, 0.5],
    [0.5, 0.5],
    [0.74, 0.5],
    [0.75, 1.0],
    [0.9, 1.0],
    [0.99, 1.0],
  ];

  it('the service accepts it as typed, with no problem and no gap, and stores it exactly', async () => {
    expect(checkRoundingBands(REPORTER)).toEqual([]);
    await setLeaveTypeRules(adminCtx(b), { id: b.annualLeaveTypeId, roundingMethod: 'custom', roundingBands: REPORTER });
    const [row] = await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    expect(row!.roundingBands).toEqual(REPORTER);
    const pol = applyLeaveTypeRules({ days: 14, carryMax: 0 }, row!)!;
    for (const [fraction, want] of FIGURES) {
      for (const whole of [0, 10]) {
        const v = round2(whole + fraction);
        expect(applyRounding(v, pol.roundingMethod, pol.roundingThreshold, pol.roundingBands), `${v}`).toBe(round2(whole + want));
      }
    }
  });

  it('…and the service refuses a third decimal rather than rounding it', async () => {
    await expect(
      setLeaveTypeRules(adminCtx(b), {
        id: b.annualLeaveTypeId,
        roundingMethod: 'custom',
        roundingBands: [{ from: 0, to: 0.245, result: 0 }],
      }),
    ).rejects.toThrow(/Row 1: use at most two decimal places\./);
  });

  it('…and refuses the OLD touching style (0.00–0.50, 0.50–1.00) as an overlap, naming the row', async () => {
    const attempt = setLeaveTypeRules(adminCtx(b), {
      id: b.annualLeaveTypeId,
      roundingMethod: 'custom',
      roundingBands: [
        { from: 0, to: 0.5, result: 0 },
        { from: 0.5, to: 1, result: 1 },
      ],
    });
    await expect(attempt).rejects.toBeInstanceOf(LeaveTypeRuleError);
    await expect(attempt).rejects.toThrow(/Row 2: 0\.50 to 1\.00 overlaps 0\.00 to 0\.50 \(row 1\)/);
  });
});

describe('§4 the "every input is already 2dp" premise, checked per caller', () => {
  /**
   * applyRoundingBands is reached only through applyRounding('custom'), from five places:
   *   core/org.ts            hire grant           hireYearGrantDays(...)  — a2c and ANNUAL pro-rating round2; any
   *                                                                          other type returns the template days RAW
   *   core/leave.ts          openLeaveYear        the same hireYearGrantDays, or composed.days RAW
   *   core/leave.ts          accrueEarnedLeave    earnedToDateFor(...)     — round2 on both branches
   *   core/leave.ts          projectExpected…     a2c / earned / ANNUAL joiner round2; else `days` RAW
   *   leave-type-sub-forms   worked example       14 ÷ 12 rounded to 2dp
   * RAW is a template band's configured days, and validateServiceBands does not limit its decimals. So a
   * third decimal CAN reach the engine on the full-grant path. The engine now works every figure out to
   * 2dp before the lookup — the plan's "a figure can never fall between 0.24 and 0.25" — so for such a
   * figure the new result is the OLD engine's result for the 2dp figure, and it differs from the old
   * engine's result on the raw figure only where the 2dp tidy crosses a band edge.
   */
  const CALL_SITES: [string, RegExp, number][] = [
    ['core/org.ts', /applyRounding\(grantRaw, /g, 1],
    ['core/leave.ts', /applyRounding\((days|earnedToDate|expected), /g, 3],
    ['app/admin/leave-config/types/leave-type-sub-forms.tsx', /applyRounding\(ROUNDING_EXAMPLE_RAW, /g, 1],
  ];

  it('the callers are the ones listed above, and no other file calls the engine', () => {
    for (const [file, re, n] of CALL_SITES) {
      expect(readFileSync(resolve(here, '..', file), 'utf8').match(re)?.length, file).toBe(n);
    }
    // Every file that calls a function of that name. core/payroll*.ts is the PAY-component rounding, a
    // different function that happens to share the name (core/payroll-policy-config.ts).
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(resolve(here, '..', dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(e.name) && /\bapplyRounding(Bands)?\(/.test(readFileSync(resolve(here, '..', rel), 'utf8'))) callers.push(rel);
      }
    };
    for (const d of ['app', 'components', 'core', 'lib', 'packs', 'scripts']) walk(d);
    expect(callers.sort()).toEqual(
      [
        'app/admin/leave-config/types/leave-type-sub-forms.tsx',
        'core/leave-compute.ts',
        'core/leave.ts',
        'core/org.ts',
        'core/payroll-policy-config.ts',
        'core/payroll.ts',
      ].sort(),
    );
    expect(readFileSync(resolve(here, '../core/payroll.ts'), 'utf8')).toMatch(/import \{[^}]*applyRounding[^}]*\} from '\.\/payroll-policy-config'/);
    expect(readFileSync(resolve(here, '../core/leave.ts'), 'utf8')).toMatch(/return round2\(\(annualDays \/ totalPeriods\) \* elapsed\);/);
  });

  it('THE PREMISE GAP: a template may configure 14.397 days, and the full grant hands that figure over raw', () => {
    expect(() => validateServiceBands([{ fromYears: 0, toYears: null, days: 14.397 }])).not.toThrow();
    const composed = composeEntitlement({ floorDays: 0, templateBand: { fromYears: 0, toYears: null, days: 14.397 }, rules: null });
    expect(composed.days).toBe(14.397);
    expect(hireYearGrantDays({ days: composed.days, typeCode: 'SICK', yearCycleOverride: null, hiredOn: '2026-03-01' })).toBe(14.397);
  });

  it('for EVERY 3dp figure: new(converted) === old(the 2dp figure), and a change from old(raw) only crosses a band edge', async () => {
    const ids = await storeTables({ PRODUCTION_X: PRODUCTION });
    await runMigration();
    const converted = (await bandsById(ids)).PRODUCTION_X;
    const moved: string[] = [];
    for (const whole of WHOLE_PARTS) {
      for (let k = 0; k < 1000; k++) {
        const v = (whole * 1000 + k) / 1000;
        // The same composition the hire grant and the year-open use for a non-annual type.
        const raw = hireYearGrantDays({ days: v, typeCode: 'SICK', yearCycleOverride: null, hiredOn: '2026-03-01' });
        const now = applyRounding(raw, 'custom', null, converted);
        expect(now, `${v}`).toBe(preR303ApplyRoundingBands(round2(raw), PRODUCTION));
        const before = preR303ApplyRoundingBands(raw, PRODUCTION);
        if (now !== before) {
          moved.push(`${whole}+${k}`);
          // Only a 3dp decimal that tidies UP onto 0.40 or 0.70 moves, and it moves by exactly one band step.
          expect([395, 396, 397, 398, 399, 695, 696, 697, 698, 699], `${v}`).toContain(k);
          expect(round2(now - before), `${v}`).toBe(0.5);
        }
      }
    }
    // It is not vacuous: 14.397-style figures really do move.
    expect(moved).toContain('7+397');
    expect(applyRounding(14.397, 'custom', null, converted)).toBe(14.5);
    expect(preR303ApplyRoundingBands(14.397, PRODUCTION)).toBe(14);
  });
});
