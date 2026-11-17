import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {requireModule} from '@/lib/authz';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {rewardReviewPlans} from '@/packs/rewards/review-plans';
import {shiftRewardYearSettings,type RewardReviewPlanFilters} from '@/packs/rewards/review-plans-model';
import {RewardSetupError} from '@/packs/rewards/setup-model';
import {PageHeader,Field,Button,inputCls} from '@/components/ui';
import {NewRewardYear} from './new-year';
import {ReviewPlanGrid} from './editor';

type Params={year?:string;page?:string;businessUnitId?:string;planType?:string;missingSalary?:string;missingBonus?:string;unreviewed?:string;error?:string};
export default async function ReviewPlansPage({searchParams}:{searchParams:Promise<Params>}){
 const s=await requireModule('rewards'),p=await searchParams,t=await getTranslations('rewardsReviewPlans');
 const year=Number(p.year??todayInKualaLumpur().slice(0,4));if(!Number.isInteger(year)||year<2000||year>2200)notFound();
 const filters:RewardReviewPlanFilters={...(p.businessUnitId?{businessUnitId:p.businessUnitId}:{}),...(['standard','uploaded','no_awards'].includes(p.planType??'')?{planType:p.planType as RewardReviewPlanFilters['planType']}:{}),...(p.missingSalary?{missingSalary:true}:{}),...(p.missingBonus?{missingBonus:true}:{}),...(p.unreviewed?{unreviewed:true}:{})};
 let data;try{data=await rewardReviewPlans(s,{year,filters,page:Math.max(1,Number(p.page)||1)});}catch(error){if(error instanceof RewardSetupError&&error.code==='forbidden')notFound();throw error;}
 const units=data.businessUnits.map(unit=>[unit.id,unit.name] as const);
 const link=(page:number)=>{const q=new URLSearchParams();for(const [key,value]of Object.entries(p))if(value&&key!=='page'&&key!=='error')q.set(key,value);q.set('year',String(year));q.set('page',String(page));return'/admin/rewards/review-plans?'+q;};
 const nextYear=data.yearSettings?year+1:year,settings=data.yearSettings?shiftRewardYearSettings(data.yearSettings,1):data.suggestedYearSettings;
 return<div data-tour="rewards-configuration" className="space-y-6"><PageHeader title={t('title')} description={t('description')} actions={<Link href="/admin/rewards/earlier-plans" className="text-sm text-primary underline underline-offset-2">{t('earlierPlans')}</Link>}/>
 <div className="flex flex-wrap items-start justify-between gap-4"><form method="get" className="flex items-end gap-3"><Field label={t('year')}><select className={inputCls} name="year" defaultValue={year}>{[...new Set([...data.years,year])].sort((a,b)=>b-a).map(value=><option key={value} value={value}>{value}</option>)}</select></Field><Button variant="outline">{t('openYear')}</Button></form><NewRewardYear key={nextYear} year={nextYear} settings={settings} canCreate={data.canCreateYear}/></div>
 {p.error&&<p role="alert" className="text-sm text-destructive">{p.error}</p>}
 {data.yearSettings?<><details className="rounded-md border border-border p-3 text-sm"><summary className="cursor-pointer font-medium">{t('yearSettings')}</summary><dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Object.entries(data.yearSettings).map(([key,value])=><div key={key}><dt className="text-muted-foreground">{t('dates.'+key)}</dt><dd className="mt-1 tabular-nums">{value}</dd></div>)}</dl></details>
 <form method="get" className="flex flex-wrap items-end gap-3"><input type="hidden" name="year" value={year}/><Field label={t('businessUnit')}><select className={inputCls} name="businessUnitId" defaultValue={p.businessUnitId??''}><option value="">{t('allUnits')}</option>{units.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></Field><Field label={t('planType')}><select className={inputCls} name="planType" defaultValue={p.planType??''}><option value="">{t('allTypes')}</option>{(['standard','uploaded','no_awards']as const).map(type=><option key={type} value={type}>{t('types.'+type)}</option>)}</select></Field>{(['missingSalary','missingBonus','unreviewed']as const).map(key=><label key={key} className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" name={key} value="1" defaultChecked={!!p[key]}/>{t(key)}</label>)}<Button variant="outline">{t('applyFilters')}</Button><Link className="self-center text-sm text-primary underline" href={'?year='+year}>{t('clearFilters')}</Link></form>
 <ReviewPlanGrid key={year+JSON.stringify(filters)+data.page} year={year} data={data}/><nav aria-label={t('pagination')} className="flex items-center justify-between text-sm">{data.page>1?<Link className="text-primary underline" href={link(data.page-1)}>{t('previous')}</Link>:<span/>}<span>{t('page',{page:data.page})}</span>{data.hasMore?<Link className="text-primary underline" href={link(data.page+1)}>{t('next')}</Link>:<span/>}</nav>
 </>:<p className="rounded-lg border border-border p-6 text-sm text-muted-foreground">{t('noYear',{year})}</p>}
 <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer font-semibold">{t('leftOut')}</summary><p className="mt-3 max-w-3xl text-sm text-muted-foreground">{t('leftOutHelp')}</p>{data.excludedCompanies.length?<ul className="mt-3 divide-y divide-border text-sm">{data.excludedCompanies.map(company=><li key={company.id} className="flex flex-wrap justify-between gap-2 py-2"><span>{company.name}</span><span className="text-muted-foreground">{t.has('leftOutReasons.'+company.reason)?t('leftOutReasons.'+company.reason):company.reason}</span></li>)}</ul>:<p className="mt-3 text-sm text-muted-foreground">{t('noneLeftOut')}</p>}</details>
 </div>;
}
