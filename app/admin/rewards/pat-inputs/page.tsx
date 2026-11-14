import {getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {rewardPatInputs} from '@/packs/rewards/pat-inputs';
import {PageHeader,Button,Field,inputCls,ErrorBanner} from '@/components/ui';
import {PatGrid,type PatGridCompany,type PatGridVersion} from './editor';

/** Board 2103041d: one editable grid for every company's PAT, grouped Business group › Business unit › Company. */
export default async function Page({searchParams}:{searchParams:Promise<{year?:string;error?:string}>}){
 const s=await getSession(),t=await getTranslations('rewardSetup'),nav=await getTranslations('nav'),p=await searchParams,year=Number(p.year)||Number(todayInKualaLumpur().slice(0,4));
 let rows;try{rows=await rewardPatInputs(s,year);}catch{return<div className="space-y-3"><PageHeader title={nav('rewardsPatInputs')}/><p>{t('noAccess')}</p></div>;}
 const version=(v:typeof rows[number]['history'][number]):PatGridVersion=>({id:v.id,revision:v.revision,state:v.state,inputs:v.inputs,createdByName:v.createdByName??null,confirmedByName:v.confirmedByName??null,confirmedAt:v.confirmedAt,reason:v.reason});
 const companies:PatGridCompany[]=rows.map(r=>({id:r.company.id,name:r.company.name,
  groupId:r.company.businessGroupId??r.company.parentId??'',groupName:r.company.businessGroupName??r.company.parentName??t('group'),
  buId:r.company.businessUnitId??'',buName:r.company.businessUnitName??t('missingBusinessUnitShort'),
  latestRevision:Math.max(0,...r.history.map(v=>v.revision)),active:r.current?version(r.current):null,draft:r.pending?version(r.pending):null,history:r.history.map(version)}));
 return<div className="space-y-6"><PageHeader title={nav('rewardsPatInputs')} description={t('patHelp')}/><ErrorBanner message={p.error}/>
  <form className="flex flex-wrap items-end gap-3"><Field label={t('year')}><input name="year" type="number" defaultValue={year} min="2000" max="2200" className={inputCls}/></Field><Button variant="outline">{t('filter')}</Button></form>
  <PatGrid key={year} year={year} companies={companies}/>
 </div>;
}
