'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { registerUnsavedGuard, UNSAVED_GUARD_IGNORE_SELECTOR } from '@/lib/unsaved-changes';

/** Independent forms retain independent save scopes. GET filters are navigation, not edits. */
export function AttendanceSettingsNavigation() {
  const t = useTranslations('attendanceSettingsHub');
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    const baselines = new Map<HTMLFormElement,string>();
    let armed = false;
    let leaving = false;
    const snapshot = (form: HTMLFormElement) => JSON.stringify(Array.from(form.elements).flatMap(element => {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) || !element.name || element.name.startsWith('$ACTION_') || element.type === 'hidden' || element.type === 'submit') return [];
      if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) return [[element.name, element.value, element.checked]];
      if (element instanceof HTMLInputElement && element.type === 'file') return [[element.name, Array.from(element.files ?? []).map(f => [f.name,f.size,f.lastModified])]];
      if (element instanceof HTMLSelectElement && element.multiple) return [[element.name,Array.from(element.selectedOptions).map(o=>o.value)]];
      return [[element.name,element.value]];
    }));
    const observeForms = () => document.querySelectorAll<HTMLFormElement>('form').forEach(form => {
      if (form.getAttribute('method')?.toLowerCase() === 'get' || form.closest(UNSAVED_GUARD_IGNORE_SELECTOR)) return;
      if (!baselines.has(form)) baselines.set(form,snapshot(form));
    });
    observeForms();
    const observer = new MutationObserver(observeForms);
    observer.observe(document.body,{childList:true,subtree:true});
    const dirtyForms = () => [...baselines].filter(([form,baseline])=>form.isConnected && snapshot(form)!==baseline).map(([form])=>form);
    const dirty = () => !leaving && dirtyForms().length>0;
    const ask = (proceed:()=>void) => { if (!dirty() || window.confirm(t('leaveUnsaved'))) { leaving=true; proceed(); } };
    const unregister=registerUnsavedGuard({isDirty:dirty,prompt:ask});
    const edit=()=>{
      if(dirty() && !armed){window.history.pushState({...window.history.state,__attendanceSettingsGuard:true},'',window.location.href);armed=true;}
    };
    const before=(e:BeforeUnloadEvent)=>{if(dirty()){e.preventDefault();e.returnValue='';}};
    const click=(e:MouseEvent)=>{
      if(!dirty() || e.defaultPrevented || e.button!==0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)return;
      const anchor=(e.target as Element|null)?.closest?.('a[href]') as HTMLAnchorElement|null;
      if(!anchor || anchor.target==='_blank' || anchor.hasAttribute('download') || anchor.closest(UNSAVED_GUARD_IGNORE_SELECTOR))return;
      const url=new URL(anchor.href,window.location.href);
      if(url.pathname===window.location.pathname && url.search===window.location.search)return;
      e.preventDefault();e.stopPropagation();
      ask(()=>{if(url.origin===window.location.origin)router.push(url.pathname+url.search+url.hash);else window.location.assign(url.href);});
    };
    const submit=(e:Event)=>{
      const form=e.target;
      if(!(form instanceof HTMLFormElement))return;
      const others=dirtyForms().filter(f=>f!==form);
      if(others.length && !window.confirm(t('leaveOtherUnsaved'))){e.preventDefault();e.stopPropagation();return;}
      // This form is being saved. Other independent forms are discarded only after explicit confirmation.
      baselines.set(form,snapshot(form));
      if(others.length)leaving=true;
    };
    const pop=()=>{
      if(!armed || leaving)return;
      if(!dirty()){armed=false;window.history.go(-1);return;}
      window.history.pushState({...window.history.state,__attendanceSettingsGuard:true},'',window.location.href);
      ask(()=>{armed=false;window.history.go(-2);});
    };
    document.addEventListener('input',edit,true);document.addEventListener('change',edit,true);
    document.addEventListener('click',click,true);document.addEventListener('submit',submit,true);
    window.addEventListener('beforeunload',before);window.addEventListener('popstate',pop);
    return()=>{observer.disconnect();unregister();document.removeEventListener('input',edit,true);document.removeEventListener('change',edit,true);document.removeEventListener('click',click,true);document.removeEventListener('submit',submit,true);window.removeEventListener('beforeunload',before);window.removeEventListener('popstate',pop);};
  },[pathname,router,t]);
  return null;
}
