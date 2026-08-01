import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { requireModule } from '@/lib/authz';
import { myEmployment } from '@/core/read';
import { getEmployeeClaimTypes, listClaimsForEmployment } from '@/core/claims';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { ClaimForm, type ClaimFormType } from '@/components/claim-form';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { cancelClaimAction, submitClaimAction } from './actions';

import { todayInKualaLumpur } from '@/lib/hr-date';

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  paid: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
};
const rm = (n: number) => `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;

export default async function ClaimsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    page?: string;
    size?: string;
  }>;
}) {
  // ADR-0077 slice 4 — a courtesy redirect when the tenant has not bought this module, so they get
  // an explanation instead of the service error. NOT the control: the reads below refuse on their
  // own (D3), and this guard fails open on an unresolved snapshot. Applied at the module ENTRY
  // point; a deep link skips it and meets the service refusal, which is the correct outcome.
  await requireModule('claims');
  const s = await getSession();
  const t = await getTranslations('claims');
  const sp = await searchParams;
  const { error } = sp;
  const me = await myEmployment(s);

  if (!me) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader title={t('title')} />
        <Card className="p-6 text-sm text-muted-foreground">{t('noEmployment')}</Card>
      </div>
    );
  }

  const [types, claims] = await Promise.all([
    getEmployeeClaimTypes(s, me.employmentId),
    listClaimsForEmployment(s, me.employmentId),
  ]);
  // fc776376 — the claim history is a genuine list that grows with time, so it pages like every other.
  const { rows: claimPage, state: pgState } = paginateRows(claims, parsePageQuery(sp));
  const today = todayInKualaLumpur();
  const dayMs = 86400000;
  const formTypes: ClaimFormType[] = types.map((ct) => ({
    id: ct.id,
    code: ct.code,
    name: ct.name,
    requiresReceipt: ct.requiresReceipt,
    rateConfig: ct.rateConfig,
    items: ct.items,
    // Per-type receipt window ⇒ the earliest date the picker allows for THIS type.
    minDate: new Date(new Date(`${today}T00:00:00Z`).getTime() - ct.maxReceiptAgeDays * dayMs).toISOString().slice(0, 10),
    balance: {
      annualLimit: ct.balance.annualLimit,
      usedThisYear: ct.balance.usedThisYear,
      remainingThisYear: ct.balance.remainingThisYear,
      monthlyLimit: ct.balance.monthlyLimit,
      remainingThisMonth: ct.balance.remainingThisMonth,
      perClaimCap: ct.balance.perClaimCap,
      claimsUsedThisYear: ct.balance.claimsUsedThisYear,
      maxClaimsPerYear: ct.balance.maxClaimsPerYear,
    },
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <ErrorBanner message={error} />

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">{t('newClaim')}</h2>
        {types.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noTypes')}</p>
        ) : (
          <ClaimForm types={formTypes} submitAction={submitClaimAction} todayUtc={today} />
        )}
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={t('myClaims')} count={claims.length} />
        {claims.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colType')}</th>
                <th className="px-4 py-2 font-medium">{t('colAmount')}</th>
                <th className="px-4 py-2 font-medium">{t('colDate')}</th>
                <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {claimPage.map((c) => (
                <tr key={c.id} className="border-t border-border align-top">
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{c.typeName}</div>
                    {c.itemName && <div className="text-xs text-muted-foreground">{c.itemName}</div>}
                    {c.quantityKm != null && (
                      <div className="text-xs text-muted-foreground">{t('distanceLabel')}: {c.quantityKm} km</div>
                    )}
                    {c.description && <div className="text-xs text-muted-foreground">{c.description}</div>}
                    {c.attachments.map((a) => (
                      <a key={a.id} href={`/claims/attachment/${a.id}?inline=1`} target="_blank" rel="noopener noreferrer" className="mt-0.5 block text-xs text-primary underline-offset-2 hover:underline">
                        ↗ {a.fileName}
                      </a>
                    ))}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {rm(c.amount)}
                    {c.status === 'approved' && (
                      <span className="ml-1 text-[10px] text-muted-foreground">{c.taxable ? t('taxableBadge') : t('nonTaxableBadge')}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{c.incurredOn}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[c.status] ?? 'bg-muted text-muted-foreground'}`}>
                      {t(`status_${c.status}` as 'status_pending')}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {c.status === 'pending' && (
                      <form action={cancelClaimAction}>
                        <input type="hidden" name="id" value={c.id} />
                        <ConfirmSubmit size="sm" variant="ghost" className="text-destructive hover:text-destructive" title={t('cancelConfirmTitle')} description={t('cancelConfirmDescription')} confirmLabel={t('cancelConfirmLabel')}>
                          {t('cancel')}
                        </ConfirmSubmit>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pager basePath="/claims" state={pgState} />
      </Card>
    </div>
  );
}
