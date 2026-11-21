'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {reloadResignationCase,runResignationCommand} from '@/app/resignation/actions';
import type {ResignationCaseView,ResignationJourneyCommand} from '@/lib/resignation-journey';
export function useResignationCase(initial:ResignationCaseView,onChanged?:(value:ResignationCaseView)=>void){
 const [value,setValue]=useState(initial),[error,setError]=useState(''),[conflict,setConflict]=useState(false),[busy,start]=useTransition();const router=useRouter(),t=useTranslations('resignationJourney');
 const update=(next:ResignationCaseView)=>{setValue(next);onChanged?.(next);router.refresh();};
 const command=(command:ResignationJourneyCommand)=>new Promise<boolean>(resolve=>start(async()=>{setError('');setConflict(false);try{const result=await runResignationCommand({caseId:value.id,revision:value.revision,command});if(result.ok){update(result.value);resolve(true);}else{setError(result.error);setConflict(!!result.conflict);resolve(false);}}catch{setError(t('failed'));resolve(false);}}));
 const reload=()=>start(async()=>{try{const result=await reloadResignationCase(value.id);if(result.ok){setError('');setConflict(false);update(result.value);}else setError(result.error);}catch{setError(t('failed'));}});
 return {value,error,conflict,busy,command,reload};
}
