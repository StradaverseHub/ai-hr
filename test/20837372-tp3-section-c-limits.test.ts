/**
 * Item 20837372 (r342) — SECTION C IS COUNTED TO ITS STATUTORY LIMITS, and the boxes still store whole.
 *
 * ═══ WHY THIS FILE EXISTS ═══
 *
 * The reporter contested a shipped round to say the TP3 exemption limits were not being applied. They
 * were right, and one half of it was live on their own data: their single TP3 form holds C3 = 8,979
 * against a RM4,000 EPF relief cap, and `core/payroll.ts` capped K at 4,000 while `deriveAccumulatorSeed`
 * subtracted the whole 8,979 from accumulated pay. The SAME BOX gave two answers, the employee's
 * ∑(Y−K) was recorded RM4,979 too low, and their PCB came out light.
 *
 * ═══ r350 — THE C2 HALF WAS STILL WRONG, AND THE REPORTER SAID SO FIVE TIMES ═══
 *
 * r342 made ΣC2 count to its limits and kept SUBTRACTING it from C1. r345 and r348 defended that, and
 * r348 told the reporter their contest was mistaken. All of it rested on one unread assumption: that C1
 * is gross INCLUDING the exempt allowances. It is not. The agency's own form, identically in the 2026
 * and 2023 editions:
 *
 *     C1  "…termasuk elaun / perkuisit / pemberian / Manfaat YANG DIKENAKAN CUKAI"   ← SUBJECT to tax
 *     C2  "Jumlah elaun/perkuisit/pemberian/manfaat YANG DIKECUALIKAN CUKAI"         ← EXEMPT from tax
 *
 * C1 holds only the taxable items, so the exempt money was never in it and subtracting it removed money
 * that was not there — understating ∑(Y−K), and under-deducting MTD, for every TP3 employee with a C2
 * figure. The excess ABOVE a limit IS taxable (printed page 20 item 9: "Any amount exceed the restricted
 * amount shall be taxable") and, because C1 carries only taxable pay, that excess is NOT in C1 either —
 * so it is ADDED:
 *
 *     netRemuneration = C1 + Σ max(C2ₖ − limitₖ, 0) − C3allowable
 *
 * The reporter's own two worked examples are pinned in (c) below. Five independent sources are listed on
 * core/tp3.ts `deriveAccumulatorSeed`; this file states the rule and asserts it, it does not re-argue it.
 *
 * ═══ THE LINE THIS FILE REFUSES TO CROSS ═══
 *
 * ADR-0008 — "an item with no printed cap is captured and never blocked" — governs the INPUT, and it is
 * untouched: every box still stores exactly what the operator keyed, and nothing here refuses a save.
 * Only what the ARITHMETIC may use is limited. The two are asserted separately below, because
 * collapsing them is the mistake a later reader is most likely to make.
 */
import { describe, expect, it } from 'vitest';
import { deriveAccumulatorSeed, TP3_SECTION_C } from '../core/tp3';
import { MY_RELIEFS } from '../localization/my/statutory-tables';

/** The limits the catalogue carries, named here so this file states them rather than reading the code. */
const SPEC = {
  c2i: { limit: 6_000, what: 'travel, petrol card, petrol and toll for official duties' },
  c2ii: { limit: 3_000, what: 'child-care allowance' },
  c2iv: { limit: 2_000, what: 'past-service, excellent-service, innovation and long-service awards' },
  epf: { cap: 4_000, what: 'EPF and other approved funds, per year' },
} as const;

const seedOf = (c2: Record<string, number>, c3: number, c1 = 60_000) =>
  deriveAccumulatorSeed({
    form: 'tp3-2026',
    sectionC: { c1: { amount: c1 }, c2: { amount: Object.values(c2).reduce((a, b) => a + b, 0), subItems: c2 }, c3: { amount: c3 } },
    sectionD: {},
  })!;

// ─── (a) The catalogue really does carry these limits ────────────────────────────────────────────────

