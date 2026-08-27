import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { isGroupAdmin } from '@/lib/authz';
import { listCompanies, listJobGrades } from '@/core/read';
import {
  listBusinessUnitsForLabels,
  listCostCentersForLabels,
  listDepartmentsForLabels,
  listPositionsForLabels,
} from '@/core/admin';
import { listLabelAssignments } from '@/core/system-labels';
import { EMPLOYMENT_PROFILE_CATEGORIES, listAllProfileOptions } from '@/core/profile-options';
// 9a65f808 — grade groups, through the leave PACK FACADE. `listGradeGroups` lives in core/benefit-scheme
// (a filename that is a leftover — see its header), which is a guarded leave-pack boundary module: the
// pages that may reach into it directly are the pack's own routes, and this is not one of them. Importing
// the facade is the sanctioned path and costs nothing; the alternative would have been a new entry on
// test/pack-drift-allowlist.json, a list documented to only ever shrink.
import { listGradeGroups } from '@/packs/leave/service';
import { Card, ErrorBanner, PageHeader } from '@/components/ui';
import { SystemLabelsGrid, type GridKind, type GridRecord } from '@/components/system-labels-grid';
import { GradeLabelsGrid } from '@/components/grade-labels-grid';
import { GradeGroupConfig } from '@/components/leave/grade-group-config';
import { ProfileOptionsGrid } from '@/components/profile-options-grid';
import { SystemLabelsTabs } from '@/components/system-labels-tabs';
import { removeProfileOptionAction, saveProfileOptionsAction } from './profile-options/actions';
import {
  assignLabelCompaniesAction,
  copyLabelsToCompaniesAction,
  removeJobGradeGridAction,
  restoreJobGradeGridAction,
  saveJobGradesGridAction,
  saveLabelsGridAction,
  setCompanySharedLabelsAction,
  setLabelGlobalAction,
  unassignLabelCompaniesAction,
} from '../actions';
// 9a65f808 — the three grade-group writes, unchanged, from app/admin/actions.ts (NOT the settings actions
// file above — the grade-group actions never moved, only their mount and their redirect did). Each calls
// `requireAdmin()` itself, which is the same predicate this page's own `scopedAdmin()` guard applies, so
// the move changes who can edit a grade group by nothing at all.
import {
  createGradeGroupAction,
  deleteGradeGroupAction,
  updateGradeGroupAction,
} from '../../actions';

