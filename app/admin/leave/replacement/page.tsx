import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies, listDepartments, listEmployees, listJobGrades } from '@/core/read';
import { listPositions } from '@/core/admin';
import { listAllProfileOptions } from '@/core/profile-options';
import { listToilPolicies } from '@/packs/leave/service';
import { REPLACEMENT_ELIGIBILITY_CRITERIA } from '@/core/replacement-eligibility';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { ReplacementEligibilityPicker } from '@/components/replacement-eligibility-picker';
import { setToilPolicyAction } from '../../actions';
import { isModuleEnabledOrFalse } from '@/core/entitlements';

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
 * READ-ONLY WITHOUT THE MODULE, NOT HIDDEN. Replacement leave is a chargeable add-on; without it, every
 * control here is disabled and no Save button renders, but the page still shows what is configured. That
 * is existing behaviour carried over verbatim from the screen this form came from, and the reasoning is
 * carried over with it: every field on this form is FROZEN onto each accrual at accrual time, so an admin
 * asked to settle an outstanding liability must be able to SEE the settings that decide how it settles.
 * Reviewing is not configuring; only the second is what the entitlement withholds. `setToilPolicy`
 * asserts the same thing server-side — disabling the controls only stops the UI offering a refused save.
 *
 * SERVER/CLIENT BOUNDARY: `ReplacementEligibilityPicker` is a client component and receives ONLY
 * serialisable props — option arrays and a plain `labels` object of already-translated strings. No `t`
 * and no closure crosses the boundary; see that file's header and test/server-client-boundary.test.ts.
 */
export default async function LeaveReplacementPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; warning?: string; saved?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const tr = await getTranslations('admin.replacementLeave');
  const { error, warning, saved } = await searchParams;
  const moduleOn = isModuleEnabledOrFalse(s, 'toil');

  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id));
  const visibleIds = visible.map((c) => c.id);
  const policies = await listToilPolicies(s, visibleIds);
  const byCompany = new Map(policies.map((p) => [p.companyId, p]));

  // The eight pickers' option lists. Loaded ONCE for the whole page rather than per company card: the
  // catalogues are tenant-wide (grades, profile options) or already company-filtered by the scope above,
  // and a group with six companies would otherwise run the same six reads six times.
  const [departments, positions, grades, employees, profileOptions] = await Promise.all([
    listDepartments(s, { companyIds: visibleIds }),
    listPositions(s, { companyIds: visibleIds }),
    listJobGrades(s),
    listEmployees(s, visibleIds),
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

  return (
    <div className="space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />

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

      {!moduleOn && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {tr('moduleOff')}
        </div>
      )}

      {/* Cross-link BOTH WAYS (the other half is on app/admin/toil/page.tsx). An admin who lands here
          looking for the balance ledger or the settle/expire buttons must be told where they went, or the
          split reads as a feature having been deleted. */}
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">
          {tr('ledgerMovedNote')}{' '}
          <Link href="/admin/toil" className="font-medium text-primary hover:underline">
            {tr('ledgerMovedLink')}
          </Link>
        </p>
      </Card>

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr('noCompanies')}</p>
      ) : (
        visible.map((c) => {
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
                  <input type="checkbox" name="enabled" defaultChecked={p.enabled} disabled={!moduleOn} className="mt-0.5 h-4 w-4 accent-primary disabled:opacity-60" />
                  <span>
                    <span className="text-sm font-medium text-foreground">{tr('enabledLabel')}</span>
                    <span className="block text-xs text-muted-foreground">{tr('enabledHint')}</span>
                  </span>
                </label>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={tr('accrualBasis')}>
                    <select name="accrualBasis" defaultValue={p.accrualBasis} disabled={!moduleOn} className={inputCls}>
                      <option value="hours_worked">{tr('basisHoursWorked')}</option>
                      <option value="premium_equivalent">{tr('basisPremiumEquivalent')}</option>
                    </select>
                  </Field>
                  <Field label={tr('onExpiry')}>
                    <select name="onExpiry" defaultValue={p.onExpiry} disabled={!moduleOn} className={inputCls}>
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
                      <select name="expiryUnit" defaultValue={p.expiryUnit} disabled={!moduleOn} className={inputCls}>
                        <option value="days">{tr('expiryUnitDays')}</option>
                        <option value="months">{tr('expiryUnitMonths')}</option>
                      </select>
                    </Field>
                    <Field label={tr('expiryDays')}>
                      <input type="number" name="expiryDays" min={1} max={730} required defaultValue={p.expiryDays} disabled={!moduleOn} className={inputCls} />
                    </Field>
                    <Field label={tr('expiryMonths')}>
                      <input type="number" name="expiryMonths" min={1} max={24} required defaultValue={p.expiryMonths} disabled={!moduleOn} className={inputCls} />
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
                    <select name="replacementLeaveFrom" defaultValue={p.replacementLeaveFrom} disabled={!moduleOn} className={inputCls}>
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
                    disabled={!moduleOn}
                    className="mt-0.5 h-4 w-4 accent-amber-600 disabled:opacity-60"
                  />
                  <span>
                    <span className="text-sm font-medium text-foreground">{tr('allowEligibleLabel')}</span>
                    <span className="block text-xs text-amber-700/90 dark:text-amber-300/80">{tr('allowEligibleHint')}</span>
                  </span>
                </label>

                <label className="flex items-start gap-2.5">
                  <input type="checkbox" name="autoAccrueOnApproval" defaultChecked={p.autoAccrueOnApproval} disabled={!moduleOn} className="mt-0.5 h-4 w-4 accent-primary disabled:opacity-60" />
                  <span>
                    <span className="text-sm font-medium text-foreground">{tr('autoAccrueLabel')}</span>
                    <span className="block text-xs text-muted-foreground">{tr('autoAccrueHint')}</span>
                  </span>
                </label>

                <label className="flex items-start gap-2.5">
                  <input type="checkbox" name="carryForwardAtYearEnd" defaultChecked={p.carryForwardAtYearEnd} disabled={!moduleOn} className="mt-0.5 h-4 w-4 accent-primary disabled:opacity-60" />
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
                      disabled={!moduleOn}
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
                      disabled={!moduleOn}
                    />
                  </div>
                </div>

                {moduleOn && <button className={btnPrimary}>{tr('save')}</button>}
              </form>
            </Card>
          );
        })
      )}

      <p className="px-1 text-xs text-muted-foreground">{tr('footnote')}</p>
    </div>
  );
}
