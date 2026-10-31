'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {Field,inputCls} from '@/components/ui';
import {RewardSubmit} from '@/app/(app)/rewards/submit-button';
import {createRewardAction} from '@/app/(app)/rewards/actions';
import type {RewardSharedChoice} from '@/packs/rewards/service';
import Link from 'next/link';
import {rewardEligibilitySummary} from '@/packs/rewards/policy-eligibility';
import type {RewardEligibilitySummary} from '@/packs/rewards/policy-eligibility';
import type {RewardPolicyTarget} from '@/packs/rewards/policy-group-model';
import {defaultPolicy} from '@/packs/rewards/model';
import {RewardPolicySummaryDialog} from './policy-summary';
type Props={actorUserId:string;today:string;companies:readonly{id:string;name:string;excludedYears?:number[]}[];units:readonly{id:string;companyId:string;name:string;global:boolean}[];cycles:readonly{id:string;name:string;year:number}[];shared:readonly RewardSharedChoice[];memberships?:readonly RewardPolicyTarget[]};
/** 40bf44f7: the snapshot only says when data is read; eligibility is judged against the review's policy dates. */
function EligibilityDates({policy,title}:{policy:RewardEligibilitySummary|null;title:string|null}){
 const t=useTranslations('rewards.eligibilitySummary');
 return <section className="space-y-2 rounded-md border border-border p-3 text-sm sm:col-span-2 lg:col-span-3" aria-label={t('title')}><h3 className="font-medium">{t('title')}</h3>{title&&<p className="font-medium">{title}</p>}
  {policy?<><dl className="grid gap-2 sm:grid-cols-2">{(['activeAsOf','joinedBefore','confirmedBy','effectiveFrom'] as const).map(key=><div key={key}><dt className="text-muted-foreground">{t(key)}</dt><dd>{policy[key]??t('legacySnapshot')}</dd></div>)}</dl><p>{t('salaryWindow',{from:policy.blockedFrom,to:policy.blockedTo})}</p><p>{(policy.minimumBonusRating?t('bonus',{rating:policy.minimumBonusRating}):t('legacyMinimum'))} {policy.excludeNotice&&t('notice')} {policy.excludeErCase&&t('er')}</p><p>{t(policy.seniorMembershipMode==='named-members'?'senior':'seniorLegacy')}</p>{policy.legacyDefaults&&<p className="text-xs text-muted-foreground">{t('legacyDefaults')}</p>}</>:<p className="text-muted-foreground">{t('unavailable')}</p>}</section>;
}
export function RewardReviewCreateForm(props:Props){return <RewardReviewCreateDraft key={props.actorUserId+':'+JSON.stringify([props.companies,props.units,props.shared,props.memberships])} {...props}/>;}
function RewardReviewCreateDraft({today,companies,units,cycles,shared,memberships=[]}:Props){
 const t=useTranslations('rewards'),tc=useTranslations('rewardsConfig');
 // The suggested cycle name follows the reward year until the creator types their own (7a8102a7).
 const [name,setName]=useState<string|null>(null);
 const [companyId,setCompany]=useState(companies[0]?.id??''),[year,setYear]=useState(Number(today.slice(0,4))),[cycleId,setCycle]=useState('');
 const compatibleWith=(company:string,unit:string)=>memberships.some(pair=>pair.companyId===company&&pair.businessUnitId===unit);
 const [unitId,setUnit]=useState(units.find(u=>compatibleWith(companyId,u.id))?.id??'');
 const availableCompanies=companies.filter(c=>!c.excludedYears?.includes(year));
 const selectedCompany=availableCompanies.some(c=>c.id===companyId)?companyId:availableCompanies[0]?.id??'';
 const compatible=units.filter(u=>compatibleWith(selectedCompany,u.id)),selectedUnit=compatible.some(u=>u.id===unitId)?unitId:compatible[0]?.id??'';
 const validYear=Number.isInteger(year)&&year>=2000&&year<=2200;
 const versions=shared.filter(v=>v.companyId===selectedCompany&&v.businessUnitId===selectedUnit&&v.year===year);
 const versionId=versions.length===1?versions[0].versionId:'';
 const settings=versions.length===1?versions[0].policy:versions.length||!validYear?null:{...defaultPolicy(year),eligibility:rewardEligibilitySummary(defaultPolicy(year))};
 const effectiveFrom=settings?.effectiveFrom;
 const versionTitle=versions.length===1?`${versions[0].name} · ${t('sharedPolicy.version',{version:versions[0].revision})}`:null;
 return <form action={createRewardAction} className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
  <Field label={t('existingCycle')}><select name="cycleId" className={inputCls} value={cycleId} onChange={event=>setCycle(event.target.value)}><option value="">{t('newCycle')}</option>{cycles.filter(c=>c.year===year).map(c=><option key={c.id} value={c.id}>{c.name} ({c.year})</option>)}</select></Field>
  {cycleId===''&&<Field label={t('cycle')}><input name="name" required maxLength={160} className={inputCls} value={name??tc('create.defaultName',{year})} onChange={event=>setName(event.target.value)}/></Field>}
  <Field label={t('year')}><input name="year" type="number" min={2000} max={2200} required value={year} className={inputCls} onChange={event=>{setYear(Number(event.target.value));setCycle('');}}/></Field>
  <Field label={t('effectiveFrom')}><input type="date" readOnly aria-readonly value={effectiveFrom??''} className={`${inputCls} bg-muted`}/></Field>
  <Field label={t('company')}><select name="companyId" required className={inputCls} value={selectedCompany} onChange={event=>{const id=event.target.value;setCompany(id);setUnit(units.find(u=>compatibleWith(id,u.id))?.id??'');}}>{availableCompanies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
  <Field label={t('unit')}><select name="businessUnitId" required className={inputCls} value={selectedUnit} onChange={event=>{setUnit(event.target.value);}}>{compatible.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
  <Field label={t('snapshotDate')}><input name="snapshotDate" type="date" max={today} required className={inputCls}/></Field>
  <EligibilityDates policy={versions.length===1?(versions[0].policy?.eligibility??null):versions.length||!validYear?null:rewardEligibilitySummary(defaultPolicy(year))} title={versionTitle}/>
  <Field label={t('sharedPolicy.title')} className="sm:col-span-2"><input type="hidden" name="sharedPolicyVersionId" value={versionId}/>{versions.length===1?<p className="rounded-md border px-3 py-2 text-sm">{versionTitle}</p>:<p className="rounded-md border px-3 py-2 text-sm">{versions.length?t('sharedPolicy.individualDefaults'):<>{tc('shared.noneForPair')} <Link href="/admin/rewards/shared" className="text-primary hover:underline">{tc('shared.createOne')}</Link></>}</p>}</Field>
  {settings&&<div className="flex items-end pb-2"><RewardPolicySummaryDialog title={versionTitle??tc('summary.defaultsTitle',{year})} policy={settings}/></div>}
  <p className="max-w-3xl text-sm text-muted-foreground sm:col-span-2 lg:col-span-3">{tc('create.effectiveHelp')} {versionId?t('sharedPolicy.reviewSnapshotHelp'):t('createHelp')}</p>
  <RewardSubmit type="submit" className="w-fit" disabled={!selectedCompany||!selectedUnit||versions.length>1||!validYear||versions.length===1&&!settings}>{t('createUnit')}</RewardSubmit>
 </form>;
}
