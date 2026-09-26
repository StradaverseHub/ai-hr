/**
 * Item d64d0df4, the remainder — Disabled Spouse, the third child-relief mode ("Auto (from table)"),
 * and the TWO live regressions found while reproducing the report.
 *
 * REPRODUCED FIRST. What was already built and is NOT rebuilt here: the Disabled Individual control and
 * its ruleset-driven deduction (test/statutory-disabled-individual.test.ts pins it), and the Manual /
 * Auto (from Family Records) modes with their no-button automatic resync. What was genuinely absent, by
 * a repo-wide grep that returned nothing: `disabled_spouse` in any form, any third child-relief mode,
 * and any use of a child's relief CATEGORY in a money calculation.
 *
 * THE TWO REGRESSIONS, both live before this change and both losing information:
 *   A · core/dependents.ts syncChildReliefFromFamily read six tax columns and called the full-overwrite
 *       setter with exactly those six. Since migration 0341 added disabled_individual, editing a family
 *       record on an employee in 'auto' mode silently cleared their OKU claim and RAISED their PCB, with
 *       nothing on screen saying so.
 *   B · components/statutory-config-form.tsx rebuilt `pcb.reliefs` as a FRESH object from the four
 *       edited scalars with no spread of the base, so any save through the statutory override editor
 *       stripped every other relief. Because the others are optional-with-fallback the strip was
 *       INVISIBLE — the ruleset simply reverted to the unverified built-in, undoing the correction the
 *       pending sign-off exists to capture. THAT ONE SHIPPED SEPARATELY (r125, item 2e3ec77d) and is
 *       pinned by test/statutory-relief-roundtrip.test.ts — which this item EXTENDS rather than
 *       duplicates, so the two new reliefs are proved to survive the same round trip in the one place
 *       that already owns it. Nothing about it is re-asserted here.
 *
 * SEPARATION OF POWERS, the property this file exists to keep. The employee's CIRCUMSTANCES (disabled
 * spouse; how many children in which category, at which share) are tenant data on employee_statutory_my.
 * Every DEDUCTION AMOUNT is statutory and lives only in the country pack's ruleset. Every assertion below
 * drives the amount from a SUPPLIED ruleset and watches P move by exactly that number, so no future change
 * can turn a legislated figure into a tenant setting and no inline constant can creep into the maths.
 *
 * ⚠️ THESE TESTS ASSERT MECHANISM AGAINST RULESET-SUPPLIED NUMBERS, SO CORRECTING A FIGURE CHANGES ONE
 * CONSTANT AND NO TEST — AND THAT CUTS BOTH WAYS. Item 04b88724 (r339) proved the cost: `disabled` was
 * RM6,000 and `disabled_study` RM14,000 (the ANNUAL ASSESSMENT figures, where the MTD schedule governs)
 * for two ruleset versions, and this file stayed green the whole time, because a test that reads its
 * expected value out of the same map as the code can never disagree with it. The reporter caught it.
 * Keep the design — but the FIGURES themselves are now stated independently, with the specification page
 * they were read on, in test/child-relief-figures-04b88724.test.ts. Do not hardcode an amount here.
 * Of the seven originally RATE-ONLY built-ins (docs/architecture/STATUTORY-SOURCES.md §1), the five
 * `childByCategory` amounts are now primary-sourced; `disabledIndividual` and `disabledSpouse` are not,
 * and `disabledSpouse` (RM5,000) disagrees with the spec's RM6,000 — recorded there, not fixed here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CHILD_RELIEF_CATEGORY_KEYS,
  DEFAULT_MY_STATUTORY,
  MY_RELIEFS,
  type StatutoryRuleset,
} from '../localization/my/statutory-tables';
import { childReliefAmountFor, pcbMonth } from '../localization/my/payroll';
import { validateStatutoryRuleset } from '../localization/my/statutory-config';
import { CHILD_RELIEF_CATEGORIES } from '../core/dependents';
import {
  CHILD_RELIEF_MODES,
  getStatutoryProfileMY,
  normaliseChildReliefTable,
  setStatutoryProfileMY,
  setTaxProfileMY,
} from '../localization/my/statutory';
import { addDependent, archiveDependent } from '../core/dependents';
import { hireEmployee } from '../core/org';
import { type SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** One month of PCB for a fixed wage/EPF/month, varying only the tax profile + the ruleset's PCB slice. */
const P1of = (profile: Parameters<typeof pcbMonth>[0]['profile'], pcb?: StatutoryRuleset['pcb']) =>
  pcbMonth({ monthlyWage: 12000, epfMonthly: 1320, month: 3, profile, pcb }).snapshot.P1;

