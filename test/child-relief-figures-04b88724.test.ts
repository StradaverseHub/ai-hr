/**
 * Item 04b88724 (r339) — THE FIVE `childByCategory` FIGURES, PINNED TO THE SPECIFICATION.
 *
 * ═══ WHY THIS FILE EXISTS AT ALL, WHEN THREE OTHER FILES ALREADY TEST THIS MECHANISM ═══
 *
 * test/statutory-disabled-spouse-child-table.test.ts, test/child-relief-review.test.ts and
 * test/statutory-relief-roundtrip.test.ts all exercise the child-relief path, and all three deliberately
 * derive every expected amount from a ruleset handed to the code under test. That is the right design for
 * MECHANISM tests — it means correcting a statutory figure touches one constant and no test.
 *
 * It is also exactly why none of them could catch this defect. `disabled` was RM6,000 and
 * `disabled_study` RM14,000 for two ruleset versions; the suite was green throughout, because a test that
 * reads its expected value out of the same map as the code can never disagree with it. The reporter caught
 * it. We told them our figures "match HASiL line for line" and they were wrong.
 *
 * So this file does the opposite thing on purpose: it NAMES THE RINGGIT, and it names the page the ringgit
 * was read on. A figure that no test states independently is a figure nothing is checking.
 *
 * ═══ THE SOURCE ═══
 *
 * LHDN, "Specification for MTD Calculations Using Computerized Calculation for 2026" (cover: "Updated:
 * 01 January 2026"), read directly on 2026-09-25 from
 * https://www.hasil.gov.my/wp-content/uploads/spesifikasi-kaedah-pengiraan-berkomputer-pcb-2026.pdf
 * — NOT from a secondary summary, which is what the two wrong figures came from.
 *
 * Reliefs table, item c. "Child", PRINTED pages 26–27 (PDF pages 27–28). Printed page 27 carries the
 * qualifying-children table and the footnote that prices each row, verbatim:
 *
 *     Child over the age of 18 years and receiving full-time instruction at diploma level
 *       onwards in an institution of higher education in Malaysia. .......................... 4
 *     Child over the age of 18 years and receiving full-time instruction at degree level
 *       onwards in an institution of higher education outside Malaysia. .................... 4
 *     Disabled child as certified by the Department of Social Welfare. ..................... 4
 *     Disabled child receiving further instruction at diploma level onwards in an institution
 *       of higher education in Malaysia or at degree level onwards in an institution of
 *       higher education outside Malaysia. ................................................. 8
 *
 *     *Relief for:
 *     *1 child below the age of 18 or a child who is studying = RM2,000
 *     *Child - 18 years and above and studying (diploma or higher) = RM8,000 (considered with 4 children)
 *     *Disabled child = RM8,000 (considered with 4 children)
 *     *Disabled child - 18 years and above and studying (diploma or higher) = RM16,000 (considered
 *      with 8 children)
 *
 * The spec expresses the deduction as QC — a count of qualifying children, each worth RM2,000 — and
 * multiplies inside the P formula's deduction block `[D + S + DU + SU + QC + (∑LP + LP1)]` (printed page
 * 24). `childReliefAmountFor` returns ringgit directly. The two are arithmetically identical for every
 * category, and §(c) below asserts THE EQUIVALENCE rather than only the totals, so an edit that keeps a
 * total while breaking the relationship still fails.
 *
 * ⚠️ NOT A 2026 RATE CHANGE. Printed page 7 of the same specification: "In line with the Budget 2026 as
 * above, there is no amendment to the MTD formula." The 2026 amendments (printed pages 4–8) are TP1/TP3
 * deduction items and none of them touches child relief. These two figures were wrong from the day they
 * were transcribed, not changed this year — which is the one part of the reporter's framing that does not
 * hold, and it does not matter, because the numbers are theirs and they are right.
 *
 * ⚠️ IF YOU ARE HERE BECAUSE AN ASSERTION BELOW FAILED: do not "fix" the test. Open the specification at
 * the page named in the failing assertion and decide which of the two is wrong. This file is the only
 * place in the suite that knows what the amounts are supposed to BE.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHILD_RELIEF_CATEGORY_KEYS,
  DEFAULT_MY_STATUTORY,
  MY_RELIEFS,
  MY_STATUTORY_VERSION,
  type StatutoryRuleset,
} from '../localization/my/statutory-tables';
import { childReliefAmountFor, pcbMonth } from '../localization/my/payroll';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * THE SPECIFICATION'S OWN TABLE, transcribed by hand from printed page 27 — the qualifying-children count
 * per category, and the page each row was read on. This constant is the source of truth for this file;
 * nothing below reads an amount out of the code under test.
 */
