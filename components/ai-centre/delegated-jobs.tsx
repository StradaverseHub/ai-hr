import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Ban } from 'lucide-react';
import { PageHeader } from '@/components/ui';

/** ADR-0170 §3.10 mandates, called "Delegated jobs" on screen because "delegation" already names approval
 * cover (/delegations). By default nothing is delegated, and on this build no job type exists yet (the
 * mandate store is on a later step), so the page says exactly that and lists what can never be delegated.
 * It reads nothing: there is no per-person state to show until mandates exist. */
export async function AiCentreDelegatedJobs() {
  const t = await getTranslations('aiCentre.jobs');
  const never = ['pay', 'payroll', 'employment', 'access', 'irreversible', 'own'] as const;
  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <p className="max-w-3xl text-sm"><strong className="font-semibold">{t('leadStrong')}</strong> {t('lead')}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <section aria-labelledby="jobs-none" className="rounded-xl border border-dashed border-border p-5">
          <h2 id="jobs-none" className="text-sm font-semibold">{t('none')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('noneHelp')}</p>
        </section>
        <section aria-labelledby="jobs-never" className="rounded-xl border border-border bg-card p-5">
          <h2 id="jobs-never" className="text-sm font-semibold">{t('neverTitle')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('neverHelp')}</p>
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {never.map(key => <li key={key} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground"><Ban aria-hidden className="size-3.5" />{t(`never.${key}`)}</li>)}
          </ul>
        </section>
      </div>
      <p className="text-sm text-muted-foreground">{t('approvalCover')} <Link href="/delegations" className="font-medium text-primary hover:underline">{t('approvalCoverLink')}</Link></p>
    </div>
  );
}
