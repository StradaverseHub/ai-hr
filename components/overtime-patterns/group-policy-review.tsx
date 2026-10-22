import Link from 'next/link';
import {useFormatter,useTranslations} from 'next-intl';
import {Card,btnPrimary,inputCls} from '@/components/ui';
import {ATTENDANCE_POLICY_DAY_CLASSES} from '@/lib/attendance-group-policy';
import type {AttendanceGroupPolicyReview} from '@/packs/attendance/service';

const PAGE='/admin/attendance/settings/overtime-patterns';
type Option={id:string;name:string};
export type OvertimeGroupPolicyReviewProps={
 companies:Option[];groups:Option[];companyId:string;groupId:string;
 review:AttendanceGroupPolicyReview|null;failed:boolean;versionId?:string;today:string;
};
/** A server-rendered consumer of the immutable Schedule Group owner. No local policy copy or writer. */
export function OvertimeGroupPolicyReview({companies,groups,companyId,groupId,review,failed,versionId,today}:OvertimeGroupPolicyReviewProps){
 const t=useTranslations('overtimePatterns.policyReview'),format=useFormatter();
 const href=(id?:string)=>{const query=new URLSearchParams({policyCompany:companyId,policyGroup:groupId});if(id)query.set('policyVersion',id);return `${PAGE}?${query}#group-policy-review`;};
 const selected=versionId?review?.history.find(row=>row.id===versionId):
  review?.history.slice().reverse().find(row=>row.effectiveFrom<=today)??review?.history[0];
 const next=selected?review?.history.find(row=>row.effectiveFrom>selected.effectiveFrom):undefined;
 const state=selected&&selected.effectiveFrom>today?'scheduled':next&&next.effectiveFrom<=today?'earlier':'current';
 const date=(value:string)=>format.dateTime(new Date(value+'T00:00:00+08:00'),{dateStyle:'medium',timeZone:'Asia/Kuala_Lumpur'});
 const yes=(value:boolean)=>t(value?'on':'off');
 const p=selected?.policy;
 const clockRows=p?[
  ['pairing',t(`pairings.${p.clock.pairing}`)],
  ['minimumInterval',t('minutes',{count:p.clock.minimumIntervalMinutes})],
  ['lateGrace',t('minutes',{count:p.clock.lateGraceMinutes})],
  ['earlyGrace',t('minutes',{count:p.clock.earlyGraceMinutes})],
  ['skipIncomplete',yes(p.clock.skipLatenessIfIncomplete)],
 ]:[];
 const overtimeRows=p?[
  ['enabled',yes(p.overtime.enabled)],['beforeShift',yes(p.overtime.beforeShift)],['afterShift',yes(p.overtime.afterShift)],
  ['unclocked',yes(p.overtime.allowBackdatedWithoutClock)],['midnight',yes(p.overtime.splitAtMidnight)],['lateOffset',yes(p.overtime.offsetLateness)],
  ['approval',t(`approvals.${p.overtime.approval}`)],['autoMethod',t(`methods.${p.overtime.autoMethod}`)],
  ['rounding',p.overtime.rounding.mode==='none'?t('roundings.none'):t('roundingStep',{mode:t(`roundings.${p.overtime.rounding.mode}`),count:p.overtime.rounding.step!})],
 ]:[];
 const details=(rows:string[][])=><dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">{rows.map(([key,value])=><div key={key}><dt className="text-sm text-muted-foreground">{t(`fields.${key}`)}</dt><dd className="mt-1 text-sm font-medium">{value}</dd></div>)}</dl>;
 return <section id="group-policy-review" aria-labelledby="group-policy-review-title" className="space-y-4 scroll-mt-6">
  <div><h2 id="group-policy-review-title" className="font-semibold">{t('title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('description')}</p></div>
  <form method="get" action={PAGE+'#group-policy-review'} className="flex flex-wrap items-end gap-3">
   <label className="min-w-48 space-y-1 text-sm"><span className="block">{t('company')}</span><select name="policyCompany" className={inputCls+' min-h-11'} defaultValue={companyId} required><option value="">{t('chooseCompany')}</option>{companies.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
   <label className="min-w-48 space-y-1 text-sm"><span className="block">{t('group')}</span><select name="policyGroup" className={inputCls+' min-h-11'} defaultValue={groupId} required><option value="">{t('chooseGroup')}</option>{groups.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
   <button className={btnPrimary+' min-h-11'}>{t('review')}</button>
  </form>
  {failed||versionId&&!selected?<p role="alert" className="rounded-lg border border-border p-4 text-sm">{t('unavailable')} <Link href={href()} className="text-primary underline">{t('retry')}</Link></p>:
   !review?<p className="text-sm text-muted-foreground">{t('chooseHelp')}</p>:
   !selected?<Card className="p-4"><p className="text-sm">{t('legacy')}</p><Link className="mt-2 inline-flex min-h-11 items-center text-sm text-primary hover:underline" href={`/admin/attendance/schedule/${review.rule.id}`}>{t('openGroup')}</Link></Card>:
   <Card className="space-y-6 p-4 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
     <div><h3 className="font-medium">{review.rule.label?.trim()?`${review.rule.label} — ${review.rule.name}`:review.rule.name}</h3><p className="mt-1 text-sm text-muted-foreground">{t('version',{count:selected.ordinal})} · {t(`states.${state}`)} · {t('from',{date:date(selected.effectiveFrom)})}{next?` · ${t('until',{date:date(next.effectiveFrom)})}`:''}</p></div>
     <Link className="inline-flex min-h-11 items-center text-sm text-primary hover:underline" href={`/admin/attendance/schedule/${review.rule.id}`}>{t('openGroup')}</Link>
    </div>
    <nav aria-label={t('history')} className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">{review.history.map(row=><Link key={row.id} href={href(row.id)} aria-current={selected.id===row.id?'page':undefined} className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 py-2 text-sm aria-[current=page]:border-primary aria-[current=page]:text-primary">{t('version',{count:row.ordinal})} · {date(row.effectiveFrom)}</Link>)}</nav>
    <section className="space-y-3" aria-label={t('clock')}><h4 className="text-sm font-semibold">{t('clock')}</h4>{details(clockRows)}<p className="text-xs text-muted-foreground">{t('graceHelp')}</p></section>
    <section className="space-y-3" aria-label={t('overtime')}><h4 className="text-sm font-semibold">{t('overtime')}</h4>{details(overtimeRows)}{!p!.overtime.enabled?<p className="text-sm text-muted-foreground">{t('disabledHelp')}</p>:null}{p!.overtime.approval==='manual'?<p className="text-xs text-muted-foreground">{t('manualHelp')}</p>:null}</section>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="pb-3 text-left font-semibold">{t('bindings')}</caption><thead><tr className="border-b border-border">{['day','minimum','maximum','pattern'].map(key=><th key={key} scope="col" className="px-3 py-3">{t(key)}</th>)}</tr></thead><tbody>{ATTENDANCE_POLICY_DAY_CLASSES.map(key=>{
     const day=p!.overtime.days[key],pattern=review.patterns.find(row=>row.versionId===day.patternVersionId);
     return <tr key={key} className="border-b border-border/60"><th scope="row" className="whitespace-nowrap px-3 py-3 font-medium">{t(`days.${key}`)}</th><td className="whitespace-nowrap px-3 py-3">{t('minutes',{count:day.minimumMinutes})}</td><td className="whitespace-nowrap px-3 py-3">{day.maximumMinutes===null?t('uncapped'):t('minutes',{count:day.maximumMinutes})}</td><td className="px-3 py-3">{pattern?<Link className="inline-flex min-h-11 items-center text-primary hover:underline" href={`${PAGE}?pattern=${pattern.patternId}&version=${pattern.versionId}`}>{t('patternVersion',{name:pattern.name,count:pattern.ordinal})}</Link>:day.patternVersionId?t('bindingUnavailable'):t('unassigned')}</td></tr>;
    })}</tbody></table></div>
   </Card>}
 </section>;
}
