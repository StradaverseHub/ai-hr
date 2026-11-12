import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, Field, Input, PageHeader, btnGhost, btnPrimary, tableWrapCls, tbodyCls, thCls, theadCls } from '@/components/ui';
import { recruitmentSettings, RECRUITMENT_STAGE_TYPES } from '@/packs/recruitment/service';
import { deleteArchiveReasonAction, saveArchiveReasonAction, updateProcessAction, updateStageAction } from '../actions';
import { NoRecruitmentCompany, Notice, RecruitmentTabs, SubTabs, pickCompany, recruitmentAccess, recruitmentErrorText, selectCls } from '../shared';
import { InterviewSettingsSection } from './interview-settings';
import { OfferSettingsSection } from './offer-settings';
import { PrivacySettingsSection } from './privacy-settings';
import { ReferralSettingsSection } from './referral-settings';
import { CareersSettingsSection } from './careers-settings';
import { TagSettingsSection } from './tag-settings';
import { AgencySettingsSection } from './agency-settings';
import { BackgroundCheckSettingsSection } from './background-check-settings';
import { PoolSettingsSection } from './pool-settings';
import { CustomFieldSettingsSection } from './custom-field-settings';
import { PositionTemplateSettingsSection } from './position-template-settings';

/**
 * Recruitment › Settings for one company (administrators only). Pipeline: the stage catalogue, recruitment processes
 * and archive reasons. Interviews (slice 2): feedback visibility, the edit lock, whether a result is required, and
 * evaluation forms. Offers and approvals (slices 3–4): the offer-field set, validity, the optional automation and the
 * offer and requisition approval flows. Referrals (slice 7): the referral protection period. Careers page (slice 8): the public
 * page, its publish switch and privacy notice versions. Agencies (slice 10): agency tags, agencies, contracts (each with its own
 * page) and consultants. Background checks (slice 12): the company's check types. Talent pools (slice 13): custom pools, sub-pools
 * and sharing. Custom fields (slice 14): the company's own candidate and job fields and their options. Position templates (slice 15):
 * the company's switch for "New position from template" and its templates. Every change is a domain event.
 */