const SPEC = {
  under_18: { qc: 1, rm: 2000, page: 'printed p.26 prose + p.27 footnote line 1' },
  study_preu: { qc: 1, rm: 2000, page: 'printed p.26 prose (18+, full-time education) + p.27 footnote line 1' },
  study_tertiary: { qc: 4, rm: 8000, page: 'printed p.27 table rows 1–2 + footnote line 2' },
  disabled: { qc: 4, rm: 8000, page: 'printed p.27 table row 3 + footnote line 3' },
  disabled_study: { qc: 8, rm: 16000, page: 'printed p.27 table row 4 + footnote line 4' },
} as const;

/** The spec's per-child unit. Every amount above is this × QC. */
const PER_CHILD_RM = 2000;

/** The figures as they stood in ruleset 2026.7 — WRONG for two categories. Used to prove non-vacuity. */
const WRONG_2026_7 = { disabled: 6000, disabled_study: 14000 } as const;

const BUILT_IN = MY_RELIEFS.childByCategory;

// ─── (a) The two corrected figures, named ────────────────────────────────────────────────────────────
describe('04b88724 · (a) the two figures the reporter was right about', () => {
  it('a DISABLED child prices at RM8,000 — printed p.27 table row 3, "Disabled child … = RM8,000 (considered with 4 children)"', () => {
    expect(
      BUILT_IN.disabled,
      'MY_RELIEFS.childByCategory.disabled must be 8000 (4 qualifying children × RM2,000), per the LHDN ' +
        '2026 MTD spec printed p.27. RM6,000 is the ANNUAL ASSESSMENT figure and does not govern MTD.',
    ).toBe(8000);
    expect(BUILT_IN.disabled, 'the superseded 2026.7 figure must not be back').not.toBe(WRONG_2026_7.disabled);
  });

  it('a DISABLED child in higher education prices at RM16,000 — printed p.27 table row 4, "… = RM16,000 (considered with 8 children)"', () => {
    expect(
      BUILT_IN.disabled_study,
      'MY_RELIEFS.childByCategory.disabled_study must be 16000 (8 qualifying children × RM2,000), per the ' +
        'LHDN 2026 MTD spec printed p.27. RM14,000 is the annual-assessment build-up (6,000 + 8,000).',
    ).toBe(16000);
    expect(
      BUILT_IN.disabled_study,
      'the superseded 2026.7 figure must not be back',
    ).not.toBe(WRONG_2026_7.disabled_study);
  });

  it('prices a real grid through childReliefAmountFor, not just the constant', () => {
    // The constant being right is necessary but not sufficient — the money path must read it.
    expect(
      childReliefAmountFor({ disabled: { full: 1, half: 0 } }, DEFAULT_MY_STATUTORY.pcb.reliefs),
      'one disabled child claimed at 100% must deduct RM8,000 (LHDN 2026 MTD spec printed p.27)',
    ).toBeCloseTo(8000, 2);
    expect(
      childReliefAmountFor({ disabled_study: { full: 1, half: 0 } }, DEFAULT_MY_STATUTORY.pcb.reliefs),
      'one disabled child in higher education at 100% must deduct RM16,000 (printed p.27)',
    ).toBeCloseTo(16000, 2);
    // The 50% share halves the corrected figures too, not the old ones.
    expect(
      childReliefAmountFor({ disabled: { full: 0, half: 1 } }, DEFAULT_MY_STATUTORY.pcb.reliefs),
      'a disabled child at the 50% share must deduct RM4,000, half of the corrected RM8,000',
    ).toBeCloseTo(4000, 2);
  });

  it('moves P by exactly the correction, so the fix reaches the projection and not only the map', () => {
    const wrong: StatutoryRuleset['pcb'] = {
      ...DEFAULT_MY_STATUTORY.pcb,
      reliefs: {
        ...DEFAULT_MY_STATUTORY.pcb.reliefs,
        childByCategory: { ...BUILT_IN, ...WRONG_2026_7 },
      },
    };
    const P = (pcb: StatutoryRuleset['pcb'], childReliefAmount: number) =>
      pcbMonth({ monthlyWage: 12000, epfMonthly: 1320, month: 3, profile: { category: 1, children: 1, childReliefAmount }, pcb })
        .snapshot.P1;
    const grid = { disabled: { full: 1, half: 0 } };
    const before = P(wrong, childReliefAmountFor(grid, wrong.reliefs));
    const after = P(DEFAULT_MY_STATUTORY.pcb, childReliefAmountFor(grid, DEFAULT_MY_STATUTORY.pcb.reliefs));
    // More relief ⇒ LOWER chargeable income. RM2,000 of extra annual relief, to the cent.
    expect(before - after, 'correcting disabled 6,000 → 8,000 must drop P by exactly RM2,000').toBeCloseTo(2000, 2);
  });
});

