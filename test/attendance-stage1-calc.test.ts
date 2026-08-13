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
  roundingMode: 'none',
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

  it("a public holiday uses the band's own PH rate when one is set", () => {
    const withPh = rule({ otRows: [band({ fromMinutes: 0, toMinutes: 0, ratePattern: 'variable', rate: 1.5, phRate: 3 })] });
    expect(splitOtMinutes(120, 'holiday', withPh)).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 0, ot20: 0, ot30: 120 });
    expect(splitOtMinutes(120, 'workday', withPh)).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 120, ot20: 0, ot30: 0 });
    // An OWNER-CONFIGURED PH rate is never overridden, even when it is not the statutory 3×: Standard's
    // first band really is set to 2.00 on production, and that is the owner's number, not a mistake.
    const ph2 = rule({ otRows: [band({ fromMinutes: 0, toMinutes: 0, ratePattern: 'variable', rate: 1.5, phRate: 2 })] });
    expect(splitOtMinutes(120, 'holiday', ph2)).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 0, ot20: 120, ot30: 0 });
  });

  /**
   * 7c834696 rev 3 — THE DAY-TYPE BUCKET REGRESSION, fixed. A band has an ordinary rate and an optional PH
   * rate; it has no rest-day column at all. So before this fix, adding an OT table silently MOVED which
   * column a non-workday was reported in: a rest day and an unconfigured public holiday both fell back to
   * the band's workday multiplier (1.5 on production rule A02) and were reported in OT 1.5, while the very
   * same day on a rule with no bands lands in OT 2.0 / OT 3.0 (the no-bands leg above).
   *
   * Reporting only — pay reads ot_minutes and the statutory multipliers, never a band's rate — but the
   * first rest day worked under A02 would have been reported at the wrong rate. Production has 8 rest-day
   * rows (all 2026-06-28, all predating any banded rule) and no public-holiday rows, so nothing is
   * re-categorised until those days are recomputed, which this round does not do.
   */
  it('a NON-workday falls back to the statutory multiplier, not to the band workday rate', () => {
    const a02 = rule({
      otRows: [
        band({ fromMinutes: 1, toMinutes: 59, ratePattern: 'variable', rate: 1.5, phRate: null }),
        band({ fromMinutes: 60, toMinutes: 119, ratePattern: 'variable', rate: 1.5, phRate: null }),
      ],
    });
    // Rest day → 2.0. Was OT 1.5 before this fix.
    expect(splitOtMinutes(300, 'rest_day', a02)).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 0, ot20: 300, ot30: 0 });
    // Public holiday with no PH rate on the band → 3.0. Was OT 1.5 before this fix.
    expect(splitOtMinutes(300, 'holiday', a02)).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 0, ot20: 0, ot30: 300 });
    // A workday is untouched — this fix cannot move an ordinary day.
    expect(splitOtMinutes(59, 'workday', a02)).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 59, ot20: 0, ot30: 0 });
    // A configured PH rate still wins over the statutory fallback.
    const withPh = rule({ otRows: [band({ fromMinutes: 0, toMinutes: 0, ratePattern: 'variable', rate: 1.5, phRate: 3 })] });
    expect(splitOtMinutes(300, 'rest_day', withPh)).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 0, ot20: 300, ot30: 0 });
    // A BANDED non-workday now agrees with the same day on a rule with no bands at all — which is the
    // property that was broken, stated as an equality rather than as two hand-written numbers.
    for (const dayType of ['rest_day', 'holiday'] as DayType[]) {
      expect(splitOtMinutes(300, dayType, a02), dayType).toEqual(splitOtMinutes(300, dayType, rule()));
    }
  });

  it('a FLAT band still reports in the Flat bucket on a rest day or a holiday', () => {
    // bucketForRate ignores the multiplier for a flat band, so the statutory fallback cannot drag a flat
    // band out of the Flat column — attendance records the hours and payroll decides what they are worth.
    const flat = rule({ otRows: [band({ fromMinutes: 0, toMinutes: 0, ratePattern: 'flat', rate: 1.5 })] });
    expect(splitOtMinutes(300, 'rest_day', flat)).toEqual({ flat: 300, ot00: 0, ot10: 0, ot15: 0, ot20: 0, ot30: 0 });
    expect(splitOtMinutes(300, 'holiday', flat)).toEqual({ flat: 300, ot00: 0, ot10: 0, ot15: 0, ot20: 0, ot30: 0 });
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
    // 7c834696 rev 3: the statutory fallbacks. `phRate: null` on a holiday WAS 1.5.
    expect(rateForDay(band({ rate: 1.5, phRate: null }), 'holiday')).toBe(3);
    expect(rateForDay(band({ rate: 1.5, phRate: null }), 'rest_day')).toBe(2);
    expect(rateForDay(band({ rate: 1.5, phRate: 3 }), 'rest_day')).toBe(2);
  });
});