// ─── (1) The promise: NOTHING moves on the day this ships ────────────────────────────────────────────
describe('d64d0df4 · the new fields default to "nothing claimed" and change no existing figure', () => {
  const CASES = [
    { monthlyWage: 8000, epfMonthly: 880, month: 1, category: 1 as const, children: 0 },
    { monthlyWage: 12000, epfMonthly: 1320, month: 7, category: 2 as const, children: 3 },
    { monthlyWage: 4000, epfMonthly: 440, month: 12, category: 3 as const, children: 1 },
    { monthlyWage: 25000, epfMonthly: 2750, month: 5, category: 2 as const, children: 5 },
  ];

  it('a profile that predates the two new fields is byte-identical to one that sets them off', () => {
    for (const c of CASES) {
      const before = pcbMonth({ ...c, profile: { category: c.category, children: c.children } });
      const explicitOff = pcbMonth({
        ...c,
        profile: {
          category: c.category,
          children: c.children,
          disabledSpouse: false,
          childReliefAmount: undefined,
        },
      });
      expect(explicitOff).toEqual(before);
    }
  });

  it('the LHDN Exhibit 5 golden vector is unmoved (RM110.00 in January)', () => {
    // The spec's own worked example. If the relief sum were restructured wrongly this is what would move.
    const r = pcbMonth({ monthlyWage: 5000, epfMonthly: 550, month: 1, profile: { category: 1, children: 0 } });
    expect(r.normal).toBe(110);
  });
});

// ─── (2) Disabled spouse: the amount comes from the ruleset, and ONLY category 2 can claim it ────────
describe('d64d0df4 · disabled spouse', () => {
  const withAmount = (amount: number): StatutoryRuleset['pcb'] => ({
    ...DEFAULT_MY_STATUTORY.pcb,
    reliefs: { ...DEFAULT_MY_STATUTORY.pcb.reliefs, disabledSpouse: amount },
  });

  it('moves P by EXACTLY the ruleset figure for a category-2 employee — never an inline constant', () => {
    for (const amount of [3000, 5000, 9500, 0]) {
      const pcb = withAmount(amount);
      const off = P1of({ category: 2, children: 0, disabledSpouse: false }, pcb);
      const on = P1of({ category: 2, children: 0, disabledSpouse: true }, pcb);
      expect(off - on).toBeCloseTo(amount, 2);
    }
  });

  it('moves NOTHING for categories 1 and 3 — the same gate the spouse deduction itself sits behind', () => {
    const pcb = withAmount(5000);
    for (const category of [1, 3] as const) {
      expect(P1of({ category, children: 0, disabledSpouse: true }, pcb)).toBeCloseTo(
        P1of({ category, children: 0, disabledSpouse: false }, pcb),
        2,
      );
    }
  });

  it('a ruleset predating 2026.7 (no such key) falls back to the built-in, not to a silent zero', () => {
    const legacy = {
      ...DEFAULT_MY_STATUTORY.pcb,
      reliefs: { ...DEFAULT_MY_STATUTORY.pcb.reliefs },
    } as { bands: StatutoryRuleset['pcb']['bands']; reliefs: Record<string, unknown> };
    delete legacy.reliefs.disabledSpouse;
    expect(legacy.reliefs.disabledSpouse).toBeUndefined();
    const pcb = legacy as unknown as StatutoryRuleset['pcb'];
    const drop = P1of({ category: 2, disabledSpouse: false }, pcb) - P1of({ category: 2, disabledSpouse: true }, pcb);
    expect(drop).toBeCloseTo(MY_RELIEFS.disabledSpouse, 2);
  });

  it('stacks with the disabled-individual deduction rather than replacing it', () => {
    const pcb = withAmount(5000);
    const neither = P1of({ category: 2 }, pcb);
    const both = P1of({ category: 2, disabled: true, disabledSpouse: true }, pcb);
    expect(neither - both).toBeCloseTo(
      (pcb.reliefs.disabledIndividual ?? 0) + (pcb.reliefs.disabledSpouse ?? 0),
      2,
    );
  });
});

