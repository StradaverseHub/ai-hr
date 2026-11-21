'use client';
import {useEffect,useRef,useState,useTransition,type FormEvent} from 'react';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import type {ResignationCaseView,ResignationTaskView} from '@/lib/resignation-journey';
import {ResignationCaseCard} from './case-card';
import {ResignationReplacementTask} from './replacement-task';
import {uploadOwnResignationFile} from '@/app/resignation/actions';
export function ResignationTaskPanel({task,initial,today,close,complete}:{task:ResignationTaskView;initial:ResignationCaseView;today:string;close:()=>void;complete:()=>void}){
 const t=useTranslations('resignationJourney'),dialog=useRef<HTMLDialogElement>(null),[busy,start]=useTransition(),[error,setError]=useState('');
 useEffect(()=>{const node=dialog.current;node?.showModal();return()=>node?.close();},[]);
 const changed=(value:ResignationCaseView)=>{if(task.kind==='repair'&&value.stage==='decision'&&!value.deciders.length&&value.blocked.length>0)return;if(!value.tasks.some(item=>item.id===task.id)){complete();}};
 const upload=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=new FormData(event.currentTarget),file=form.get('file');if(!(file instanceof File)||!file.size){setError(t('fileRequired'));return;}setError('');start(async()=>{try{const result=await uploadOwnResignationFile(form);if(result.ok)changed(result.value);else setError(result.error);}catch{setError(t('failed'));}});};
 return <dialog ref={dialog} aria-labelledby="resignation-task-title" className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-[min(48rem,100%)] max-w-none overflow-y-auto border-l bg-background p-5 text-foreground shadow-xl backdrop:bg-black/35 sm:p-6" onCancel={event=>{if(busy)event.preventDefault();else close();}} onClick={event=>{if(event.target===event.currentTarget){const r=event.currentTarget.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}}}>
 <header className="mb-5 flex items-start justify-between gap-3 border-b pb-4"><div><h2 id="resignation-task-title" className="text-lg font-semibold">{task.title}</h2><p className="mt-1 text-sm text-muted-foreground">{task.employeeName} · {task.caseNumber}</p></div><Button variant="ghost" disabled={busy} onClick={close}>{t('close')}</Button></header>
 {task.kind==='repair'&&<p className="mb-4 text-sm text-muted-foreground">{t('repairTaskHint')}</p>}
 {task.kind==='recruitment'?<ResignationReplacementTask initial={initial} task={task} onChanged={changed}/>:task.kind==='upload'?<section className="space-y-4"><h3 className="font-semibold">{task.uploadLabel??t('uploadTask')}</h3><p className="text-sm text-muted-foreground">{t('uploadHint')}</p><form onSubmit={upload} className="space-y-4"><input type="hidden" name="caseId" value={initial.id}/><input type="hidden" name="revision" value={initial.revision}/><input type="hidden" name="taskId" value={task.id}/><label className="block space-y-2 text-sm"><span>{task.uploadLabel??t('upload')}</span><input required type="file" name="file" accept="application/pdf,image/jpeg,image/png" disabled={busy} className="block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-2"/><span className="block text-xs text-muted-foreground">{t('fileHint')}</span></label>{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}<Button type="submit" disabled={busy} aria-busy={busy}>{t('upload')}</Button></form></section>:<ResignationCaseCard initial={initial} today={today} onChanged={changed} documentId={task.documentId??undefined}/>}
 </dialog>;
}
