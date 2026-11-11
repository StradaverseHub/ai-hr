import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnGhost, btnPrimary, tableWrapCls, tbodyCls, thCls, theadCls } from '@/components/ui';
import { agencyContracts, agencySetup, CONTRACT_ACCESS, CONTRACT_STATUSES, CONTRACT_TYPES, PROTECTION_OVERRIDE_MAX_DAYS } from '@/packs/recruitment/service';
import { deleteAgencyTagAction, saveAgencyAction, saveAgencyContractAction, saveAgencyTagAction } from '../actions';
import { Pill, klDate, selectCls } from '../shared';

export type AgencyFilters = { agency?: string; tag?: string; type?: string; status?: string };

/**
 * Settings › Agencies (slice 10, administrators): agency tags, agencies with their tags, and contracts — a filtered list
 * (agency name, tag, type, status) and a form for a new contract. Each contract opens its own page (details, fee rate and
 * file, access list, consultants and Positions). Agencies have no login here and nothing is sent to them (D-036); the fee
 * rate is a percentage shown to administrators, never turned into an amount (D-037).
 */
export async function AgencySettingsSection({ s, companyId, here, filters }: { s: SessionContext; companyId: string; here: string; filters: AgencyFilters }) {
  const [t, locale, setup, contracts] = await Promise.all([
    getTranslations('recruitment.agency'), getLocale(), agencySetup(s, companyId),
    agencyContracts(s, companyId, { agency: filters.agency, tagId: filters.tag, contractType: filters.type, status: filters.status }),
  ]);
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const enabledTags = setup.tags.filter((g) => g.enabled);
  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">{t('settingsNote')}</p>

      <section className="space-y-3" aria-labelledby="contracts-title">
        <div><h2 id="contracts-title" className="text-base font-semibold">{t('contractsTitle')}</h2><p className="text-sm text-muted-foreground">{t('contractsNote')}</p></div>
        <form method="get" className="flex flex-wrap items-end gap-2">
          {hidden('section', 'agencies')}{hidden('company', companyId)}
          <Field label={t('filterAgency')} className="min-w-48"><Input name="agency" defaultValue={filters.agency ?? ''} maxLength={120} /></Field>
          <Field label={t('tag')} className="min-w-40">
            <select name="tag" defaultValue={filters.tag ?? ''} className={selectCls}>
              <option value="">{t('any')}</option>
              {setup.tags.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </Field>
          <Field label={t('type')} className="min-w-36">
            <select name="type" defaultValue={filters.type ?? ''} className={selectCls}>
              <option value="">{t('any')}</option>
              {CONTRACT_TYPES.map((v) => <option key={v} value={v}>{t(`types.${v}`)}</option>)}
            </select>
          </Field>
          <Field label={t('status')} className="min-w-36">
            <select name="status" defaultValue={filters.status ?? ''} className={selectCls}>
              <option value="">{t('any')}</option>
              {CONTRACT_STATUSES.map((v) => <option key={v} value={v}>{t(`statuses.${v}`)}</option>)}
            </select>
          </Field>
          <button type="submit" className={btnGhost}>{t('filter')}</button>
        </form>
        {contracts.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('noContracts')}</p> : (
          <div className={tableWrapCls}>
            <table className="w-full text-sm">
              <thead className={theadCls}><tr>
                <th className={thCls}>{t('contract')}</th><th className={thCls}>{t('agency')}</th><th className={thCls}>{t('tags')}</th>
                <th className={thCls}>{t('consultants')}</th><th className={thCls}>{t('feeRate')}</th><th className={thCls}>{t('status')}</th><th className={thCls}>{t('period')}</th>
              </tr></thead>
              <tbody className={tbodyCls}>
                {contracts.map((c) => (
                  <tr key={c.id}>
                    <td className="px-3 py-2"><Link href={`/recruitment/settings/agencies/contracts/${c.id}`} className="font-medium text-primary hover:underline">{c.name}</Link>
                      <span className="block text-xs text-muted-foreground">{t(`types.${c.contractType}`)}</span></td>
                    <td className="px-3 py-2">{c.agencyName}</td>
                    <td className="px-3 py-2 text-xs">{c.tags.join(', ') || '—'}</td>
                    <td className="px-3 py-2 tabular-nums">{c.activeConsultants}</td>
                    <td className="px-3 py-2 tabular-nums">{t('percent', { rate: c.feeRate })}</td>
                    <td className="px-3 py-2"><Pill tone={c.usableToday ? 'good' : 'neutral'}>{c.usableToday ? t('usable') : t(`statuses.${c.status}`)}</Pill></td>
                    <td className="px-3 py-2 text-xs tabular-nums">{klDate(locale, c.startsOn)} – {klDate(locale, c.endsOn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {setup.agencies.length > 0 && (
          <details className="rounded-xl border border-border bg-card p-4">
            <summary className="cursor-pointer text-sm font-semibold">{t('newContract')}</summary>
            <form action={saveAgencyContractAction} className="mt-3 grid gap-3 sm:grid-cols-2">
              {hidden('returnTo', here)}
              <Field label={t('agency')} required requiredAriaLabel={t('required')}>
                <select name="agencyId" required defaultValue="" className={selectCls}>
                  <option value="" disabled>{t('choose')}</option>
                  {setup.agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <ContractFields t={t} contacts={setup.contacts} />
              <div className="sm:col-span-2"><button type="submit" className={btnPrimary}>{t('createContract')}</button></div>
            </form>
          </details>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="agencies-title">
        <div><h2 id="agencies-title" className="text-base font-semibold">{t('agenciesTitle')}</h2><p className="text-sm text-muted-foreground">{t('agenciesNote')}</p></div>
        {setup.agencies.length === 0 && <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('noAgencies')}</p>}
        <ul className="space-y-2">
          {setup.agencies.map((a) => (
            <li key={a.id} className="rounded-xl border border-border bg-card p-3">
              <form action={saveAgencyAction} className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
                {hidden('agencyId', a.id)}{hidden('returnTo', here)}
                <Field label={t('agencyName')}><Input name="name" defaultValue={a.name} maxLength={120} required /></Field>
                <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                  <legend className="mb-1 text-xs font-medium text-muted-foreground">{t('tags')}</legend>
                  {setup.tags.filter((g) => g.enabled || a.tagIds.includes(g.id)).map((g) => (
                    <label key={g.id} className="flex items-center gap-1"><input type="checkbox" name="tagIds" value={g.id} defaultChecked={a.tagIds.includes(g.id)} />{g.name}</label>
                  ))}
                  {setup.tags.length === 0 && <span className="text-xs text-muted-foreground">{t('noTags')}</span>}
                </fieldset>
                <button type="submit" className={btnGhost}>{t('save')}</button>
              </form>
              <p className="mt-1 text-xs text-muted-foreground">{t('contractCount', { n: a.contracts })}</p>
            </li>
          ))}
        </ul>
        <form action={saveAgencyAction} className="flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-border p-4">
          {hidden('companyId', companyId)}{hidden('returnTo', here)}
          <Field label={t('newAgency')} className="min-w-64" required requiredAriaLabel={t('required')}><Input name="name" maxLength={120} required /></Field>
          {enabledTags.length > 0 && (
            <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
              <legend className="mb-1 text-xs font-medium text-muted-foreground">{t('tags')}</legend>
              {enabledTags.map((g) => <label key={g.id} className="flex items-center gap-1"><input type="checkbox" name="tagIds" value={g.id} />{g.name}</label>)}
            </fieldset>
          )}
          <button type="submit" className={btnPrimary}>{t('addAgency')}</button>
        </form>
      </section>

      <section className="space-y-3" aria-labelledby="agency-tags-title">
        <div><h2 id="agency-tags-title" className="text-base font-semibold">{t('tagsTitle')}</h2><p className="text-sm text-muted-foreground">{t('tagsNote')}</p></div>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {setup.tags.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">{t('noTags')}</li>}
          {setup.tags.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <form action={saveAgencyTagAction} className="grid flex-1 gap-2 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center">
                {hidden('tagId', g.id)}{hidden('returnTo', here)}
                <Input name="name" defaultValue={g.name} maxLength={60} required aria-label={t('tagName')} />
                <span className="text-xs text-muted-foreground">{t('usedBy', { n: g.used })}</span>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={g.enabled} />{t('enabled')}</label>
                <button type="submit" className={btnGhost}>{t('save')}</button>
              </form>
              {g.used === 0 && (
                <form action={deleteAgencyTagAction}>
                  {hidden('tagId', g.id)}{hidden('returnTo', here)}
                  <button type="submit" className="text-sm text-destructive hover:underline">{t('delete')}</button>
                </form>
              )}
            </li>
          ))}
        </ul>
        <form action={saveAgencyTagAction} className="flex flex-wrap items-end gap-2">
          {hidden('companyId', companyId)}{hidden('returnTo', here)}<input type="hidden" name="enabled" value="on" />
          <Field label={t('newTag')} className="min-w-56"><Input name="name" maxLength={60} required /></Field>
          <button type="submit" className={btnGhost}>{t('addTag')}</button>
        </form>
      </section>
    </div>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<'recruitment.agency'>>>;
/** The contract fields shared by the new-contract form and the contract page. */
export function ContractFields({ t, contacts, values }: {
  t: T; contacts: { id: string; name: string }[];
  values?: { name: string; contractType: string; status: string; feeRate: string; startsOn: string; endsOn: string; hrContactUserId: string; access: string; protectionDays: number | null };
}) {
  return (
    <>
      <Field label={t('contractName')} required requiredAriaLabel={t('required')}><Input name="name" defaultValue={values?.name} maxLength={120} required /></Field>
      <Field label={t('type')} required requiredAriaLabel={t('required')}>
        <select name="contractType" required defaultValue={values?.contractType ?? 'headhunter'} className={selectCls}>
          {CONTRACT_TYPES.map((v) => <option key={v} value={v}>{t(`types.${v}`)}</option>)}
        </select>
      </Field>
      <Field label={t('feeRatePercent')} required requiredAriaLabel={t('required')}>
        <Input name="feeRate" inputMode="decimal" defaultValue={values?.feeRate} required pattern="\d{1,3}(\.\d{1,2})?" />
      </Field>
      <Field label={t('status')}>
        <select name="status" defaultValue={values?.status ?? 'enabled'} className={selectCls}>
          {CONTRACT_STATUSES.map((v) => <option key={v} value={v}>{t(`statuses.${v}`)}</option>)}
        </select>
      </Field>
      <Field label={t('startsOn')} required requiredAriaLabel={t('required')}><Input type="date" name="startsOn" defaultValue={values?.startsOn} required /></Field>
      <Field label={t('endsOn')} required requiredAriaLabel={t('required')}><Input type="date" name="endsOn" defaultValue={values?.endsOn} required /></Field>
      <Field label={t('hrContact')} required requiredAriaLabel={t('required')}>
        <select name="hrContactUserId" required defaultValue={values?.hrContactUserId ?? ''} className={selectCls}>
          <option value="" disabled>{t('choose')}</option>
          {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label={t('access')}>
        <select name="access" defaultValue={values?.access ?? 'public'} className={selectCls}>
          {CONTRACT_ACCESS.map((v) => <option key={v} value={v}>{t(`accessKinds.${v}`)}</option>)}
        </select>
      </Field>
      <Field label={t('protectionOverride', { max: PROTECTION_OVERRIDE_MAX_DAYS })}>
        <Input type="number" name="protectionDays" min={0} max={PROTECTION_OVERRIDE_MAX_DAYS} defaultValue={values?.protectionDays ?? ''} placeholder={t('protectionDefault')} />
      </Field>
    </>
  );
}
