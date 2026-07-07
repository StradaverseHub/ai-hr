import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listLeaveTypes, listCompanies, listJobGrades } from '@/core/read';
import { listLeavePolicies } from '@/core/admin';
import type { ServiceBand } from '@/core/leave-compute';
import { entitlement } from '@/localization/my/leave';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { LeaveTabs } from '@/components/leave-tabs';
import { LeaveTypePanel, type EntitlementPolicy } from '@/components/leave-type-panel';
import { LeaveRulePreview } from '@/components/leave-rule-preview';
import {
  archiveLeaveTypeAction,
  createLeavePolicyAction,
  createLeaveTypeAction,
  deleteLeavePolicyAction,
  deleteLeaveTypeAction,
  updateLeavePolicyAction,
  updateLeaveTypeAction,
} from '../actions';

/**
 * Leave Settings — Leave Types tab (0d147b78 — Leave Settings Reorganization).
 *
 * Feature 0d147b78 re-slices the former single, top-to-bottom Leave Settings page into a tabbed IA
 * that mirrors the Payroll module (`<LeaveTabs />` + real sub-routes). This route is the FIRST tab:
 * the effective-rules overview + live preview, the leave-type list (identity, eligibility, durations,
 * supporting-document, payroll-impact, backdating, expiry AND per-type entitlement policies all live
 * inside `LeaveTypePanel`), and the add-type form. The company-level cards (leave year, accrual cycle,
 * grades, half-day deduction, encashment, import, festive grant, approval chain) moved to their own
 * tabs — see `entitlements/`, `application-rules/`, `payroll/`, `approval/`, `audit/`.
 *
 * No schema/service/action change: every `<form action={…}>` keeps pointing at its existing server
 * action (behaviour #6/#7/#8 hold by construction — this is pure IA/JSX movement).
 */
