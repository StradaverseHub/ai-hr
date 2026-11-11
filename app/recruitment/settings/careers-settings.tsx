import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnGhost, btnPrimary } from '@/components/ui';
import {
  careersSettings, CAREERS_CLIENT_HOURLY_LIMIT, CAREERS_COMPANY_DAILY_LIMIT, CAREERS_DISPLAY_NAME_MAX, CAREERS_HEADLINE_MAX, CAREERS_INTRODUCTION_MAX,
  CAREERS_NOTICE_MAX,
} from '@/packs/recruitment/service';
import { setCareersPublishedAction, updateCareersSettingsAction } from '../actions';
import { klDateTime } from '../shared';

const areaCls = 'w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';

/**
 * Settings › Careers page (slice 8, administrators): the company's one public careers page — its address, display name,
 * headline, introduction and privacy notice — the Publish switch, which names what is still missing, and the notice's
 * version history (each version kept unchanged, with who saved it and when). Which jobs appear is set on each job.
 */
export async function CareersSettingsSection({ s, companyId, here }: { s: SessionContext; companyId: string; here: string }) {
  const [t, locale, settings] = await Promise.all([getTranslations('recruitment.settings.careers'), getLocale(), careersSettings(s, companyId)]);
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const path = settings.address ? `/careers/${settings.address}` : null;
  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-labelledby="careers-publish-title">
        <div>
          <h2 id="careers-publish-title" className="text-base font-semibold">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('note')}</p>
        </div>
        <p className="text-sm font-medium" role="status">{settings.published ? t('statusPublished') : t('statusDraft')}</p>
        {!settings.acceptingApplications && (
          <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground" role="note">{t('notAccepting')}</p>
        )}
        {!settings.published && settings.missing.length > 0 && (
          <div className="text-sm">
            <p>{t('missingTitle')}</p>
            <ul className="list-disc pl-5">{settings.missing.map((m) => <li key={m}>{t(`missing.${m}`)}</li>)}</ul>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <form action={setCareersPublishedAction}>
            {hidden('companyId', companyId)}{hidden('returnTo', here)}{hidden('published', settings.published ? '' : 'on')}
            <button type="submit" className={settings.published ? btnGhost : btnPrimary} disabled={!settings.published && settings.missing.length > 0}>
              {settings.published ? t('withdraw') : t('publish')}
            </button>
          </form>
          {settings.published && path && <a href={path} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline">{t('open')}</a>}
        </div>
        <p className="text-xs text-muted-foreground">{t('limits', { hour: CAREERS_CLIENT_HOURLY_LIMIT, day: CAREERS_COMPANY_DAILY_LIMIT })}</p>
      </section>

      <form action={updateCareersSettingsAction} className="space-y-4 rounded-xl border border-border bg-card p-4" aria-labelledby="careers-content-title">
        {hidden('companyId', companyId)}{hidden('returnTo', here)}
        <h2 id="careers-content-title" className="text-base font-semibold">{t('contentTitle')}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('address')}>
            <Input name="address" defaultValue={settings.address ?? ''} minLength={3} maxLength={40} pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?" autoComplete="off" />
          </Field>
          <Field label={t('displayName')}>
            <Input name="displayName" defaultValue={settings.displayName ?? ''} maxLength={CAREERS_DISPLAY_NAME_MAX} />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">{t('addressHelp', { path: path ?? '/careers/…' })}</p>
        <Field label={t('headline')}><Input name="headline" defaultValue={settings.headline ?? ''} maxLength={CAREERS_HEADLINE_MAX} /></Field>
        <Field label={t('introduction')}>
          <textarea name="introduction" defaultValue={settings.introduction ?? ''} maxLength={CAREERS_INTRODUCTION_MAX} rows={5} className={areaCls} />
        </Field>
        <Field label={t('notice')}>
          <textarea name="notice" defaultValue={settings.notice?.body ?? ''} maxLength={CAREERS_NOTICE_MAX} rows={10} className={areaCls} />
        </Field>
        <p className="text-xs text-muted-foreground">{t('noticeHelp')}</p>
        <button type="submit" className={btnPrimary}>{t('save')}</button>
        {settings.updatedAt && <p className="text-xs text-muted-foreground">{t('changed', { by: settings.updatedBy ?? t('unnamedUser'), at: klDateTime(locale, settings.updatedAt) })}</p>}
      </form>

      <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-labelledby="careers-versions-title">
        <h2 id="careers-versions-title" className="text-base font-semibold">{t('versionsTitle')}</h2>
        {settings.versions.length === 0 ? <p className="text-sm text-muted-foreground">{t('versionsEmpty')}</p> : (
          <ul className="space-y-2">
            {settings.versions.map((v, i) => (
              <li key={v.version} className="rounded-lg border border-border p-3 text-sm">
                <details>
                  <summary className="cursor-pointer">
                    <span className="font-medium">{t('version', { version: v.version })}</span>
                    {i === 0 && <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs">{t('current')}</span>}
                    <span className="ml-2 text-xs text-muted-foreground">{t('versionBy', { by: v.createdBy ?? t('unnamedUser'), at: klDateTime(locale, v.createdAt) })}</span>
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap">{v.body}</p>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