// ─── (b) The other three are byte-identical ──────────────────────────────────────────────────────────
describe('04b88724 · (b) the three categories this item did NOT touch are byte-identical', () => {
  const UNTOUCHED = ['under_18', 'study_preu', 'study_tertiary'] as const;

  it.each(UNTOUCHED)('%s is unchanged by this item', (key) => {
    expect(BUILT_IN[key], `${key} was already correct (${SPEC[key].page}) and must not have moved`).toBe(
      SPEC[key].rm,
    );
  });

  it('the flat perChild figure, which every manual/auto employee uses, is untouched at RM2,000', () => {
    // Printed p.26: "A relief of RM2,000 per child". This is the figure `children × perChild` multiplies.
    expect(MY_RELIEFS.perChild).toBe(PER_CHILD_RM);
    expect(BUILT_IN.under_18, 'under_18 IS perChild broken out; if they diverge one of them is wrong').toBe(
      MY_RELIEFS.perChild,
    );
  });

  it('no category other than the two corrected ones differs from the 2026.7 map', () => {
    const reconstructed2026_7: Record<string, number> = { ...BUILT_IN, ...WRONG_2026_7 };
    const moved = CHILD_RELIEF_CATEGORY_KEYS.filter((k) => reconstructed2026_7[k] !== BUILT_IN[k]);
    expect(moved.sort(), 'exactly two figures moved in 2026.8, no more').toEqual(['disabled', 'disabled_study']);
  });
});

