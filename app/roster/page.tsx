import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { listCompanies, listDepartments } from '@/core/read';
import { rosterExceptionCount, rosterMonthView } from '@/core/roster';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { RosterGrid, RosterTemplateButton } from '@/components/roster-grid';
import { copyRosterAction, generateRosterAction } from './actions';
import { addDaysIso, addMonths, buildRosterTemplate, isMonthParam, monthOf, shiftCodeOf } from '@/lib/roster-month';

import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * Roster scheduling (ADR-0032 C3) — the MONTHLY shift roster for one company's employees. Manager/admin
 * only via RLS (can_admin_employment).
 *
 * 23390097 turned this screen from a seven-day window into a month: one column per date, the identity
 * columns pinned left, weekends shaded, Business Group / Department / Employee filters and a Query
 * button, an Excel round trip, and an export. The DATA LAYER did not move — roster_assignment already
 * held (employment, date, shift, is_rest_day) and every attendance, lateness and overtime figure is
 * already measured against it. This was a screen problem.
 *
 * Roster deliberately stays BESIDE Attendance in the sidebar rather than inside it: the Attendance menu
 * is administrators-only, and a supervisor who is not an administrator still needs the roster. Uploading
 * is administrators-only either way — that button is gated below and /roster/import calls requireAdmin.
 */
