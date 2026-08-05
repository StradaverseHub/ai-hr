/**
 * 7c834696 stage 1 — the PURE calculation layer, and the release gate for the whole item.
 *
 * THE RELEASE GATE, in the approved plan's own words: "a rule with no bands and deductions off must leave
 * every existing derived figure byte-identical". The first describe block below is that gate, and it is
 * written the only way such a claim is worth anything — by keeping a VERBATIM COPY of the pre-7c834696
 * read-time routing in this file and asserting the new code agrees with it across a matrix, rather than by
 * re-stating today's expected numbers by hand (which would only prove the new code agrees with what I
 * believed today's numbers were).
 *
 * 7c834696 rev 2 narrowed the gate for ONE column and one column only: OT 1.0 no longer carries normal
 * working hours, which is the display fault the reporter raised. The gate now asserts that the difference
 * from the old routing is exactly `worked − ot` in ot10 and zero everywhere else — a stricter statement
 * than "identical" would have been for the other five columns, and the reason it was narrowed instead of
 * deleted. STORED figures are untouched by that change; nothing below writes anything.
 *
 * No DB, no fixtures, no clock: every function under test is total in its arguments.
 */
import { describe, expect, it } from 'vitest';
import {
  bucketForRate,
  deductionMinutes,
  deductionsApplyOn,
  earlyOutMinutes,
  emptyOtSplit,
  latenessMinutes,
  otSplitTotal,
  rateForDay,
  splitOtMinutes,
} from '../core/attendance-calc';
import { applyOtRuleRows, type ResolvedAttendanceRule, type ResolvedOtRow } from '../core/attendance-rule';
import { otByRate } from '../core/attendance-derive';
import type { DayType } from '../core/attendance';

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────
const band = (over: Partial<ResolvedOtRow> = {}): ResolvedOtRow => ({
  fromMinutes: 0,
  toMinutes: 0,
  ratePattern: 'flat',
  rate: 1.5,
  phRate: null,
  rounding: false,
  roundToMinutes: null,
  ...over,
});
const rule = (over: Partial<ResolvedAttendanceRule> = {}): ResolvedAttendanceRule => ({
  id: 'r',
  isDefault: false,
  lateGracePeriodMinutes: 0,
  earlyGracePeriodMinutes: 0,
  applyToEarlyOt: false,
  lateAfterMinutes: 0,
  lateDeductMinutes: 0,
  includeGraceInLateness: false,
  earlyAfterMinutes: 0,
  earlyDeductMinutes: 0,
  includeGraceInEarlyOut: false,
  applyDeductions: false,
  deductionsEffectiveFrom: null,
  otRows: [],
  ...over,
});

// ─────────────────────────── THE RELEASE GATE ───────────────────────────

/**
 * core/attendance-derive.ts otByRate EXACTLY as it stood before 7c834696, pasted rather than imported.
 * If someone changes the shipped function, this copy does not move with it and the gate below fails —
 * which is the entire point of pasting it.
 */
function otByRate_beforeStage1(row: { worked: number | null; ot: number | null; dayType: DayType | null }) {
  const worked = row.worked ?? 0;
  const ot = Math.max(0, Math.min(row.ot ?? 0, worked));
  const normal = Math.max(0, worked - ot);
  const bucket = { ot10: normal, ot15: 0, ot20: 0, ot30: 0 };
  if (ot > 0) {
    if (row.dayType === 'holiday') bucket.ot30 = ot;
    else if (row.dayType === 'rest_day') bucket.ot20 = ot;
    else bucket.ot15 = ot;
  }
  return bucket;
}

