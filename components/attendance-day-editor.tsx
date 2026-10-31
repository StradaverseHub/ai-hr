'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import type { AttendanceDayEditorData } from '@/packs/attendance/service';
import { saveAttendanceDayScheduleAction, saveAttendanceDayChangesAction, adminCorrectAttendanceDayAction, rejectAttendanceDayApplicationAction } from '@/app/attendance/individual/[date]/actions';
import { Button, ErrorBanner, inputCls, tableWrapCls, thCls, theadCls, tbodyCls } from './ui';
import { fmtMin } from './attendance-format';

type Props={data:AttendanceDayEditorData;employmentId:string;date:string};
function Context({data,employmentId,date,children}:{data:AttendanceDayEditorData;employmentId:string;date:string;children?:ReactNode}){
  return <><input type="hidden" name="employmentId" value={employmentId}/><input type="hidden" name="date" value={date}/><input type="hidden" name="baseline" value={data.baseline}/>{children}</>;
}
function SaveFields({data,disabled}:{data:AttendanceDayEditorData;disabled:boolean}){
  const t=useTranslations('attendance.dayEdit');
  return <><label className="block space-y-1 text-sm"><span>{t('reason')}</span><input name="reason" required maxLength={500} disabled={disabled} className={inputCls}/></label>
    {data.processed&&<label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirmPayrollRecalculation" required disabled={disabled}/>{t('payrollConsent')}</label>}
    {data.closed&&<p className="text-sm text-destructive">{t('closed')}</p>}{data.self&&<p className="text-sm text-muted-foreground">{t('self')}</p>}</>;
}
export function AttendanceDateSchedule(props:Props){
  const t=useTranslations('attendance.dayEdit');
  const [open,setOpen]=useState(false),[saving,setSaving]=useState(false);
  return <Dialog.Root open={open} onOpenChange={next=>{if(!saving)setOpen(next);}}>
    <Dialog.Trigger asChild><Button type="button" variant="outline" size="sm" disabled={props.data.closed||props.data.self} title={props.data.closed?t('closed'):props.data.self?t('self'):undefined}>{t('edit')}</Button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/>
      <Dialog.Content onEscapeKeyDown={e=>{if(saving)e.preventDefault();}} onInteractOutside={e=>{if(saving)e.preventDefault();}} className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-lg">
        <Dialog.Title className="text-lg font-semibold">{t('editSchedule')}</Dialog.Title>
        <Dialog.Description className="mt-1 text-sm text-muted-foreground">{props.date} · {t('dateOnly')}</Dialog.Description>
        <AttendanceDateScheduleForm {...props} onSaved={()=>setOpen(false)} onCancel={()=>setOpen(false)} onPending={setSaving}/>
      </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
function AttendanceDateScheduleForm({data,employmentId,date,onSaved,onCancel,onPending}:Props&{onSaved:()=>void;onCancel:()=>void;onPending:(pending:boolean)=>void}){
  const t=useTranslations('attendance.dayEdit'),router=useRouter();
  const [shift,setShift]=useState(data.shiftId??''),[kind,setKind]=useState(data.dayKind??''),[error,setError]=useState(''),[saved,setSaved]=useState(false),[pending,start]=useTransition();
  const disabled=data.closed||data.self||pending;
  const submit=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();const fd=new FormData(e.currentTarget);onPending(true);start(async()=>{try{setError('');setSaved(false);const r=await saveAttendanceDayScheduleAction(fd);if(r.ok){setSaved(true);toast.success(t('saved'));router.refresh();onSaved();}else setError(r.message);}catch{setError(t('saveFailed'));}finally{onPending(false);}});};
  const selected=data.shifts.find(s=>s.id===shift);
  return <form onSubmit={submit} className="space-y-3 border-t border-border p-4" data-day-edit="schedule">
    <Context data={data} employmentId={employmentId} date={date}><input type="hidden" name="kind" value="schedule"/></Context>
    <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm"><span className="block">{t('shift')}</span><select name="shiftId" className={inputCls} value={shift} disabled={disabled} onChange={e=>{setSaved(false);setShift(e.target.value);}}>
      <option value="">{t('automaticSchedule')}</option>{data.shiftId&&!data.shifts.some(s=>s.id===data.shiftId)&&<option value={data.shiftId}>{data.schedule.shiftCode??'—'} · {t('currentShift')}</option>}
      {data.shifts.map(s=><option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></label>
      <label className="space-y-1 text-sm"><span className="block">{t('dayType')}</span><select name="dayKind" value={kind} className={inputCls} disabled={disabled||data.leave.length>0} onChange={e=>{setSaved(false);setKind(e.target.value);}}>
        <option value="">{t('automaticSchedule')}</option>{(['workday','off_day','rest_day','holiday'] as const).map(k=><option key={k} value={k}>{t(`kind.${k}`)}</option>)}</select></label></div>
    {data.leave.length>0&&<><input type="hidden" name="dayKind" value={data.dayKind??''}/><p className="rounded-md bg-muted p-3 text-sm">{t('onLeave')}: {data.leave.map(l=>`${l.name} (${l.duration})`).join(', ')} · <a className="text-primary underline" href={`/admin/personnel/${employmentId}?tab=leave`}>{t('manageLeave')}</a><span className="mt-1 block text-muted-foreground">{t('leaveOwner')}</span></p></>}
    <p className="text-xs text-muted-foreground">{t('beforeAfter',{before:`${data.schedule.shiftCode??'—'} · ${t(`kind.${data.schedule.dayKind}`)}`,after:`${selected?.code??(shift?data.schedule.shiftCode:t('automaticSchedule'))} · ${kind?t(`kind.${kind}`):t('automaticSchedule')}`})}</p>
    <SaveFields data={data} disabled={disabled}/><ErrorBanner message={error}/>{saved&&<p role="status" className="text-sm text-emerald-700">{t('saved')}</p>}
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{t('dateOnly')}</p><div className="flex gap-2"><Button type="button" variant="outline" disabled={pending} onClick={onCancel}>{t('cancel')}</Button><Button type="submit" disabled={disabled}>{t('saveSchedule')}</Button></div></div>
  </form>;
}

export function AttendanceDateOvertime({data,employmentId,date}:Props){
  const t=useTranslations('attendance.dayEdit'),router=useRouter(),locale=useLocale();
  const [modes,setModes]=useState<Record<string,'auto'|'manual'>>(()=>Object.fromEntries(data.rows.map(r=>[r.key,r.manual?'manual':'auto'])));
  const [values,setValues]=useState<Record<string,string>>(()=>Object.fromEntries(data.rows.map(r=>[r.key,String(r.manual?.minutes??r.calculatedMinutes)])));
  const [dirty,setDirty]=useState<Set<string>>(new Set()),[error,setError]=useState(''),[pending,start]=useTransition();
  const disabled=data.closed||data.self||pending;
  const change=(key:string,mode:'auto'|'manual')=>{setModes({...modes,[key]:mode});setDirty(new Set([...dirty,key]));};
  const submit=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();const fd=new FormData(e.currentTarget);fd.set('rows',JSON.stringify([...dirty].map(key=>({key,minutes:modes[key]==='auto'?null:Number(values[key])}))));
    start(async()=>{setError('');const r=await saveAttendanceDayChangesAction(fd);if(r.ok){setDirty(new Set());toast.success(t('saved'));router.refresh();}else setError(r.message);});};
  return <form onSubmit={submit} className="space-y-4 p-4" data-day-edit="overtime">
    <Context data={data} employmentId={employmentId} date={date}><input type="hidden" name="kind" value="overtime"/></Context>
    {!data.complete&&<p className="text-sm text-muted-foreground">{t('completeDay')}</p>}
    {data.approvedOtMinutes!=null&&<p className="text-sm text-muted-foreground">{t('approved',{minutes:fmtMin(data.approvedOtMinutes)})}</p>}
    <div className={tableWrapCls}><table className="w-full text-sm"><thead className={theadCls}><tr>{['otRow','calculated','method','manualMinutes','effective'].map(k=><th key={k} className={thCls}>{t(k)}</th>)}</tr></thead>
      <tbody className={tbodyCls}>{data.rows.map(row=><tr key={row.key}>
        <td className="max-w-72 px-3 py-3 align-top">{row.orphan?<p className="text-xs text-destructive">{t('orphan')}</p>:<p>{row.ratePattern==='flat'?t('flat'):`OT ${row.rate}×`} · {t('band',{from:row.fromMinutes,to:row.toMinutes??t('unlimited')})}</p>}
          {row.manual&&<p className="mt-1 text-xs text-muted-foreground">{t('original',{minutes:fmtMin(row.manual.calculatedMinutes),date:new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium'}).format(new Date(row.manual.recordedAt))})}</p>}</td>
        <td className="px-3 py-3 align-top tabular-nums">{data.complete&&!row.orphan?fmtMin(row.calculatedMinutes):'—'}</td>
        <td className="px-3 py-3 align-top"><select aria-label={t('method')} className={inputCls} value={modes[row.key]} disabled={disabled} onChange={e=>change(row.key,e.target.value as 'auto'|'manual')}>
          <option value="auto">{t('auto')}</option><option value="manual" disabled={!data.complete||row.orphan}>{t('manual')}</option></select>
          {row.manual&&<button type="button" className="mt-1 text-xs text-primary underline" disabled={disabled} onClick={()=>change(row.key,'auto')}>{t('resetAuto')}</button>}</td>
        <td className="px-3 py-3 align-top"><input aria-label={t('manualMinutes')} type="number" min={0} max={1440} step={1} required={modes[row.key]==='manual'} value={values[row.key]} disabled={disabled||modes[row.key]!=='manual'||!data.complete||row.orphan} className={`${inputCls} w-28`} onChange={e=>{setValues({...values,[row.key]:e.target.value});setDirty(new Set([...dirty,row.key]));}}/></td>
        <td className="px-3 py-3 align-top tabular-nums">{fmtMin(dirty.has(row.key)?modes[row.key]==='manual'?Number(values[row.key]):row.autoEffectiveMinutes:row.effectiveMinutes)}</td>
      </tr>)}</tbody></table></div>
    <p className="text-xs text-muted-foreground">{t('manualHelp')}</p><SaveFields data={data} disabled={disabled}/><ErrorBanner message={error}/>
    <div className="flex justify-end"><Button type="submit" disabled={disabled||dirty.size===0}>{t('saveOvertime')}</Button></div>
    {data.history.length>0&&<details className="border-t border-border pt-3"><summary className="cursor-pointer text-sm font-medium">{t('history')}</summary><ol className="mt-2 divide-y divide-border">{data.history.map(e=><li key={e.id} className="py-2 text-xs"><p>{new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium',timeStyle:'short'}).format(new Date(e.at))} · {e.actor??t('administrator')}</p><p>{String((e.payload as Record<string,unknown>)?.reason??'')}</p></li>)}</ol></details>}
  </form>;
}

export function AttendanceApplicationDecision({data,employmentId,date,application,children}:Props&{application:AttendanceDayEditorData['applications'][number];children?:ReactNode}){
  const t=useTranslations('attendance.dayEdit'),router=useRouter(),[error,setError]=useState(''),[result,setResult]=useState(''),[pending,start]=useTransition();
  const disabled=data.closed||data.self||pending;
  const staged=!!application.clockChanges||(application.workflow?.currentStage??0)>0;
  const submit=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();const fd=new FormData(e.currentTarget);const reject=(e.nativeEvent as SubmitEvent).submitter?.getAttribute("value")==="reject";start(async()=>{setError('');setResult('');const r=await (reject?rejectAttendanceDayApplicationAction(fd):adminCorrectAttendanceDayAction(fd));if(r.ok){setResult(reject?t('rejectedSaved'):r.pending?t('pendingStage'):t('approvedSaved'));router.refresh();}else setError(r.message);});};
  return <form onSubmit={submit} className="space-y-3 border-t border-border pt-3">
    <Context data={data} employmentId={employmentId} date={date}><input type="hidden" name="correctionId" value={application.id}/><input type="hidden" name="stage" value={application.workflow?.currentStage??''}/></Context>
    {staged?<p className="text-xs text-muted-foreground">{t('frozenStage')}</p>:<div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-sm"><span className="block">{t('requestedIn')}</span><input type="time" name="checkIn" defaultValue={(application.adminAmendment?.checkIn??application.proposedCheckIn)?.slice(0,5)??''} disabled={disabled} className={inputCls}/></label>
      <label className="space-y-1 text-sm"><span className="block">{t('requestedOut')}</span><input type="time" name="checkOut" defaultValue={(application.adminAmendment?.checkOut??application.proposedCheckOut)?.slice(0,5)??''} disabled={disabled} className={inputCls}/></label></div>}
    {staged&&<><input type="hidden" name="checkIn" value={application.adminAmendment?.checkIn??application.proposedCheckIn??''}/><input type="hidden" name="checkOut" value={application.adminAmendment?.checkOut??application.proposedCheckOut??''}/></>}
    <label className="block space-y-1 text-sm"><span>{t('administratorReason')}</span><input name="reason" required maxLength={500} disabled={disabled} className={inputCls}/></label>
    {data.processed&&<label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirmPayrollRecalculation" required disabled={disabled}/>{t('payrollConsent')}</label>}
    <ErrorBanner message={error}/>{result&&<p role="status" className="text-sm text-primary">{result}</p>}
    <div className="flex flex-wrap items-center justify-between gap-2">{children}<div className="flex gap-2"><Button type="submit" name="decision" value="reject" formNoValidate variant="outline" disabled={disabled}>{t('reject')}</Button><Button type="submit" disabled={disabled}>{t('correctApprove')}</Button></div></div>
    <p className="text-xs text-muted-foreground">{t('approvalHelp')}</p>
  </form>;
}
