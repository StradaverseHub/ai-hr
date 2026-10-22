import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { listMyTp1Declarations, getMyTp1ById, listMyTp1Versions, getMyTp1Accumulated, getMyTp1FormIdentity, tp1Revision } from '@/packs/payroll/service';
import { myEmployment } from '@/core/read';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader, inputCls, pageWideCls } from '@/components/ui';
import { Tp1DeclarationForm } from '@/components/tp1-declaration-form';
import { Tp1DeclarationsList, type Tp1DeclarationListRow } from '@/components/tp1-declarations-list';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { myTp1FormAction } from '../actions';

export default async function TaxReliefPage({searchParams}:{searchParams:Promise<{year?:string;month?:string;entry?:string;new?:string;id?:string;error?:string;saved?:string;dPage?:string;dSize?:string}>}) {
  await requireModule('payroll');
  const {s}=await scopedSession(),sp=await searchParams,t=await getTranslations('taxRelief'),txn=await getTranslations('payroll.transactions.tp1'),locale=await getLocale();
  const currentYear=Number(todayInKualaLumpur().slice(0,4));
  const [declarations,me]=await Promise.all([s.personId?listMyTp1Declarations(s):Promise.resolve([]),myEmployment(s)]);
  const monthName=(month:number|null)=>month==null?txn('history.wholeYear'):new Intl.DateTimeFormat(locale,{month:'long',timeZone:'UTC'}).format(new Date(Date.UTC(2000,month-1,1)));
  const savedAt=(date:Date)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(date);
  const historyParams=new URLSearchParams();
  for(const key of ['dPage','dSize'] as const)if(sp[key]&&/^(?:\d{1,6}|all)$/.test(sp[key]!))historyParams.set(key,sp[key]!);
  const back='/me/tax-relief'+(historyParams.size?`?${historyParams}`:'');
  const rowHref=(id:string)=>`/me/tax-relief?${new URLSearchParams({...Object.fromEntries(historyParams),id})}`;
  const rows:Tp1DeclarationListRow[]=declarations.map(row=>({id:row.id,assessmentYear:row.assessmentYear,deductionMonth:row.deductionMonth,monthLabel:monthName(row.deductionMonth),amount:row.tp1Amount.toFixed(2),status:row.status,versions:row.versions,lastSaved:savedAt(row.submittedAt??row.lastSavedAt??row.createdAt),href:rowHref(row.id),readOnly:!me||row.assessmentYear<currentYear,deleteHref:null}));
  if(sp.new==='1')return <div className={pageWideCls}>
    <PageHeader title={txn('addTitle')} back={{href:back,label:t('title')}} description={txn('addStepHint')}/>
    {!me?<Card className="p-6 text-sm text-muted-foreground">{t('notLinked')}</Card>:<Card className="p-5"><form method="GET" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="entry" value="1"/>{[...historyParams].map(([key,value])=><input key={key} type="hidden" name={key} value={value}/>)}
      <label className="space-y-1 text-sm">{txn('assessmentYear')}<select name="year" className={inputCls} defaultValue={String(currentYear)}>{[...new Set([currentYear+1,currentYear,currentYear-1,currentYear-2,...declarations.map(row=>row.assessmentYear)])].sort((a,b)=>b-a).map(year=><option key={year} value={year}>{year}</option>)}</select></label>
      <label className="space-y-1 text-sm">{txn('addMonthLabel')}<select name="month" className={inputCls} defaultValue={todayInKualaLumpur().slice(5,7).replace(/^0/,'')}>{Array.from({length:12},(_,index)=><option key={index+1} value={index+1}>{monthName(index+1)}</option>)}</select></label>
      <Button type="submit" className="min-h-11">{txn('addStepContinue')}</Button>
    </form></Card>}
  </div>;
  if(sp.id||sp.entry==='1') {
    if(!s.personId)return <div className={pageWideCls}><PageHeader title={t('title')} back={{href:back,label:t('title')}}/><Card className="p-6 text-sm">{t('notLinked')}</Card></div>;
    const exact=sp.id?await getMyTp1ById(s,{id:sp.id}):null;
    if(sp.id&&!exact)notFound();
    const year=exact?.assessmentYear??(/^\d{4}$/.test(sp.year??'')?Number(sp.year):NaN);
    const month=exact?exact.deductionMonth:/^(?:[1-9]|1[0-2])$/.test(sp.month??'')?Number(sp.month):NaN;
    if(!Number.isInteger(year)||year<2000||year>2100||month!==null&&(!Number.isInteger(month)||month<1||month>12))notFound();
    const winner=declarations.find(row=>row.assessmentYear===year&&row.deductionMonth===month);
    const latest=exact??(winner?await getMyTp1ById(s,{id:winner.id}):null);
    const [accumulated,identity,versions]=await Promise.all([
      getMyTp1Accumulated(s,{assessmentYear:year,deductionMonth:month}),
      s.personId?getMyTp1FormIdentity(s):null,
      listMyTp1Versions(s,{assessmentYear:year,deductionMonth:month}),
    ]);
    const readOnly=!me||year<currentYear||Boolean(latest&&winner?.id!==latest.id);
    return <div className={pageWideCls}>
      <PageHeader title={t('title')} description={`${monthName(month)} · ${year}`} back={{href:back,label:txn('history.title')}}/>
      {!me&&<ErrorBanner message={t('notLinked')}/>}<ErrorBanner message={sp.error}/>
      {sp.saved&&['draft','submit'].includes(sp.saved)&&<p role="status" className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">{t(sp.saved==='draft'?'savedDraft':'savedSubmitted')}</p>}
      <Tp1DeclarationForm key={latest?.id??`${year}-${month}`} selectedYear={year} deductionMonth={month} latest={latest} accumulated={accumulated} readOnly={readOnly} employer={identity?.employer??null} employee={identity?.employee??{name:me?.name??'',idNumber:null,tin:null}} formAction={myTp1FormAction} hiddenFields={{tp1Revision:tp1Revision(latest),...Object.fromEntries(historyParams)}}/>
      {versions.length>1&&<Card className="p-4"><h2 className="text-sm font-semibold">{t('recordHistory')}</h2><ul className="mt-2 space-y-2 text-sm">{versions.map(version=><li key={version.id}><Link className="text-primary underline" href={rowHref(version.id)}>{savedAt(version.submittedAt??version.createdAt)} · {txn(`history.status_${version.status}`)}</Link></li>)}</ul></Card>}
    </div>;
  }
  return <div className={pageWideCls}>
    <PageHeader title={t('title')} description={t('monthlyIntro')} actions={me?<Button asChild><Link href={`/me/tax-relief?${new URLSearchParams({...Object.fromEntries(historyParams),new:'1'})}`}>{txn('addButton')}</Link></Button>:undefined}/>
    {!me&&<ErrorBanner message={t('notLinked')}/>}<ErrorBanner message={sp.error}/>
    <Card className="overflow-hidden"><SectionHeader title={txn('history.title')}/><Tp1DeclarationsList rows={rows} compactOnMobile/></Card>
    <p className="text-xs text-muted-foreground">{t('historyNote')}</p>
  </div>;
}