describe('20837372 · (a) the limits are the catalogue’s, not this file’s', () => {
  const c2 = TP3_SECTION_C.find((l) => l.code === 'c2')!;
  const sub = (code: string) => c2.subItems.find((s) => s.code === code)!;

  it(`C2(i) ${SPEC.c2i.what} is limited to RM${SPEC.c2i.limit}`, () => {
    expect(sub('i').exemptionLimit).toBe(SPEC.c2i.limit);
  });
  it(`C2(ii) ${SPEC.c2ii.what} is limited to RM${SPEC.c2ii.limit}`, () => {
    expect(sub('ii').exemptionLimit).toBe(SPEC.c2ii.limit);
  });
  it(`C2(iv) ${SPEC.c2iv.what} is limited to RM${SPEC.c2iv.limit}`, () => {
    expect(sub('iv').exemptionLimit).toBe(SPEC.c2iv.limit);
  });
  it('C2(iii) and C2(v) carry NO sourced limit, and none is invented', () => {
    expect(sub('iii').exemptionLimit ?? null).toBeNull();
    expect(sub('v').exemptionLimit ?? null).toBeNull();
  });
  it('the EPF cap comes from the pack the kernel uses, not from a literal here', () => {
    expect(MY_RELIEFS.epfReliefCap).toBe(SPEC.epf.cap);
  });
});

// ─── (b) The EPF half — the reporter's own live row ──────────────────────────────────────────────────

describe('20837372 · (b) C3 is counted to the EPF cap, and K stops disagreeing with ∑(Y−K)', () => {
  it('the reporter’s production row: C3 8,979 counts as 4,000, and after r350 the net is 56,000', () => {
    const s = seedOf({ i: 3_600 }, 8_979);
    expect(s.epfClaimed, 'the raw box, because the form prints it').toBe(8_979);
    expect(s.epfAllowable, 'K as the specification defines it').toBe(SPEC.epf.cap);
    expect(s.netRemuneration, '60000 + 0 excess − 4000').toBe(56_000);
  });

  it('K and the figure ∑(Y−K) is struck against are THE SAME figure — asserted against each other', () => {
    const s = seedOf({ i: 1_000 }, 9_999);
    expect(s.gross + s.excessTotal - s.epfAllowable).toBeCloseTo(s.netRemuneration, 2);
  });

  it('a C3 UNDER the cap is byte-identical to before — this change moves nothing that was already right', () => {
    const s = seedOf({ i: 1_000 }, 2_500);
    expect(s.epfAllowable).toBe(2_500);
    expect(s.netRemuneration, '60000 + 0 excess − 2500 — the 1,000 is within its limit').toBe(57_500);
  });
});

// ─── (c) The C2 half — the decision that was reversed ────────────────────────────────────────────────