/**
 * 7c834696 rev 2 point 1 MOVED one column on purpose, so the gate below is narrowed rather than deleted —
 * a gate that is simply removed the first time it fires proves nothing about the release after it.
 *
 * What the reporter asked for: OT 1.0 must stop showing normal working hours. What that permits to change
 * is therefore EXACTLY the `worked − ot` component the old routing added into ot10, and nothing else. So
 * the gate keeps the verbatim pre-stage-1 copy and the full matrix, and asserts three things per row:
 *   1. the PREMIUM columns (1.5 / 2.0 / 3.0) are still byte-identical to the old routing,
 *   2. `flat` and `ot00` are still empty for a no-bands rule,
 *   3. ot10 differs from the old value by precisely the normal-hours component — no more, no less.
 * (3) is what makes this a gate: any other drift in ot10, in either direction, fails it.
 */
const normalOf = (m: { worked: number | null; ot: number | null }) => {
  const worked = m.worked ?? 0;
  return Math.max(0, worked - Math.max(0, Math.min(m.ot ?? 0, worked)));
};

describe('RELEASE GATE — no bands + deductions off moves NOTHING except normal hours out of OT 1.0', () => {
  // A matrix that covers every branch the old routing had: each day type, no OT, some OT, all-OT, and the
  // pathological OT-exceeds-worked row a correction can produce.
  const MATRIX: { worked: number | null; ot: number | null; dayType: DayType | null }[] = [];
  for (const dayType of ['workday', 'rest_day', 'holiday', null] as (DayType | null)[]) {
    for (const [worked, ot] of [
      [480, 0],
      [540, 60],
      [300, 300],
      [615, 135],
      [240, 480], // OT > worked — only reachable via an approved-OT override
      [0, 0],
      [null, null],
    ] as [number | null, number | null][]) {
      MATRIX.push({ worked, ot, dayType });
    }
  }

  it('the stored split written by a no-bands rule keeps the OLD premium routing, minus the normal hours', () => {
    for (const m of MATRIX) {
      const split = splitOtMinutes(m.ot, m.dayType ?? 'workday', rule()); // no bands
      const now = otByRate({
        workedMinutes: m.worked,
        otMinutes: m.ot,
        dayType: m.dayType,
        otFlatMinutes: split.flat,
        ot00Minutes: split.ot00,
        ot10Minutes: split.ot10,
        ot15Minutes: split.ot15,
        ot20Minutes: split.ot20,
        ot30Minutes: split.ot30,
      });
      const before = otByRate_beforeStage1(m);
      expect({ ot15: now.ot15, ot20: now.ot20, ot30: now.ot30 }, JSON.stringify(m)).toEqual({
        ot15: before.ot15,
        ot20: before.ot20,
        ot30: before.ot30,
      });
      // The whole of the difference, and the only difference: the normal-within-schedule hours.
      expect(now.ot10, JSON.stringify(m)).toBe(before.ot10 - normalOf(m));
      // The two NEW columns are empty, so nothing appears on screen that was not there before.
      expect(now.flat, JSON.stringify(m)).toBe(0);
      expect(now.ot00, JSON.stringify(m)).toBe(0);
    }
  });

  it('a row with NO stored split at all behaves identically — the fallback moved the same one thing', () => {
    for (const m of MATRIX) {
      const now = otByRate({ workedMinutes: m.worked, otMinutes: m.ot, dayType: m.dayType });
      const before = otByRate_beforeStage1(m);
      expect({ ot15: now.ot15, ot20: now.ot20, ot30: now.ot30 }, JSON.stringify(m)).toEqual({
        ot15: before.ot15,
        ot20: before.ot20,
        ot30: before.ot30,
      });
      expect(now.ot10, JSON.stringify(m)).toBe(before.ot10 - normalOf(m));
      expect(now.flat + now.ot00, JSON.stringify(m)).toBe(0);
    }
  });

  it('the columns now sum to the day OVERTIME, and Actual Working Hours carries the worked total', () => {
    for (const m of MATRIX) {
      const split = splitOtMinutes(m.ot, m.dayType ?? 'workday', rule());
      const now = otByRate({
        workedMinutes: m.worked,
        otMinutes: m.ot,
        dayType: m.dayType,
        otFlatMinutes: split.flat,
        ot00Minutes: split.ot00,
        ot10Minutes: split.ot10,
        ot15Minutes: split.ot15,
        ot20Minutes: split.ot20,
        ot30Minutes: split.ot30,
      });
      const worked = m.worked ?? 0;
      // OT is clamped to worked: an approved-OT override cannot make the columns exceed the day.
      expect(now.flat + now.ot00 + now.ot10 + now.ot15 + now.ot20 + now.ot30, JSON.stringify(m)).toBe(
        Math.max(0, Math.min(m.ot ?? 0, worked)),
      );
    }
  });

  it('a no-bands rule leaves ot_minutes itself untouched (rounding is the only thing bands ever did)', () => {
    for (const ot of [0, 1, 29, 70, 121, 150, 480]) {
      expect(applyOtRuleRows(ot, 0, rule())).toBe(ot);
      expect(applyOtRuleRows(ot, 0, null)).toBe(ot);
    }
  });

  it('deductions are zero for every rule shipped in this release (the switch defaults OFF)', () => {
    const shipped = rule({ lateAfterMinutes: 15, lateDeductMinutes: 30, earlyAfterMinutes: 15, earlyDeductMinutes: 30 });
    expect(shipped.applyDeductions).toBe(false);
    expect(deductionsApplyOn(shipped, '2026-08-05')).toBe(false);
    expect(deductionsApplyOn(null, '2026-08-05')).toBe(false);
  });
});

