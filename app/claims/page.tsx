import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import {notFound} from 'next/navigation';
import { getSession } from '@/lib/session';
import { requireModule } from '@/lib/authz';
import {ownClaimSubject} from './subject';
import { claimRecordFacts, getEmployeeClaimTypes, listClaimDraftsForEmployment, listClaimHistoryPage } from '@/packs/claims/service';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { ClaimForm, type ClaimDraftPrefill, type ClaimFormType } from '@/components/claim-form';
import { Button } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { Pager } from '@/components/pager';
import { cancelClaimAction, deleteDraftAction, submitClaimAction, submitDraftsAction } from './actions';

import { todayInKualaLumpur } from '@/lib/hr-date';

// One entry per claim_status label. test/claims-draft-reservation.test.ts fails if a value in the enum has
// no style here — a claim rendered with no badge is a claim nobody notices.
const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300',
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
    /** id of a draft being edited — the form opens prefilled with it instead of empty. */
    draft?: string;
    employmentId?:string|string[];
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
  const me = await ownClaimSubject(s,sp.employmentId);
  if(sp.employmentId!==undefined&&!me)notFound();
  const selectedQuery:Record<string,string>=typeof sp.employmentId==='string'?{employmentId:sp.employmentId}:{};
  const subjectField=selectedQuery.employmentId?<input type="hidden" name="employmentId" value={selectedQuery.employmentId}/>:null;

  if (!me) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader title={t('title')} />
        <Card className="p-6 text-sm text-muted-foreground">{t('noEmployment')}</Card>
      </div>
    );
  }

  const [types, drafts, {rows: claimPage, state: pgState}] = await Promise.all([
    getEmployeeClaimTypes(s, me.employmentId),
    listClaimDraftsForEmployment(s, me.employmentId),
    listClaimHistoryPage(s, me.employmentId, sp),
  ]);
  // Only displayed rejections need detail facts; older history stays in the database.
  const rejectReasons = await claimRecordFacts(s, claimPage.filter(c => c.status === 'rejected').map(c => c.id));
  const editing = sp.draft ? drafts.find((d) => d.id === sp.draft) : undefined;
  if(selectedQuery.employmentId&&sp.draft!==undefined&&!editing)notFound();
  const draftPrefill: ClaimDraftPrefill | undefined = editing
    ? {
        id: editing.id,
        claimTypeId: editing.claimTypeId,
        claimItemId: editing.claimItemId,
        amount: editing.amount,
        quantityKm: editing.quantityKm,
        incurredOn: editing.incurredOn,
        description: editing.description,
      }
    : undefined;
  const today = todayInKualaLumpur();
  const dayMs = 86400000;
  const formTypes: ClaimFormType[] = types.map((ct) => ({
    id: ct.id,
    code: ct.code,
    name: ct.name,
    requiresReceipt: ct.requiresReceipt,
    rateConfig: ct.rateConfig,
    isMileage: ct.isMileage,
    items: ct.items,
    // Per-type receipt window ⇒ the earliest date the picker allows for THIS type.
    minDate: new Date(new Date(`${today}T00:00:00Z`).getTime() - ct.maxReceiptAgeDays * dayMs).toISOString().slice(0, 10),
    balance: {
      // e7eb5d83 rev 5 — each sub-claim's own pot, passed straight through so the form can show the
      // selected sub-claim's remaining beside the claim type's. Data only: this is a server component
      // handing a client island plain values, never a closure.
      items: ct.balance.items,
      annualLimit: ct.balance.annualLimit,
      usedThisYear: ct.balance.usedThisYear,
      reservedThisYear: ct.balance.reservedThisYear,
      remainingThisYear: ct.balance.remainingThisYear,
      monthlyLimit: ct.balance.monthlyLimit,
      remainingThisMonth: ct.balance.remainingThisMonth,
      perClaimCap: ct.balance.perClaimCap,
      claimsUsedThisYear: ct.balance.claimsUsedThisYear,
      maxClaimsPerYear: ct.balance.maxClaimsPerYear,
      blockLimit: ct.balance.blockLimit,
      remainingThisBlock: ct.balance.remainingThisBlock,
      blockEndsOn: ct.balance.blockEndsOn,
    },
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('title')} description={[t('subtitle'),...(selectedQuery.employmentId?[me.company,me.employeeCode]:[])].filter(Boolean).join(' · ')} />
      <ErrorBanner message={error} />

      <Card data-tour="claims-compose" className="p-4">
        <h2 className="mb-3 text-sm font-semibold">{editing ? t('editDraft') : t('newClaim')}</h2>
        {types.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noTypes')}</p>
        ) : (
          <ClaimForm
            // Remounts the controlled form when the employee switches between drafts (or back to a new
            // claim): without a changing key React keeps the first draft's useState values.
            key={JSON.stringify([selectedQuery.employmentId,draftPrefill?.id??'new'])}
            types={formTypes}
            submitAction={submitClaimAction}
            todayUtc={today}
            draft={draftPrefill}
            employmentId={selectedQuery.employmentId}
          />
        )}
      </Card>

      {drafts.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('draftsTitle')} count={drafts.length} />
          <p className="px-4 pt-3 text-xs text-muted-foreground">{t('draftsHint')}</p>
          {/* Bulk submit. Every checkbox posts the same field name, so the action reads them with
              getAll('draftIds') and the service files them in ONE transaction against ONE limit. */}
          <form action={submitDraftsAction}>
            {subjectField}
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="w-8 px-4 py-2" />
                  <th className="px-4 py-2 font-medium">{t('colType')}</th>
                  <th className="px-4 py-2 font-medium">{t('colAmount')}</th>
                  <th className="px-4 py-2 font-medium">{t('colDate')}</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {drafts.map((d) => (
                  <tr key={d.id} className="border-t border-border align-top">
                    <td className="px-4 py-2.5">
                      <input type="checkbox" name="draftIds" value={d.id} aria-label={d.typeName} className="size-4 align-middle" />
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{d.typeName}</div>
                      {d.itemName && <div className="text-xs text-muted-foreground">{d.itemName}</div>}
                      {d.description && <div className="text-xs text-muted-foreground">{d.description}</div>}
                      {d.attachments.map((a) => (
                        <a key={a.id} href={`/claims/attachment/${a.id}?inline=1`} target="_blank" rel="noopener noreferrer" className="mt-0.5 block text-xs text-primary underline-offset-2 hover:underline">
                          ↗ {a.fileName}
                        </a>
                      ))}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">{d.amount > 0 ? rm(d.amount) : <span className="text-muted-foreground">{t('draftNoAmount')}</span>}</td>
                    <td className="px-4 py-2.5 tabular-nums">{d.incurredOn}</td>
                    <td className="px-4 py-2.5 text-right">
                      <Link href={'/claims?'+new URLSearchParams({draft:d.id,...selectedQuery})} className="mr-3 text-xs text-primary underline-offset-2 hover:underline">
                        {t('edit')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center gap-3 border-t border-border px-4 py-3">
              <Button type="submit" size="sm">{t('submitSelected')}</Button>
              <span className="text-xs text-muted-foreground">{t('submitSelectedHint')}</span>
            </div>
          </form>
          {/* Deletion is its own form: nesting it inside the bulk-submit form would post both. */}
          <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
            {drafts.map((d) => (
              <form key={d.id} action={deleteDraftAction}>
                {subjectField}
                <input type="hidden" name="id" value={d.id} />
                <ConfirmSubmit
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  title={t('deleteDraftConfirmTitle')}
                  description={t('deleteDraftConfirmDescription')}
                  confirmLabel={t('deleteDraftConfirmLabel')}
                >
                  {t('deleteDraftFor', { type: d.typeName })}
                </ConfirmSubmit>
              </form>
            ))}
          </div>
        </Card>
      )}

      <Card data-tour="claims-history" className="overflow-hidden">
        <SectionHeader title={t('myClaims')} count={pgState.total} />
        <Pager basePath="/claims" params={selectedQuery} state={pgState} />
        {claimPage.length === 0 ? (
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
                    {c.status === 'rejected' && rejectReasons.get(c.id)?.rejectReason && (
                      <div className="mt-1 max-w-xs break-words text-xs text-muted-foreground">{t('rejectReasonShown', { reason: rejectReasons.get(c.id)!.rejectReason! })}</div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {c.status === 'pending' && (
                      <form action={cancelClaimAction}>
                        {subjectField}
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
      </Card>
    </div>
  );
}
