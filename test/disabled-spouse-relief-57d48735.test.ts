/**
 * Item 57d48735 (r340) — THE DISABLED-SPOUSE FURTHER DEDUCTION, PINNED TO THE SPECIFICATION.
 *
 * ═══ WHY THIS FILE EXISTS ═══
 *
 * A mutation probe run while building this item: with `disabledSpouse` reverted from RM6,000 to the old
 * RM5,000, the ENTIRE targeted suite stayed green except one assertion — the pack-versus-constant
 * roundtrip in test/statutory-relief-roundtrip.test.ts, which only fires because the bundled pack had
 * already been rebuilt. Change the constant AND the pack together and nothing in this repo disagrees.
 *
 * That is the same hole item 04b88724 fell into one round earlier, and test/child-relief-figures-04b88724
 * .test.ts opens with the lesson: "A figure that no test states independently is a figure nothing is
 * checking." Every other test of this path derives its expected amount from the ruleset handed to the
 * code under test, which is correct for MECHANISM tests and structurally incapable of catching a wrong
 * figure. So this file does the opposite on purpose: it NAMES THE RINGGIT and names the page it was read
 * on.
 *
 * ═══ THE SOURCE ═══
 *
 * LHDN, "Specification for MTD Calculations Using Computerized Calculation for 2026", Reliefs table,
 * PRINTED page 28 (PDF page 29), read directly on 2026-09-25:
 *
 *     e.  Disabled Individual                                              7,000.00
 *         A further deduction of RM7,000 is allowed if the individual is a disabled person.
 *     f.  Disabled Husband / Wife                                          6,000.00
 *         An further deduction of RM6,000 is given in respect of a disabled husband / wife.  [sic]
 *
 * We held RM5,000, which is the ANNUAL ASSESSMENT figure under s.47(1)(b) ITA 1967. Malaysia runs two
 * schedules and they disagree here — the identical class of error as the two child figures corrected in
 * r339, and in the same direction: under-relief, so over-deduction.
 *
 * r339 found this while reading the same Reliefs table, flagged it in red rather than widening its own
 * scope, and told the reporter to own it as its own item. This is that item.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MY_STATUTORY, MY_RELIEFS, MY_STATUTORY_VERSION } from '../localization/my/statutory-tables';
import { pcbMonth } from '../localization/my/payroll';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The specification's own figures, transcribed by hand. Nothing below reads these out of the code. */
const SPEC = {
  disabledSpouse: { rm: 6000, page: 'printed p.28 (PDF 29), Reliefs table item f' },
  disabledIndividual: { rm: 7000, page: 'printed p.28 (PDF 29), Reliefs table item e' },
} as const;

/** What the constant held before this item. Used to prove the assertions below are not vacuous. */
const WRONG_ANNUAL_FIGURE = 5000;

/** A ruleset identical to the built-in except for the disabled-spouse figure. */
function withDisabledSpouse(rm: number | undefined) {
  const reliefs = { ...DEFAULT_MY_STATUTORY.pcb.reliefs } as Record<string, unknown>;
  if (rm === undefined) delete reliefs.disabledSpouse;
  else reliefs.disabledSpouse = rm;
  return { ...DEFAULT_MY_STATUTORY.pcb, reliefs } as typeof DEFAULT_MY_STATUTORY.pcb;
}

/** One ordinary month. Category and the two disabled flags are what each case varies. */
function month(profile: Record<string, unknown>, pcb = DEFAULT_MY_STATUTORY.pcb) {
  return pcbMonth({ monthlyWage: 12000, epfMonthly: 1320, month: 3, profile, pcb } as never);
}

// ─── (a) The figure itself, named ────────────────────────────────────────────────────────────────────

describe('57d48735 · (a) the figure the reporter was right about', () => {
  it(`a DISABLED SPOUSE further deduction is RM6,000 — ${SPEC.disabledSpouse.page}`, () => {
    expect(MY_RELIEFS.disabledSpouse).toBe(SPEC.disabledSpouse.rm);
  });

  it('it is NOT the RM5,000 annual-assessment figure under s.47(1)(b) ITA 1967', () => {
    expect(MY_RELIEFS.disabledSpouse).not.toBe(WRONG_ANNUAL_FIGURE);
  });

  it(`the disabled INDIVIDUAL deduction is untouched at RM7,000 — ${SPEC.disabledIndividual.page}`, () => {
    expect(MY_RELIEFS.disabledIndividual).toBe(SPEC.disabledIndividual.rm);
  });

  it('the ruleset version moved with the figure, so two different tables cannot share a version string', () => {
    expect(MY_STATUTORY_VERSION).toBe('2026.11');
    expect(DEFAULT_MY_STATUTORY.version).toBe('2026.11');
  });
});

// ─── (b) It reaches the projection, not just the map ─────────────────────────────────────────────────

