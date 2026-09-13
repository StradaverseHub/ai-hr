/**
 * r270 — THE ENTITLEMENT TABLES TAB, CLEARED AND THEN REBUILT IN THE SHAPE THE REPORTER DREW.
 *
 * Three approved items, all about ONE screen, and the third only makes sense on the screen the first two
 * clear:
 *
 *   5527ce8f  Leave balance health was drawn TWICE — `app/admin/leave-config/types/page.tsx:220` renders
 *             `LeaveConfigHealthCard` at page level, and the shared block rendered the identical card
 *             above the tables on the Entitlement tables tab.
 *   995387c6  Benefit schemes were drawn TWICE — the list and its create/edit form are the leave type's
 *             own tab 3 (`6aee1d91`), and the unscoped mount carried a second copy of the same form
 *             writing the same effective-dated lineage.
 *   65e4073a  …and what the reporter actually wanted on that screen was their own four columns as one
 *             grid: Leave type · Job grade · Years of service · Entitlement · Table. The facts were all
 *             already there; they were split across two blocks. Years of service and days live on the
 *             entitlement TABLE, job grade lives on the SCHEME that names it.
 *
 * WHAT EACH GROUP IS FOR:
 *   §A the grid's derivation, unit-tested. It is the only part of r270 with behaviour, and its failure
 *      mode is silent: a wrong "Job grade" cell asserts something false about who gets days, and every
 *      other column on the row would still read correctly.
 *   §B the composition — which mount switches what off, what was GATED rather than deleted, and the five
 *      things on this tab that must keep working with the schemes Card gone. Source-asserted, which is
 *      this block's own convention (see test/entitlement-tables-embed.test.ts's header): it is a server
 *      component importing a 'use server' module and cannot be mounted in vitest.
 *   §C the words — the nine keys the grid mints, in six catalogues, and the two sentences that went stale
 *      the moment the schemes section left the page.
 *
 * ⚠️ NOTHING HERE IS A SCHEMA OR ENGINE TEST, because r270 changed neither. `65e4073a` build 1 is
 * presentation: no migration, no new matcher, and not one figure recalculated. §A asserts exactly that —
 * the derivation reads what the block already holds and computes no entitlement of its own.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { entitlementGridRows } from '../app/admin/leave/entitlements/templates/entitlement-tables-block';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const BLOCK = 'app/admin/leave/entitlements/templates/entitlement-tables-block.tsx';
const PAGE = 'app/admin/leave-config/entitlement-tables/page.tsx';
const TYPES_PAGE = 'app/admin/leave-config/types/page.tsx';
const IA = 'docs/design/a6fe37fc-leave-config-ia.md';

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const catalogue = (loc: string) => JSON.parse(read(`messages/${loc}.json`));

/** A table with three service bands, which is the reporter's own GP1215 shape (0–2 · 2–5 · 5+). */
const bands = [
  { fromYears: 0, toYears: 2, days: 16 },
  { fromYears: 2, toYears: 5, days: 18 },
  { fromYears: 5, toYears: null, days: 20 },
];
const table = (over: Partial<{ id: string; lineageId: string; leaveTypeId: string; name: string }> = {}) => ({
  id: 'v1',
  lineageId: 'lin-gp1215',
  leaveTypeId: 'annual',
  name: 'GP1215',
  serviceBands: bands,
  ...over,
});
const grid = (over: Partial<Parameters<typeof entitlementGridRows>[0]> = {}) =>
  entitlementGridRows({
    running: [table()],
    rulesByTemplateLineage: new Map(),
    defaultLineageByType: new Map(),
    soleTableTypeIds: new Set(),
    ...over,
  });

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// §A · the derivation
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('§A 65e4073a · one row per table × service band × the thing that reaches it', () => {
  it('a scheme-covered table produces one row per band, carrying that scheme’s own criteria', () => {
    const rows = grid({
      rulesByTemplateLineage: new Map([['lin-gp1215', [{ id: 'rule-a', criteria: { gradeIds: ['g16', 'g17'] } }]]]),
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.fromYears, r.toYears, r.days])).toEqual([
      [0, 2, 16],
      [2, 5, 18],
      [5, null, 20],
    ]);
    // The Job grade cell is the SCHEME's criteria, unmodified — the grid never invents a grade, and the
    // renderer hands this straight to the same `coversCell` the tables list below uses.
    for (const r of rows) {
      expect(r.reach).toEqual({ kind: 'scheme', ruleId: 'rule-a', criteria: { gradeIds: ['g16', 'g17'] } });
      expect(r.tableName).toBe('GP1215');
      expect(r.leaveTypeId).toBe('annual');
      expect(r.isDefaultTable).toBe(false);
    }
  });

  it('TWO schemes naming one table are two populations, so they are two sets of rows', () => {
    const rows = grid({
      rulesByTemplateLineage: new Map([
        [
          'lin-gp1215',
          [
            { id: 'rule-a', criteria: { gradeIds: ['g16'] } },
            { id: 'rule-b', criteria: { departmentIds: ['d1'] } },
          ],
        ],
      ]),
    });
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => (r.reach.kind === 'scheme' ? r.reach.ruleId : r.reach.kind))).toEqual([
      'rule-a',
      'rule-a',
      'rule-a',
      'rule-b',
      'rule-b',
      'rule-b',
    ]);
    // ⚠️ THE SECOND SCHEME NARROWS ON SOMETHING THAT IS NOT A GRADE, and it is carried through as itself.
    // A blank cell would assert nothing and a grade would assert something false; the renderer prints
    // what the scheme DOES narrow on, in the picker's own words.
    expect(rows[3].reach).toEqual({ kind: 'scheme', ruleId: 'rule-b', criteria: { departmentIds: ['d1'] } });
  });

  it('a table reached ONLY by the leave type’s default says so, and its Table cell is marked', () => {
    const rows = grid({ defaultLineageByType: new Map([['annual', 'lin-gp1215']]) });
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.reach).toEqual({ kind: 'default' });
      expect(r.isDefaultTable, 'the Table cell carries the default suffix').toBe(true);
    }
  });

  it('a table that is BOTH scheme-covered AND the default produces both, and marks every row default', () => {
    // The reporter's own production state on 2026-09-13: one rule named GP1215 AND Annual Leave's default
    // entitlement table set to the same lineage at 17:28. The mockup draws both, and they are different
    // populations — the scheme's people, and everyone the scheme misses.
    const rows = grid({
      rulesByTemplateLineage: new Map([['lin-gp1215', [{ id: 'rule-a', criteria: { gradeIds: ['g16'] } }]]]),
      defaultLineageByType: new Map([['annual', 'lin-gp1215']]),
    });
    expect(rows).toHaveLength(6);
    expect(rows.slice(0, 3).every((r) => r.reach.kind === 'scheme')).toBe(true);
    expect(rows.slice(3).every((r) => r.reach.kind === 'default')).toBe(true);
    expect(rows.every((r) => r.isDefaultTable)).toBe(true);
  });

  it('the leave type’s SINGLE table with no scheme reaches everyone, and is not called broken', () => {
    // r193 fault 3, read from `soleTableApplies` and never re-derived here: the engine applies the sole
    // table because there is nothing to choose between. Calling that "nobody" would make the grid lie
    // about the reporter's Hospitalization Leave, which has one table, no scheme, and works.
    const rows = grid({ soleTableTypeIds: new Set(['annual']) });
    expect(rows.map((r) => r.reach.kind)).toEqual(['everyone', 'everyone', 'everyone']);
  });

  it('a table nothing reaches is printed as reaching nobody, never left blank', () => {
    const rows = grid();
    expect(rows.map((r) => r.reach.kind)).toEqual(['unreached', 'unreached', 'unreached']);
    // …and the days are still carried, because the row has to show WHAT would be given if anybody
    // qualified. The Job grade cell is what says nobody does.
    expect(rows.map((r) => r.days)).toEqual([16, 18, 20]);
  });

  it('a default table is never ALSO reported as unreached or as a sole table', () => {
    const rows = grid({
      defaultLineageByType: new Map([['annual', 'lin-gp1215']]),
      soleTableTypeIds: new Set(['annual']),
    });
    expect(rows.map((r) => r.reach.kind)).toEqual(['default', 'default', 'default']);
  });

  it('input order is preserved and every key is unique, so the caller owns the order and React owns nothing', () => {
    const rows = entitlementGridRows({
      running: [
        table({ id: 'v-sick', lineageId: 'lin-sick', leaveTypeId: 'sick', name: 'Sick standard' }),
        table(),
      ],
      rulesByTemplateLineage: new Map([['lin-gp1215', [{ id: 'rule-a', criteria: {} }]]]),
      defaultLineageByType: new Map(),
      soleTableTypeIds: new Set(),
    });
    expect(rows.map((r) => r.tableName)).toEqual([
      'Sick standard',
      'Sick standard',
      'Sick standard',
      'GP1215',
      'GP1215',
      'GP1215',
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('nothing in force ⇒ no rows, so the screen can hide the grid instead of drawing empty furniture', () => {
    expect(entitlementGridRows({
      running: [],
      rulesByTemplateLineage: new Map(),
      defaultLineageByType: new Map(),
      soleTableTypeIds: new Set(),
    })).toEqual([]);
  });

  it('the derivation computes no entitlement of its own: no clock, no database, no resolver, no i18n', () => {
    // 65e4073a build 1 is PRESENTATION ONLY. The plan's standing decision is that grade stays on the rule
    // and no second matcher is created; a derivation that reached for the engine, the clock or a
    // catalogue would be that second matcher arriving by the back door.
    const src = read(BLOCK);
    const fn = src.slice(
      src.indexOf('export function entitlementGridRows'),
      src.indexOf('export async function EntitlementTablesBlock'),
    );
    expect(fn.length, 'the derivation must still be a top-level exported function').toBeGreaterThan(500);
    // Word-boundary matches, not substrings: `.get(` ends in `t(` and would fail a naive needle for a
    // translator call, which is the kind of false red that gets a guard deleted rather than fixed.
    for (const forbidden of [
      /\bawait\b/,
      /\bdb\./,
      /\bdrizzle\b/,
      /\bresolveEntitlement\b/,
      /\bbandFor\(/,
      /\btodayInKualaLumpur\b/,
      /\bgetTranslations\b/,
      /(?<![A-Za-z0-9_.$])t\(/,
    ]) {
      expect(fn, `the grid derivation must not reach for ${forbidden}`).not.toMatch(forbidden);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// §B · the composition
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('§B · which mount switches what off, and what was gated rather than deleted', () => {
  const block = read(BLOCK);
  const page = read(PAGE);

  it('both flags default to today’s behaviour and neither names the scope', () => {
    expect(block).toContain('showConfigHealth = true');
    expect(block).toContain('showBenefitSchemes = true');
    // ⚠️ `test/entitlement-tables-embed.test.ts` proves this mount is UNFILTERED by slicing the mount text
    // to its first `/>` and asserting no `leaveTypeId` in it, and `test/leave-config-round3.test.ts`
    // asserts the whole page names no `leaveTypeId={`. A flag named after the scope trips both, so the
    // same slice is taken here over the real mount text — including the two flags r270 added to it.
    const mount = page.slice(page.indexOf('<EntitlementTablesBlock'));
    const props = mount.slice(0, mount.indexOf('/>'));
    expect(props).toContain('showConfigHealth={false}');
    expect(props).toContain('showBenefitSchemes={false}');
    expect(props).not.toContain('leaveTypeId');
  });

  it('the Entitlement tables tab switches both off; the leave type tab switches neither off', () => {
    // ⚠️ SLICED TO THE MOUNT, not searched over the whole file. This assertion first read the file and was
    // VACUOUS: the page's own explanatory comment names both flags, so stripping them off the real mount
    // left it green. The r270 verify pass proved that by mutation. A guard that a comment can satisfy is
    // not a guard — take the mount text, exactly as the sibling above does.
    const mount = page.slice(page.indexOf('<EntitlementTablesBlock'));
    const mountProps = mount.slice(0, mount.indexOf('/>'));
    expect(mountProps).toContain('showConfigHealth={false}');
    expect(mountProps).toContain('showBenefitSchemes={false}');
    const types = read(TYPES_PAGE);
    expect(types).not.toContain('showConfigHealth={false}');
    expect(types).not.toContain('showBenefitSchemes={false}');
    // …and the copy of the health card that is KEPT is the one that page renders itself.
    expect(types).toContain('<LeaveConfigHealthCard rows={configHealth} />');
  });

  it('the schemes Card is GATED, not deleted — the leave type tab still gets every part of it', () => {
    const gate = block.indexOf('{showBenefitSchemes ? (');
    expect(gate, 'the gate must exist').toBeGreaterThan(-1);
    expect(gate).toBeLessThan(block.indexOf("t('rulesTitle')"));
    // The three literals r266 requires this file to keep, and the two editors that make the card a card.
    for (const kept of ["t('colSchemeName')", "t('rulesIntro')", "t('rulesNamingTip')", '<EligibilityRuleForm']) {
      expect(block, `${kept} must survive the gate`).toContain(kept);
    }
  });

  it('the suppressed health state is tested BEFORE the scoped/unscoped branch', () => {
    // Order is the assertion twice over: a caller that said "do not draw this" must not fall through to
    // the unscoped card, and the same ordering closes the live edge case where a `leaveTypeId` matching
    // no loaded row left `scopedHealth` null and rendered an empty "No active leave types" card.
    expect(block).toContain('{!showConfigHealth ? null : scopedHealth ? (');
  });

  it('the five things that must keep working on this tab with the schemes card gone', () => {
    // Verified, not assumed: none of these depends on the schemes Card, and together they are what keeps
    // cross-leave-type visibility on this screen after the editor leaves it.
    expect(block, 'the Leave type column on the tables list').toContain("<th className=\"px-3 py-2\">{t('colLeaveType')}</th>");
    expect(block, 'the leave type picker in the create form').toContain("t('templateLeaveType')");
    expect(block, 'the Schemes count column').toContain("t('colRules')");
    expect(block, 'the Covers cell').toContain('{coversOfScheme(rule.criteria)}');
    expect(block, 'the amber "nothing points here" marker').toContain('text-amber-700 dark:text-amber-500');
    expect(block).toContain("t('ruleNonePointsHere')");
  });

  it('there is still exactly ONE renderer of a criteria object, and the grid borrows it', () => {
    // The invariant `test/r269-grade-change-record.test.ts` §D is about, asserted as the invariant rather
    // than as a call count: a second inline walk of a criteria object is how two halves of one screen come
    // to describe the same scheme differently. r270 added a THIRD reader (the grid's Job grade cell) and
    // routed it, with the tables list, through `coversOfScheme` — so the renderer is still called from two
    // places and the grid cannot drift from the Covers cell beside it.
    expect((block.match(/const coversCell = \(/g) ?? []).length).toBe(1);
    expect((block.match(/coversCell\(/g) ?? []).length, 'the alias and the schemes list').toBe(2);
    expect(block).toContain('const coversOfScheme = (criteria: unknown) => coversCell(');
    expect(block).toContain('coversOfScheme(reach.criteria)');
    // …and the summariser underneath it is still walked in exactly one place, which is what "one
    // renderer" ultimately means. A grid that walked the criteria itself would pass every count above.
    expect((block.match(/summariseOrgCriteria\(/g) ?? []).length, 'inside coversCell and nowhere else').toBe(1);
  });

  it('the grid is the unfiltered mount’s alone, and it renders the five promised columns in order', () => {
    expect(block).toContain('const gridRows = scoped');
    const head = block.slice(block.indexOf("t('gridColLeaveType')"), block.indexOf("t('gridColTable')"));
    expect(head).toContain("t('gridColGrade')");
    expect(head.indexOf("t('gridColGrade')")).toBeLessThan(head.indexOf("t('gridColService')"));
    expect(head.indexOf("t('gridColService')")).toBeLessThan(head.indexOf("t('gridColEntitlement')"));
    // Days print through the shared formatter (4a1abc4a), never re-rounded for a new column.
    expect(block).toContain('{formatDays(r.days)}');
    // The grid sits ABOVE the tables list: it is the reading, the list is the editor.
    expect(block.indexOf("t('gridTitle')")).toBeLessThan(block.indexOf("t('templatesTitle')"));
  });

  it('the scheme-explainer note and its translator are gone from this page only', () => {
    expect(page).not.toContain('data-testid="scheme-explainer"');
    expect(page).not.toContain('entitlementStep.schemeExplainer');
    expect(page).not.toContain("getTranslations('admin.leaveConfigTypes')");
    // Still rendered where the schemes actually are.
    expect(read('app/admin/leave-config/types/leave-type-tabs.tsx')).toContain("tTabs('entitlementStep.schemeExplainer')");
  });

  it('the page comment no longer names a health card this page does not render', () => {
    expect(page).not.toContain('the health card above');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// §C · the words
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('§C · the nine keys the grid mints, and the two sentences that went stale', () => {
  const KEYS = [
    'gridTitle',
    'gridColLeaveType',
    'gridColGrade',
    'gridColService',
    'gridColEntitlement',
    'gridColTable',
    'gridEveryoneElse',
    'gridDefaultSuffix',
    'gridNoGrade',
  ];

  it('every new key resolves in all six catalogues, non-empty and actually translated', () => {
    const en = catalogue('en').admin.entitlementTemplates;
    for (const loc of LOCALES) {
      const cat = catalogue(loc).admin.entitlementTemplates;
      for (const k of KEYS) {
        expect(typeof cat[k], `${loc}.${k}`).toBe('string');
        expect(cat[k].length, `${loc}.${k}`).toBeGreaterThan(0);
        if (loc !== 'en') expect(cat[k], `${loc}.${k} is still English`).not.toBe(en[k]);
      }
    }
  });

  it('the screen really asks for all nine, or they are six catalogues of dead strings', () => {
    const block = read(BLOCK);
    for (const k of KEYS) expect(block, k).toContain(`t('${k}')`);
  });

  it('coexistNote no longer points BELOW at a section that is not on the screen', () => {
    const en = catalogue('en').admin.entitlementTemplates.coexistNote;
    expect(en).not.toContain('below');
    expect(en).toContain('Leave types tab');
    for (const loc of LOCALES) {
      const v = catalogue(loc).admin.entitlementTemplates.coexistNote;
      expect(typeof v, loc).toBe('string');
      if (loc !== 'en') expect(v, `${loc} coexistNote is still English`).not.toBe(en);
    }
  });

  it('IA §3.2 F33 no longer promises eligibility on a screen that no longer carries it', () => {
    const f33 = read(IA)
      .split('\n')
      .find((l) => l.startsWith('| F33 |'))!;
    expect(f33, 'the F33 row must still exist — the anti-drop guard is keyed to this table').toBeTruthy();
    expect(f33).not.toContain('Entitlement tables + eligibility');
    expect(f33).toContain('r270');
  });
});
