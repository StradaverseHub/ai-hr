'use client';

import * as React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {useLocale,useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {IndependentHomeCard} from './home-card';
import {validateEmployeeHomeToday,type EmployeeHomeToday} from '@/lib/employee-home-today';
import {liveClockSeconds} from '@/lib/clock-elapsed';
import type {ClockingConfirmation} from '@/app/(app)/attendance/clock/clock-client';

type ClockComponent=typeof import('@/app/(app)/attendance/clock/clock-client').ClockPageClient;
type ClockState=React.ComponentProps<ClockComponent>['initial'];
function ClockLoading(){const t=useTranslations('employeeHome.today');return <p role="status" className="p-4 text-sm">{t('loadingClock')}</p>;}
const CanonicalClockFlow=dynamic(()=>import('@/app/(app)/attendance/clock/clock-client').then(module=>module.ClockPageClient),{ssr:false,loading:ClockLoading});

/** No sensor, camera, capture command or full clock history loads when Home opens. The existing
 * canonical clock interaction mounts only after an explicit button press for this own employment. */
export function HomeTodayCard({employmentId,employmentLabel,timeZone}:{employmentId:string;employmentLabel:string;timeZone:string}){
 const t=useTranslations('employeeHome.today'),clockText=useTranslations('attendance.clock'),locale=useLocale();
 const [revision,setRevision]=React.useState(0),[intent,setIntent]=React.useState<'in'|'out'|null>(null),[confirmed,setConfirmed]=React.useState<ClockingConfirmation|null>(null);
 const actionRef=React.useRef<HTMLButtonElement|null>(null),regionRef=React.useRef<HTMLDivElement|null>(null);
 const restoreFocus=React.useCallback(()=>{(actionRef.current??regionRef.current)?.focus();},[]);
 const read=React.useCallback(async(signal:AbortSignal):Promise<EmployeeHomeToday>=>{
  const response=await fetch('/api/home/today?'+new URLSearchParams({employmentId}),{signal,cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw Error('Your Day unavailable.');return validateEmployeeHomeToday(await response.json(),employmentId);
 },[employmentId]);
 React.useEffect(()=>{
  const refresh=()=>{if(document.visibilityState==='visible'&&intent===null)setRevision(value=>value+1);};
  const timer=setInterval(refresh,60000);window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
 },[intent]);
 const complete=React.useCallback((receipt:ClockingConfirmation)=>{setConfirmed(receipt);setIntent(null);setRevision(value=>value+1);},[]);
 const dismiss=React.useCallback(()=>{setIntent(null);setRevision(value=>value+1);},[]);
 const start=React.useCallback((direction:'in'|'out')=>{setConfirmed(null);setIntent(direction);},[]);
 const recorded=confirmed?new Intl.DateTimeFormat(locale,{timeZone,hour:'2-digit',minute:'2-digit'}).format(new Date(confirmed.recordedAt)):null;
 return <>
  {confirmed&&<p role="status" className="mb-3 rounded-lg border p-3 text-sm">{clockText(confirmed.direction==='in'?'savedIn':'savedOut',{time:recorded!})}</p>}
  <IndependentHomeCard card="today" title={t('title')} labels={{loading:t('loading'),failed:t('failed'),timeout:t('timeout'),retry:t('retry'),refresh:t('refresh')}} regionRef={regionRef}
   requestKey={`${employmentId}:${locale}:${revision}`} read={read}>{value=><TodayFacts value={value} timeZone={timeZone} onClock={start} actionRef={actionRef}/>}</IndependentHomeCard>
  {intent&&<HomeClockDialog key={`${employmentId}:${intent}`} employmentId={employmentId} employmentLabel={employmentLabel} intent={intent} onSaved={complete} onClose={dismiss} onRestoreFocus={restoreFocus}/>}
 </>;
}

function TodayFacts({value,timeZone,onClock,actionRef}:{value:EmployeeHomeToday;timeZone:string;onClock:(direction:'in'|'out')=>void;actionRef:React.Ref<HTMLButtonElement>}){
 const t=useTranslations('employeeHome.today'),clockText=useTranslations('attendance.clock'),locale=useLocale();
 const [now,setNow]=React.useState(()=>Date.parse(value.serverNow));
 React.useEffect(()=>{
  const server=Date.parse(value.serverNow),start=performance.now();setNow(server);
  const timer=setInterval(()=>setNow(server+performance.now()-start),1000);return()=>clearInterval(timer);
 },[value.serverNow]);
 const clock=value.clock,seconds=clock?liveClockSeconds({...clock,serverNow:value.serverNow},now):0;
 const number=new Intl.NumberFormat(locale,{minimumIntegerDigits:2,useGrouping:false});
 const elapsed=number.format(Math.floor(seconds/3600))+':'+number.format(Math.floor(seconds%3600/60));
 const time=new Intl.DateTimeFormat(locale,{timeZone,hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(now));
 const date=(day:string)=>new Intl.DateTimeFormat(locale,{weekday:'long',day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(day+'T00:00:00Z'));
 const dayOff=clock&&!clock.clockedIn&&(value.leavePresence==='full_day'||value.dayKind==='holiday');
 const correction='/attendance/my-records/'+encodeURIComponent(clock?.date??value.businessDate)+'?'+new URLSearchParams({employmentId:value.employmentId,home:'1'});
 return <div className="space-y-4">
  <div><p className="font-mono text-3xl tabular-nums" aria-label={t('currentTime')}>{time}</p><p className="mt-1 break-words text-xs text-muted-foreground">{t('displayZone',{zone:timeZone})}</p></div>
  {clock?<>
   <dl className="space-y-3 text-sm">
    <div><dt className="text-muted-foreground">{t('shift')}</dt><dd className="mt-1 font-medium">{clock.shift.code?`${clock.shift.code} · `:''}{clock.shift.start&&clock.shift.end?`${clock.shift.start.slice(0,5)} – ${clock.shift.end.slice(0,5)}`:t('noShift')}{clock.crossesMidnight&&<span className="block text-xs text-muted-foreground">{t('overnight')}</span>}</dd></div>
    <div><dt className="text-muted-foreground">{t('locations')}</dt><dd className="mt-1 break-words font-medium">{value.workLocations.names.length?value.workLocations.names.join(' · '):t('noLocation')}{value.workLocations.total>value.workLocations.names.length&&<span className="block text-xs">{t('moreLocations',{count:value.workLocations.total-value.workLocations.names.length})}</span>}</dd></div>
   </dl>
   {clock.clockedIn?<div className="rounded-lg bg-muted/50 p-3 text-sm"><p>{t('clockedInAt',{time:new Intl.DateTimeFormat(locale,{timeZone,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(clock.openSince!))})}</p><p className="mt-2 text-xl font-semibold tabular-nums">{elapsed}</p><p className="mt-1 text-xs text-muted-foreground">{t('clockedTime')}</p></div>:
    <p className="text-sm text-muted-foreground">{dayOff?t(value.leavePresence==='full_day'?'leaveDayOff':'holidayDayOff'):t('notClockedIn')}</p>}
   {value.leavePresence&&clock.clockedIn&&<p className="text-xs text-muted-foreground">{t('leaveRecorded')}</p>}
   {value.leavePresence==='part_day'&&!clock.clockedIn&&<p className="text-xs text-muted-foreground">{t('partialLeave')}</p>}
   {!dayOff&&<Button ref={actionRef} type="button" className="min-h-11 w-full" onClick={()=>onClock(clock.clockedIn?'out':'in')}>{clockText(clock.clockedIn?'clockOut':'clockIn')}</Button>}
   <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm"><Link href={correction} className="inline-flex min-h-11 items-center text-primary underline underline-offset-4">{t('correction')}</Link><Link href={'/attendance/clock?'+new URLSearchParams({employmentId:value.employmentId})} className="inline-flex min-h-11 items-center text-primary underline underline-offset-4">{t('openClock')}</Link></div>
  </>:<p className="text-sm text-muted-foreground">{t('clockUnavailable')}</p>}
  {value.payrollEnabled&&<p className="border-t pt-3 text-sm leading-relaxed">{value.payday?t(value.payday.daysAway===0?'paydayToday':value.payday.daysAway===1?'paydayTomorrow':'paydayIn',{date:date(value.payday.date),days:value.payday.daysAway}):t('noPayday')}</p>}
 </div>;
}

function HomeClockDialog({employmentId,employmentLabel,intent,onSaved,onClose,onRestoreFocus}:{employmentId:string;employmentLabel:string;intent:'in'|'out';onSaved:(receipt:ClockingConfirmation)=>void;onClose:()=>void;onRestoreFocus:()=>void}){
 const t=useTranslations('employeeHome.today'),clockText=useTranslations('attendance.clock');
 const [attempt,setAttempt]=React.useState(0),[busy,setBusy]=React.useState(false),busyRef=React.useRef(false);
 const reportBusy=React.useCallback((value:boolean)=>{busyRef.current=value;setBusy(value);},[]);
 const [loaded,setLoaded]=React.useState<{state:'loading'}|{state:'failed'}|{state:'ready';value:ClockState}>({state:'loading'});
 React.useEffect(()=>{
  const controller=new AbortController();let live=true;setLoaded({state:'loading'});
  const timeout=setTimeout(()=>{if(live){controller.abort();setLoaded({state:'failed'});}},15000);
  void fetch('/api/attendance/today?'+new URLSearchParams({employmentId}),{signal:controller.signal,cache:'no-store',credentials:'same-origin'}).then(async response=>{
   if(!response.ok)throw Error('Clock unavailable.');const value:ClockState=await response.json();
   if(typeof value.clockContext!=='string'||!value.clockContext||typeof value.removalBaseline!=='string'||!Number.isFinite(Date.parse(value.serverNow))
    ||!/^\d{4}-\d{2}-\d{2}$/.test(value.date)||typeof value.clockedIn!=='boolean'||!Number.isFinite(value.workedSeconds)||!value.shift
    ||typeof value.locationValid!=='boolean'||typeof value.geofencingRequired!=='boolean'||!['required','optional','not_required'].includes(value.attendancePhotoSetting)
    ||!Array.isArray(value.captures)||!Array.isArray(value.legacy))throw Error('Clock unavailable.');
   if(!controller.signal.aborted){clearTimeout(timeout);setLoaded({state:'ready',value});}
  }).catch(()=>{if(!controller.signal.aborted){clearTimeout(timeout);setLoaded({state:'failed'});}});
  return()=>{live=false;clearTimeout(timeout);controller.abort();};
 },[employmentId,attempt]);
 return <Dialog.Root open onOpenChange={open=>{if(!open&&!busyRef.current)onClose();}}><Dialog.Portal>
  <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/>
  <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-5xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-4 shadow-xl sm:p-6"
   onCloseAutoFocus={event=>{event.preventDefault();onRestoreFocus();}} onEscapeKeyDown={event=>{if(busyRef.current)event.preventDefault();}} onPointerDownOutside={event=>{if(busyRef.current)event.preventDefault();}}>
   <div className="mb-4 flex items-start justify-between gap-3"><div className="min-w-0"><Dialog.Title className="text-lg font-semibold">{clockText(intent==='in'?'clockIn':'clockOut')}</Dialog.Title><Dialog.Description className="mt-1 break-words text-sm text-muted-foreground">{employmentLabel}</Dialog.Description></div><Dialog.Close asChild><Button type="button" variant="outline" disabled={busy} className="min-h-11">{t('close')}</Button></Dialog.Close></div>
   {loaded.state==='loading'?<ClockLoading/>:loaded.state==='failed'?<div className="space-y-3"><p role="alert" className="text-sm">{t('clockFailed')}</p><Button type="button" variant="outline" className="min-h-11" onClick={()=>setAttempt(value=>value+1)}>{t('retry')}</Button></div>:
    <CanonicalClockFlow initial={loaded.value} shiftName={null} employmentId={employmentId} embedded initialAction={intent} onSaved={onSaved} onBusyChange={reportBusy}/>}
  </Dialog.Content>
 </Dialog.Portal></Dialog.Root>;
}
