/**
 * Feedback 9816a5ad — "Move Benefit Scheme Entitlement Maintenance into Service Based Entitlements",
 * STEP 1 OF 3: the type-level leave RULE columns (migration 0325).
 *
 * The approved plan consolidates leave configuration into two homes — the LEAVE TYPE owns the rules, the
 * BENEFIT SCHEME owns the days — and ships in three releases with a checkpoint between each. Step 1 adds
 * the rule columns to `leave_type` and backfills them from the single distinct value each type carries
 * across all of its `leave_policy` rows. Step 2 repoints the four `core/leave.ts` call sites to read them.
 * Step 3 zeroes and disconnects `leave_policy`.
 *
 * STEP 1 IS SAFE PRECISELY BECAUSE IT IS ADDITIVE AND INERT, and that is what this file exists to prove.
 * After the migration the system must behave BYTE-IDENTICALLY: if any employee's entitlement, accrual,
 * carry-forward or rounding moves, step 2 has arrived by accident. So the four proofs here are:
 *
 *   1. THE BACKFILL IS CORRECT — every rule lands on every type, numeric spellings collapse ('5' vs '5.0'),
 *      a type with no policy rows stays untouched, and legacy JSONB garbage is read the way the DEFENSIVE
 *      runtime resolvers already read it (a stored 31-Feb, an unknown rounding method, a non-array
 *      serviceBands ⇒ NULL, i.e. "not configured", which is the answer the engine gives today).
 *
 *   2. NOTHING READS THEM YET — asserted twice over. Statically: the four call sites (openLeaveYear,
 *      accrueEarnedLeave, reprojectEntitlementForPolicy → projectExpectedEntitlement, and the a2c
 *      correction reprojectA2cEntitlement) still select from `leave_policy`, and no source file outside
 *      db/schema.ts so much as names one of the ten new columns. Behaviourally: the columns are filled with
 *      values that CONTRADICT the policy — lump instead of earned, round down instead of up, a carry cap of
 *      zero, a maximum balance of one day — and every engine still produces the policy's answer. A static
 *      check alone would miss a dynamic read; a behavioural check alone would miss a read that happens to
 *      agree. Both are needed.
 *
 *   3. ENTITLEMENT FIGURES ARE UNCHANGED — the same scenario is run three times (columns NULL, columns
 *      backfilled, columns contradicting) and the ledger comes out identical every time.
 *
 *   4. THE DISTINCTNESS ASSERTION FIRES — the migration refuses, by name, to collapse a type whose policy
 *      rows disagree about a rule, rather than silently picking one with a LIMIT 1. A database that
 *      disagrees genuinely disagrees, and a human must decide which value wins before step 2 can ship.
 *
 * The migration is re-executed FROM THE ACTUAL FILE (the 0298/0309 convention) so this file can never drift
 * from what ships. It is run inside one transaction, mirroring how drizzle-kit applies it, so a failed
 * assertion rolls the whole thing back exactly as it would on deploy.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { accrueEarnedLeave, openLeaveYear } from '../core/leave';
import {
  adminCtx,
  closeAll,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MIGRATION = resolve(root, 'db/migrations/0325_leave_type_rule_columns.sql');

/** The ten columns step 1 adds, as (drizzle field, SQL column) pairs. Single source for both greps below. */
const RULE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['accrualMethod', 'accrual_method'],
  ['carryForwardMax', 'carry_forward_max'],
  ['carryForwardEnabled', 'carry_forward_enabled'],
  ['carryForwardExpiryMode', 'carry_forward_expiry_mode'],
  ['carryForwardExpiryMonths', 'carry_forward_expiry_months'],
  ['carryForwardExpiryMonth', 'carry_forward_expiry_month'],
  ['carryForwardExpiryDay', 'carry_forward_expiry_day'],
  ['carryForwardIncludeEarned', 'carry_forward_include_earned'],
  ['roundingMethod', 'rounding_method'],
  ['maxBalanceDays', 'max_balance_days'],
];

/**
 * Re-execute migration 0325 from the ACTUAL file, statement by statement, inside ONE transaction.
 *
 * The transaction matters: drizzle-kit applies a migration transactionally, so an assertion failure must
 * leave the database exactly as it found it. Running the statements in autocommit would leave the transient
 * collapse view behind and make the "it fires" tests dependent on each other's wreckage.
 */