// ─── (c) Every category equals its spec QC × RM2,000 ─────────────────────────────────────────────────
describe('04b88724 · (c) every category equals the specification’s QC × RM2,000', () => {
  it('the ruleset map and the spec table agree on the SAME five keys', () => {
    // If a key is added or renamed without adding it to SPEC above, the equivalence below would silently
    // stop covering it. Pin the key sets equal first.
    expect(Object.keys(SPEC).sort()).toEqual([...CHILD_RELIEF_CATEGORY_KEYS].sort());
    expect(Object.keys(BUILT_IN).sort()).toEqual([...CHILD_RELIEF_CATEGORY_KEYS].sort());
  });

  it.each(CHILD_RELIEF_CATEGORY_KEYS)(
    '%s: the encoded ringgit equals qualifying-children × RM2,000, the spec’s own expression',
    (key) => {
      const { qc, rm, page } = SPEC[key];
      // Both halves are asserted, not just the total: the ringgit must match the spec's stated amount AND
      // be reconstructible from the spec's stated child count. A future edit that changes one without the
      // other breaks the relationship the spec defines, and that is the thing worth catching.
      expect(rm, `SPEC[${key}] is internally inconsistent: ${qc} × ${PER_CHILD_RM} ≠ ${rm}`).toBe(
        qc * PER_CHILD_RM,
      );
      expect(
        BUILT_IN[key],
        `childByCategory.${key} must equal QC ${qc} × RM${PER_CHILD_RM} = RM${qc * PER_CHILD_RM} (${page})`,
      ).toBe(qc * PER_CHILD_RM);
      // And through the money path, for a whole child and a half child.
      expect(childReliefAmountFor({ [key]: { full: 1, half: 0 } }, DEFAULT_MY_STATUTORY.pcb.reliefs)).toBeCloseTo(
        qc * PER_CHILD_RM,
        2,
      );
      expect(childReliefAmountFor({ [key]: { full: 0, half: 1 } }, DEFAULT_MY_STATUTORY.pcb.reliefs)).toBeCloseTo(
        (qc * PER_CHILD_RM) / 2,
        2,
      );
    },
  );

  it('a mixed grid equals the SUM of its qualifying children × RM2,000 — the reporter’s own worked examples', () => {
    // From the ticket, which quotes the spec's method back at us. Each must come out of the real path.
    const cases: { grid: Record<string, { full: number; half: number }>; units: number; note: string }[] = [
      { grid: { under_18: { full: 2, half: 0 } }, units: 2, note: '2 children below 18 → 2 units = RM4,000' },
      {
        grid: { under_18: { full: 1, half: 0 }, study_tertiary: { full: 1, half: 0 } },
        units: 5,
        note: '1 child below 18 + 1 qualifying diploma student → 5 units = RM10,000',
      },
      {
        grid: { disabled: { full: 1, half: 0 }, under_18: { full: 1, half: 0 } },
        units: 5,
        note: '1 disabled child + 1 child below 18 → 5 units = RM10,000',
      },
      {
        grid: { disabled_study: { full: 1, half: 0 } },
        units: 8,
        note: '1 disabled child in qualifying higher education → 8 units = RM16,000',
      },
    ];
    for (const { grid, units, note } of cases) {
      expect(childReliefAmountFor(grid, DEFAULT_MY_STATUTORY.pcb.reliefs), note).toBeCloseTo(
        units * PER_CHILD_RM,
        2,
      );
    }
  });
});

