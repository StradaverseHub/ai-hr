"use client";

import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {initializeOvertimeStartersAction} from '@/app/(app)/admin/attendance/settings/overtime-patterns/actions';

/** An explicit POST after mount keeps configuration changes out of render and link prefetch. */
export function OvertimeStarterInitializer({scopeKey}:{scopeKey:string}){
 const t=useTranslations('overtimePatterns'),router=useRouter();
 const [attempt,setAttempt]=useState(0),[state,setState]=useState<'pending'|'failed'|'done'>('pending');
 const request=useRef<{key:string;promise:ReturnType<typeof initializeOvertimeStartersAction>}|null>(null);
 useEffect(()=>{
  let active=true;const key=`${scopeKey}:${attempt}`;
  setState('pending');
  // Strict-mode effect replay joins the same command. Concurrent tabs still converge under the
  // canonical configuration lock; neither effect nor server action chooses a rate or assignment.
  if(request.current?.key!==key)request.current={key,promise:initializeOvertimeStartersAction()};
  void request.current.promise.then(result=>{
   if(!active)return;
   if(!result.ok){setState('failed');return;}
   setState('done');if(result.value.created>0)router.refresh();
  },()=>{if(active)setState('failed');});
  return()=>{active=false;};
 },[scopeKey,attempt,router]);
 if(state==='done')return null;
 return <div role="status" className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
  <span>{t(state==='pending'?'starterPreparing':'starterPreparationFailed')}</span>
  {state==='failed'?<button type="button" onClick={()=>setAttempt(value=>value+1)} className="min-h-10 rounded-lg border border-border px-3 py-2 text-foreground hover:bg-accent">{t('retryStarterPreparation')}</button>:null}
 </div>;
}
