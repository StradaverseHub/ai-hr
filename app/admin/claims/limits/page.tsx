import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listClaimLimits, listClaimTypes } from '@/core/claims';
import { listJobGrades } from '@/core/read';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { ClaimsTabs } from '@/components/claims-tabs';
import { ClaimLimitEditor } from '@/components/claim-limit-editor';

import { todayInKualaLumpur } from '@/lib/hr-date';

const rm = (n: number | null): string =>
  n == null ? '—' : `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;

export default async function ClaimLimitsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.claims');
  const { error } = await searchParams;
  const [limits, types, grades] = await Promise.all([
    listClaimLimits(s),
    listClaimTypes(s),
    listJobGrades(s),
  ]);
  const activeGrades = grades.filter((g) => !g.archivedAt).map((g) => ({ id: g.id, name: g.name }));
  const typeOptions = types.map((ct) => ({ id: ct.id, code: ct.code, name: ct.name }));
  const today = todayInKualaLumpur();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('limitsTitle')} description={t('limitsSubtitle')} />
      <ClaimsTabs active="limits" />
      <ErrorBanner message={error} />

      <Card className="overflow-hidden">
        <SectionHeader title={t('limitsTitle')} count={limits.length} />
        {limits.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('noLimitRows')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('claimTypeLabel')}</th>
                  <th className="px-4 py-2 font-medium">{t('gradeLabel')}</th>
                  <th className="px-4 py-2 font-medium">{t('perClaimCapLabel')}</th>
                  <th className="px-4 py-2 font-medium">{t('monthlyLimitLabel')}</th>
                  <th className="px-4 py-2 font-medium">{t('annualBudgetLabel')}</th>
                  <th className="px-4 py-2 font-medium">{t('lifetimeLimitLabel')}</th>
                  <th className="px-4 py-2 font-medium">{t('maxClaimsPerYearLabel')}</th>
                  <th className="px-4 py-2 font-medium">{t('approvalRequiredLabel')}</th>
                  <th className="px-4 py-2 font-medium">{t('effectiveFromLabel')}</th>
                </tr>
              </thead>
              <tbody>
                {limits.map((l) => {
                  const isUnlimited =
                    l.perClaimCap == null && l.monthlyLimit == null && l.annualBudget == null &&
                    l.lifetimeLimit == null && l.maxClaimsPerYear == null;
                  return (
                    <tr key={`${l.claimTypeId}:${l.gradeId ?? ''}`} className="border-t border-border">
                      <td className="px-4 py-2.5">
                        <div className="font-medium">{l.typeName}</div>
                        <div className="font-mono text-xs text-muted-foreground">{l.typeCode}</div>
                      </td>
                      <td className="px-4 py-2.5">{l.gradeName ?? t('allGrades')}</td>
                      {isUnlimited ? (
                        <td className="px-4 py-2.5 text-muted-foreground" colSpan={5}>{t('unlimitedBadge')}</td>
                      ) : (
                        <>
                          <td className="px-4 py-2.5 tabular-nums">{rm(l.perClaimCap)}</td>
                          <td className="px-4 py-2.5 tabular-nums">{rm(l.monthlyLimit)}</td>
                          <td className="px-4 py-2.5 tabular-nums">{rm(l.annualBudget)}</td>
                          <td className="px-4 py-2.5 tabular-nums">{rm(l.lifetimeLimit)}</td>
                          <td className="px-4 py-2.5 tabular-nums">{l.maxClaimsPerYear ?? '—'}</td>
                        </>
                      )}
                      <td className="px-4 py-2.5">{t('approvalAlwaysYes')}</td>
                      <td className="px-4 py-2.5 tabular-nums">{l.validFrom}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="mb-1 text-sm font-semibold">{t('newLimitTitle')}</h2>
        <p className="mb-3 text-xs text-muted-foreground">{t('newLimitHint')}</p>
        {typeOptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ClaimLimitEditor types={typeOptions} grades={activeGrades} today={today} />
        )}
      </Card>
    </div>
  );
}
