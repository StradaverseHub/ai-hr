import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {requireModule} from '@/lib/authz';
import {scopedSession} from '@/lib/scope';
import {myTp3Employments,myTp3History,myTp3Identity,myTp3Eligibility,type Tp3Record} from '@/packs/payroll/service';
import {Tp3DeclarationFields} from '@/components/tp3-declaration-fields';
import {Button,Card,PageHeader,inputCls,pageWideCls} from '@/components/ui';
import {todayInKualaLumpur,timeInKualaLumpur} from '@/lib/hr-date';
import {TP3_FORM_MARKER} from '@/lib/tp3-form-input';
import {MyTp3EditableForm} from './form-client';
export default async function MyTp3Page({searchParams}:{searchParams:Promise<{employmentId?:string;year?:string;saved?:string}>}) {
  await requireModule('payroll');
  const {s}=await scopedSession();
  const [sp,t,employments,history]=await Promise.all([searchParams,getTranslations('myTp3'),myTp3Employments(s),myTp3History(s)]);
  const today=todayInKualaLumpur();
  const active=employments.filter(row=>row.hiredOn<=today&&!row.blacklistedAt&&(!row.terminatedOn||row.terminatedOn>=today)&&(!row.resignationDate||row.resignationDate>=today)&&(!row.lastWorkingDate||row.lastWorkingDate>=today));
  const selected=sp.employmentId?employments.find(row=>row.employmentId===sp.employmentId):active.length===1?active[0]:undefined;
  const eligibility=myTp3Eligibility(selected,today);
  const years=[...new Set([...history.records.map(row=>row.assessmentYear),...history.drafts.map(row=>row.assessmentYear),...(eligibility.year?[eligibility.year]:[])])].sort((a,b)=>b-a);
  const requested=sp.year&&/^\d{4}$/.test(sp.year)?Number(sp.year):null;
  const year=requested&&years.includes(requested)?requested:eligibility.year??years[0]??Number(today.slice(0,4));
  const canonical=history.records.find(row=>row.assessmentYear===year),draft=history.drafts.find(row=>row.assessmentYear===year);
  const record:Tp3Record|null=canonical??(draft?{id:draft.id,personId:s.personId??'',assessmentYear:year,deductionMonth:draft.deductionMonth,previousEmployers:draft.previousEmployers,payload:draft.payload,declaredAt:draft.submittedAt,remarks:null,updatedAt:draft.updatedAt}:null);
  const editable=!!selected&&eligibility.eligible&&year===eligibility.year&&!canonical&&!draft?.submittedAt&&(!draft||draft.employmentId===selected.employmentId);
  const identity=s.personId?await myTp3Identity(s):null;
  const state=canonical?canonical.declaredAt?'declared':'payrollSaved':draft?draft.submittedAt?'submitted':'draft':'new';
  const href=(assessmentYear:number)=>`/me/tp3?${new URLSearchParams({year:String(assessmentYear),...(selected?{employmentId:selected.employmentId}:{})})}`;
  const fields=identity?<Tp3DeclarationFields record={record} identity={identity} selectedYear={year} mode="personal" declarationAccepted={canonical?canonical.declaredAt!=null:draft?.declarationAccepted??false}/>:null;
  return <div className={pageWideCls}>
    <PageHeader title={t('title')} description={t('intro')}/>
    {employments.length>0&&<Card className="p-4"><form method="GET" className="flex flex-wrap items-end gap-3"><label className="min-w-0 flex-1 space-y-1 text-sm font-medium">{t('employment')}<select name="employmentId" defaultValue={selected?.employmentId??''} className={inputCls} required><option value="">{t('chooseEmployment')}</option>{employments.map(row=><option key={row.employmentId} value={row.employmentId}>{[row.company,row.employeeCode].filter(Boolean).join(' · ')}</option>)}</select></label>{years.length>0&&<label className="space-y-1 text-sm font-medium">{t('year')}<select name="year" defaultValue={String(year)} className={inputCls}>{years.map(value=><option key={value} value={value}>{value}</option>)}</select></label>}<Button type="submit" className="min-h-11">{t('view')}</Button></form></Card>}
    <Card className="space-y-3 p-4"><dl className="grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-muted-foreground">{t('joinDate')}</dt><dd className="font-medium">{eligibility.joinDate??'—'}</dd></div><div><dt className="text-muted-foreground">{t('year')}</dt><dd className="font-medium tabular-nums">{year}</dd></div><div><dt className="text-muted-foreground">{t('state')}</dt><dd className="font-medium">{t(state)}</dd></div></dl>{eligibility.fallback&&<p className="text-xs text-muted-foreground">{t('fallback')}</p>}{!editable&&<p className="max-w-prose text-sm text-muted-foreground">{canonical||draft?.submittedAt?t('correctionHelp'):!selected&&active.length>1?t('chooseHelp'):t('ineligible')}</p>}{draft?.projectionOutcome&&!draft.projectionOutcome.applied&&draft.projectionOutcome.reason==='laterYearHoldsColumns'&&<p className="text-sm text-amber-700 dark:text-amber-300">{t('held',{year:draft.projectionOutcome.heldBy})}</p>}{record&&<p className="text-xs text-muted-foreground">{t('savedAt',{at:timeInKualaLumpur(record.updatedAt)})}</p>}</Card>
    {sp.saved&&['draft','submit'].includes(sp.saved)&&<p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{t(sp.saved==='draft'?'draftSaved':'submitted')}</p>}
    {fields&&(record||editable)&&(editable&&selected?<MyTp3EditableForm><input type="hidden" name="tp3Form" value={TP3_FORM_MARKER}/><input type="hidden" name="employmentId" value={selected.employmentId}/><input type="hidden" name="assessmentYear" value={year}/><input type="hidden" name="revision" value={draft?.revision??0}/>{fields}</MyTp3EditableForm>:<fieldset disabled className="min-w-0 space-y-5">{fields}</fieldset>)}
    {!s.personId&&<Card className="p-6 text-sm text-muted-foreground">{t('notLinked')}</Card>}
    {years.length>1&&<Card className="space-y-3 p-4"><h2 className="font-semibold">{t('history')}</h2><ul className="flex flex-wrap gap-4 text-sm">{years.map(value=><li key={value}><Link href={href(value)} className="text-primary underline-offset-4 hover:underline" aria-current={year===value?'page':undefined}>{value}</Link></li>)}</ul></Card>}
  </div>;
}
