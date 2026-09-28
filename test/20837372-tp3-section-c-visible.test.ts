/**
 * Item 20837372 (r345) — SECTION C SHOWS THE OPERATOR THE RULE WORKING ON THEIR OWN FIGURES.
 *
 * ═══ WHY THERE IS A SECOND FILE FOR THIS ITEM ═══
 *
 * r342 made the arithmetic hold each Section C line to its statutory limit, and
 * `test/20837372-tp3-section-c-limits.test.ts` pins that. The reporter then contested the item a THIRD
 * time — and they were right to. r342's own approved plan promised "the screen will show what part of
 * it the calculation is allowed to use, beside it", and that half was never built. The capping was
 * correct and completely invisible: the form printed the amount keyed and nothing else, so the only way
 * to tell the rule was running was to do the sum by hand.
 *
 * This file pins the SURFACE. It asserts no new arithmetic — `core/tp3.ts` is untouched by r345 except
 * for exporting the EPF cap accessor — and it deliberately asserts the figures against the reporter's
 * own worked examples rather than against round numbers of our choosing.
 *
 * ═══ THE LINE THIS FILE REFUSES TO CROSS ═══
 *
 * The limits are the SPECIFICATION's, not the FORM's. `test/20837372-tp3-section-d-lp.test.ts` already
 * asserts the generated PDF never mentions `exemptionLimit`, because printing them would produce a TP3
 * that does not match the one the employee signed. That guard is re-asserted here from the other side,
 * so a later round cannot satisfy "show the limits" by putting them on the paper.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tp3LineFigures } from '../lib/tp3-line-figures';
import { deriveAccumulatorSeed, TP3_SECTION_C, tp3EpfReliefCap } from '../core/tp3';
import { MY_RELIEFS } from '../localization/my/statutory-tables';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = (p: string) => readFileSync(new URL(p, `file://${root}`), 'utf8');
const PAGE = 'app/payroll/transactions/tp3/page.tsx';

const c2sub = (code: string) => TP3_SECTION_C.find((l) => l.code === 'c2')!.subItems.find((s) => s.code === code)!;

// ─── (a) The reporter's own two worked examples, as the screen will print them ───────────────────────

describe('20837372 · (a) a capped line explains itself with the reporter’s own numbers', () => {
  it('C2(i) keyed 7,000 against a 6,000 limit: exempt 6,000, excess 1,000, remaining 0', () => {
    const limit = c2sub('i').exemptionLimit!;
    expect(limit, 'the limit is the catalogue’s, not this file’s').toBe(6_000);
    const f = tp3LineFigures(7_000, limit);
    expect(f.exempt).toBe(6_000);
    expect(f.excess, 'the part that stays taxable — their table’s MAX(amount − limit, 0)').toBe(1_000);
    expect(f.remaining).toBe(0);
  });

  it('C2(i) keyed 3,600 against the same limit: excess 0, remaining 2,400 — their first example', () => {
    const f = tp3LineFigures(3_600, c2sub('i').exemptionLimit!);
    expect(f.exempt).toBe(3_600);
    expect(f.excess).toBe(0);
    expect(f.remaining, 'a part-used limit is visible BEFORE the next figure is keyed').toBe(2_400);
  });

  it('exempt + excess is always what was keyed — the two columns cannot lose a ringgit between them', () => {
    for (const keyed of [0, 1, 3_600, 5_999, 6_000, 6_001, 7_000, 99_999]) {
      const f = tp3LineFigures(keyed, 6_000);
      expect(f.exempt! + f.excess!, `keyed ${keyed}`).toBe(keyed);
    }
  });
});

// ─── (b) The line with no sourced limit, which must assert NOTHING ───────────────────────────────────

describe('20837372 · (b) a sub-line with no printed limit shows blanks, never zeroes', () => {
  it('C2(iii) and C2(v) carry no limit, so no limit is invented for them', () => {
    expect(c2sub('iii').exemptionLimit ?? null).toBeNull();
    expect(c2sub('v').exemptionLimit ?? null).toBeNull();
  });

  it('such a line contributes whole, and its excess and remaining are NULL rather than 0', () => {
    const f = tp3LineFigures(12_345, null);
    expect(f.exempt, 'it contributes in full').toBe(12_345);
    // A 0.00 excess would assert "we checked and nothing is over". For a line with no sourced limit
    // that is a claim this repo cannot make — CLAUDE.md §8, an absent box asserts nothing.
    expect(f.excess).toBeNull();
    expect(f.remaining).toBeNull();
  });

  it('an empty box asserts nothing either — nothing keyed is not "nil is exempt"', () => {
    expect(tp3LineFigures(undefined, null).exempt).toBeNull();
    expect(tp3LineFigures(null, null).exempt).toBeNull();
  });
});

// ─── (c) C3, the largest capping on the form and the one the screen never mentioned ──────────────────

describe('20837372 · (c) C3 is held to the EPF cap, and the screen now says so', () => {
  it('the cap comes from the pack, via the SAME accessor the kernel uses — never a literal', () => {
    expect(tp3EpfReliefCap()).toBe(MY_RELIEFS.epfReliefCap);
    expect(src(PAGE), 'the page reads the accessor').toContain('tp3EpfReliefCap');
    expect(src(PAGE), 'and carries no hardcoded cap').not.toMatch(/\b4000\b|\b4_000\b/);
  });

  it('the reporter’s own row: C3 8,979 shows allowable 4,000 and excess 4,979', () => {
    const f = tp3LineFigures(8_979, tp3EpfReliefCap());
    expect(f.exempt).toBe(4_000);
    expect(f.excess).toBe(4_979);
    expect(f.remaining).toBe(0);
  });

  it('C3 has no sub-items, so it used to fall in the branch that printed an EMPTY limit cell', () => {
    // The regression this guards: C3 is a whole-line box like C1 and C5, and the old branch treated all
    // three as "not exemptions" and printed nothing. C1 and C5 genuinely carry no limit; C3 does.
    expect(TP3_SECTION_C.find((l) => l.code === 'c3')!.subItems).toHaveLength(0);
    expect(src(PAGE), 'the branch now distinguishes C3').toContain("line.code === 'c3'");
  });
});

// ─── (d) The totals are READ OFF the seed, not recomputed beside it ──────────────────────────────────

describe('20837372 · (d) the section total is the seed’s own figure', () => {
  const seed = deriveAccumulatorSeed({
    form: 'tp3-2026',
    sectionC: {
      c1: { amount: 60_000 },
      c2: { amount: 10_600, subItems: { i: 7_000, ii: 3_600 } },
      c3: { amount: 8_979 },
    },
    sectionD: {},
  })!;

  it('what the screen totals equals what the calculation struck the net against', () => {
    expect(seed.exemptTotal, 'C2(i) capped to 6,000 plus C2(ii) 3,600 under its 3,000 limit').toBe(
      6_000 + 3_000,
    );
    expect(seed.epfAllowable).toBe(4_000);
    expect(seed.excessTotal, 'C2(i) is 1,000 over and C2(ii) is 600 over').toBe(1_000 + 600);
    expect(seed.gross + seed.excessTotal - seed.epfAllowable).toBeCloseTo(seed.netRemuneration, 2);
  });

  it('the page prints the seed’s fields and does not sum the lines a second time', () => {
    const s = src(PAGE);
    for (const f of ['derived.gross', 'derived.excessTotal', 'derived.epfAllowable', 'derived.netRemuneration']) {
      expect(s, `${f} is read off the seed`).toContain(f);
    }
    // Two call sites each working the caps out is the duplicate source of truth CLAUDE.md §1 forbids —
    // and it is the exact shape of the defect this item corrects, pointing the other way.
    expect(s, 'the view never calls the kernel’s capping helper itself').not.toContain('cappedLineTotal');
  });

  it('what was keyed is still reported alongside what counts — ADR-0008 survives', () => {
    expect(seed.exemptEntered, 'the keyed ΣC2 in full').toBe(10_600);
    expect(seed.epfClaimed, 'the keyed C3 in full').toBe(8_979);
    expect(src(PAGE)).toContain('derived.exemptEntered');
  });
});

// ─── (e) The four columns exist, in both row kinds ───────────────────────────────────────────────────

describe('20837372 · (e) the screen actually carries the columns', () => {
  it('the header declares all four figure columns plus the input', () => {
    const s = src(PAGE);
    for (const k of ['tp3.colExemptionLimit', 'tp3.colTaxExempt', 'tp3.colExcess', 'tp3.colRemaining']) {
      expect(s, `${k} is a column`).toContain(k);
    }
  });

  it('every new key resolves in all six locales', async () => {
    const keys = [
      'colTaxExempt',
      'colExcess',
      'colRemaining',
      // r350 — the total block is gross PLUS the taxable excess LESS C3. `totalLessExempt` and
      // `totalExcessNote` join `totalExemptCounted` / `totalEpfCounted` / `totalCappedNote` as RETIRED
      // (see the r348 and r350 cases below).
      'totalGross',
      'totalPlusExcess',
      'totalLessEpf',
      'totalNetRemuneration',
      'totalExemptNote',
      'totalNoLimitNote',
    ];
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(src(`messages/${loc}.json`)) as Record<string, any>;
      for (const k of keys) {
        expect(m.taxRelief?.tp3?.[k], `${loc}.taxRelief.tp3.${k}`).toBeTruthy();
      }
    }
  });

  it('the note no longer claims the keyed figure is used exactly as it is', () => {
    // It said "Whatever you key is recorded and used exactly as it is; nothing is trimmed." That became
    // FALSE when r342 shipped the capping, and it contradicted the very thing this item makes visible.
    const en = JSON.parse(src('messages/en.json')) as Record<string, any>;
    const note = en.taxRelief.tp3.exemptLimitNote as string;
    expect(note, 'the input is still never trimmed, and still says so').toMatch(/never trimmed|recorded exactly/i);
    expect(note, 'but it no longer claims the whole of it is used').not.toMatch(/used exactly as it is/i);
  });
});

// ─── (f) The PRINTED form still carries no limits ────────────────────────────────────────────────────

describe('20837372 · (f) the limits reach the screen and never the paper', () => {
  it('the generated TP3 PDF still never mentions an exemption limit', () => {
    // These limits are the specification's, not the form's. A TP3 printed with a limit column would not
    // match the one the employee signed. Asserted here as well as in the section-D file, because this
    // is the round that could most plausibly have broken it.
    expect(src('app/payroll/transactions/tp3/pdf/route.ts')).not.toContain('exemptionLimit');
  });
});

// ─── (g) r350 — THE TOTAL IS THE SUM THE FORM DESCRIBES: GROSS, PLUS THE TAXABLE EXCESS, LESS C3 ────

describe('20837372 · (g) Accumulated Net Remuneration shows its own working', () => {
  /**
   * ⚠️ THIS SCREEN HAS NOW BEEN CORRECTED THREE ROUNDS RUNNING AND ONLY r350 CHANGED THE ARITHMETIC.
   *
   * r345 shipped `totalCappedNote` reading "RM {counted} counts towards Accumulated Net Remuneration"
   * where `counted` was the figure SUBTRACTED to reach it. r348 corrected the words, drew the
   * subtraction with explicit minus signs, and told the reporter their contest was mistaken — on the
   * premise that "C1 is gross with the allowance inside it". That premise was never read off the form.
   *
   * The form says otherwise, in both its 2026 and 2023 editions: C1 is "…YANG DIKENAKAN CUKAI", the
   * items SUBJECT to tax, and C2 is "…YANG DIKECUALIKAN CUKAI", the items EXEMPT from it. The exempt
   * money was never in C1, so subtracting it understated ∑(Y−K) — and under-deducted MTD — for every
   * TP3 employee. The excess above a limit is taxable and is also not in C1, so it is ADDED.
   *
   * The reporter was right at every one of their five contests. The cases below are theirs.
   */
  const seedOf = (keyed: number, c3 = 0, c1 = 60_000) =>
    deriveAccumulatorSeed({
      form: 'tp3-2026',
      sectionC: { c1: { amount: c1 }, c2: { amount: keyed, subItems: { i: keyed } }, c3: { amount: c3 } },
      sectionD: {},
    })!;

  it('the reporter’s scenario 1: keyed 3,600 under a 6,000 limit adds NOTHING to ANR', () => {
    const s = seedOf(3_600, 4_000);
    expect(s.excessTotal).toBe(0);
    expect(s.netRemuneration, 'their figure: 60,000 + 0 − 4,000').toBe(56_000);
  });

  it('the reporter’s scenario 2: keyed 7,000 adds exactly the 1,000 excess', () => {
    const s = seedOf(7_000, 4_000);
    expect(s.excessTotal).toBe(1_000);
    expect(s.netRemuneration, 'their figure: 60,000 + 1,000 − 4,000').toBe(57_000);
  });

  it('the exempt part is never subtracted — ANR never falls below C1 − C3, at any keyed value', () => {
    // The defect r350 fixes, stated as an invariant: an exempt allowance can only ever ADD to ANR
    // (when it is over its limit) or leave it alone. It can never reduce it, because it was never in C1.
    for (const k of [0, 1_000, 5_999, 6_000, 6_001, 7_000, 50_000]) {
      const s = seedOf(k, 4_000);
      expect(s.netRemuneration, `keyed ${k}`).toBeGreaterThanOrEqual(s.gross - s.epfAllowable);
    }
  });

  it('the screen renders the sum: gross, plus the taxable excess, less C3, equals ANR', () => {
    const s = src(PAGE);
    for (const k of ['tp3.totalGross', 'tp3.totalPlusExcess', 'tp3.totalLessEpf', 'tp3.totalNetRemuneration']) {
      expect(s, `${k} is a row`).toContain(k);
    }
    // The SIGNS are what make the sum unreadable backwards — and the sign on C2 is the whole item.
    expect(s, 'the excess is drawn as an addition').toContain('+ {money(derived.excessTotal)}');
    expect(s, 'C3 is still drawn as a deduction').toContain('&minus; {money(derived.epfAllowable)}');
    expect(s, 'the exempt total is no longer part of the arithmetic').not.toContain(
      '&minus; {money(derived.exemptTotal)}',
    );
  });

  it('gross + excess − epf equals the printed ANR, to the cent', () => {
    const s = seedOf(7_000, 8_979);
    expect(s.gross + s.excessTotal - s.epfAllowable).toBeCloseTo(s.netRemuneration, 2);
  });

  it('NOTHING on that screen still claims the exempt amount counts TOWARDS ANR', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const tp3 = (JSON.parse(src(`messages/${loc}.json`)) as Record<string, any>).taxRelief.tp3;
      for (const k of ['totalExemptCounted', 'totalEpfCounted', 'totalCappedNote']) {
        expect(tp3[k], `${loc}.${k} must be retired, not live`).toMatch(/^\[retired r348/);
      }
      // r350 — the subtraction itself was the defect, so the two keys that drew it are retired too.
      for (const k of ['totalLessExempt', 'totalExcessNote']) {
        expect(tp3[k], `${loc}.${k} must be retired, not live`).toMatch(/^\[retired r350/);
      }
    }
    // …and the page must not render a retired key.
    const page = src(PAGE);
    for (const k of ['totalExemptCounted', 'totalEpfCounted', 'totalCappedNote', 'totalLessExempt', 'totalExcessNote']) {
      expect(page, `the page still renders the retired ${k}`).not.toContain(`tp3.${k}`);
    }
  });

  it('the retired keys are RETIRED, not deleted — a key dropped from en alone still renders from ms', () => {
    // i18n/request.ts deep-merges each locale over English. Deleting from en.json only would leave the
    // old sentence rendering for a Malay reader, which is the worst possible half-fix here.
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const tp3 = (JSON.parse(src(`messages/${loc}.json`)) as Record<string, any>).taxRelief.tp3;
      for (const k of ['totalCappedNote', 'totalLessExempt', 'totalExcessNote']) {
        expect(Object.keys(tp3), `${loc} dropped retired ${k} instead of marking it`).toContain(k);
      }
    }
  });
});
