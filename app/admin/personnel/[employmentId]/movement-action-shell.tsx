'use client';
import {useEffect,useRef,type ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import {useRouter} from 'next/navigation';
import {registerUnsavedGuard,UNSAVED_GUARD_IGNORE_SELECTOR} from '@/lib/unsaved-changes';

/** Shared navigation protection for standalone movement forms. Validation does not remount children. */
export function MovementActionShell({children,readOnly=false}:{children:ReactNode;readOnly?:boolean}){
 const root=useRef<HTMLDivElement>(null),dirty=useRef(false),router=useRouter(),t=useTranslations('components.tabSave');
 useEffect(()=>{
  if(readOnly)return;
  const message=t('unsavedBody'),key='personnelMovementDraft';let sentinel=false;
  const ask=()=>window.confirm(message);
  const unregister=registerUnsavedGuard({isDirty:()=>dirty.current,prompt:proceed=>{if(ask()){dirty.current=false;proceed();}}});
  const unload=(event:BeforeUnloadEvent)=>{if(dirty.current){event.preventDefault();event.returnValue='';}};
  const click=(event:MouseEvent)=>{if(!dirty.current||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;
   const a=(event.target as Element)?.closest<HTMLAnchorElement>('a[href]');
   if(!a||a.closest(UNSAVED_GUARD_IGNORE_SELECTOR)||a.target==='_blank'||a.hasAttribute('download'))return;
   if(a.href===window.location.href)return;
   event.preventDefault();event.stopPropagation();if(ask()){dirty.current=false;router.push(a.href);}
  };
  const pop=(event:PopStateEvent)=>{if(!dirty.current)return;event.stopImmediatePropagation();
   if(ask()){dirty.current=false;window.history.back();}else{window.history.pushState({...window.history.state,[key]:true},'',window.location.href);sentinel=true;}
  };
  const change=()=>{dirty.current=true;if(!sentinel){window.history.pushState({...window.history.state,[key]:true},'',window.location.href);sentinel=true;}};
  const clean=()=>{dirty.current=false;};
  const node=root.current;node?.addEventListener('input',change);node?.addEventListener('change',change);node?.addEventListener('personnel-movement-saved',clean);
  window.addEventListener('beforeunload',unload);document.addEventListener('click',click,true);window.addEventListener('popstate',pop,true);
  return()=>{unregister();node?.removeEventListener('input',change);node?.removeEventListener('change',change);node?.removeEventListener('personnel-movement-saved',clean);window.removeEventListener('beforeunload',unload);document.removeEventListener('click',click,true);window.removeEventListener('popstate',pop,true);};
 },[readOnly,router,t]);
 return <div ref={root} data-personnel-movement-page>{children}</div>;
}
