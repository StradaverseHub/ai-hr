'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { firstDirtyGuard, registerUnsavedGuard, UNSAVED_GUARD_IGNORE_SELECTOR, type UnsavedGuard } from '@/lib/unsaved-changes';

type SnapshotField=[name:string,...values:unknown[]];
const fields = (form: HTMLFormElement) => Array.from(form.elements).flatMap<SnapshotField>(element => {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) || !element.name || element.hasAttribute('data-attendance-guard-meta') || (element.name.startsWith('$ACTION_') || element.name === '__attendanceSaveNonce') || ['submit', 'button', 'reset'].includes(element.type)) return [];
  if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) return [[element.name, element.value, element.checked]];
  if (element instanceof HTMLInputElement && element.type === 'file') return [[element.name, Array.from(element.files ?? []).map(f => [f.name, f.size, f.lastModified])]];
  if (element instanceof HTMLSelectElement && element.multiple) return [[element.name, Array.from(element.selectedOptions).map(o => o.value)]];
  return [[element.name, element.value]];
});
const snapshot = (form: HTMLFormElement) => JSON.stringify(fields(form));

/** Some settings fields intentionally clear after their own accepted revision. Other edits stay
 * tied to the exact submitted values so changes made while saving remain dirty. */
function acknowledgedSnapshot(form:HTMLFormElement, submitted:string) {
  const reset=new Set(Array.from(form.elements).flatMap(element=>{
    if(!element.closest('[data-attendance-reset-on-save]')||
      !(element instanceof HTMLInputElement||element instanceof HTMLSelectElement||element instanceof HTMLTextAreaElement))return [];
    return [element.name];
  }));
  if(!reset.size)return submitted;
  const submittedFields=JSON.parse(submitted) as SnapshotField[];
  const trigger=form.querySelector<HTMLInputElement>('input[data-attendance-reset-on-save-trigger]');
  if(!trigger||trigger.checked||!submittedFields.some(([name,,checked])=>name===trigger.name&&checked===true))return submitted;
  const pending=submittedFields.filter(([name])=>!reset.has(name));
  return JSON.stringify(fields(form).flatMap(field=>{
    if(reset.has(field[0]))return [field];
    const index=pending.findIndex(([name])=>name===field[0]);
    return index<0?[]:pending.splice(index,1);
  }).concat(pending));
}

type GuardMessages = { leaveUnsaved: string; leaveOtherUnsaved: string };

/** Independent forms retain independent save scopes. GET filters are navigation, not edits.
 * A client action increments savedRevision only after persistence succeeds for formId.
 *
 * 82748f92 — shared by People › Settings (components/people-settings-navigation.tsx) through three optional props.
 * Attendance passes none of them, so its behaviour is unchanged:
 * - `messages`: the confirm texts (default: attendanceSettingsHub.leaveUnsaved / leaveOtherUnsaved).
 * - `includeRegisteredGuards`: a page is also dirty while another registered guard (lib/unsaved-changes.ts) is,
 *   so formless editors such as the System Labels grids count.
 * - `resetKey`: re-take every form baseline when it changes (the page's search string: a saved server action that
 *   redirects back to the same address with ?toast= must not leave a stale baseline that prompts falsely). */
export function AttendanceSettingsNavigation({ formId, savedRevision, messages, includeRegisteredGuards = false, resetKey }: {
  formId?: string; savedRevision?: string | number; messages?: GuardMessages; includeRegisteredGuards?: boolean; resetKey?: string;
} = {}) {
  const t = useTranslations('attendanceSettingsHub');
  const translationRef = useRef<(key: keyof GuardMessages) => string>(t);
  translationRef.current = messages ? (key) => messages[key] : t;
  const router = useRouter();
  const pathname = usePathname();
  const baselinesRef = useRef(new Map<HTMLFormElement, string>());
  const savedRef = useRef({ formId, savedRevision });
  useEffect(() => {
    const baselines = baselinesRef.current;
    baselines.clear();
    const submissions = new Map<HTMLFormElement, { nonce: string; snapshot: string }>();
    let armed = false;
    let leaving = false;
    let active = true;
    const observeForms = () => document.querySelectorAll<HTMLFormElement>('form').forEach(form => {
      if (form.getAttribute('method')?.toLowerCase() === 'get' || form.closest(UNSAVED_GUARD_IGNORE_SELECTOR)) return;
      if (!baselines.has(form)) baselines.set(form,snapshot(form));
      const receipt = form.getAttribute('data-attendance-saved-receipt');
      const submitted = submissions.get(form);
      if (submitted && receipt === submitted.nonce) {
        submissions.delete(form); // A receipt is consumed once, and only by the form that submitted it.
        baselines.set(form, acknowledgedSnapshot(form,submitted.snapshot));
      }
    });
    observeForms();
    const observer = new MutationObserver(() => { observeForms(); edit(); });
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['value','checked','selected','data-attendance-saved-receipt']});
    const dirtyForms = () => [...baselines].filter(([form,baseline])=>form.isConnected && snapshot(form)!==baseline).map(([form])=>form);
    let consulting = false;
    const registeredDirty = () => {
      if (!includeRegisteredGuards || consulting) return false;
      consulting = true; // Two consulting guards never recurse into each other.
      try { return firstDirtyGuard(self) !== null; } finally { consulting = false; }
    };
    const dirty = () => !leaving && (dirtyForms().length>0 || registeredDirty());
    const ask = (proceed:()=>void) => { if (!dirty() || window.confirm(translationRef.current('leaveUnsaved'))) { leaving=true; proceed(); } };
    const self:UnsavedGuard={isDirty:dirty,prompt:ask};
    const unregister=registerUnsavedGuard(self);
    const arm=()=>{
      if(active && dirty() && !armed){window.history.pushState({...window.history.state,__attendanceSettingsGuard:true},'',window.location.href);armed=true;}
    };
    const edit=()=>{arm();queueMicrotask(arm);}; // Controlled fields can update their hidden business value after the native event.
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
      if(form.hasAttribute('data-attendance-save-scope') && form.getAttribute('aria-busy')==='true'){e.preventDefault();e.stopPropagation();return;}
      const others=dirtyForms().filter(f=>f!==form);
      if(others.length && !window.confirm(translationRef.current('leaveOtherUnsaved'))){e.preventDefault();e.stopPropagation();return;}
      if (form.hasAttribute('data-attendance-save-scope')) {
        const nonce = Array.from(window.crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2,'0')).join('');
        let field = form.querySelector<HTMLInputElement>('input[name="__attendanceSaveNonce"]');
        if (!field) { field = document.createElement('input'); field.type='hidden'; field.name='__attendanceSaveNonce'; form.appendChild(field); }
        field.value = nonce;
        submissions.set(form, { nonce, snapshot: snapshot(form) });
      }
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
    return()=>{active=false;observer.disconnect();unregister();document.removeEventListener('input',edit,true);document.removeEventListener('change',edit,true);document.removeEventListener('click',click,true);document.removeEventListener('submit',submit,true);window.removeEventListener('beforeunload',before);window.removeEventListener('popstate',pop);};
  },[pathname,router,includeRegisteredGuards,resetKey]);
  useEffect(() => {
    const previous = savedRef.current;
    savedRef.current = { formId, savedRevision };
    if (!formId || previous.formId !== formId || previous.savedRevision === savedRevision) return;
    const form = document.getElementById(formId);
    if (form instanceof HTMLFormElement && baselinesRef.current.has(form)) baselinesRef.current.set(form, snapshot(form));
  }, [formId, savedRevision]);
  return null;
}