// ─── (3) Auto (from table): per-category amounts, and the 50% column is exactly half ────────────────
describe('d64d0df4 · the child-relief category table', () => {
  const RULES: StatutoryRuleset['pcb']['reliefs'] = {
    ...DEFAULT_MY_STATUTORY.pcb.reliefs,
    childByCategory: {
      under_18: 1000,
      study_preu: 2000,
      study_tertiary: 4000,
      disabled: 8000,
      disabled_study: 16000,
    },
  };

  it('values each category at the RULESET amount, not at the flat per-child figure', () => {
    for (const [key, amount] of Object.entries(RULES.childByCategory!)) {
      expect(childReliefAmountFor({ [key]: { full: 1, half: 0 } }, RULES)).toBeCloseTo(amount, 2);
    }
  });

  it('a child in the 50% column is worth EXACTLY half that category’s amount', () => {
    for (const [key, amount] of Object.entries(RULES.childByCategory!)) {
      expect(childReliefAmountFor({ [key]: { full: 0, half: 1 } }, RULES)).toBeCloseTo(amount / 2, 2);
      expect(childReliefAmountFor({ [key]: { full: 0, half: 2 } }, RULES)).toBeCloseTo(amount, 2);
    }
  });

  it('sums across categories and counts', () => {
    const total = childReliefAmountFor(
      { under_18: { full: 2, half: 1 }, disabled_study: { full: 1, half: 0 } },
      RULES,
    );
    expect(total).toBeCloseTo(2 * 1000 + 0.5 * 1000 + 16000, 2);
  });

  it('falls back to the built-in map when the ruleset predates 2026.7', () => {
    const legacy = { ...DEFAULT_MY_STATUTORY.pcb.reliefs } as Record<string, unknown>;
    delete legacy.childByCategory;
    expect(
      childReliefAmountFor({ study_tertiary: { full: 1, half: 0 } }, legacy as StatutoryRuleset['pcb']['reliefs']),
    ).toBeCloseTo(MY_RELIEFS.childByCategory.study_tertiary, 2);
  });

  it('REPLACES children × perChild in the projection rather than adding to it', () => {
    const pcb: StatutoryRuleset['pcb'] = { ...DEFAULT_MY_STATUTORY.pcb, reliefs: RULES };
    // Three children counted the old way vs. an explicitly supplied amount.
    const flat = P1of({ category: 1, children: 3 }, pcb);
    const table = P1of({ category: 1, children: 3, childReliefAmount: 12345 }, pcb);
    expect(flat - table).toBeCloseTo(12345 - 3 * pcb.reliefs.perChild, 2);
  });

  it('an ABSENT amount leaves the arithmetic untouched to the cent (manual + auto employees)', () => {
    const pcb: StatutoryRuleset['pcb'] = { ...DEFAULT_MY_STATUTORY.pcb, reliefs: RULES };
    for (const children of [0, 1, 4]) {
      expect(P1of({ category: 1, children, childReliefAmount: undefined }, pcb)).toBeCloseTo(
        P1of({ category: 1, children }, pcb),
        2,
      );
    }
  });

  it('an unknown or malformed category contributes nothing rather than throwing a payroll run', () => {
    expect(childReliefAmountFor({ not_a_category: { full: 9, half: 9 } }, RULES)).toBe(0);
    expect(childReliefAmountFor(null, RULES)).toBe(0);
    expect(childReliefAmountFor('nonsense', RULES)).toBe(0);
    expect(childReliefAmountFor({ under_18: 'nonsense' }, RULES)).toBe(0);
  });
});