export default async function RosterPage({
  searchParams,
}: {
  searchParams: Promise<{
    companyId?: string;
    month?: string;
    bu?: string;
    dept?: string;
    q?: string;
    error?: string;
    generated?: string;
    copied?: string;
    rowSaved?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const t = await getTranslations('roster');
  const locale = await getLocale();
  const sp = await searchParams;

  const companies = (await listCompanies(s)).filter((c) => scopeIds.length === 0 || scopeIds.includes(c.id));
  if (companies.length === 0) {
    // a57f0584 — the empty state takes the SAME width as the screen. It was mx-auto max-w-6xl, which is a
    // page-level cap on a screen whose whole point is being full width; one card of text is no reason for
    // the header above it to sit at a different width from every other state of this page.
    return (
      <div className={pageWideCls}>
        <PageHeader title={t('title')} description={t('subtitle')} />
        <Card className="p-4 text-sm text-muted-foreground">{t('noCompanies')}</Card>
      </div>
    );
  }
  /**
   * a57f0584 — THE COMPANY NO LONGER DECIDES WHAT YOU SEE; it narrows it.
   *
   * This read `companies[0].id` when nothing was chosen, so an operator with twelve companies opened
   * Roster on whichever sorted first — measured on production: 31 of 75 employees in the largest, the
   * rest spread across eight more — and the only way to see the others was to switch company eleven
   * times. That is the ticket's "I cannot immediately see the overall employee roster". The filters were
   * never the fault, and the plan said so before this was built.
   *
   * `companies` is already `listCompanies(s)` narrowed to `scopeIds`, so opening on all of them widens
   * what is ASKED FOR and not what is permitted. Nothing about who may be seen changes.
   */
  const companyId = sp.companyId && companies.some((c) => c.id === sp.companyId) ? sp.companyId : null;
  const companyIds = companyId ? [companyId] : companies.map((c) => c.id);
  const todayIso = todayInKualaLumpur();
  const month = isMonthParam(sp.month) ? sp.month : monthOf(todayIso);
  const admin = isAdmin(s);

  const view = await rosterMonthView(s, {
    companyIds,
    month,
    ...(sp.bu ? { businessUnitId: sp.bu } : {}),
    ...(sp.dept ? { departmentId: sp.dept } : {}),
    ...(sp.q ? { q: sp.q } : {}),
  });

  /**
   * a57f0584 rev 2 — ONLY THE COUNT. "This week's exceptions" was a full listing rendered at the foot of
   * this screen; it is now the Exceptions button below, and the rows live on /roster/exceptions. The
   * roster therefore reads a number, and the TOIL policy read that only ever existed to decide whether a
   * rest-worked row got a "Bank in lieu" button went WITH the rows — it belongs to the screen that draws
   * them.
   */
  const [exceptionCount, departments] = await Promise.all([
    rosterExceptionCount(s, { from: view.from, to: view.to, companyIds, today: todayIso }),
    listDepartments(s, { companyIds }),
  ]);

  // Success banner for the roster generator: "employments.workingRows.restRows" packed by the action.
  const gen = sp.generated && /^\d+\.\d+\.\d+$/.test(sp.generated) ? sp.generated.split('.').map(Number) : null;
  // R17 3e8350db — success banner for "copy roster": the number of rows copied onto the target window.
  const copiedCount = sp.copied && /^\d+$/.test(sp.copied) ? Number(sp.copied) : null;
  // a57f0584 rev 2 — "comes back to the roster with your change already showing". The Edit SCREEN redirects
  // here after a save; `rowAssignAction` revalidated /roster, so the grid below is the saved month and this
  // line says how many dates it covers. Without it the administrator lands on a page that looks unchanged.
  const rowSaved = sp.rowSaved && /^\d+$/.test(sp.rowSaved) ? Number(sp.rowSaved) : null;
  const dowFmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  /**
   * a57f0584 rev 2 — THE DATE HEADING, CHANGED IN THE FORMATTER AND NOWHERE ELSE.
   *
   * It read `01/09`, which a reader has to be told whether to parse as day-month or month-day, and the
   * reporter asked for the month to be named. `{ day: '2-digit', month: 'short' }` through Intl in the
   * VIEWER'S locale, never a hardcoded ['Jan','Feb',…]: that array is the trap the Excel template header
   * (lib/roster-month#ROSTER_TEMPLATE_ID_COLUMNS) records from the other direction, and it would print
   * English months on a Malay screen. The grid renders what it is handed, so there is still exactly ONE
   * rendition of a date on this screen and the export cannot drift from it.
   *
   * ⚠️ ORDER IS THE LOCALE'S, NOT OURS. `en` is en-US here and yields "Sep 01"; en-GB would yield
   * "01 Sept", which is the spelling in the plan. Reordering the parts by hand would be exactly the
   * hardcoding this avoids — if day-first English is wanted, the answer is an en-GB locale, not a
   * formatter that knows better than Intl.
   */
  const dayFmt = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', timeZone: 'UTC' });
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const gridDates = view.dates.map((iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return { iso, dow: dowFmt.format(d), day: dayFmt.format(d) };
  });
  const monthLabel = monthFmt.format(new Date(`${view.from}T00:00:00Z`));

  // Filter dropdown values come from the employees this session can already see, so a Business Group
  // with nobody in it never appears and a supervisor is never offered somebody else's department.
  const buOptions = dedupe(view.allEmployees.map((e) => ({ id: e.businessUnitId, name: e.businessUnit })));
  const deptOptions = dedupe(view.allEmployees.map((e) => ({ id: e.departmentId, name: e.department })));

  const qs = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams({ month });
    if (companyId) p.set('companyId', companyId);
    if (sp.bu) p.set('bu', sp.bu);
    if (sp.dept) p.set('dept', sp.dept);
    if (sp.q) p.set('q', sp.q);
    for (const [k, v] of Object.entries(over)) {
      if (v == null || v === '') p.delete(k);
      else p.set(k, v);
    }
    return p.toString();
  };
  const monthHref = (m: string) => `/roster?${qs({ month: m })}`;
  const navBtn = 'rounded-md border border-border px-2.5 py-1 text-sm text-foreground hover:bg-muted';

  // The Excel template is the month grid PRE-FILLED WITH WHAT IS ROSTERED — never with the grey ghosts.
  // A ghosted day has no stored row; writing its code into the template and sending it back would harden
  // every un-rostered day into an explicit assignment, which is not what "prepare the month" means.
  // Its four identity headings are the MACHINE header (lib/roster-month#ROSTER_TEMPLATE_ID_COLUMNS) and
  // stay English in every locale — a translated heading made the round trip impossible outside en.
  const shiftCodeById = new Map(view.shifts.map((sh) => [sh.id, shiftCodeOf(sh)]));
  const template = buildRosterTemplate({
    dates: view.dates,
    employees: view.employees,
    cells: view.cells,
    shiftCode: (id) => shiftCodeById.get(id) ?? '',
  });

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('title')} description={t('subtitle')} />
      <ErrorBanner message={sp.error} />
      {gen && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300">
          {t('generated', { employees: gen[0], working: gen[1], rest: gen[2] })}
        </div>
      )}
      {copiedCount != null && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300">
          {copiedCount > 0 ? t('copiedDone', { rows: copiedCount }) : t('copiedEmpty')}
        </div>
      )}
      {rowSaved != null && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300">
          {t('rowApplied', { count: rowSaved })}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {companies.length > 1 ? (
          <form method="get" className="flex items-center gap-2">
            <input type="hidden" name="month" value={month} />
            <select name="companyId" defaultValue={companyId ?? ''} className={inputCls}>
              {/* a57f0584 — and it is the DEFAULT, not merely available: the screen opens on everyone. */}
              <option value="">{t('allCompanies')}</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className={navBtn}>{t('switch')}</button>
          </form>
        ) : (
          <span className="text-sm font-medium">{companies[0].name}</span>
        )}
        {/* Upload and its template are ADMINISTRATORS ONLY, together: /roster/import calls requireAdmin,
            so a template handed to a supervisor is a file they could never send back. Export stays open —
            reading the month is exactly what a supervisor is here to do. */}
        <div className="flex flex-wrap items-center gap-2">
          {admin && (
            <>
              {/* Upload targets ONE company's roster too — /roster/import reads a companyId. */}
              {companyId && (
                <Link href={`/roster/import?companyId=${companyId}&month=${month}`} className={navBtn}>
                  {t('uploadRoster')}
                </Link>
              )}
              <RosterTemplateButton
                dates={view.dates}
                rows={template.rows}
                month={month}
                codes={view.shifts.map((sh) => shiftCodeOf(sh))}
                label={t('downloadTemplate')}
                notesTitle={t('templateNotesTitle')}
                notes={[
                  t('templateNoteBlank'),
                  t('templateNoteCode'),
                  t('templateNoteRd'),
                  t('templateNoteOff'),
                  t('templateNoteMonth', { month }),
                ]}
                failedLabel={t('templateFailed')}
              />
            </>
          )}
          {/* a57f0584 rev 2 — EXCEPTIONS IS A BUTTON WITH A COUNT, not a listing bolted to the bottom of
              the roster. The count is what the reporter needs on this screen ("so you still know there
              are any"); the rows are a screen of their own, reached from here with the same month and the
              same filters. It is NOT hidden when the count is zero: an Exceptions button that vanishes
              cannot tell you there is nothing wrong, it can only look like a missing feature. */}
          <Link href={`/roster/exceptions?${qs({})}`} className={navBtn}>
            {t('exceptionsButton', { count: exceptionCount })}
          </Link>
          <Link href={`/roster/export?${qs({ format: 'xlsx' })}`} className={navBtn} prefetch={false}>
            {t('exportLabel')}
          </Link>
        </div>
      </div>

      {/* Filters — Business Group, Department, Employee, Month, and a Query button, exactly the row the
          reporter's own screen carries. A plain GET form: the URL is the state, so a filtered month is
          shareable and the export link below carries the same narrowing. */}
      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3 px-4 py-3">
          {companyId && <input type="hidden" name="companyId" value={companyId} />}
          <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('filterBusinessGroup')}
            <select name="bu" defaultValue={sp.bu ?? ''} className={inputCls}>
              <option value="">{t('filterAll')}</option>
              {buOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('filterDepartment')}
            <select name="dept" defaultValue={sp.dept ?? ''} className={inputCls}>
              <option value="">{t('filterAll')}</option>
              {deptOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('filterEmployee')}
            <input name="q" defaultValue={sp.q ?? ''} placeholder={t('filterEmployeePlaceholder')} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('filterMonth')}
            <input type="month" name="month" defaultValue={month} className={inputCls} />
          </label>
          <button className={btnPrimary}>{t('query')}</button>
          <span className="ml-auto flex items-center gap-2">
            <Link href={monthHref(addMonths(month, -1))} className={navBtn} aria-label={t('prevMonth')}>
              ‹
            </Link>
            <span className="text-sm text-muted-foreground">{monthLabel}</span>
            <Link href={monthHref(addMonths(month, 1))} className={navBtn} aria-label={t('nextMonth')}>
              ›
            </Link>
            <Link href={monthHref(monthOf(todayIso))} className={navBtn}>
              {t('thisMonth')}
            </Link>
          </span>
        </form>
      </Card>

      {/* Configurable Multi-Shift Attendance Management: shift setup moved to Shift settings (admin-only).
          This screen is now purely for assigning shifts onto the calendar; the hint points anyone who looks
          for shift setup here to its new home. The screen was called Attendance Policy when this card was
          written; f21d6eee split the policy config out to /admin/attendance-policy and a324a4b3 renamed
          what is left to Shift settings, so both this comment and roster.manageShiftsHint named the wrong
          screen from mid-July until 2ec1e3d2.

          2ec1e3d2: the SENTENCE is for everybody — a supervisor who cannot open the screen still benefits
          from knowing where the setting lives before asking an administrator for it. The LINK is
          administrators only, because /admin/attendance calls requireAdmin (app/admin/attendance/page.tsx)
          and would bounce a supervisor straight back to '/' with no explanation. Same reasoning, and the
          same shape, as the Upload / Download Template gate above. */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
          <span className="text-muted-foreground">{t('manageShiftsHint')}</span>
          {admin && (
            <Link href="/admin/attendance" className="font-medium text-primary hover:underline">
              {t('manageShiftsLink')} →
            </Link>
          )}
        </div>
      </Card>

      <Card>
        <SectionHeader title={t('monthlyRoster')} count={view.employees.length} />
        <div className="px-4 py-3">
          {view.employees.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noEmployees')}</p>
          ) : view.shifts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('createShiftFirst')}</p>
          ) : (
            <RosterGrid
              dates={gridDates}
              employees={view.employees.map((e) => ({
                employmentId: e.employmentId,
                name: e.name,
                code: e.code,
                occupation: e.occupation,
              }))}
              shifts={view.shifts}
              initial={view.cells}
              usual={view.usual}
              isAdmin={admin}
              today={todayIso}
              editQuery={qs({})}
            />
          )}
        </div>
      </Card>

      {/* R7 Phase 2 — generate a roster window from a shift's weekly pattern. KEPT (with its dates
          retargeted to the month on screen): it and Copy roster are the only bulk roster tools today, and
          dropping them while adding an upload would be a regression dressed as a feature.

          BOTH ARE ADMIN-ONLY, for the same reason the grid is read-only for a supervisor: they write
          roster_assignment, whose RLS requires can_admin_employment, so for anybody else they are a form
          that can only ever end in a 42501. */}
      {/*
        * a57f0584 — GENERATE AND COPY STILL NEED ONE COMPANY, and they say so rather than going quiet.
        *
        * Both WRITE roster_assignment for a named company (generateRosterAction / copyRosterAction each
        * take a companyId), so neither has a meaning across twelve of them: "generate the December
        * roster" is a different instruction per company. Rendering the forms with an empty hidden field
        * would have posted '' and failed in the action, so the affordance is withdrawn and the reason
        * given — a disabled form the operator cannot explain is worse than one that is absent.
        *
        * The READ is unaffected: the whole workforce's month stays on screen behind this.
        */}
      {admin && !companyId && (
        <Card className="p-4 text-sm text-muted-foreground">{t('pickCompanyToEdit')}</Card>
      )}
      {admin && companyId && (
        <Card>
          <SectionHeader title={t('generate')} />
          <div className="space-y-3 px-4 py-3">
            {view.shifts.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('createShiftFirst')}</p>
            ) : (
              <form action={generateRosterAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="companyId" value={companyId} />
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {t('shifts')}
                  <select name="shiftId" required className={inputCls}>
                    {view.shifts.map((sh) => (
                      <option key={sh.id} value={sh.id}>
                        {sh.code ? `${sh.code} · ` : ''}
                        {sh.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {t('scope')}
                  {/* A chosen department wins over the employee multi-select (the action prefers it). */}
                  <select name="departmentId" defaultValue="" className={inputCls}>
                    <option value="">{t('scopeEmployees')}</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {t('scopeDepartment')}: {d.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {t('employee')}
                  <select name="employmentIds" multiple size={4} className={`${inputCls} min-w-44`} aria-label={t('scopeEmployees')}>
                    {view.employees.map((e) => (
                      <option key={e.employmentId} value={e.employmentId}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {t('dateRange')}
                  <span className="flex items-center gap-1.5">
                    <input type="date" name="from" required defaultValue={view.from} className={inputCls} />
                    <span className="text-xs text-muted-foreground">–</span>
                    <input type="date" name="to" required defaultValue={view.to} className={inputCls} />
                  </span>
                </label>
                <button className={btnPrimary}>{t('generate')}</button>
              </form>
            )}
            <p className="text-xs text-muted-foreground">{t('generateHint')}</p>
          </div>
        </Card>
      )}

      {/* R17 3e8350db — "Copy roster schedules from previous weeks or months". Copies every roster row from a
          source window forward onto a target window starting at targetFrom, preserving each row's day-offset.
          Scoped to this company's active employees (posted as hidden employmentIds). Defaults now: source =
          the PREVIOUS month, target = the month on screen. Administrators only, with Generate and for
          the same reason. */}
      {admin && companyId && (
        <Card>
          <SectionHeader title={t('copyTitle')} />
          <div className="space-y-3 px-4 py-3">
            {view.employees.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noEmployees')}</p>
            ) : (
              <form action={copyRosterAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="companyId" value={companyId} />
                {view.employees.map((e) => (
                  <input key={e.employmentId} type="hidden" name="employmentIds" value={e.employmentId} />
                ))}
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {t('copySource')}
                  <span className="flex items-center gap-1.5">
                    <input
                      type="date"
                      name="sourceFrom"
                      required
                      defaultValue={`${addMonths(month, -1)}-01`}
                      className={inputCls}
                    />
                    <span className="text-xs text-muted-foreground">–</span>
                    <input type="date" name="sourceTo" required defaultValue={addDaysIso(view.from, -1)} className={inputCls} />
                  </span>
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {t('copyTargetStart')}
                  <input type="date" name="targetFrom" required defaultValue={view.from} className={inputCls} />
                </label>
                <button className={btnPrimary}>{t('copyButton')}</button>
              </form>
            )}
            <p className="text-xs text-muted-foreground">{t('copyHint')}</p>
          </div>
        </Card>
      )}

    </div>
  );
}

/** Distinct, named options for a filter dropdown, sorted by name. Rows with no value are dropped —
 *  "unassigned" is not a Business Group you can filter to. */
function dedupe(rows: { id: string | null; name: string | null }[]): { id: string; name: string }[] {
  const out = new Map<string, string>();
  for (const r of rows) if (r.id && r.name) out.set(r.id, r.name);
  return [...out].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
