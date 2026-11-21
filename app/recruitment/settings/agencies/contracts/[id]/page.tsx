import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, Field, Input, PageHeader, btnGhost, btnPrimary, tableWrapCls, tbodyCls, thCls, theadCls } from '@/components/ui';
import { agencyContract, CONSULTANT_STATUSES, CONTRACT_FILE_ACCEPT, RecruitmentError, type ContractDetail } from '@/packs/recruitment/service';
import {
  addAgencyContractUserAction, removeAgencyContractFileAction, removeAgencyContractUserAction, saveAgencyConsultantAction, saveAgencyContractAction,
  uploadAgencyContractFileAction,
} from '../../../../actions';
import { Notice, Pill, RecruitmentTabs, klDate, recruitmentAccess, recruitmentErrorText, selectCls } from '../../../../shared';
import { ContractFields } from '../../../agency-settings';

/**
 * Settings › Agencies › Contract (slice 10, recruitment administrators only — the service and row security refuse
 * everybody else): the contract's details with its fee rate (a percentage, never an amount, D-037) and PDF, who it is
 * released to when Restricted, its consultants (contact records; nothing is sent to them, D-036) and Positions — every
 * job it was released to or submitted to, with live counts of submitted, accepted, interviewed, offered and hired.
 */
export default async function AgencyContractPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ problem?: string; notice?: string }> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  await recruitmentAccess(s, scopeIds, false);
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  let c: ContractDetail;
  try {
    c = await agencyContract(s, id);
  } catch (e) {
    if (e instanceof RecruitmentError && (e.code === 'not_found' || e.code === 'forbidden')) notFound();
    throw e;
  }
  const [t, locale] = await Promise.all([getTranslations('recruitment.agency'), getLocale()]);
  const here = `/recruitment/settings/agencies/contracts/${c.id}`;
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <PageHeader title={c.name} description={<>{c.agencyName} · {t(`types.${c.contractType}`)} · <Pill tone={c.usableToday ? 'good' : 'neutral'}>{c.usableToday ? t('usable') : t(`statuses.${c.status}`)}</Pill></>}
        back={{ href: `/recruitment/settings?section=agencies&company=${c.companyId}`, label: t('backToAgencies') }} />
      <RecruitmentTabs active="settings" />
      <Notice text={sp.notice === 'saved' ? t('savedNotice') : undefined} />
      <ErrorBanner message={await recruitmentErrorText(sp.problem)} />

      <section aria-labelledby="details-title" className="space-y-3 rounded-xl border border-border bg-card p-4">
        <h2 id="details-title" className="text-sm font-semibold">{t('details')}</h2>
        <form action={saveAgencyContractAction} className="grid gap-3 sm:grid-cols-2">
          {hidden('contractId', c.id)}{hidden('returnTo', here)}
          <ContractFields t={t} contacts={c.contacts.some((x) => x.id === c.hrContactUserId) ? c.contacts : [...c.contacts, { id: c.hrContactUserId, name: c.hrContactName ?? t('unnamedUser') }]}
            values={{ ...c, protectionDays: c.protectionDays }} />
          <p className="text-xs text-muted-foreground sm:col-span-2">{t('feeNote')}</p>
          <div className="sm:col-span-2"><button type="submit" className={btnPrimary}>{t('save')}</button></div>
        </form>
      </section>

      <section aria-labelledby="file-title" className="space-y-3 rounded-xl border border-border bg-card p-4">
        <h2 id="file-title" className="text-sm font-semibold">{t('contractFile')}</h2>
        {c.file ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <a href={`${here}/file`} className="font-medium text-primary hover:underline">{c.file.name}</a>
            <span className="text-xs text-muted-foreground">{kb(c.file.size)}</span>
            <form action={removeAgencyContractFileAction}>{hidden('contractId', c.id)}<button type="submit" className="text-sm text-destructive hover:underline">{t('removeFile')}</button></form>
          </div>
        ) : <p className="text-sm text-muted-foreground">{t('noFile')}</p>}
        <form action={uploadAgencyContractFileAction} className="flex flex-wrap items-end gap-2">
          {hidden('contractId', c.id)}
          <Field label={t('uploadPdf')} className="min-w-64">
            <input name="file" type="file" required accept={CONTRACT_FILE_ACCEPT} className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-sm" />
          </Field>
          <button type="submit" className={btnGhost}>{c.file ? t('replaceFile') : t('attachFile')}</button>
        </form>
      </section>

      {c.access === 'restricted' && (
        <section aria-labelledby="access-title" className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div><h2 id="access-title" className="text-sm font-semibold">{t('accessList')}</h2><p className="text-sm text-muted-foreground">{t('accessListNote')}</p></div>
          {c.users.length === 0 ? <p className="text-sm text-muted-foreground">{t('noUsers')}</p> : (
            <ul className="flex flex-wrap gap-2">
              {c.users.map((u) => (
                <li key={u.id} className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-sm">
                  {u.name || t('unnamedUser')}
                  <form action={removeAgencyContractUserAction}>{hidden('contractId', c.id)}{hidden('userId', u.id)}
                    <button type="submit" className="text-xs text-muted-foreground hover:text-destructive" aria-label={t('removeUser', { name: u.name || t('unnamedUser') })}>×</button></form>
                </li>
              ))}
            </ul>
          )}
          <form action={addAgencyContractUserAction} className="flex flex-wrap items-end gap-2">
            {hidden('contractId', c.id)}
            <Field label={t('user')} className="min-w-64">
              <select name="userId" required defaultValue="" className={selectCls}>
                <option value="" disabled>{t('choose')}</option>
                {c.userOptions.filter((u) => !c.users.some((x) => x.id === u.id)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </Field>
            <button type="submit" className={btnGhost}>{t('addUser')}</button>
          </form>
        </section>
      )}

      <section aria-labelledby="consultants-title" className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div><h2 id="consultants-title" className="text-sm font-semibold">{t('consultantsTitle')}</h2><p className="text-sm text-muted-foreground">{t('consultantsNote')}</p></div>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {c.consultants.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">{t('noConsultants')}</li>}
          {c.consultants.map((k) => (
            <li key={k.id} className="px-3 py-2">
              <form action={saveAgencyConsultantAction} className="grid gap-2 sm:grid-cols-[1fr_1fr_10rem_9rem_auto] sm:items-end">
                {hidden('contractId', c.id)}{hidden('consultantId', k.id)}
                <Field label={t('consultantName')}><Input name="name" defaultValue={k.name} maxLength={120} required /></Field>
                <Field label={t('email')}><Input type="email" name="email" defaultValue={k.email ?? ''} maxLength={254} /></Field>
                <Field label={t('mobile')}><Input name="mobile" defaultValue={k.mobile ?? ''} maxLength={40} /></Field>
                <Field label={t('status')}>
                  <select name="status" defaultValue={k.status} className={selectCls}>
                    {CONSULTANT_STATUSES.map((v) => <option key={v} value={v}>{t(`consultantStatuses.${v}`)}</option>)}
                  </select>
                </Field>
                <button type="submit" className={btnGhost}>{t('save')}</button>
              </form>
            </li>
          ))}
        </ul>
        <form action={saveAgencyConsultantAction} className="grid gap-2 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[1fr_1fr_10rem_auto] sm:items-end">
          {hidden('contractId', c.id)}
          <Field label={t('consultantName')} required requiredAriaLabel={t('required')}><Input name="name" maxLength={120} required /></Field>
          <Field label={t('email')}><Input type="email" name="email" maxLength={254} /></Field>
          <Field label={t('mobile')}><Input name="mobile" maxLength={40} /></Field>
          <button type="submit" className={btnPrimary}>{t('addConsultant')}</button>
        </form>
      </section>

      <section aria-labelledby="positions-title" className="space-y-3">
        <div><h2 id="positions-title" className="text-sm font-semibold">{t('positionsTitle')}</h2><p className="text-sm text-muted-foreground">{t('positionsNote')}</p></div>
        {c.positions.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('noPositions')}</p> : (
          <div className={tableWrapCls}>
            <table className="w-full text-sm">
              <thead className={theadCls}><tr>
                <th className={thCls}>{t('position')}</th><th className={thCls}>{t('counts.submitted')}</th><th className={thCls}>{t('counts.accepted')}</th>
                <th className={thCls}>{t('counts.interviewed')}</th><th className={thCls}>{t('counts.offered')}</th><th className={thCls}>{t('counts.hired')}</th>
              </tr></thead>
              <tbody className={tbodyCls}>
                {c.positions.map((p) => (
                  <tr key={p.jobId}>
                    <td className="px-3 py-2"><Link href={`/recruitment/positions/${p.jobId}`} className="font-medium text-primary hover:underline">{p.title}</Link>
                      <span className="block text-xs text-muted-foreground"><span className="font-mono">{p.jobNumber}</span>{!p.assigned && ` · ${t('noLongerReleased')}`}</span></td>
                    {([p.submitted, p.accepted, p.interviewed, p.offered, p.hired] as const).map((n, i) => <td key={i} className="px-3 py-2 tabular-nums">{n}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t('periodLine', { from: klDate(locale, c.startsOn), to: klDate(locale, c.endsOn) })}</p>
      </section>
    </div>
  );
}