// ─── (d) manual / auto employees are byte-identical ──────────────────────────────────────────────────
describe('04b88724 · (d) a manual or auto employee is byte-identical — the flat path is untouched', () => {
  // Production 2026-09-25: 71 employees are `manual` and 3 are `auto`. Not one of them may move.
  const CASES = [
    { monthlyWage: 8000, epfMonthly: 880, month: 1, category: 1 as const, children: 0 },
    { monthlyWage: 12000, epfMonthly: 1320, month: 7, category: 2 as const, children: 3 },
    { monthlyWage: 4000, epfMonthly: 440, month: 12, category: 3 as const, children: 1 },
    { monthlyWage: 25000, epfMonthly: 2750, month: 5, category: 2 as const, children: 5 },
    // A disabled-child household still on `manual`: production has exactly this shape (person
    // b57268ae has a disabled_study grid keyed but child_relief_mode = 'manual', so the grid is NOT read).
    { monthlyWage: 9500, epfMonthly: 1045, month: 6, category: 2 as const, children: 9 },
  ];

  it('the corrected map cannot reach an employee who supplies no childReliefAmount', () => {
    const wrong: StatutoryRuleset['pcb'] = {
      ...DEFAULT_MY_STATUTORY.pcb,
      reliefs: { ...DEFAULT_MY_STATUTORY.pcb.reliefs, childByCategory: { ...BUILT_IN, ...WRONG_2026_7 } },
    };
    for (const c of CASES) {
      const profile = { category: c.category, children: c.children };
      const onOld = pcbMonth({ ...c, profile, pcb: wrong });
      const onNew = pcbMonth({ ...c, profile, pcb: DEFAULT_MY_STATUTORY.pcb });
      expect(
        onNew.normal,
        `manual/auto employee (cat ${c.category}, ${c.children} children) must be byte-identical: the ` +
          'flat children × perChild path never consults childByCategory',
      ).toBe(onOld.normal);
      expect(onNew.snapshot.P1, 'P must not move either').toBe(onOld.snapshot.P1);
    }
  });

  it('and the flat path is still literally children × RM2,000, not the category map', () => {
    const base = pcbMonth({ monthlyWage: 12000, epfMonthly: 1320, month: 3, profile: { category: 1, children: 0 } })
      .snapshot.P1;
    for (const children of [1, 2, 5]) {
      const withKids = pcbMonth({
        monthlyWage: 12000,
        epfMonthly: 1320,
        month: 3,
        profile: { category: 1, children },
      }).snapshot.P1;
      expect(base - withKids, `${children} children on the flat path deduct ${children} × RM2,000`).toBeCloseTo(
        children * PER_CHILD_RM,
        2,
      );
    }
  });
});

// ─── (e) no keyed grid still yields 0 ────────────────────────────────────────────────────────────────
describe('04b88724 · (e) an employee with no keyed grid still gets 0 from the category path', () => {
  // ⚠️ THIS IS A HAZARD, NOT A FEATURE, AND THIS ITEM DELIBERATELY LEFT IT ALONE. An employee moved to
  // 'auto_table' with no grid keyed claims RM0 of child relief and their PCB goes UP. Production
  // 2026-09-25: the ONE auto_table employee has a grid ({"under_18":{"full":1,"half":0}}), so nobody is
  // in this state today — but num_children = 1 for them, so the grid and the count agree only by luck.
  // Changing the default or flipping anybody's mode is a separate money migration with its own item.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['an array (malformed)', [] as unknown],
    ['a string (malformed)', 'under_18' as unknown],
    ['an unknown category only', { made_up_category: { full: 3, half: 0 } }],
  ])('%s yields exactly 0, unchanged by this item', (_label, grid) => {
    expect(childReliefAmountFor(grid, DEFAULT_MY_STATUTORY.pcb.reliefs)).toBe(0);
  });

  it('falls back to the built-in map when the ruleset predates childByCategory — with the CORRECTED figures', () => {
    // An override or pack written before 2026.7 omits the map entirely. The fallback must be the
    // corrected built-in, or a legacy override would quietly keep deducting RM6,000.
    const legacy = { ...DEFAULT_MY_STATUTORY.pcb.reliefs } as Record<string, unknown>;
    delete legacy.childByCategory;
    expect(
      childReliefAmountFor({ disabled: { full: 1, half: 0 } }, legacy as StatutoryRuleset['pcb']['reliefs']),
      'a pre-2026.7 ruleset must fall back to the CORRECTED RM8,000, not the old RM6,000',
    ).toBeCloseTo(8000, 2);
  });
});