export default async function SystemLabelsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const { error } = await searchParams;
  const t = await getTranslations('admin.systemLabels');
  // c9986927 — the relocated organisation categories keep their own existing i18n namespace; only their
  // maintenance surface moved, not their wording.
  const tp = await getTranslations('admin.profileOptions');
  // 9a65f808 — same discipline for the relocated Grade Groups editor: it reads `admin.benefitScheme` for
  // itself (the module name is a leftover — see components/leave/grade-group-config.tsx), and the page
  // reads the one string the RAIL needs from that same namespace. So the move orphans no key and mints
  // none: every string the card renders is already shipped in all six locales.
  const tGroups = await getTranslations('admin.benefitScheme');

  // ⚠️ A NAME ADDED TO THIS DESTRUCTURE MUST BE ADDED TO THE ARRAY BELOW IN THE SAME POSITION. Every
  // element is an array, so a mismatch shifts each later variable by one slot and NOTHING type-errors —
  // each catalogue silently becomes a different one.
  const [companies, departments, positions, costCenters, businessUnits, deptAssign, posAssign, ccAssign, buAssign, grades, profileOptions, gradeGroups] =
    await Promise.all([
      listCompanies(s, { includeArchived: true }),
      listDepartmentsForLabels(s),
      listPositionsForLabels(s),
      listCostCentersForLabels(s),
      listBusinessUnitsForLabels(s),
      listLabelAssignments(s, 'department'),
      listLabelAssignments(s, 'position'),
      listLabelAssignments(s, 'cost_center'),
      listLabelAssignments(s, 'business_unit'),
      // b1b81a08 — Grades moved here from Leave Config. Archived rows load too so the grid can show and
      // restore them. NOTE: grades are TENANT-WIDE, so they must NOT pass through inScope(...) below —
      // job_grade has no company_id to narrow on.
      listJobGrades(s, { includeArchived: true }),
      // c9986927 — Division / Branch / Region / Line / Section / Team / Base / Category are maintained
      // here now. Like grades they are TENANT-WIDE, so they must NOT pass through inScope(...) below.
      listAllProfileOptions(s, { activeOnly: false }),
      // 9a65f808 — grade groups, maintained here now for the same reason grades are: they are the
      // tenant's grade vocabulary, TENANT-WIDE (a group carries no company), and they must NOT pass
      // through inScope(...) below. Archived groups arrive too — the editor badges them and the editor is
      // the only surface that can un-archive one.
      listGradeGroups(s),
    ]);

  const scopedCompanies = scopeIds.length ? companies.filter((c) => scopeIds.includes(c.id)) : companies;
  const scopedIdSet = new Set(scopedCompanies.map((c) => c.id));

  // Assignment map: labelId → [companyId, …]. The origin company is always included so the Scope cell can
  // pre-check it (the origin is implicitly assigned; the backfill in 0157 wrote a self-assignment too).
  const assignMap = (rows: { labelId: string; companyId: string }[]) => {
    const m = new Map<string, string[]>();
    for (const r of rows) {
      const list = m.get(r.labelId) ?? [];
      list.push(r.companyId);
      m.set(r.labelId, list);
    }
    return m;
  };
  const deptMap = assignMap(deptAssign);
  const posMap = assignMap(posAssign);
  const ccMap = assignMap(ccAssign);
  const buMap = assignMap(buAssign);

  const norm = (
    r: {
      id: string;
      companyId: string;
      code?: string;
      name?: string;
      title?: string;
      jobFamily?: string | null;
      label?: string | null;
      businessUnitId?: string | null;
      headEmploymentId?: string | null;
      description?: string | null;
      isGlobal: boolean;
      archivedAt: Date | null;
      inUse: boolean;
      createdAt: Date | null;
      lastUpdatedAt: string | null;
      lastUpdatedBy: string | null;
    },
    map: Map<string, string[]>,
  ): GridRecord => ({
    id: r.id,
    companyId: r.companyId,
    code: r.code ?? '',
    name: r.name ?? '',
    title: r.title ?? '',
    jobFamily: r.jobFamily ?? '',
    label: r.label ?? '',
    businessUnitId: r.businessUnitId ?? null,
    headEmploymentId: r.headEmploymentId ?? null,
    description: r.description ?? '',
    isGlobal: r.isGlobal,
    archived: !!r.archivedAt,
    inUse: r.inUse,
    assignedCompanyIds: Array.from(new Set([r.companyId, ...(map.get(r.id) ?? [])])),
    createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    lastUpdatedAt: r.lastUpdatedAt,
    lastUpdatedBy: r.lastUpdatedBy,
  });

  const inScope = <T extends { companyId: string }>(rows: T[]) => rows.filter((r) => scopedIdSet.has(r.companyId));

  const data: Record<GridKind, GridRecord[]> = {
    department: inScope(departments).map((r) => norm(r, deptMap)),
    position: inScope(positions).map((r) => norm(r, posMap)),
    cost_center: inScope(costCenters).map((r) => norm(r, ccMap)),
    business_unit: inScope(businessUnits).map((r) => norm(r, buMap)),
  };

  // 71bacb95: the Business Unit select was removed from the Department config grid (the BU link is now
  // maintained via the employee's organisation assignment), so the per-company BU option list it fed is no
  // longer built or passed here. department.businessUnitId + its hire-form / payroll cascade are unchanged.
  // 797e3523: the Head column was removed from the System Labels surface, so employee/head options are no
  // longer loaded here. Dept/BU heads (approval routing) are maintained via the organisation admin surface.

  const gridCompanies = scopedCompanies.map((c) => ({ id: c.id, name: c.name, sharedSystemLabels: c.sharedSystemLabels }));

  const actions = {
    save: saveLabelsGridAction,
    setGlobal: setLabelGlobalAction,
    assign: assignLabelCompaniesAction,
    unassign: unassignLabelCompaniesAction,
    copyToCompanies: copyLabelsToCompaniesAction,
    setCompanyShared: setCompanySharedLabelsAction,
  };

  // b1b81a08 — the Grades body. Rows go in exactly as core/read.ts returns them (id, code, name, rank,
  // archivedAt, inUse); there is no mapper and no synthetic companyId / isGlobal / assignedCompanyIds,
  // because job_grade genuinely has none of those.
  const gradesSlot = (
    <GradeLabelsGrid
      data={grades}
      // r224 — `restore` is the third action: it takes the offer the save returns when a typed code turns
      // out to belong to an archived grade, bringing that grade back in place instead of duplicating it.
      actions={{
        save: saveJobGradesGridAction,
        remove: removeJobGradeGridAction,
        restore: restoreJobGradeGridAction,
      }}
    />
  );

  /**
   * 9a65f808 — the Grade Groups body, the rail entry directly after Grades.
   *
   * WHY IT IS HERE AND NOT ON A LEAVE SCREEN. The editor has had three addresses: Settings → Leave →
   * Entitlements (parked there when 6e9a126e deleted the workbench it lived inside), Settings → Leave →
   * Approval (f12d77e5, when a grade group was purely an approval-routing scope), and now here. What
   * changed is that 9a65f808 made a grade group the vocabulary of ENTITLEMENT ELIGIBILITY as well —
   * picking a group on Employee Eligibility fills in its member grades — so it is shared master data with
   * two consumers, and master data maintained inside one of its consumers is master data the other one's
   * admins cannot find. Beside Job Grades is where a named set of job grades belongs.
   *
   * The MEMBERSHIP tick-boxes are offered the ACTIVE grades only, deliberately, and this is the same
   * filter the two previous homes applied by hand: the form posts only the boxes it renders, so a group
   * member that is not shown would be dropped from the group on the next save. `grades` above is loaded
   * with `includeArchived: true` for the Grades GRID (which must be able to show and restore an archived
   * row), so the filter has to happen here rather than being inherited from the read.
   */
  const gradeGroupsSlot = (
    // `min-w-0 flex-1` because the rail and the body are one flex row and every other body carries it —
    // without it this card renders at its content width beside a column of empty space. The rail entry
    // already prints the title and the count, so the SectionHeader the two previous homes wrapped this in
    // is deliberately not repeated here.
    <div className="min-w-0 flex-1">
      <Card>
        <GradeGroupConfig
          gradeGroups={gradeGroups.map((g) => ({ id: g.id, name: g.name, gradeIds: g.gradeIds, archived: g.archived }))}
          grades={grades.filter((g) => g.archivedAt == null).map((g) => ({ id: g.id, name: g.name }))}
          actions={{
            createGradeGroup: createGradeGroupAction,
            updateGradeGroup: updateGradeGroupAction,
            deleteGradeGroup: deleteGradeGroupAction,
          }}
        />
      </Card>
    </div>
  );

  // c9986927 — one rail entry per relocated organisation category, each with the SAME editor Profile
  // Options used (create / edit / delete / activate / deactivate, value immutability, the in-use delete
  // guard) pointed at a single category. Nothing about the catalog itself changes — the same core
  // mutations run through the same actions, so stored employment values keep resolving untouched.
  const optionSlots = EMPLOYMENT_PROFILE_CATEGORIES.map((c) => ({
    key: c,
    label: tp(`category.${c}`),
    count: (profileOptions[c] ?? []).filter((r) => r.isActive).length,
    body: (
      <ProfileOptionsGrid
        hideRail
        categories={[c]}
        data={{ [c]: profileOptions[c] ?? [] }}
        actions={{ save: saveProfileOptionsAction, remove: removeProfileOptionAction }}
      />
    ),
  }));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <SystemLabelsTabs active="organisation" />
      <ErrorBanner message={error} />

      {/* b1b81a08 — this used to REPLACE the grid, which made the whole screen (and now Grades with it)
          unreachable on a fresh tenant or an empty company scope. Grades are tenant-wide and were creatable
          before any company existed, which is the natural onboarding order — define grades, then companies,
          then policies. So the empty-scope message is now a NOTICE above the grid; the four company-scoped
          categories still show their own empty state in the body. */}
      {gridCompanies.length === 0 && (
        <Card>
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noCompaniesInScope')}</p>
        </Card>
      )}
      <SystemLabelsGrid
        data={data}
        companies={gridCompanies}
        isGroupAdmin={isGroupAdmin(s)}
        actions={actions}
        gradesSlot={gradesSlot}
        gradesActiveCount={grades.filter((g) => g.archivedAt == null).length}
        gradeGroupsSlot={gradeGroupsSlot}
        gradeGroupsLabel={tGroups('groupsTitle')}
        gradeGroupsCount={gradeGroups.filter((g) => !g.archived).length}
        optionSlots={optionSlots}
      />
    </div>
  );
}
