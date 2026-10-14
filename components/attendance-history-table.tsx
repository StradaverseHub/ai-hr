'use client';
import { useRef, useState, useTransition } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import type { AttendanceHistoryRow } from '@/packs/attendance/service';
import { attendanceHistoryDate } from '@/lib/attendance-history-filter';
import { attendanceHistoryBulkAction } from '@/app/attendance/application-history/actions';
import { Button, ErrorBanner, inputCls, tableWrapCls, tbodyCls, thCls } from './ui';

export function AttendanceHistoryTable({rows,returnTo}:{rows:AttendanceHistoryRow[];returnTo:string}){
  const t=useTranslations('attendanceHistory'),locale=useLocale(),router=useRouter();
  const [selected,setSelected]=useState<string[]>([]),[decision,setDecision]=useState<'approved'|'rejected'|null>(null),[reason,setReason]=useState(''),[error,setError]=useState(''),[pending,start]=useTransition();
  const [results,setResults]=useState<(Awaited<ReturnType<typeof attendanceHistoryBulkAction>>[number]&{employee:string;attendanceDate:string})[]>([]);
  const inFlight=useRef(false), trigger=useRef<HTMLButtonElement|null>(null);
  const eligible=rows.filter(r=>r.selectable),all=eligible.length>0&&eligible.every(r=>selected.includes(r.id));
  function submit(){
    if(inFlight.current||!decision)return;
    inFlight.current=true;
    const chosen=rows.filter(r=>selected.includes(r.id));
    const items=chosen.map(r=>({id:r.id,stage:r.currentStage}));
    start(async()=>{try{setError('');const outcomes=await attendanceHistoryBulkAction({items,decision,reason});setResults(outcomes.map(outcome=>{const row=chosen.find(r=>r.id===outcome.id);return {...outcome,employee:row?.employee??'',attendanceDate:row?.attendanceDate??''};}));setSelected([]);setDecision(null);router.refresh();}catch(e){setError(e instanceof Error?e.message:t('bulkFailed'));}finally{inFlight.current=false;}});
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-3"><span className="text-sm" aria-live="polite">{t('selected',{count:selected.length})}</span>{(['approved','rejected'] as const).map(d=><Button key={d} type="button" variant={d==='approved'?'default':'outline'} disabled={!selected.length||pending} onClick={e=>{trigger.current=e.currentTarget;setReason('');setError('');setDecision(d);}}>{t(d==='approved'?'approveSelected':'rejectSelected')}</Button>)}</div>
    <div className={tableWrapCls}><table className="w-full text-sm"><thead className="bg-white! text-slate-900!"><tr><th className={thCls}><input type="checkbox" checked={all} disabled={!eligible.length||pending} aria-label={t('selectPage')} onChange={e=>setSelected(e.target.checked?eligible.map(r=>r.id):[])}/></th>{['applicationType','employee','company','attendanceDate','submissionDate','status','progress','actions'].map(k=><th className={`${thCls} text-slate-900!`} key={k}>{t(k)}</th>)}</tr></thead>
      <tbody className={tbodyCls}>{rows.map(row=><tr key={row.id}><td className="p-3"><input type="checkbox" aria-label={t('selectEmployee',{name:row.employee})} title={row.selectable?t('selectEmployee',{name:row.employee}):t('ineligible')} checked={selected.includes(row.id)} disabled={!row.selectable||pending} onChange={e=>setSelected(ids=>e.target.checked?[...ids,row.id]:ids.filter(id=>id!==row.id))}/></td>
        <td className="p-3">{t(`types.${row.applicationType}`)}<span className="block text-xs text-muted-foreground">{t(`subtypes.${row.requestKind??'unknown'}`)}</span></td>
        <td className="min-w-40 max-w-64 break-words p-3">{row.employee}<span className="block text-xs text-muted-foreground">{row.employeeCode}</span></td><td className="min-w-32 max-w-64 break-words p-3">{row.company}</td>
        <td className="whitespace-nowrap p-3 tabular-nums">{attendanceHistoryDate(row.attendanceDate)}</td><td className="p-3">{new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium',timeStyle:'short'}).format(new Date(row.submittedAt))}</td>
        <td className="p-3">{t(`statuses.${row.status}`)}</td><td className="p-3">{row.stages?row.status==='pending'&&row.currentStage!=null&&row.stages[row.currentStage]?<><span>{row.stages[row.currentStage].name}</span><span className="block text-xs text-muted-foreground">{row.stages[row.currentStage].approvers.map(a=>a.kind==='hr_admin'?t('hrApprover'):a.name).join(' / ')}</span></>:row.templateName:t('legacy')}</td><td className="p-3"><Link className="text-primary underline" href={`/attendance/application-history/${row.id}?returnTo=${encodeURIComponent(returnTo)}`}>{t('view')}</Link></td></tr>)}</tbody></table>{!rows.length&&<p className="p-5 text-muted-foreground">{t('empty')}</p>}</div>
    {results.length>0&&<section aria-live="polite" className="rounded-lg border border-border p-4"><h2 className="font-semibold">{t('results')}</h2><ul className="mt-2 space-y-2 text-sm">{results.map((r,i)=><li key={r.id+i}>{r.employee} · {r.attendanceDate?attendanceHistoryDate(r.attendanceDate):''} · {r.status==='failed'?r.message:r.status==='pending'?t('furtherApproval'):t(`statuses.${r.status}`)}</li>)}</ul></section>}
    <Dialog.Root open={decision!==null} onOpenChange={open=>{if(!open&&!pending)setDecision(null);}}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/><Dialog.Content onCloseAutoFocus={e=>{e.preventDefault();trigger.current?.focus();}} onEscapeKeyDown={e=>{if(pending)e.preventDefault();}} onInteractOutside={e=>{if(pending)e.preventDefault();}} className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-lg"><Dialog.Title className="font-semibold">{t(decision==='rejected'?'rejectSelected':'approveSelected')}</Dialog.Title><Dialog.Description className="mt-2 text-sm text-muted-foreground">{t('confirmSelected',{count:selected.length})}</Dialog.Description><ul className="mt-3 max-h-40 space-y-1 overflow-y-auto text-sm">{rows.filter(row=>selected.includes(row.id)).map(row=><li key={row.id}>{row.employee} · {attendanceHistoryDate(row.attendanceDate)}</li>)}</ul><form className="mt-4 space-y-4" onSubmit={e=>{e.preventDefault();submit();}}><label className="block text-sm">{t('remarks')}<textarea required={decision==='rejected'} maxLength={1000} value={reason} disabled={pending} onChange={e=>setReason(e.target.value)} className={inputCls}/></label><ErrorBanner message={error}/><div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={pending} onClick={()=>setDecision(null)}>{t('cancel')}</Button><Button type="submit" disabled={pending}>{t('confirm')}</Button></div></form></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