describe('57d48735 · (b) the corrected figure reaches P, and moves it by exactly the correction', () => {
  const profile = { category: 2, children: 0, disabledSpouse: true };

  it('a category-2 employee with a disabled spouse deducts RM6,000', () => {
    expect(month(profile).snapshot.reliefs.disabledSpouse).toBe(SPEC.disabledSpouse.rm);
  });

  it('P falls by exactly RM1,000 against the old figure — the fix reaches the projection', () => {
    const corrected = month(profile).snapshot.P1;
    const old = month(profile, withDisabledSpouse(WRONG_ANNUAL_FIGURE)).snapshot.P1;
    expect(old - corrected).toBeCloseTo(SPEC.disabledSpouse.rm - WRONG_ANNUAL_FIGURE, 2);
  });

  it('and the MTD actually deducted changes, so this is money and not presentation', () => {
    const corrected = month(profile).total;
    const old = month(profile, withDisabledSpouse(WRONG_ANNUAL_FIGURE)).total;
    expect(corrected).toBeLessThan(old);
  });
});

// ─── (c) The gate this change must not widen ─────────────────────────────────────────────────────────

describe('57d48735 · (c) still gated to category 2 exactly as the spouse deduction is', () => {
  it('category 1 (single) deducts nothing for a disabled spouse, flag or no flag', () => {
    expect(month({ category: 1, children: 0, disabledSpouse: true }).snapshot.reliefs.disabledSpouse).toBe(0);
  });

  it('category 3 (spouse working / divorced / widowed) deducts nothing either', () => {
    expect(month({ category: 3, children: 0, disabledSpouse: true }).snapshot.reliefs.disabledSpouse).toBe(0);
  });

  it('a category-1 employee is byte-identical whether or not the flag is set', () => {
    const on = month({ category: 1, children: 0, disabledSpouse: true });
    const off = month({ category: 1, children: 0 });
    expect(on.total).toBe(off.total);
    expect(on.snapshot.P1).toBe(off.snapshot.P1);
  });
});

// ─── (d) Everyone the correction must not touch ──────────────────────────────────────────────────────

describe('57d48735 · (d) an employee without a disabled spouse is byte-identical', () => {
  it('a category-2 employee with no flag is unchanged by the correction', () => {
    const profile = { category: 2, children: 0 };
    const onNew = month(profile);
    const onOld = month(profile, withDisabledSpouse(WRONG_ANNUAL_FIGURE));
    expect(onNew.total).toBe(onOld.total);
    expect(onNew.snapshot.P1).toBe(onOld.snapshot.P1);
    expect(onNew.snapshot.reliefs.disabledSpouse).toBe(0);
  });

  it('the disabled-INDIVIDUAL leg is unaffected by this item', () => {
    const withOku = month({ category: 2, children: 0, disabled: true });
    expect(withOku.snapshot.reliefs.disabledIndividual).toBe(SPEC.disabledIndividual.rm);
  });
});

// ─── (e) The optional-with-fallback shape a company override relies on ───────────────────────────────

describe('57d48735 · (e) a company override that omits the field still gets the corrected built-in', () => {
  it('an override with no disabledSpouse key falls back to RM6,000, not to 0 and not to RM5,000', () => {
    const profile = { category: 2, children: 0, disabledSpouse: true };
    expect(month(profile, withDisabledSpouse(undefined)).snapshot.reliefs.disabledSpouse).toBe(
      SPEC.disabledSpouse.rm,
    );
  });
});

// ─── (f) The signed pack, which `statutory:sync` would otherwise reinstate over the fix ──────────────

describe('57d48735 · (f) the bundled signed pack carries the corrected figure', () => {
  const pack = JSON.parse(
    readFileSync(new URL('localization/statutory-pack/bundled/my-2026.01.01.pack.json', `file://${root}`), 'utf8'),
  );
  const ruleset = JSON.parse(pack.payload).rulesets[0];

  it('the embedded ruleset is current version 2026.11, so a sync cannot stamp the old version over it', () => {
    expect(ruleset.version).toBe('2026.11');
    expect(ruleset.data.version).toBe('2026.11');
  });

  it('the embedded disabled-spouse figure is RM6,000 — `pnpm statutory:sync` would otherwise reinstate RM5,000', () => {
    expect(ruleset.data.pcb.reliefs.disabledSpouse).toBe(SPEC.disabledSpouse.rm);
  });

  it("and r339's corrected child figures survived the rebuild", () => {
    expect(ruleset.data.pcb.reliefs.childByCategory.disabled).toBe(8000);
    expect(ruleset.data.pcb.reliefs.childByCategory.disabled_study).toBe(16000);
  });
});

// ─── (g) The documents that carried the red flag ─────────────────────────────────────────────────────

describe('57d48735 · (g) the red flag r339 left is retired everywhere it was raised', () => {
  const read = (p: string) => readFileSync(new URL(p, `file://${root}`), 'utf8');

  it('STATUTORY-SOURCES.md names the current statutory-table version', () => {
    expect(read('docs/architecture/STATUTORY-SOURCES.md')).toContain('`2026.11`');
  });

  it('STATUTORY-SOURCES.md no longer says the figure is probably wrong', () => {
    const doc = read('docs/architecture/STATUTORY-SOURCES.md');
    expect(doc).not.toContain('THIS FIGURE IS VERY PROBABLY WRONG');
  });

  it('the PCB configuration screen no longer tells an admin the shown figure is wrong', () => {
    expect(read('app/payroll/configuration/pcb/page.tsx')).not.toContain('is, on the evidence of printed page 28 item f, WRONG');
  });

  it('the rows still show pending sign-off — a transcription is not an accountant’s signature', () => {
    expect(read('app/payroll/configuration/pcb/page.tsx')).toContain('reliefsPendingSignOff');
  });
});
