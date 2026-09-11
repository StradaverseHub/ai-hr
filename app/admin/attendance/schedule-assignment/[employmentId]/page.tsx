import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import {
  listShiftArrangements,
  shiftArrangementHistory,
  type ShiftArrangementListRow,
} from '@/core/shift-arrangement';
import { listShiftsForTenant } from '@/core/roster';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  Card,
  ErrorBanner,
  PageHeader,
  SectionHeader,
  btnPrimary,
  pageWideCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { EmployeeShiftFields } from '@/components/employee-shift-fields';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { removeScheduleArrangementAction, saveScheduleAssignmentAction } from '../actions';
import { StatusChip } from '../status-chip';

/**
 * Shift arrangement — ONE employee's, on a page of its own (feedback a485afa1 rev 2, r265).
 *
 * THE ITEM IN ONE LINE. r263 gave the Schedule Assignment list an inline editor: View / Edit opened a
 * panel ABOVE the list (`?assign=<id>#assign-panel`), so on a 74-row list the browser jumped to the top
 * and Close put the administrator back at the top rather than at the row they were on. The reporter
 * contested it: View / Edit must open a screen of its own, Save must return to the refreshed list, and
 * Cancel / Back must write nothing. This page is that screen; the list is a list again.
 *
 * WHAT DID NOT CHANGE, and is pinned by test/schedule-assignment.test.ts: this is still the SAME record
 * the employee's own profile shows, edited through the SAME control (components/employee-shift-fields.tsx)
 * and the SAME writer (core/shift-arrangement.ts assignEmployeeShiftDated, via ../actions.ts). Nothing
 * here decides what is stored. The shape copied is the shift library's list → [shiftId] edit page
 * (app/admin/attendance/[shiftId]/page.tsx + shift-form.tsx): PageHeader with a back link, Save plus a
 * Cancel link to the list, and a refusal that lands back on THIS page with `?error=` so nothing typed is
 * lost (shift-actions.ts errTarget).
 *
 * THREE BLOCKS, top to bottom: what is in force today (read-only — the same row the list shows, read
 * with the same resolver so the two can never disagree), the three fields to change it, and the history
 * with Remove on the newest change only (see the history section for why only the newest).
 *
 * WHERE EVERY WAY OUT LEADS. The filters the administrator was working under ride along in this page's
 * query string (`?q=&shiftType=&shiftId=&status=`), untouched. Back and Cancel are plain links to the
 * list with those filters plus `focus=<id>#row-<id>`: the browser lands on the row, highlighted, and
 * nothing was posted. Save posts `returnTo` (this page's own URL) and the action sends a success to the
 * list the same way with `saved=1`, and a refusal back here with the reason — shown immediately above
 * the fields — AND with what was typed echoed in the url (`typedShiftType` / `typedShiftId` /
 * `typedEffectiveFrom`; the backup shift cannot ride under `shiftId`, which is the list's FILTER of the
 * same name), so the form re-renders with the operator's own values rather than what is on file:
 * "nothing you entered is lost". Remove stays here with `removed=1`: the administrator is looking at the
 * history they just changed.
 *
 * `[employmentId]` IS AN UNTRUSTED URL SEGMENT AND `employment.id` IS A UUID COLUMN. Its shape is
 * checked BEFORE any query (the r263 verifier's 500: junk reached `eq(employment.id, …)` and Postgres
 * threw "invalid input syntax for type uuid"). Junk, an unknown id and a terminated employment all
 * render the same sentence with the back link — never notFound(), never a crash: a stale bookmark is
 * told its employee is not on this list. `?assign=<id>` links written before r265 are redirected here
 * by the list page, so r263 bookmarks keep working.
 *
 * requireAdmin(), like the list and every other row of the Attendance menu: it names an employee and
 * changes their paid hours. The menu is not what protects it (test/attendance-menu-relocation.test.ts).
 * Registered in lib/permissions.ts on the shift-library column in the same commit as this file.
 */
