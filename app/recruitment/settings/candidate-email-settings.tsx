import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnGhost, btnPrimary } from '@/components/ui';
import {
  CANDIDATE_EMAIL_BODY_MAX, CANDIDATE_EMAIL_KINDS, CANDIDATE_EMAIL_LOCALES, CANDIDATE_EMAIL_SENDER_NAME_MAX, CANDIDATE_EMAIL_SUBJECT_MAX, candidateEmailSettings,
} from '@/packs/recruitment/service';
import { localeNames, type Locale } from '@/i18n/config';
import { resetCandidateEmailTemplateAction, saveCandidateEmailSettingsFormAction, saveCandidateEmailTemplateFormAction } from '../actions';
import { ActionForm, FieldProblem } from '../action-form';
import { Pill, klDateTime, selectCls } from '../shared';

/**
 * Settings › Candidate e-mail (slice 19, administrators; D-063): the company's switch, sender display name, reply-to and the language
 * of its candidate e-mails, and the wording of each kind in one chosen language at a time (default wording until the company changes
 * it). On an installation without the embedded relay the page says candidate e-mail is unavailable and the switch cannot be turned
 * on. Each form keeps what was typed when a save is refused (an unknown placeholder, a link, a missing reply-to).
 */
export async function CandidateEmailSettingsSection({ s, companyId, lang }: { s: SessionContext; companyId: string; lang?: string }) {
  const [t, locale, view] = await Promise.all([getTranslations('recruitment.candidateEmail'), getLocale(), candidateEmailSettings(s, companyId)]);
  const shown = (CANDIDATE_EMAIL_LOCALES as readonly string[]).includes(lang ?? '') ? lang as (typeof CANDIDATE_EMAIL_LOCALES)[number] : view.locale;
  const problem = { required: t('fieldRequired'), invalid: t('fieldInvalid') };
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  return (
    <div className="space-y-6">
      <div className="max-w-3xl space-y-2 text-sm text-muted-foreground">
        <p>{t('settingsNote')}</p>
        {!view.available && <p role="note" className="rounded-lg border border-destructive/40 bg-muted/40 px-3 py-2 text-foreground">{t('unavailable')}</p>}
        <p className="text-xs">{t('dataNote')}</p>
      </div>

      <section aria-labelledby="email-sender-title" className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="email-sender-title" className="font-medium">{t('enabled')}</h2>
          {view.updatedAt && <span className="text-xs text-muted-foreground">{t('changed', { by: view.updatedBy ?? t('unnamedUser'), at: klDateTime(locale, view.updatedAt) })}</span>}
        </div>
        <ActionForm action={saveCandidateEmailSettingsFormAction} className="grid gap-3 sm:grid-cols-2">
          {hidden('companyId', companyId)}{hidden('lang', shown)}
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="enabled" defaultChecked={view.enabled} disabled={!view.available && !view.enabled} />
            {t('enabled')}
          </label>
          <Field label={t('senderName', { max: CANDIDATE_EMAIL_SENDER_NAME_MAX })}>
            <Input name="senderName" maxLength={CANDIDATE_EMAIL_SENDER_NAME_MAX} defaultValue={view.senderName ?? ''} placeholder={view.defaultSenderName} />
            <span className="text-xs text-muted-foreground">{t('senderNameHint', { name: view.defaultSenderName })}</span>
            <FieldProblem name="senderName" required={t('senderNameRequired')} invalid={t('senderNameInvalid', { max: CANDIDATE_EMAIL_SENDER_NAME_MAX })} />
          </Field>
          <Field label={t('replyTo')}>
            <Input name="replyTo" type="email" maxLength={254} defaultValue={view.replyTo ?? ''} />
            <span className="text-xs text-muted-foreground">{t('replyToHint')}</span>
            <FieldProblem name="replyTo" {...problem} />
          </Field>
          <Field label={t('locale')}>
            <select name="locale" defaultValue={view.locale} className={selectCls}>
              {CANDIDATE_EMAIL_LOCALES.map((l) => <option key={l} value={l}>{localeNames[l as Locale]}</option>)}
            </select>
            <span className="text-xs text-muted-foreground">{t('localeHint')}</span>
          </Field>
          <div className="flex items-end"><button type="submit" className={btnPrimary}>{t('save')}</button></div>
        </ActionForm>
        <div>
          <h3 className="text-xs font-medium text-muted-foreground">{t('countsTitle')}</h3>
          <p className="mt-1 flex flex-wrap gap-2 text-sm">
            {(['queued', 'sending', 'sent', 'failed', 'uncertain'] as const).map((k) => (
              <Pill key={k} tone={k === 'failed' ? 'bad' : k === 'uncertain' ? 'warn' : undefined}>{t(`states.${k}`)}: {view.counts[k]}</Pill>
            ))}
          </p>
        </div>
      </section>

      <section aria-labelledby="email-templates-title" className="space-y-3">
        <div className="max-w-3xl">
          <h2 id="email-templates-title" className="text-base font-semibold">{t('templatesTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('templatesNote')}</p>
        </div>
        <form method="get" className="flex flex-wrap items-end gap-2">
          {hidden('company', companyId)}{hidden('section', 'email')}
          <Field label={t('templateLanguage')} className="min-w-48">
            <select name="lang" defaultValue={shown} className={selectCls}>
              {CANDIDATE_EMAIL_LOCALES.map((l) => <option key={l} value={l}>{localeNames[l as Locale]}</option>)}
            </select>
          </Field>
          <button type="submit" className={btnGhost}>{t('showLanguage')}</button>
        </form>
        <ul className="space-y-3">
          {CANDIDATE_EMAIL_KINDS.map((kind) => {
            const row = view.templates.find((x) => x.kind === kind && x.locale === shown)!;
            const current = row.override ?? row.default;
            return (
              <li key={kind} className="space-y-3 rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-medium">{t(`kinds.${kind}`)}</h3>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Pill tone={row.override ? 'warn' : undefined}>{row.override ? t('customised') : t('usingDefault')}</Pill>
                    {row.override && row.updatedAt && t('changed', { by: row.updatedBy ?? t('unnamedUser'), at: klDateTime(locale, row.updatedAt) })}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{t(`kindNotes.${kind}`)}</p>
                <p className="text-xs text-muted-foreground">{t('placeholders', { list: view.placeholders[kind].map((p) => `{${p}}`).join(' ') })}</p>
                <ActionForm action={saveCandidateEmailTemplateFormAction} className="space-y-3">
                  {hidden('companyId', companyId)}{hidden('kind', kind)}{hidden('locale', shown)}{hidden('lang', shown)}
                  <Field label={t('subject', { max: CANDIDATE_EMAIL_SUBJECT_MAX })} required requiredAriaLabel={t('fieldRequired')}>
                    <Input name="subject" required maxLength={CANDIDATE_EMAIL_SUBJECT_MAX} defaultValue={current.subject} />
                    <FieldProblem name="subject" {...problem} />
                  </Field>
                  <Field label={t('body', { max: CANDIDATE_EMAIL_BODY_MAX })} required requiredAriaLabel={t('fieldRequired')}>
                    <textarea name="body" required maxLength={CANDIDATE_EMAIL_BODY_MAX} rows={10} defaultValue={current.body}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
                    <FieldProblem name="body" {...problem} />
                  </Field>
                  <button type="submit" className={btnPrimary}>{t('saveTemplate')}</button>
                </ActionForm>
                {row.override && (
                  <form action={resetCandidateEmailTemplateAction}>
                    {hidden('companyId', companyId)}{hidden('kind', kind)}{hidden('locale', shown)}{hidden('lang', shown)}
                    <button type="submit" className={btnGhost}>{t('resetTemplate')}</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
