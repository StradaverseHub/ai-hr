import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { getMyOnboarding } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../_guard';
import { ProgressBar, fmt, fmtTime } from '../_ui';
import { acknowledgeAction } from '../actions';

/**
 * The new hire's own checklist. Read-only except the one Device Acceptance Acknowledgement. The data comes
 * from a fixed-allowlist database function: no identity number, bank details, cost centre, temporary
 * password, notes or staff names can reach this page (core/lifecycle-self.ts).
 */
export default async function MyOnboardingPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { s } = await lifecycleSession(0);
  const t = await getTranslations('lifecycle');
  const { error } = await searchParams;
  const me = await getMyOnboarding(s);
  if (!me) redirect('/lifecycle');
  const phases = Object.keys(me.phases).map(Number).sort((a, b) => a - b);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('me.title')} description={t('me.subtitle', { company: me.companyName })} back={{ href: '/lifecycle', label: t('title') }} />
      <ErrorBanner message={error} />
      <Card className="grid gap-3 p-4 text-sm sm:grid-cols-2">
        <div><span className="text-muted-foreground">{t('me.name')}</span><div className="font-medium">{me.fullName}</div></div>
        <div><span className="text-muted-foreground">{t('me.jobTitle')}</span><div>{me.jobTitle ?? '—'}</div></div>
        <div><span className="text-muted-foreground">{t('me.department')}</span><div>{me.department ?? '—'}</div></div>
        <div><span className="text-muted-foreground">{t('me.joinDate')}</span><div>{fmt(me.joinDate)}</div></div>
        <div><span className="text-muted-foreground">{t('me.supervisor')}</span><div>{me.supervisor ?? '—'}</div></div>
        <div><span className="text-muted-foreground">{t('me.hrContact')}</span><div>{me.gbsTa ?? '—'}</div></div>
        <div><span className="text-muted-foreground">{t('me.location')}</span><div>{me.floorBuilding ?? '—'}</div></div>
        <div><span className="text-muted-foreground">{t('me.progress')}</span><ProgressBar percent={me.progress.percent} label={t('me.progress')} /></div>
      </Card>

      {phases.map((p) => {
        const steps = me.steps.filter((x) => x.phase === p);
        if (steps.length === 0) return null;
        return (
          <Card key={p} className="overflow-hidden">
            <SectionHeader title={me.phases[p]!} />
            <ul className="divide-y divide-border text-sm">
              {steps.map((st) => (
                <li key={st.key} className="flex items-start justify-between gap-3 px-4 py-2.5">
                  <div className="flex items-start gap-2">
                    <span aria-hidden className={st.done ? 'text-emerald-600' : 'text-muted-foreground'}>{st.done ? '✓' : '○'}</span>
                    <span className={st.done ? 'text-muted-foreground line-through' : ''}>{st.label}</span>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{st.ownerTeam || '—'}</span>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}

      {me.acknowledgement.required && (
        <Card className="p-4">
          <h2 className="mb-1 text-sm font-semibold">{t('me.ackTitle')}</h2>
          {me.acknowledgement.submittedAt ? (
            <p className="text-sm text-emerald-700 dark:text-emerald-400">{t('me.ackDone', { when: fmtTime(me.acknowledgement.submittedAt) })}</p>
          ) : !me.acknowledgement.available ? (
            <p className="text-sm text-muted-foreground">{t('me.ackWaiting')}</p>
          ) : (
            <form action={acknowledgeAction} className="grid gap-3 sm:grid-cols-2">
              <p className="col-span-full text-xs text-muted-foreground">{t('me.ackHint')}</p>
              <Field label={t('me.company')}><input className={inputCls} value={me.companyName} readOnly /></Field>
              <Field label={t('me.employeeNo')}><input className={inputCls} value={me.employeeNo} readOnly /></Field>
              <Field label={t('me.contactNumber')} required><input name="contactNumber" required className={inputCls} /></Field>
              <Field label={t('me.pcType')}><input name="pcType" className={inputCls} placeholder={t('me.pcTypeHint')} /></Field>
              <Field label={t('me.serialNumber')} required><input name="serialNumber" required className={inputCls} /></Field>
              <Field label={t('me.accessories')}><input name="accessories" className={inputCls} /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="hasMonitor" className="size-4" />{t('me.hasMonitor')}</label>
              <Field label={t('me.monitorSerial')}><input name="monitorSerial" className={inputCls} /></Field>
              <Field label={t('me.receiptEmail')} className="col-span-full"><input name="receiptEmail" type="email" className={inputCls} /></Field>
              <label className="col-span-full flex items-start gap-2 text-sm"><input type="checkbox" name="acknowledged" required className="mt-0.5 size-4" />{t('me.acknowledge')}</label>
              <div className="col-span-full"><Button type="submit">{t('me.submitAck')}</Button></div>
            </form>
          )}
        </Card>
      )}
    </div>
  );
}