// ─── (4) The stored grid: validation + the shared category vocabulary ────────────────────────────────
describe('d64d0df4 · the stored grid and its category keys', () => {
  it('normalises to whole numbers ≥ 0, drops unknown keys, and empties to null', () => {
    expect(normaliseChildReliefTable({ under_18: { full: 2.7, half: -3 } })).toEqual({
      under_18: { full: 2, half: 0 },
    });
    expect(normaliseChildReliefTable({ made_up: { full: 5, half: 5 } })).toBeNull();
    expect(normaliseChildReliefTable({ under_18: { full: 0, half: 0 } })).toBeNull();
    expect(normaliseChildReliefTable(null)).toBeNull();
    expect(normaliseChildReliefTable([1, 2, 3])).toBeNull();
  });

  it('the pack’s category keys are the SAME five the Family register stores per child', () => {
    // Duplicated deliberately (a country pack must not import a core service module) — pinned here so
    // the two lists can never drift into a grid whose categories payroll does not price.
    expect([...CHILD_RELIEF_CATEGORY_KEYS]).toEqual([...CHILD_RELIEF_CATEGORIES]);
  });

  it('the Identity & Tax card renders the same five keys, in the same order', () => {
    const src = readFileSync(`${root}components/identity-tax-card.tsx`, 'utf8');
    const block = src.slice(src.indexOf('const CHILD_RELIEF_CATEGORY_KEYS'));
    for (const key of CHILD_RELIEF_CATEGORY_KEYS) expect(block).toContain(`'${key}'`);
  });

  it('adds the third mode without disturbing the first two', () => {
    expect([...CHILD_RELIEF_MODES]).toEqual(['manual', 'auto', 'auto_table']);
  });
});

// ─── (5) Ruleset validation: a bad relief is rejected, an unknown category is REJECTED not ignored ───
describe('d64d0df4 · ruleset validation', () => {
  const withReliefs = (reliefs: Record<string, unknown>) => ({
    ...DEFAULT_MY_STATUTORY,
    pcb: { ...DEFAULT_MY_STATUTORY.pcb, reliefs: { ...DEFAULT_MY_STATUTORY.pcb.reliefs, ...reliefs } },
  });

  it('accepts the verified default unchanged', () => {
    expect(validateStatutoryRuleset(DEFAULT_MY_STATUTORY)).toEqual([]);
  });

  it('rejects a negative disabled-spouse relief but tolerates its absence', () => {
    expect(validateStatutoryRuleset(withReliefs({ disabledSpouse: -1 })).join(' ')).toContain('disabled-spouse');
    const absent = withReliefs({});
    delete (absent.pcb.reliefs as Record<string, unknown>).disabledSpouse;
    expect(validateStatutoryRuleset(absent)).toEqual([]);
  });

  it('rejects an UNKNOWN per-category key rather than silently ignoring it', () => {
    // A silently-ignored key would let an admin believe they had corrected a figure the calculation
    // never reads — the exact failure this whole item exists to close.
    const errs = validateStatutoryRuleset(withReliefs({ childByCategory: { made_up: 100 } }));
    expect(errs.join(' ')).toContain('made_up');
  });

  it('rejects a negative per-category amount and a non-object map', () => {
    expect(
      validateStatutoryRuleset(withReliefs({ childByCategory: { under_18: -5 } })).join(' '),
    ).toContain('under_18');
    expect(validateStatutoryRuleset(withReliefs({ childByCategory: [1, 2] })).length).toBeGreaterThan(0);
  });
});

// ─── (7) i18n — every new user-visible string, in all six locales ────────────────────────────────────
describe('d64d0df4 · i18n coverage', () => {
  const DETAIL = [
    'disabledSpouseLabel',
    'disabledSpouseHint',
    'childReliefModeAutoTable',
    'childReliefTableNote',
    'childReliefTableCategoryCol',
    'childReliefTableFullCol',
    'childReliefTableHalfCol',
  ];
  const CONFIG = [
    'reliefsPendingSignOff',
    'reliefsPendingSignOffNote',
    'pendingSignOff',
    'reliefDisabledIndividual',
    'reliefDisabledSpouse',
    ...CHILD_RELIEF_CATEGORY_KEYS.map((k) => `reliefChildCat_${k}`),
  ];

  it.each(LOCALES)('%s carries every new key', (loc) => {
    const m = JSON.parse(readFileSync(`${root}messages/${loc}.json`, 'utf8'));
    for (const k of DETAIL) expect(m.people.detail[k], `people.detail.${k}`).toBeTruthy();
    for (const k of CONFIG) expect(m.payroll.config[k], `payroll.config.${k}`).toBeTruthy();
  });
});