// ─────────────────────────── THE ot_minutes INVARIANT ───────────────────────────

describe('ot_minutes stays the canonical total — the buckets only redistribute it', () => {
  const LADDERS: ResolvedOtRow[][] = [
    [],
    [band({ fromMinutes: 0, toMinutes: 0 })], // single open-ended band
    [band({ fromMinutes: 0, toMinutes: 120, ratePattern: 'variable', rate: 1.5 }), band({ fromMinutes: 121, toMinutes: 180, ratePattern: 'variable', rate: 2 })],
    [
      band({ fromMinutes: 0, toMinutes: 60, ratePattern: 'variable', rate: 0 }),
      band({ fromMinutes: 61, toMinutes: 120, ratePattern: 'variable', rate: 1 }),
      band({ fromMinutes: 121, toMinutes: 0, ratePattern: 'variable', rate: 3 }), // open-ended tail
    ],
    [band({ fromMinutes: 30, toMinutes: 90 })], // legacy table that does not start at 0
  ];

  it('every bucket set sums to exactly the minutes it was given, for every ladder and day type', () => {
    for (const otRows of LADDERS) {
      for (const dayType of ['workday', 'rest_day', 'holiday'] as DayType[]) {
        for (const total of [0, 1, 59, 60, 119, 120, 121, 180, 181, 600]) {
          const split = splitOtMinutes(total, dayType, rule({ otRows }));
          expect(otSplitTotal(split), `${dayType} ${total} ${JSON.stringify(otRows.length)}`).toBe(total);
        }
      }
    }
  });

  it('negative / null overtime cannot leak a negative bucket', () => {
    expect(splitOtMinutes(null, 'workday', rule())).toEqual(emptyOtSplit());
    expect(splitOtMinutes(-40, 'workday', rule())).toEqual(emptyOtSplit());
  });
});

// ─────────────────────────── PROGRESSIVE CATEGORISATION ───────────────────────────

