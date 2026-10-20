'use client';
import {useState} from 'react';
import {useFormStatus} from 'react-dom';
import * as Dialog from '@radix-ui/react-dialog';
import {useTranslations} from 'next-intl';
import Link from 'next/link';
import {DEFAULT_PAYROLL_COMPARISON,PAYROLL_COMPARISON_COLUMNS,type PayrollComparisonDefinition} from '@/lib/payroll-period-comparison';
import {savePayrollComparisonAction,createPayrollComparisonSampleAction} from './actions';

function Submit(){const {pending}=useFormStatus(),t=useTranslations('payrollComparison');return <button disabled={pending} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" type="submit">{t('saveRun')}</button>;}
function SampleSubmit(){const {pending}=useFormStatus(),t=useTranslations('payrollComparison');return <button type="submit" disabled={pending} className="rounded-lg border border-border px-3 py-2 text-sm font-medium disabled:opacity-50">{t(pending?'creatingSample':'createSample')}</button>;}

type Props={payItems:{code:string;name:string}[];initial?:PayrollComparisonDefinition;id?:string;version?:number;name?:string;description?:string};
export function PayrollComparisonEditor({payItems,initial=DEFAULT_PAYROLL_COMPARISON,id,version,name,description}:Props){
  const t=useTranslations('payrollComparison'),[compareMode,setCompareMode]=useState(initial.compareMode);
  const field='mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm';
  const items=payItems.some(item=>item.code===initial.payItemCode)?payItems:[{code:initial.payItemCode,name:initial.payItemCode},...payItems];
  return <form action={savePayrollComparisonAction} className="space-y-5">
    <input type="hidden" name="id" value={id??''}/><input type="hidden" name="version" value={version??''}/>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm font-medium">{t('reportName')}<input className={field} name="name" required maxLength={150} defaultValue={name??'Payroll Basic Variance'}/></label>
      <label className="text-sm font-medium">{t('payItem')}<select className={field} name="payItemCode" defaultValue={initial.payItemCode}>{items.map(item=><option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select></label>
      <label className="text-sm font-medium">{t('compareAgainst')}<select className={field} name="compareMode" value={compareMode} onChange={event=>setCompareMode(event.target.value as 'previous'|'specific')}><option value="previous">{t('automaticPrevious')}</option><option value="specific">{t('specificPeriod')}</option></select></label>
      {compareMode==='specific'&&<label className="text-sm font-medium">{t('previousPeriod')}<input type="month" className={field} name="previousPeriod" required defaultValue={initial.previousPeriod??''}/></label>}
      <label className="text-sm font-medium">{t('runs')}<select className={field} name="runType" defaultValue={initial.runType}><option value="regular">{t('regular')}</option><option value="all">{t('allRuns')}</option></select></label>
      <label className="text-sm font-medium">{t('minimum')}<input type="number" className={field} name="minVariance" min="0" max="999999999999.99" step="0.01" required defaultValue={initial.minVariance}/></label>
    </div>
    <label className="block text-sm font-medium">{t('description')}<textarea className={field} name="description" maxLength={1000} defaultValue={description??''}/></label>
    <div className="space-y-2 text-sm"><label className="flex items-center gap-2"><input type="checkbox" name="autoTag" defaultChecked={initial.autoTag}/>{t('autoTag')}</label><label className="flex items-center gap-2"><input type="checkbox" name="onlyVariances" defaultChecked={initial.onlyVariances}/>{t('onlyVariances')}</label></div>
    <fieldset><legend className="text-sm font-semibold">{t('columnsTitle')}</legend><p className="mt-1 text-xs text-muted-foreground">{t('mandatory')}</p><div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">{PAYROLL_COMPARISON_COLUMNS.map(column=><label key={column} className="flex items-center gap-2"><input type="checkbox" name="columns" value={column} defaultChecked={initial.columns.includes(column)}/>{t('columns.'+column)}</label>)}</div></fieldset>
    <fieldset><legend className="text-sm font-semibold">{t('access')}</legend><p className="mt-1 text-xs text-muted-foreground">{t('accessHelp')}</p><div className="mt-3 flex gap-4 text-sm">{(['hr_admin','super_admin'] as const).map(role=><label key={role} className="flex items-center gap-2"><input type="checkbox" name="roles" value={role} defaultChecked={initial.roles.includes(role)}/>{t('roles.'+role)}</label>)}</div></fieldset>
    <div className="flex justify-end gap-3 border-t border-border pt-4"><Link className="rounded-lg px-4 py-2 text-sm" href={id?'/reports/payroll-comparison/'+id:'/reports?cat=payroll'}>{t('cancel')}</Link><Submit/></div>
  </form>;
}
export function PayrollNewReportDialog({payItems}:{payItems:Props['payItems']}){
  const t=useTranslations('payrollComparison'),[type,setType]=useState('comparison');
  return <Dialog.Root><Dialog.Trigger className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">{t('newReport')}</Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/40"/><Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[95vw] max-w-3xl -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border border-border bg-card p-6 shadow-xl">
    <div className="flex items-start justify-between"><div><Dialog.Title className="text-lg font-semibold">{t('newReport')}</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted-foreground">{t('newHelp')}</Dialog.Description></div><Dialog.Close aria-label={t('cancel')} className="rounded px-2 py-1">×</Dialog.Close></div>
    <fieldset className="my-5 flex gap-3"><legend className="sr-only">{t('reportType')}</legend>{['list','comparison'].map(value=><label className="flex flex-1 items-center gap-2 rounded-xl border border-border p-3 text-sm" key={value}><input type="radio" name="reportType" value={value} checked={type===value} onChange={()=>setType(value)}/>{t(value==='list'?'listReport':'periodComparison')}</label>)}</fieldset>
    {type==='list'?<Link href="/reports/builder/new?dataset=payroll_history" className="inline-block rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">{t('openListBuilder')}</Link>:<><PayrollComparisonEditor payItems={payItems}/><form action={createPayrollComparisonSampleAction} className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"><p className="max-w-lg text-xs text-muted-foreground">{t('sampleHelp')}</p><SampleSubmit/></form></>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