const PAGE = '/admin/attendance/schedule-assignment';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function ShiftArrangementPage({
  params,
  searchParams,
}: {
  params: Promise<{ employmentId: string }>;
  searchParams: Promise<{
    q?: string;
    shiftType?: string;
    shiftId?: string;
    status?: string;
    error?: string;
    removed?: string;
    typedShiftType?: string;
    typedShiftId?: string;
    typedEffectiveFrom?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.scheduleAssignment');
  const { employmentId: rawId } = await params;
  const sp = await searchParams;

  // The list's four filters, parsed exactly as the list parses them (by VALUE, never by presence) so
  // the URL this page hands back is one the list will read the same way it read it before.
  const q = sp.q?.trim() || undefined;
  const shiftType = sp.shiftType === 'fixed' || sp.shiftType === 'roster' ? sp.shiftType : undefined;
  const status =
    sp.status === 'current' || sp.status === 'scheduled' || sp.status === 'notRecorded' ? sp.status : undefined;
  const shiftId = sp.shiftId?.trim() || undefined;
  const hrefWith = (pathname: string, extra: Record<string, string | undefined>, fragment = '') => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, shiftType, shiftId, status, ...extra })) {
      if (v) p.set(k, v);
    }
    const qs = p.toString();
    return `${pathname}${qs ? `?${qs}` : ''}${fragment}`;
  };

  const employmentId = UUID_RE.test(rawId) ? rawId : undefined;
  // ONE "today" for the whole page — the summary's status and the effective-date default answer to the
  // same calendar day, in the tenant's timezone, exactly as the list resolves it.
  const today = todayInKualaLumpur();
  // THE SAME READ THE LIST USES, narrowed to one employment — never re-deciding "current" here.
  const [row] = employmentId ? await listShiftArrangements(s, { employmentId, today }) : [];

  if (!row) {
    // Junk, an unknown id, or a terminated employment (which the list read excludes on purpose — a
    // leaver's history stays on their own profile). Say so, with the way back; never a 500.
    return (
      <div className={pageWideCls}>
        <PageHeader
          title={t('detailTitle')}
          back={{ href: hrefWith(PAGE, {}), label: t('detailBack') }}
        />
        <Card>
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('panelMissing')}</p>
        </Card>
      </div>
    );
  }

  const [history, libraryShifts] = await Promise.all([
    shiftArrangementHistory(s, row.employmentId),
    // WITH archived rows, then filtered: a currently-assigned-but-later-archived shift must still render
    // as the selected option (instead of silently showing the placeholder), exactly as the personnel
    // card loads it. New assignments of archived shifts are refused by the service.
    listShiftsForTenant(s, { includeArchived: true }),
  ]);
  const shifts = libraryShifts.filter((sh) => !sh.archivedAt || sh.id === row.shiftId);

  const SHIFT_TYPE_LABEL: Record<ShiftArrangementListRow['shiftType'], string> = {
    fixed: t('shiftTypeFixed'),
    roster: t('shiftTypeRoster'),
  };
  const STATUS_LABEL: Record<ShiftArrangementListRow['status'], string> = {
    current: t('statusCurrent'),
    scheduled: t('statusScheduled'),
    notRecorded: t('statusNotRecorded'),
  };
  const STATUS_HINT: Record<ShiftArrangementListRow['status'], string> = {
    current: t('statusCurrentHint'),
    scheduled: t('statusScheduledHint'),
    notRecorded: t('statusNotRecordedHint'),
  };

  // WHAT WAS TYPED, echoed by a refused save (../actions.ts). Untrusted url values, each shape-checked;
  // a malformed one silently falls back to what is on file. A well-formed backup shift that is not in
  // the dropdown (archived since, or forged) selects nothing, which the `required` control then refuses.
  const typedType =
    sp.typedShiftType === 'fixed' || sp.typedShiftType === 'roster' ? sp.typedShiftType : undefined;
  const typedShiftId = sp.typedShiftId && UUID_RE.test(sp.typedShiftId) ? sp.typedShiftId : undefined;
  const typedEffectiveFrom =
    sp.typedEffectiveFrom && ISO_DATE_RE.test(sp.typedEffectiveFrom) ? sp.typedEffectiveFrom : undefined;

  /** Back and Cancel: the list, same filters, landed on this employee's row. Nothing is posted. */
  const listHref = hrefWith(PAGE, { focus: row.employmentId }, `#row-${row.employmentId}`);
  /** What the two actions get back: THIS page, with the filters still on it. See ../actions.ts backTo. */
  const returnTo = hrefWith(`${PAGE}/${row.employmentId}`, {});

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('detailTitle')}
        description={[row.name, row.employeeCode ?? '—', row.company].join(' · ')}
        back={{ href: listHref, label: t('detailBack') }}
      />

      {!sp.error && sp.removed ? (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
          {t('removedNote')}
        </p>
      ) : null}

      {/* IN FORCE TODAY — read-only, and the same four cells the list row shows for this employee. */}
      <Card>
        <SectionHeader title={t('summaryTitle')} />
        <dl className="grid gap-4 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">{t('colShiftType')}</dt>
            <dd className="mt-1">{SHIFT_TYPE_LABEL[row.shiftType]}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">{t('colBackupShift')}</dt>
            <dd className="mt-1">{row.shiftName ? `${row.shiftCode ?? '—'} — ${row.shiftName}` : '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">{t('colEffectiveFrom')}</dt>
            <dd className="mt-1 tabular-nums">{row.effectiveFrom ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">{t('colStatus')}</dt>
            <dd className="mt-1 flex items-center gap-2">
              <StatusChip status={row.status} label={STATUS_LABEL[row.status]} hint={STATUS_HINT[row.status]} />
              <span className="text-xs text-muted-foreground">{STATUS_HINT[row.status]}</span>
            </dd>
          </div>
        </dl>
      </Card>

      {/* CHANGE THE ARRANGEMENT — the personnel card's own control, from the same file, posting to the
          same writer. `defaultEffectiveFrom` is today in the tenant's calendar, resolved on the server
          exactly as the card resolves it. */}
      <Card>
        <SectionHeader title={t('changeTitle')} />
        {/* THE REASON A SAVE WAS REFUSED sits immediately above the fields it is about — not under the
            page header, two cards away from the boxes the operator has to change. */}
        {sp.error ? (
          <div className="px-4 pt-4">
            <ErrorBanner message={sp.error} />
          </div>
        ) : null}
        <form action={saveScheduleAssignmentAction} className="space-y-3 p-4">
          <input type="hidden" name="employmentId" value={row.employmentId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <EmployeeShiftFields
            defaultType={typedType ?? row.shiftType}
            defaultShiftId={typedShiftId ?? row.shiftId}
            defaultEffectiveFrom={typedEffectiveFrom ?? today}
            shifts={shifts.map((sh) => ({
              id: sh.id,
              label: `${sh.code ?? '—'} — ${sh.name} (${sh.startTime.slice(0, 5)}–${sh.endTime.slice(0, 5)})`,
            }))}
          />
          <div className="flex items-center gap-3">
            <button className={btnPrimary}>{t('panelSave')}</button>
            <Link href={listHref} className="text-sm text-muted-foreground hover:text-foreground hover:underline">
              {t('detailCancel')}
            </Link>
          </div>
        </form>
        <p className="px-4 pb-3 text-xs text-muted-foreground">{t('panelHint')}</p>
      </Card>

      {/* SHIFT HISTORY, and the place the most recent change is taken back off. LIVE periods only — a
          second save for the same date REPLACES its entry rather than adding a line, which is why a
          replaced entry is not here to remove. The Remove form is a SIBLING of the save form, never
          nested inside it: a form inside a form is invalid HTML and the inner one is dropped by the
          parser.

          ⚠️ REMOVE IS ON THE NEWEST ROW ONLY, and `historyRemoveNote` says so on screen. Removal is
          undone by saving the same arrangement back at the same date, and the writer refuses a date
          earlier than the ladder's last (ShiftBackInsertError, back-insert out of scope for v1) — so an
          OLDER row, once removed, could not be put back at either door, and the stretch of time it
          governed would permanently revert to the earlier shift with attendance and overtime deriving
          against that. core/shift-arrangement.ts enforces the same rule against a forged POST
          (ShiftArrangementNotNewestError); this only decides what is offered. The confirmation is the
          second half: even the recoverable removal moves somebody's paid hours, so it is not a single
          click. */}
      <Card>
        <div className="px-4 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('historyTitle')}
        </div>
        {history.length === 0 ? (
          <p className="px-4 pb-4 pt-2 text-sm text-muted-foreground">{t('historyEmpty')}</p>
        ) : (
          <div className="px-4 pb-4 pt-2">
            <div className={tableWrapCls}>
              <table className="w-full text-sm">
                <thead className={theadCls}>
                  <tr>
                    <th className={thCls}>{t('historyColEffective')}</th>
                    <th className={thCls}>{t('historyColPrevious')}</th>
                    <th className={thCls}>{t('historyColNew')}</th>
                    <th className={thCls}>{t('historyColChangedBy')}</th>
                    <th className={thCls}>{t('historyColChangedOn')}</th>
                    <th className={thCls}></th>
                  </tr>
                </thead>
                <tbody className={tbodyCls}>
                  {history.map((h, i) => (
                    <tr key={h.id}>
                      <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{h.effectiveFrom}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {h.previousShiftName ? `${h.previousShiftCode ?? '—'} — ${h.previousShiftName}` : '—'}
                      </td>
                      <td className="px-3 py-2.5">{`${h.shiftCode ?? '—'} — ${h.shiftName}`}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{h.changedByName ?? '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">
                        {h.recordedOnRelease ? t('historyRecordedOnRelease') : h.changedAt.slice(0, 10)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {/* history is newest-first (core/shift-arrangement.ts shiftArrangementHistory
                            ends `.reverse()`), so row 0 IS the newest. */}
                        {i === 0 && history.length > 1 ? (
                          <form action={removeScheduleArrangementAction}>
                            <input type="hidden" name="employmentId" value={row.employmentId} />
                            <input type="hidden" name="arrangementId" value={h.id} />
                            <input type="hidden" name="returnTo" value={returnTo} />
                            <ConfirmSubmit
                              size="sm"
                              aria-label={t('removeAria', { date: h.effectiveFrom })}
                              title={t('removeConfirmTitle')}
                              subtitle={t('removeConfirmSubject', { date: h.effectiveFrom })}
                              description={t('removeConfirmBody')}
                              confirmLabel={t('remove')}
                            >
                              {t('remove')}
                            </ConfirmSubmit>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="pt-2 text-xs text-muted-foreground">{t('historyRemoveNote')}</p>
          </div>
        )}
      </Card>
    </div>
  );
}
