/**
 * Enhance Entitlement Rounding Method to Support Custom Decimal Thresholds (feedback 9f5164d8, migration 0335).
 *
 * The request replaces three fixed choices (none / up to a whole day / down to a whole day) with a fourth,
 * configurable one: "Nearest 0.5 day", whose behaviour is decided by where the value's DECIMAL PORTION falls
 * relative to a threshold the administrator sets.
 *
 * §1 IS THE POINT OF THE FILE. This changes how many days people are credited, so the approved plan makes
 * backward compatibility a hard requirement rather than a nicety: the three existing values must produce
 * BYTE-IDENTICAL figures through the new evaluator. §1 runs them and asserts the numbers, not that a save
 * succeeded — a rounding regression is not visible in a green save.
 *
 * §2 is the new method's arithmetic, including the reporter's documented default (0.000–0.499 down,
 * 0.500–1.000 up) and the case that makes the 0.5 grid actually visible — a threshold above 0.5, where 1.60
 * lands on 1.50 instead of 2.00.
 *
 * §3 is the validation. The request lists five rules (values inside 0.000–1.000, full coverage, no overlap,
 * no gaps, From < To). Four of the five are satisfied BY CONSTRUCTION because the configuration is stored as
 * the single boundary between two complementary ranges; §3 pins that the derived ranges really do meet, and
 * that the one remaining rule — the bound on the boundary — is enforced with a NAMED error rather than an
 * opaque 23514 from the CHECK constraint.
 *
 * §4 is the round trip through the writer and the engine overlay, because a threshold the editor stores and
 * the granting engine never reads would be exactly the "saves successfully and does nothing" control that
 * r85 found and closed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { setLeaveTypeRules, LeaveTypeRuleError } from '../core/admin';
import {
  applyLeaveTypeRules,
  applyRounding,
  DEFAULT_ROUNDING_THRESHOLD,
  ENGINE_ROUNDING_METHODS,
  USER_ROUNDING_METHODS,
  resolveRoundingThreshold,
  roundingThresholdRanges,
} from '../core/leave-compute';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeAll(async () => {
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

// A spread of figures with awkward decimal parts: one month of 14 days (the reporter's own arithmetic),
// a clean half, a value just under and just over a half, and two whole days.
const SAMPLES = [1.17, 1.5, 1.49, 1.6, 2, 0, 10.9, 10.1, 19.73];

describe('§1 the three EXISTING methods are byte-identical through the new evaluator', () => {
  // These are the exact expectations b81d3c52 shipped: 'up' ceils to a whole day, 'down' floors to a whole
  // day, and anything else leaves the figure alone. If this table ever needs editing, somebody has changed
  // what every currently-configured leave type credits.
  const EXPECTED: Record<'none' | 'up' | 'down', number[]> = {
    none: [1.17, 1.5, 1.49, 1.6, 2, 0, 10.9, 10.1, 19.73],
    up: [2, 2, 2, 2, 2, 0, 11, 11, 20],
    down: [1, 1, 1, 1, 2, 0, 10, 10, 19],
  };

  for (const method of ['none', 'up', 'down'] as const) {
    it(`'${method}' produces the pre-9f5164d8 figures`, () => {
      expect(SAMPLES.map((v) => applyRounding(v, method))).toEqual(EXPECTED[method]);
    });

    it(`'${method}' ignores a stored threshold entirely`, () => {
      // The threshold column is shared with the new method. If any of the old three ever started reading it,
      // a type that had once been set to Nearest-0.5 and then switched back would silently re-price.
      for (const threshold of [0.001, 0.25, 0.75, 1]) {
        expect(SAMPLES.map((v) => applyRounding(v, method, threshold))).toEqual(EXPECTED[method]);
      }
    });
  }

  it('NULL / absent / an unknown string all still mean no rounding', () => {
    for (const m of [null, undefined, '', 'nonsense', 'nearest', 'NEAREST_HALF']) {
      expect(SAMPLES.map((v) => applyRounding(v, m as string | null | undefined))).toEqual(EXPECTED.none);
    }
  });
});

describe('§2 nearest_half — the new arithmetic', () => {
  it("the reporter's documented DEFAULT rule: 0.000-0.499 down, 0.500-1.000 up", () => {
    // No threshold configured ⇒ 0.500. 1.17 ⇒ 1.00 (decimal 0.17 is in the down range, floored to the 0.5
    // grid); 1.50 stays 1.50 (already on the grid); 1.60 ⇒ 2.00 (decimal 0.60 is in the up range).
    expect(applyRounding(1.17, 'nearest_half')).toBe(1);
    expect(applyRounding(1.5, 'nearest_half')).toBe(1.5);
    expect(applyRounding(1.6, 'nearest_half')).toBe(2);
    expect(applyRounding(1.49, 'nearest_half')).toBe(1);
    expect(applyRounding(0, 'nearest_half')).toBe(0);
    expect(applyRounding(2, 'nearest_half')).toBe(2);
  });

  it('a HIGHER threshold is what makes the half-day step visible', () => {
    // At 0.750, a decimal of 0.60 is now in the DOWN range, so 1.60 floors to the 0.5 grid — 1.50, not 2.00.
    // This is the case that distinguishes "nearest 0.5 day" from "round to a whole day", and it is the
    // behaviour a company that rounds late is asking for.
    expect(applyRounding(1.6, 'nearest_half', 0.75)).toBe(1.5);
    expect(applyRounding(1.8, 'nearest_half', 0.75)).toBe(2);
    expect(applyRounding(1.17, 'nearest_half', 0.75)).toBe(1);
  });

  it('a LOWER threshold rounds up sooner — to the next 0.5 STEP, not the next whole day', () => {
    // 1.17 with a 0.100 threshold: the decimal 0.17 is in the UP range, and the 0.5 step at or above it is
    // 0.5 — so 1.50, not 2.00. This is the assertion that distinguishes "nearest 0.5 day" from "round up",
    // and getting it wrong the other way is what a naive ceil-to-the-grid implementation does.
    expect(applyRounding(1.17, 'nearest_half', 0.1)).toBe(1.5);
    expect(applyRounding(1.05, 'nearest_half', 0.1)).toBe(1);
    // Past the half, the up step is the whole day.
    expect(applyRounding(1.62, 'nearest_half', 0.1)).toBe(2);
  });

  it('a binary-float tail does not fall into the wrong range', () => {
    // 14/12 * 6 is 6.999999999999999 in IEEE754, and 20/365*210 lands just off 11.5. Both must land where
    // an administrator reading three decimal places expects, not one grid step away.
    expect(applyRounding((14 / 12) * 6, 'nearest_half')).toBe(7);
    expect(applyRounding(0.1 + 0.2 + 1.2, 'nearest_half')).toBe(1.5);
  });

  it('a garbage or out-of-range threshold degrades to the default rather than throwing', () => {
    for (const bad of [null, undefined, NaN, Infinity, 0, -1, 2, 'abc']) {
      expect(applyRounding(1.6, 'nearest_half', bad as number)).toBe(applyRounding(1.6, 'nearest_half'));
    }
  });

  it('accepts the postgres numeric-as-string spelling', () => {
    expect(resolveRoundingThreshold('0.750')).toBe(0.75);
    expect(applyRounding(1.6, 'nearest_half', '0.750')).toBe(1.5);
  });
});

describe('§3 the validation rules, four of which hold by construction', () => {
  it('the two derived ranges cover 0.000-1.000 with no gap and no overlap, at every threshold', () => {
    for (const t of [0.001, 0.25, DEFAULT_ROUNDING_THRESHOLD, 0.499, 0.75, 1]) {
      const { down, up } = roundingThresholdRanges(t);
      expect(down.from).toBe(0); // starts at the interval's floor
      expect(up.to).toBe(1); // ends at its ceiling
      expect(down.to).toBe(up.from); // no gap AND no overlap: they meet at one point
      expect(down.from).toBeLessThan(down.to); // From < To
      expect(up.from).toBeLessThanOrEqual(up.to);
    }
  });

  it("an unset threshold derives the reporter's own default table", () => {
    const { down, up } = roundingThresholdRanges(null);
    expect(down).toEqual({ from: 0, to: 0.5 });
    expect(up).toEqual({ from: 0.5, to: 1 });
  });

  it('8fec719e — the writer no longer accepts nearest_half AT ALL, so no new threshold can be created', async () => {
    // The method was retired as a CHOICE by 8fec719e. The evaluator above still honours a stored one (that
    // is what §1/§2 assert, and it is why nothing already stored moves), but nothing may write it again —
    // a retired choice a hand-crafted POST could still save is not retired.
    const id = await annualId();
    for (const m of ['nearest_half', 'up', 'down'] as const) {
      await expect(
        setLeaveTypeRules(adminCtx(b), { id, roundingMethod: m as unknown as 'custom' }),
      ).rejects.toBeInstanceOf(LeaveTypeRuleError);
    }
  });

  it('the threshold bounds are still enforced with a NAMED error, not a raw constraint violation', async () => {
    // The column survives 8fec719e (dropping it is not reversible in a rollback and nothing asked for it),
    // so its validator survives too. It is now reachable only without a method, which is the honest shape:
    // the threshold was never the method's operand at the writer, only at the evaluator.
    const id = await annualId();
    for (const bad of [0, -0.5, 1.001, 2, Number.NaN]) {
      const attempt = setLeaveTypeRules(adminCtx(b), { id, roundingThreshold: bad });
      await expect(attempt).rejects.toBeInstanceOf(LeaveTypeRuleError);
      await expect(attempt).rejects.toMatchObject({ name: 'LeaveTypeRuleError' });
    }
  });

  it('the writer refuses more than three decimal places', async () => {
    const id = await annualId();
    await expect(setLeaveTypeRules(adminCtx(b), { id, roundingThreshold: 0.4995 })).rejects.toBeInstanceOf(
      LeaveTypeRuleError,
    );
    // …but three decimal places, including ones that are inexact in binary floating point, are accepted.
    await expect(setLeaveTypeRules(adminCtx(b), { id, roundingThreshold: 0.123 })).resolves.not.toThrow();
  });

  it('the writer still refuses a method the engine would ignore', async () => {
    const id = await annualId();
    await expect(
      // 'nearest' is the PAY-COMPONENT rounding vocabulary (core/pay-components.ts), a different domain with
      // deliberately no shared code. Storing it here would save and then do nothing.
      setLeaveTypeRules(adminCtx(b), { id, roundingMethod: 'nearest' as 'custom' }),
    ).rejects.toBeInstanceOf(LeaveTypeRuleError);
  });

  it('8fec719e — the ENGINE set and the USER set are different, and the difference is deliberate', () => {
    // The ENGINE set is what applyRounding still ACTS on. It keeps the three retired methods so a stored
    // value migration 0358 did not reach (a seed, a fixture, hand-written JSONB) keeps producing the figure
    // it always produced — retiring a choice and re-interpreting every value stored under it are different
    // changes, and only the first was asked for.
    expect([...ENGINE_ROUNDING_METHODS].sort()).toEqual(['custom', 'down', 'nearest_half', 'up']);
    expect(ENGINE_ROUNDING_METHODS).not.toContain('none');
    // The USER set is what may be WRITTEN, rendered and chosen. Exactly two, which IS the request.
    expect([...USER_ROUNDING_METHODS].sort()).toEqual(['custom', 'none']);
    for (const retired of ['up', 'down', 'nearest_half']) {
      expect(USER_ROUNDING_METHODS as readonly string[]).not.toContain(retired);
    }
  });
});

describe('§4 the round trip — 8fec719e: a STORED nearest_half still reads back and still evaluates', () => {
  /**
   * The writer can no longer create one (see §3), so the round trip is now half a round trip: a value that
   * already sits in the column — a seed, a fixture, a tenant migration 0358 has not reached — must still
   * resolve through the overlay and still produce the figure it always produced. This is the assertion
   * that makes "we retired the CHOICE, not the VALUE" true rather than merely stated.
   */
  const writeDirect = async (id: string, roundingMethod: string, roundingThreshold: string | null) =>
    owner.db
      .update(schema.leaveType)
      .set({ roundingMethod: roundingMethod as 'nearest_half', roundingThreshold })
      .where(eq(schema.leaveType.id, id));

  it('the overlay hands a stored method and threshold to the engine unchanged', async () => {
    const id = await annualId();
    await writeDirect(id, 'nearest_half', '0.750');
    const [row] = await owner.db
      .select({
        roundingMethod: schema.leaveType.roundingMethod,
        roundingThreshold: schema.leaveType.roundingThreshold,
      })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, id))
      .limit(1);
    expect(row!.roundingMethod).toBe('nearest_half');
    expect(Number(row!.roundingThreshold)).toBe(0.75);

    const pol = applyLeaveTypeRules({ days: 14, carryMax: 0 }, row!);
    expect(pol!.roundingMethod).toBe('nearest_half');
    expect(Number(pol!.roundingThreshold)).toBe(0.75);
    // And the figure the engine would credit for one earned month is the one the threshold implies.
    expect(applyRounding(14 / 12, pol!.roundingMethod, pol!.roundingThreshold)).toBe(1);
    expect(applyRounding(1.6, pol!.roundingMethod, pol!.roundingThreshold)).toBe(1.5);
  });

  it('a stored method with NO threshold falls back to the standard rule, exactly as before', async () => {
    const id = await annualId();
    await writeDirect(id, 'nearest_half', null);
    const [row] = await owner.db
      .select({
        roundingMethod: schema.leaveType.roundingMethod,
        roundingThreshold: schema.leaveType.roundingThreshold,
      })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, id))
      .limit(1);
    expect(row!.roundingMethod).toBe('nearest_half');
    expect(row!.roundingThreshold).toBeNull();
    expect(applyRounding(1.6, 'nearest_half', row!.roundingThreshold)).toBe(2);
  });

  it('a save that does not mention rounding leaves BOTH columns alone (the tri-state)', async () => {
    const id = await annualId();
    await writeDirect(id, 'nearest_half', '0.750');
    // The Carry Forward sub-step's half of the row — it never renders the rounding control.
    await setLeaveTypeRules(adminCtx(b), { id, carryForwardMax: 7, carryForwardEnabled: true });
    const [row] = await owner.db
      .select({
        roundingMethod: schema.leaveType.roundingMethod,
        roundingThreshold: schema.leaveType.roundingThreshold,
      })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, id))
      .limit(1);
    expect(row!.roundingMethod).toBe('nearest_half');
    expect(Number(row!.roundingThreshold)).toBe(0.75);
  });
});
