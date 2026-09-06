import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { ALL_COMPANIES, resolveCompanyFilter } from '@/lib/company-filter';
import { listCompanies, listDepartments, listEmployees, listJobGrades } from '@/core/read';
import { listPositions } from '@/core/admin';
import { listAllProfileOptions } from '@/core/profile-options';
import { listToilPolicies } from '@/packs/leave/service';
import { REPLACEMENT_ELIGIBILITY_CRITERIA } from '@/core/replacement-eligibility';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { CompanyFilterSelect } from '@/components/company-filter-select';
import { ReplacementEligibilityPicker } from '@/components/replacement-eligibility-picker';
import { setToilPolicyAction } from '../../actions';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { LeaveConfigMap, leaveConfigScreenTitle } from '@/components/leave-config-map';

// Not exported: Next refuses unknown exports from a page module. The company picker's hrefs are built
// here on the server, so the choice rides in the address bar and the page stays a server render.
const PAGE = '/admin/leave/replacement';

/**
 * Leave Config → Replacement Leave — THE HOME OF REPLACEMENT-LEAVE CONFIGURATION (296fc027).
 *
 * WHAT THIS PAGE USED TO BE, AND WHY IT IS NOT THAT ANY MORE. 645e67c4 shipped this route as a deliberate
 * 45-line placeholder whose header said, correctly, that replacement leave already worked and that this
 * page was not its home. That was true of the tree it was written for. 296fc027 is the ticket that makes
 * it the home: the per-company policy editor and its `setToilPolicyAction` target MOVED here from
 * app/admin/toil/page.tsx, and four new settings landed with them. test/leave-replacement-placeholder.ts
 * was rewritten rather than deleted, because the placeholder's three guarantees (guarded, registered,
 * honest about what already exists) are exactly the ones that must survive the change.
 *
 * WHAT DELIBERATELY DID **NOT** MOVE, and this is the load-bearing half of the split. The running balance
 * LEDGER and the two settlement sweeps (`runToilExpiryAction` / `closeReplacementLeaveYearAction`) stay on
 * app/admin/toil/page.tsx. Those two sweeps are NOT entitlement-gated — a tenant whose `toil` module
 * lapses still owes its employees the days they already banked, and for a First-Schedule-eligible employee
 * that debt is statutory and must convert to pay rather than lapse. That wind-down argument is written out
 * in full in core/toil.ts and in the comments on that page, and moving the settlement UI here — behind a
 * CONFIGURATION tab that is read-only without the module — would have quietly re-gated it. Configuration
 * and settlement are gated differently on purpose; they therefore live on different screens, cross-linked.
 *
 * EDITABLE WITHOUT THE ADD-ON AS OF 1cf5b37c — this paragraph used to say the opposite, so read the
 * change rather than the memory. The screen previously rendered every control disabled with no Save
 * whenever the `toil` entitlement was absent, which is precisely why the reporter read it as an
 * unfinished placeholder: it looks identical to a page nobody built. It is now always editable for an
 * administrator.
 *
 * What the entitlement still governs is whether anything is BANKED. `accrueToil`,
 * `maybeAutoAccrueOnApprovalTx` and the employee request path each check it themselves, so a tenant
 * without the add-on can describe how replacement leave would work and cannot cause one accrual. The
 * banner near the top says exactly that, and it is the honest statement — the old wording claimed the
 * settings "cannot be changed", which is no longer true.
 *
 * The commercial half of the original argument does survive: every field here is FROZEN onto each
 * accrual at accrual time, so a policy configured today takes effect verbatim the day the add-on is
 * bought. That was the reason `setToilPolicy` carried an entitlement assert; see its header for why the
 * owner accepted removing it.
 *
 * ONE COMPANY AT A TIME (20e759a0) — the screen used to print EVERY in-scope company's form one under
 * the other. With the reporter's nine companies that was 180 controls and nine Save buttons on one page,
 * and reaching the last company meant scrolling past eight identical copies of the form. A `?company=`
 * parameter now picks one; `all` keeps the old stacked view for anyone who wants it.
 *
 * WHY A QUERY PARAMETER AND NOT THE `company_scope` COOKIE, which is the obvious-looking shortcut and is
 * wrong: `getScopeIds` is GLOBAL. Narrowing this page by writing that cookie would silently re-scope
 * Roster, Payroll and every other screen — the reporter asked to shorten ONE page, not to change what
 * the rest of the product shows. The cookie therefore stays the OUTER bound (`visible` is still
 * companies ∩ scopeIds) and the dropdown picks one from inside it. See lib/company-filter.ts for the
 * resolution rules, including why an unrecognised id falls back to the first visible company rather than
 * rendering an empty page.
 *
 * THE SAVE CARRIES THE SELECTION BACK. `setToilPolicyAction` appends `company=` to all three of its
 * redirect targets (saved, warning, AND the error path). Without that, every save would bounce the admin
 * onto the default company — and on the error path it would also hide the form the error is about.
 *
 * WHAT THE SELECTION DOES *NOT* NARROW: `listJobGrades` and `listAllProfileOptions` are tenant-wide
 * catalogues, not company-scoped ones. And the `companyIds` ELIGIBILITY criterion still offers the FULL
 * in-scope list — it says who may SUBMIT a replacement-leave request, which is a different question from
 * which company is being configured.
 *
 * SERVER/CLIENT BOUNDARY: `ReplacementEligibilityPicker` and `CompanyFilterSelect` are client components
 * and receive ONLY serialisable props — option arrays, pre-built hrefs and a plain `labels` object of
 * already-translated strings. No `t` and no closure crosses the boundary; see those files' headers and
 * test/server-client-boundary.test.ts. Keeping the page itself a server render is what lets the eight
 * eligibility pickers keep their server-resolved option arrays.
 */
