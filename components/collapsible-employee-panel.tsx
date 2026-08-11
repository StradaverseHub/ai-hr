'use client';

import { useMemo, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Card, EmployeeName, Field, inputCls } from '@/components/ui';

/**
 * The employee panel + workspace two-column shell, with the panel collapsible — 49e7e0a2 (Individual
 * Transaction) and f3ae3245 (Fixed Transaction), which both ask for it in the same words.
 *
 * BUILT ONCE ON PURPOSE. Both transaction screens asked for the same control and NEITHER had one, and no
 * horizontal panel collapse existed anywhere in this codebase before this. `components/collapsible-card-
 * section.tsx` is the VERTICAL details/summary fold; its cookie-persistence shape is reused here (path=/,
 * one year, samesite=lax, server reads it to resolve `defaultOpen` so first paint is already correct and
 * there is no open-then-collapse flash), but its markup solves a different problem and is not reused.
 *
 * WHY IT OWNS THE GRID RATHER THAN LIVING INSIDE THE PANEL. Collapsing the panel has to give its width to
 * the workspace, and only the element that declares the columns can do that. So this component takes both
 * sides and lays them out, which also means the two screens cannot drift into two slightly different
 * collapse behaviours.
 *
 * EVERY PROP IS PLAIN DATA OR A ReactNode — deliberately, and this is not a style preference. A function
 * passed from a SERVER component to a client one returns a 500 on every request while tsc, the test suite
 * and the render check all stay green, and the Fixed Transaction screen is a server component.
 *
 * LABELS: the three control captions may arrive PRE-TRANSLATED (the caller does the literal `t('…')` lookup
 * so the i18n coverage check can still see it) — that is how Individual and Fixed Transaction pass their
 * own wording, and it stays. They are OPTIONAL because the three screens added in r168a say the same thing
 * in the same words: omitting them falls back to the shared `employeePanel` namespace, which is resolved in
 * THIS file. That is not a shortcut — a page that had to fetch a second namespace just for two button
 * captions would stop being a single-namespace file, and check C of the i18n guard skips those entirely.
 * So the fallback BUYS coverage on the consumer page rather than spending it.
 */
