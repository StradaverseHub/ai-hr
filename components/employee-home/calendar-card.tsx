'use client';

import * as React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import Link from 'next/link';
import {useLocale,useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {IndependentHomeCard} from './home-card';
import {addMonths} from '@/lib/roster-month';
import {validateHomeCalendar,type EmployeeHomeCalendar,type HomeCalendarEntry} from '@/lib/employee-home-calendar';

type View='month'|'week'|'list';
const tones={leave:'border-primary/50 bg-primary/10 text-foreground',holiday:'border-amber-600/50 bg-amber-500/10 text-foreground',payday:'border-emerald-600/50 bg-emerald-500/10 text-foreground'};

export function HomeCalendarCard({employmentId,initialMonth,full=false}:{employmentId:string;initialMonth:string;full?:boolean}){
 const t=useTranslations('employeeHome.calendar'),locale=useLocale();
 const [month,setMonth]=React.useState(initialMonth),[view,setView]=React.useState<View>('month');
 const read=React.useCallback(async(signal:AbortSignal):Promise<EmployeeHomeCalendar>=>{
  const response=await fetch('/api/home/calendar?'+new URLSearchParams({employmentId,month}),{signal,cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw Error('Calendar unavailable.');
  return validateHomeCalendar(await response.json(),employmentId,month);
 },[employmentId,month]);
 const monthLabel=new Intl.DateTimeFormat(locale,{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(month+'-01T00:00:00Z'));
 return <IndependentHomeCard card="calendar" title={t('title')} labels={{loading:t('loading'),failed:t('failed'),timeout:t('timeout'),retry:t('retry'),refresh:t('refresh')}}
  requestKey={`${employmentId}:${month}:${locale}`} read={read}>{value=><div className="space-y-4">
   <div className="flex flex-wrap items-center justify-between gap-2">
    <h3 aria-live="polite" className="font-semibold">{monthLabel}</h3>
    <div className="flex flex-wrap gap-1">
     <Button type="button" variant="outline" className="min-h-11 px-3" onClick={()=>setMonth(addMonths(month,-1))}>{t('previous')}</Button>
     <Button type="button" variant="outline" className="min-h-11 px-3" onClick={()=>setMonth(value.today.slice(0,7))}>{t('today')}</Button>
     <Button type="button" variant="outline" className="min-h-11 px-3" onClick={()=>setMonth(addMonths(month,1))}>{t('next')}</Button>
    </div>
   </div>
   {full&&<div className="flex flex-wrap gap-2" role="group" aria-label={t('view')}>
    {(['month','week','list'] as const).map(option=><Button key={option} type="button" variant={view===option?'default':'outline'} className="min-h-11" aria-pressed={view===option} onClick={()=>setView(option)}>{t(option)}</Button>)}
   </div>}
   <CalendarDays key={`${month}:${value.weekStartsOn}`} value={value} view={full?view:'month'}/>
   <ul aria-label={t('legend')} className="flex flex-wrap gap-3 text-xs">
    <li className={'rounded border px-2 py-1 '+tones.leave}>{t('leave')}</li>
    <li className="rounded border border-dashed border-primary/50 px-2 py-1">{t('pending')}</li>
    <li className={'rounded border px-2 py-1 '+tones.holiday}>{t('holiday')}</li>
    {value.payrollEnabled&&<li className={'rounded border px-2 py-1 '+tones.payday}>{t('payday')}</li>}
   </ul>
   {value.payrollEnabled&&<p className="text-xs leading-relaxed text-muted-foreground">{t('paymentNote')}</p>}
   {!full&&<Link className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring" href={'/me/calendar?'+new URLSearchParams({employmentId,month})}>{t('full')}</Link>}
  </div>}</IndependentHomeCard>;
}

function CalendarDays({value,view}:{value:EmployeeHomeCalendar;view:View}){
 const t=useTranslations('employeeHome.calendar'),locale=useLocale();
 const initialDay=value.days.findIndex(day=>day.date===value.today);
 const [week,setWeek]=React.useState(initialDay>=0?Math.floor(initialDay/7):0);
 const fmtDate=(date:string)=>new Intl.DateTimeFormat(locale,{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(date+'T00:00:00Z'));
 function entryLabel(entry:HomeCalendarEntry){
  if(entry.kind==='leave')return `${t('leave')} · ${t(entry.status)} · ${t(entry.duration)}`;
  if(entry.kind==='holiday')return `${entry.name??t('holiday')}${entry.replacement?' · '+t('replacement'):''}${entry.tentative?' · '+t('tentative'):''}`;
  return t('payday');
 }
 const weekdayNames=Array.from({length:7},(_,offset)=>new Intl.DateTimeFormat(locale,{weekday:'short',timeZone:'UTC'})
  .format(new Date(Date.UTC(2024,0,7+(value.weekStartsOn+offset)%7))));
 const days=view==='week'?value.days.slice(week*7,week*7+7):view==='list'?value.days.filter(day=>day.date.startsWith(value.month)&&day.entries.length>0):value.days;
 return <div className="space-y-3">
  {view==='week'&&<div className="flex flex-wrap items-center justify-between gap-2">
   <Button type="button" variant="outline" className="min-h-11" disabled={week===0} onClick={()=>setWeek(index=>index-1)}>{t('previousWeek')}</Button>
   <span className="text-sm">{t('weekNumber',{number:week+1})}</span>
   <Button type="button" variant="outline" className="min-h-11" disabled={(week+1)*7>=value.days.length} onClick={()=>setWeek(index=>index+1)}>{t('nextWeek')}</Button>
  </div>}
  {view!=='list'&&<div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground" aria-hidden="true">{weekdayNames.map((name,index)=><span key={index}>{name}</span>)}</div>}
  {view==='list'&&days.length===0?<p className="text-sm text-muted-foreground">{t('empty')}</p>:
   <div className={view==='list'?'space-y-2':'grid grid-cols-7 gap-1'}>
    {days.map(day=><Dialog.Root key={day.date}>
     <Dialog.Trigger asChild><button type="button" aria-label={fmtDate(day.date)+(day.entries.length?' · '+day.entries.map(entryLabel).join('; '):'')}
      aria-current={day.date===value.today?'date':undefined}
      className={'min-w-0 rounded-md border p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring '+(view==='list'?'flex min-h-14 flex-wrap items-center gap-3 p-3':'min-h-24')
       +(day.date===value.today?' ring-2 ring-primary ring-offset-1 ring-offset-background':'')+(day.date.startsWith(value.month)?'':' bg-muted/40 text-muted-foreground')}>
      <span className="block text-sm font-medium tabular-nums">{view==='list'?fmtDate(day.date):Number(day.date.slice(-2))}</span>
      <span className="mt-1 block space-y-1">{day.entries.map((entry,index)=><span key={index}
       className={'block break-words rounded border px-0.5 py-1 text-[10px] leading-tight '+tones[entry.kind]+(entry.kind==='leave'&&entry.status==='pending'?' border-dashed bg-transparent':'')}>
       {view==='list'?entryLabel(entry):<>{t(entry.kind)}{entry.kind==='leave'&&entry.status==='pending'&&<span className="block">{t('pending')}</span>}</>}
      </span>)}</span>
     </button></Dialog.Trigger>
     <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/>
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl">
       <Dialog.Title className="pr-4 text-base font-semibold">{fmtDate(day.date)}</Dialog.Title>
       <Dialog.Description className="mt-2 text-sm text-muted-foreground">{t('details')}</Dialog.Description>
       {day.entries.length?<ul className="my-4 space-y-2 text-sm">{day.entries.map((entry,index)=><li key={index} className={'rounded border p-3 '+tones[entry.kind]}>{entryLabel(entry)}</li>)}</ul>:
        <p className="my-4 text-sm">{t('emptyDay')}</p>}
       <div className="flex flex-wrap justify-between gap-3">
        {day.canRequestLeave&&<Link className="inline-flex min-h-11 items-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring" href={'/leave?'+new URLSearchParams({apply:'1',start:day.date,employmentId:value.employmentId})}>{t('requestLeave')}</Link>}
        <Dialog.Close asChild><Button type="button" variant="outline" className="min-h-11">{t('close')}</Button></Dialog.Close>
       </div>
      </Dialog.Content>
     </Dialog.Portal>
    </Dialog.Root>)}
   </div>}
 </div>;
}
