'use client';

import {useEffect} from 'react';
import {useRouter} from 'next/navigation';

/** Board 0735d1b7 — re-reads an invitation batch's page every few seconds while its job is still running. */
export function RefreshWhileRunning({running}:{running:boolean}){
 const router=useRouter();
 useEffect(()=>{
  if(!running)return;
  const timer=window.setInterval(()=>router.refresh(),3000);
  return()=>window.clearInterval(timer);
 },[router,running]);
 return null;
}