describe('splitOtMinutes — progressive bands', () => {
  const progressive = rule({
    otRows: [
      band({ fromMinutes: 0, toMinutes: 120, ratePattern: 'variable', rate: 1.5 }),
      band({ fromMinutes: 121, toMinutes: 180, ratePattern: 'variable', rate: 2.0 }),
    ],
  });

  it("the request's worked example: 3 hours under 0–2h@1.5 then 2–3h@2.0 splits 2h + 1h", () => {
    expect(splitOtMinutes(180, 'workday', progressive)).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 120, ot20: 60, ot30: 0 });
  });

  it('a partial first band stays entirely in the first band', () => {
    expect(splitOtMinutes(45, 'workday', progressive)).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 45, ot20: 0, ot30: 0 });
  });

  it('exactly the first band boundary does not spill into the second', () => {
    expect(splitOtMinutes(120, 'workday', progressive)).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 120, ot20: 0, ot30: 0 });
  });

  it('minutes past the LAST band keep the last band rate — deliberately not dropped (see the module note)', () => {
    // The request says overtime beyond the final range "shall not be counted"; doing that would cut
    // ot_minutes, i.e. pay, so it is a separate opt-in. What must NOT happen is minutes vanishing here.
    const s = splitOtMinutes(240, 'workday', progressive);
    expect(s).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 120, ot20: 120, ot30: 0 });
    expect(otSplitTotal(s)).toBe(240);
  });

  it('a FLAT band lands in the Flat bucket whatever its numeric rate says', () => {
    const flat = rule({ otRows: [band({ fromMinutes: 0, toMinutes: 0, ratePattern: 'flat', rate: 1.5 })] });
    expect(splitOtMinutes(90, 'workday', flat)).toEqual({ flat: 90, ot00: 0, ot10: 0, ot15: 0, ot20: 0, ot30: 0 });
  });

  it('a rate of 0 is RECORDED as unpaid overtime rather than discarded', () => {
    const unpaid = rule({
      otRows: [
        band({ fromMinutes: 0, toMinutes: 30, ratePattern: 'variable', rate: 0 }),
        band({ fromMinutes: 31, toMinutes: 0, ratePattern: 'variable', rate: 1.5 }),
      ],
    });
    const s = splitOtMinutes(90, 'workday', unpaid);
    expect(s).toEqual({ flat: 0, ot00: 30, ot10: 0, ot15: 60, ot20: 0, ot30: 0 });
    expect(otSplitTotal(s)).toBe(90);
  });

  it('a public holiday uses the band PH rate when one is set, and the ordinary rate when it is not', () => {
    const withPh = rule({ otRows: [band({ fromMinutes: 0, toMinutes: 0, ratePattern: 'variable', rate: 1.5, phRate: 3 })] });
    expect(splitOtMinutes(120, 'holiday', withPh)).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 0, ot20: 0, ot30: 120 });
    expect(splitOtMinutes(120, 'workday', withPh)).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 120, ot20: 0, ot30: 0 });

    const noPh = rule({ otRows: [band({ fromMinutes: 0, toMinutes: 0, ratePattern: 'variable', rate: 1.5 })] });
    expect(splitOtMinutes(120, 'holiday', noPh)).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 120, ot20: 0, ot30: 0 });
  });

  it('a rest day uses the working-day rate and starts from the first worked minute (request §9)', () => {
    const withPh = rule({ otRows: [band({ fromMinutes: 0, toMinutes: 0, ratePattern: 'variable', rate: 1.5, phRate: 3 })] });
    expect(splitOtMinutes(300, 'rest_day', withPh)).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 300, ot20: 0, ot30: 0 });
  });

  it('bucketForRate / rateForDay pin the mapping the split depends on', () => {
    expect(bucketForRate('flat', 1.5)).toBe('flat');
    expect(bucketForRate('variable', 0)).toBe('ot00');
    expect(bucketForRate('variable', 1)).toBe('ot10');
    expect(bucketForRate('variable', 1.5)).toBe('ot15');
    expect(bucketForRate('variable', 2)).toBe('ot20');
    expect(bucketForRate('variable', 3)).toBe('ot30');
    // A multiplier no editor offers still has to land somewhere, or the sum invariant breaks.
    expect(bucketForRate('variable', 2.75)).toBe('flat');
    expect(rateForDay(band({ rate: 1.5, phRate: 3 }), 'holiday')).toBe(3);
    expect(rateForDay(band({ rate: 1.5, phRate: 3 }), 'workday')).toBe(1.5);
    expect(rateForDay(band({ rate: 1.5, phRate: null }), 'holiday')).toBe(1.5);
  });
});

