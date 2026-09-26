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
 * The C2 half required reversing a decision this repo had written down twice — in core/tp3.ts and in a
 * test that said "THIS ASSERTION IS THE DECISION". That comment argued capping "would tax the same
 * ringgit twice". It does not:
 *
 *     C1 57,000 (including a 7,000 travel allowance), C2(i) keyed 7,000, limit 6,000
 *       uncapped →  net 50,000  — the whole allowance escapes tax
 *       capped   →  net 51,000  — the 1,000 excess is taxed, ONCE
 *
 * C1 is gross, so the excess sits in it either way; `C1 − ΣC2` is the single place it is taxed or not.
 * Printed page 20 item 9 of the 2026 MTD specification: "Any amount exceed the restricted amount shall
 * be taxable." Not capping is what let it escape.
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
  c2ii: { limit: 3_000, what: 'parking and meal allowance' },
  c2iv: { limit: 2_000, what: 'child-care allowance' },
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
  it('the reporter’s production row: C3 8,979 counts as 4,000, so the net is 52,400 and not 47,421', () => {
    const s = seedOf({ i: 3_600 }, 8_979);
    expect(s.epfClaimed, 'the raw box, because the form prints it').toBe(8_979);
    expect(s.epfAllowable, 'K as the specification defines it').toBe(SPEC.epf.cap);
    expect(s.netRemuneration, '60000 − 3600 − 4000').toBe(52_400);
  });

  it('K and the figure ∑(Y−K) is struck against are THE SAME figure — asserted against each other', () => {
    const s = seedOf({ i: 1_000 }, 9_999);
    expect(s.gross - s.exemptTotal - s.epfAllowable).toBeCloseTo(s.netRemuneration, 2);
  });

  it('a C3 UNDER the cap is byte-identical to before — this change moves nothing that was already right', () => {
    const s = seedOf({ i: 1_000 }, 2_500);
    expect(s.epfAllowable).toBe(2_500);
    expect(s.netRemuneration, '60000 − 1000 − 2500, exactly as it always was').toBe(56_500);
  });
});

// ─── (c) The C2 half — the decision that was reversed ────────────────────────────────────────────────

describe('20837372 · (c) each C2 sub-line counts to its own limit, and the excess stays taxable', () => {
  it('C2(i) keyed at 7,000 contributes 6,000 — the worked case from the reversed comment', () => {
    const s = seedOf({ i: 7_000 }, 0, 57_000);
    expect(s.exemptEntered, 'what the operator keyed').toBe(7_000);
    expect(s.exemptTotal, 'what counts').toBe(SPEC.c2i.limit);
    expect(s.netRemuneration, 'the 1,000 excess is taxed ONCE, not subtracted again').toBe(51_000);
  });

  it('every limited sub-line is held to its OWN limit, not to one shared ceiling', () => {
    const s = seedOf({ i: 9_000, ii: 9_000, iv: 9_000 }, 0);
    expect(s.exemptTotal).toBe(SPEC.c2i.limit + SPEC.c2ii.limit + SPEC.c2iv.limit);
  });

  it('a sub-line with NO sourced limit contributes in full — no limit is invented for it', () => {
    const s = seedOf({ iii: 12_345, v: 6_789 }, 0);
    expect(s.exemptTotal).toBe(12_345 + 6_789);
  });

  it('sub-lines within their limits are untouched, so an ordinary form does not move', () => {
    const s = seedOf({ i: 2_400, ii: 1_200, v: 400 }, 0);
    expect(s.exemptTotal).toBe(4_000);
    expect(s.exemptEntered).toBe(4_000);
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

  it('a NEGATIVE net is still returned negative — capping the inputs is not clamping the result', () => {
    // The keying-error guard predates this item and must survive it: a clamp would hide the error.
    // Capping the INPUTS makes the net LARGER, so this case is built from figures that stay negative
    // even after the caps, which is the only honest way to keep the guard meaningful.
    const s = seedOf({ iii: 80_000 }, 0, 1_000);
    expect(s.netRemuneration).toBeLessThan(0);
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
    expect(s.netRemuneration).toBe(-400);
  });
});