async function runMigration0325(): Promise<void> {
  const text = readFileSync(MIGRATION, 'utf8');
  // Guard against the file being renamed/rewritten out from under this test into something that no longer
  // asserts or backfills — either would make every expectation below vacuously green.
  expect(text).toContain('_r0325_leave_type_rule_source');
  expect(text).toContain('UPDATE "leave_type" lt');
  expect(text).toContain('[0325_leave_type_rule_columns] refusing to collapse');
  const stmts = text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  await owner.db.transaction(async (tx) => {
    for (const s of stmts) await tx.execute(sql.raw(s));
  });
}

/** Every message in a thrown error's `.cause` chain. `rejects.toThrow()` passes on the WRONG throw, so the
 *  assertion tests below match the REAL Postgres message, which Drizzle buries one or more causes deep. */
function causeMessages(err: unknown): string {
  const out: string[] = [];
  let e: unknown = err;
  for (let i = 0; i < 10 && e != null; i++) {
    const o = e as { message?: unknown; cause?: unknown };
    if (typeof o.message === 'string') out.push(o.message);
    e = o.cause;
  }
  return out.join(' | ');
}

/** Run the migration and return the full cause-chain message of the failure it is expected to raise. */
async function migrationFailure(): Promise<string> {
  try {
    await runMigration0325();
  } catch (err) {
    return causeMessages(err);
  }
  throw new Error('migration 0325 was expected to raise, but it succeeded');
}

let b: Base;

/** Insert a leave_policy row with an EXACT accrual JSONB — deliberately bypassing core/admin's write-time
 *  validation, because the rows this migration meets in the wild include seeds and hand-written ones. */
async function policy(leaveTypeId: string, accrual: Record<string, unknown>, validFrom = '2020-01-01') {
  await owner.db.insert(schema.leavePolicy).values({
    tenantId: b.tenantId,
    leaveTypeId,
    accrual,
    validFrom,
  });
}

async function leaveTypeRow(id: string) {
  const [row] = await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.id, id));
  return row;
}

/** A second leave type in the base tenant. */
async function extraType(code: string): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name: code })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** The complete rule set as stored on a leave type, normalised for comparison. */
async function storedRules(id: string) {
  const t = await leaveTypeRow(id);
  return {
    accrualMethod: t.accrualMethod,
    carryForwardMax: t.carryForwardMax == null ? null : Number(t.carryForwardMax),
    carryForwardEnabled: t.carryForwardEnabled,
    carryForwardExpiryMode: t.carryForwardExpiryMode,
    carryForwardExpiryMonths: t.carryForwardExpiryMonths,
    carryForwardExpiryMonth: t.carryForwardExpiryMonth,
    carryForwardExpiryDay: t.carryForwardExpiryDay,
    carryForwardIncludeEarned: t.carryForwardIncludeEarned,
    roundingMethod: t.roundingMethod,
    maxBalanceDays: t.maxBalanceDays == null ? null : Number(t.maxBalanceDays),
  };
}

