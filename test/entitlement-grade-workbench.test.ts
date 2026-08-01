/**
 * Refactor Entitlement Configuration Workflow (feedback 387792a4), narrowed by b1b81a08.
 *
 * 387792a4 turned the Benefit Schemes sub-step into a THREE-panel workbench inside BenefitSchemeConfig:
 *   Panel A — Grade Master (the server-composed GradeCatalog slot, `gradesPanel`), with a drag handle per
 *             active grade that could be dropped onto a Panel B group row;
 *   Panel B — Grade Groups: create/rename/delete + membership;
 *   Panel C — Assignment: the Benefit Schemes list (Company × Employment Type × Grade Group per scheme).
 *
 * b1b81a08 moved grade MASTER data out of Leave Config to Settings → System Labels → Organisation Labels,
 * because a grade is organisation-level master data (it also drives claim limits, approval routing and
 * payroll banding), not leave-specific configuration. Panel A and the grade→group DRAG shortcut that only
 * existed to feed it are therefore gone, and the workbench is a TWO-panel grid: Grade Groups · Assignment.
 * The tick-box membership editor inside each group row — always the accessible path, and always the write
 * the drop delegated to — is the surviving way to put a grade into a group, and is unchanged.
 *
 * This suite now pins the two-panel contract plus that surviving membership editor. Static source guard
 * (repo convention for this DOM-runner-less feature area — see benefit-scheme-scoped-step.test.ts); the
 * round-trip of a membership save through the real action + DB is exercised below against core.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createGradeGroup,
  listGradeGroups,
  updateGradeGroup,
} from '../core/benefit-scheme';
import { createJobGrade } from '../core/admin';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const configSrc = readFileSync(resolve(here, '../components/benefit-scheme-config.tsx'), 'utf8');
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');

describe('b1b81a08 · the workbench is now TWO panels — Grade Groups · Assignment', () => {
  it('renders a grid that is ONE column by default and TWO at xl (the stacking contract)', () => {
    expect(configSrc).toContain('grid grid-cols-1 items-start gap-4 xl:grid-cols-2');
    // The three-column form is gone with Panel A.
    expect(configSrc.includes('xl:grid-cols-3')).toBe(false);
  });

  it('panel order inside the grid is Grade Groups → Assignment', () => {
    const grid = configSrc.indexOf('grid grid-cols-1 items-start gap-4 xl:grid-cols-2');
    const groups = configSrc.indexOf("t('groupsTitle')");
    const schemes = configSrc.indexOf("t('schemesTitle')");
    expect(grid).toBeGreaterThan(-1);
    expect(groups).toBeGreaterThan(grid);
    expect(schemes).toBeGreaterThan(groups);
  });

  it('the per-scheme Leave Entitlements area still renders full-width BELOW the workbench grid', () => {
    const groups = configSrc.indexOf("t('groupsTitle')");
    const ent = configSrc.indexOf("t('entTitle')");
    expect(groups).toBeGreaterThan(-1);
    expect(ent).toBeGreaterThan(groups);
  });

  it('both surviving panels keep their sticky headers', () => {
    expect(configSrc.match(/sticky top-0 z-10 rounded-t-lg border-b border-border bg-card/g)?.length).toBe(2);
  });
});

describe('b1b81a08 · Panel A and its drag wiring are gone (over-deletion guard included)', () => {
  it('the component no longer declares or renders a gradesPanel slot', () => {
    expect(configSrc.includes('gradesPanel')).toBe(false);
    expect(pageSrc.includes('gradesPanel=')).toBe(false);
  });

  it('the grade→grade-group drag wiring is gone with the panel that fed it', () => {
    for (const gone of [
      'gradeSensors',
      'onGradeDragStart',
      'onGradeDragEnd',
      'activeGradeId',
      'GradeGroupItem',
      'gradeGroup:${group.id}',
      "t('dropGradeHint')",
      "t('gradeAlreadyInGroup'",
    ]) {
      expect(configSrc.includes(gone), `${gone} removed`).toBe(false);
    }
  });

  it('the entitlement pool/row drag is GONE, and nothing drags on this screen any more', () => {
    // INVERTED IN r88 (1ef1cf95). This assertion was written during the GRADES relocation (b1b81a08),
    // where the per-scheme entitlement pool/row drag (R47 d6f88c2f) genuinely WAS unrelated collateral —
    // hence its original name, "must not over-delete". For 1ef1cf95 that same DndContext is the TARGET:
    // a shared leave group is no longer a property of a benefit scheme, so the drag that created one by
    // dropping a row onto a pool has no subject left. Keeping the old assertion would have re-asserted
    // the mechanism the reporter explicitly rejected.
    //
    // Both DndContexts in this file are now gone — grades by b1b81a08, pools by 1ef1cf95 — so the
    // stronger and simpler claim is that the screen has no drag surface at all. That also pins the
    // dead-import cleanup: a lingering @dnd-kit import is how the next reader concludes it still drags.
    expect(configSrc).not.toContain('<DndContext');
    expect(configSrc).not.toContain('useDroppable({ id: `pool:${pool.id}` })');
    expect(configSrc).not.toContain('useDroppable({ id: `row:${ent.id}` })');
    expect(configSrc).not.toMatch(/from '@dnd-kit\//);
  });

  it('the grade LIST is still loaded by the page and still fed to the config', () => {
    // Relocating the EDITOR must not orphan the readers: the scope dropdown, the preview dialog and the
    // grade-group membership tick-boxes all still need the grade rows.
    expect(pageSrc).toContain('listJobGrades(s, { includeArchived: true })');
    expect(pageSrc).toContain('const gradeOptions = grades.filter((g) => !g.archivedAt)');
    expect(configSrc).toContain('grades: Grade[]');
  });
});

describe('b1b81a08 · the tick-box grade-group membership editor is the surviving path', () => {
  it('each group row posts updateGradeGroup with one gradeIds entry per member', () => {
    expect(configSrc).toContain('<form action={actions.updateGradeGroup} className="space-y-3">');
    expect(configSrc).toContain('name="gradeIds"');
    expect(configSrc).toContain('defaultChecked={g.gradeIds.includes(gr.id)}');
    // The empty-state string is shared by the edit form and the create form and must be kept.
    expect(configSrc.match(/t\('noGrades'\)/g)?.length).toBe(2);
  });

  it('each group row still shows how many grades it holds', () => {
    expect(configSrc).toContain("t('memberCount', { count: g.gradeIds.length })");
  });
});

describe('b1b81a08 · the membership write itself still round-trips', () => {
  let b: Base;
  const ctx = () => adminCtx(b);

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('adds and removes grades from a group through the same full-member-list write the tick-boxes post', async () => {
    const g1 = await createJobGrade(ctx(), { code: 'EXEC', name: 'Executive', rank: 1 });
    const g2 = await createJobGrade(ctx(), { code: 'MGR', name: 'Manager', rank: 2 });
    const group = await createGradeGroup(ctx(), { name: 'Senior band', gradeIds: [g1.id] });

    // Tick g2 on: the form posts the FULL member list (existing ∪ newly ticked).
    await updateGradeGroup(ctx(), { id: group.id, name: 'Senior band', gradeIds: [g1.id, g2.id] });
    let groups = await listGradeGroups(ctx());
    expect(new Set(groups.find((g) => g.id === group.id)!.gradeIds)).toEqual(new Set([g1.id, g2.id]));

    // Untick g1: same write shape, shorter list.
    await updateGradeGroup(ctx(), { id: group.id, name: 'Senior band', gradeIds: [g2.id] });
    groups = await listGradeGroups(ctx());
    expect(groups.find((g) => g.id === group.id)!.gradeIds).toEqual([g2.id]);
  });
});
