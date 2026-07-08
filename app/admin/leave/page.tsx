import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listLeaveTypes, listCompanies, listJobGrades } from '@/core/read';
import { listLeavePolicies } from '@/core/admin';
import type { ServiceBand } from '@/core/leave-compute';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { LeaveTabs } from '@/components/leave-tabs';
import { LeaveRulePreview } from '@/components/leave-rule-preview';
import { deleteLeaveTypeAction } from '../actions';

/**
 * Leave Settings — Leave Types tab.
 *
 * Feedback 9d8cf621 (Entitlements Setting reorganization) moved the per-type CONFIGURATION panel — leave-type
 * identity, eligibility, durations, supporting-document, backdating, advance-notice, expiry, apply-time
 * message AND the per-type entitlement policies — off this tab and onto the Entitlements tab (`entitlements/`),
 * where HR expects "one leave type, one full set of settings". This tab keeps the read-only master listing
 * (identity / status), the effective-rules overview + resolution order, and the live preview; every Edit link
 * jumps to the config panel on the Entitlements tab (`/admin/leave/entitlements#type-<id>`). No schema/service
 * change — the master-table delete keeps its existing server action.
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
  const companyOptions = companies.map((c) => ({ id: c.id, name: c.name }));
  const activeTypeOptions = types.filter((t) => !t.archivedAt).map((t) => ({ id: t.id, name: t.name }));
  const typeNameById = new Map(types.map((t) => [t.id, t.name]));
  const typeCodeById = new Map(types.map((t) => [t.id, t.code]));

  // Leave Entitlement Rules Engine — effective-rules table (all types, all scopes) + the live preview.
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

      {/* Leave Type master page (feedback 097de541) — read-only master listing. Edit jumps to the per-type
          config panel on the Entitlements tab (feedback 9d8cf621). */}
      <Card>
        <SectionHeader title={t('typeMasterTitle')} count={types.length} />
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-4 py-2 font-medium">{t('colName')}</th>
                <th className="px-4 py-2 font-medium">{t('colCode')}</th>
                <th className="px-4 py-2 font-medium">{t('colPaid')}</th>
                <th className="px-4 py-2 font-medium">{t('colDescription')}</th>
                <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {types.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                    {t('noLeaveTypes')}
                  </td>
                </tr>
              )}
              {types.map((lt) => {
                const isActive = !lt.archivedAt;
                return (
                  <tr key={lt.id} className={isActive ? '' : 'opacity-60'}>
                    <td className="px-4 py-2 font-medium text-foreground">{lt.name}</td>
                    <td className="px-4 py-2 text-muted-foreground">{lt.code}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {lt.paid ? t('paidValue') : t('unpaidValue')}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{lt.description || '—'}</td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-1.5" title={isActive ? t('statusActive') : t('statusInactive')}>
                        <span
                          aria-hidden
                          className={`inline-block size-2 shrink-0 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-red-500'}`}
                        />
                        <span className="sr-only">{isActive ? t('statusActive') : t('statusInactive')}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <a
                          href={`/admin/leave/entitlements#type-${lt.id}`}
                          className="rounded-md px-2 py-1 text-foreground underline decoration-border hover:decoration-foreground"
                        >
                          {t('edit')}
                        </a>
                        {lt.inUse ? (
                          <button
                            type="button"
                            disabled
                            title={t('deleteInUseTooltip')}
                            className="cursor-not-allowed rounded-md px-2 py-1 text-muted-foreground/60"
                          >
                            {t('delete')}
                          </button>
                        ) : (
                          <form action={deleteLeaveTypeAction}>
                            <input type="hidden" name="id" value={lt.id} />
                            <ConfirmSubmit
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              title={t('deleteTypeConfirmTitle')}
                              description={t('deleteTypeConfirmDescription')}
                              confirmLabel={t('deleteConfirmLabel')}
                            >
                              {t('delete')}
                            </ConfirmSubmit>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          {t('typeMasterConfigHint')}
        </p>
      </Card>

      {/* Leave Entitlement Rules Engine — consolidated view: every effective rule, the resolution order in
          plain words, and a live preview. Anchor links (#type-<id>) jump to the per-type panel on the
          Entitlements tab for CRUD, so this table is read-only and never duplicates editing. */}
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
                    <a href={`/admin/leave/entitlements#type-${r.leaveTypeId}`} className="text-foreground underline decoration-border hover:decoration-foreground">
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
    </div>
  );
}
