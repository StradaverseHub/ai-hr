'use client';
import {useEffect} from 'react';
import {useRouter} from 'next/navigation';
import {legacyScheduleAnchorRedirect} from '@/lib/legacy-schedule-redirect';
export function LegacyScheduleAnchor(){
 const router=useRouter();
 useEffect(()=>{
  const target=legacyScheduleAnchorRedirect(window.location.hash,new URLSearchParams(window.location.search));
  if(target)router.replace(target);
 },[router]);
 return null;
}