// ─────────────────────────── ROUNDING ───────────────────────────

describe('OT rounding is DOWNWARD — 7c834696 rev 3, and it moves two real days', () => {
  const round = (roundToMinutes: number) =>
    rule({ otRows: [band({ fromMinutes: 0, toMinutes: 0, roundingMode: 'down', roundToMinutes })] });

  it("the request's second example still holds: round-to 30 turns 121 into 120 and leaves 150 at 150", () => {
    // Unchanged by the switch from nearest to floor — floor(121/30)=4 and floor(150/30)=5 give the same
    // answers nearest did, which is why this example never distinguished the two rules.
    expect(applyOtRuleRows(121, 0, round(30))).toBe(120);
    expect(applyOtRuleRows(150, 0, round(30))).toBe(150);
  });

  it("WHAT FLOOR COSTS: an overtime shorter than the Round-To multiple is now ZERO, not a full block", () => {
    // The request's FIRST rounding example ("0:01–0:59 with Round To 60 → 60 minutes") wants rounding UP,
    // and the approved rule went the other way: rounding must never return more time than was worked.
    // 20 minutes was already 0 under nearest. 40 minutes WAS 60 and is now 0 — that is the one generic
    // expectation this change reverses, recorded here rather than deleted.
    expect(applyOtRuleRows(20, 0, round(60))).toBe(0);
    expect(applyOtRuleRows(40, 0, round(60))).toBe(0); // was 60 under round-to-nearest
    // Exactly one multiple, and one multiple plus a remainder, both keep the whole multiple.
    expect(applyOtRuleRows(60, 0, round(60))).toBe(60);
    expect(applyOtRuleRows(119, 0, round(60))).toBe(60);
  });

  /**
   * THE ROUNDING TABLE THAT EXISTS ON PRODUCTION, re-read 2026-08-11: rule "A02"
   * (id 803be8ff-55dd-4615-8602-fc9f65ef5c05 — created 2026-07-16 as A01 and RENAMED on 2026-08-05, so it
   * is the same row the older comment here called A01). BOTH rows are written out with their real
   * geometry, because the first row's rounding being OFF is half of why the defect was invisible:
   *
   *      from 1  to 59   variable 1.50   rounding OFF
   *      from 60 to 119  variable 1.50   rounding ON, round to 60
   *
   * It is NOT the tenant default (Standard is), but 8 live shifts select it (AM01, AM02, AM03, AM1, AM2,
   * SemiFlex01, Test, Test-2) as of 2026-08-05 13:42, so it decides real days — the older note here that
   * said "ZERO attendance days" was already false by the time it was read.
   *
   * WHAT THIS CHANGE MOVES, in raw minutes worked past the shift end:
   *
   *      raw minutes over |  nearest (before)  |  floor (now)
   *              1 … 59   |     unchanged      |   unchanged   (row 1 has rounding off)
   *                  60   |         60         |       60
   *             61 … 89   |         60         |       60
   *             90 … 119  |        120         |       60      ← the ONLY band that moves
   *            120 …      |     unchanged      |   unchanged   (past the table; no row matches)
   *
   * ON PRODUCTION that band is exactly two attendance days, both 2026-08-05, both on shift AM03
   * (09:00–18:00, break 60), and both currently STORED at 120:
   *
   *      Eee Lee Yong (100814)             09:00 → 19:30   raw  90   stored 120   becomes 60
   *      NURUL ALIAH BINTI ACHIN (100815)  09:00 → 19:40   raw 100   stored 120   becomes 60
   *
   * Every other overtime day on production already matches its raw minutes exactly (verified 2026-08-11
   * across all 63 days with a clock-out since 2026-08-04, and across all 14 Standard-governed OT days,
   * whose figures are 60/120/240/480 — all exact multiples of 60, so floor leaves every one of them alone).
   *
   * If anyone reverses this to round-up or back to nearest, THIS test is what fails, and its failure names
   * the exact minutes. Do not "fix" it by editing the numbers — change applyOtRuleRows and re-derive.
   */
  it("production rule A02's real two-row table: 60–119 all floor to 60, and 90/100 stop inflating", () => {
    const a02 = rule({
      otRows: [
        band({ fromMinutes: 1, toMinutes: 59, ratePattern: 'variable', rate: 1.5, roundingMode: 'none', roundToMinutes: null }),
        band({ fromMinutes: 60, toMinutes: 119, ratePattern: 'variable', rate: 1.5, roundingMode: 'down', roundToMinutes: 60 }),
      ],
    });
    // Row 1 — rounding OFF, so the exact minutes survive. These are Daniel Tan 18:29, 18:56 and Mei Ling
    // 18:59 on 2026-08-05, which were always right.
    expect(applyOtRuleRows(1, 0, a02)).toBe(1);
    expect(applyOtRuleRows(29, 0, a02)).toBe(29);
    expect(applyOtRuleRows(56, 0, a02)).toBe(56);
    expect(applyOtRuleRows(59, 0, a02)).toBe(59);
    // Row 2 — every minute inside the band now pays the band's own hour, and never more.
    expect(applyOtRuleRows(60, 0, a02)).toBe(60); // Ismail 19:00 — unchanged
    expect(applyOtRuleRows(61, 0, a02)).toBe(60);
    expect(applyOtRuleRows(89, 0, a02)).toBe(60); // unchanged: nearest already gave 60
    expect(applyOtRuleRows(90, 0, a02)).toBe(60); // Eee Lee Yong 19:30 — WAS 120, the +30 that moves
    expect(applyOtRuleRows(100, 0, a02)).toBe(60); // NURUL ALIAH 19:40 — WAS 120, the +20 that moves
    expect(applyOtRuleRows(119, 0, a02)).toBe(60); // WAS 120 — the band's ceiling can no longer be passed
    // The cliff is gone: no day inside the band pays more than a day at the top of it.
    expect(applyOtRuleRows(89, 0, a02)).toBeLessThanOrEqual(applyOtRuleRows(90, 0, a02));
    // Past the table nothing rounds at all — no row covers these, and overtime beyond the final range is
    // still counted in full (see splitOtMinutes' note on non-truncation). Farah / Elon Musk 20:00.
    expect(applyOtRuleRows(120, 0, a02)).toBe(120);
    expect(applyOtRuleRows(180, 0, a02)).toBe(180);
    expect(applyOtRuleRows(240, 0, a02)).toBe(240);
    // And zero overtime stays zero.
    expect(applyOtRuleRows(0, 0, a02)).toBe(0);
  });

  /**
   * THE OTHER RULE WITH A ROUNDING BAND — "Standard", the tenant default, which governs shift MB28 and any
   * day with no shift. Its second row is 60→480 round-to 60 (ph_rate 3.00), so floor changes it too: 150
   * was 180 and is now 120. Re-measured on production 2026-08-11, every Standard-governed day that carries
   * overtime holds 60, 120, 240 or 480 minutes — exact multiples of 60 — so the expected production diff
   * from this rule is ZERO rows. The general behaviour is pinned anyway, because "no rows today" is not a
   * property of the code.
   */
  it("the tenant-default Standard rule's 60→480 band floors too — 150 becomes 120, not 180", () => {
    const standard = rule({
      isDefault: true,
      otRows: [
        band({ fromMinutes: 1, toMinutes: 59, ratePattern: 'variable', rate: 1.5, phRate: 2, roundingMode: 'none' }),
        band({ fromMinutes: 60, toMinutes: 480, ratePattern: 'variable', rate: 1.5, phRate: 3, roundingMode: 'down', roundToMinutes: 60 }),
      ],
    });
    expect(applyOtRuleRows(150, 0, standard)).toBe(120); // was 180 under nearest
    expect(applyOtRuleRows(90, 0, standard)).toBe(60); // was 120 under nearest
    // Every figure actually stored on production against this rule — all unchanged.
    expect(applyOtRuleRows(60, 0, standard)).toBe(60);
    expect(applyOtRuleRows(120, 0, standard)).toBe(120);
    expect(applyOtRuleRows(240, 0, standard)).toBe(240);
    expect(applyOtRuleRows(480, 0, standard)).toBe(480);
  });

  it('rounding never returns more minutes than were worked, for any band geometry', () => {
    // The property the whole fix exists for, asserted directly rather than only through examples.
    for (const roundTo of [5, 10, 15, 30, 45, 60, 90, 120]) {
      const r = rule({ otRows: [band({ fromMinutes: 0, toMinutes: 0, roundingMode: 'down', roundToMinutes: roundTo })] });
      for (let ot = 0; ot <= 600; ot += 1) {
        const out = applyOtRuleRows(ot, 0, r);
        expect(out, `roundTo=${roundTo} ot=${ot}`).toBeLessThanOrEqual(ot);
        expect(out % roundTo, `roundTo=${roundTo} ot=${ot}`).toBe(0);
      }
    }
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
