import { RewardSubmit } from '@/app/rewards/submit-button';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { listRewardUnits, rewardSetupChoices } from '@/packs/rewards/service';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls, tableWrapCls, theadCls, thCls, tbodyCls } from '@/components/ui';
import { createRewardAction } from '@/app/rewards/actions';

export default async function RewardsConfigurationPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireModule('rewards'); const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('rewards'); const { error } = await searchParams;
  const choices = await rewardSetupChoices(s, scopeIds);
  const units = await listRewardUnits(s, choices.companies.map(c => c.id));
  const today = todayInKualaLumpur();
  return <div className="w-full space-y-6">
    <div data-tour="rewards-configuration"><PageHeader title={t('adminTitle')} description={t('adminDescription')} /></div>
    <Link href="/rewards" className="text-sm text-primary hover:underline">{t('openReviews')}</Link>
    <ErrorBanner message={error} />
    <div data-tour="rewards-admin-units" className={tableWrapCls}><table className="w-full text-sm"><thead className={theadCls}><tr>{['cycle', 'company', 'unit', 'stage', 'action'].map(k => <th key={k} className={thCls}>{t(k)}</th>)}</tr></thead>
      <tbody className={tbodyCls}>{units.map(u => <tr key={u.id}><td className="px-3 py-3 font-medium">{u.cycle} · {t(`kinds.${u.kind}`)}<span className="ml-2 text-muted-foreground">{u.year}</span></td><td className="px-3 py-3">{u.company}</td><td className="px-3 py-3">{u.unit}</td><td className="px-3 py-3">{t(`stages.${u.status}`)}</td><td className="px-3 py-3"><Link className="font-medium text-primary hover:underline" href={`/admin/rewards/${u.id}`}>{t('configure')}</Link></td></tr>)}</tbody>
    </table>{!units.length && <p className="max-w-2xl px-5 py-10 text-sm text-muted-foreground">{t('adminEmpty')}</p>}</div>
    {choices.companies.length > 0 && <Card><SectionHeader title={t('createUnit')} /><form action={createRewardAction} className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
      <Field label={t('cycle')}><input name="name" required maxLength={160} className={inputCls} placeholder={t('cyclePlaceholder')} /></Field>
      <Field label={t('existingCycle')}><select name="cycleId" className={inputCls}><option value="">{t('newCycle')}</option>{choices.cycles.map(c => <option key={c.id} value={c.id}>{c.name} ({c.year})</option>)}</select></Field>
      <Field label={t('year')}><input name="year" type="number" min={2000} max={2200} required defaultValue={Number(today.slice(0, 4))} className={inputCls} /></Field>
      <Field label={t('company')}><select name="companyId" required className={inputCls}>{choices.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <Field label={t('unit')}><select name="businessUnitId" required className={inputCls}>{choices.units.map(u => <option key={u.id} value={u.id}>{u.name} ({choices.companies.find(c => c.id === u.companyId)?.name ?? t('shared')})</option>)}</select></Field>
      <Field label={t('snapshotDate')}><input name="snapshotDate" type="date" max={today} required defaultValue={today} className={inputCls} /></Field>
      <p className="max-w-3xl text-sm text-muted-foreground sm:col-span-2 lg:col-span-3">{t('createHelp')}</p>
      <RewardSubmit type="submit" className="w-fit">{t('createUnit')}</RewardSubmit>
    </form></Card>}
  </div>;
}
