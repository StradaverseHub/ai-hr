'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { inputCls, tbodyCls, theadCls, thCls } from '@/components/ui';
import { bulkAssignScheduleGroupAction } from '../actions';

/** One tickable employee. PLAIN DATA — everything is resolved on the server before it crosses over. */
export type BulkRow = {
  employmentId: string;
  employeeCode: string | null;
  name: string;
  company: string;
  /** The group they are in TODAY, already resolved to a name. Null = in none. */
  scheduleGroupName: string | null;
  /** The shift the arrangement in force puts them on, already resolved. Null = none on file. */
  shiftLabel: string | null;
};

/**
 * 8cd601d0 (r329) — PUT MANY EMPLOYEES IN A SCHEDULE GROUP IN ONE ACTION.
 *
 * WHY THIS SCREEN EXISTS AT ALL. 870b79e2 (r277) shipped the refusal that stops a grouped employee being
 * put on a shift their group forbids, and f513ec02 (r281) shipped a card that seats ONE employment in a
 * group. Measured on production on 2026-09-22: 1 of 75 active employments is in a group, so for the other
 * 74 that correct refusal never fires. The missing piece was never the validation — it was that nobody was
 * going to seat seventy-four people one personnel page at a time.
 *
 * ⚠️ A CLIENT ISLAND ONLY FOR THE TICKING. Everything that decides anything is on the server: which
 * employees are offered (the list's own read, with the list's own filters), which groups are offered, and
 * — the part that matters — whether the batch is allowed at all. The server action it posts to is
 * IMPORTED, never passed in as a prop: a server action handed to a client island as a prop is a 500 at
 * runtime while tsc, the suite and `next build` all stay green.
 *
 * ⚠️ SELECTION IS CONFINED TO THE ROWS ON SCREEN, structurally — the form can only ever carry a hidden
 * input per ticked row, and the rows are what the server rendered. "Select all" means "all of these",
 * never "all 75". Narrowing the filters is how the operator changes what "all" means, and the filters are
 * on the page above this.
 *
 * ⚠️ NO PER-ROW GROUP. One batch sets ONE group, for everybody ticked. A grid of per-row pickers would be
 * the personnel page again with more clicks, and it would make "all or nothing" meaningless: the operator
 * could not say what a refusal had and had not applied to.
 */
export function BulkScheduleGroupForm({
  rows,
  groups,
  returnTo,
}: {
  rows: BulkRow[];
  /** Active Schedule Groups, in the library's own order. Never a list written down in this file. */
  groups: { id: string; name: string }[];
  /** This page's own URL with its filters, so the outcome lands back on the same filtered screen. */
  returnTo: string;
}) {
  const t = useTranslations('admin.scheduleAssignment');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // '' is a REAL value — "take these people out of every Schedule Group" — and the one change that can
  // never be refused. It is not a placeholder, and the action maps it to null in one place.
  const [groupId, setGroupId] = useState<string>('');

  const ids = rows.map((r) => r.employmentId).filter((id) => selected.has(id));
  const allSelected = rows.length > 0 && ids.length === rows.length;
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.employmentId)));

  const chosenGroupName = groups.find((g) => g.id === groupId)?.name ?? t('noScheduleGroup');

  return (
    <form action={bulkAssignScheduleGroupAction}>
      <input type="hidden" name="returnTo" value={returnTo} />
      {/* The ticked rows, as the ONLY thing the batch can act on. Rendered inside the form rather than
          collected in the action, so what is posted is exactly what is ticked on screen. */}
      {ids.map((id) => (
        <input key={id} type="hidden" name="employmentId" value={id} />
      ))}

      <div className="flex flex-wrap items-end gap-3 border-b border-border bg-muted/30 px-4 py-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('colScheduleGroup')}</span>
          <select
            name="attendanceRuleId"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className={inputCls}
          >
            <option value="">{t('noScheduleGroup')}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <span className="text-sm">{t('bulkSelected', { count: ids.length })}</span>
        <div className="ml-auto flex items-center gap-2">
          {/* A batch moves many people's lateness, early-out and overtime rules at once, so it is not a
              single click. The dialog names the group and the count, both derived from what is on screen. */}
          <ConfirmSubmit
            variant="default"
            size="sm"
            disabled={ids.length === 0}
            title={t('bulkConfirmTitle')}
            subtitle={t('bulkConfirmSubject', { group: chosenGroupName, count: ids.length })}
            description={t('bulkConfirmBody')}
            confirmLabel={t('bulkApply')}
          >
            {t('bulkApply')}
          </ConfirmSubmit>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {t('bulkClear')}
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className={theadCls}>
            <tr>
              <th className="w-10 px-4 py-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label={t('bulkSelectAll')}
                  className="h-4 w-4 rounded border-border"
                />
              </th>
              <th className={thCls}>{t('colEmployeeId')}</th>
              <th className={thCls}>{t('colName')}</th>
              <th className={thCls}>{t('colCompany')}</th>
              <th className={thCls}>{t('colScheduleGroup')}</th>
              <th className={thCls}>{t('colBackupShift')}</th>
            </tr>
          </thead>
          <tbody className={tbodyCls}>
            {rows.map((r) => (
              <tr key={r.employmentId} className={selected.has(r.employmentId) ? 'bg-primary/5' : undefined}>
                <td className="px-4 py-2.5">
                  <input
                    type="checkbox"
                    checked={selected.has(r.employmentId)}
                    onChange={() => toggle(r.employmentId)}
                    aria-label={t('bulkSelectAria', { name: r.name })}
                    className="h-4 w-4 rounded border-border"
                  />
                </td>
                <td className="px-3 py-2.5 tabular-nums">{r.employeeCode ?? '—'}</td>
                <td className="px-3 py-2.5 font-medium">{r.name}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{r.company}</td>
                <td className="px-3 py-2.5">
                  {r.scheduleGroupName ?? <span className="text-muted-foreground">{t('noScheduleGroup')}</span>}
                </td>
                <td className="px-3 py-2.5 text-muted-foreground">{r.shiftLabel ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </form>
  );
}
