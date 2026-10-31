import { SystemLabelImportTools } from '@/components/system-label-import-tools';
import { getTranslations } from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import { isGroupAdmin } from '@/lib/authz';
import { listJobGrades } from '@/core/read';
import {
  listBusinessUnitsForLabels,
  listCostCentersForLabels,
  listDepartmentsForLabels,
  listPositionsForLabels,
} from '@/core/admin';
import {labelMaintenanceCompanies,labelMaintenanceHeadOptions} from '@/core/system-labels';
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
  setLabelCriteriaAction,
  unassignLabelCompaniesAction,
} from '../actions';
// 9a65f808 — the three grade-group writes, unchanged, from app/(app)/admin/actions.ts (NOT the settings actions
// file above — the grade-group actions never moved, only their mount and their redirect did). Each calls
// `requireAdmin()` itself, which is the same administrator guard this page applies, so
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
  const s=await requireAdmin();
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
  const [companies, departments, positions, costCenters, businessUnits, grades, profileOptions, gradeGroups, employees] =
    await Promise.all([
      labelMaintenanceCompanies(s),
      listDepartmentsForLabels(s),
      listPositionsForLabels(s),
      listCostCentersForLabels(s),
      listBusinessUnitsForLabels(s),
      // b1b81a08 — Grades moved here from Leave Config. Archived rows load too so the grid can show and
      // restore them. NOTE: grades are TENANT-WIDE, so they must NOT pass through company Criteria —
      // job_grade has no company_id to narrow on.
      listJobGrades(s, { includeArchived: true }),
      // c9986927 — Division / Branch / Region / Line / Section / Team / Base / Category are maintained
      // here now. Like grades they are TENANT-WIDE, so they must NOT pass through company Criteria.
      listAllProfileOptions(s, { activeOnly: false }),
      // 9a65f808 — grade groups, maintained here now for the same reason grades are: they are the
      // tenant's grade vocabulary, TENANT-WIDE (a group carries no company), and they must NOT pass
      // through company Criteria. Archived groups arrive too — the editor badges them and the editor is
      // the only surface that can un-archive one.
      listGradeGroups(s),
      // Head choices are database-admin scoped independently of the common workspace's company cookie.
      labelMaintenanceHeadOptions(s),
    ]);


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
      assignedCompanyIds:string[];
      isGlobal: boolean;
      archivedAt: Date | null;
      inUse: boolean;
      createdAt: Date | null;
      lastUpdatedAt: string | null;
      lastUpdatedBy: string | null;
    },
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
    assignedCompanyIds:[...r.assignedCompanyIds],
    createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    lastUpdatedAt: r.lastUpdatedAt,
    lastUpdatedBy: r.lastUpdatedBy,
  });

  // All four canonical reads apply database admin scope before bounds/counting; no switcher filter.
  const maintenanceIds=new Set(companies.map(company=>company.id));
  const data:Record<GridKind,GridRecord[]>={department:departments.map(norm),position:positions.map(norm),cost_center:costCenters.map(norm),business_unit:businessUnits.map(norm)};

  // 71bacb95: the Business Unit select was removed from the Department config grid (the BU link is now
  // maintained via the employee's organisation assignment), so the per-company BU option list it fed is no
  // longer built or passed here. department.businessUnitId + its hire-form / payroll cascade are unchanged.
  // r285 — HEAD OPTIONS ARE BACK, and the note that replaced them was not true. 797e3523 removed the Head
  // column and said heads were "maintained via the organisation admin surface"; no such surface has one —
  // after that commit no `name="headEmploymentId"` control existed anywhere in the app. So department_head
  // and business_unit_head stayed selectable approval steps that could never fire (generateApprovalSteps
  // drops a head step whose head is unset), and on the live tenant 0 of 25 departments and 0 of 7 business
  // units had a head. The select, its per-company options and the same-company guard behind them are the
  // ones that shipped with 6fadb036; only the surface had gone missing.
  const headByCompany: Record<string, { id: string; label: string }[]> = {};
  for (const e of employees) {
    (headByCompany[e.companyId] ??= []).push({
      id: e.employmentId,
      label: e.employeeCode ? `${e.name} (${e.employeeCode})` : e.name,
    });
  }

  const gridCompanies = companies.filter(c => maintenanceIds.has(c.id)).map(c => ({ id: c.id, name: c.name,archived:!!c.archivedAt }));

  const actions = {
    save: saveLabelsGridAction,
    setCriteria: setLabelCriteriaAction,
    assign: assignLabelCompaniesAction,
    unassign: unassignLabelCompaniesAction,
    copyToCompanies: copyLabelsToCompaniesAction,
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
        key={c}
        hideRail
        categories={[c]}
        data={{ [c]: profileOptions[c] ?? [] }}
        actions={{ save: saveProfileOptionsAction, remove: removeProfileOptionAction }}
      />
    ),
  }));

  return (
    <div className="w-full min-w-0 space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <p className="text-sm text-muted-foreground">{t('criteriaHelp')}</p>
      <SystemLabelsTabs active="organisation" />
      <SystemLabelImportTools />
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
        writableCompanyIds={companies.map((c) => c.id)}
        headByCompany={headByCompany}
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
