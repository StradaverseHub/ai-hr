'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {Field,inputCls} from '@/components/ui';
import {RewardSubmit} from '@/app/rewards/submit-button';
import {createRewardAction} from '@/app/rewards/actions';
import type {RewardSharedChoice} from '@/packs/rewards/service';
import {defaultPolicy} from '@/packs/rewards/model';
type Props={actorUserId:string;today:string;companies:readonly{id:string;name:string}[];units:readonly{id:string;companyId:string;name:string;global:boolean}[];cycles:readonly{id:string;name:string;year:number}[];shared:readonly RewardSharedChoice[]};
export function RewardReviewCreateForm(props:Props){return <RewardReviewCreateDraft key={props.actorUserId+':'+JSON.stringify([props.companies,props.units,props.shared])} {...props}/>;}
function RewardReviewCreateDraft({today,companies,units,cycles,shared}:Props){
 const t=useTranslations('rewards'),tc=useTranslations('rewardsConfig');
 // The suggested cycle name follows the reward year until the creator types their own (7a8102a7).
 const [name,setName]=useState<string|null>(null);
 const [companyId,setCompany]=useState(companies[0]?.id??''),[year,setYear]=useState(Number(today.slice(0,4))),[cycleId,setCycle]=useState('');
 const [unitId,setUnit]=useState(units.find(u=>u.companyId===companyId||u.global)?.id??'');
 const compatible=units.filter(u=>u.companyId===companyId||u.global),versions=shared.filter(v=>v.companyId===companyId&&v.businessUnitId===unitId&&v.year===year);
 const versionId=versions.length===1?versions[0].versionId:'';
 const settings=versions.length===1?versions[0].policy:versions.length?null:defaultPolicy(year);
 const effectiveFrom=settings?.effectiveFrom;
 return <form action={createRewardAction} className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
  <Field label={t('existingCycle')}><select name="cycleId" className={inputCls} value={cycleId} onChange={event=>setCycle(event.target.value)}><option value="">{t('newCycle')}</option>{cycles.filter(c=>c.year===year).map(c=><option key={c.id} value={c.id}>{c.name} ({c.year})</option>)}</select></Field>
  {cycleId===''&&<Field label={t('cycle')}><input name="name" required maxLength={160} className={inputCls} value={name??tc('create.defaultName',{year})} onChange={event=>setName(event.target.value)}/></Field>}
  <Field label={t('year')}><input name="year" type="number" min={2000} max={2200} required value={year} className={inputCls} onChange={event=>{setYear(Number(event.target.value));setCycle('');}}/></Field>
  <Field label={t('effectiveFrom')}><input type="date" readOnly aria-readonly value={effectiveFrom??''} className={`${inputCls} bg-muted`}/></Field>
  <Field label={t('company')}><select name="companyId" required className={inputCls} value={companyId} onChange={event=>{const id=event.target.value;setCompany(id);setUnit(units.find(u=>u.companyId===id||u.global)?.id??'');}}>{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
  <Field label={t('unit')}><select name="businessUnitId" required className={inputCls} value={unitId} onChange={event=>{setUnit(event.target.value);}}>{compatible.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
  <Field label={t('snapshotDate')}><input name="snapshotDate" type="date" max={today} required defaultValue={today} className={inputCls}/></Field>
  <Field label={t('sharedPolicy.title')} className="sm:col-span-2"><input type="hidden" name="sharedPolicyVersionId" value={versionId}/><p className="rounded-md border px-3 py-2 text-sm">{versions.length===1?`${versions[0].name} · ${t('sharedPolicy.version',{version:versions[0].revision})}`:t('sharedPolicy.individualDefaults')}</p></Field>
  <p className="max-w-3xl text-sm text-muted-foreground sm:col-span-2 lg:col-span-3">{tc('create.effectiveHelp')} {versionId?t('sharedPolicy.reviewSnapshotHelp'):t('createHelp')}</p>
  <RewardSubmit type="submit" className="w-fit" disabled={!unitId||versions.length>1}>{t('createUnit')}</RewardSubmit>
 </form>;
}