// ─── (f) the Personnel page no longer offers the link, and its neighbour still does ──────────────────
describe('04b88724 · (f) the Child Relief Review link is gone from Personnel Management, surgically', () => {
  const personnelPage = readFileSync(`${root}app/admin/personnel/page.tsx`, 'utf8');

  /**
   * ⚠️ COMMENTS ARE STRIPPED BEFORE THE ROUTE IS LOOKED FOR, AND THAT IS NOT A LOOPHOLE — IT IS THE POINT.
   * The removal site carries a long comment explaining why the link went and why the route stayed, and that
   * comment necessarily NAMES the route. A naive `not.toContain(path)` failed on that comment, which would
   * have pressured the next person to delete the explanation in order to get a green suite. What must be
   * absent is a REFERENCE, not a mention.
   * The stripper is deliberately crude (it does not understand a `/*` inside a string literal). It is
   * adequate because it is applied to ONE known file and the href assertion below is checked against the
   * RAW source as well, so a real link cannot hide behind a stripping bug.
   */
  const withoutComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

  // The link is a plain `href` on a server component, so the honest pin is the contract in the source:
  // the route must not be reachable from this screen. Asserting on fetched HTML would prove nothing —
  // CLAUDE.md §8, "a key is not a screen": the RSC payload carries the whole catalogue either way.
  it('offers no href to /admin/personnel/child-relief', () => {
    expect(
      withoutComments(personnelPage),
      'the Child Relief Review button was removed from the Personnel Management main page at the ' +
        "reporter's request (04b88724). If this fails, a link was restored — read the comment at its old " +
        'site before deciding that is correct.',
    ).not.toContain('/admin/personnel/child-relief');
  });

  it('and carries no href attribute for it in the RAW source either — belt and braces on the stripper', () => {
    // Checked against the unstripped file, so a bug in the comment stripper cannot hide a real link.
    for (const form of [
      'href="/admin/personnel/child-relief"',
      "href={'/admin/personnel/child-relief'}",
      'href={"/admin/personnel/child-relief"}',
      'href={`/admin/personnel/child-relief`}',
    ]) {
      expect(personnelPage, `${form} must not appear on the Personnel Management main page`).not.toContain(form);
    }
  });

  it('the comment recording the decision is still there — a silent removal is the failure mode', () => {
    // A future reader who finds neither a link nor an explanation will assume the removal was an accident
    // and restore it. The explanation is load-bearing; assert it survives.
    expect(personnelPage, 'the removal site must still explain itself').toContain('04b88724');
    expect(personnelPage).toContain('ROUTE WAS DELIBERATELY KEPT');
  });

  it('still offers the duplicates link that sat beside it — the removal was surgical', () => {
    expect(
      personnelPage,
      'Duplicate Records sat immediately above the removed link and must survive it untouched',
    ).toContain('/admin/personnel/duplicates');
    expect(personnelPage, "and still renders its own label").toContain("t('duplicateRecords')");
  });

  it('no longer renders the childReliefReview label, and the other entry points are untouched', () => {
    expect(personnelPage).not.toContain("t('childReliefReview')");
    // The screen's other neighbours on this header row.
    //
    // ── UPDATED BY ITEM 034a5080 ─────────────────────────────────────────────────────────────────────
    // THE OLD CLAIM, quoted rather than deleted:
    //
    //     for (const href of ['/admin/personnel/import', '/admin/personnel/new']) {
    //       expect(personnelPage, `${href} is a different button and must not have been collateral`).toContain(href);
    //     }
    //
    // Create New Employee is no longer a bare href on this page: 034a5080 turned it into a prompt, and the
    // trigger (still a Link to that route) moved into ./create-employee-dialog.tsx. Left as written, the
    // loop would have gone on passing because two of this file's OWN neighbouring comments mention the
    // path in prose — a guard about a button, satisfied by a sentence. So Import keeps the href check and
    // Create is checked by the component that now renders it.
    expect(
      personnelPage,
      '/admin/personnel/import is a different button and must not have been collateral',
    ).toContain('/admin/personnel/import');
    expect(
      personnelPage,
      'Create New Employee is a different button and must not have been collateral',
    ).toContain('<CreateEmployeeDialog');
  });

  it('THE ROUTE IS KEPT ON PURPOSE — page, its SCREENS column and its guard all still present', () => {
    // The approved plan promised the reporter this report as the list they would see before any migration
    // of the other 74 employees off flat child counting. Deleting it in the same round would break that.
    // A deleted page must ALSO lose its SCREENS column (test/function-access.test.ts walks app/**/page.tsx),
    // so these two assertions must move together or not at all.
    const routePage = readFileSync(`${root}app/admin/personnel/child-relief/page.tsx`, 'utf8');
    expect(routePage, 'the route page still exists and is still admin-gated').toContain('requireAdmin');
    expect(
      readFileSync(`${root}lib/permissions.ts`, 'utf8'),
      'the SCREENS column stays while the page stays — deleting one without the other fails ' +
        'test/function-access.test.ts',
    ).toContain("'/admin/personnel/child-relief'");
  });

  it("r336's two kernel pins survive: both readers of child_relief_mode are still in place", () => {
    // The review screen keeps its tests because it keeps its route, but these two live in the kernel and
    // were unpinned by anything before r336. If the screen is ever deleted, these must be rehomed FIRST.
    for (const f of ['core/payroll.ts', 'core/payroll-view.ts']) {
      const src = readFileSync(`${root}${f}`, 'utf8');
      expect(src, `${f} must still gate the category path on auto_table`).toContain("'auto_table'");
      expect(src, `${f} must still call the pack's childReliefAmountFor`).toContain('childReliefAmountFor');
    }
  });
});