export default async function RecruitmentSettingsPage({ searchParams }: { searchParams: Promise<{ company?: string; problem?: string; notice?: string; section?: string; agency?: string; tag?: string; type?: string; status?: string; kind?: string; template?: string }> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const companies = await recruitmentAccess(s, scopeIds, false);
  const sp = await searchParams;
  const [t, nav, locale] = await Promise.all([getTranslations('recruitment.settings'), getTranslations('nav'), getLocale()]);
  const company = pickCompany(companies, sp.company);
  const settings = company ? await recruitmentSettings(s, company.id) : null;
  const section = sp.section === 'interviews' || sp.section === 'offers' || sp.section === 'privacy' || sp.section === 'tags' || sp.section === 'referrals' || sp.section === 'careers' || sp.section === 'agencies' || sp.section === 'checks' || sp.section === 'pools' || sp.section === 'fields' || sp.section === 'templates' ? sp.section : 'general';
  const sectionHref = (key: string) => `/recruitment/settings?${new URLSearchParams({ ...(company ? { company: company.id } : {}), ...(key === 'general' ? {} : { section: key }) })}`;
  const here = sectionHref(section);
  const when = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(iso));
  const audit = (by: string | null, at: string) => t('changed', { by: by ?? t('unnamedUser'), at: when(at) });
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('purpose')} />
      <RecruitmentTabs active="settings" />
      <Notice text={sp.notice === 'saved' ? t('savedNotice') : sp.notice === 'removed' ? t('privacy.removedNotice') : undefined} />
      <ErrorBanner message={await recruitmentErrorText(sp.problem)} />
      {!company || !settings ? <NoRecruitmentCompany /> : (
        <>
          {companies.length > 1 && (
            <form method="get" className="flex flex-wrap items-end gap-2">
              <Field label={t('company')} className="min-w-64">
                <select name="company" defaultValue={company.id} className={selectCls}>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <button type="submit" className={btnGhost}>{t('switchCompany')}</button>
            </form>
          )}
          <SubTabs label={t('sections')} items={(['general', 'interviews', 'offers', 'privacy', 'tags', 'referrals', 'careers', 'agencies', 'checks', 'pools', 'fields', 'templates'] as const).map((key) => ({ key, href: sectionHref(key), text: t(`section.${key}`), current: section === key }))} />
          {section === 'interviews' ? <InterviewSettingsSection s={s} companyId={company.id} here={here} />
            : section === 'offers' ? <OfferSettingsSection s={s} companyId={company.id} here={here} />
              : section === 'privacy' ? <PrivacySettingsSection s={s} companyId={company.id} here={here} />
                : section === 'tags' ? <TagSettingsSection s={s} companyId={company.id} here={here} />
                  : section === 'referrals' ? <ReferralSettingsSection s={s} companyId={company.id} here={here} />
                    : section === 'careers' ? <CareersSettingsSection s={s} companyId={company.id} here={here} />
                      : section === 'agencies' ? <AgencySettingsSection s={s} companyId={company.id} here={here} filters={{ agency: sp.agency, tag: sp.tag, type: sp.type, status: sp.status }} />
                        : section === 'checks' ? <BackgroundCheckSettingsSection s={s} companyId={company.id} here={here} />
                          : section === 'pools' ? <PoolSettingsSection s={s} companyId={company.id} here={here} />
                            : section === 'fields' ? <CustomFieldSettingsSection s={s} companyId={company.id} kind={sp.kind} />
                              : section === 'templates' ? <PositionTemplateSettingsSection s={s} companyId={company.id} here={here} template={sp.template} /> : (<>

          <section className="space-y-3" aria-labelledby="stages-title">
            <div><h2 id="stages-title" className="text-base font-semibold">{t('stagesTitle')}</h2><p className="text-sm text-muted-foreground">{t('stagesNote')}</p></div>
            <div className={tableWrapCls}>
              <table className="w-full text-sm">
                <thead className={theadCls}><tr><th className={thCls}>{t('stageName')}</th><th className={thCls}>{t('stageType')}</th><th className={thCls}>{t('enabled')}</th><th className={thCls}>{t('lastChange')}</th><th className={thCls}><span className="sr-only">{t('save')}</span></th></tr></thead>
                <tbody className={tbodyCls}>
                  {settings.stages.map((st) => {
                    const form = `stage-${st.id}`;
                    return (
                      <tr key={st.id}>
                        <td className="px-3 py-2"><Input form={form} name="name" defaultValue={st.name} maxLength={120} required aria-label={t('stageName')} /></td>
                        <td className="px-3 py-2">
                          {st.systemKey ? <span>{t('types.system_default')}</span> : (
                            <select form={form} name="type" defaultValue={st.type} className={selectCls} aria-label={t('stageType')}>
                              {RECRUITMENT_STAGE_TYPES.filter((v) => v !== 'system_default').map((v) => <option key={v} value={v}>{t(`types.${v}`)}</option>)}
                            </select>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <input form={form} type="checkbox" name="enabled" defaultChecked={st.enabled} disabled={!!st.systemKey} aria-label={t('enabled')} />
                          {st.systemKey && <input form={form} type="hidden" name="enabled" value="on" />}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{audit(st.updatedBy, st.updatedAt)}</td>
                        <td className="px-3 py-2 text-right">
                          <form id={form} action={updateStageAction}>
                            {hidden('stageId', st.id)}{hidden('returnTo', here)}{st.systemKey && <input type="hidden" name="type" value="system_default" />}
                            <button type="submit" className={btnGhost}>{t('save')}</button>
                          </form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">{t('terminalNote')}</p>
          </section>

          <section className="space-y-3" aria-labelledby="processes-title">
            <h2 id="processes-title" className="text-base font-semibold">{t('processesTitle')}</h2>
            <ul className="space-y-3">
              {settings.processes.map((p) => (
                <li key={p.id} className="space-y-3 rounded-xl border border-border bg-card p-4">
                  <form action={updateProcessAction} className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
                    {hidden('processId', p.id)}{hidden('returnTo', here)}
                    <Field label={t('processName')}><Input name="name" defaultValue={p.name} maxLength={120} required /></Field>
                    <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={p.enabled} />{t('enabled')}</label>
                    <button type="submit" className={btnGhost}>{t('save')}</button>
                  </form>
                  <p className="text-xs text-muted-foreground">{t('processScope', { jobs: p.jobs })} · {audit(p.updatedBy, p.updatedAt)}</p>
                  <ol className="flex flex-wrap gap-2 text-xs">
                    {p.stages.map((st, i) => <li key={st.stageId} className={st.enabled ? 'rounded-full border border-border px-2 py-1' : 'rounded-full border border-dashed border-border px-2 py-1 text-muted-foreground'}>{i + 1}. {st.name}</li>)}
                    <li className="rounded-full bg-muted px-2 py-1">{t('hired')}</li>
                    <li className="rounded-full bg-muted px-2 py-1">{t('archived')}</li>
                  </ol>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-3" aria-labelledby="reasons-title">
            <div><h2 id="reasons-title" className="text-base font-semibold">{t('reasonsTitle')}</h2><p className="text-sm text-muted-foreground">{t('reasonsNote')}</p></div>
            <div className={tableWrapCls}>
              <table className="w-full text-sm">
                <thead className={theadCls}><tr><th className={thCls}>{t('internalReason')}</th><th className={thCls}>{t('externalReason')}</th><th className={thCls}>{t('kind')}</th><th className={thCls}>{t('displayed')}</th><th className={thCls}>{t('lastChange')}</th><th className={thCls}><span className="sr-only">{t('actions')}</span></th></tr></thead>
                <tbody className={tbodyCls}>
                  {settings.reasons.map((r) => {
                    const form = `reason-${r.id}`;
                    return (
                      <tr key={r.id}>
                        <td className="px-3 py-2"><Input form={form} name="internal" defaultValue={r.internal} maxLength={200} required aria-label={t('internalReason')} /></td>
                        <td className="px-3 py-2"><Input form={form} name="external" defaultValue={r.external} maxLength={500} required aria-label={t('externalReason')} /></td>
                        <td className="px-3 py-2">{r.kind === 'default' ? t('kindDefault') : t('kindCustom')}</td>
                        <td className="px-3 py-2"><input form={form} type="checkbox" name="displayed" defaultChecked={r.displayed} aria-label={t('displayed')} /></td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{audit(r.updatedBy, r.updatedAt)}</td>
                        <td className="space-x-2 whitespace-nowrap px-3 py-2 text-right">
                          <form id={form} action={saveArchiveReasonAction} className="inline">
                            {hidden('reasonId', r.id)}{hidden('returnTo', here)}
                            <button type="submit" className={btnGhost}>{t('save')}</button>
                          </form>
                          {r.kind === 'custom' && !r.used && (
                            <form action={deleteArchiveReasonAction} className="inline">
                              {hidden('reasonId', r.id)}{hidden('returnTo', here)}
                              <button type="submit" className="text-sm text-destructive hover:underline">{t('delete')}</button>
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <form action={saveArchiveReasonAction} className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
              {hidden('companyId', company.id)}{hidden('returnTo', here)}
              <Field label={t('internalReason')} required requiredAriaLabel={t('required')}><Input name="internal" maxLength={200} required /></Field>
              <Field label={t('externalReason')} required requiredAriaLabel={t('required')}><Input name="external" maxLength={500} required /></Field>
              <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="displayed" defaultChecked />{t('displayed')}</label>
              <button type="submit" className={btnPrimary}>{t('addReason')}</button>
            </form>
          </section>
          </>)}
        </>
      )}
    </div>
  );
}