export default async function LeaveTypesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const { error } = await searchParams;
  const [types, policies, companies, grades] = await Promise.all([
    listLeaveTypes(s, { includeArchived: true }),
    listLeavePolicies(s),
    listCompanies(s),
    listJobGrades(s),
  ]);
  const gradeOptions = grades.map((g) => ({ id: g.id, name: g.name }));
  // ADR-0066: companies for the per-policy scope select. IMPORTANT: companyOptions stays the FULL
  // list — policy writes are separately RLS-gated and must not be narrowed here.
  const companyOptions = companies.map((c) => ({ id: c.id, name: c.name }));
  const activeTypeOptions = types.filter((t) => !t.archivedAt).map((t) => ({ id: t.id, name: t.name }));
  const typeNameById = new Map(types.map((t) => [t.id, t.name]));
  const typeCodeById = new Map(types.map((t) => [t.id, t.code]));

  // Statutory floor display (MY pack): sample the three service bands. 6 (not 5)
  // catches the top band on both boundary conventions (annual ≤5 vs sick <5).
  const floorBands = (code: string) => {
    const days = [...new Set([0, 2, 6].map((y) => entitlement(code, y)))];
    return days[0] === 0 ? null : days.join(' / ');
  };

  // Group each type's effective-dated policies, newest first, for inline editing.
  const polByType = new Map<string, EntitlementPolicy[]>();
  for (const p of policies) {
    const acc = p.accrual as {
      annualDays?: number;
      carryForwardMax?: number;
      method?: string;
      carryForwardExpiryMonth?: number;
      carryForwardExpiryDay?: number;
      carryForwardExpiryMode?: 'date' | 'months';
      carryForwardExpiryMonths?: number;
      carryForwardEnabled?: boolean;
      carryForwardIncludeEarned?: boolean;
      serviceBands?: ServiceBand[];
    } | null;
    const ep: EntitlementPolicy = {
      id: p.id,
      annualDays: Number(acc?.annualDays ?? 0),
      // Leave Entitlement Rules Engine: absent ⇒ null (no bands, flat annualDays only).
      serviceBands: Array.isArray(acc?.serviceBands) && acc.serviceBands.length > 0 ? acc.serviceBands : null,
      carryForwardMax: Math.max(0, Number(acc?.carryForwardMax ?? 0)),
      carryForwardExpiryMonth: acc?.carryForwardExpiryMonth ?? null,
      carryForwardExpiryDay: acc?.carryForwardExpiryDay ?? null,
      // R4 Build #1: mode absent ⇒ 'date' so existing policies hydrate as date-mode (back-compat).
      carryForwardExpiryMode: acc?.carryForwardExpiryMode === 'months' ? 'months' : 'date',
      carryForwardExpiryMonths: acc?.carryForwardExpiryMonths ?? null,
      // Carry-forward enhancement: absent ⇒ undefined so the panel's back-compat default (cap > 0) drives
      // the checkbox; an explicit boolean round-trips.
      carryForwardEnabled: typeof acc?.carryForwardEnabled === 'boolean' ? acc.carryForwardEnabled : null,
      carryForwardIncludeEarned: acc?.carryForwardIncludeEarned ?? false,
      method: acc?.method,
      gradeId: p.gradeId,
      gradeName: p.gradeName,
      // ADR-0066: the owning company (null = group default) + its name for the scope badge.
      companyId: p.companyId,
      companyName: p.companyName,
      validFrom: p.validFrom,
      validTo: p.validTo,
    };
    const arr = polByType.get(p.leaveTypeId);
    if (arr) arr.push(ep);
    else polByType.set(p.leaveTypeId, [ep]);
  }
  for (const arr of polByType.values()) arr.sort((a, b) => b.validFrom.localeCompare(a.validFrom));

  // Leave Entitlement Rules Engine — effective-rules table (all types, all scopes) + the live preview.
  // Reuses the already-loaded `policies` / `types` / `companies` / `grades` — no extra query.
  const activeRules = policies
    .filter((p) => !p.validTo)
    .map((p) => {
      const acc = p.accrual as { annualDays?: number; serviceBands?: ServiceBand[] } | null;
      const bands = Array.isArray(acc?.serviceBands) && acc.serviceBands.length > 0 ? acc.serviceBands : null;
      return {
        id: p.id,
        leaveTypeId: p.leaveTypeId,
        leaveTypeName: typeNameById.get(p.leaveTypeId) ?? p.leaveType,
        companyName: p.companyId ? (p.companyName ?? null) : null,
        gradeName: p.gradeName ?? null,
        entitlementLabel: bands
          ? bands
              .map((b) => `${b.fromYears}${b.toYears == null ? '+' : `–${b.toYears}`}y: ${b.days}d`)
              .join(', ')
          : `${Number(acc?.annualDays ?? 0)}d`,
        validFrom: p.validFrom,
        validTo: p.validTo,
      };
    })
    .sort((a, b) => a.leaveTypeName.localeCompare(b.leaveTypeName));
  const previewPolicies = policies
    .filter((p) => !p.validTo)
    .map((p) => ({ leaveTypeId: p.leaveTypeId, gradeId: p.gradeId, companyId: p.companyId, accrual: p.accrual }));
  const previewCompanies = companies.map((c) => ({ id: c.id, name: c.name, country: c.country }));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <LeaveTabs active="types" />
      <ErrorBanner message={error} />

      {/* Leave Entitlement Rules Engine — consolidated view: every effective rule, the resolution order in
          plain words, and a live preview. Anchor links (#type-<id>) jump to the per-type panel below for
          CRUD, so this table is read-only and never duplicates editing. */}
      <Card>
        <SectionHeader title={t('rulesCardTitle')} count={activeRules.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('rulesCardHelp')}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-4 py-2 font-medium">{t('rulesColLeaveType')}</th>
                <th className="px-4 py-2 font-medium">{t('rulesColCompany')}</th>
                <th className="px-4 py-2 font-medium">{t('rulesColGrade')}</th>
                <th className="px-4 py-2 font-medium">{t('rulesColEntitlement')}</th>
                <th className="px-4 py-2 font-medium">{t('rulesColValidFrom')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {activeRules.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                    {t('noLeaveTypes')}
                  </td>
                </tr>
              )}
              {activeRules.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2">
                    <a href={`#type-${r.leaveTypeId}`} className="text-foreground underline decoration-border hover:decoration-foreground">
                      {r.leaveTypeName}
                    </a>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{r.companyName ?? t('policyCompanyGroupDefault')}</td>
                  <td className="px-4 py-2 text-muted-foreground">{r.gradeName ?? t('gradeAll')}</td>
                  <td className="px-4 py-2 tabular-nums text-foreground">{r.entitlementLabel}</td>
                  <td className="px-4 py-2 text-muted-foreground">{r.validFrom}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">{t('rulesOrderTitle')}</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4">
            <li>{t('rulesOrderStep1')}</li>
            <li>{t('rulesOrderStep2')}</li>
            <li>{t('rulesOrderStep3')}</li>
            <li>{t('rulesOrderStep4')}</li>
          </ol>
          <p className="mt-1">{t('rulesOrderNoReorder')}</p>
        </div>
        {activeTypeOptions.length > 0 && companyOptions.length > 0 && (
          <div className="border-t border-border p-4">
            <p className="pb-2 text-xs font-medium text-muted-foreground">{t('previewTitle')}</p>
            <LeaveRulePreview
              leaveTypes={activeTypeOptions.map((o) => ({ id: o.id, name: o.name, code: typeCodeById.get(o.id) ?? '' }))}
              companies={previewCompanies}
              grades={gradeOptions}
              policies={previewPolicies}
            />
          </div>
        )}
      </Card>

      <Card data-tour="leave-config">
        <SectionHeader title={t('typesSectionTitle')} count={types.length} />
        <ul className="divide-y divide-border">
          {types.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noLeaveTypes')}</li>
          )}
          {types.map((t) => (
            <LeaveTypePanel
              key={t.id}
              id={t.id}
              name={t.name}
              code={t.code}
              archived={!!t.archivedAt}
              inUse={t.inUse}
              isAnnual={t.code === 'ANNUAL'}
              floorLabel={floorBands(t.code)}
              floor0={entitlement(t.code, 0)}
              eligibility={(t.eligibility as { gender?: string; maritalStatus?: string; minServiceMonths?: number } | null) ?? null}
              durations={(t.durations as string[] | null) ?? null}
              requiresDocument={t.requiresDocument}
              mandatoryAfterDays={t.mandatoryAfterDays ?? null}
              allowedMimeTypes={(t.allowedMimeTypes as string[] | null) ?? null}
              maxDocBytes={t.maxDocBytes}
              employeeRemarkRequired={t.employeeRemarkRequired}
              hrRemarkRequired={t.hrRemarkRequired}
              backdatingLimitDays={t.backdatingLimitDays ?? null}
              minAdvanceDays={t.minAdvanceDays ?? null}
              expiryValue={t.expiryValue ?? null}
              expiryUnit={t.expiryUnit ?? null}
              customMessages={(t.customMessages as Record<string, string> | null) ?? null}
              paid={t.paid}
              sendToPayroll={t.sendToPayroll}
              counting={t.counting}
              perDateApproval={t.perDateApproval}
              policies={polByType.get(t.id) ?? []}
              grades={gradeOptions}
              companies={companyOptions}
              updateTypeAction={updateLeaveTypeAction}
              archiveTypeAction={archiveLeaveTypeAction}
              deleteTypeAction={deleteLeaveTypeAction}
              createPolicyAction={createLeavePolicyAction}
              updatePolicyAction={updateLeavePolicyAction}
              deletePolicyAction={deleteLeavePolicyAction}
            />
          ))}
        </ul>
        <form
          action={createLeaveTypeAction}
          className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4"
        >
          <Field label={t('codeLabel')}>
            <input
              name="code"
              required
              placeholder={t('codePlaceholder')}
              title={t('codeHint')}
              className={`${inputCls} uppercase`}
            />
          </Field>
          <Field label={t('nameLabel')}>
            <input name="name" required placeholder={t('namePlaceholder')} className={inputCls} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="paid" defaultChecked className="size-4 rounded" />
            {t('paidLabel')}
          </label>
          <button className={btnPrimary}>{t('addType')}</button>
        </form>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          {t.rich('typesHelp', { strong: (chunks) => <span className="font-medium">{chunks}</span> })}
        </p>
      </Card>
    </div>
  );
}
