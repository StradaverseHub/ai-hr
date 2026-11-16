'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {Button,inputCls} from '@/components/ui';
import type {ResignationCaseView,ResignationTaskView} from '@/lib/resignation-journey';
import {useResignationCase} from './use-case';
import {CaseFacts} from './common';
export function ResignationReplacementTask({initial,task,onChanged}:{initial:ResignationCaseView;task:ResignationTaskView;onChanged:(value:ResignationCaseView)=>void}){
 const t=useTranslations('resignationJourney'),[reference,setReference]=useState(''),{value,error,conflict,busy,command,reload}=useResignationCase(initial,onChanged);
 return <section className="space-y-4"><CaseFacts value={value}/><p className="text-sm text-muted-foreground">{t('replacementHint')}</p><form className="space-y-3" onSubmit={event=>{event.preventDefault();void command({type:'completeReplacement',taskId:task.id,reference:reference.trim()});}}><label className="block space-y-1 text-sm"><span>{t('replacementReference')}</span><input className={inputCls} type="url" pattern="https?://.+" required maxLength={2000} value={reference} disabled={busy||!task.actionable} placeholder="https://" onChange={event=>setReference(event.target.value)}/></label><Button type="submit" disabled={busy||!task.actionable||!reference.trim()}>{t('replacementComplete')}</Button></form>{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}{conflict&&<Button variant="outline" disabled={busy} onClick={reload}>{t('reload')}</Button>}</section>;
}