// 7c834696-adjacent, found in r168 verification: EVERY toggle here is `print:hidden`.
// app/payroll/individual-payslip/page.tsx wraps the PAYSLIP in this shell, and a payslip is the one
// thing on any of these screens that is actually printed. Every other chrome element on that page is
// already print:hidden and the global sheet (app/globals.css) hides only <aside>/<header>, so without
// this a Save-as-PDF emitted a stray "Hide employee list" line above the letterhead.
// r179 briefly took that screen off this shell and f35f758a rev 2 put it back at the reporter's
// request, so the requirement above is LIVE again — it is not a historical note. 009c8a37 gives the
// control TWO positions, and the class is on both of them.
export function CollapsibleEmployeePanel({
  panel,
  children,
  defaultOpen,
  cookieKey,
  hideLabel,
  showLabel,
  title,
  detailHeader,
  headerClassName,
}: {
  /** The employee list (left). Rendered only while expanded. */
  panel: ReactNode;
  /** The workspace (right). Always rendered; takes the full width while the panel is collapsed. */
  children: ReactNode;
  /** SSR-resolved initial state, read from the cookie by the server page. */
  defaultOpen: boolean;
  /** Cookie persisting the choice. One per screen, so the two do not share a state. */
  cookieKey: string;
  /** Pre-translated label for the control while the panel is OPEN (e.g. "Hide employee list"). */
  hideLabel?: string;
  /** Pre-translated label for the control while the panel is COLLAPSED (e.g. "Show employee list"). */
  showLabel?: string;
  /** 009c8a37 — the screen's own name, shown in the header row while NOBODY is selected. Every consumer
   *  draws no header at all in that state, which is exactly the screenshot the reporter sent: a control
   *  floating above a "choose someone" message. Without this fallback the control would simply vanish. */
  title?: string;
  /**
   * 009c8a37 — what sits on the LEFT of the header row: who is selected, and that screen's ONE primary
   * action. Give the identity `min-w-0 flex-1` so the action and the toggle sit together on the right.
   *
   * A ReactNode, NEVER a callback — see the note above. Six of the seven consumers are server components.
   */
  detailHeader?: ReactNode;
  /** Extra classes for the header row itself. Plain data, and it exists for exactly one caller: the
   *  Individual Payslip screen passes `print:hidden`, because that screen's output IS a printed payslip
   *  and this row is chrome above its letterhead. */
  headerClassName?: string;
}) {
  const t = useTranslations('employeePanel');
  const [open, setOpen] = useState(defaultOpen);
  const hide = hideLabel ?? t('hideEmployees');
  const show = showLabel ?? t('showEmployees');

  const toggle = () => {
    const next = !open;
    setOpen(next);
    document.cookie = `${cookieKey}=${next ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
  };

  /**
   * ONE control, TWO positions, one handler and one cookie key — so the two copies cannot disagree.
   *
   * BELOW `lg` THE GRID STACKS IN DOM ORDER, AND THAT IS THE TRAP. A toggle living only in the detail
   * header lands UNDER the entire employee list on a phone; a toggle rendered only "above the panel"
   * DISAPPEARS the moment you collapse, because the panel branch is not rendered in that state. So the
   * `lg:hidden` copy is the first child of the shell and is rendered in BOTH states, and the
   * `hidden lg:flex` copy lives in the header row.
   */
  const toggleButton = (extra: string) => (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={open}
      title={open ? hide : show}
      className={`items-center justify-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground print:hidden ${extra}`}
    >
      <span aria-hidden>{open ? '☰' : '◀'}</span>
      {open ? hide : show}
    </button>
  );

  return (
    /**
     * 009c8a37 REVERSES A DOCUMENTED DECISION ON PURPOSE — say so, or the next reader reverts it.
     *
     * This shell used to keep a narrow COLLAPSED RAIL in the left column, and the comment there argued it
     * "keeps the control in the same place on the page rather than moving it into the workspace header, so
     * expanding is where collapsing left it". The rail is gone and the control is now in the header row in
     * BOTH states, which answers that concern rather than ignoring it: the control never moves at all, so
     * expanding is still exactly where collapsing left it — and it no longer pushes the employee list down
     * by its own height, which is the misalignment the reporter marked in red.
     *
     * DELETING THE RAIL WAS NOT ENOUGH ON ITS OWN. While collapsed the grid drops to a SINGLE COLUMN and
     * the left cell is not rendered at all. An empty auto column plus `gap-4` still held 16px back from
     * the detail (40px of rail + 16px of gap against the shared `max-w-[100rem]` cap), which is the "use
     * the full available width" requirement.
     */
    <div
      className={`grid gap-4 lg:items-start ${
        open ? 'lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]' : 'lg:grid-cols-1'
      }`}
    >
      {/* The narrow-viewport copy. FIRST child so it is above the employee list when the grid stacks, and
          rendered in both states so collapsing on a phone cannot strand the operator. */}
      <div className="lg:hidden">{toggleButton('flex w-full')}</div>

      {open && <div className="min-w-0">{panel}</div>}

      <div className="min-w-0 space-y-4">
        {/* THE HEADER ROW, RENDERED UNCONDITIONALLY. Every consumer drew no header at all with nobody
            selected, so a row that only appeared once someone was picked would leave the control missing
            on all seven — in exactly the state the reporter photographed. Each screen's own no-selection
            body still renders below this. */}
        <Card
          className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 ${headerClassName ?? ''}`}
        >
          {detailHeader ?? <h2 className="min-w-0 flex-1 text-sm font-semibold text-foreground">{title}</h2>}
          {toggleButton('hidden shrink-0 lg:flex')}
        </Card>
        {children}
      </div>
    </div>
  );
}

