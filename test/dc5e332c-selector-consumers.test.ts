/** Consumer regressions: configured text changes, stable option identities and scope do not. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as s from '../db/schema';
import { criteriaVocabulary } from '../app/(app)/admin/notice-board/criteria-options';
import { overtimePatternSetup } from '../packs/attendance/overtime-patterns';
import { onboardingOptions, onboardingSetup } from '../packs/lifecycle/onboarding/service';
import { resolveMyTeamScope } from '../core/my-team-scope';
import { listJobGrades } from '../core/read';
import { buildOrgCriteriaSections } from '../core/org-criteria-form';
import { organisationChoiceLabels } from '../lib/organisation-choice-label';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
let b: Base;
beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb(); b = await seedBase();
  for (const module of ['attendance', 'lifecycle']) await setModule(b.tenantId, module, 'active');
  await owner.db.update(s.department).set({ label: 'People Operations', description: 'Department detail' }).where(eq(s.department.id, b.deptA));
  await owner.db.update(s.department).set({ label: 'People Operations' }).where(eq(s.department.id, b.deptB));
  await owner.db.update(s.position).set({ label: 'People Partner', description: 'Position detail' }).where(eq(s.position.id, b.positionId));
});
afterAll(closeAll);

describe('configured organisation labels in remaining selector owners', () => {
  it('keeps the canonical Job Grade Label ahead of Description through the real criteria consumer', async () => {
    const [created] = await owner.db.insert(s.jobGrade).values({
      tenantId: b.tenantId, code: 'JG-SELECTOR', name: 'Principal Specialist',
      description: 'Internal grade detail that is not its configured Label', rank: 7,
    }).returning();
    const grades = await listJobGrades(await entitledCtx(b));
    const row = grades.find(g => g.id === created.id)!;
    expect(row).toMatchObject({ id: created.id, code: created.code, name: created.name, description: created.description });
    expect(organisationChoiceLabels(grades).find(g => g.id === created.id)?.displayLabel).toBe(created.name);
    const translate = (key: string) => key;
    const sections = buildOrgCriteriaSections({
      companies: [], departments: [], positions: [], costCenters: [], businessUnits: [], profileOptions: {}, grades,
    }, { crit: translate, org: translate, employmentType: translate });
    const grade = sections.flatMap(section => section.fields).find(field => field.name === 'gradeIds');
    expect(grade?.options?.find(option => option.value === created.id)).toEqual({ value: created.id, label: created.name });
    const [stored] = await owner.db.select().from(s.jobGrade).where(eq(s.jobGrade.id, created.id));
    expect(stored).toEqual(created);
  });
  it('uses qualified department labels in Notice audience choices and reflects a rename on reload', async () => {
    const ctx = await entitledCtx(b);
    const before = await criteriaVocabulary(ctx);
    for (const id of [b.deptA, b.deptB]) expect(before.departments.find(d => d.value === id)?.label).toMatch(/^People Operations \(.+\)$/);
    expect(new Set(before.departments.map(d => d.label)).size).toBe(before.departments.length);
    await owner.db.update(s.department).set({ label: 'Talent Services' }).where(eq(s.department.id, b.deptA));
    const after = await criteriaVocabulary(ctx);
    expect(after.departments.find(d => d.value === b.deptA)?.label).toBe('Talent Services');
    expect(after.departments.map(d => d.value)).toEqual(before.departments.map(d => d.value));
  });
  it('qualifies same-label profile dimensions without changing their submitted values', async () => {
    await owner.db.insert(s.profileOption).values([
      { tenantId: b.tenantId, category: 'division', value: 'DIV-A', label: 'Services' },
      { tenantId: b.tenantId, category: 'division', value: 'DIV-B', label: 'Services' },
    ]);
    const value = await criteriaVocabulary(await entitledCtx(b));
    const options = value.orgCriteria.flatMap(c => c.options).filter(o => ['DIV-A', 'DIV-B'].includes(o.value));
    expect(options).toEqual(expect.arrayContaining([{ value: 'DIV-A', label: 'Services (DIV-A)' }, { value: 'DIV-B', label: 'Services (DIV-B)' }]));
  });
  it('uses configured Overtime labels and keeps requested company scope and archived filtering', async () => {
    const [unit] = await owner.db.insert(s.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'OPS', name: 'Legacy operations', label: 'Operations' }).returning();
    const [outside] = await owner.db.insert(s.company).values({ tenantId: b.tenantId, legalName: 'Outside selected company' }).returning();
    const [outsideDepartment] = await owner.db.insert(s.department).values({ tenantId: b.tenantId, companyId: outside.id, name: 'OUT', label: 'Outside choice' }).returning();
    const ctx = await entitledCtx(b), setup = await overtimePatternSetup(ctx, { companyIds: [b.companyId] });
    expect(setup.choices.departmentId?.some(o => o.id === outsideDepartment.id)).toBe(false);
    expect(setup.choices.positionId?.find(o => o.id === b.positionId)?.label).toBe('People Partner');
    expect(setup.choices.businessUnitId?.find(o => o.id === unit.id)?.label).toBe('Operations');
    expect(setup.choices.departmentId?.find(o => o.id === b.deptA)?.label).toMatch(/^People Operations \(.+\)$/);
    await owner.db.update(s.position).set({ label: '  ', description: 'Partner fallback' }).where(eq(s.position.id, b.positionId));
    expect((await overtimePatternSetup(ctx, { companyIds: [b.companyId] })).choices.positionId?.find(o => o.id === b.positionId)?.label).toBe('Partner fallback');
    await owner.db.update(s.position).set({ archivedAt: new Date() }).where(eq(s.position.id, b.positionId));
    expect((await overtimePatternSetup(ctx, { companyIds: [b.companyId] })).choices.positionId?.some(o => o.id === b.positionId)).toBe(false);
  });
  it('uses current labels in Onboarding configuration and My Team department choices', async () => {
    const ctx = await entitledCtx(b); await onboardingSetup(ctx);
    const options = await onboardingOptions(ctx);
    expect(options.title.find(o => o.id === b.positionId)?.name).toBe('People Partner');
    expect(options.department.find(o => o.id === b.deptA)?.name).toMatch(/^People Operations \(.+\)$/);
    const scope = await resolveMyTeamScope(ctx, { view: 'month', scope: 'department', companyIds: [b.companyId], locale: 'en' });
    expect(scope.departments.find(o => o.id === b.deptA)?.name).toMatch(/^People Operations \(.+\)$/);
    expect(scope.departments.map(o => o.id).sort()).toEqual([b.deptA, b.deptB].sort());
  });
});
