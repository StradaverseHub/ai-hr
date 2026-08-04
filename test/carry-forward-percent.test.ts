/**
 * 7cd914b1 — Carry Forward Policy on EVERY leave type, plus a percentage mode.
 *
 * Two gates were removed in this item, and the risk in both directions is the same: money.
 *   - `openLeaveYear` hardcoded `t.code === 'ANNUAL'`, so nothing else could carry.
 *   - the editor posted a hidden `carryForwardMax = 0` for non-annual types on every earning save.
 *
 * The load-bearing test here is NOT the percentage — it is `carryEnabled` staying FALSE for an
 * unconfigured type. Every non-annual type in every existing database has carryForwardEnabled NULL and
 * carryForwardMax 0; if removing the ANNUAL gate let any of them start carrying, this release would
 * silently hand days to employees at the next year open, and the ledger is the record of record.
 *
 * These are unit tests over the pure resolvers deliberately: `resolveCarryAllowance` /
 * `carryAllowanceFrom` are the SINGLE definition that openLeaveYear, accrueEarnedLeave's cycle cap,
 * expireCarriedLeave and the breakdown all now call, so pinning the arithmetic here pins every engine.
 */
import { describe, expect, it } from 'vitest';
import {
  applyLeaveTypeRules,
  carryAllowanceFrom,
  carryConfigured,
  carryEnabled,
  hasAnyLeaveTypeRule,
  resolveCarryAllowance,
  type ResolvedPolicy,
} from '../core/leave-compute';

const pol = (over: Partial<ResolvedPolicy> = {}): ResolvedPolicy => ({ days: 14, carryMax: 0, ...over });

describe('7cd914b1 — nothing carries until it is configured', () => {
  it('an unconfigured type does not carry — the regression that would cost real days', () => {
    // This is the shape of EVERY non-annual leave type in every existing database.
    const unconfigured = pol({ carryMax: 0, carryForwardEnabled: undefined, carryPercent: null });
    expect(carryEnabled(unconfigured)).toBe(false);
    expect(resolveCarryAllowance(unconfigured, 20)).toBe(0);
  });

  it('carry explicitly switched off forfeits everything, even with a cap and a percentage stored', () => {
    // "None" preserves the stored cap so switching back restores it; the flag must still win.
    const off = pol({ carryMax: 10, carryPercent: null, carryForwardEnabled: false });
    expect(carryEnabled(off)).toBe(false);
    expect(resolveCarryAllowance(off, 20)).toBe(0);
  });

  it('a null policy carries nothing rather than throwing', () => {
    expect(carryEnabled(null)).toBe(false);
    expect(resolveCarryAllowance(null, 20)).toBe(0);
    expect(resolveCarryAllowance(undefined, 20)).toBe(0);
  });
});

describe('7cd914b1 — the fixed maximum still behaves exactly as it did', () => {
  it('carries up to the cap and no further', () => {
    const p = pol({ carryMax: 5, carryForwardEnabled: true });
    expect(resolveCarryAllowance(p, 20)).toBe(5);
  });

  it('never carries more than the employee actually holds', () => {
    const p = pol({ carryMax: 50, carryForwardEnabled: true });
    expect(resolveCarryAllowance(p, 3)).toBe(3);
  });

  it('a negative balance carries nothing, never a negative', () => {
    const p = pol({ carryMax: 5, carryForwardEnabled: true });
    expect(resolveCarryAllowance(p, -4)).toBe(0);
  });

  it('back-compat: a positive cap with no explicit flag still means carry is ON', () => {
    expect(carryEnabled(pol({ carryMax: 5 }))).toBe(true);
  });
});

describe('7cd914b1 — percentage of the remaining balance', () => {
  it("the reporter's own example: 20 days at 50% carries 10", () => {
    const p = pol({ carryMax: 0, carryPercent: 50 });
    expect(resolveCarryAllowance(p, 20)).toBe(10);
  });

  it('a percentage alone switches carry ON — without it the type would silently forfeit everything', () => {
    // carryEnabled's back-compat rule is `carryMax > 0`, and a percentage-only type has no cap.
    expect(carryEnabled(pol({ carryMax: 0, carryPercent: 50 }))).toBe(true);
  });

  it('fractions are NOT rounded here — half of 7 is 3.5, and rounding is the leave type\'s own step', () => {
    expect(resolveCarryAllowance(pol({ carryPercent: 50 }), 7)).toBe(3.5);
  });

  it('100% carries the whole balance; 0% is not a percentage rule at all', () => {
    expect(resolveCarryAllowance(pol({ carryPercent: 100 }), 12)).toBe(12);
    // 0 means "no percentage configured", so the cap (0 here) decides ⇒ nothing carries.
    expect(resolveCarryAllowance(pol({ carryPercent: 0, carryMax: 0 }), 12)).toBe(0);
  });
});

