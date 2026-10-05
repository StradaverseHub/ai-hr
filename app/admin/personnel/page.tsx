import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import {
  countEmployeesByStatus,
  listCompanies,
  listDepartments,
  listEmployeesPage,
} from '@/core/read';
import { listProfileChangeRequests } from '@/core/profile';
// r260 stage two (9583deac) — the shared approve/reject control whose Reject cannot be submitted
// without a reason, and the declaration that names each proposed field the way both screens name it.
import { ProfileChangeDecide } from '@/components/profile-change-decide';
import {
  PROFILE_REQUEST_OPTION_NAMESPACE,
  formatProposedValue,
  requestableField,
} from '@/lib/profile-requestable-fields';
import { listEmployeeDrafts } from '@/core/employee-draft';
import { deriveEmploymentStatus } from '@/core/employment-status';
import { getEmployeeListColumns } from '@/core/employee-list-prefs';
import { Card, PageHeader } from '@/components/ui';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
import { Pager } from '@/components/pager';
import { pageState, parsePageQuery } from '@/lib/pagination';
import {
  MANDATORY_EMPLOYEE_COLUMNS,
  UNAVAILABLE_EMPLOYEE_FIELDS,
  employeeColumnText,
  type EmployeeColumnKey,
} from '@/lib/employee-columns';
import { decideProfileChangeAction } from './actions';
import { resetEmployeeColumnsAction, saveEmployeeColumnsAction } from './column-actions';
import { ColumnPicker } from './column-picker';
import { DraftRow } from './draft-row';
import { EmployeeRow } from './employee-row';
import { employmentPhotoIds } from '@/core/person-photo';
// 034a5080 — the Create New Employee prompt over this list. Same four-question body the standalone route
// renders, so it needs the same Employee ID rule resolution the route's page performs.
import { listConfigs, resolveEmployeeIdRule } from '@/core/employee-id-config';
import type { EmployeeIdRule } from '@/lib/employee-id-mode';
import { CreateEmployeeDialog } from './create-employee-dialog';
import {
  DRAFT_BUCKET,
  EMPLOYEE_STATUS_BUCKETS,
  draftMatchesQuery,
  headcountFilters,
  parsePersonnelListQuery,
  type PersonnelSearchParams,
} from './list-query';
// c002b3c3 — "Search Employee": jump straight to a profile without a round trip through this list.
import { EmployeeSwitcher } from './employee-switcher';

import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * Render a proposed change bundle as human-readable "field → value" pairs.
 *
 * ── r260 STAGE TWO: NAMED FROM THE DECLARATION, NOT FROM AN `if` LADDER ─────────────────────────────
 * This used to test four field names by hand, so the widened set (lib/profile-requestable-fields.ts —
 * twenty-four fields across `person` and `employee_statutory_my`) would have arrived here as
 * "No changes": an approver being asked to approve a bundle the screen refused to describe. It now
 * walks the declaration, and each field is named by the SAME `people.detail.*` key the employee reads it
 * under on their own record — the property the plan asks for, that a request and a record can never call
 * one field two things. `tp` is that catalogue; `t` (people.list) stays for the empty case.
 *
 * ── AND THE VALUE IS RENDERED BY THE SHARED RENDERER, NOT BY THIS SCREEN ────────────────────────────
 * The first draft resolved a select option to `opt.value` — a no-op returning the string it had just
 * matched on — so this queue printed "Tax Category → 2" and "Gender → male" where the code it replaced
 * printed "PCB → Married · spouse working", while My Profile, in the same round, printed the label. An
 * approver deciding a pay-affecting PCB change was being shown an LHDN code, and the two screens
 * disagreed about one request, which is the exact opposite of what this round is for. `tMe` is the
 * namespace those option labels live in (PROFILE_REQUEST_OPTION_NAMESPACE) — the same words the employee
 * picked from. `mask: false`: an approver checks the proposed account number against a bank letter, and
 * already reads it unmasked on the Personnel card.
 *
 * It returns one string PER FIELD rather than one joined line, because resolving the labels made the old
 * ' · ' join ambiguous: "2 · Married, spouse not working" is ONE PCB label and read as two fields.
 */
