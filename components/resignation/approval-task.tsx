'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {Button,inputCls} from '@/components/ui';
import type {ResignationJourneyCommand,ResignationTaskView} from '@/lib/resignation-journey';
export function ResignationApprovalTask({task,busy,command}:{task:ResignationTaskView;busy:boolean;command:(command:ResignationJourneyCommand)=>Promise<boolean>}){
 const t=useTranslations('resignationJourney'),a=useTranslations('approvals'),[reason,setReason]=useState('');
 return <section className="space-y-3 rounded-lg border p-4"><h4 className="font-medium">{task.title}</h4><Button disabled={busy} onClick={()=>command({type:'approvalTask',taskId:task.id,action:task.kind==='approve'?'approve':'review'})}>{t(task.kind==='approve'?'approve':'review')}</Button>{task.kind==='approve'&&<div className="space-y-2"><label className="block space-y-1 text-sm"><span>{a('rejectReasonPlaceholder')}</span><textarea className={inputCls} rows={3} maxLength={4000} value={reason} disabled={busy} onChange={event=>setReason(event.target.value)}/></label><Button variant="destructive" disabled={busy||!reason.trim()} onClick={()=>command({type:'approvalTask',taskId:task.id,action:'reject',comment:reason.trim()})}>{a('reject')}</Button></div>}</section>;
}
