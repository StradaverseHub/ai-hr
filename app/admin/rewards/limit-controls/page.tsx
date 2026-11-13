import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {rewardLimitControls,rewardLimitDefinitions} from '@/packs/rewards/limit-controls';
import {RewardSetupError} from '@/packs/rewards/setup-model';
import {Button,Card,Field,PageHeader,inputCls} from '@/components/ui';
import {LimitControlsEditor,type LimitRow} from './editor';
import {LimitControlReviews} from './reviews';

/** Board fc804e8c: CONFIGURATION › Limit Controls. Group Rewards edits, CTRO and EC view, everyone else (including a
 * direct link) sees "You don't have access". The service enforces the same rule on every read and command. */
export default async function Page({searchParams}:{searchParams:Promise<{year?:string}>}){
 const s=await getSession(),t=await getTranslations('rewardLimits'),nav=await getTranslations('nav'),p=await searchParams;
 const requested=Number(p.year),year=Number.isInteger(requested)&&requested>=2000&&requested<=2200?requested:Number(todayInKualaLumpur().slice(0,4));
 let data;
 try{data=await rewardLimitControls(s,year);}
 catch(e){if(!(e instanceof RewardSetupError))throw e;return<div className="space-y-3"><PageHeader title={nav('rewardsLimitControls')}/><Card className="space-y-2 p-5"><h2 className="font-semibold">{t('noAccess')}</h2><p className="text-sm text-muted-foreground">{t('noAccessHelp')}</p></Card></div>;}
 const locale=await getLocale(),time=new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'});
 const rows:LimitRow[]=rewardLimitDefinitions.map(def=>({key:def.key,area:def.area,unit:def.unit,appliesTo:def.appliesTo,fixed:'fixed' in def&&!!def.fixed,valueEditable:def.valueEditable,typeEditable:def.typeEditable,nullable:'nullable' in def&&!!def.nullable,
  value:data.values[def.key].value,type:data.values[def.key].type,changedBy:data.history[def.key].changedBy,changedAt:data.history[def.key].changedAt}));
 const years=[...new Set([year,...data.years])].sort((a,b)=>b-a);
 return<div className="space-y-6"><PageHeader title={nav('rewardsLimitControls')} description={t('description')}/>
  <form className="flex flex-wrap items-end gap-3"><Field label={t('year')}><select name="year" defaultValue={year} className={inputCls}>{years.map(y=><option key={y} value={y}>{y}</option>)}</select></Field><Button variant="outline">{t('show')}</Button></form>
  <p className="text-sm">{data.version?t('versionLine',{version:data.version.revision,year}):t('baselineLine',{year})}</p>
  <LimitControlsEditor key={`${year}:${data.version?.revision??0}`} year={year} revision={data.version?.revision??0} canEdit={data.canEdit} rows={rows}/>
  <Card className="space-y-3 p-4 sm:p-5"><h2 className="font-semibold">{t('reviewsHeading')}</h2><p className="text-sm text-muted-foreground">{t('reviewsHelp')}</p>
   <LimitControlReviews key={`${year}:${data.version?.revision??0}`} year={year} revision={data.version?.revision??null} canEdit={data.canEdit} reviews={data.reviews} truncated={data.reviewsTruncated}/></Card>
  <Card className="space-y-3 p-4 sm:p-5"><h2 className="font-semibold">{t('exemptionsHeading')}</h2><p className="text-sm text-muted-foreground">{t('exemptionsHelp')}</p>
   {data.exemptions.length?<ul className="divide-y divide-border text-sm">{data.exemptions.map(x=><li key={x.reviewId} className="py-2"><span className="font-medium">{x.label}</span><span className="block text-muted-foreground">{x.reason}</span></li>)}</ul>:<p className="text-sm text-muted-foreground">{t('noExemptions')}</p>}</Card>
  <Card className="space-y-3 p-4 sm:p-5"><h2 className="font-semibold">{t('historyHeading')}</h2>
   {data.versions.length?<ol className="divide-y divide-border text-sm">{data.versions.map(v=><li key={v.id} className="py-2"><span className="font-medium">{t('version',{version:v.revision})}</span> · {v.createdByName??t('unknownPerson')} · {time.format(new Date(v.createdAt))}<span className="block text-muted-foreground">{v.reason}</span></li>)}</ol>:<p className="text-sm text-muted-foreground">{t('noVersions')}</p>}
   <Link href="/admin/rewards/change-log?area=limit" className="text-sm text-primary underline">{t('changeLogLink')}</Link></Card>
 </div>;
}
