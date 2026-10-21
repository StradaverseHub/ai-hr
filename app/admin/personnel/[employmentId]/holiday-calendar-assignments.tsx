'use client';
import { useId, useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Button, Card, inputCls } from '@/components/ui';
import { PersonnelField } from '@/components/personnel-field';
import { personnelControl, personnelInput } from '@/lib/personnel-form-contract';
import { saveHolidayCalendarAssignmentAction } from './holiday-calendar-actions';

type Row={id:string;startDate:string;endDate:string|null;choice:string;superseded:boolean};
type Props={employmentId:string;joinDate:string;employmentStartDate?:string;fallbackLabel:string;groups:{id:string;name:string;active:boolean}[];states:string[];rows:Row[]};
export function HolidayCalendarAssignments({employmentId,joinDate,employmentStartDate=joinDate,fallbackLabel,groups,states,rows}:Props){
 const t=useTranslations('holidayCalendarAssignments'),locale=useLocale(),router=useRouter(),formId=useId();
 const [draft,setDraft]=useState<{id:string|null;startDate:string;endDate:string;choice:string}|null>(null);
 const [error,setError]=useState<string|null>(null),[notice,setNotice]=useState<{updated:number;reviewDates:string[]}|null>(null);
 const [pending,startTransition]=useTransition();
 const date=(value:string)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(value+'T00:00:00Z'));
 const label=(choice:string)=>choice.startsWith('group:')?groups.find(g=>`group:${g.id}`===choice)?.name??t('unavailableCalendar'):choice.startsWith('state:')?choice.slice(6):t('companyDefault');
 const edit=(row?:Row)=>{setError(null);setNotice(null);setDraft(row?{id:row.id,startDate:row.startDate,endDate:row.endDate??'',choice:row.choice}:{id:null,startDate:joinDate,endDate:'',choice:''});};
 const submit=(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault();const form=new FormData(event.currentTarget);
  // Preserve the values actually submitted, including native date edits/autofill, on a refusal.
  setDraft({id:String(form.get('replacesId')??'')||null,startDate:String(form.get('startDate')??''),endDate:String(form.get('endDate')??''),choice:String(form.get('calendar')??'')});
  setError(null);setNotice(null);
  startTransition(async()=>{
   try{
    const result=await saveHolidayCalendarAssignmentAction(form);
    if(!result.ok){setError(result.error);return;}
    setDraft(null);setNotice({updated:result.updated,reviewDates:result.reviewDates});router.refresh();
   }catch{setError('failed');}
  });
 };
 const active=rows.filter(row=>!row.superseded),history=rows.filter(row=>row.superseded);
 return <Card id="section-holiday-calendar" className="overflow-hidden">
  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
   <h2 className="text-base font-semibold">{t('title')}</h2>
   <Button type="button" onClick={()=>edit()} disabled={pending||!!draft}>{t('add')}</Button>
  </div>
  <div className="space-y-4 p-4">
   <p className="text-sm text-muted-foreground">{t('fallback',{calendar:fallbackLabel})}</p>
   {notice&&<div role="status" className="rounded-lg border border-border bg-muted p-3 text-sm">
    <p>{t('saved',{count:notice.updated})}</p>
    {notice.reviewDates.length>0&&<p className="mt-1">{t('review',{count:notice.reviewDates.length})} {notice.reviewDates.map(date).join(', ')}</p>}
   </div>}
   {draft&&<form data-tab-save-independent="true" onSubmit={submit} className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-3" aria-label={draft.id?t('edit'):t('add')}>
    <input type="hidden" name="employmentId" value={employmentId}/><input type="hidden" name="replacesId" value={draft.id??''}/>
    <PersonnelField fieldId="attendance.dated_holiday_calendar.calendar" className="space-y-1 text-sm">
     <select {...personnelControl('attendance.dated_holiday_calendar.calendar')} id={`${formId}-calendar`} value={draft.choice} disabled={pending} onChange={e=>setDraft({...draft,choice:e.target.value})} className={inputCls}>
      <option value="">{t('companyDefault')}</option>
      <optgroup label={t('groups')}>{groups.filter(g=>g.active||draft.choice===`group:${g.id}`).map(g=><option key={g.id} value={`group:${g.id}`}>{g.name}{!g.active?` · ${t('inactive')}`:''}</option>)}</optgroup>
      <optgroup label={t('states')}>{states.map(state=><option key={state} value={`state:${state}`}>{state}</option>)}</optgroup>
     </select>
    </PersonnelField>
    <PersonnelField fieldId="attendance.dated_holiday_calendar.startdate" className="space-y-1 text-sm"><input {...personnelInput('attendance.dated_holiday_calendar.startdate','edit',{employmentStartDate})} id={`${formId}-start`} value={draft.startDate} disabled={pending} onChange={e=>setDraft({...draft,startDate:e.target.value})} className={inputCls}/></PersonnelField>
    <PersonnelField fieldId="attendance.dated_holiday_calendar.enddate" className="space-y-1 text-sm"><input {...personnelInput('attendance.dated_holiday_calendar.enddate','edit',{calendarAssignmentStartDate:draft.startDate||joinDate})} id={`${formId}-end`} aria-label={t('end')} aria-describedby={`${formId}-end-help`} value={draft.endDate} disabled={pending} onChange={e=>setDraft({...draft,endDate:e.target.value})} className={inputCls}/><span id={`${formId}-end-help`} className="block text-xs text-muted-foreground">{t('endHelp')}</span></PersonnelField>
    {error&&<p role="alert" className="text-sm text-destructive sm:col-span-3">{t(`errors.${error}`)}</p>}
    <div className="flex flex-wrap gap-2 sm:col-span-3"><Button type="submit" disabled={pending}>{t(pending?'saving':'save')}</Button><Button type="button" variant="secondary" disabled={pending} onClick={()=>{setDraft(null);setError(null);}}>{t('cancel')}</Button></div>
   </form>}
   {!active.length?<p className="py-3 text-sm text-muted-foreground">{t('empty')}</p>:<div className="overflow-x-auto"><table className="w-full min-w-[36rem] text-left text-sm">
    <thead><tr className="border-b border-border text-xs text-muted-foreground">{['calendar','start','end','actions'].map(key=><th key={key} scope="col" className="p-3 font-medium">{t(key)}</th>)}</tr></thead>
    <tbody>{active.map(row=><tr key={row.id} className="border-b border-border last:border-0"><td className="p-3 font-medium">{label(row.choice)}</td><td className="p-3 whitespace-nowrap">{date(row.startDate)}</td><td className="p-3 whitespace-nowrap">{row.endDate?date(row.endDate):t('noEnd')}</td><td className="p-3"><Button type="button" variant="secondary" disabled={pending||!!draft} onClick={()=>edit(row)} aria-label={t('editNamed',{calendar:label(row.choice),date:date(row.startDate)})}>{t('edit')}</Button></td></tr>)}</tbody>
   </table></div>}
   <p className="text-xs text-muted-foreground">{t('protection')}</p>
   {history.length>0&&<details className="border-t border-border pt-3"><summary className="cursor-pointer text-sm font-medium">{t('history',{count:history.length})}</summary><ul className="mt-3 space-y-2 text-sm text-muted-foreground">{history.map(row=><li key={row.id}>{label(row.choice)} · {date(row.startDate)} – {row.endDate?date(row.endDate):t('noEnd')} · {t('replaced')}</li>)}</ul></details>}
  </div>
 </Card>;
}