// ─────────────────────────── ROUNDING ───────────────────────────

describe('OT rounding — unchanged, and the request example it does NOT satisfy', () => {
  const round = (roundToMinutes: number) =>
    rule({ otRows: [band({ fromMinutes: 0, toMinutes: 0, rounding: true, roundToMinutes })] });

  it("the request's second example holds today: round-to 30 turns 121 into 120 and leaves 150 at 150", () => {
    expect(applyOtRuleRows(121, 0, round(30))).toBe(120);
    expect(applyOtRuleRows(150, 0, round(30))).toBe(150);
  });

  it('CONFLICT, pinned deliberately: round-to 60 sends a short overtime to ZERO, not to 60', () => {
    // The request's FIRST rounding example says "0:01–0:59 with Round To 60 → 60 minutes", which needs
    // rounding up. Its SECOND example (121 → 120) needs rounding to nearest. No single rule satisfies both.
    // Rounding decides ot_minutes, which payroll pays from, so it is NOT changed on a guess — this test
    // records what the product does today so the change, when the owner picks a rule, cannot be silent.
    expect(applyOtRuleRows(20, 0, round(60))).toBe(0);
    expect(applyOtRuleRows(40, 0, round(60))).toBe(60);
  });

  /**
   * THE ONE ROUNDING BAND THAT EXISTS ON PRODUCTION, counted 2026-08-05: rule "A01", from 61 minutes to
   * 119 minutes, round to 60. Written out with its real geometry — not a stand-in — because the generic
   * case above cannot tell the owner what THEIR data does, and this band is the entire live exposure to
   * the request's self-contradictory rounding examples.
   *
   * The band decides ZERO attendance days today (A01 is not the tenant default and no shift selects it),
   * so this release moves nothing. It becomes live money the moment someone assigns A01 to a shift, and
   * the difference is an hour of overtime per occurrence:
   *
   *      minutes worked over |  nearest (ships today)  |  round-up (the request's other example)
   *              61 … 89     |          60             |            120
   *              90 … 119    |         120             |            120
   *
   * If the owner picks round-up, THIS test is what fails, and its failure names the exact minutes that
   * change. Do not "fix" it by editing the numbers — change applyOtRuleRows and re-derive the table.
   */
  it("production rule A01's real band (61→119, round-to 60): 61–89 round DOWN to 60 today", () => {
    const a01 = rule({
      otRows: [band({ fromMinutes: 61, toMinutes: 119, rounding: true, roundToMinutes: 60 })],
    });
    expect(applyOtRuleRows(61, 0, a01)).toBe(60);
    expect(applyOtRuleRows(75, 0, a01)).toBe(60);
    expect(applyOtRuleRows(89, 0, a01)).toBe(60);
    // The halfway point tips upward — Math.round(1.5) is 2 — so the band is not uniformly downward.
    expect(applyOtRuleRows(90, 0, a01)).toBe(120);
    expect(applyOtRuleRows(119, 0, a01)).toBe(120);
    // Outside the band nothing rounds at all: the table has no row covering these, and overtime past the
    // last configured range is still counted in full (see splitOtMinutes' note on non-truncation).
    expect(applyOtRuleRows(30, 0, a01)).toBe(30);
    expect(applyOtRuleRows(60, 0, a01)).toBe(60);
    expect(applyOtRuleRows(120, 0, a01)).toBe(120);
    expect(applyOtRuleRows(130, 0, a01)).toBe(130);
  });
});

// ─────────────────────────── LATENESS / EARLY OUT / DEDUCTIONS ───────────────────────────