function describeProposed(
  p: unknown,
  t: Awaited<ReturnType<typeof getTranslations>>,
  tp: Awaited<ReturnType<typeof getTranslations>>,
  tMe: Awaited<ReturnType<typeof getTranslations>>,
): string[] {
  const o = (p ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(o)) {
    const f = requestableField(key);
    if (!f) continue;
    parts.push(`${tp(f.labelKey)} → ${formatProposedValue(f, value, tMe, { mask: false })}`);
  }
  return parts.length ? parts : [t('noChanges')];
}

/** people.list message key per catalogue column — ONE map, read by the <th> row, the picker and the
 *  export route's header row, so a column cannot be called two different things on two surfaces. */
const COLUMN_LABEL_KEY: Record<EmployeeColumnKey, string> = {
  code: 'colCode',
  name: 'colName',
  company: 'colCompany',
  department: 'colDepartment',
  position: 'colPosition',
  status: 'colStatus',
  jobGrade: 'colJobGrade',
  employmentType: 'colEmploymentType',
  reportingTo: 'colReportingTo',
  businessUnit: 'colBusinessUnit',
  costCenter: 'colCostCenter',
  workLocation: 'colWorkLocation',
  groupJoinDate: 'colHired',
  joinDate: 'colJoinDate',
  confirmationDate: 'colConfirmationDate',
  email: 'colEmail',
};

const EMPLOYMENT_TYPES = [
  { value: 'full_time', labelKey: 'employmentFullTime' },
  { value: 'part_time', labelKey: 'employmentPartTime' },
  { value: 'contract', labelKey: 'employmentContract' },
  { value: 'intern', labelKey: 'employmentIntern' },
] as const;

const EMPLOYMENT_TYPE_KEY: Record<string, string> = Object.fromEntries(
  EMPLOYMENT_TYPES.map((e) => [e.value, e.labelKey]),
);