/**
 * One employee row for the shared scope panel. Exactly the field set every screen that has ever built one
 * of these settled on independently (Individual Transaction, Fixed Transaction), so pointing a new screen
 * at it is a `.map()` over `listEmployees`, not a new read. `status` is the DERIVED employment status
 * ('active' when not terminated, else 'ended'), computed on the SERVER — deriving it in the browser gets
 * it wrong by a day for anyone whose device clock sits the other side of MYT midnight.
 */
export type ScopeEmployee = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  company: string;
  companyId: string;
  department: string | null;
  departmentId: string | null;
  businessUnit: string | null;
  businessUnitId: string | null;
  status: 'active' | 'ended';
};

/** Same cap Fixed Transaction has always used: the list is a picker, not a report. */
const SCOPE_PANEL_CAP = 25;

/**
 * THE searchable employee list — search by employee ID or name over Company / Business Unit / Department /
 * Employee Status filters (6a1f2bd6, 6d72816e, da4af51f, all asking for it in the same words).
 *
 * WHY IT LIVES IN THIS FILE. Four screens now want the same control and there were already TWO
 * implementations of it — the inline list inside individual/txn-workspace.tsx and the 192-line
 * fixed/employee-picker.tsx. Copying either for the other three would have produced a fifth. It sits beside
 * `CollapsibleEmployeePanel` because it is the thing that panel is always collapsing; splitting them across
 * two files would let the pair drift the way the two originals already had.
 *
 * SELECTION LIVES IN THE URL, NOT IN THIS COMPONENT. Every consumer is a SERVER component whose
 * `?employmentId=` is scope-guarded server-side (`employees.some(...)` before selecting), and that guard is
 * the only one that can be trusted — this list is a navigation convenience over an ALREADY access-fenced
 * set. Lifting selection into client state would move the fence to where a user can edit it. So choosing
 * someone is a `router.push`, and the server decides what that means.
 *
 * EVERY PROP IS PLAIN DATA. No callback, no closure, for the reason recorded on the panel above: a function
 * prop crossing from a server component to a client one returns a 500 on every request while tsc, the suite
 * and `next build` all stay green. `basePath` + `selectParam` + `preserve` is that navigation expressed as
 * data — the caller says WHERE to go rather than handing over a function that goes there.
 *
 * ONE NAMESPACE ON PURPOSE. It resolves its own labels from `employeePanel` rather than taking them
 * pre-translated: a single-namespace file is the shape the i18n coverage check (check C) actually validates
 * key-by-key, so these twenty-odd labels are now checked where before each screen's copy was not.
 */
