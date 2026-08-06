/**
 * Move "Grade" configuration to System Settings → System Label → Organisation Label (feedback b1b81a08).
 *
 * Grades are organisation-level master data — they set the seniority bands leave entitlements, benefit
 * schemes, claim limits and approval routing all read from — but the only place to maintain them was five
 * levels deep inside Leave Config (Entitlements → Benefit Schemes → Panel A). They now sit on the System
 * Labels Organisation-Labels rail beside Departments, Positions, Cost Centres and Business Units.
 *
 * NO MIGRATION: job_grade is untouched, so every foreign key (employment.grade_id, leave_policy.grade_id,
 * grade_group_member.grade_id, leave_approval_policy.grade_id, claim_policy.grade_id) keeps resolving and
 * nothing is re-entered. What this suite covers:
 *   1. Source guards for the relocation itself (rail entry, swapped body, the Leave Config removal, and an
 *      over-deletion guard on the unrelated entitlement drag context).
 *   2. The save FAN-OUT — one transaction per row, so a bad row in the middle of a batch cannot poison the
 *      good ones (the defect that makes core/admin.ts's bulkSaveLabels shape unusable here) — plus the
 *      rank-parsing trap that would otherwise persist every rank as 0.
 *   3. The widened delete guard: a grade referenced ONLY by an approval rule, ONLY by a claim limit or ONLY
 *      by a grade group now reports inUse and refuses deletion instead of raising a raw 23503 (or, for the
 *      cascading grade-group case, silently dropping benefit-scheme membership).
 *   4. The explicit admin gate on the new delete entry point.
 *   5. The five new i18n keys, in all six locales.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The new grid actions call requireAdmin() (which resolves getSession() and redirect()s a non-admin away)
// plus revalidatePath(). redirect() in real Next.js THROWS to abort the request, so the mock must throw
// too — the sentinel carries the target path so the permission test can assert the refusal.
let actionCtx: import('../db/client').SessionContext | null = null;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => actionCtx) }));
vi.mock('next/navigation', () => ({
  redirect: (p: string): never => {
    throw new RedirectError(p);
  },
  notFound: vi.fn(() => undefined),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));

import { createJobGrade } from '../core/admin';
import { createGradeGroup } from '../core/benefit-scheme';
import { createLeaveApprovalRule } from '../core/leave-approval-policy';
import { createClaimType, setClaimPolicy } from '../core/claims';
import { listJobGrades } from '../core/read';
import {
  removeJobGradeGridAction,
  saveJobGradesGridAction,
} from '../app/admin/settings/actions';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');
const gridSrc = read('../components/system-labels-grid.tsx');
const gradeGridSrc = read('../components/grade-labels-grid.tsx');
const labelsPageSrc = read('../app/admin/settings/system-labels/page.tsx');
const entitlementsPageSrc = read('../app/admin/leave/entitlements/page.tsx');
const adminActionsSrc = read('../app/admin/actions.ts');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

// ONE set of DB hooks for the whole file — closeAll() ends the SHARED postgres client, so a per-describe
// afterAll(closeAll) would tear the connection down before the later DB describes run.
let b: Base;
const ctx = () => adminCtx(b);
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  actionCtx = adminCtx(b);
});
afterAll(async () => {
  await closeAll();
});

describe('b1b81a08 · the destination — a fifth rail entry with its own body', () => {
  it('the System Labels rail renders a Grades entry with a live count', () => {
    expect(gridSrc).toContain("t('category.grade')");
    expect(gridSrc).toContain('gradesActiveCount');
    expect(gridSrc).toContain('setShowGrades(true)');
  });

  it('selecting Grades swaps the BODY for gradesSlot rather than re-pointing `kind`', () => {
    expect(gridSrc).toContain('gradesSlot?: ReactNode');
    expect(gridSrc).toContain('{showGrades && gradesSlot !== undefined ? (');
    // GridKind stays the four company-scoped kinds — no synthetic fifth kind, so every existing hook,
    // memo and derived value keeps running unchanged and no hook becomes conditional.
    expect(gridSrc).toContain(
      "export type GridKind = 'department' | 'position' | 'cost_center' | 'business_unit'",
    );
    expect(gridSrc).toContain("const KINDS: GridKind[] = ['department', 'position', 'cost_center', 'business_unit']");
  });

  it('the grade body carries NO company / scope / sharing wiring (job_grade is tenant-global)', () => {
    expect(existsSync(resolve(here, '../components/grade-labels-grid.tsx'))).toBe(true);
    for (const forbidden of [
      'companyId',
      'isGlobal',
      'assignedCompanyIds',
      'ScopePopover',
      'copyToCompanies',
      'setCompanyShared',
    ]) {
      expect(gradeGridSrc.includes(forbidden), `${forbidden} absent from the grade body`).toBe(false);
    }
  });

  // e3c733df round 2 — the Criteria HEADER is back (the reporter asked for it beside Rank, "exactly like
  // other category"), but only as a fixed read-only label. On the company-scoped kinds Criteria is the
  // sharing-scope cell; for a tenant-global catalog its one possible value is Global. The assertion above
  // still forbids every piece of the scope WIRING, so this cannot drift into an editable scope by accident.
  it('the grade body renders Criteria between Rank and Status as a fixed, non-editable Global label', () => {
    const at = (needle: string) => {
      const i = gradeGridSrc.indexOf(needle);
      return i < 0 ? Number.POSITIVE_INFINITY : i;
    };
    expect(gradeGridSrc).toContain("t('col.scope')");
    expect(gradeGridSrc).toContain("t('scopeGlobal')");
    // Column order: … Rank → Criteria → Status → Actions. `col.rank` first appears in its header cell.
    expect(at("t('col.rank')")).toBeLessThan(at("t('col.scope')"));
    expect(at("t('col.scope')")).toBeLessThan(at("t('col.status')"));
    expect(at("t('col.status')")).toBeLessThan(at("t('col.actions')"));
    // Rank keeps its numeric sort and its own header — restoring Criteria must not displace it.
    expect(gradeGridSrc).toContain("if (sortField === 'rank')");
    // Criteria is not sortable and not a form control: no toggleSort on it, and no scope field on RowState.
    expect(gradeGridSrc.includes("toggleSort('scope')")).toBe(false);
    expect(gradeGridSrc.includes("data-cell={`scope:")).toBe(false);
  });

  it('the grade body sorts Rank NUMERICALLY (2 before 10), not by localeCompare', () => {
    expect(gradeGridSrc).toContain("if (sortField === 'rank')");
    expect(gradeGridSrc).toContain('return sortDir === \'asc\' ? av - bv : bv - av;');
  });

  it('the grade body drops its in-body heading and no longer pins the header (sibling parity)', () => {
    // The category name now renders only from the rail (gridSrc, still guarded at the test above), so
    // the grade BODY must not repeat it as an in-body heading — asserted against gradeGridSrc, NOT gridSrc.
    expect(gradeGridSrc).not.toContain("t('category.grade')");
    // The header aligns with the four canonical siblings, which use a plain (non-sticky) thead.
    expect(gradeGridSrc).not.toContain('sticky top-0');
  });

  it('the page loads listJobGrades and no longer REPLACES the grid with the no-companies card', () => {
    expect(labelsPageSrc).toContain('listJobGrades(s, { includeArchived: true })');
    expect(labelsPageSrc).toContain('gradesSlot={gradesSlot}');
    // Grades are tenant-wide and were creatable before any company existed, so an empty company scope must
    // not make the rail unreachable: the notice renders ABOVE the grid, never instead of it.
    expect(labelsPageSrc).toContain('{gridCompanies.length === 0 && (');
    expect(labelsPageSrc.includes('gridCompanies.length === 0 ? (')).toBe(false);
    // Grades must NOT be narrowed by the company scope filter.
    expect(labelsPageSrc.includes('inScope(grades)')).toBe(false);
  });
});

describe('b1b81a08 · the origin — Grade is gone from Leave Config', () => {
  it('components/grade-catalog.tsx is deleted', () => {
    expect(existsSync(resolve(here, '../components/grade-catalog.tsx'))).toBe(false);
  });

  it('the entitlements page composes no GradeCatalog and no gradesSection', () => {
    expect(entitlementsPageSrc.includes('GradeCatalog')).toBe(false);
    expect(entitlementsPageSrc.includes('const gradesSection = (')).toBe(false);
    expect(entitlementsPageSrc.includes('GRADES_OPEN_COOKIE')).toBe(false);
  });

  it('the four redirecting grade actions are gone from app/admin/actions.ts', () => {
    for (const action of [
      'export async function createJobGradeAction',
      'export async function updateJobGradeAction',
      'export async function archiveJobGradeAction',
      'export async function deleteJobGradeAction',
      'function gradeReturnAnchor',
    ]) {
      expect(adminActionsSrc.includes(action), `${action} removed`).toBe(false);
    }
  });

  // 6e9a126e RELEASE THREE — the `benefit-scheme-config no longer declares gradesPanel` case was removed
  // with the file it read. It asserted the ABSENCE of something in a source file that no longer exists,
  // which is a claim with nothing left to be true about. The other 23 cases here guard the System Labels
  // relocation itself and are untouched; the grade-group editor's own coverage moved to
  // test/grade-group-button-row.test.ts, repointed at components/leave/grade-group-config.tsx.

});

describe('b1b81a08 · the save fan-out — good rows commit, only the bad row is flagged', () => {
  it('saves BOTH good rows and flags only the duplicate-CODE row in the middle of a batch', async () => {
    await createJobGrade(ctx(), { code: 'EXEC', name: 'Executive' });
    const res = await saveJobGradesGridAction({
      creates: [
        { key: 'r1', code: 'JNR', name: 'Junior', description: '', rank: '1' },
        { key: 'r2', code: 'EXEC', name: 'Executive Two', description: '', rank: '2' },
        { key: 'r3', code: 'SNR', name: 'Senior', description: '', rank: '3' },
      ],
      updates: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.rowErrors).toHaveLength(1);
    expect(res.rowErrors[0].key).toBe('r2');
    expect(res.rowErrors[0].field).toBe('code');
    // The two GOOD rows committed — this is the whole point of a per-row transaction. Under the
    // bulkSaveLabels shape the r2 failure would abort the shared transaction and r3 would raise 25P02.
    const codes = (await listJobGrades(ctx(), { includeArchived: true })).map((g) => g.code);
    expect(codes).toContain('JNR');
    expect(codes).toContain('SNR');
    expect(codes.filter((c) => c === 'EXEC')).toHaveLength(1);
  });

  it('flags a duplicate NAME on exactly the offending row, and still saves the surrounding rows', async () => {
    await createJobGrade(ctx(), { code: 'EXEC', name: 'Executive' });
    const res = await saveJobGradesGridAction({
      creates: [
        { key: 'a', code: 'AAA', name: 'Band A', description: '', rank: '1' },
        { key: 'b', code: 'BBB', name: 'executive', description: '', rank: '2' },
        { key: 'c', code: 'CCC', name: 'Band C', description: '', rank: '3' },
      ],
      updates: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    // Exactly the middle row is flagged; the two good rows still committed (the fan-out guarantee).
    // NOTE the highlighted CELL is 'code': createJobGrade cannot tell a name clash from a code clash
    // (postgres.js does not populate `.constraint`, so its DuplicateError message is always the
    // "grade with code" wording), and the core is out of scope for this item. The row is still flagged
    // and the message the admin reads matches the cell.
    expect(res.rowErrors.map((e) => e.key)).toEqual(['b']);
    expect(res.rowErrors[0].field).toBe('code');
    const codes = (await listJobGrades(ctx(), { includeArchived: true })).map((g) => g.code);
    expect(codes).toEqual(expect.arrayContaining(['AAA', 'CCC']));
    expect(codes).not.toContain('BBB');
  });

  it('returns a CODE row error (not a thrown banner) for a badly-shaped code like "G-1"', async () => {
    const res = await saveJobGradesGridAction({
      creates: [{ key: 'x', code: 'G-1', name: 'Grade One', description: '', rank: '1' }],
      updates: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.rowErrors).toEqual([expect.objectContaining({ key: 'x', field: 'code' })]);
  });

  it('persists a rank typed as text as a real number (Number.isFinite("3") is false)', async () => {
    const res = await saveJobGradesGridAction({
      creates: [{ key: 'x', code: 'MGR', name: 'Manager', description: '', rank: '3' }],
      updates: [],
    });
    expect(res.ok).toBe(true);
    const row = (await listJobGrades(ctx(), { includeArchived: true })).find((g) => g.code === 'MGR')!;
    expect(row.rank).toBe(3);
  });

  it('returns a RANK row error for a non-numeric rank instead of silently storing 0', async () => {
    const res = await saveJobGradesGridAction({
      creates: [{ key: 'x', code: 'MGR', name: 'Manager', description: '', rank: 'ten' }],
      updates: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.rowErrors).toEqual([expect.objectContaining({ key: 'x', field: 'rank' })]);
    expect((await listJobGrades(ctx(), { includeArchived: true })).some((g) => g.code === 'MGR')).toBe(false);
  });

  it('an update that only renames does NOT emit a status event; flipping archived does', async () => {
    const g = await createJobGrade(ctx(), { code: 'EXEC', name: 'Executive', rank: 1 });
    const renamed = await saveJobGradesGridAction({
      creates: [],
      updates: [{ key: g.id, id: g.id, code: 'EXEC', name: 'Executive Band', description: '', rank: '1', setArchived: null }],
    });
    expect(renamed.ok).toBe(true);
    expect(await eventTypesFor(b.tenantId, g.id)).not.toContain('job-grade.archived');

    const archivedRes = await saveJobGradesGridAction({
      creates: [],
      updates: [{ key: g.id, id: g.id, code: 'EXEC', name: 'Executive Band', description: '', rank: '1', setArchived: true }],
    });
    expect(archivedRes.ok).toBe(true);
    expect(await eventTypesFor(b.tenantId, g.id)).toContain('job-grade.archived');
  });
});

describe('b1b81a08 · the widened delete guard — five referencing tables, not two', () => {
  it('a grade used ONLY by a leave approval rule reports inUse and refuses deletion', async () => {
    const g = await createJobGrade(ctx(), { code: 'EXEC', name: 'Executive' });
    await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      gradeId: g.id,
      levels: ['direct_manager'],
    });
    const row = (await listJobGrades(ctx(), { includeArchived: true })).find((r) => r.id === g.id)!;
    expect(row.inUse).toBe(true);
    const res = await removeJobGradeGridAction(g.id);
    expect(res.ok).toBe(false);
    expect((await listJobGrades(ctx(), { includeArchived: true })).some((r) => r.id === g.id)).toBe(true);
  });

  it('a grade used ONLY by a claim limit reports inUse and refuses deletion', async () => {
    const g = await createJobGrade(ctx(), { code: 'EXEC', name: 'Executive' });
    const ct = await createClaimType(ctx(), {
      code: 'MED',
      name: 'Medical',
      defaultTaxable: false,
      requiresReceipt: true,
    });
    await setClaimPolicy(ctx(), {
      claimTypeId: ct.id,
      annualBudget: 1000,
      perClaimCap: null,
      effectiveFrom: '2026-01-01',
      gradeId: g.id,
    });
    const row = (await listJobGrades(ctx(), { includeArchived: true })).find((r) => r.id === g.id)!;
    expect(row.inUse).toBe(true);
    const res = await removeJobGradeGridAction(g.id);
    expect(res.ok).toBe(false);
  });

  it('a grade that is ONLY a grade-group member reports inUse and refuses deletion', async () => {
    // grade_group_member CASCADES, so before this change the delete SUCCEEDED and silently dropped the
    // benefit-scheme group membership.
    const g = await createJobGrade(ctx(), { code: 'EXEC', name: 'Executive' });
    await createGradeGroup(ctx(), { name: 'Senior band', gradeIds: [g.id] });
    const row = (await listJobGrades(ctx(), { includeArchived: true })).find((r) => r.id === g.id)!;
    expect(row.inUse).toBe(true);
    const res = await removeJobGradeGridAction(g.id);
    expect(res.ok).toBe(false);
    expect((await listJobGrades(ctx(), { includeArchived: true })).some((r) => r.id === g.id)).toBe(true);
  });

  it('an unreferenced grade deletes and appends job-grade.deleted', async () => {
    const g = await createJobGrade(ctx(), { code: 'TMP', name: 'Temporary Band' });
    const row = (await listJobGrades(ctx(), { includeArchived: true })).find((r) => r.id === g.id)!;
    expect(row.inUse).toBe(false);
    const res = await removeJobGradeGridAction(g.id);
    expect(res.ok).toBe(true);
    expect((await listJobGrades(ctx(), { includeArchived: true })).some((r) => r.id === g.id)).toBe(false);
    expect(await eventTypesFor(b.tenantId, g.id)).toContain('job-grade.deleted');
  });

  it('a NON-ADMIN session is refused by the delete action (WITH CHECK does not cover DELETE)', async () => {
    const g = await createJobGrade(ctx(), { code: 'TMP', name: 'Temporary Band' });
    actionCtx = { ...adminCtx(b), roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
    await expect(removeJobGradeGridAction(g.id)).rejects.toBeInstanceOf(RedirectError);
    // Restore an admin ctx to confirm the row survived the refused attempt.
    actionCtx = adminCtx(b);
    expect((await listJobGrades(ctx(), { includeArchived: true })).some((r) => r.id === g.id)).toBe(true);
  });
});

describe('b1b81a08 · i18n — the five new keys resolve in all six locales', () => {
  it('ships category.grade, col.rank, gradeInUseHint, deleteGradeTitle and deleteGradeDescription', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`../messages/${loc}.json`));
      const sl = msgs?.admin?.systemLabels ?? {};
      expect(typeof sl.category?.grade, `${loc}.admin.systemLabels.category.grade`).toBe('string');
      expect((sl.category.grade as string).length).toBeGreaterThan(0);
      expect(typeof sl.col?.rank, `${loc}.admin.systemLabels.col.rank`).toBe('string');
      expect((sl.col.rank as string).length).toBeGreaterThan(0);
      for (const key of ['gradeInUseHint', 'deleteGradeTitle', 'deleteGradeDescription']) {
        expect(typeof sl[key], `${loc}.admin.systemLabels.${key}`).toBe('string');
        expect((sl[key] as string).length, `${loc}.admin.systemLabels.${key} non-empty`).toBeGreaterThan(0);
      }
      expect(sl.deleteGradeDescription as string, `${loc}: deleteGradeDescription keeps {name}`).toContain('{name}');
      // The orphaned col.name string is now the Grades grid's name header, so it must not still read
      // "Type Name" in en (the other locales are checked for presence by i18n-coverage).
      expect((sl.col.name as string).length).toBeGreaterThan(0);
    }
    const en = JSON.parse(read('../messages/en.json'));
    expect(en.admin.systemLabels.category.grade).toBe('Job Grade');
    expect(en.admin.systemLabels.col.rank).toBe('Rank');
    expect(en.admin.systemLabels.col.name).toBe('Grade Name');
  });

  // e3c733df round 2 — the restored Criteria column reuses the company-scoped grid's existing strings
  // rather than minting a grade-specific set, so the two tables read identically word for word.
  it('the Criteria column reuses col.scope / scopeGlobal / assignmentAll, present in all six locales', () => {
    for (const loc of LOCALES) {
      const sl = JSON.parse(read(`../messages/${loc}.json`))?.admin?.systemLabels ?? {};
      for (const [label, v] of [
        ['col.scope', sl.col?.scope],
        ['scopeGlobal', sl.scopeGlobal],
        ['assignmentAll', sl.assignmentAll],
      ] as const) {
        expect(typeof v, `${loc}.admin.systemLabels.${label}`).toBe('string');
        expect((v as string).length, `${loc}.admin.systemLabels.${label} non-empty`).toBeGreaterThan(0);
      }
    }
    const en = JSON.parse(read('../messages/en.json'));
    expect(en.admin.systemLabels.col.scope).toBe('Criteria');
    expect(en.admin.systemLabels.scopeGlobal).toBe('Global');
  });
});