export default async function LeaveReplacementPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; warning?: string; saved?: string; company?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const tr = await getTranslations('admin.replacementLeave');
  const { error, warning, saved, company } = await searchParams;
  // 1cf5b37c — TWO QUESTIONS, NOT ONE. They used to be the same flag, which is why this screen looked
  // like an unfinished placeholder: `toil` is not in the tenant's modules, so every control rendered
  // disabled with no Save.
  //
  //   • `accrualLive` — does replacement leave actually BANK days for this tenant? Still the `toil`
  //     entitlement, unchanged, and still enforced inside core/toil.ts on every accrual path.
  //   • configuring   — may an admin EDIT these settings? Now yes, always. Saving writes configuration
  //     and cannot cause an accrual; see setToilPolicy's header for the full argument.
  //
  // Switching `toil` on to make this screen editable would also have lit up the legacy /admin/toil page,
  // which the reporter explicitly asked us to leave alone. That is the decoupling this item is about.
  const accrualLive = isModuleEnabledOrFalse(s, 'toil');

  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id));
  const visibleIds = visible.map((c) => c.id);

  // 20e759a0 — `?company=`. `all` keeps the stacked view; a known id narrows to that one; anything else
  // (absent, junk, a bookmark held after the company was archived) falls back to the first visible
  // company. `shown` is therefore empty ONLY when `visible` is, which is exactly today's empty case —
  // the filter can never manufacture a blank page of its own.
  const selected = resolveCompanyFilter(company, visibleIds);
  const shown = selected === ALL_COMPANIES ? visible : visible.filter((c) => c.id === selected);
  const shownIds = shown.map((c) => c.id);

  const policies = await listToilPolicies(s, shownIds);
  const byCompany = new Map(policies.map((p) => [p.companyId, p]));

  // The eight pickers' option lists. Loaded ONCE for the whole page rather than per company card: the
  // catalogues are tenant-wide (grades, profile options) or already company-filtered by the scope above,
  // and a group with six companies would otherwise run the same six reads six times.
  //
  // Narrowed to `shownIds`, not `visibleIds` (20e759a0): with one company selected, serialising the other
  // eight companies' departments, positions and employees into the pickers is work nothing on screen can
  // use. Grades and profile options stay tenant-wide because they ARE tenant-wide catalogues.
  const [departments, positions, grades, employees, profileOptions] = await Promise.all([
    listDepartments(s, { companyIds: shownIds }),
    listPositions(s, { companyIds: shownIds }),
    listJobGrades(s),
    listEmployees(s, shownIds),
    listAllProfileOptions(s, { activeOnly: true }),
  ]);

  // Employment type is the one dimension with NO master table — it is a four-value enum column on the
  // effective-dated assignment row (db/schema.ts employmentTypeEnum), so its options are a literal list
  // rather than a catalogue read. Labels are keyed statically (not `tr(\`empType_${v}\`)`) so the i18n
  // coverage scan can see them.
  const employmentTypeOptions = [
    { id: 'full_time', name: tr('empTypeFullTime') },
    { id: 'part_time', name: tr('empTypePartTime') },
    { id: 'contract', name: tr('empTypeContract') },
    { id: 'intern', name: tr('empTypeIntern') },
  ];

  const eligibilityOptions: Record<string, { id: string; name: string }[]> = {
    // `visible`, NOT `shown`, and deliberately so (20e759a0). This criterion answers "who may SUBMIT a
    // replacement-leave request", which is a different question from "which company am I configuring".
    // Narrowing it with the page filter would quietly delete the ability to name another in-scope company
    // as eligible — and would silently drop that company from the criterion on the next save.
    companyIds: visible.map((c) => ({ id: c.id, name: c.name })),
    employmentTypes: employmentTypeOptions,
    departmentIds: departments.map((d) => ({ id: d.id, name: d.name })),
    divisions: (profileOptions.division ?? []).map((o) => ({ id: o.value, name: o.label })),
    positionIds: positions.map((p) => ({ id: p.id, name: p.title })),
    gradeIds: grades.map((g) => ({ id: g.id, name: g.name || g.code })),
    employmentCategories: (profileOptions.category ?? []).map((o) => ({ id: o.value, name: o.label })),
    employmentIds: employees.map((e) => ({ id: e.employmentId, name: e.name })),
  };

  // The descriptor is resolved to plain {key,label} data HERE, on the server. Two reasons, both covered
  // in the picker's header: it keeps drizzle/db-schema out of the client bundle, and it keeps
  // core/replacement-eligibility (a leave-pack boundary module) out of components/, which the ADR-0080
  // ratchet would otherwise flag as drift.
  const criteria = REPLACEMENT_ELIGIBILITY_CRITERIA.map((c) => ({ key: c.key, label: tr(c.labelKey) }));
  const pickerLabels = {
    all: tr('pickerAll'),
    search: tr('pickerSearch'),
    selectAll: tr('pickerSelectAll'),
    clearAll: tr('pickerClearAll'),
    // `.raw`, NOT `tr(...)`, and this is load-bearing. The placeholder must survive to the client, which
    // substitutes the live count as the selection changes — there is no number to resolve here. next-intl
    // REFUSES to format a message whose ICU variable was not supplied: `tr('pickerSelectedCount')` throws
    // FORMATTING_ERROR ("the intl string context variable 'count' was not provided") at render. `.raw`
    // returns the message unformatted, which is exactly what a template being handed onward needs.
    //
    // Caught by render-verify, not by tsc, the build or the suite — the page still returned 200 while the
    // label was broken, which is why this comment is here rather than a bare `.raw`.
    selectedCountTemplate: tr.raw('pickerSelectedCount') as string,
  };

  // Every href is built here, on the server, so the choice lands in the address bar and a copied link
  // opens on the same company. Switching company deliberately DROPS `saved`/`warning`/`error`: those
  // banners describe the save you just made to the company you are leaving.
  const companyHref = (v: string) => `${PAGE}?company=${encodeURIComponent(v)}`;
  const companyOptions = [
    { value: ALL_COMPANIES, label: tr('companyFilterAll'), href: companyHref(ALL_COMPANIES) },
    ...visible.map((c) => ({ value: c.id, label: c.name, href: companyHref(c.id) })),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={await leaveConfigScreenTitle('replacementLeave')}
        description={t('pageDescription')}
        actions={
          visible.length > 0 ? (
            <CompanyFilterSelect
              id="replacement-company-filter"
              label={tr('companyFilterLabel')}
              value={selected ?? ALL_COMPANIES}
              options={companyOptions}
            />
          ) : undefined
        }
      />
      {/* a6fe37fc — the area map. ADDITIVE: everything below it is unchanged. */}
      <LeaveConfigMap current="replacementLeave" />

      <ErrorBanner message={error} />
      {saved !== undefined && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {tr('savedBanner')}
        </div>
      )}
      {/* The premium-equivalent + First-Schedule banking risk. `setToilPolicy` has returned this warning
          since Phase-B #14, but the screen it used to redirect to never read the `warning` param, so it
          was silently dropped on every save. Rendering it here is not new behaviour being invented — it
          is a warning that was already being produced finally reaching the person it is about. */}
      {warning && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {warning}
        </div>
      )}

      {!accrualLive && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {tr('moduleOff')}
        </div>
      )}

      {/* 1cf5b37c — THE CROSS-LINK TO /admin/toil IS GONE, on purpose. It pointed at the legacy module
          the reporter told us to ignore, and they asked for this submenu to be self-contained. The
          ledger and the two settlement sweeps still live there and are unchanged; nothing about that
          page moved, was unlocked, or was retired by this item. */}

      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr('noCompanies')}</p>
      ) : (
        shown.map((c) => {
          const p = byCompany.get(c.id);
          if (!p) return null;
          const elig = p.requestEligibility ?? {};
          const defaultSelected: Record<string, string[]> = Object.fromEntries(
            REPLACEMENT_ELIGIBILITY_CRITERIA.map((k) => [k.key, elig[k.key] ?? []]),
          );
          return (
            <Card key={c.id}>
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-foreground">{c.name}</h2>
                <span
                  className={
                    p.enabled
                      ? 'rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                      : 'rounded bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground'
                  }
                >
                  {p.enabled ? tr('on') : tr('off')}
                </span>
              </div>
              <form action={setToilPolicyAction} className="space-y-5 p-4">
                <input type="hidden" name="companyId" value={c.id} />

                <label className="flex items-start gap-2.5">
                  <input type="checkbox" name="enabled" defaultChecked={p.enabled} className="mt-0.5 h-4 w-4 accent-primary disabled:opacity-60" />
                  <span>
                    <span className="text-sm font-medium text-foreground">{tr('enabledLabel')}</span>
                    <span className="block text-xs text-muted-foreground">{tr('enabledHint')}</span>
                  </span>
                </label>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={tr('accrualBasis')}>
                    <select name="accrualBasis" defaultValue={p.accrualBasis} className={inputCls}>
                      <option value="hours_worked">{tr('basisHoursWorked')}</option>
                      <option value="premium_equivalent">{tr('basisPremiumEquivalent')}</option>
                    </select>
                  </Field>
                  <Field label={tr('onExpiry')}>
                    <select name="onExpiry" defaultValue={p.onExpiry} className={inputCls}>
                      <option value="convert_to_pay">{tr('expiryConvertToPay')}</option>
                      <option value="lapse">{tr('expiryLapse')}</option>
                    </select>
                  </Field>
                </div>

                {/* ── The expiry period: a NUMBER plus a UNIT, replacing the days-only box ──────────────
                    Both counts are posted every time and stored in their own columns, so switching the
                    unit and switching back does not lose the other count. core/toil.ts `resolveExpiry`
                    is the only thing that reads the trio; nothing here does date arithmetic. */}
                <div>
                  <SectionHeader title={tr('expiryTitle')} />
                  <div className="grid grid-cols-1 gap-3 px-0 pt-3 sm:grid-cols-3">
                    <Field label={tr('expiryUnit')}>
                      <select name="expiryUnit" defaultValue={p.expiryUnit} className={inputCls}>
                        <option value="days">{tr('expiryUnitDays')}</option>
                        <option value="months">{tr('expiryUnitMonths')}</option>
                      </select>
                    </Field>
                    <Field label={tr('expiryDays')}>
                      <input type="number" name="expiryDays" min={1} max={730} required defaultValue={p.expiryDays} className={inputCls} />
                    </Field>
                    <Field label={tr('expiryMonths')}>
                      <input type="number" name="expiryMonths" min={1} max={24} required defaultValue={p.expiryMonths} className={inputCls} />
                    </Field>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">{tr('expiryHint')}</p>
                </div>

                {/* ── Replacement Leave From — RECORDED ONLY, AND THE PAGE SAYS SO ─────────────────────
                    The note below is not decoration. Nothing validates against this setting: no
                    attendance, timesheet or overtime figure is checked against it and it changes nothing
                    about what is banked. Saying so on screen is the difference between a recorded
                    intention and a promise the system does not keep. */}
                <div>
                  <Field label={tr('leaveFrom')}>
                    <select name="replacementLeaveFrom" defaultValue={p.replacementLeaveFrom} className={inputCls}>
                      <option value="working_hours">{tr('leaveFromWorkingHours')}</option>
                      <option value="overtime">{tr('leaveFromOvertime')}</option>
                      <option value="working_hours_and_overtime">{tr('leaveFromBoth')}</option>
                    </select>
                  </Field>
                  <p className="mt-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    {tr('leaveFromRecordedOnly')}
                  </p>
                </div>

                <label className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-500/25 dark:bg-amber-500/5">
                  <input
                    type="checkbox"
                    name="allowFirstScheduleEligible"
                    defaultChecked={p.allowFirstScheduleEligible}
                   
                    className="mt-0.5 h-4 w-4 accent-amber-600 disabled:opacity-60"
                  />
                  <span>
                    <span className="text-sm font-medium text-foreground">{tr('allowEligibleLabel')}</span>
                    <span className="block text-xs text-amber-700/90 dark:text-amber-300/80">{tr('allowEligibleHint')}</span>
                  </span>
                </label>

                <label className="flex items-start gap-2.5">
                  <input type="checkbox" name="autoAccrueOnApproval" defaultChecked={p.autoAccrueOnApproval} className="mt-0.5 h-4 w-4 accent-primary disabled:opacity-60" />
                  <span>
                    <span className="text-sm font-medium text-foreground">{tr('autoAccrueLabel')}</span>
                    <span className="block text-xs text-muted-foreground">{tr('autoAccrueHint')}</span>
                  </span>
                </label>

                <label className="flex items-start gap-2.5">
                  <input type="checkbox" name="carryForwardAtYearEnd" defaultChecked={p.carryForwardAtYearEnd} className="mt-0.5 h-4 w-4 accent-primary disabled:opacity-60" />
                  <span>
                    <span className="text-sm font-medium text-foreground">{tr('carryForwardLabel')}</span>
                    <span className="block text-xs text-muted-foreground">{tr('carryForwardHint')}</span>
                  </span>
                </label>

                {/* ── Employee-submitted requests + who may submit ─────────────────────────────────────
                    The switch is enforced in the SERVICE (assertEmployeeMaySubmit), not here. Hiding the
                    button is a courtesy; refusing the submission is the control. */}
                <div className="space-y-3 rounded-lg border border-border p-3">
                  <label className="flex items-start gap-2.5">
                    <input
                      type="checkbox"
                      name="employeeRequestEnabled"
                      defaultChecked={p.employeeRequestEnabled}
                     
                      className="mt-0.5 h-4 w-4 accent-primary disabled:opacity-60"
                    />
                    <span>
                      <span className="text-sm font-medium text-foreground">{tr('employeeRequestLabel')}</span>
                      <span className="block text-xs text-muted-foreground">{tr('employeeRequestHint')}</span>
                    </span>
                  </label>
                  <div>
                    <p className="text-sm font-medium text-foreground">{tr('eligibilityTitle')}</p>
                    <p className="mb-3 mt-0.5 text-xs text-muted-foreground">{tr('eligibilityHint')}</p>
                    <ReplacementEligibilityPicker
                      criteria={criteria}
                      options={eligibilityOptions}
                      defaultSelected={defaultSelected}
                      labels={pickerLabels}
                     
                    />
                  </div>
                </div>

                <button className={btnPrimary}>{tr('save')}</button>
              </form>
            </Card>
          );
        })
      )}

      <p className="px-1 text-xs text-muted-foreground">{tr('footnote')}</p>
    </div>
  );
}
