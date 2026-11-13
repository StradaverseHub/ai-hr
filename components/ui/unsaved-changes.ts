'use client';
/** Warn before leaving a page with unsaved grid edits: the browser's own prompt on reload/close, and a confirmation
 * on in-app links (captured before Next.js handles the click). Shared by the Rewards editable grids (PAT Inputs
 * board 2103041d, Role permissions board db14e49c). `allow` lets downloads and exports through without a prompt. */
import {useEffect} from 'react';

export function useUnsavedChangesGuard(dirty:boolean,message:string,allow?:(link:HTMLAnchorElement)=>boolean){
 useEffect(()=>{
  if(!dirty)return;
  const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
  const leave=(event:MouseEvent)=>{
   const link=(event.target as Element|null)?.closest?.('a[href]') as HTMLAnchorElement|null;
   if(!link||link.hasAttribute('download')||allow?.(link))return;
   if(!window.confirm(message)){event.preventDefault();event.stopPropagation();}
  };
  window.addEventListener('beforeunload',warn);document.addEventListener('click',leave,true);
  return()=>{window.removeEventListener('beforeunload',warn);document.removeEventListener('click',leave,true);};
 },[dirty,message,allow]);
}
