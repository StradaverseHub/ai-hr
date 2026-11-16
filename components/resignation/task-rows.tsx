'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Badge,Button,inputCls} from '@/components/ui';
import type {ResignationCaseView,ResignationTaskView} from '@/lib/resignation-journey';
import {reloadResignationCase,runResignationCommand} from '@/app/resignation/actions';
import {ResignationTaskPanel} from './task-panel';
import {day} from './common';
export {resignationTaskInFilter} from './task-filter';
import {resignationTaskInFilter} from './task-filter';
export function ResignationTaskRows({items,filter,today,viewerId}:{items:ResignationTaskView[];filter:string;today:string;viewerId?:string}){
 const t=useTranslations('resignationJourney'),router=useRouter(),[active,setActive]=useState<{task:ResignationTaskView;value:ResignationCaseView}|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,start]=useTransition();
 const [finished,setFinished]=useState<string[]>([]),[updates,setUpdates]=useState<Record<string,ResignationTaskView>>({});
 const rows=items.map(t=>updates[t.id]??t).filter(t=>!finished.includes(t.id)&&resignationTaskInFilter(t,filter,viewerId));
 const open=(task:ResignationTaskView)=>start(async()=>{setError('');try{const detail=await reloadResignationCase(task.caseId);if(!detail.ok){setError(detail.error);return;}let value=detail.value;let current=value.tasks.find(item=>item.id===task.id);if(!current){router.refresh();return;}if(current.team&&!current.onIt){const claim=await runResignationCommand({caseId:value.id,revision:value.revision,command:{type:'taskProgress',taskId:current.id,status:'progress'}});if(!claim.ok){setError(claim.error);return;}value=claim.value;current=value.tasks.find(item=>item.id===task.id);if(!current){router.refresh();return;}setUpdates(old=>({...old,[current!.id]:current!}));}setActive({task:current,value});}catch{setError(t('failed'));}});
 const progress=(task:ResignationTaskView,status:'todo'|'progress')=>start(async()=>{setError('');try{const result=await runResignationCommand({caseId:task.caseId,revision:task.revision,command:{type:'taskProgress',taskId:task.id,status}});if(result.ok){const next=result.value.tasks.find(t=>t.id===task.id);if(next)setUpdates(old=>({...old,[next.id]:next}));router.refresh();}else setError(result.error);}catch{setError(t('failed'));}});
 return <>{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}{notice&&<p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}{rows.map(task=><article key={task.id} className="onb-panel flex flex-wrap items-center justify-between gap-4" data-resignation-task={task.id}><div className="min-w-0"><Badge variant={task.team?'default':'info'}>{t(task.team?'taskTeam':'taskAssigned')}</Badge><button type="button" className="mt-2 block text-left font-medium hover:text-primary hover:underline" disabled={busy} onClick={()=>open(task)}>{task.title}</button><p className="mt-1 text-sm text-muted-foreground">{task.dueOn?t(task.overdue?'overdue':'due',{date:day(task.dueOn)}):t('noDate')} · {t('offboarding')}{task.onIt&&<span> · {t('onIt',{name:task.onIt.name})}</span>}</p></div><div className="flex flex-wrap items-center gap-2"><select className={inputCls+' w-auto'} aria-label={t('taskStatus')+' · '+task.title} value={task.status} disabled={busy||!task.actionable} onChange={e=>progress(task,e.target.value as 'todo'|'progress')}><option value="todo">{t('todo')}</option><option value="progress">{t('progress')}</option></select><Button variant="ghost" size="sm" disabled={busy} onClick={()=>open(task)}>{t(task.kind==='sign'?'taskSign':task.kind==='upload'?'taskUpload':'taskUpdate')}</Button></div></article>)}
 {active&&<ResignationTaskPanel key={active.task.id} task={active.task} initial={active.value} today={today} close={()=>setActive(null)} complete={()=>{setFinished(ids=>[...ids,active.task.id]);setActive(null);setNotice(t('taskComplete'));router.refresh();}}/>}
 </>;
}