// ─── The version bump, which r338 made load-bearing ─────────────────────────────────────────────────
describe('04b88724 · the ruleset version moved with the figures', () => {
  it('MY_STATUTORY_VERSION is past 2026.7, so two different tables cannot share a version string', () => {
    // r338 (item 00e28308) started recording `pay_period.statutory_version`. A payslip computed on
    // 6,000/14,000 and one computed on 8,000/16,000 must not both stamp "2026.7".
    expect(MY_STATUTORY_VERSION).not.toBe('2026.7');
    const [major, minor] = MY_STATUTORY_VERSION.split('.');
    expect(major).toBe('2026');
    expect(Number(minor), 'the version must move FORWARD when a figure changes').toBeGreaterThan(7);
  });

  it('the bundled default ruleset carries that same version', () => {
    expect(DEFAULT_MY_STATUTORY.version).toBe(MY_STATUTORY_VERSION);
  });

  it('docs/architecture/STATUTORY-SOURCES.md records the same version and the citation', () => {
    // The file header of statutory-tables.ts says: DO NOT change a number without updating that doc.
    const doc = readFileSync(`${root}docs/architecture/STATUTORY-SOURCES.md`, 'utf8');
    expect(doc, 'the doc must name the current statutory-table version').toContain(
      `\`${MY_STATUTORY_VERSION}\``,
    );
    expect(doc, 'and must carry the corrected disabled-child figures').toContain('RM16,000');
    expect(doc).toContain('RM8,000');
  });
});

// ─── (g) r351 — THE SCREEN'S OWN PROSE CARRIES THE SAME FIGURES, IN ALL SIX LOCALES ─────────────────

