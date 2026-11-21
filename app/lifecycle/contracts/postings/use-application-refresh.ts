'use client';
import {useCallback,useEffect,useTransition} from 'react';
import {useRouter} from 'next/navigation';

/** One bounded visible-page refresh, independent of the number of postings on this page. */
export function usePostingApplicationRefresh(active:boolean){
 const router=useRouter(),[refreshing,start]=useTransition();
 const refresh=useCallback(()=>start(()=>router.refresh()),[router]);
 useEffect(()=>{
  if(!active||refreshing)return;
  const timer=setInterval(()=>{if(document.visibilityState==='visible'&&navigator.onLine)refresh();},5000);
  return()=>clearInterval(timer);
 },[active,refreshing,refresh]);
 return {refreshing,refresh};
}
