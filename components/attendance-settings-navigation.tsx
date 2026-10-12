'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { registerUnsavedGuard, UNSAVED_GUARD_IGNORE_SELECTOR } from '@/lib/unsaved-changes';

const snapshot = (form: HTMLFormElement) => JSON.stringify(Array.from(form.elements).flatMap(element => {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) || !element.name || element.name.startsWith('$ACTION_') || ['submit', 'button', 'reset'].includes(element.type)) return [];
  if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) return [[element.name, element.value, element.checked]];
  if (element instanceof HTMLInputElement && element.type === 'file') return [[element.name, Array.from(element.files ?? []).map(f => [f.name, f.size, f.lastModified])]];
  if (element instanceof HTMLSelectElement && element.multiple) return [[element.name, Array.from(element.selectedOptions).map(o => o.value)]];
  return [[element.name, element.value]];
}));

/** Independent forms retain independent save scopes. GET filters are navigation, not edits.
 * A client action increments savedRevision only after persistence succeeds for formId. */
export function AttendanceSettingsNavigation({ formId, savedRevision }: { formId?: string; savedRevision?: string | number } = {}) {
  const t = useTranslations('attendanceSettingsHub');
  const router = useRouter();
  const pathname = usePathname();
  const baselinesRef = useRef(new Map<HTMLFormElement, string>());
  const savedRef = useRef({ formId, savedRevision });
  useEffect(() => {
    const baselines = baselinesRef.current;
    baselines.clear();
    let armed = false;
    let leaving = false;
    const observeForms = () => document.querySelectorAll<HTMLFormElement>('form').forEach(form => {
      if (form.getAttribute('method')?.toLowerCase() === 'get' || form.closest(UNSAVED_GUARD_IGNORE_SELECTOR)) return;
      if (!baselines.has(form)) baselines.set(form,snapshot(form));
    });
    observeForms();
    const observer = new MutationObserver(() => { observeForms(); edit(); });
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['value','checked','selected']});
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
      // Submitting is not proof of persistence. Validation and network failures retain every baseline.
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
  useEffect(() => {
    const previous = savedRef.current;
    savedRef.current = { formId, savedRevision };
    if (!formId || previous.formId !== formId || previous.savedRevision === savedRevision) return;
    const form = document.getElementById(formId);
    if (form instanceof HTMLFormElement && baselinesRef.current.has(form)) baselinesRef.current.set(form, snapshot(form));
  }, [formId, savedRevision]);
  return null;
}
