import { Fragment } from 'react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import { listClaimLimitsForGrade, listClaimTypes } from '@/core/claims';
import { listJobGrades } from '@/core/read';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { ClaimsTabs } from '@/components/claims-tabs';
import { ClaimLimitEditor } from '@/components/claim-limit-editor';

import { todayInKualaLumpur } from '@/lib/hr-date';

const rm = (n: number | null): string =>
  n == null ? '—' : `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;

/**
 * Claim Limits — GRADE-FIRST (e7eb5d83).
 *
 * The previous version of this page rendered ONE flat table, claim type first and grade second, nine columns
 * wide. With production's 55 job grades × 4 claim types that is 220 possible rows in a single scroll, and the
 * measured consequence was that not one per-grade limit had ever been set (claim_policy rows with a non-null
 * grade_id: zero). The data model already supported everything the reporter asked for; the screen did not.
 *
 * So: pick a grade on the left, see that grade's claim types on the right. Nothing about claim_policy,
 * its columns or its resolution order changed — this is presentation only, which is why it ships without a
 * migration.
 *
 * SELECTION LIVES IN THE URL (?gradeId=), not in client state. Two reasons, both load-bearing:
 *   • This is a server component. Holding the selection in a client island would mean passing the grade list
 *     and a setter across the RSC boundary — the r123 500 — or duplicating the data fetch.
 *   • An unknown, archived or other-tenant gradeId must be COERCED TO "no selection" (the company-wide view)
 *     rather than queried. listJobGrades is already tenant-scoped by RLS, so validating the parameter against
 *     that list is the scope guard: a forged id can never select a grade the admin cannot see, and it cannot
 *     500 either. test/claims-limits-grade-screen.test.ts asserts that REFUSAL, not just the happy path.
 */
export default async function ClaimLimitsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; gradeId?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.claims');
  const { error, gradeId: rawGradeId } = await searchParams;
  const [types, grades] = await Promise.all([listClaimTypes(s), listJobGrades(s)]);
  const activeGrades = grades.filter((g) => !g.archivedAt).map((g) => ({ id: g.id, name: g.name }));

  // THE SCOPE GUARD. Anything that is not one of THIS tenant's live grades resolves to null = company-wide.
  const selectedGradeId = activeGrades.some((g) => g.id === rawGradeId) ? (rawGradeId as string) : null;
  const selectedGrade = activeGrades.find((g) => g.id === selectedGradeId) ?? null;

  const rows = await listClaimLimitsForGrade(s, { gradeId: selectedGradeId });
  const typeOptions = types.map((ct) => ({ id: ct.id, code: ct.code, name: ct.name }));
  const today = todayInKualaLumpur();

  const tabCls = (on: boolean) =>
    `block truncate rounded px-3 py-1.5 text-left text-sm transition-colors ${
      on ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
    }`;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('limitsTitle')} description={t('limitsSubtitle')} />
      <ClaimsTabs active="limits" />
      <ErrorBanner message={error} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,15rem)_1fr]">
        <Card className="overflow-hidden">
          <SectionHeader title={t('gradesTitle')} count={activeGrades.length} />
          <nav className="max-h-[28rem] space-y-0.5 overflow-y-auto p-2">
            <Link href="/admin/claims/limits" className={tabCls(selectedGradeId == null)}>
              {t('companyWide')}
            </Link>
            {activeGrades.map((g) => (
              <Link
                key={g.id}
                href={`/admin/claims/limits?gradeId=${encodeURIComponent(g.id)}`}
                className={tabCls(selectedGradeId === g.id)}
              >
                {g.name}
              </Link>
            ))}
          </nav>
        </Card>

        <Card className="overflow-hidden">
          <SectionHeader title={selectedGrade ? selectedGrade.name : t('companyWide')} count={rows.length} />
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('claimTypeLabel')}</th>
                    <th className="px-4 py-2 font-medium">{t('perClaimCapLabel')}</th>
                    <th className="px-4 py-2 font-medium">{t('monthlyLimitLabel')}</th>
                    <th className="px-4 py-2 font-medium">{t('annualBudgetLabel')}</th>
                    {/* e7eb5d83 rev 4 — Per block takes the column Lifetime limit used to hold. */}
                    <th className="px-4 py-2 font-medium">{t('blockLimitLabel')}</th>
                    <th className="px-4 py-2 font-medium">{t('maxClaimsPerYearLabel')}</th>
                    <th className="px-4 py-2 font-medium">{t('effectiveFromLabel')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const e = r.effective;
                    return (
                      <Fragment key={r.claimTypeId}>
                        <tr className="border-t border-border align-top">
                          <td className="px-4 py-2.5">
                            <div className="font-medium">{r.typeName}</div>
                            <div className="font-mono text-xs text-muted-foreground">{r.typeCode}</div>
                            {/* A grade with no row of its own INHERITS — saying so is the whole point of the
                                screen. A blank cell here is what makes an admin set the same limit twice. */}
                            {r.source === 'company' && selectedGradeId != null ? (
                              <div className="mt-1 text-xs text-amber-600 dark:text-amber-500">{t('fallbackBadge')}</div>
                            ) : null}
                            {r.source === 'none' ? (
                              <div className="mt-1 text-xs text-muted-foreground">{t('unlimitedBadge')}</div>
                            ) : null}
                          </td>
                          {e == null ? (
                            <td className="px-4 py-2.5 text-muted-foreground" colSpan={6}>
                              {t('unlimitedBadge')}
                            </td>
                          ) : (
                            <>
                              <td className="px-4 py-2.5 tabular-nums">{rm(e.perClaimCap)}</td>
                              <td className="px-4 py-2.5 tabular-nums">{rm(e.monthlyLimit)}</td>
                              <td className="px-4 py-2.5 tabular-nums">{rm(e.annualBudget)}</td>
                              <td className="px-4 py-2.5 tabular-nums">
                                {e.block == null ? (
                                  '—'
                                ) : (
                                  <>
                                    <div>{rm(e.block.limit)}</div>
                                    <div className="text-xs text-muted-foreground">
                                      {e.block.unit === 'year'
                                        ? t('blockEveryYears', { n: e.block.length })
                                        : t('blockEveryMonths', { n: e.block.length })}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      {t('blockFrom', { date: e.block.startOn })}
                                    </div>
                                  </>
                                )}
                              </td>
                              <td className="px-4 py-2.5 tabular-nums">{e.maxClaimsPerYear ?? '—'}</td>
                              <td className="px-4 py-2.5 tabular-nums">{e.validFrom}</td>
                            </>
                          )}
                        </tr>
                        {/* Sub-types are claim_item rows. They have no limit columns of their own — the limit
                            is enforced per claim TYPE — so they are listed under their parent with that said
                            plainly, rather than shown as rows whose empty cells imply a separate budget. */}
                        {r.items.length > 0 ? (
                          <tr className="border-t border-border/50">
                            <td className="px-4 pb-2.5 pl-8" colSpan={7}>
                              <ul className="space-y-0.5 text-xs text-muted-foreground">
                                {r.items.map((it) => (
                                  <li key={it.id}>
                                    ↳ {it.name} <span className="font-mono">({it.code})</span>
                                  </li>
                                ))}
                              </ul>
                              <p className="mt-1 text-xs text-muted-foreground">{t('subTypesInheritHint')}</p>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card className="p-4">
        <h2 className="mb-1 text-sm font-semibold">{t('newLimitTitle')}</h2>
        <p className="mb-3 text-xs text-muted-foreground">{t('newLimitHint')}</p>
        {typeOptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ClaimLimitEditor
            types={typeOptions}
            grades={activeGrades}
            today={today}
            defaultGradeId={selectedGradeId}
          />
        )}
      </Card>
    </div>
  );
}
