import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { UNGROUPED, listShiftArrangements } from '@/core/shift-arrangement';
import { listShiftsForTenant } from '@/core/roster';
// The Schedule Group library, through the pack facade — the same import the list, the detail page and the
// personnel card use, so all four read one list.
import { listAttendanceRules } from '@/packs/attendance/service';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { Card, ErrorBanner, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
import { BulkScheduleGroupForm, type BulkRow } from './bulk-form';

/**
 * 8cd601d0 (r329) — BULK SCHEDULE GROUP ASSIGNMENT.
 *
 * THE ITEM IN ONE LINE, and it is not the one the ticket's title suggests. The approved plan's central
 * demand — "the system shall not allow a shift outside the group, and the check must be service-side, not
 * a filtered dropdown" — was ALREADY BUILT by 870b79e2 (r277): core/roster.ts
 * assertShiftsAllowedForEmploymentsTx, called by all four writers of "which shift is this person on" plus
 * copyRoster. f513ec02 (r281) then built the card that puts ONE employment in a group. What was missing
 * was the workflow that makes either of them bite: measured on production on 2026-09-22, ONE of 75 active
 * employments has a Schedule Group. The guard's own header says an employment with no group "is not
 * constrained at all" — so for 74 of 75 people the correct refusal is a no-op, and putting them in a group
 * one personnel page at a time is exactly why it had not happened. This screen is that workflow.
 *
 * ⚠️ IT WRITES THROUGH THE SAME SERVICE AS THE SINGLE DOOR. ../actions.ts bulkAssignScheduleGroupAction →
 * core/roster.ts setEmploymentScheduleGroupBulk → N calls of setEmploymentScheduleGroupTx, the identical
 * per-employment writer the personnel card and the detail page reach through
 * setEmploymentScheduleGroup. There is no bulk UPDATE and no second definition of the rule, so a batch
 * cannot walk past the reverse refusal that a single save has to pass. ALL OR NOTHING: one transaction for
 * the batch, and a refusal names the employee who blocked it and says nobody moved.
 *
 * THE FILTERS ARE THE SELECTION. This page takes the list's filters verbatim and offers exactly the rows
 * the list would show, so "everybody with no Schedule Group" is a filter away rather than a page of
 * scrolling. They ride the link in from the list, they ride the form's returnTo back out, and they are
 * editable here with the list's own FilterPanel.
 *
 * NO GROUP NAME, NO GROUP COUNT AND NO SHIFT'S MEMBERSHIP IS WRITTEN DOWN in this file or its island.
 * Item 07ebd04d is about to split "Standard" into three groups; everything here is read from the library
 * at render time, so that split shows up by itself.
 *
 * requireAdmin(), the same guard as the list it hangs off — it names every employee in the tenant and
 * changes the rules their paid hours are measured against. Registered in lib/permissions.ts on the
 * shift-library column, in the same commit as this file (test/function-access.test.ts fails both ways).
 */
const PAGE = '/admin/attendance/schedule-assignment';
const BULK = `${PAGE}/bulk`;

export default async function BulkScheduleGroupPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    shiftType?: string;
    shiftId?: string;
    status?: string;
    scheduleGroupId?: string;
    error?: string;
    bulkChanged?: string;
    bulkUnchanged?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.scheduleAssignment');
  const sp = await searchParams;

  // Parsed EXACTLY as the list parses them — by VALUE, never by presence — so the two screens can never
  // disagree about which employees the same URL names.
  const q = sp.q?.trim() || undefined;
  const shiftType = sp.shiftType === 'fixed' || sp.shiftType === 'roster' ? sp.shiftType : undefined;
  const status =
    sp.status === 'current' || sp.status === 'scheduled' || sp.status === 'notRecorded' ? sp.status : undefined;
  const shiftId = sp.shiftId?.trim() || undefined;
  const scheduleGroupId = sp.scheduleGroupId?.trim() || undefined;

  const hrefWith = (pathname: string) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, shiftType, shiftId, status, scheduleGroupId })) {
      if (v) params.set(k, v);
    }
    const qs = params.toString();
    return `${pathname}${qs ? `?${qs}` : ''}`;
  };

  // ONE "today" for the whole render, in the tenant's calendar — the same instant rule the list uses.
  const today = todayInKualaLumpur();
  const [rows, shifts, scheduleGroups] = await Promise.all([
    listShiftArrangements(s, { q, shiftType, shiftId, status, scheduleGroupId, today }),
    listShiftsForTenant(s),
    listAttendanceRules(s),
  ]);

  const SHIFT_TYPE_LABEL = { fixed: t('shiftTypeFixed'), roster: t('shiftTypeRoster') } as const;
  const STATUS_LABEL = {
    current: t('statusCurrent'),
    scheduled: t('statusScheduled'),
    notRecorded: t('statusNotRecorded'),
  } as const;

  // All strings PRE-TRANSLATED: FilterPanel / FilterChips are shared client islands and must not call t().
  const filterFields: FilterField[] = [
    {
      kind: 'search',
      name: 'q',
      label: t('filters.search'),
      placeholder: t('filters.searchPlaceholder'),
      ariaLabel: t('filters.searchAria'),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.search') }),
    },
    {
      kind: 'select',
      name: 'scheduleGroupId',
      label: t('filters.scheduleGroup'),
      ariaLabel: t('filters.scheduleGroup'),
      allLabel: t('filters.allScheduleGroups'),
      options: [
        { value: UNGROUPED, label: t('filters.noScheduleGroup') },
        ...scheduleGroups.map((g) => ({ value: g.id, label: g.name })),
      ],
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.scheduleGroup') }),
    },
    {
      kind: 'select',
      name: 'shiftType',
      label: t('filters.shiftType'),
      ariaLabel: t('filters.shiftType'),
      allLabel: t('filters.allShiftTypes'),
      options: [
        { value: 'fixed', label: SHIFT_TYPE_LABEL.fixed },
        { value: 'roster', label: SHIFT_TYPE_LABEL.roster },
      ],
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.shiftType') }),
    },
    {
      kind: 'select',
      name: 'shiftId',
      label: t('filters.backupShift'),
      ariaLabel: t('filters.backupShift'),
      allLabel: t('filters.allBackupShifts'),
      options: shifts.map((sh) => ({ value: sh.id, label: `${sh.code ?? '—'} — ${sh.name}` })),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.backupShift') }),
    },
    {
      kind: 'select',
      name: 'status',
      label: t('filters.status'),
      ariaLabel: t('filters.status'),
      allLabel: t('filters.allStatuses'),
      options: [
        { value: 'current', label: STATUS_LABEL.current },
        { value: 'scheduled', label: STATUS_LABEL.scheduled },
        { value: 'notRecorded', label: STATUS_LABEL.notRecorded },
      ],
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.status') }),
    },
  ];
  const filterValues = {
    q: q ?? '',
    shiftType: shiftType ?? '',
    shiftId: shiftId ?? '',
    status: status ?? '',
    scheduleGroupId: scheduleGroupId ?? '',
  };
  const activeCount = [q, shiftType, shiftId, status, scheduleGroupId].filter(Boolean).length;
  const filterLabels = {
    filter: t('filters.filter'),
    apply: t('filters.apply'),
    clearAll: t('filters.clearAll'),
    activeCount: t('filters.activeCount', { count: activeCount }),
  };

  // Everything the island shows is resolved HERE — a uuid is not an answer, and a client island must not
  // be the place a name is looked up.
  const bulkRows: BulkRow[] = rows.map((r) => ({
    employmentId: r.employmentId,
    employeeCode: r.employeeCode,
    name: r.name,
    company: r.company,
    scheduleGroupName: r.scheduleGroupName,
    shiftLabel: r.shiftName ? `${r.shiftCode ?? '—'} — ${r.shiftName}` : null,
  }));
  // ACTIVE groups only. An inactive rule stays assigned where it already is (db/schema.ts
  // attendance_rule.status) but is never something a batch puts seventy-four people into.
  const groupOptions = scheduleGroups
    .filter((g) => g.status === 'active')
    .map((g) => ({ id: g.id, name: g.name }));

  // `bulkChanged` / `bulkUnchanged` come back from the action as counts. Read as NUMBERS, and a
  // non-numeric value (a hand-edited url) simply shows no note rather than rendering itself.
  const changed = Number(sp.bulkChanged);
  const unchanged = Number(sp.bulkUnchanged);
  const showResult = !sp.error && Number.isInteger(changed) && Number.isInteger(unchanged);

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('bulkTitle')}
        description={t('bulkDescription')}
        back={{ href: hrefWith(PAGE), label: t('detailBack') }}
        actions={
          <FilterPanel action={BULK} fields={filterFields} values={filterValues} labels={filterLabels} />
        }
      />
      <FilterChips action={BULK} fields={filterFields} values={filterValues} labels={filterLabels} />

      <ErrorBanner message={sp.error} />
      {showResult ? (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
          {t('bulkDoneNote', { changed, unchanged })}
        </p>
      ) : null}

      <Card>
        <SectionHeader title={t('listTitle')} count={bulkRows.length} />
        {groupOptions.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('groupLibraryEmpty')}</p>
        ) : null}
        <BulkScheduleGroupForm rows={bulkRows} groups={groupOptions} returnTo={hrefWith(BULK)} />
        <p className="px-4 py-3 text-xs text-muted-foreground">{t('bulkHint')}</p>
        <p className="px-4 pb-4 text-xs text-muted-foreground">{t('activeOnlyNote')}</p>
      </Card>
    </div>
  );
}
