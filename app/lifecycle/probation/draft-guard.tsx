'use client';
import {useEffect,useRef} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {registerUnsavedGuard,UNSAVED_GUARD_IGNORE_SELECTOR} from '@/lib/unsaved-changes';
export function DraftGuard({dirty}:{dirty:boolean}){
 const current=useRef(dirty),router=useRouter(),t=useTranslations('probation');current.current=dirty;
 useEffect(()=>{
  let leaving=false,armed=false;
  const ask=()=>!current.current||window.confirm(t('leaveUnsaved'));
  const unregister=registerUnsavedGuard({isDirty:()=>current.current&&!leaving,prompt:proceed=>{if(ask()){leaving=true;proceed();}}});
  const before=(event:BeforeUnloadEvent)=>{if(current.current&&!leaving){event.preventDefault();event.returnValue='';}};
  const click=(event:MouseEvent)=>{
   if(!current.current||leaving||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;
   const a=(event.target as Element|null)?.closest<HTMLAnchorElement>('a[href]');if(!a||a.target==='_blank'||a.hasAttribute('download')||a.closest(UNSAVED_GUARD_IGNORE_SELECTOR))return;
   const url=new URL(a.href,window.location.href);if(url.href===window.location.href)return;
   event.preventDefault();event.stopPropagation();if(ask()){leaving=true;if(url.origin===window.location.origin)router.push(url.pathname+url.search+url.hash);else window.location.assign(url.href);}
  };
  const submit=(event:SubmitEvent)=>{const form=event.target;if(!current.current||leaving||event.defaultPrevented||!(form instanceof HTMLFormElement)||form.method.toLowerCase()!=='get'||form.closest(UNSAVED_GUARD_IGNORE_SELECTOR))return;if(ask())leaving=true;else{event.preventDefault();event.stopPropagation();}};
  const pop=(event:PopStateEvent)=>{if(!current.current||leaving)return;event.stopImmediatePropagation();if(ask()){leaving=true;window.history.back();}else window.history.pushState({...window.history.state,probationDraft:true},'',window.location.href);};
  const arm=()=>{if(current.current&&!armed&&!leaving){window.history.pushState({...window.history.state,probationDraft:true},'',window.location.href);armed=true;}};
  window.addEventListener('beforeunload',before);document.addEventListener('click',click,true);document.addEventListener('submit',submit,true);window.addEventListener('popstate',pop,true);document.addEventListener('input',arm);document.addEventListener('change',arm);
  return()=>{unregister();window.removeEventListener('beforeunload',before);document.removeEventListener('click',click,true);document.removeEventListener('submit',submit,true);window.removeEventListener('popstate',pop,true);document.removeEventListener('input',arm);document.removeEventListener('change',arm);};
 },[router,t]);
 return null;
}
