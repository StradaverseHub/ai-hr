import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Field, Input, btnGhost, btnPrimary } from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  AUTHORISATION_FILE_ACCEPT, AUTHORISATION_METHODS, CHECK_CANCEL_REASON_MAX, CHECK_OUTCOMES, CHECK_PROVIDER_MAX, CHECK_REFERENCE_MAX, CHECK_SUMMARY_MAX,
  REPORT_FILE_ACCEPT, type ApplicationBackgroundChecks, type BackgroundCheckOutcome, type BackgroundCheckView, type CheckStatus,
} from '@/packs/recruitment/service';
import {
  addBackgroundCheckAction, cancelBackgroundCheckAction, completeBackgroundCheckAction, recordBackgroundCheckAuthorisationAction, startBackgroundCheckAction,
} from '../../actions';
import { Pill, klDate, klDateTime, selectCls, textareaCls } from '../../shared';

const STATUS_TONE: Record<CheckStatus, 'neutral' | 'info' | 'warn' | 'good'> = {
  awaiting_authorisation: 'warn', in_progress: 'info', completed: 'good', cancelled: 'neutral',
};
const OUTCOME_TONE: Record<BackgroundCheckOutcome, 'good' | 'bad' | 'warn'> = { clear: 'good', concerns_found: 'bad', could_not_verify: 'warn' };
const fileCls = 'block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-sm';

/**
 * Slice 12 — an application's Background checks section. The job's recruiter, assistants and recruitment administrators: add a
 * check (from the Offer stage, or a stage named for background checks), record the candidate's authorisation first, start,
 * complete with an outcome and report, or cancel; every detail and file. The job's hiring managers: each check's types,
 * status, outcome and dates only (the service returns nothing else to them).
 */