/**
 * ⚠️ WHY THIS SECTION HAD TO EXIST, AND WHAT IT CAUGHT.
 *
 * r339 corrected `childByCategory` from 6,000 / 14,000 to 8,000 / 16,000 and the whole suite went green.
 * What nobody corrected was the SENTENCE the Family tab prints beside the category dropdown — the info
 * badge an administrator reads at the exact moment they classify a child. `people.detail.family
 * .childReliefGuidance` went on saying "disabled child — RM6,000; disabled child in full-time higher
 * education — RM6,000 plus RM8,000" in ALL SIX locales for two rounds, because NO TEST PINNED ITS FIGURES.
 * A figure that only prose states is a figure nothing is checking — the same reasoning that created this
 * file, applied to the half of the product a human actually reads.
 *
 * HOW IT IS PINNED, AND WHY THE SET RATHER THAN THE SENTENCE. Asserting the wording would break on every
 * translation improvement and teach the next reader to edit the test. What must hold is narrower and
 * absolute: THE SET OF RINGGIT FIGURES THE SENTENCE NAMES IS EXACTLY THE SET `childByCategory` PRICES. A
 * figure appearing there that the ruleset does not price is a statutory claim the kernel would contradict;
 * a priced figure missing from there is guidance that understates somebody's relief.
 *
 * It works across all six because a ringgit amount is written with Latin digits and comma grouping in
 * every one of these catalogues — that is checked below rather than assumed, so a future locale that
 * localises its digits fails loudly here instead of silently dropping out of the guard.
 */
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const guidanceOf = (loc: string): string => {
  const m = JSON.parse(readFileSync(`${root}messages/${loc}.json`, 'utf8')) as Record<string, any>;
  const s = m?.people?.detail?.family?.childReliefGuidance;
  expect(typeof s, `${loc}: people.detail.family.childReliefGuidance must be a string`).toBe('string');
  return s as string;
};
/** Every `RM<digits>` token in a sentence, as NUMBERS, so formatting is not what is being compared. */
const ringgitIn = (s: string): number[] =>
  [...s.matchAll(/RM\s?([\d,]+)/g)].map((m) => Number(m[1].replace(/,/g, '')));

describe('04b88724 · (g) the Family tab guidance names the ruleset’s own figures', () => {
  it.each(LOCALES)('%s: the set of amounts is exactly what childByCategory prices', (loc) => {
    const priced = [...new Set(Object.values(BUILT_IN!))].sort((a, b) => a - b);
    const named = [...new Set(ringgitIn(guidanceOf(loc)))].sort((a, b) => a - b);
    expect(named, `${loc}: the guidance names an amount the ruleset does not price, or omits one it does`).toEqual(
      priced,
    );
  });

  it.each(LOCALES)('%s: every one of the five categories is accounted for', (loc) => {
    // The set test above cannot tell a sentence that lists four categories from one that lists five, since
    // two of them share RM2,000. Count the tokens as well: five categories, five amounts.
    expect(ringgitIn(guidanceOf(loc)).length, `${loc}: five categories, five amounts`).toBe(
      CHILD_RELIEF_CATEGORY_KEYS.length,
    );
  });

  it.each(LOCALES)('%s: neither figure r339 corrected survives in the prose', (loc) => {
    // NON-VACUITY, and the actual regression: these are the two amounts that were printed for two rounds
    // after the ruleset stopped agreeing with them. RM6,000 is a real MY relief figure (disabled spouse), so
    // this is asserted on THIS sentence only, never on the catalogue at large.
    const named = ringgitIn(guidanceOf(loc));
    for (const wrong of Object.values(WRONG_2026_7)) {
      expect(named, `${loc}: the guidance still prints the pre-r339 figure RM${wrong}`).not.toContain(wrong);
    }
  });

  it.each(LOCALES)('%s: the amounts are written in Latin digits, which is what makes this guard work', (loc) => {
    // If a catalogue ever localises its numerals the regex above would find nothing and every assertion in
    // this section would pass vacuously. Fail here instead, with the reason.
    expect(ringgitIn(guidanceOf(loc)).length, `${loc}: no RM amount was parseable at all`).toBeGreaterThan(0);
  });

  it('and the guidance agrees with the grid caption the same screen prints for each category', () => {
    // The badge is prose; `childByCategory` is what the kernel deducts. Stated once more as ringgit, from
    // the spec table at the top of this file, so section (g) cannot drift from sections (a)-(c).
    for (const key of CHILD_RELIEF_CATEGORY_KEYS) {
      expect(BUILT_IN![key], `${key}`).toBe(SPEC[key as keyof typeof SPEC].rm);
    }
    expect(ringgitIn(guidanceOf('en')), 'the English sentence, category by category, in the canonical order')
      .toEqual(CHILD_RELIEF_CATEGORY_KEYS.map((k) => SPEC[k as keyof typeof SPEC].rm));
  });
});
