'use client';
import {useEffect} from 'react';
import {useRouter} from 'next/navigation';
import {legacySecurityDestination} from '@/lib/security-center-navigation';
export function LegacySecurityNavigation(){
 const router=useRouter();
 useEffect(()=>{
  const handoff=()=>{const href=legacySecurityDestination(window.location.hash,new URLSearchParams(window.location.search));if(href)router.replace(href);};
  handoff();window.addEventListener('hashchange',handoff);return ()=>window.removeEventListener('hashchange',handoff);
 },[router]);
 return null;
}
