import { getTranslations } from 'next-intl/server';

import type { SessionContext } from '@/db/client';
import { ALL_COMPANIES, resolveCompanyFilter } from '@/lib/company-filter';
import { listDepartments, listEmployees, listJobGrades } from '@/core/read';
import { listPositions } from '@/core/admin';
import { listAllProfileOptions } from '@/core/profile-options';
import { listToilPolicies } from '@/packs/leave/service';
import { REPLACEMENT_ELIGIBILITY_CRITERIA } from '@/core/replacement-eligibility';
import { Card, Field, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { CompanyFilterSelect } from '@/components/company-filter-select';
import { ReplacementEligibilityPicker } from '@/components/replacement-eligibility-picker';
import { setToilPolicyAction } from '../../actions';

/**
 * 3fb1a611 (r299) · THE RULES TAB of Leave Config › Leave Credit — who can earn a credit, how it is earned
 * and how long it lasts, per company.
 *
 * MOVED, NOT COPIED, from Company rules (F38 there), which no longer draws it at all. The form is the same
 * absolute-set form posting the same `setToilPolicyAction` with the same field names and the same `?company=`
 * narrowing (20e759a0: with nine companies the section is 180 controls). The eligibility the customer entered
 * in August is still stored and is what this tab shows.
 *
 * ONE CONTROL LEFT BEHIND, deliberately: "Replacement leave from". Nothing reads it (core/toil.ts wrote it,
 * nothing validated against it, and the old screen said so on its face). The form no longer posts it, and
 * setToilPolicy now PRESERVES the stored value when it is omitted rather than resetting it on every save.
 *
 * ⚠️ EVERY FIELD BELOW IS POSTED ON EVERY SAVE — the contract of an absolute-set form: `setToilPolicyAction`
 * reads each key with a default, so a field dropped from here would silently write its default over the
 * company's value. `replacementLeaveFrom` is the one exception, and only because the action now passes it
 * as undefined when absent.
 *
 * Rendered only when the `toil` module is on (the page decides); `setToilPolicy` refuses without it too.
 * SERVER COMPONENT: the pickers are client islands fed plain data and pre-translated strings only.
 */
export async function LeaveCreditRulesTab({
  s,
  visible,
  company,
  pageHref,
}: {
  s: SessionContext;
  visible: { id: string; name: string }[];
  company: string | undefined;
  pageHref: string;
}) {
  const tr = await getTranslations('admin.replacementLeave');
  const t = await getTranslations('admin.leaveCredit');
  const visibleIds = visible.map((c) => c.id);
  const selected = resolveCompanyFilter(company, visibleIds);
  const shown = selected === ALL_COMPANIES ? visible : visible.filter((c) => c.id === selected);
  const shownIds = shown.map((c) => c.id);

  const [policies, departments, positions, grades, employees, profileOptions] = await Promise.all([
    listToilPolicies(s, shownIds),
    listDepartments(s, { companyIds: shownIds }),
    listPositions(s, { companyIds: shownIds }),
    listJobGrades(s),
    listEmployees(s, shownIds),
    listAllProfileOptions(s, { activeOnly: true }),
  ]);
  const byCompany = new Map(policies.map((p) => [p.companyId, p]));

  // Employment type has no master table (a four-value enum on the assignment), so its options are literal.
  // Keyed statically so the i18n coverage scan can see every label.
  const employmentTypeOptions = [
    { id: 'full_time', name: tr('empTypeFullTime') },
    { id: 'part_time', name: tr('empTypePartTime') },
    { id: 'contract', name: tr('empTypeContract') },
    { id: 'intern', name: tr('empTypeIntern') },
  ];
  const eligibilityOptions: Record<string, { id: string; name: string }[]> = {
    // `visible`, NOT `shown` (20e759a0): "who may submit" can name any in-scope company, whichever company is
    // being configured — narrowing it would silently drop another company from the criterion on the next save.
    companyIds: visible.map((c) => ({ id: c.id, name: c.name })),
    employmentTypes: employmentTypeOptions,
    departmentIds: departments.map((d) => ({ id: d.id, name: d.name })),
    divisions: (profileOptions.division ?? []).map((o) => ({ id: o.value, name: o.label })),
    positionIds: positions.map((p) => ({ id: p.id, name: p.title })),
    gradeIds: grades.map((g) => ({ id: g.id, name: g.name || g.code })),
    employmentCategories: (profileOptions.category ?? []).map((o) => ({ id: o.value, name: o.label })),
    employmentIds: employees.map((e) => ({ id: e.employmentId, name: e.name })),
  };
  const criteria = REPLACEMENT_ELIGIBILITY_CRITERIA.map((c) => ({ key: c.key, label: tr(c.labelKey) }));
  const pickerLabels = {
    all: tr('pickerAll'),
    search: tr('pickerSearch'),
    selectAll: tr('pickerSelectAll'),
    clearAll: tr('pickerClearAll'),
    // `.raw`, NOT `tr(...)`: the client substitutes the live count, and next-intl refuses to format a message
    // whose ICU variable was not supplied (FORMATTING_ERROR at render — caught only by render-verify).
    selectedCountTemplate: tr.raw('pickerSelectedCount') as string,
  };
  const companyHref = (v: string) => `${pageHref}?tab=rules&company=${encodeURIComponent(v)}`;
  const companyOptions = [
    { value: ALL_COMPANIES, label: tr('companyFilterAll'), href: companyHref(ALL_COMPANIES) },
    ...visible.map((c) => ({ value: c.id, label: c.name, href: companyHref(c.id) })),
  ];

  return (
    <div className="space-y-6" data-testid="leave-credit-rules">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">{t('rulesIntro')}</p>
        {visible.length > 0 && (
          <CompanyFilterSelect
            id="leave-credit-rules-company-filter"
            label={tr('companyFilterLabel')}
            value={selected ?? ALL_COMPANIES}
            options={companyOptions}
          />
        )}
      </div>

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
                  <input type="checkbox" name="enabled" defaultChecked={p.enabled} className="mt-0.5 h-4 w-4 accent-primary" />
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

                {/* The expiry period: a NUMBER plus a UNIT. BOTH counts are posted every time and stored in their
                    own columns, so switching the unit and back loses nothing. core/toil.ts `resolveExpiry` is
                    the only reader of the trio. */}
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

                <label className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-500/25 dark:bg-amber-500/5">
                  <input
                    type="checkbox"
                    name="allowFirstScheduleEligible"
                    defaultChecked={p.allowFirstScheduleEligible}
                    className="mt-0.5 h-4 w-4 accent-amber-600"
                  />
                  <span>
                    <span className="text-sm font-medium text-foreground">{tr('allowEligibleLabel')}</span>
                    <span className="block text-xs text-amber-700/90 dark:text-amber-300/80">{tr('allowEligibleHint')}</span>
                  </span>
                </label>

                <label className="flex items-start gap-2.5">
                  <input type="checkbox" name="autoAccrueOnApproval" defaultChecked={p.autoAccrueOnApproval} className="mt-0.5 h-4 w-4 accent-primary" />
                  <span>
                    <span className="text-sm font-medium text-foreground">{tr('autoAccrueLabel')}</span>
                    <span className="block text-xs text-muted-foreground">{tr('autoAccrueHint')}</span>
                  </span>
                </label>

                <label className="flex items-start gap-2.5">
                  <input type="checkbox" name="carryForwardAtYearEnd" defaultChecked={p.carryForwardAtYearEnd} className="mt-0.5 h-4 w-4 accent-primary" />
                  <span>
                    <span className="text-sm font-medium text-foreground">{tr('carryForwardLabel')}</span>
                    <span className="block text-xs text-muted-foreground">{tr('carryForwardHint')}</span>
                  </span>
                </label>

                {/* Employee-submitted requests + who may submit. Enforced in the SERVICE, not here. */}
                <div className="space-y-3 rounded-lg border border-border p-3">
                  <label className="flex items-start gap-2.5">
                    <input
                      type="checkbox"
                      name="employeeRequestEnabled"
                      defaultChecked={p.employeeRequestEnabled}
                      className="mt-0.5 h-4 w-4 accent-primary"
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
