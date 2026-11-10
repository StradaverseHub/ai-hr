import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnPrimary, tableWrapCls, tbodyCls, thCls, theadCls } from '@/components/ui';
import { dueForDestruction, REPEAT_WINDOW_CHOICES } from '@/packs/recruitment/service';
import { destroyCandidatesAction, updatePrivacySettingsAction } from '../actions';
import { klDate, selectCls } from '../shared';

/**
 * Settings › Privacy (slice 5, administrators): how long candidate data is kept without and with consent, the
 * repeated-application window, and the candidates whose retention period has ended. Nothing is destroyed automatically:
 * an administrator selects due candidates and confirms. Destruction removes personal data and keeps the application
 * skeleton, so pipeline counts do not change.
 */
export async function PrivacySettingsSection({ s, companyId, here }: { s: SessionContext; companyId: string; here: string }) {
  const [t, locale, { settings, due, today }] = await Promise.all([getTranslations('recruitment.settings.privacy'), getLocale(), dueForDestruction(s, companyId)]);
  const day = (d: string) => klDate(locale, `${d}T00:00:00+08:00`);
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  return (
    <div className="space-y-6">
      <form action={updatePrivacySettingsAction} className="space-y-4 rounded-xl border border-border bg-card p-4">
        {hidden('companyId', companyId)}{hidden('returnTo', here)}
        <div>
          <h2 className="text-base font-semibold">{t('retentionTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('retentionNote')}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t('withoutConsent')}><Input name="monthsWithoutConsent" type="number" min={1} max={120} required defaultValue={settings.monthsWithoutConsent} /></Field>
          <Field label={t('withConsent')}><Input name="monthsWithConsent" type="number" min={1} max={120} required defaultValue={settings.monthsWithConsent} /></Field>
          <Field label={t('repeatWindow')}>
            <select name="repeatWindowMonths" defaultValue={String(settings.repeatWindowMonths)} className={selectCls}>
              {REPEAT_WINDOW_CHOICES.map((m) => <option key={m} value={m}>{m === 0 ? t('repeatOff') : t('months', { n: m })}</option>)}
            </select>
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">{t('repeatNote')}</p>
        <button type="submit" className={btnPrimary}>{t('save')}</button>
      </form>

      <section className="space-y-3" aria-labelledby="due-title">
        <div>
          <h2 id="due-title" className="text-base font-semibold">{t('dueTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('dueNote', { date: day(today) })}</p>
        </div>
        {due.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('noneDue')}</p> : (
          <form action={destroyCandidatesAction} className="space-y-3">
            {hidden('companyId', companyId)}{hidden('returnTo', here)}
            <div className={tableWrapCls}>
              <table className="w-full text-sm">
                <thead className={theadCls}><tr>
                  <th className={thCls}><span className="sr-only">{t('select')}</span></th><th className={thCls}>{t('candidate')}</th>
                  <th className={thCls}>{t('archivedOn')}</th><th className={thCls}>{t('consent')}</th><th className={thCls}>{t('dueOn')}</th>
                </tr></thead>
                <tbody className={tbodyCls}>
                  {due.map((d) => (
                    <tr key={d.candidateId}>
                      <td className="px-3 py-2"><input type="checkbox" name="candidateIds" value={d.candidateId} aria-label={t('selectCandidate', { name: d.name })} /></td>
                      <td className="px-3 py-2">{d.name} <span className="ml-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-xs text-destructive">{t('ended')}</span></td>
                      <td className="px-3 py-2">{day(d.archivedOn)}</td>
                      <td className="px-3 py-2">{d.consent === null ? t('noConsent') : d.consent.status === 'withdrawn' ? t('withdrawnOn', { date: day(d.consent.on) }) : t('consentedOn', { date: day(d.consent.on) })}</td>
                      <td className="px-3 py-2">{day(d.dueOn)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <p>{t('destroyExplain')}</p>
              <label className="flex items-start gap-2"><input type="checkbox" name="confirm" required className="mt-0.5" /><span>{t('confirm')}</span></label>
              <button type="submit" className="inline-flex h-9 items-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:bg-destructive/90">{t('destroy')}</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
