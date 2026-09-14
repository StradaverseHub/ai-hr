import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { entitlementGridRows } from '@/app/admin/leave/entitlements/templates/entitlement-tables-block';

/**
 * r271 (6d29e11c) — THE ENTITLEMENT TABLES ARE ONE TABLE.
 *
 * r270 built the reporter's four-column view as a SECOND Card above the managed list. The approved sketch
 * drew one table, and the item it came from was a complaint about the facts being split across two blocks;
 * shipping a third block was the wrong answer to it, and it described every version twice — once with its
 * figures, once with its buttons.
 *
 * The risk in merging is subtraction, not addition. The grid only ever drew versions IN FORCE, while the
 * list drew every version including stopped ones — and a stopped version's row is the only place its
 * lineage's Delete button lives. A careless merge takes rows off the screen along with the only way to
 * clear them. Most of what follows is about what must NOT disappear.
 */

const BLOCK = 'app/admin/leave/entitlements/templates/entitlement-tables-block.tsx';
const read = (p: string) => readFileSync(p, 'utf8');
const block = read(BLOCK);

const bands = [
  { fromYears: 0, toYears: 2, days: 16 },
  { fromYears: 2, toYears: 5, days: 18 },
  { fromYears: 5, toYears: null, days: 20 },
];
const table = (over: Record<string, unknown> = {}) =>
  ({
    id: 'v1',
    lineageId: 'lin-a',
    leaveTypeId: 'annual',
    name: 'GP1215',
    validFrom: '2026-01-01',
    validTo: null,
    serviceBands: bands,
    ...over,
  }) as Parameters<typeof entitlementGridRows>[0]['templates'][number];

const rowsFor = (over: Partial<Parameters<typeof entitlementGridRows>[0]> = {}) => {
  const templates = over.templates ?? [table()];
  return entitlementGridRows({
    templates,
    inForceIds: new Set(templates.map((x) => x.id)),
    rulesByTemplateLineage: new Map(),
    defaultLineageByType: new Map(),
    soleTableTypeIds: new Set(),
    ...over,
  });
};

describe('§A · nothing falls off the screen', () => {
  it('a STOPPED version still produces rows, so its Delete button still has somewhere to live', () => {
    const rows = rowsFor({
      templates: [table({ id: 'v-old', validFrom: '2025-01-01', validTo: '2026-01-01' })],
      inForceIds: new Set(),
    });
    expect(rows.length, 'one row per service step, the same as a live version').toBe(3);
    expect(rows.every((r) => r.reach.kind === 'stopped')).toBe(true);
    // It reaches nobody — and that is a DIFFERENT fact from "no benefit scheme names this table", which
    // is about a live table. Conflating them is how a closed year's record starts looking like a fault.
    expect(rows[0].reach.kind).not.toBe('unreached');
    expect(rows[0].validTo).toBe('2026-01-01');
  });

  it('a version with NO service bands still produces a row, rather than vanishing with its controls', () => {
    const rows = rowsFor({ templates: [table({ serviceBands: [] })] });
    expect(rows.length, 'a table that hands out nothing is a fault somebody must be able to see').toBe(1);
    expect(rows[0].fromYears).toBeNull();
    expect(rows[0].days).toBeNull();
    expect(rows[0].firstOfTable, 'and it still carries the group cells').toBe(true);
  });

  it('a stopped version is NOT credited with the schemes that name its lineage', () => {
    // A scheme names a LINEAGE. Drawing it against a closed version would say people receive these days.
    const rows = rowsFor({
      templates: [table({ id: 'v-old', validTo: '2026-01-01' })],
      inForceIds: new Set(),
      rulesByTemplateLineage: new Map([['lin-a', [{ id: 'r1', criteria: { gradeIds: ['g1'] } }]]]),
    });
    expect(rows.every((r) => r.reach.kind === 'stopped')).toBe(true);
  });
});

describe('§B · the controls are drawn once per VERSION, never once per row', () => {
  it('firstOfTable is true exactly once, even when two schemes each expand the same bands', () => {
    const rows = rowsFor({
      rulesByTemplateLineage: new Map([
        [
          'lin-a',
          [
            { id: 'r1', criteria: { gradeIds: ['g1'] } },
            { id: 'r2', criteria: { departmentIds: ['d1'] } },
          ],
        ],
      ]),
    });
    expect(rows.length, 'two schemes x three bands').toBe(6);
    // The whole point: Edit / Stop / Delete hang off this flag. Twice would draw two Delete buttons for
    // one table, and a reader cannot tell which one they are about to press.
    expect(rows.filter((r) => r.firstOfTable).length).toBe(1);
    expect(rows[0].firstOfTable).toBe(true);
  });

  it('the Job grade cell is drawn once per SCHEME, so it does not repeat down a version’s bands', () => {
    const rows = rowsFor({
      rulesByTemplateLineage: new Map([
        [
          'lin-a',
          [
            { id: 'r1', criteria: { gradeIds: ['g1'] } },
            { id: 'r2', criteria: { departmentIds: ['d1'] } },
          ],
        ],
      ]),
    });
    expect(rows.filter((r) => r.firstOfReach).length, 'once at the head of each scheme’s band run').toBe(2);
    expect(rows.map((r) => r.firstOfReach)).toEqual([true, false, false, true, false, false]);
  });

  it('every row still names the version it came from, so the group head can find its controls', () => {
    expect(rowsFor().every((r) => r.templateId === 'v1')).toBe(true);
  });
});

