import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { LEVEL, caseHistory, getCase, listComments, listMyCompanies, staffDirectory } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../../_guard';
import { Checklist, CommentsCard, HistoryCard, RequisitionCard } from '../../_case-parts';
import { ScopedFields } from '../../_scoped-fields';
import { LifecycleTabs, Pill, ProgressBar, fmt } from '../../_ui';
import { cancelCaseAction, outcomeAction, reopenCaseAction, updateCaseAction } from '../../actions';

export default async function OffboardingCasePage({ params, searchParams }: { params: Promise<{ number: string }>; searchParams: Promise<{ error?: string }> }) {
  const { s, level } = await lifecycleSession(LEVEL.agent);
  const t = await getTranslations('lifecycle');
  const { number } = await params;
  const { error } = await searchParams;
  let data;
  try { data = await getCase(s, 'offboarding', number); } catch { notFound(); }
  const c = data.case;
  const [history, comments, dir, companies] = await Promise.all([
    caseHistory(s, 'offboarding', number), listComments(s, 'offboarding', number), staffDirectory(s, c.companyId), listMyCompanies(s),
  ]);
  const names = new Map(dir.map((d) => [d.userId, d.name]));
  const manager = level >= LEVEL.manager; const admin = level >= LEVEL.admin;
  const open = c.status !== 'cancelled';
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={`${c.number} · ${c.fullName}`} back={{ href: '/lifecycle/offboarding', label: t('offboarding.title') }}
        description={`${c.jobTitle ?? ''}${c.department ? ` · ${c.department}` : ''}`}
        actions={<><Pill value={c.outcome} label={t(`outcome.${c.outcome}`)} /><Pill value={c.status} label={t(`status.${c.status}`)} /><ProgressBar percent={data.progress.percent} label={t('case.progress')} /></>} />
      <ErrorBanner message={error} />
      <LifecycleTabs level={level} active="offboarding" />

      <Card className="space-y-3 p-4 text-sm">
        <h2 className="font-semibold">{t('offboarding.outcome')}</h2>
        {c.outcome === 'pending' ? (
          open && (
            <form action={outcomeAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="number" value={c.number} />
              <span className="text-muted-foreground">{t('offboarding.recordOutcome')}</span>
              <Button type="submit" name="outcome" value="accepted" size="sm">{t('outcome.accepted')}</Button>
              <Button type="submit" name="outcome" value="rejected" size="sm" variant="outline">{t('outcome.rejected')}</Button>
            </form>
          )
        ) : (
          <>
            <p className="text-muted-foreground">{c.outcome === 'accepted' ? t('offboarding.acceptedExplain') : t('offboarding.rejectedExplain')}</p>
            {admin && open && (
              <form action={outcomeAction} className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
                <input type="hidden" name="number" value={c.number} />
                <Field label={t('common.reason')} required><input name="reason" required className={inputCls} /></Field>
                <Button type="submit" name="outcome" value={c.outcome === 'accepted' ? 'rejected' : 'accepted'} size="sm" variant="outline">{t('offboarding.changeTo', { outcome: t(`outcome.${c.outcome === 'accepted' ? 'rejected' : 'accepted'}`) })}</Button>
              </form>
            )}
            {!admin && <p className="text-xs text-muted-foreground">{t('offboarding.adminOnlyChange')}</p>}
          </>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <Checklist kind="offboarding" data={data} canUndo={manager} names={names} />
          <CommentsCard kind="offboarding" number={c.number} comments={comments} />
          <HistoryCard rows={history} />
        </div>
        <aside className="space-y-4">
          <Card className="space-y-1.5 p-4 text-sm">
            <h2 className="font-semibold">{t('case.details')}</h2>
            {([
              [t('case.employeeNo'), c.employeeNo], [t('offboarding.resignationDate'), fmt(c.resignationDate)], [t('offboarding.lastWorkingDay'), fmt(c.lastWorkingDay)],
              [t('case.supervisor'), c.supervisor ?? '—'], [t('case.gbsTa'), c.gbsTa ?? '—'], [t('offboarding.workLocation'), c.workLocation ?? '—'],
              [t('offboarding.balanceLeave'), c.balanceLeave ?? '—'], [t('offboarding.deviceName'), c.deviceName ?? '—'],
            ] as [string, string][]).map(([k, v]) => <div key={k}><span className="text-muted-foreground">{k}: </span>{v}</div>)}
            {data.customFields.map((f) => <div key={f.key}><span className="text-muted-foreground">{f.label}: </span>{String(c.custom[f.key] ?? '—')}</div>)}
          </Card>
          <RequisitionCard data={data} />
          <details className="rounded-lg border border-border bg-card">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">{t('case.edit')}</summary>
            <form action={updateCaseAction} className="grid gap-3 border-t border-border p-4">
              <input type="hidden" name="kind" value="offboarding" /><input type="hidden" name="number" value={c.number} />
              <Field label={t('case.name')}><input name="fullName" defaultValue={c.fullName} required className={inputCls} /></Field>
              <Field label={t('offboarding.resignationDate')}><input name="resignationDate" type="date" defaultValue={c.resignationDate ?? ''} required className={inputCls} /></Field>
              <Field label={t('offboarding.lastWorkingDay')}><input name="lastWorkingDay" type="date" defaultValue={c.lastWorkingDay ?? ''} className={inputCls} /></Field>
              <Field label={t('case.jobTitle')}><input name="jobTitle" defaultValue={c.jobTitle ?? ''} className={inputCls} /></Field>
              <Field label={t('case.department')}><input name="department" defaultValue={c.department ?? ''} className={inputCls} /></Field>
              <Field label={t('case.supervisor')}><input name="supervisor" defaultValue={c.supervisor ?? ''} className={inputCls} /></Field>
              <Field label={t('case.gbsTa')}><input name="gbsTa" defaultValue={c.gbsTa ?? ''} className={inputCls} /></Field>
              <Field label={t('offboarding.workLocation')}><input name="workLocation" defaultValue={c.workLocation ?? ''} className={inputCls} /></Field>
              <Field label={t('offboarding.balanceLeave')}><input name="balanceLeave" type="number" step="0.5" defaultValue={c.balanceLeave ?? ''} className={inputCls} /></Field>
              <Field label={t('offboarding.deviceName')}><input name="deviceName" defaultValue={c.deviceName ?? ''} className={inputCls} /></Field>
              <ScopedFields companies={companies.filter((x) => x.id === c.companyId)} systems={{}} fields={data.customFields} defaultCompanyId={c.companyId} values={c.custom} showSystems={false} lockCompany />
              <Field label={t('common.notes')}><textarea name="notes" rows={2} defaultValue={c.notes ?? ''} className={`${inputCls} h-auto py-2`} /></Field>
              <Button type="submit" size="sm">{t('common.save')}</Button>
            </form>
          </details>
          {manager && c.status === 'in_progress' && (
            <form action={cancelCaseAction}>
              <input type="hidden" name="kind" value="offboarding" /><input type="hidden" name="number" value={c.number} />
              <ConfirmSubmit size="sm" variant="ghost" className="text-destructive hover:text-destructive" title={t('case.cancelTitle')} description={t('case.cancelDescription')} confirmLabel={t('case.cancel')}
                reasonField={{ name: 'reason', label: t('common.reason'), required: true }}>{t('case.cancel')}</ConfirmSubmit>
            </form>
          )}
          {manager && c.status === 'cancelled' && (
            <form action={reopenCaseAction}><input type="hidden" name="kind" value="offboarding" /><input type="hidden" name="number" value={c.number} /><Button type="submit" size="sm" variant="outline">{t('case.reopen')}</Button></form>
          )}
          {c.cancelReason && <p className="text-xs text-muted-foreground">{t('common.reason')}: {c.cancelReason}</p>}
        </aside>
      </div>
    </div>
  );
}
