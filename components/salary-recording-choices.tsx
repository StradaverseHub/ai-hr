'use client';
import {personnelControl,personnelCarry,personnelWorkflowControl} from '../lib/personnel-form-contract';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {DateField} from './ui/date-field';
import {inputCls} from './ui';
import {PaymentMethodField} from './payment-method-field';
import {formatDmy} from '../lib/date-display';
import type {SalaryRecordingChoice} from '../core/personnel-salary-recording';

export type SalaryRecordingOptions={
 events:{code:string;label:string}[];
 latest:{id:string;label:string;effectiveDate:string;canUpdate:boolean;paymentMethod?:string|null}[];
 closedPeriods:string[];
};
/** Shared by Salary Add and Edit. Amount remains in the enclosing form; all inputs post atomically. */
export function SalaryRecordingChoices({options,defaultDate,paymentMethod,defaultChoice='newEvent'}:{
 options:SalaryRecordingOptions;defaultDate:string;paymentMethod:string|null;defaultChoice?:SalaryRecordingChoice;
}){
 const t=useTranslations('people.detail'),[choice,setChoice]=useState<SalaryRecordingChoice>(defaultChoice),[date,setDate]=useState(defaultDate);
 const [method,setMethod]=useState(paymentMethod??'');
 const [target,setTarget]=useState(options.latest.length===1&&options.latest[0].canUpdate?options.latest[0].id:'');
 const selected=options.latest.find(event=>event.id===target);
 const changeChoice=(next:SalaryRecordingChoice)=>{setChoice(next);if(next==='updateLatest'){setDate(selected?.effectiveDate??'');if(selected?.paymentMethod!==undefined)setMethod(selected.paymentMethod??'');}};
 const closed=options.closedPeriods.some(period=>period>=date.slice(0,7));
 return <fieldset className="space-y-3 rounded-md border border-border p-3">
  <legend className="px-1 text-sm font-medium">{t('salaryRecording.title')}</legend>
  <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('salaryRecording.choice')}
   <select name="salaryRecordingChoice" value={choice} onChange={event=>changeChoice(event.target.value as SalaryRecordingChoice)} className={inputCls}>
    <option value="newEvent">{t('salaryRecording.newEvent')}</option>
    <option value="updateLatest" disabled={!options.latest.some(event=>event.canUpdate)}>{t('salaryRecording.updateLatest')}</option>
    <option value="amendment">{t('salaryRecording.amendment')}</option>
   </select>
  </label>
  {choice==='newEvent'&&<label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('salaryRecording.eventType')}
   <select {...personnelWorkflowControl('employment_history.event_information.kind','salaryRecording','record')} defaultValue={options.events.some(event=>event.code==='salaryAdjustment')?'salaryAdjustment':options.events[0]?.code??''} className={inputCls}>
    {!options.events.length&&<option value="">—</option>}
    {options.events.map(event=><option key={event.code} value={event.code}>{event.label}</option>)}
   </select>
  </label>}
  {choice==='updateLatest'&&<label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('salaryRecording.target')}
   <select name="salaryMovementId" required value={target} onChange={event=>{setTarget(event.target.value);const selected=options.latest.find(row=>row.id===event.target.value);setDate(selected?.effectiveDate??'');if(selected?.paymentMethod!==undefined)setMethod(selected.paymentMethod??'');}} className={inputCls}>
    <option value="">{t('salaryRecording.selectTarget')}</option>
    {options.latest.map(event=><option key={event.id} value={event.id} disabled={!event.canUpdate}>{event.label} · {formatDmy(event.effectiveDate)}</option>)}
   </select><span>{t('salaryRecording.latestHint')}</span>
  </label>}
  <div className="grid gap-3 sm:grid-cols-2">
   <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('paymentMethodEffectiveDate')}
    <DateField {...personnelControl('payroll.basic_salary_and_salary_history.validfrom','record')} value={date} onChange={event=>setDate(event.target.value)} readOnly={choice==='updateLatest'} className={inputCls} label={t('paymentMethodEffectiveDate')}/>
   </label>
   <div className="space-y-1"><PaymentMethodField mode="controlled" value={method} onChange={setMethod}/><input {...personnelCarry('payroll.payment_method_and_payroll_policy.paymentmethod')} value={method}/></div>
  </div>
  {choice!=='newEvent'&&<label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('movement.correctionReasonLabel')}
   <textarea {...personnelWorkflowControl('employment_history.event_information.correctionreason','salaryRecording','record')} maxLength={1000} className={inputCls}/>
  </label>}
  {choice==='amendment'&&<p className="text-xs text-muted-foreground">{t('salaryRecording.amendmentHint')}</p>}
  {closed&&<p className="text-xs text-amber-800 dark:text-amber-300">{t('movement.form.closedPayrollBody')}</p>}
 </fieldset>;
}