describe('§C · in force means the date test, not "nothing has superseded it"', () => {
  it('a FUTURE-dated supersede leaves the live version in force and the future one stopped', () => {
    // r270 D2, now pinned through the merged derivation. `validTo == null` is the FUTURE row here.
    const live = table({ id: 'v-live', validFrom: '2026-01-01', validTo: '2027-01-01' });
    const future = table({ id: 'v-future', validFrom: '2027-01-01', validTo: null });
    const rows = entitlementGridRows({
      templates: [live, future],
      inForceIds: new Set(['v-live']),
      rulesByTemplateLineage: new Map(),
      defaultLineageByType: new Map(),
      soleTableTypeIds: new Set(['annual']),
    });
    const byVersion = new Map(rows.map((r) => [r.templateId, r.reach.kind]));
    expect(byVersion.get('v-live'), 'the one deciding pay today reaches everyone').toBe('everyone');
    expect(byVersion.get('v-future'), 'next year’s figures are not today’s').toBe('stopped');
    // And BOTH are on the screen: the future one is what an operator opens to correct a mistake.
    expect(new Set(rows.map((r) => r.templateId)).size).toBe(2);
  });
});

describe('§D · one table on the screen, on both mounts', () => {
  it('there is no second Card and no second heading', () => {
    expect(block, 'the grid heading retired with the Card it headed').not.toContain("t('gridTitle')");
    expect(block, 'the merged table carries the list’s own heading').toContain("t('templatesTitle')");
    // One `<tbody>` fed by one derivation: a second `.map` over templates would be the second
    // implementation the merge exists to remove.
    expect((block.match(/gridRows\.map\(/g) ?? []).length).toBe(1);
    expect(block).not.toMatch(/\{templates\.map\(\(x\) => \(\s*<tr/);
  });

  it('the merged table renders wherever the list does — it is NOT gated to the unfiltered mount', () => {
    expect(block).not.toContain('const gridRows = scoped');
    expect(block).toContain('const gridRows = entitlementGridRows({');
    // …and `scoped` still hides the Leave type column, because on a leave type’s own tab every row is
    // that type and naming it on each line is noise.
    expect(block).toContain("{scoped ? null : <th className=\"px-3 py-2\">{t('gridColLeaveType')}</th>}");
  });

  it('the group cells are drawn on the group head only, not on every row', () => {
    /**
     * ⚠️ THIS ASSERTION WAS VACUOUS ON ITS FIRST WRITE, and the mutation pass caught it. It looked for
     * `r.firstOfTable` within 260 characters BEFORE each cell — and the row's own
     * `className={r.firstOfTable ? …}` sits a few characters above, so stripping the condition off the
     * Leave type cell left the test green. A proximity window around a flag that also appears on the
     * enclosing element measures nothing.
     *
     * Pinned as the exact conditional each cell is wrapped in. Brittle by design: these four cells are
     * the difference between a table that reads as one entry per version and one that repeats a leave
     * type, a name, a date and a Delete button down every service step.
     */
    expect(block, 'leave type').toContain('{r.firstOfTable ? (typeNameById.get(r.leaveTypeId) ?? dash) : null}');
    expect(block, 'table name').toMatch(/\{r\.firstOfTable \? \(\s*<>\s*\{r\.tableName\}/);
    expect(block, 'in-force window').toMatch(/\{r\.firstOfTable \? \(\s*<>\s*\{r\.validFrom\}/);
    expect(block, 'the controls').toContain('{r.firstOfTable && x ? (');
    // The Job grade cell hangs off the REACH, not the version: two schemes on one table must each label
    // their own band run.
    expect(block, 'job grade').toContain('{r.firstOfReach ? gridGradeCell(r.reach) : null}');
  });

  it('the empty state survives the merge, keyed on the rows the table actually draws', () => {
    expect(block).toContain('gridRows.length === 0');
    expect(block).toContain("t('templatesNone')");
    expect(block).toContain('colSpan={mergedCols}');
  });
});