const ALL_NULL = {
  accrualMethod: null,
  carryForwardMax: null,
  carryForwardEnabled: null,
  carryForwardExpiryMode: null,
  carryForwardExpiryMonths: null,
  carryForwardExpiryMonth: null,
  carryForwardExpiryDay: null,
  carryForwardIncludeEarned: null,
  roundingMethod: null,
  maxBalanceDays: null,
};

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('0325 — the backfill', () => {
  it('collapses every agreeing leave_policy row of a type onto the type itself', async () => {
    // The production shape: many copies of the same rule, one per (company, grade). Some copies are SILENT
    // on a key — that is not disagreement, it is absence, and the one stated value must win.
    const full = {
      annualDays: 16,
      method: 'earned_monthly',
      carryForwardMax: 5,
      carryForwardEnabled: true,
      carryForwardExpiryMode: 'date',
      carryForwardExpiryMonth: 3,
      carryForwardExpiryDay: 31,
      carryForwardIncludeEarned: true,
      roundingMethod: 'up',
      serviceBands: [{ fromYears: 0, toYears: null, days: 16, maxBalanceDays: 30 }],
    };
    await policy(b.annualLeaveTypeId, full, '2020-01-01');
    // Same rule, different numeric SPELLING (5.0 vs 5) and a different days figure — days are not a rule.
    await policy(b.annualLeaveTypeId, { ...full, annualDays: 18, carryForwardMax: 5.0 }, '2021-01-01');
    // A copy that states nothing but the days.
    await policy(b.annualLeaveTypeId, { annualDays: 20 }, '2022-01-01');

    await runMigration0325();

    expect(await storedRules(b.annualLeaveTypeId)).toEqual({
      accrualMethod: 'earned_monthly',
      carryForwardMax: 5,
      carryForwardEnabled: true,
      carryForwardExpiryMode: 'date',
      carryForwardExpiryMonths: null,
      carryForwardExpiryMonth: 3,
      carryForwardExpiryDay: 31,
      carryForwardIncludeEarned: true,
      roundingMethod: 'up',
      maxBalanceDays: 30,
    });
  });

  it('carries the months-mode carry expiry', async () => {
    await policy(b.annualLeaveTypeId, {
      annualDays: 12,
      carryForwardMax: 3,
      carryForwardEnabled: true,
      carryForwardExpiryMode: 'months',
      carryForwardExpiryMonths: 6,
    });
    await runMigration0325();
    const r = await storedRules(b.annualLeaveTypeId);
    expect(r.carryForwardExpiryMode).toBe('months');
    expect(r.carryForwardExpiryMonths).toBe(6);
    expect(r.carryForwardExpiryMonth).toBeNull();
    expect(r.carryForwardExpiryDay).toBeNull();
  });

  it('leaves a leave type with no policy rows entirely untouched', async () => {
    const orphan = await extraType(`ORPHAN_${randomUUID().slice(0, 6).toUpperCase()}`);
    await policy(b.annualLeaveTypeId, { annualDays: 16, method: 'earned_monthly' });
    await runMigration0325();
    expect(await storedRules(orphan)).toEqual(ALL_NULL);
    // ...and the type that DOES have a policy is unaffected by the orphan's presence.
    expect((await storedRules(b.annualLeaveTypeId)).accrualMethod).toBe('earned_monthly');
  });

  it('reads legacy JSONB garbage exactly as the defensive runtime resolvers read it — as absence', async () => {
    // Each of these is something core/leave-compute.ts already IGNORES today: a string where a number
    // belongs, a stored 31-February (parseCarryExpiry's own named example), a rounding method that is not
    // 'up'/'down' (resolveGradePolicy honours nothing else), a mode outside the closed pair, and a
    // serviceBands that is not an array (bandFor ignores malformed bands entirely). Carrying any of them
    // verbatim would hand step 2 a rule that step 1's system was not acting on — a behaviour change
    // smuggled in as a data move.
    await policy(b.annualLeaveTypeId, {
      annualDays: 14,
      carryForwardMax: '5',
      carryForwardEnabled: 'yes',
      carryForwardExpiryMode: 'sideways',
      carryForwardExpiryMonths: 13,
      carryForwardExpiryMonth: 2,
      carryForwardExpiryDay: 31,
      carryForwardIncludeEarned: 1,
      roundingMethod: 'nearest',
      serviceBands: 'nope',
    });
    await runMigration0325();
    const r = await storedRules(b.annualLeaveTypeId);
    expect(r).toEqual({ ...ALL_NULL, accrualMethod: null });
  });

  it("stores 'no rounding' as NULL, matching how b81d3c52 persists it", async () => {
    // A No-Rounding policy OMITS the key entirely; an explicit 'none' means the same thing. Both must land
    // as NULL, or two policies that behave identically would look like a disagreement.
    await policy(b.annualLeaveTypeId, { annualDays: 16, roundingMethod: 'none' }, '2020-01-01');
    await policy(b.annualLeaveTypeId, { annualDays: 16 }, '2021-01-01');
    await runMigration0325();
    expect((await storedRules(b.annualLeaveTypeId)).roundingMethod).toBeNull();
  });

  it('accepts a 29-February carry expiry (leap-correct, matching isValidMonthDay)', async () => {
    await policy(b.annualLeaveTypeId, {
      annualDays: 16,
      carryForwardExpiryMonth: 2,
      carryForwardExpiryDay: 29,
    });
    await runMigration0325();
    const r = await storedRules(b.annualLeaveTypeId);
    expect([r.carryForwardExpiryMonth, r.carryForwardExpiryDay]).toEqual([2, 29]);
  });

  it('collapses maxBalanceDays across every service band of every policy of the type', async () => {
    const bands = [
      { fromYears: 0, toYears: 5, days: 14, maxBalanceDays: 25 },
      { fromYears: 5, toYears: null, days: 18, maxBalanceDays: 25 },
    ];
    await policy(b.annualLeaveTypeId, { annualDays: 14, serviceBands: bands }, '2020-01-01');
    await policy(b.annualLeaveTypeId, { annualDays: 16, serviceBands: bands }, '2021-01-01');
    await runMigration0325();
    expect((await storedRules(b.annualLeaveTypeId)).maxBalanceDays).toBe(25);
  });

  it('is idempotent, and a re-run never drags an already-set rule back to what leave_policy says', async () => {
    await policy(b.annualLeaveTypeId, { annualDays: 16, method: 'earned_monthly', roundingMethod: 'up' });
    await runMigration0325();
    const first = await storedRules(b.annualLeaveTypeId);
    await runMigration0325();
    expect(await storedRules(b.annualLeaveTypeId)).toEqual(first);

    // Simulate the world AFTER step 2, where an admin can edit the rule on the type. A replay of 0325 must
    // not undo that edit — this is what the "all ten columns still NULL" guard buys.
    await owner.db
      .update(schema.leaveType)
      .set({ roundingMethod: 'down' })
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    await runMigration0325();
    expect((await storedRules(b.annualLeaveTypeId)).roundingMethod).toBe('down');
  });

  it('keeps each tenant/type separate — one type never inherits another type’s rule', async () => {
    const sick = await extraType(`SICK_${randomUUID().slice(0, 6).toUpperCase()}`);
    await policy(b.annualLeaveTypeId, { annualDays: 16, method: 'earned_monthly', roundingMethod: 'up' });
    await policy(sick, { annualDays: 14, method: 'grant_on_hire_prorated' });
    await runMigration0325();
    expect((await storedRules(b.annualLeaveTypeId)).roundingMethod).toBe('up');
    expect(await storedRules(sick)).toEqual({
      ...ALL_NULL,
      accrualMethod: 'grant_on_hire_prorated',
    });
  });
});