describe('20837372 · (c) each C2 sub-line counts to its own limit, and only the excess is ADDED', () => {
  // ⚠️ THE REPORTER'S OWN TWO EXAMPLES, VERBATIM FROM THEIR FIFTH CONTEST. They are the acceptance
  // criteria for this change and they are asserted before anything else in this block.
  it("reporter example 1 — C2(i) keyed 3,600 under a 6,000 limit: ANR is 56,000", () => {
    const s = seedOf({ i: 3_600 }, 4_000);
    expect(s.exemptTotal, 'the whole 3,600 is exempt').toBe(3_600);
    expect(s.excessTotal, 'nothing is over the limit').toBe(0);
    expect(s.netRemuneration, '60,000 + 0 − 4,000').toBe(56_000);
  });

  it("reporter example 2 — C2(i) keyed 7,000 over a 6,000 limit: ANR is 57,000", () => {
    const s = seedOf({ i: 7_000 }, 4_000);
    expect(s.exemptEntered, 'what the operator keyed').toBe(7_000);
    expect(s.exemptTotal, 'the exempt part').toBe(SPEC.c2i.limit);
    expect(s.excessTotal, 'the taxable part').toBe(1_000);
    expect(s.netRemuneration, '60,000 + 1,000 − 4,000').toBe(57_000);
  });

  it('NON-VACUITY — the old rule gives a different number, so these tests can fail', () => {
    // Guards against the assertions above passing by coincidence: had r350 not landed, ANR would be
    // gross − exemptTotal − epfAllowable. Both examples must differ from that, or they prove nothing.
    for (const keyed of [3_600, 7_000]) {
      const s = seedOf({ i: keyed }, 4_000);
      expect(s.netRemuneration, `keyed ${keyed}`).not.toBe(s.gross - s.exemptTotal - s.epfAllowable);
    }
  });

  it('every limited sub-line is held to its OWN limit, not to one shared ceiling', () => {
    const s = seedOf({ i: 9_000, ii: 9_000, iv: 9_000 }, 0);
    expect(s.exemptTotal).toBe(SPEC.c2i.limit + SPEC.c2ii.limit + SPEC.c2iv.limit);
    expect(s.excessTotal, 'each excess is against its own limit').toBe(
      9_000 - SPEC.c2i.limit + (9_000 - SPEC.c2ii.limit) + (9_000 - SPEC.c2iv.limit),
    );
  });

  it('a sub-line with NO sourced limit adds NOTHING — no limit is invented, so no excess is asserted', () => {
    const s = seedOf({ iii: 12_345, v: 6_789 }, 0);
    expect(s.exemptTotal, 'declared exempt in full, as keyed').toBe(12_345 + 6_789);
    expect(s.excessTotal, 'no limit ⇒ no excess can be PROVEN ⇒ nothing is taxed').toBe(0);
    expect(s.netRemuneration, 'so these boxes move ANR not at all').toBe(60_000);
  });

  it('sub-lines within their limits are untouched, so an ordinary form does not move', () => {
    const s = seedOf({ i: 2_400, ii: 1_200, v: 400 }, 0);
    expect(s.exemptTotal).toBe(4_000);
    expect(s.exemptEntered).toBe(4_000);
    expect(s.excessTotal).toBe(0);
    expect(s.netRemuneration, 'an ordinary form is just C1 − C3').toBe(60_000);
  });
});

// ─── (d) The line this file refuses to cross ─────────────────────────────────────────────────────────

describe('20837372 · (d) ADR-0008 survives: the INPUT is limited by nothing', () => {
  it('the seed reports what was keyed alongside what counts, so the form can print both', () => {
    const s = seedOf({ i: 7_000 }, 8_979);
    expect(s.exemptEntered, 'the keyed ΣC2 is still available in full').toBe(7_000);
    expect(s.epfClaimed, 'the keyed C3 is still available in full').toBe(8_979);
    expect(s.exemptTotal).toBeLessThan(s.exemptEntered);
    expect(s.epfAllowable).toBeLessThan(s.epfClaimed);
  });

  it('a NEGATIVE net is still returned negative — the keying-error guard survives r350', () => {
    // The guard predates this item and must survive it: a clamp would hide the error. r350 changed what
    // makes it negative. ΣC2 no longer comes off at all, so the only way now is a C3 that exceeds C1
    // plus any taxable excess — which is exactly the shape of a mis-keyed form and must still be seen.
    const s = seedOf({}, 4_000, 1_000);
    expect(s.netRemuneration, '1,000 + 0 − 4,000').toBe(-3_000);
  });

  it('a payload whose sub-lines were never stored falls back to the amount, never to a recomputed zero', () => {
    // `readGroup` writes `subItems` only where a sub-line is above zero, so a saved payload cannot carry
    // a non-zero `amount` without them — but a legacy or hand-built one can, and summing its absent keys
    // would silently erase the figure. The first cut of this change did exactly that and turned a −400
    // keying error into +500.
    const s = deriveAccumulatorSeed({
      form: 'tp3-2026',
      sectionC: { c1: { amount: 1_000 }, c2: { amount: 900 }, c3: { amount: 500 } },
      sectionD: {},
    })!;
    expect(s.exemptTotal, 'the stored amount stands').toBe(900);
    expect(s.excessTotal, 'nothing to apply a PER-SUB limit to ⇒ no excess is invented').toBe(0);
    expect(s.netRemuneration, '1,000 + 0 − 500').toBe(500);
  });
});