/** people.list key per absent field (lib/employee-columns.UNAVAILABLE_EMPLOYEE_FIELDS). */
const ABSENT_LABEL_KEY: Record<(typeof UNAVAILABLE_EMPLOYEE_FIELDS)[number], string> = {
  division: 'absentDivision',
  section: 'absentSection',
  line: 'absentLine',
  team: 'absentTeam',
  region: 'absentRegion',
  base: 'absentBase',
  employeeCategory: 'absentEmployeeCategory',
  employeeType: 'absentEmployeeType',
};

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<PersonnelSearchParams>;
}) {
  await requireAdmin(); // Admin-only management surface (ADR: People→Personnel split). Non-admins redirect home.
  const t = await getTranslations('people.list');
  const tStatus = await getTranslations('people.employeeStatus');
  // r260 — Personnel Management's own field labels, so a proposed profile change is named in this
  // queue exactly as the employee reads it on their record and HR reads it on the Personnel card.
  const tPeopleDetail = await getTranslations('people.detail');
  // r260 — and the option WORDS (gender, marital status, PCB category) come from the namespace the
  // employee picked them in, so the approver reads the sentence they chose and not its stored code.
  const tMeOptions = await getTranslations(PROFILE_REQUEST_OPTION_NAMESPACE);
  // Employee Status redesign (R43 c26c3ce5): the People list shows the SYSTEM-DERIVED status (from each
  // employee's lifecycle dates + blacklist override), not the legacy stored assignment.status.
  const { s: session, scopeIds } = await scopedSession();
  const today = todayInKualaLumpur();
  const isAdmin = (session.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');
  const sp = await searchParams;
  const { error } = sp;
  const pq = parsePageQuery(sp);
  // 579255c3 — ONE parse of the query string, shared with the Excel export so the file and the table
  // are answering the same question. See ./list-query.ts for why the cards write `bucket` rather than
  // overloading `status`.
  const query = parsePersonnelListQuery(sp);
  const { q, company, dept, type, draftOnly, hasFilters } = query;

  const [
    { rows: employeeRows, total: employeeTotal },
    headcount,
    companies,
    departments,
    profileChanges,
    allDrafts,
    savedColumns,
    idConfigs,
  ] = await Promise.all([
    listEmployeesPage(session, {
      companyIds: scopeIds,
      ...query.filters,
      limit: pq.limit,
      offset: pq.offset,
    }),
    // Point 5 — the five headcount cards. Counted in SQL over the WHOLE filtered set, never over the
    // page: "40 employees" must keep meaning forty people, not twenty-five rows. The bucket narrowing is
    // stripped (headcountFilters) so the cards stay a facet of the current view — clicking one cannot
    // make the other four read zero.
    countEmployeesByStatus(session, { companyIds: scopeIds, ...headcountFilters(query) }),
    listCompanies(session),
    listDepartments(session),
    isAdmin
      ? listProfileChangeRequests(session, { companyIds: scopeIds, status: 'pending' })
      : Promise.resolve([]),
    isAdmin ? listEmployeeDrafts(session) : Promise.resolve([]),
    // 579255c3 — this reader's own columns and their order. Per user (app_user.list_preferences through
    // the own-row seam), so one person's arrangement never changes what anybody else sees.
    getEmployeeListColumns(session),
    // 034a5080 — the Create New Employee prompt asks the same four questions the standalone route asks,
    // so it needs the same two things that route's page builds: the companies (already read above) and
    // the Employee ID Auto Running Number Setup that applies to each of them. Resolved ONCE from a single
    // read here, exactly as app/admin/personnel/new/page.tsx does it, rather than a query per company as
    // the select is used. Admin-only, because the prompt itself is.
    isAdmin ? listConfigs(session, scopeIds) : Promise.resolve([]),
  ]);

  const columns = savedColumns.selected;

  // What crosses into the prompt is PLAIN DATA (booleans, strings, numbers and a pre-formatted sample
  // code) for the reason app/admin/personnel/new/page.tsx spells out at length: both the prompt and its
  // body are client components, and a formatter or a translator closure passed here would throw at render
  // and take the whole employee list down — the r123 fault test/server-client-boundary.test.ts exists to
  // catch. `sampleCode` is a PREVIEW of the next running number, not a reservation; the ID the employee
  // actually gets is issued inside the create transaction and the prompt's confirmation reports THAT.
  const employeeIdRules: Record<string, EmployeeIdRule> = {};
  for (const c of companies) employeeIdRules[c.id] = resolveEmployeeIdRule(idConfigs, c.id);

  // ── Draft rows (item 06f0cb8f, preserved) ─────────────────────────────────────────────────────────
  // Drafts are PINNED ABOVE the employees on every page, not merged into the sort and not paged. There
  // are a handful of them at most (they exist for days, not years), and the reporter's reason for wanting
  // them in this list is to see who is still outstanding — an outstanding record on page 4 answers
  // nothing. THE PAGER TOTAL STILL COUNTS EMPLOYMENTS ONLY: "40 employees" must keep meaning forty people
  // on the books, and a Draft is a reserved place, not a person.
  //
  // 579255c3 DELIBERATELY DOES NOT RE-SEPARATE THEM. A standalone "Draft Employees" card above the table
  // used to exist and was REMOVED AT THE REPORTER'S OWN REQUEST (06f0cb8f) — a draft parked outside the
  // list with no status against it was exactly the complaint. What the redesign adds instead is the Draft
  // CARD, which shows the count and pulls up those rows alone in one click.
  //
  // Which filters hide a draft, and why, now lives in ONE predicate (draftMatchesQuery) shared with the
  // Draft card's count and with the export, so a card can never promise records the table then refuses.
  const matchingDrafts = allDrafts.filter((d) => draftMatchesQuery(d, query));
  // THE DRAFT CARD COUNTS WHAT CLICKING IT WOULD SHOW, not what the current selection shows. Clicking a
  // card REPLACES the bucket, so counting the drafts under the bucket already chosen made the card read
  // "0" the moment Active was selected — a card offering nothing, next to two records that exist. Caught
  // by rendering, not by a test: every count was individually correct.
  const draftCardCount = allDrafts.filter((d) =>
    draftMatchesQuery(d, { ...query, bucket: undefined }),
  ).length;
  // FIRST PAGE ONLY. Pinned rows that repeat above every page of a long list stop reading as "these are
  // outstanding" and start reading as a rendering fault. Under the Draft selection there is only one
  // page, so this costs nothing there.
  const drafts = pq.offset > 0 ? [] : matchingDrafts;

  const employees = draftOnly ? [] : employeeRows;
  const total = draftOnly ? 0 : employeeTotal;
  const pgState = pageState(pq, total, employees.length);

  // 597c810a — WHO ON THIS PAGE HAS A PROFILE PHOTO, in ONE query, AFTER the page's rows are known.
  //
  // It cannot join the Promise.all above: the answer depends on the twenty-five rows that read returns, and
  // a photo lookup over the whole scoped set would be a bulk read of the wrong population. One extra round
  // trip for the page is the point — the alternative is an <img> on every row, which on production's 89
  // persons and 2 photos means 89 browser requests, 87 of them 404s that each cost a session read and an
  // RLS query. The Map is empty for a page where nobody has one, and then the rows are byte-identical to
  // before. RLS decides membership, not this call: a person outside can_see_person is simply absent
  // (core/person-photo.ts).
  const photoIds = await employmentPhotoIds(
    session,
    employees.map((e) => e.employmentId),
  );

  // ── Filters ───────────────────────────────────────────────────────────────────────────────────────
  // Consolidated filter panel (feedback 3542ed4a): same GET params, same query path — only the
  // presentation moved from an inline row into a top-right panel + chips. All strings resolved here so
  // the client island stays free of dynamic t() keys.
  //
  // 579255c3 — the Status field now offers the DERIVED Employee Status vocabulary (the same words the
  // badge in the same table prints, plus Draft) on the `bucket` param, instead of the lifecycle
  // active/terminated query on `status`. The old param is still honoured for existing links; nothing
  // writes it any more. See ./list-query.ts.
  const filterFields: FilterField[] = [
    {
      kind: 'search',
      name: 'q',
      label: t('search'),
      placeholder: t('searchPlaceholder'),
      ariaLabel: t('searchAriaLabel'),
      removeAriaLabel: t('removeFilter', { label: t('search') }),
    },
    {
      kind: 'select',
      name: 'company',
      label: t('company'),
      ariaLabel: t('filterCompany'),
      allLabel: t('allCompanies'),
      options: companies.map((c) => ({ value: c.id, label: c.name })),
      removeAriaLabel: t('removeFilter', { label: t('company') }),
    },
    {
      kind: 'select',
      name: 'dept',
      label: t('department'),
      ariaLabel: t('filterDepartment'),
      allLabel: t('allDepartments'),
      options: departments.map((d) => ({ value: d.id, label: d.name })),
      removeAriaLabel: t('removeFilter', { label: t('department') }),
    },
    {
      kind: 'select',
      name: 'bucket',
      label: t('colStatus'),
      ariaLabel: t('filterStatus'),
      allLabel: t('allStatuses'),
      options: [
        ...EMPLOYEE_STATUS_BUCKETS.map((b) => ({ value: b, label: tStatus(b) })),
        // 06f0cb8f — the one option here that is a STORED state rather than a derived one, because it
        // selects from a different table; picking it shows the Draft rows and no employees at all.
        { value: DRAFT_BUCKET, label: t('statusDraft') },
      ],
      removeAriaLabel: t('removeFilter', { label: t('colStatus') }),
    },
    {
      kind: 'select',
      name: 'type',
      label: t('employmentType'),
      ariaLabel: t('filterType'),
      allLabel: t('allTypes'),
      options: EMPLOYMENT_TYPES.map((et) => ({ value: et.value, label: t(et.labelKey) })),
      removeAriaLabel: t('removeFilter', { label: t('employmentType') }),
    },
  ];
  const filterValues = { q, company, dept, bucket: sp.bucket, type };
  const activeFilterCount = [q, company, dept, sp.bucket, type].filter(Boolean).length;
  const filterLabels = {
    filter: t('filter'),
    apply: t('applyFilters'),
    clearAll: t('clearAllFilters'),
    activeCount: t('activeFilters', { count: activeFilterCount }),
  };

  // ── Headcount cards (point 5) + card-as-quick-filter (point 6) ────────────────────────────────────
  // Each card is a plain <Link> carrying the CURRENT filters plus its own bucket, so a card click
  // narrows rather than replaces, works without JavaScript, and appears as a removable chip like every
  // other filter. `page` is deliberately dropped: a new narrowing starts at page one.
  const cardHref = (bucket: string | null) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (company) params.set('company', company);
    if (dept) params.set('dept', dept);
    if (type) params.set('type', type);
    if (bucket) params.set('bucket', bucket);
    const s = params.toString();
    return s ? `/admin/personnel?${s}` : '/admin/personnel';
  };
  const n = (k: keyof typeof headcount.byStatus) => headcount.byStatus[k] ?? 0;
  const cards = [
    // Total = every employment in the filtered scope. active_serving_notice and blacklisted fold in
    // here and nowhere else — they are real states a row can be in, but not cards the reporter asked
    // for, and inventing a card per state would bury the five that were asked for.
    { key: null, label: t('cardTotal'), hint: t('cardTotalHint'), count: headcount.total },
    { key: 'active', label: tStatus('active'), hint: t('cardActiveHint'), count: n('active') },
    { key: 'probation', label: tStatus('probation'), hint: t('cardProbationHint'), count: n('probation') },
    { key: 'resigned', label: tStatus('resigned'), hint: t('cardResignedHint'), count: n('resigned') },
    // The Draft figure comes from the OTHER table, counted through the same predicate that decides
    // which draft rows the table shows.
    { key: DRAFT_BUCKET, label: t('statusDraft'), hint: t('cardDraftHint'), count: draftCardCount },
  ] as const;
  const activeCard = draftOnly ? DRAFT_BUCKET : (query.bucket ?? null);

  // ── Column picker (points 2 & 3) ──────────────────────────────────────────────────────────────────
  // Pre-translated, serialisable props only — no closure over `t` may cross into a client island
  // (test/server-client-boundary.test.ts).
  const pickerColumns = savedColumns.order.map((key) => ({
    key,
    label: t(COLUMN_LABEL_KEY[key]),
    mandatory: MANDATORY_EMPLOYEE_COLUMNS.includes(key),
  }));
  const absentNote = t('columnsAbsent', {
    fields: UNAVAILABLE_EMPLOYEE_FIELDS.map((f) => t(ABSENT_LABEL_KEY[f])).join(', '),
  });

  // The Export link carries the SCREEN's resolved columns, not just the filters, so the file cannot
  // disagree with the table even if the preference changes in another tab between the two requests.
  const exportHref = (() => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (company) params.set('company', company);
    if (dept) params.set('dept', dept);
    if (type) params.set('type', type);
    if (sp.bucket) params.set('bucket', sp.bucket);
    if (sp.status) params.set('status', sp.status);
    params.set('cols', columns.join(','));
    return `/admin/personnel/export?${params.toString()}`;
  })();

  /** The plain-text cell for a column, from the SAME projection the export prints. */
  const textCell = (e: (typeof employees)[number], key: EmployeeColumnKey) =>
    employeeColumnText(e, key, {
      status: tStatus(deriveEmploymentStatus(e, today)),
      employmentType: e.employmentType ? t(EMPLOYMENT_TYPE_KEY[e.employmentType] ?? 'employmentType') : null,
    });

  return (
    // c002b3c3 — the Personnel module goes FULL WIDTH. `max-w-[100rem]` is not a new number: it is the
    // container this codebase already settled on for wide screens, chosen there after measuring —
    // capped rather than full-bleed, because an uncapped table on an ultrawide display is unreadable in
    // the other direction. Reusing that exact value is the point: the listing and the profile must not
    // become a third and fourth width.
    //
    // 152fea7f — THIS SENTENCE USED TO CITE PAYROLL as part of that evidence and no longer can. The
    // reporter asked for the whole Payroll module to fill the browser; the approved item moved every
    // Payroll screen off this cap and onto `pageWideCls` (`w-full`, uncapped). That is an override for
    // Payroll SPECIFICALLY — a reporter who wants the extra columns on their own screens and accepts the
    // line lengths that come with them — not a finding that the measurement above was wrong. The screens
    // that still share this exact value, and are therefore what "already settled on" now means, are the
    // profile next door (app/admin/personnel/[employmentId]/page.tsx) and the leave inquiries
    // (app/leave/{page,tracker,employee-records,employee-balances}); test/leave-inquiry-layout.test.ts
    // and test/personnel-full-width-search.test.ts pin the two ends of it together. If Payroll's users
    // later report the ultrawide readability problem this cap exists to prevent, that is an argument to
    // re-cap Payroll — not to uncap this page to match it.
    <div className="mx-auto max-w-[100rem] space-y-6">
      <PageHeader
        // 4ea70bb7 — `adminTitle`, NOT `title`. The people.list namespace is shared: people.list.title is
        // also the heading of the employee-facing directory at /personnel, the header of the Excel export
        // and a column label on the leave tracker. Renaming it in place would have renamed a screen this
        // item never mentioned. The admin module alone becomes "Personnel Management"; the directory stays
        // "Personnel" (nav.people), which is what tells the two menu entries apart.
        title={t('adminTitle')}
        actions={
          // `flex-wrap` (c002b3c3): this row gained a search box, and PageHeader holds its actions
          // group `shrink-0` — without wrapping, a narrow window would scroll the PAGE sideways rather
          // than stacking the controls, which is the one thing a full-width change must not introduce.
          <div className="flex flex-wrap items-center justify-end gap-3">
            {/* 579255c3 — the bare "40 employees" count that stood here is GONE. It said one number with
                no context; the five cards below say all five, and the pager still prints "1–25 of 30". */}
            {isAdmin && (
              <Link
                href="/admin/personnel/import"
                data-tour="people-import"
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                {t('importCsv')}
              </Link>
            )}
            {/* 05d2709a — the way in to "Possible duplicate employee records". A LINK from this list, not
                a rail row: `/admin/personnel/duplicates` sits below this screen's own href, and the rail's
                flat rows match a segment PREFIX (components/nav-flyout.tsx isHrefActive), so a row of its
                own would light Personnel Management AND itself on the same page — the two-lit-rows defect
                388e53c2 was raised to fix. Reached the same way /admin/personnel/import and
                /admin/personnel/new are, which is also where somebody looking at the employee list would
                go asking "why is this person in here twice?". */}
            {isAdmin && (
              <Link
                href="/admin/personnel/duplicates"
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                {t('duplicateRecords')}
              </Link>
            )}
            {/* 04b88724 (r339) — THE "CHILD RELIEF REVIEW (PCB)" LINK WAS REMOVED FROM HERE, DELIBERATELY,
                AND THE ROUTE WAS DELIBERATELY KEPT. Do not restore the link; do not delete the route
                without reading this.
                  · r336 (99b2d6c0) added a link at this spot, for the same reason the duplicates link
                    above is one: `/admin/personnel/child-relief` sits below this screen's own href and the
                    rail matches a segment PREFIX, so a nav row of its own would light Personnel Management
                    AND itself on one page (defect 388e53c2).
                  · The reporter asked for it gone: "Remove the Child Relief Review button from the
                    Personnel Management main page because the function is not required." Their own
                    expected-behaviour list is about the BUTTON and adds "No replacement button is
                    required" — it does not ask for the report to be destroyed.
                WHY THE ROUTE STAYS. The approved plan told the reporter that moving their other 74
                employees off flat child counting onto the category grid moves real PCB, and that we would
                do it "as its own change, with the list in front of you first". THIS SCREEN IS THAT LIST —
                deleting it in the same round would destroy the instrument we just promised to use. It is
                `requireAdmin()`-gated on the page and again inside core/child-relief-review.ts, it keeps
                its `SCREENS` column in lib/permissions.ts (so it stays a grantable function and
                test/function-access.test.ts stays satisfied), and it changes nothing when opened — there
                is no bulk action on it. An unlinked, permission-gated, read-only report is not an
                exposure; it is a report nobody is pushed towards.
                Removing the link is also the reversible half. If the reporter later says the route must go
                too, that is a deletion of app/admin/personnel/child-relief/, core/child-relief-review.ts,
                components/child-relief-review-table.tsx, their tests, the SCREENS column and the message
                keys in all six locales — and r336's two kernel pins (core/payroll.ts and
                core/payroll-view.ts both read child_relief_mode) would have to be rehomed first. */}
            {/* c002b3c3 — Search Employee, beside the Filter button. It is NOT a second copy of the
                filter's `q` box and does not narrow this table: it JUMPS to a profile. Both controls
                are here because they answer different questions — "show me these people" and "take me
                to this person" — and the second one previously had no answer at all. */}
            <EmployeeSwitcher key={scopeIds.join(',')} />
            <FilterPanel
              action="/admin/personnel"
              fields={filterFields}
              values={filterValues}
              labels={filterLabels}
              dataTour="people-search"
            />
            <ColumnPicker
              columns={pickerColumns}
              selected={columns}
              labels={{
                title: t('customizeColumns'),
                hint: t('columnsHint'),
                apply: t('columnsApply'),
                reset: t('columnsReset'),
                moveUp: t('columnsMoveUp'),
                moveDown: t('columnsMoveDown'),
                unavailableNote: absentNote,
              }}
              saveAction={saveEmployeeColumnsAction}
              resetAction={resetEmployeeColumnsAction}
            />
            {/* Points 9 & 10 — a plain link, so the download is a GET the browser owns and the file is
                whatever this screen is currently showing. */}
            <a
              href={exportHref}
              aria-label={t('exportAria')}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              {t('exportXlsx')}
            </a>
            {/* 6d671f44 — Create New Employee became its own step-by-step screen with Save as Draft,
                because that reporter's requirement was literal: "The current employee list screen shall
                not be used for data entry". The inline hire form that used to expand below this header is
                still gone, and is not coming back.
                034a5080 walks HALF of that back, deliberately and only for the four-question create: the
                button now opens a PROMPT over this list. The route is untouched and still reachable — the
                trigger is a real Link to that route whose plain left click is intercepted
                (see the component), so ⌘-click, a JS-less browser, the tour and every draft row still get
                the full screen. The markup, the `data-tour` anchor and the confirmation step live in
                ./create-employee-dialog.tsx; the trigger's LABEL is resolved here so that file keeps to a
                single message namespace. */}
            {isAdmin && (
              <CreateEmployeeDialog
                triggerLabel={t('createNewEmployee')}
                companies={companies.map((c) => ({ id: c.id, label: c.name }))}
                employeeIdRules={employeeIdRules}
              />
            )}
          </div>
        }
      />

      {/* Point 5 + 6 — the headcount summary, and every card a one-click narrowing. */}
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
        aria-label={t('headcountAria')}
        data-tour="people-headcount"
      >
        {cards.map((c) => {
          const on = activeCard === c.key;
          return (
            <Link
              key={c.key ?? 'total'}
              href={cardHref(c.key)}
              aria-current={on ? 'true' : undefined}
              data-headcount={c.key ?? 'total'}
              className={`rounded-xl border px-4 py-3 transition-colors ${
                on
                  ? 'border-primary bg-accent text-accent-foreground'
                  : 'border-border bg-card hover:border-primary/40 hover:bg-muted/40'
              }`}
            >
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {c.label}
              </div>
              <div className="mt-1 text-2xl font-bold tabular-nums">{c.count}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {on ? t('cardShowing') : c.hint}
              </div>
            </Link>
          );
        })}
      </div>

      <FilterChips
        action="/admin/personnel"
        fields={filterFields}
        values={filterValues}
        labels={filterLabels}
      />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {isAdmin && profileChanges.length > 0 && (
        <Card className="overflow-hidden border-amber-200 dark:border-amber-500/30">
          <div className="flex items-center gap-2 border-b border-border bg-amber-50/60 px-4 py-3 dark:bg-amber-500/10">
            <h2 className="text-sm font-semibold">{t('profileChangeRequests')}</h2>
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
              {t('pendingCount', { count: profileChanges.length })}
            </span>
          </div>
          <ul className="divide-y divide-border">
            {profileChanges.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{r.employee}</div>
                  {/* ONE FIELD PER LINE. The pairs used to be joined with ' · ', which was unambiguous
                      only while the values were raw: the PCB labels the employee picks from are
                      themselves "2 · Married, spouse not working", so a joined line read as two fields
                      where there was one. An approver reads a pay-affecting bundle here. */}
                  <div className="text-xs text-muted-foreground">
                    {describeProposed(r.proposed, t, tPeopleDetail, tMeOptions).map((line) => (
                      <div key={line}>{line}</div>
                    ))}
                  </div>
                </div>
                <ProfileChangeDecide
                  action={decideProfileChangeAction}
                  requestId={r.id}
                  idFieldName="requestId"
                  labels={{
                    approve: t('approve'),
                    reject: t('reject'),
                    reasonPlaceholder: t('rejectReasonPlaceholder'),
                    yourRequest: t('approve'),
                  }}
                />
              </li>
            ))}
          </ul>
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            {t('profileChangeHint')}
          </p>
        </Card>
      )}

      <Card className="overflow-hidden" data-tour="people-table">
        {/* The table can now carry up to sixteen columns, so it scrolls INSIDE its card rather than
            pushing the page sideways — the same rule the full-width change (c002b3c3) was careful about. */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {columns.map((key) => (
                  <th key={key} scope="col" data-column={key} className="whitespace-nowrap px-4 py-3 font-medium">
                    {t(COLUMN_LABEL_KEY[key])}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {/* DRAFTS FIRST (item 06f0cb8f). Same columns as everyone else — the reporter's own example
                  table is Employee ID / Employee Name / Company / Status — so a Draft reads as what it is:
                  a place in the list with a number held for it.

                  420ebab5 — and it is clickable across its whole width like every other row here, because
                  it IS one of the rows the reporter was looking at. The destination differs (the form that
                  finishes the draft, not a profile that does not exist yet) and the row says so twice, in
                  the Draft chip and the sub-line under the name. Every string is resolved here: <DraftRow>
                  owns no translator, exactly like <EmployeeRow>. */}
              {drafts.map((d) => (
                <DraftRow
                  key={d.id}
                  draftId={d.id}
                  label={d.label || t('draftUntitled')}
                  avatarName={d.label || '?'}
                  subtitle={
                    d.missing.length > 0 ? t('draftMissing', { count: d.missing.length }) : t('draftReady')
                  }
                  reservedEmployeeCode={d.reservedEmployeeCode}
                  companyName={d.companyName ?? t('draftNoCompany')}
                  statusLabel={t('statusDraft')}
                  columns={columns}
                />
              ))}
              {/* 420ebab5 — THE WHOLE ROW OPENS THE EMPLOYEE. The row carried the hover tint and nothing
                  else: only the name was a link, so it looked clickable and was not. The markup moved into
                  <EmployeeRow>, which is the one place the stretched-link idiom is spelled and explains
                  itself there — and it had to move to be TESTABLE at all, because this page is an async
                  server component that reads the database before it renders a single row.

                  Everything the row shows is still resolved HERE and handed over as plain text: the
                  component owns no translator, no clock and no column catalogue of its own, so this table
                  and the Excel export keep printing the same projection. */}
              {employees.map((e) => {
                const st = deriveEmploymentStatus(e, today);
                const text: Partial<Record<EmployeeColumnKey, string | null>> = {};
                for (const key of columns) text[key] = textCell(e, key);
                return (
                  <EmployeeRow
                    key={e.employmentId}
                    employmentId={e.employmentId}
                    name={e.name}
                    email={e.email}
                    employeeCode={e.employeeCode}
                    status={st}
                    statusLabel={tStatus(st)}
                    columns={columns}
                    text={text}
                    photoPersonId={photoIds.get(e.employmentId) ?? null}
                  />
                );
              })}
              {/* The empty state counts the DRAFT rows too — "no employees yet" under a table that is
                  visibly showing two of them would be the screen contradicting itself. */}
              {employees.length === 0 && drafts.length === 0 && (
                <tr>
                  <td colSpan={columns.length} className="px-4 py-10 text-center text-muted-foreground">
                    {q ? t('emptySearch', { q }) : hasFilters ? t('emptyFiltered') : t('emptyNoEmployeesAdmin')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager
          basePath="/admin/personnel"
          params={{ q, company, dept, status: sp.status, type, bucket: sp.bucket }}
          state={pgState}
        />
      </Card>
    </div>
  );
}