export function EmployeeScopePanel({
  employees,
  selectedId,
  basePath,
  selectParam = 'employmentId',
  preserve,
}: {
  /** The already access-fenced employee set, mapped from the server's `listEmployees`. */
  employees: ScopeEmployee[];
  /** The server's RESOLVED selection — i.e. after its scope guard, not the raw query param. */
  selectedId: string | null;
  /** Route the selection navigates to, e.g. `/payroll/transactions/zakat`. */
  basePath: string;
  /** Query param carrying the selection. Defaults to the convention every screen already uses. */
  selectParam?: string;
  /** Other query params to carry across the switch (the screen's own filters), already scope-guarded. */
  preserve?: Record<string, string>;
}) {
  const t = useTranslations('employeePanel');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [query, setQuery] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [businessUnitId, setBusinessUnitId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [status, setStatus] = useState('');

  const companyOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of employees) seen.set(e.companyId, e.company);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [employees]);

  // BU / department options derive from the currently company-scoped set (no extra query).
  const inCompany = useMemo(
    () => (companyId ? employees.filter((e) => e.companyId === companyId) : employees),
    [employees, companyId],
  );
  const businessUnitOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of inCompany) if (e.businessUnitId && e.businessUnit) seen.set(e.businessUnitId, e.businessUnit);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [inCompany]);
  const departmentOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of inCompany) if (e.departmentId && e.department) seen.set(e.departmentId, e.department);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [inCompany]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let base = companyId ? employees.filter((e) => e.companyId === companyId) : employees;
    if (businessUnitId) base = base.filter((e) => e.businessUnitId === businessUnitId);
    if (departmentId) base = base.filter((e) => e.departmentId === departmentId);
    if (status) base = base.filter((e) => e.status === status);
    if (q) {
      base = base.filter(
        (e) => e.name.toLowerCase().includes(q) || (e.employeeCode ?? '').toLowerCase().includes(q),
      );
    }
    return base;
  }, [employees, query, companyId, businessUnitId, departmentId, status]);
  const results = useMemo(() => filtered.slice(0, SCOPE_PANEL_CAP), [filtered]);
  const capped = filtered.length > SCOPE_PANEL_CAP;

  const select = (id: string) => {
    // The screen's own filters ride along; anything it did NOT list is dropped on purpose, because a
    // param scoped to the PREVIOUS employee (a payslip id, a page number) is wrong for the next one.
    const qs = new URLSearchParams({ ...(preserve ?? {}), [selectParam]: id });
    startTransition(() => router.push(`${basePath}?${qs.toString()}`));
  };
  const resetFilters = () => {
    setQuery('');
    setCompanyId('');
    setBusinessUnitId('');
    setDepartmentId('');
    setStatus('');
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3">
        <Field label={t('filterCompany')}>
          <select
            value={companyId}
            onChange={(e) => {
              setCompanyId(e.target.value);
              setBusinessUnitId('');
              setDepartmentId('');
            }}
            className={inputCls}
          >
            <option value="">{t('allCompanies')}</option>
            {companyOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('filterBusinessUnit')}>
            <select value={businessUnitId} onChange={(e) => setBusinessUnitId(e.target.value)} className={inputCls}>
              <option value="">{t('allBusinessUnits')}</option>
              {businessUnitOptions.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('filterDepartment')}>
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={inputCls}>
              <option value="">{t('allDepartments')}</option>
              {departmentOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t('filterStatus')}>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
            <option value="">{t('allStatuses')}</option>
            <option value="active">{t('statusActive')}</option>
            <option value="ended">{t('statusEnded')}</option>
          </select>
        </Field>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('searchLabel')} className="flex-1">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className={inputCls}
          />
        </Field>
        <button
          type="button"
          onClick={resetFilters}
          className="h-9 rounded-md border border-border px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {t('reset')}
        </button>
      </div>

      <div className="max-h-[28rem] divide-y divide-border overflow-y-auto rounded-md border border-border">
        {results.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noEmployees')}</p>
        )}
        {results.map((e) => {
          const active = e.employmentId === selectedId;
          return (
            <button
              key={e.employmentId}
              type="button"
              aria-current={active ? 'true' : undefined}
              onClick={() => select(e.employmentId)}
              disabled={isPending}
              className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted disabled:opacity-60 ${
                active ? 'bg-primary/10' : ''
              }`}
            >
              <span className="min-w-0 flex-1">
                <EmployeeName
                  code={e.employeeCode}
                  name={e.name}
                  className="block truncate font-medium text-foreground"
                />
                <span className="block truncate text-xs text-muted-foreground">
                  {e.company} · {e.businessUnit ?? '—'} · {e.department ?? '—'}
                </span>
              </span>
              {active && <span className="shrink-0 text-xs font-medium text-primary">{t('selectedTag')}</span>}
            </button>
          );
        })}
      </div>
      {capped && (
        <p className="text-xs text-muted-foreground">
          {t('showingCapped', { cap: SCOPE_PANEL_CAP, total: filtered.length })}
        </p>
      )}
    </div>
  );
}
