'use client';
import {useState,useTransition,type FormEvent} from 'react';
import {useTranslations} from 'next-intl';
import Link from 'next/link';
import {Button,Card,inputCls} from './ui';
import {submitUnclockedAttendanceWorkAction} from '@/app/(app)/attendance/individual/[date]/actions';
export function AttendanceUnclockedWork({employmentId,date}:{employmentId:string;date:string}){
 const t=useTranslations('attendance.unclockedWork'),[rows,setRows]=useState([0]),[next,setNext]=useState(1),
  [positioned,setPositioned]=useState(false),[requestedRows,setRequestedRows]=useState([0]),[requestedNext,setRequestedNext]=useState(1),
  [error,setError]=useState(''),[saved,setSaved]=useState<string|null>(null),[pending,start]=useTransition();
 function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=new FormData(event.currentTarget);setError('');
  start(async()=>{const result=await submitUnclockedAttendanceWorkAction(form);if(result.ok)setSaved(result.correctionId);else setError(result.message);});}
 return <Card className="space-y-4 p-5" data-unclocked-work-form>
  <h2 className="font-semibold">{t('title')}</h2><p className="text-sm text-muted-foreground">{t('help')}</p>
  {saved?<p role="status" className="text-sm"><Link className="text-primary underline" href={'/attendance/application-history/'+encodeURIComponent(saved)}>{t('submitted')}</Link></p>:
  <form onSubmit={submit} className="space-y-4">
   <input type="hidden" name="employmentId" value={employmentId}/><input type="hidden" name="date" value={date}/>
   <p className="text-sm">{t('timeZone')}</p>
   <fieldset disabled={pending} className="space-y-3"><legend className="mb-2 text-sm font-medium">{t('intervals')}</legend>
    {rows.map((id,index)=><div key={id} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
     <label className="space-y-1 text-sm">{t('start',{number:index+1})}<input className={inputCls} type="datetime-local" name="workStart" required step="0.001"/></label>
     <label className="space-y-1 text-sm">{t('end',{number:index+1})}<input className={inputCls} type="datetime-local" name="workEnd" required step="0.001"/></label>
     {rows.length>1&&<Button type="button" variant="outline" className="sm:col-span-2" onClick={()=>setRows(rows.filter(row=>row!==id))}>{t('remove',{number:index+1})}</Button>}
    </div>)}
    {rows.length<16&&<Button type="button" variant="outline" onClick={()=>{setRows([...rows,next]);setNext(next+1);}}>{t('add')}</Button>}
   </fieldset>
   <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="useRequestedPositions" checked={positioned} onChange={event=>setPositioned(event.target.checked)} disabled={pending} className="mt-1 size-4"/>{t('positionedRequest')}</label>
   {positioned&&<fieldset disabled={pending} className="space-y-3"><legend className="mb-2 text-sm font-medium">{t('requestedIntervals')}</legend>
    <p className="text-sm text-muted-foreground">{t('requestedHelp')}</p>
    {requestedRows.map((id,index)=><div key={id} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
     <label className="space-y-1 text-sm">{t('start',{number:index+1})}<input className={inputCls} type="datetime-local" name="requestedStart" required step="0.001"/></label>
     <label className="space-y-1 text-sm">{t('end',{number:index+1})}<input className={inputCls} type="datetime-local" name="requestedEnd" required step="0.001"/></label>
     {requestedRows.length>1&&<Button type="button" variant="outline" className="sm:col-span-2" onClick={()=>setRequestedRows(requestedRows.filter(row=>row!==id))}>{t('remove',{number:index+1})}</Button>}
    </div>)}
    {requestedRows.length<16&&<Button type="button" variant="outline" onClick={()=>{setRequestedRows([...requestedRows,requestedNext]);setRequestedNext(requestedNext+1);}}>{t('add')}</Button>}
   </fieldset>}
   <label className="block space-y-1 text-sm">{t('requestedMinutes')}<input className={inputCls} name="requestedOtMinutes" type="number" min="1" max="4320" step="1" required disabled={pending}/></label>
   <label className="block space-y-1 text-sm">{t('reason')}<textarea className={inputCls+' min-h-24'} name="reason" required maxLength={500} disabled={pending}/></label>
   <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="completeWorkedDay" required disabled={pending} className="mt-1 size-4"/>{t('complete')}</label>
   {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
   <Button type="submit" disabled={pending}>{t(pending?'submitting':'submit')}</Button>
  </form>}
 </Card>;
}
