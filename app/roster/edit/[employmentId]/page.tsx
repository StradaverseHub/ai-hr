import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { rosterMonthView } from '@/core/roster';
import { Card, EmployeeCode, ErrorBanner, PageHeader, SectionHeader, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { cellKey, isMonthParam, monthOf, resolveRosterCell, rosterCellLabel, shiftCodeOf } from '@/lib/roster-month';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { saveRosterRowAction } from '../../actions';
import { RosterEditDates, type EditDate } from './date-picker';

/**
 * ONE EMPLOYEE'S MONTH, ON A SCREEN OF ITS OWN (a57f0584 rev 2).
 *
 * WHAT MOVED AND WHY. Edit used to toggle a panel at the FOOT of /roster: on a 75-row roster the browser
 * jumped away from the row that was clicked, and Close put the administrator back at the top of a grid
 * they had scrolled sideways through. The reporter asked for a screen, and this codebase already has the
 * shape — the TP1 declaration form and app/admin/attendance/schedule-assignment/[employmentId] are both
 * "own page, Save returns to the refreshed list". This is that, for the roster.
 *
 * NOT A CONFIRM AND NOT A MODAL. The row editor also asked `window.confirm("Set N dates for this
 * employee?")` before saving — a browser dialog standing in for a screen that could simply SHOW what it
 * was about to do. It is gone; the Apply button names the count, and the past-date warning is a line on
 * the page that updates as dates are ticked (date-picker.tsx) rather than an interruption. The grid keeps
 * its own past-date confirm, because a single painted cell has no screen to move to — see the note on
 * `confirmPast` in components/roster-grid.tsx.
 *
 * IT IS THE SAME READ AS THE GRID. `rosterMonthView(..., { employmentIds: [id] })` — the same view,
 * narrowed to one person — so every tile resolves through `resolveRosterCell` at the same precedence the
 * roster behind it drew, and the date captions come from the same Intl formatter. A second read here is
 * how the editor comes to show RD on a day the grid shows OFF.
 *
 * AND THE SAME WRITE. Save posts to `saveRosterRowAction`, a thin wrapper over the unchanged
 * `rowAssignAction` → `assignRosterRow`, which loops the PER-DATE primitives so the Audit Trail gets one
 * reversible entry per date with the shift before and after. Nothing about who may write, or what is
 * written, moved with the screen.
 *
 * GUARD: `scopedAdmin()` — `requireAdmin` plus the active company scope, the same two admin roles the
 * matrix derives for requireAdmin (lib/permissions.ts registers this route beside /roster/import for
 * that reason). It names an employee and rewrites their paid days; the roster's own `scopedSession` is
 * not enough, and a missing Edit link is an affordance rather than a guard.
 *
 * `[employmentId]` IS AN UNTRUSTED URL SEGMENT. It is never handed to a query here — it is matched
 * against the ids the scoped month view returned — so junk, an unknown id, a terminated employment and
 * somebody else's employee all render the same sentence with the way back, never a 500 and never
 * notFound().
 */
export default async function RosterEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ employmentId: string }>;
  searchParams: Promise<{
    companyId?: string;
    month?: string;
    bu?: string;
    dept?: string;
    q?: string;
    error?: string;
    picked?: string | string[];
    brush?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('roster');
  const locale = await getLocale();
  const { employmentId } = await params;
  const sp = await searchParams;

  const companies = (await listCompanies(s)).filter((c) => scopeIds.length === 0 || scopeIds.includes(c.id));
  const companyId = sp.companyId && companies.some((c) => c.id === sp.companyId) ? sp.companyId : null;
  const companyIds = companyId ? [companyId] : companies.map((c) => c.id);
  const todayIso = todayInKualaLumpur();
  const month = isMonthParam(sp.month) ? sp.month : monthOf(todayIso);

  /** The roster's own query string — what Back and Cancel return to, and what the action round-trips. */
  const listQuery = new URLSearchParams({ month });
  if (companyId) listQuery.set('companyId', companyId);
  if (sp.bu) listQuery.set('bu', sp.bu);
  if (sp.dept) listQuery.set('dept', sp.dept);
  if (sp.q) listQuery.set('q', sp.q);
  const listHref = `/roster?${listQuery.toString()}`;

  const view = await rosterMonthView(s, { companyIds, month, employmentIds: [employmentId] });
  const employee = view.employees.find((e) => e.employmentId === employmentId) ?? null;

  if (!employee) {
    return (
      <div className={pageWideCls}>
        {/* NOT `rowEditTitle` with a placeholder name: "Edit month — —" reads as a rendering fault. The
            screen has no employee, so it is the roster's own title plus the sentence and the way back. */}
        <PageHeader title={t('title')} back={{ href: listHref, label: t('exceptionsBack') }} />
        <Card>
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('rowEditMissing')}</p>
        </Card>
      </div>
    );
  }

  const dowFmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const dayFmt = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', timeZone: 'UTC' });
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shiftCodeById = new Map(view.shifts.map((sh) => [sh.id, shiftCodeOf(sh)]));
  const codeOf = (id: string) => shiftCodeById.get(id) ?? '?';

  const editDates: EditDate[] = view.dates.map((iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    const cell = resolveRosterCell(iso, view.cells[cellKey(employmentId, iso)] ?? null, view.usual[employmentId] ?? null);
    return {
      iso,
      day: dayFmt.format(d),
      dow: dowFmt.format(d),
      current: rosterCellLabel(cell, codeOf, t('rdCode'), t('offCode')),
      past: iso <= todayIso,
    };
  });

  // A refused save comes back here with what was ticked, so nothing the administrator chose is lost.
  const picked = sp.picked == null ? [] : Array.isArray(sp.picked) ? sp.picked : [sp.picked];
  const initialPicked = picked.filter((iso) => view.dates.includes(iso));
  const errorMessage = sp.error === 'noDates' ? t('rowEditNoDates') : sp.error;

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('rowEditTitle', { name: employee.name })}
        description={monthFmt.format(new Date(`${view.from}T00:00:00Z`))}
        back={{ href: listHref, label: t('exceptionsBack') }}
      />
      <ErrorBanner message={errorMessage} />
      <Card>
        <SectionHeader title={t('rowEditSection')} />
        <div className="space-y-4 px-4 py-4">
          <p className="flex flex-wrap items-baseline gap-2 text-sm">
            <span className="font-medium">{employee.name}</span>
            {employee.code && (
              <span className="font-normal text-muted-foreground">
                (<EmployeeCode code={employee.code} />)
              </span>
            )}
            {employee.occupation && <span className="text-xs text-muted-foreground">{employee.occupation}</span>}
          </p>
          <p className="text-xs text-muted-foreground">{t('rowEditHint')}</p>

          {view.shifts.length === 0 ? (
            /* NOT `createShiftFirst` — it says "Create a shift ABOVE", which is true on the roster and
               false here: there is nothing above on this screen. This line says where shifts actually
               live, which is the useful answer on either. */
            <p className="text-sm text-muted-foreground">{t('manageShiftsHint')}</p>
          ) : (
            <form action={saveRosterRowAction} className="space-y-4">
              <input type="hidden" name="employmentId" value={employmentId} />
              <input type="hidden" name="listQuery" value={listQuery.toString()} />
              <RosterEditDates dates={editDates} initial={initialPicked} />
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {t('brush')}
                  <select name="brush" defaultValue={sp.brush ?? view.shifts[0]?.id} aria-label={t('brush')} className={inputCls}>
                    {view.shifts.map((sh) => (
                      <option key={sh.id} value={sh.id}>
                        {shiftCodeOf(sh)} · {sh.name}
                      </option>
                    ))}
                    <option value="rest">{t('restDay')}</option>
                    <option value="clear">{t('clear')}</option>
                  </select>
                </label>
                <button className={btnPrimary}>{t('rowEditSave')}</button>
                <Link href={listHref} className="rounded-md border border-border px-2.5 py-1 text-sm hover:bg-muted">
                  {t('rowEditCancel')}
                </Link>
              </div>
            </form>
          )}
        </div>
      </Card>
    </div>
  );
}
