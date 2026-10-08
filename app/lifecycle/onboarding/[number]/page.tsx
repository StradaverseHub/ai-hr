import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { LEVEL, caseHistory, getCase, getCompanyConfig, listComments, listMyCompanies, staffDirectory } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../../_guard';
import { Checklist, CommentsCard, HistoryCard, RequisitionCard } from '../../_case-parts';
import { ScopedFields } from '../../_scoped-fields';
import { LifecycleTabs, Pill, ProgressBar, fmt, yesNo } from '../../_ui';
import { cancelCaseAction, reopenCaseAction, updateCaseAction } from '../../actions';

export default async function OnboardingCasePage({ params, searchParams }: { params: Promise<{ number: string }>; searchParams: Promise<{ error?: string }> }) {
  const { s, level } = await lifecycleSession(LEVEL.agent);
  const t = await getTranslations('lifecycle');
  const { number } = await params;
  const { error } = await searchParams;
  let data;
  try { data = await getCase(s, 'onboarding', number); } catch { notFound(); }
  const c = data.case;
  const [history, comments, dir, cfg, companies] = await Promise.all([
    caseHistory(s, 'onboarding', number), listComments(s, 'onboarding', number), staffDirectory(s, c.companyId), getCompanyConfig(s, c.companyId), listMyCompanies(s),
  ]);
  const names = new Map(dir.map((d) => [d.userId, d.name]));
  const manager = level >= LEVEL.manager;
  const yes = t('common.yes'); const no = t('common.no');
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={`${c.number} · ${c.fullName}`} back={{ href: '/lifecycle/onboarding', label: t('onboarding.title') }}
        description={`${c.jobTitle ?? ''}${c.department ? ` · ${c.department}` : ''}`}
        actions={<><Pill value={c.status} label={t(`status.${c.status}`)} /><ProgressBar percent={data.progress.percent} label={t('case.progress')} /></>} />
      <ErrorBanner message={error} />
      <LifecycleTabs level={level} active="onboarding" />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <Checklist kind="onboarding" data={data} canUndo={manager} names={names} />
          <CommentsCard kind="onboarding" number={c.number} comments={comments} />
          <HistoryCard rows={history} />
        </div>
        <aside className="space-y-4">
          <Card className="space-y-1.5 p-4 text-sm">
            <h2 className="font-semibold">{t('case.details')}</h2>
            {([
              [t('case.employeeNo'), c.employeeNo], [t('case.joinDate'), fmt(c.joinDate)], [t('case.supervisor'), c.supervisor ?? '—'], [t('case.gbsTa'), c.gbsTa ?? '—'],
              [t('case.hireType'), t(`case.hireTypes.${c.hireType}`) + (c.replacedPerson ? ` (${c.replacedPerson})` : '')],
              [t('case.laptopRequired'), yesNo(c.laptopRequired, yes, no)], [t('case.carparkRequired'), yesNo(c.carparkRequired, yes, no)],
              [t('case.floorBuilding'), c.floorBuilding ?? '—'], [t('case.accessSystems'), c.accessSystems.join(', ') || '—'],
              [t('case.newhireEmail'), c.newhireEmail ?? '—'], [t('case.costCentre'), c.costCentre ?? '—'], [t('case.idNumber'), c.nricPassport ?? '—'],
            ] as [string, string][]).map(([k, v]) => <div key={k}><span className="text-muted-foreground">{k}: </span>{v}</div>)}
            {data.customFields.map((f) => <div key={f.key}><span className="text-muted-foreground">{f.label}: </span>{String(c.custom[f.key] ?? '—')}</div>)}
            <div className="pt-1 text-xs text-muted-foreground">{c.newhireEmail ? t('case.accountLinkedHint') : t('case.noEmailHint')}</div>
          </Card>

          <RequisitionCard data={data} />

          {c.laptopRequired && (
            <Card className="space-y-1 p-4 text-sm">
              <h2 className="font-semibold">{t('case.acknowledgement')}</h2>
              <p className="text-muted-foreground">{data.daa.submittedAt ? t('case.ackDone', { when: fmt(data.daa.submittedAt) }) : t('case.ackPending')}</p>
            </Card>
          )}

          <details className="rounded-lg border border-border bg-card">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">{t('case.edit')}</summary>
            <form action={updateCaseAction} className="grid gap-3 border-t border-border p-4">
              <input type="hidden" name="kind" value="onboarding" /><input type="hidden" name="number" value={c.number} />
              <Field label={t('case.name')}><input name="fullName" defaultValue={c.fullName} required className={inputCls} /></Field>
              <Field label={t('case.joinDate')}><input name="joinDate" type="date" defaultValue={c.joinDate ?? ''} required className={inputCls} /></Field>
              <Field label={t('case.jobTitle')}><input name="jobTitle" defaultValue={c.jobTitle ?? ''} className={inputCls} /></Field>
              <Field label={t('case.department')}><input name="department" defaultValue={c.department ?? ''} className={inputCls} /></Field>
              <Field label={t('case.supervisor')}><input name="supervisor" defaultValue={c.supervisor ?? ''} className={inputCls} /></Field>
              <Field label={t('case.gbsTa')}><input name="gbsTa" defaultValue={c.gbsTa ?? ''} className={inputCls} /></Field>
              <Field label={t('case.hireType')}><select name="hireType" defaultValue={c.hireType} className={inputCls}><option value="new_hire">{t('case.hireTypes.new_hire')}</option><option value="replacement">{t('case.hireTypes.replacement')}</option></select></Field>
              <Field label={t('case.replacedPerson')}><input name="replacedPerson" defaultValue={c.replacedPerson ?? ''} className={inputCls} /></Field>
              <Field label={t('case.newhireEmail')}><input name="newhireEmail" type="email" defaultValue={c.newhireEmail ?? ''} className={inputCls} /></Field>
              <Field label={t('case.itOwner')}>
                <select name="itOwnerUserId" defaultValue={c.itOwnerUserId ?? ''} className={inputCls}><option value="">—</option>{dir.map((u) => <option key={u.userId} value={u.userId}>{u.name}</option>)}</select>
              </Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="laptopRequired" defaultChecked={c.laptopRequired} className="size-4" />{t('case.laptopRequired')}</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="carparkRequired" defaultChecked={c.carparkRequired} className="size-4" />{t('case.carparkRequired')}</label>
              <Field label={t('case.deviceType')}><input name="deviceType" defaultValue={c.deviceType ?? ''} className={inputCls} /></Field>
              <Field label={t('case.floorBuilding')}><input name="floorBuilding" defaultValue={c.floorBuilding ?? ''} className={inputCls} /></Field>
              <Field label={t('case.costCentre')}><input name="costCentre" defaultValue={c.costCentre ?? ''} className={inputCls} /></Field>
              <Field label={t('case.idNumber')}><input name="nricPassport" defaultValue={c.nricPassport ?? ''} autoComplete="off" className={inputCls} /></Field>
              <ScopedFields companies={companies.filter((x) => x.id === c.companyId)} systems={{ [c.companyId]: cfg.accessSystems }} fields={data.customFields} defaultCompanyId={c.companyId}
                selectedSystems={c.accessSystems} values={c.custom} showSystems lockCompany />
              <Field label={t('common.notes')}><textarea name="notes" rows={2} defaultValue={c.notes ?? ''} className={`${inputCls} h-auto py-2`} /></Field>
              <Button type="submit" size="sm">{t('common.save')}</Button>
            </form>
          </details>

          {manager && c.status === 'in_progress' && (
            <form action={cancelCaseAction}>
              <input type="hidden" name="kind" value="onboarding" /><input type="hidden" name="number" value={c.number} />
              <ConfirmSubmit size="sm" variant="ghost" className="text-destructive hover:text-destructive" title={t('case.cancelTitle')} description={t('case.cancelDescription')} confirmLabel={t('case.cancel')}
                reasonField={{ name: 'reason', label: t('common.reason'), required: true }}>{t('case.cancel')}</ConfirmSubmit>
            </form>
          )}
          {manager && c.status === 'cancelled' && (
            <form action={reopenCaseAction}><input type="hidden" name="kind" value="onboarding" /><input type="hidden" name="number" value={c.number} /><Button type="submit" size="sm" variant="outline">{t('case.reopen')}</Button></form>
          )}
          {c.cancelReason && <p className="text-xs text-muted-foreground">{t('common.reason')}: {c.cancelReason}</p>}
          <Link href="/lifecycle/onboarding" className="text-xs text-muted-foreground hover:text-foreground">← {t('onboarding.title')}</Link>
        </aside>
      </div>
    </div>
  );
}
