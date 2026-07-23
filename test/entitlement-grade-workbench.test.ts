/**
 * Refactor Entitlement Configuration Workflow (feedback 387792a4).
 *
 * The Benefit Schemes sub-step of the Entitlement step (7b945408) used to stack Grade Master, Grade
 * Groups, Benefit Schemes and the per-scheme entitlements into one long vertical scroll. It is now a
 * three-panel workbench inside BenefitSchemeConfig:
 *   Panel A — Grade Master: the server-composed GradeCatalog slot (gradesPanel), which gained a
 *             code/name search filter and a drag handle per active grade.
 *   Panel B — Grade Groups: create/rename/delete + membership, each group row a drop zone for grades
 *             dragged from Panel A; the click-based checkbox path stays as the accessible fallback.
 *   Panel C — Assignment: the Benefit Schemes list (Company × Employment Type × Grade Group per scheme).
 * The grid is xl:grid-cols-3 and stacks to ONE column below xl with sticky panel headers; the per-scheme
 * Leave Entitlements area renders full-width BELOW the workbench, unchanged. Drag-assignment posts the
 * SAME updateGradeGroup action (full member list) the checkbox fallback posts — one write path, so the
 * Service Based Entitlements sub-step keeps auto-populating from the same rows (the actions revalidate
 * the entitlements path on every save).
 *
 * Static source guard (repo convention for this DOM-runner-less feature area — see
 * benefit-scheme-scoped-step.test.ts). What a static test CANNOT prove — the actual drag interaction,
 * regrouping, delete guard rails, downstream table sync and mobile stacking — is assigned to browser
 * verification.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const configSrc = readFileSync(resolve(here, '../components/benefit-scheme-config.tsx'), 'utf8');
const catalogSrc = readFileSync(resolve(here, '../components/grade-catalog.tsx'), 'utf8');
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('387792a4 · the three-panel grid — side by side at xl, stacked below (drift guard)', () => {
  it('renders a grid that is ONE column by default and three at xl (the stacking contract)', () => {
    expect(configSrc).toContain('grid grid-cols-1 items-start gap-4 xl:grid-cols-3');
  });

  it('panel order inside the grid is A (gradesPanel) → B (Grade Groups) → C (Assignment)', () => {
    const grid = configSrc.indexOf('grid grid-cols-1 items-start gap-4 xl:grid-cols-3');
    const a = configSrc.indexOf('{gradesPanel}');
    const b = configSrc.indexOf("t('groupsTitle')");
    const c = configSrc.indexOf("t('schemesTitle')");
    expect(grid).toBeGreaterThan(-1);
    expect(a).toBeGreaterThan(grid);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('the per-scheme Leave Entitlements area renders full-width BELOW the workbench grid', () => {
    // The entitlements section sits after the workbench DndContext closes — outside the grid.
    const gridClose = configSrc.indexOf('</DndContext>');
    const ent = configSrc.indexOf("t('entTitle')");
    expect(gridClose).toBeGreaterThan(-1);
    expect(ent).toBeGreaterThan(gridClose);
  });

  it('panels B and C carry sticky headers; Panel A leans on its fold summary made sticky', () => {
    expect(configSrc.match(/sticky top-0 z-10 rounded-t-lg border-b border-border bg-card/g)?.length).toBe(2);
    expect(configSrc).toContain('[&_summary]:sticky [&_summary]:top-0 [&_summary]:z-10');
  });

  it('the page threads the shared grades node in as the gradesPanel slot (one node, no per-type fork)', () => {
    expect(pageSrc).toContain(
      '<BenefitSchemeConfig {...schemeConfigProps} scopeLeaveTypeId={lt.id} gradesPanel={gradesSection} />',
    );
    expect(configSrc).toContain('gradesPanel?: ReactNode');
  });
});

describe('387792a4 · Panel A — Grade Master search filter', () => {
  it('filters the catalogue client-side by grade code OR name, case-insensitively', () => {
    expect(catalogSrc).toContain("const [query, setQuery] = useState('')");
    expect(catalogSrc).toContain(
      'grades.filter((g) => g.code.toLowerCase().includes(q) || g.name.toLowerCase().includes(q))',
    );
    // The filtered list renders; the full list still feeds the empty state so search cannot fake "no grades".
    expect(catalogSrc).toContain('{visible.map((g) => {');
    expect(catalogSrc).toContain('{grades.length > 0 && visible.length === 0 && (');
    expect(catalogSrc).toContain("t('gradeSearchNoResults')");
  });

  it('the search input is labelled for AT and placeholdered from i18n', () => {
    expect(catalogSrc).toContain("aria-label={t('gradeSearchLabel')}");
    expect(catalogSrc).toContain("placeholder={t('gradeSearchPlaceholder')}");
  });
});

describe('387792a4 · drag-assignment writes the SAME rows as the click path', () => {
  it('Panel A exposes a grade:<id> drag handle per ACTIVE grade (archived grades are not draggable)', () => {
    expect(catalogSrc).toContain('useDraggable({ id: `grade:${gradeId}` })');
    expect(catalogSrc).toContain('{!g.archived && <GradeDragHandle gradeId={g.id} name={g.name} t={t} />}');
    expect(catalogSrc).toContain("aria-label={t('gradeDragAria', { name })}");
  });

  it('Panel B group rows are gradeGroup:<id> drop zones, disabled for archived groups', () => {
    expect(configSrc).toContain('useDroppable({ id: `gradeGroup:${group.id}`, disabled: group.archived })');
    // Valid-target highlight excludes rows the dragged grade already belongs to.
    expect(configSrc).toContain(
      'const validTarget = !!activeGradeId && !group.archived && !group.gradeIds.includes(activeGradeId)',
    );
  });

  it('the drop posts actions.updateGradeGroup with the FULL member list (existing ∪ dragged)', () => {
    // Same FormData shape the checkbox fallback's Save posts: id + name + one gradeIds entry per member.
    expect(configSrc).toContain("fd.set('id', group.id)");
    expect(configSrc).toContain("fd.set('name', group.name)");
    expect(configSrc).toContain("for (const id of [...group.gradeIds, gradeId]) fd.append('gradeIds', id)");
    expect(configSrc).toMatch(/startGradeAssign\(\(\) => \{\s*void actions\.updateGradeGroup\(fd\);\s*\}\)/);
  });

  it('the click-based checkbox path REMAINS as the accessible fallback (same action)', () => {
    // The Panel B update form still posts the same scheme-wide action with the same field names.
    expect(configSrc).toContain('<form action={actions.updateGradeGroup} className="space-y-3">');
    expect(configSrc).toContain('name="gradeIds"');
    // An already-member drop surfaces a notice instead of a silent no-op write.
    expect(configSrc).toContain("t('gradeAlreadyInGroup', { name: gradeById.get(gradeId)?.name ?? '—' })");
  });

  it('the dragged grade renders in a DragOverlay so panel overflow containers cannot clip it', () => {
    expect(configSrc).toContain('<DragOverlay>');
    expect(configSrc).toContain('{activeGrade ? (');
  });
});

describe('387792a4 · Panel B keeps the group member count visible', () => {
  it('each group row shows how many grades it holds', () => {
    expect(configSrc).toContain("t('memberCount', { count: g.gradeIds.length })");
  });
});

describe('387792a4 · i18n — all six locales', () => {
  it('ships every new workbench string, with the interpolations intact (en pins the wording)', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));
      const leave = msgs?.admin?.leave ?? {};
      for (const key of ['gradeSearchLabel', 'gradeSearchPlaceholder', 'gradeSearchNoResults', 'gradeDragAria']) {
        expect(typeof leave[key], `${loc}.admin.leave.${key}`).toBe('string');
        expect((leave[key] as string).length, `${loc}.admin.leave.${key} non-empty`).toBeGreaterThan(0);
      }
      expect(leave.gradeDragAria as string, `${loc}: gradeDragAria keeps {name}`).toContain('{name}');
      const bs = msgs?.admin?.benefitScheme ?? {};
      for (const key of ['dropGradeHint', 'gradeAlreadyInGroup']) {
        expect(typeof bs[key], `${loc}.admin.benefitScheme.${key}`).toBe('string');
        expect((bs[key] as string).length, `${loc}.admin.benefitScheme.${key} non-empty`).toBeGreaterThan(0);
      }
      expect(bs.gradeAlreadyInGroup as string, `${loc}: gradeAlreadyInGroup keeps {name}`).toContain('{name}');
    }
    const en = JSON.parse(readFileSync(resolve(here, '../messages/en.json'), 'utf8'));
    expect(en.admin.leave.gradeSearchLabel).toBe('Search grades');
    expect(en.admin.benefitScheme.gradeAlreadyInGroup).toBe('{name} is already in this group.');
  });
});

describe('387792a4 · downstream sync — assignments keep feeding Service Based Entitlements', () => {
  it('every workbench write posts an action that revalidates the entitlements page (ok(ENTITLEMENTS))', () => {
    // The grade-group + scheme actions all fail/ok against the ENTITLEMENTS path, which revalidates the
    // page — so a Panel B/C save re-renders the Service Based Entitlements sub-step's table without a
    // manual refresh. Pinned at the action layer: each workbench action ends with ok(ENTITLEMENTS).
    const actionsSrc = readFileSync(resolve(here, '../app/admin/actions.ts'), 'utf8');
    expect(actionsSrc).toContain("const ENTITLEMENTS = '/admin/leave/entitlements'");
    expect(actionsSrc).toMatch(/function ok\(path: string\): never \{\s*revalidatePath\(path\);/);
    for (const action of [
      'createGradeGroupAction',
      'updateGradeGroupAction',
      'deleteGradeGroupAction',
      'createBenefitSchemeAction',
      'updateBenefitSchemeAction',
      'deleteBenefitSchemeAction',
    ]) {
      const start = actionsSrc.indexOf(`export async function ${action}(`);
      expect(start, `${action} exists`).toBeGreaterThan(-1);
      const body = actionsSrc.slice(start, actionsSrc.indexOf('export async function', start + 1));
      expect(body.includes('ok(ENTITLEMENTS)'), `${action} revalidates ENTITLEMENTS`).toBe(true);
    }
  });
});