// ─── (8) REGRESSION A — the live data loss, against the real database ────────────────────────────────
describe('d64d0df4 · regression A — a family edit must not withdraw a relief claim', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  const hire = (ctx: SessionContext, b: Base, name: string) =>
    hireEmployee(ctx, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

  it('adding a child to an AUTO-mode flagged employee keeps every relief claim they had', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Regr A');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101019666', numChildren: 0 });
    await setTaxProfileMY(a, {
      personId: e.personId,
      childReliefMode: 'auto',
      numChildren: 0,
      taxCategory: 2,
      disabledIndividual: true,
      disabledSpouse: true,
      childReliefTable: { under_18: { full: 1, half: 0 } },
    });

    // The family edit that used to clear them. It DOES move num_children — that is the feature.
    const kid = await addDependent(a, {
      personId: e.personId,
      fullName: 'Kiddo',
      relationship: 'child',
      dateOfBirth: '2018-05-05',
    });
    expect(kid.childReliefSync.changed).toBe(true);

    const after = await getStatutoryProfileMY(a, e.personId);
    expect(after?.numChildren).toBe(1);
    expect(after?.disabledIndividual).toBe(true);
    expect(after?.disabledSpouse).toBe(true);
    // ⚠️ UPDATED BY a5f21891, AND THE CHANGE IS THE POINT OF THAT ITEM. This used to assert the grid was
    // CARRIED FORWARD across a family edit. On 'auto' the Family register is now the source of truth for
    // the grid, and "Kiddo" is added with NO `childReliefCategory` — so the register no longer fully
    // supports the seeded grid, and the sync CLEARS it rather than leaving a grid that describes a family
    // that no longer exists. The kernel then falls back to `num_children × perChild`, which is what this
    // employee was being relieved before and after, so NO MONEY MOVES here.
    //
    // The claim this case actually defends — that a family edit never silently withdraws a relief CLAIM —
    // is untouched and asserted above: disabledIndividual and disabledSpouse both survive.
    expect(
      after?.childReliefTable,
      'an incomplete family clears the grid rather than keeping a stale one; relief falls back to the head count',
    ).toBeNull();
    // And the columns the sync already carried forward are still carried forward.
    expect(after?.taxCategory).toBe(2);
    expect(after?.childReliefMode).toBe('auto');
  });

  it('archiving a child — the other direction through the same code path — keeps them too', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Regr A2');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101019555', numChildren: 0 });
    const kid = await addDependent(a, {
      personId: e.personId,
      fullName: 'Kiddo2',
      relationship: 'child',
      dateOfBirth: '2019-05-05',
    });
    await setTaxProfileMY(a, {
      personId: e.personId,
      childReliefMode: 'auto',
      numChildren: 1,
      disabledIndividual: true,
      disabledSpouse: true,
    });

    const arch = await archiveDependent(a, { id: kid.id });
    expect(arch.childReliefSync.changed).toBe(true);
    const after = await getStatutoryProfileMY(a, e.personId);
    expect(after?.numChildren).toBe(0);
    expect(after?.disabledIndividual).toBe(true);
    expect(after?.disabledSpouse).toBe(true);
  });

  it('the setter still DEFAULTS an omitted claim to off — a partial write cannot claim a relief', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Regr A3');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101019444', numChildren: 0 });
    await setTaxProfileMY(a, { personId: e.personId, numChildren: 0 });
    const after = await getStatutoryProfileMY(a, e.personId);
    expect(after?.disabledSpouse).toBe(false);
    expect(after?.childReliefTable).toBeNull();
  });
});