/**
 * 7cd914b1 rev 2 — THESE FOUR CASES NOW GUARD THE HAND-EDITED-DATA PATH ONLY.
 *
 * The editor no longer offers a cap beside a percentage (percentage mode posts carryForwardMax=0) and
 * migration 0386 cleared the rows that already held both, so a both-set row can no longer be produced
 * through the UI. The clamp stays in the engine on purpose — it is the defence against a hand-written
 * UPDATE, a restored dump, or a future writer that forgets — and these cases are what would catch its
 * removal. Do NOT delete them as "unreachable": unreachable from the editor is not unreachable from the
 * database, and a stored cap silently trimming a percentage is the exact defect this item reported.
 */
describe('7cd914b1 — percent and max are a CLAMP, not a choice', () => {
  it('the maximum is a ceiling on the percentage when both are set', () => {
    // 50% of 20 is 10, but the cap says 6.
    expect(resolveCarryAllowance(pol({ carryPercent: 50, carryMax: 6 }), 20)).toBe(6);
  });

  it('a generous cap does not inflate a small percentage', () => {
    // 10% of 20 is 2; a cap of 15 must not raise it.
    expect(resolveCarryAllowance(pol({ carryPercent: 10, carryMax: 15 }), 20)).toBe(2);
  });

  it('the smaller of the two always wins, in both orderings', () => {
    const balance = 40;
    expect(carryAllowanceFrom({ balance, carryPercent: 25, carryMax: 5 })).toBe(5); // pct 10 vs cap 5
    expect(carryAllowanceFrom({ balance, carryPercent: 10, carryMax: 20 })).toBe(4); // pct 4 vs cap 20
  });
});

describe('7cd914b1 — carryConfigured decides whether carry can expire at all', () => {
  it('a percentage-only type IS configured, so its carry gets an expiry date', () => {
    // The old test was `carryMax > 0`, which is false here — that would have left percentage carry
    // immortal, and expireCarriedLeave would have skipped it forever.
    expect(carryConfigured({ carryMax: 0, carryPercent: 50 })).toBe(true);
  });

  it('neither set means nothing could have carried', () => {
    expect(carryConfigured({ carryMax: 0, carryPercent: null })).toBe(false);
    expect(carryConfigured({ carryMax: 0, carryPercent: 0 })).toBe(false);
  });
});

describe('7cd914b1 — the rule overlay carries the percentage through', () => {
  it('a percentage alone counts as a configured rule set', () => {
    // If this returned false, applyLeaveTypeRules would fall through to the grade policy and the
    // percentage would be silently ignored — the whole-set overlay's failure mode.
    expect(hasAnyLeaveTypeRule({ carryForwardPercent: 50 })).toBe(true);
  });

  it('the overlay reads the percentage off the leave type, string or number', () => {
    // numeric columns arrive from postgres as STRINGS.
    expect(applyLeaveTypeRules(pol({ days: 14 }), { carryForwardPercent: '50.00' })?.carryPercent).toBe(50);
    expect(applyLeaveTypeRules(pol({ days: 14 }), { carryForwardPercent: 25 })?.carryPercent).toBe(25);
  });

  it('an out-of-range stored value is clamped rather than trusted', () => {
    // Three layers guard this (DB CHECK, service validator, resolver). This is the last one: a hand-written
    // UPDATE that slipped past the first two must not hand back five times the balance.
    expect(applyLeaveTypeRules(pol(), { carryForwardPercent: 500 })?.carryPercent).toBe(100);
    expect(applyLeaveTypeRules(pol(), { carryForwardPercent: -10 })?.carryPercent).toBe(0);
  });

  it('a type with no rules at all is left completely alone', () => {
    const base = pol({ carryMax: 7, carryForwardEnabled: true });
    expect(applyLeaveTypeRules(base, {})).toBe(base);
    expect(applyLeaveTypeRules(base, null)).toBe(base);
  });
});