describe('0325 — the distinctness assertion', () => {
  // The plan's safety argument rests on a production fact: grouping leave_policy by leave type, EVERY type
  // has exactly ONE distinct value for each of these rules. The migration does not TRUST that fact, it
  // ASSERTS it — because a database that disagrees would have somebody's leave silently rewritten by
  // whichever row a LIMIT 1 happened to pick.
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, Record<string, unknown>]> = [
    ['method', { method: 'earned_monthly' }, { method: 'grant_on_hire_prorated' }],
    ['carryForwardMax', { carryForwardMax: 5 }, { carryForwardMax: 8 }],
    ['carryForwardEnabled', { carryForwardEnabled: true }, { carryForwardEnabled: false }],
    ['carryForwardExpiryMode', { carryForwardExpiryMode: 'date' }, { carryForwardExpiryMode: 'months' }],
    ['carryForwardExpiryMonths', { carryForwardExpiryMonths: 3 }, { carryForwardExpiryMonths: 6 }],
    [
      'carryForwardExpiryMonth',
      { carryForwardExpiryMonth: 3, carryForwardExpiryDay: 15 },
      { carryForwardExpiryMonth: 6, carryForwardExpiryDay: 15 },
    ],
    [
      'carryForwardExpiryDay',
      { carryForwardExpiryMonth: 3, carryForwardExpiryDay: 31 },
      { carryForwardExpiryMonth: 3, carryForwardExpiryDay: 15 },
    ],
    [
      'carryForwardIncludeEarned',
      { carryForwardIncludeEarned: true },
      { carryForwardIncludeEarned: false },
    ],
    ['roundingMethod', { roundingMethod: 'up' }, { roundingMethod: 'down' }],
    [
      'serviceBands[].maxBalanceDays',
      { serviceBands: [{ fromYears: 0, toYears: null, days: 16, maxBalanceDays: 30 }] },
      { serviceBands: [{ fromYears: 0, toYears: null, days: 16, maxBalanceDays: 40 }] },
    ],
  ];

  for (const [rule, a, c] of cases) {
    it(`refuses to collapse a type whose rows disagree about ${rule}`, async () => {
      await policy(b.annualLeaveTypeId, { annualDays: 16, ...a }, '2020-01-01');
      await policy(b.annualLeaveTypeId, { annualDays: 16, ...c }, '2021-01-01');

      // Matched on the REAL Postgres message via the cause chain, not a bare rejects.toThrow() — which
      // would pass just as happily on a typo, a missing table or a constraint violation.
      const msg = await migrationFailure();
      expect(msg).toContain('[0325_leave_type_rule_columns] refusing to collapse');
      expect(msg).toContain(`has 2 distinct values for ${rule}`);
      expect(msg).toContain('ANNUAL'); // names the offending leave type, so a human can act on it

      // ...and it refuses BEFORE writing anything: the transaction rolled back, the type is untouched.
      expect(await storedRules(b.annualLeaveTypeId)).toEqual(ALL_NULL);
    });
  }

  it('does not fire when the disagreement is only between a stated value and silence', async () => {
    await policy(b.annualLeaveTypeId, { annualDays: 16, roundingMethod: 'up' }, '2020-01-01');
    await policy(b.annualLeaveTypeId, { annualDays: 16 }, '2021-01-01');
    await policy(b.annualLeaveTypeId, { annualDays: 16, roundingMethod: 'garbage' }, '2022-01-01');
    await runMigration0325();
    expect((await storedRules(b.annualLeaveTypeId)).roundingMethod).toBe('up');
  });

  it('names EVERY offending rule at once, so one re-run surfaces the whole problem', async () => {
    await policy(b.annualLeaveTypeId, { annualDays: 16, method: 'earned_monthly', roundingMethod: 'up' }, '2020-01-01');
    await policy(b.annualLeaveTypeId, { annualDays: 16, method: 'earned_quarterly', roundingMethod: 'down' }, '2021-01-01');
    const msg = await migrationFailure();
    expect(msg).toContain('has 2 distinct values for method');
    expect(msg).toContain('has 2 distinct values for roundingMethod');
  });
});

