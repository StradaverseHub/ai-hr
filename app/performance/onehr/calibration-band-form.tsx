'use client';
import { useState,useTransition,type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {flushAssessmentDrafts} from './draft-form';
import { saveCalibrationBandAction } from '../onehr-actions';
export function CalibrationBandForm({children,action,className,preserveView=false}:{children:ReactNode;action:(data:FormData)=>Promise<void>;className?:string;preserveView?:boolean}){
 const t=useTranslations('onehr.talentList'),router=useRouter(),[pending,start]=useTransition(),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 if(!preserveView)return <form action={action} className={className}>{children}</form>;
 return <form aria-busy={pending} onSubmit={event=>{event.preventDefault();const data=new FormData(event.currentTarget);setError('');setSaved(false);start(async()=>{try{await flushAssessmentDrafts();const result=await saveCalibrationBandAction(data);if('error' in result){setError(result.error??t('saveError'));return;}setSaved(true);router.refresh();}catch{setError(t('saveError'));}});}}>
  <fieldset disabled={pending} className={className}>{children}</fieldset>
  {error&&<p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}{saved&&<p role="status" className="mt-2 text-xs text-muted-foreground">{t('saved')}</p>}
 </form>;
}