export async function BackgroundChecksSection({ checks, here, locale, isAdmin }: { checks: ApplicationBackgroundChecks; here: string; locale: string; isAdmin: boolean }) {
  const t = await getTranslations('recruitment.checks');
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const base = () => <>{hidden('applicationId', checks.applicationId)}{hidden('returnTo', here)}</>;
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted-foreground">{checks.full ? t('purpose') : t('restrictedNote')}</p>
      {checks.full && checks.active && (
        !checks.stageAllowed ? <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">{t('stageNote')}</p>
          : checks.types.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
              {t('noTypes')}{isAdmin && <> <Link href="/recruitment/settings?section=checks" className="font-medium text-primary hover:underline">{t('noTypesLink')}</Link></>}
            </p>
          ) : (
            <details className="group rounded-xl border border-border bg-card p-4" open={checks.checks.length === 0}>
              <summary className="cursor-pointer text-sm font-semibold">{t('add')}</summary>
              <form action={addBackgroundCheckAction} className="mt-4 space-y-4">
                {base()}
                <fieldset className="space-y-1.5">
                  <legend className="text-xs font-medium text-muted-foreground">{t('types')} <span aria-hidden className="text-destructive">*</span></legend>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {checks.types.map((type) => (
                      <label key={type.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="typeIds" value={type.id} className="accent-primary" />{type.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('provider')} required requiredAriaLabel={t('required')}>
                    <Input name="provider" maxLength={CHECK_PROVIDER_MAX} required placeholder={t('providerHint')} />
                  </Field>
                  <Field label={t('reference')}><Input name="providerReference" maxLength={CHECK_REFERENCE_MAX} /></Field>
                </div>
                <p className="text-xs text-muted-foreground">{t('addNote')}</p>
                <button type="submit" className={btnPrimary}>{t('addButton')}</button>
              </form>
            </details>
          )
      )}
      {checks.checks.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('none')}</p>
      ) : (
        <ul className="space-y-3">
          {[...checks.checks].reverse().map((c) => <CheckCard key={c.id} check={c} base={base} locale={locale} t={t} />)}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t('noGate')}</p>
    </div>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<'recruitment.checks'>>>;

function CheckCard({ check: c, base, locale, t }: { check: BackgroundCheckView; base: () => ReactNode; locale: string; t: T }) {
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const r = c.restricted;
  const dates = [
    t('addedOn', { date: klDate(locale, c.createdAt) }),
    c.startedAt && t('startedOn', { date: klDate(locale, c.startedAt) }),
    c.completedAt && t('completedOn', { date: klDate(locale, c.completedAt) }),
    c.cancelledAt && t('cancelledOn', { date: klDate(locale, c.cancelledAt) }),
  ].filter(Boolean).join(' · ');
  return (
    <li id={`check-${c.id}`} className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{c.types.map((x) => x.name).join(', ') || t('untyped')}</p>
          <p className="text-xs text-muted-foreground">{dates}</p>
          {c.systemCancelled && <p className="text-xs text-muted-foreground">{t('systemCancelled')}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {c.overdue && <Pill tone="warn">{t('overdue')}</Pill>}
          <Pill tone={STATUS_TONE[c.status]}>{t(`status.${c.status}`)}</Pill>
          {c.outcome && <Pill tone={OUTCOME_TONE[c.outcome]}>{t(`outcome.${c.outcome}`)}</Pill>}
        </div>
      </div>
      {r && (
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">{t('provider')}</dt><dd>{[r.provider, r.providerReference].filter(Boolean).join(' · ') || '—'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('recordedBy')}</dt><dd>{r.recordedBy ?? t('unnamedUser')}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">{t('authorisation')}</dt><dd>{r.authorisation
            ? t('authorisationLine', { date: klDate(locale, `${r.authorisation.on}T00:00:00+08:00`), method: t(`method.${r.authorisation.method}`),
              by: r.authorisation.recordedBy ?? t('unnamedUser'), at: klDateTime(locale, r.authorisation.recordedAt) })
            : c.status === 'awaiting_authorisation' ? t('authorisationMissing') : '—'}</dd></div>
          {r.summary && <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">{t('summary')}</dt><dd className="whitespace-pre-wrap">{r.summary}</dd></div>}
          {r.cancelReason && <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">{t('cancelReason')}</dt><dd className="whitespace-pre-wrap">{r.cancelReason}</dd></div>}
          {r.files.length > 0 && (
            <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">{t('files')}</dt>
              <dd><ul className="space-y-1">{r.files.map((f) => (
                <li key={f.id}>
                  <a href={`/recruitment/background-check-files/${f.id}`} className="font-medium text-primary hover:underline">{f.fileName}</a>
                  <span className="text-xs text-muted-foreground"> · {t(`fileKind.${f.kind}`)} · {t('kb', { kb: Math.max(1, Math.round(f.sizeBytes / 1024)) })}</span>
                </li>
              ))}</ul></dd></div>
          )}
        </dl>
      )}
      {c.can.authorise && (
        <form action={recordBackgroundCheckAuthorisationAction} className="space-y-3 rounded-lg border border-border p-3">
          {base()}{hidden('checkId', c.id)}
          <h3 className="text-sm font-semibold">{t('authoriseTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('authoriseNote')}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('authorisedOn')} required requiredAriaLabel={t('required')}>
              <Input name="authorisedOn" type="date" max={todayInKualaLumpur()} defaultValue={todayInKualaLumpur()} required />
            </Field>
            <Field label={t('methodLabel')} required requiredAriaLabel={t('required')}>
              <select name="method" className={selectCls} required defaultValue="signed_form">
                {AUTHORISATION_METHODS.map((m) => <option key={m} value={m}>{t(`method.${m}`)}</option>)}
              </select>
            </Field>
            <Field label={t('reference')}><Input name="providerReference" maxLength={CHECK_REFERENCE_MAX} defaultValue={r?.providerReference ?? ''} /></Field>
            <Field label={t('authorisationFile')} className="sm:col-span-3">
              <input name="file" type="file" accept={AUTHORISATION_FILE_ACCEPT} className={fileCls} />
              <span className="text-xs text-muted-foreground">{t('authorisationFileRules')}</span>
            </Field>
          </div>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="filePermission" className="mt-0.5 accent-primary" /><span>{t('permission')}</span></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="start" defaultChecked className="accent-primary" />{t('startNow')}</label>
          <button type="submit" className={btnPrimary}>{t('authoriseButton')}</button>
        </form>
      )}
      {c.can.start && (
        <form action={startBackgroundCheckAction}>{base()}{hidden('checkId', c.id)}<button type="submit" className={btnPrimary}>{t('start')}</button></form>
      )}
      {c.can.complete && (
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-sm font-semibold">{t('completeTitle')}</summary>
          <form action={completeBackgroundCheckAction} className="mt-3 space-y-3">
            {base()}{hidden('checkId', c.id)}
            <fieldset className="space-y-1.5">
              <legend className="text-xs font-medium text-muted-foreground">{t('outcomeLabel')} <span aria-hidden className="text-destructive">*</span></legend>
              {CHECK_OUTCOMES.map((o) => (
                <label key={o} className="flex items-center gap-2 text-sm"><input type="radio" name="outcome" value={o} required className="accent-primary" />{t(`outcome.${o}`)}</label>
              ))}
            </fieldset>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t('summaryOptional')}</span>
              <textarea name="summary" rows={4} maxLength={CHECK_SUMMARY_MAX} className={textareaCls} />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('reference')}><Input name="providerReference" maxLength={CHECK_REFERENCE_MAX} defaultValue={r?.providerReference ?? ''} /></Field>
              <Field label={t('report')}>
                <input name="report" type="file" accept={REPORT_FILE_ACCEPT} className={fileCls} />
                <span className="text-xs text-muted-foreground">{t('reportRules')}</span>
              </Field>
            </div>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="reportPermission" className="mt-0.5 accent-primary" /><span>{t('permission')}</span></label>
            <p className="text-xs text-muted-foreground">{t('finalNote')}</p>
            <button type="submit" className={btnPrimary}>{t('completeButton')}</button>
          </form>
        </details>
      )}
      {c.can.cancel && (
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-sm font-semibold">{t('cancelTitle')}</summary>
          <form action={cancelBackgroundCheckAction} className="mt-3 space-y-3">
            {base()}{hidden('checkId', c.id)}
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t('cancelReason')} <span aria-hidden className="text-destructive">*</span></span>
              <textarea name="reason" rows={2} maxLength={CHECK_CANCEL_REASON_MAX} required className={textareaCls} />
            </label>
            <button type="submit" className={btnGhost}>{t('cancelButton')}</button>
          </form>
        </details>
      )}
    </li>
  );
}