describe('0325 — nothing reads the new columns yet (static)', () => {
  const leaveSrc = readFileSync(resolve(root, 'core/leave.ts'), 'utf8');

  /** The body of a top-level exported function in core/leave.ts, from its signature to the next one. */
  function bodyOf(name: string): string {
    const start = leaveSrc.indexOf(`export async function ${name}(`);
    const startSync = leaveSrc.indexOf(`export function ${name}(`);
    const from = start >= 0 ? start : startSync;
    expect(from, `${name} not found in core/leave.ts`).toBeGreaterThanOrEqual(0);
    const rest = leaveSrc.slice(from + 1);
    const next = rest.search(/\nexport (async )?function /);
    return next >= 0 ? rest.slice(0, next) : rest;
  }

  // The four call sites the plan names. Step 2 repoints these; until then each must still LOAD its rules
  // from leave_policy and RESOLVE them the old way — directly through resolveGradePolicy, or by handing
  // the loaded rows to the pure projectExpectedEntitlement kernel, which resolves them itself.
  it.each([
    ['openLeaveYear', 'resolveGradePolicy('],
    ['accrueEarnedLeave', 'resolveGradePolicy('],
    ['reprojectEntitlementForPolicy', 'projectExpectedEntitlement('],
    ['reprojectA2cEntitlement', 'projectExpectedEntitlement('],
  ])('%s still resolves its rules from leave_policy', (fn, resolver) => {
    const body = bodyOf(String(fn));
    expect(body, `${fn} no longer reads leave_policy`).toContain('.from(leavePolicy)');
    expect(body, `${fn} no longer resolves through ${resolver}`).toContain(String(resolver));
    // And it must not have grown a read of any step-1 column.
    for (const [field] of RULE_COLUMNS) expect(body).not.toContain(`leaveType.${field}`);
  });

  it('projectExpectedEntitlement still takes its rules from the policyRows argument', () => {
    const body = bodyOf('projectExpectedEntitlement');
    expect(body).toContain('resolveGradePolicy(policyRows');
  });

  it('no source file outside db/schema.ts names any of the ten new columns', () => {
    // A dynamic read would slip past the per-function checks above, so this sweeps the whole tree. The
    // drizzle field names are searched as PROPERTY ACCESSES on a leave-type object (`.accrualMethod`),
    // because bare names like `carryForwardMax` and `roundingMethod` are the long-standing AccrualConfig
    // JSONB keys and appear legitimately in dozens of files. The snake_case SQL names are searched bare —
    // those are unambiguous.
    const dirs = ['core', 'app', 'components', 'lib', 'packs', 'localization', 'scripts'];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(resolve(root, dir), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs)$/.test(e.name)) files.push(p);
      }
    };
    for (const d of dirs) walk(d);
    expect(files.length).toBeGreaterThan(200);

    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(resolve(root, f), 'utf8');
      for (const [field, column] of RULE_COLUMNS) {
        if (src.includes(column)) offenders.push(`${f}: ${column}`);
        if (new RegExp(`\\bleaveType\\.${field}\\b`).test(src)) offenders.push(`${f}: leaveType.${field}`);
      }
    }
    expect(offenders, `step 1 must be inert — these files reference a step-1 column:\n${offenders.join('\n')}`)
      .toEqual([]);
  });
});

