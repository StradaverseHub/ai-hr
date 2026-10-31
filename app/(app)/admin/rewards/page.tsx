import {rewardPolicyMemberships} from '@/packs/rewards/service';
import {RewardReviewActions} from './review-actions';
import {RewardReviewCreateForm} from './create-review-form';
import Link from 'next/link';
import { RewardsAdminTabs } from './admin-tabs';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { listRewardUnits, rewardCoverageForUnits, rewardDueWording, rewardSetupChoices,rewardSharedPolicyChoices } from '@/packs/rewards/service';
import { Badge, Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls, tableWrapCls, theadCls, thCls, tbodyCls } from '@/components/ui';

type Filters = { cycle?: string; company?: string; unit?: string; stage?: string };
/** Calendar dates are ISO days; show them as a day, never shifted by the viewer's time zone. */
const day = (locale: string, iso: string) => new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));


export default async function RewardsConfigurationPage({ searchParams }: { searchParams: Promise<{ error?: string;sharedError?:string; deleted?:string; deletionError?:string; cancelled?: string } & Filters> }) {
  await requireModule('rewards'); const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('rewards'); const { error,sharedError,deleted,deletionError,cancelled,...filter } = await searchParams;
  const td=await getTranslations('rewardsDeletion'),tc=await getTranslations('rewardsConfig'),locale=await getLocale();
  const choices = await rewardSetupChoices(s, scopeIds);
  const memberships=await rewardPolicyMemberships(s,choices.companies.map(c=>c.id));
  const all = await listRewardUnits(s, choices.companies.map(c => c.id));
  // Filters narrow the server-rendered list; options come from the reviews the viewer can already see.
  const units = all.filter(u => (!filter.cycle || u.cycleId === filter.cycle) && (!filter.company || u.companyId === filter.company) && (!filter.unit || u.businessUnitId === filter.unit) && (!filter.stage || u.status === filter.stage));
  const options = (pick: (u: typeof all[number]) => [string, string]) => [...new Map(all.map(pick)).entries()];
  const filters = [['cycle', options(u => [u.cycleId, `${u.cycle} (${u.year})`])], ['company', options(u => [u.companyId, u.company])], ['unit', options(u => [u.businessUnitId, u.unit])], ['stage', options(u => [u.status, t(`stages.${u.status}`)])]] as const;
  // cd72f915 — open reviews only: a finished review needs no further seat holders.
  const coverage = new Map((await rewardCoverageForUnits(s, units.filter(u => !['posted', 'withdrawn', 'rejected'].includes(u.status)).map(u => u.id))).map(c => [c.unitId, c.missing.length]));
  const ta = await getTranslations('rewardsAccess');
  const today = todayInKualaLumpur();
  const shared=await rewardSharedPolicyChoices(s,choices.companies.map(c=>c.id));
  return <div className="w-full space-y-6">
    <div data-tour="rewards-configuration"><PageHeader title={t('adminTitle')} description={t('adminDescription')} /></div>
    <RewardsAdminTabs current="configuration"/>
    <ErrorBanner message={error} />
    <ErrorBanner message={deletionError?td('error'):undefined}/>
    {deleted==='1'&&<p role="status" className="rounded-md border p-3 text-sm">{td('saved')}</p>}
    {cancelled==='1'&&<p role="status" className="rounded-md border p-3 text-sm">{tc('actions.cancelledSaved')}</p>}
    <ErrorBanner message={['invalid','changed','scope','system'].includes(sharedError??'')?t(`sharedPolicy.errors.${sharedError as 'invalid'|'changed'|'scope'|'system'}`):undefined}/>
    {all.length>0&&<form method="get" className="flex flex-wrap items-end gap-3" aria-label={tc('filters.label')}>
      {filters.map(([key, values]) => <Field key={key} label={tc(`filters.${key}`)}><select name={key} defaultValue={filter[key] ?? ''} className={inputCls}><option value="">{tc('filters.all')}</option>{values.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>)}
      <Button type="submit" variant="secondary">{tc('filters.apply')}</Button>
      {Object.values(filter).some(Boolean)&&<Link href="/admin/rewards" className="pb-2 text-sm text-primary hover:underline">{tc('filters.clear')}</Link>}
    </form>}
    <div data-tour="rewards-admin-units" className={tableWrapCls}><table className="w-full text-sm"><thead className={theadCls}><tr>{(['cycle', 'companyUnit', 'people', 'stage', 'due', 'dataCheck', 'action'] as const).map(k => <th key={k} className={thCls}>{tc(`columns.${k}`)}</th>)}</tr></thead>
      <tbody className={tbodyCls}>{units.map(u => <tr key={u.id} className="align-top">
        <td className="px-3 py-3"><div className="font-medium">{u.cycle}{u.kind !== 'annual' && <> · {t(`kinds.${u.kind}`)}</>}</div><div className="text-xs text-muted-foreground">{u.effectiveFrom ? tc('subline', { year: u.year, date: day(locale, u.effectiveFrom) }) : tc('sublineYear', { year: u.year })}</div>{u.policyOrigin && <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">{tc('shared.originLine', { name: u.policyOrigin.name, version: u.policyOrigin.revision })}{u.policyOrigin.changed && <Badge variant="info" className="normal-case">{tc('shared.changedInReview')}</Badge>}</div>}</td>
        <td className="px-3 py-3"><div>{u.company}</div><div className="text-xs text-muted-foreground">{u.unit}</div></td>
        <td className="px-3 py-3 tabular-nums">{u.people ?? tc('notAvailable')}</td>
        <td className="px-3 py-3"><div>{u.kind === 'annual' && u.status === 'withdrawn' ? tc('cancelled') : t(`stages.${u.status}`)}</div>{!!coverage.get(u.id) && <Badge variant="warning" className="mt-1 normal-case">{ta('rolesMissing', { count: coverage.get(u.id)! })}</Badge>}{u.seat && <div className="text-xs text-muted-foreground">{u.holders.length ? tc('with', { seat: t(`roles.${u.seat}`), names: u.holders.map(n => n ?? t('assignedUser')).join(', ') }) : tc('nobody', { seat: t(`roles.${u.seat}`) })}</div>}</td>
        <td className="px-3 py-3">{u.due ? <><div className="tabular-nums">{day(locale, u.due)}</div>{u.daysUntilDue !== null && <div className={`text-xs ${u.daysUntilDue < 0 ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{(w => t(`board.${w.key}`, { days: w.days }))(rewardDueWording(u.daysUntilDue))}</div>}</> : <span className="text-muted-foreground">{u.seat ? tc('dueNotSet') : tc('notAvailable')}</span>}</td>
        <td className="px-3 py-3">{u.people == null || u.verified == null ? tc('notAvailable') : u.people === 0 ? <span className="text-muted-foreground">{tc('noPeople')}</span> : u.verified === u.people ? <Badge variant="success" className="normal-case">{tc('allVerified')}</Badge> : <Badge variant="warning" className="normal-case">{tc('verifiedOf', { verified: u.verified, total: u.people })}</Badge>}</td>
        <td className="px-3 py-3"><RewardReviewActions review={u}/></td></tr>)}</tbody>
    </table>{!all.length ? <p className="max-w-2xl px-5 py-10 text-sm text-muted-foreground">{t('adminEmpty')}</p> : !units.length && <p className="max-w-2xl px-5 py-10 text-sm text-muted-foreground">{tc('filters.empty')}</p>}</div>
    {choices.companies.length>0&&<Card><SectionHeader title={t('createUnit')}/><RewardReviewCreateForm actorUserId={s.userId??''} today={today} companies={choices.companies} units={choices.units} memberships={memberships} cycles={choices.cycles} shared={shared}/></Card>}
  </div>;
}