describe('latenessMinutes — grace, and where the count starts', () => {
  const S = 9 * 60; // 09:00
  it('arriving inside the grace window is not late at all', () => {
    expect(latenessMinutes({ checkInAbs: S + 10, startAbs: S, graceMinutes: 15, includeGrace: false })).toBe(0);
    expect(latenessMinutes({ checkInAbs: S + 15, startAbs: S, graceMinutes: 15, includeGrace: false })).toBe(0);
  });
  it('past the grace window, "include grace" counts from the shift start; otherwise from the grace end', () => {
    expect(latenessMinutes({ checkInAbs: S + 25, startAbs: S, graceMinutes: 15, includeGrace: false })).toBe(10);
    expect(latenessMinutes({ checkInAbs: S + 25, startAbs: S, graceMinutes: 15, includeGrace: true })).toBe(25);
  });
  it('no grace configured measures from the shift start', () => {
    expect(latenessMinutes({ checkInAbs: S + 5, startAbs: S, graceMinutes: 0, includeGrace: false })).toBe(5);
  });
  it('an early arrival is never negative', () => {
    expect(latenessMinutes({ checkInAbs: S - 40, startAbs: S, graceMinutes: 15, includeGrace: true })).toBe(0);
  });
});

describe('earlyOutMinutes — the mirror image against the shift end', () => {
  const E = 18 * 60; // 18:00
  it('leaving inside the grace window is not early out', () => {
    expect(earlyOutMinutes({ checkOutAbs: E - 5, endAbs: E, graceMinutes: 10, includeGrace: false })).toBe(0);
  });
  it('past the grace window, include-grace counts from the shift end', () => {
    expect(earlyOutMinutes({ checkOutAbs: E - 30, endAbs: E, graceMinutes: 10, includeGrace: false })).toBe(20);
    expect(earlyOutMinutes({ checkOutAbs: E - 30, endAbs: E, graceMinutes: 10, includeGrace: true })).toBe(30);
  });
  it('staying late is never negative', () => {
    expect(earlyOutMinutes({ checkOutAbs: E + 90, endAbs: E, graceMinutes: 0, includeGrace: true })).toBe(0);
  });
});

describe('deductionMinutes — whole blocks, no ceiling', () => {
  it('deducts one block per completed interval, flooring the remainder', () => {
    expect(deductionMinutes(25, 15, 30)).toBe(30); // one whole block, not 50
    expect(deductionMinutes(30, 15, 30)).toBe(60);
    expect(deductionMinutes(14, 15, 30)).toBe(0);
  });
  it('has no maximum, as the request specifies', () => {
    expect(deductionMinutes(600, 15, 30)).toBe(1200);
  });
  it('an unset half of the pair deducts nothing', () => {
    expect(deductionMinutes(60, 0, 30)).toBe(0);
    expect(deductionMinutes(60, 15, 0)).toBe(0);
    expect(deductionMinutes(0, 15, 30)).toBe(0);
  });
});

describe('deductionsApplyOn — the forward-dating gate on the only downward figure', () => {
  const on = (from: string | null) => rule({ applyDeductions: true, deductionsEffectiveFrom: from });
  it('a switched-OFF rule never deducts, whatever date it is asked about', () => {
    expect(deductionsApplyOn(rule({ deductionsEffectiveFrom: '2020-01-01' }), '2026-08-05')).toBe(false);
  });
  it('switched on with no start date never deducts (the DB CHECK makes this unrepresentable anyway)', () => {
    expect(deductionsApplyOn(on(null), '2026-08-05')).toBe(false);
  });
  it('a day BEFORE the switch-on date never deducts — closed periods cannot be reopened', () => {
    expect(deductionsApplyOn(on('2026-08-05'), '2026-08-04')).toBe(false);
    expect(deductionsApplyOn(on('2026-08-05'), '2026-07-31')).toBe(false);
  });
  it('the switch-on date itself, and every day after it, does deduct', () => {
    expect(deductionsApplyOn(on('2026-08-05'), '2026-08-05')).toBe(true);
    expect(deductionsApplyOn(on('2026-08-05'), '2026-12-31')).toBe(true);
  });
});