describe('0325 — nothing reads the new columns yet (behavioural), and entitlement is unchanged', () => {
  /**
   * Two policies, deliberately built so that EVERY relocated rule is visible in the resulting ledger:
   *   - annualDays 15.4 with roundingMethod 'up'  ⇒ the figure is a ROUNDED one. Round DOWN gives one day
   *                                                 less, everywhere, which is exactly what the
   *                                                 contradiction below asks for.
   *   - a maxBalanceDays of 30                    ⇒ no clamp here. The contradiction's clamp of 1 would be
   *                                                 unmissable in the balance.
   *   - the method decides WHICH engine grants    ⇒ EARNED accrues through the year (accrueEarnedLeave),
   *                                                 LUMP grants up front (hire grant + openLeaveYear). Both
   *                                                 are exercised, because the contradiction swaps one for
   *                                                 the other and a single-engine test would not see it.
   */
  const EARNED_POLICY = {
    annualDays: 15.4,
    method: 'earned_monthly',
    carryForwardMax: 5,
    carryForwardEnabled: true,
    carryForwardExpiryMode: 'date',
    carryForwardExpiryMonth: 3,
    carryForwardExpiryDay: 31,
    roundingMethod: 'up',
    serviceBands: [{ fromYears: 0, toYears: null, days: 15.4, maxBalanceDays: 30 }],
  };
  const LUMP_POLICY = { ...EARNED_POLICY, method: 'grant_on_hire_prorated' };

  /** Values chosen to be LOUD if any engine ever reads them: every one contradicts the policy above. */
  const CONTRADICTION = {
    accrualMethod: 'grant_on_hire_prorated',
    carryForwardMax: '0',
    carryForwardEnabled: false,
    carryForwardExpiryMode: 'months' as const,
    carryForwardExpiryMonths: 1,
    carryForwardExpiryMonth: null,
    carryForwardExpiryDay: null,
    carryForwardIncludeEarned: false,
    roundingMethod: 'down' as const,
    maxBalanceDays: '1',
  };

  /** Hire → year-open → earned accrual, returning the figures a reporter would look at. */
  async function figures(
    accrual: Record<string, unknown>,
    prepare?: (typeId: string) => Promise<void>,
  ) {
    await policy(b.annualLeaveTypeId, accrual, '2020-01-01');
    if (prepare) await prepare(b.annualLeaveTypeId);

    const hired = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Unchanged', primaryEmail: `unchanged_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
      gradeId: null,
      grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
    });
    const afterHire = await ledgerBalance(hired.employmentId, b.annualLeaveTypeId);

    await openLeaveYear(adminCtx(b), { year: 2026 });
    const afterYearOpen = await ledgerBalance(hired.employmentId, b.annualLeaveTypeId);

    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-07-31' });
    const afterAccrual = await ledgerBalance(hired.employmentId, b.annualLeaveTypeId);

    const rows = await owner.db
      .select({ days: schema.leaveLedger.days, entryType: schema.leaveLedger.entryType })
      .from(schema.leaveLedger)
      .where(
        and(
          eq(schema.leaveLedger.employmentId, hired.employmentId),
          eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId),
        ),
      );
    return {
      afterHire,
      afterYearOpen,
      afterAccrual,
      ledger: rows.map((r) => `${r.entryType}:${Number(r.days)}`).sort(),
    };
  }

  /**
   * Run the same scenario in all three worlds and require one answer.
   *   (a) TODAY   — the columns exist but were never filled. This is the baseline the release must match.
   *   (b) AFTER   — the columns hold the type's real rules, exactly as the migration leaves production.
   *   (c) CONTRADICTED — the columns hold rules that DISAGREE with the policy. This is the load-bearing
   *       one: if any engine had started reading the type, (c) would diverge from (a) in the entry types,
   *       the day counts and the balance all at once. Agreement between (a) and (b) alone proves nothing,
   *       because a correct backfill agrees with the policy by construction.
   */
  async function inAllThreeWorlds(accrual: Record<string, unknown>) {
    const asToday = await figures(accrual);

    await resetDb();
    b = await seedBase();
    const backfilled = await figures(accrual, async () => {
      await runMigration0325();
      // ...and the backfill really did land, so this is not a vacuous comparison.
      const r = await storedRules(b.annualLeaveTypeId);
      expect(r.roundingMethod).toBe('up');
      expect(r.maxBalanceDays).toBe(30);
      expect(r.accrualMethod).toBe(accrual.method);
    });

    await resetDb();
    b = await seedBase();
    const contradicted = await figures(accrual, async (typeId) => {
      await owner.db.update(schema.leaveType).set(CONTRADICTION).where(eq(schema.leaveType.id, typeId));
      const r = await storedRules(typeId);
      expect(r.roundingMethod).toBe('down');
      expect(r.maxBalanceDays).toBe(1);
      expect(r.accrualMethod).toBe('grant_on_hire_prorated');
    });

    expect(backfilled).toEqual(asToday);
    expect(contradicted).toEqual(asToday);
    return asToday;
  }

  it('EARNED: identical figures with the columns NULL, backfilled, and contradicting the policy', async () => {
    const f = await inAllThreeWorlds(EARNED_POLICY);
    // Pinned, not merely self-consistent: 7 elapsed months of 15.4/12 = 8.98…, rounded UP to 9, granted by
    // accrueEarnedLeave and by nothing else. Rounding DOWN would give 8; the maxBalanceDays=1 clamp would
    // give 1; the lump method would have granted the whole figure at hire/year-open instead. None happens.
    expect(f).toEqual({ afterHire: 0, afterYearOpen: 0, afterAccrual: 9, ledger: ['accrual:9'] });
  });

  it('LUMP: identical figures with the columns NULL, backfilled, and contradicting the policy', async () => {
    const f = await inAllThreeWorlds(LUMP_POLICY);
    // The up-front engines, and the carry-forward rule with them:
    //   hire grant (core/org.ts)  — 15.4 rounds UP to 16.
    //   openLeaveYear 2026        — the 16 already held is CARRIED, capped at carryForwardMax 5, and the
    //                               new year's 16 is granted on top: 5 + 16 = 21.
    //   accrueEarnedLeave         — adds nothing; this type is not on an earned method.
    // Every one of those numbers moves if a rule is read off the leave type in the contradicted world: a
    // carry cap of 0 gives 16, rounding down gives 15/20, a maximum balance of 1 gives 1, and the earned
    // method would move the grant off openLeaveYear entirely. None happens.
    expect(f).toEqual({
      afterHire: 16,
      afterYearOpen: 21,
      afterAccrual: 21,
      ledger: f.ledger,
    });
    expect(f.ledger.length).toBeGreaterThan(1);
  });

  it('leaves the ledger completely alone when the migration runs over an already-granted balance', async () => {
    // The upgrade shape that matters on deploy day: the customer's balances already exist when 0325 lands.
    await policy(b.annualLeaveTypeId, EARNED_POLICY, '2020-01-01');
    const hired = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Granted', primaryEmail: `granted_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
      gradeId: null,
      grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
    });
    await openLeaveYear(adminCtx(b), { year: 2026 });
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-07-31' });

    const before = await owner.db
      .select({
        n: sql<string>`count(*)`,
        total: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)`,
      })
      .from(schema.leaveLedger);

    await runMigration0325();

    const after = await owner.db
      .select({
        n: sql<string>`count(*)`,
        total: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)`,
      })
      .from(schema.leaveLedger);

    expect(after).toEqual(before);
    expect(await ledgerBalance(hired.employmentId, b.annualLeaveTypeId)).toBeGreaterThan(0);
  });
});
