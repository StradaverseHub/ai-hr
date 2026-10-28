import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { canConfigurePeopleGeneral, getPeopleGeneral } from '@/core/people-general';
import { Card, ErrorBanner, PageHeader, btnPrimary, btnGhost } from '@/components/ui';
import { savePeopleGeneralAction } from './actions';

export default async function PeopleGeneralPage({ searchParams }: {
  searchParams: Promise<{ error?: string; toast?: string }>;
}) {
  const s = await requireAdmin();
  if (!await canConfigurePeopleGeneral(s)) redirect('/');
  const policy = await getPeopleGeneral(s);
  const t = await getTranslations('peopleGeneral');
  const { error } = await searchParams;
  return <div className="mx-auto max-w-3xl space-y-6">
    <PageHeader title={t('title')} description={t('description')} />
    <ErrorBanner message={error} />
    <Card className="p-5 sm:p-6">
      <h2 className="mb-6 text-base font-semibold">{t('identityValidation')}</h2>
      <form action={savePeopleGeneralAction} className="space-y-5">
        <input type="hidden" name="revision" value={policy.revision ?? ''} />
        <label className="flex cursor-pointer items-start justify-between gap-5">
          <span className="space-y-1"><span className="block text-sm font-semibold">{t('allowDuplicatedNric')}</span>
            <span id="nric-policy-hint" className="block text-sm text-muted-foreground">{t('toggleHint')}</span></span>
          <span className="relative mt-0.5 inline-flex shrink-0">
            <input type="checkbox" role="switch" name="allowDuplicatedNric" value="true"
              defaultChecked={policy.allowDuplicatedNric} aria-describedby="nric-policy-hint"
              className="peer sr-only" />
            <span aria-hidden="true" className="h-6 w-11 rounded-full bg-muted-foreground/50 peer-checked:bg-primary peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring" />
            <span aria-hidden="true" className="pointer-events-none absolute left-1 top-1 size-4 rounded-full bg-white peer-checked:translate-x-5" />
          </span>
        </label>
        <p className="text-sm font-medium">{t('currentSetting', { state: t(policy.allowDuplicatedNric ? 'on' : 'off') })}</p>
        <p className="text-sm text-muted-foreground">{t(policy.allowDuplicatedNric ? 'onExplanation' : 'offExplanation')}</p>
        {/* 5e0b2154 — the email switch; same form, revision and save as the NRIC switch. */}
        <label className="flex cursor-pointer items-start justify-between gap-5 border-t border-border pt-5">
          <span className="space-y-1"><span className="block text-sm font-semibold">{t('allowDuplicatedEmail')}</span>
            <span id="email-policy-hint" className="block text-sm text-muted-foreground">{t('emailToggleHint')}</span></span>
          <span className="relative mt-0.5 inline-flex shrink-0">
            <input type="checkbox" role="switch" name="allowDuplicatedEmail" value="true"
              defaultChecked={policy.allowDuplicatedEmail} aria-describedby="email-policy-hint"
              className="peer sr-only" />
            <span aria-hidden="true" className="h-6 w-11 rounded-full bg-muted-foreground/50 peer-checked:bg-primary peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring" />
            <span aria-hidden="true" className="pointer-events-none absolute left-1 top-1 size-4 rounded-full bg-white peer-checked:translate-x-5" />
          </span>
        </label>
        <p className="text-sm font-medium">{t('currentSetting', { state: t(policy.allowDuplicatedEmail ? 'on' : 'off') })}</p>
        <p className="text-sm text-muted-foreground">{t(policy.allowDuplicatedEmail ? 'emailOnExplanation' : 'emailOffExplanation')}</p>
        <p className="text-sm text-muted-foreground">{t('emailLoginNote')}</p>
        <p className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">{t('preserveExisting')}</p>
        <p className="text-xs text-muted-foreground">{t('authority')}</p>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
          <p className="text-xs text-muted-foreground">{t('saveHint')}</p>
          <div className="flex gap-2"><button type="reset" className={btnGhost}>{t('cancel')}</button>
            <button type="submit" className={btnPrimary}>{t('save')}</button></div>
        </div>
      </form>
    </Card>
  </div>;
}
