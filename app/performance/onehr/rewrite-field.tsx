'use client';
import {ProtectedInputHelp} from '@/components/assistant/protected-input-help';
import { useEffect,useId,useRef,useState,useTransition,type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { Button,inputCls } from '@/components/ui';
import type { AssessmentRewriteTarget } from '@/packs/performance/onehr/rewrite-model';
import { flushAssessmentDrafts } from './draft-form';
type Result={text:string;remaining:number;limit:number;resetSeconds?:number}|{error:string};
type RewriteAction=(target:AssessmentRewriteTarget,draft:string,instruction:string,requestId:string)=>Promise<Result>;
/** The ordinary textarea remains the form owner. Keeping a suggestion is an explicit human edit. */
type Props={areaFieldName?:string;children:ReactNode;target:AssessmentRewriteTarget;enabled:boolean;rewriteAction:RewriteAction};
export function RewriteField(props:Props){return props.enabled&&props.target.kind!=='idp_action'?<EnabledRewriteField {...props}/>:<>{props.children}{props.enabled&&<ProtectedInputHelp kind="layout"/>}</>;}
function EnabledRewriteField({children,target,enabled,rewriteAction,areaFieldName}:Props){
 const t=useTranslations('onehr.rewrite'),root=useRef<HTMLDivElement>(null),kept=useRef(false),id=useId();
 const [open,setOpen]=useState(false),[original,setOriginal]=useState(''),[instruction,setInstruction]=useState(''),[suggestion,setSuggestion]=useState(''),[error,setError]=useState(''),[quota,setQuota]=useState<{remaining:number;limit:number;resetSeconds?:number}|null>(null),[pending,start]=useTransition();
 useEffect(()=>{if(quota?.remaining!==0||!quota.resetSeconds)return;const timer=setTimeout(()=>setQuota(null),(quota.resetSeconds+1)*1000);return()=>clearTimeout(timer);},[quota]);
 const field=()=>root.current?.querySelector('textarea');
 const changeOpen=(next:boolean)=>{
  if(next){const textarea=field();if(!textarea||textarea.readOnly||textarea.matches(':disabled'))return;setOriginal(textarea.value);setSuggestion('');setError('');setInstruction('');}
  setOpen(next);
 };
 const generate=()=>start(async()=>{
  setError('');setSuggestion('');
  try{
   await flushAssessmentDrafts();
   const area=areaFieldName?root.current?.closest('form')?.elements.namedItem(areaFieldName):null;
   const currentTarget=target.kind==='idp_action'&&area instanceof HTMLTextAreaElement?{...target,area:area.value.trim().slice(0,200)}:target;
   const response=await rewriteAction(currentTarget,original,instruction||'format as a paragraph',crypto.randomUUID());
   if('error' in response){setError(response.error);return;}
   setSuggestion(response.text);setQuota({remaining:response.remaining,limit:response.limit,resetSeconds:response.resetSeconds});
  }catch{setError(t('unavailable'));}
 });
 const keep=()=>{
  const textarea=field();
  if(!textarea||textarea.readOnly||textarea.matches(':disabled')||textarea.value!==original){setError(t('changed'));return;}
  if(textarea.maxLength>=0&&suggestion.length>textarea.maxLength){setError(t('tooLong',{limit:textarea.maxLength}));return;}
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,suggestion);
  textarea.dispatchEvent(new Event('input',{bubbles:true}));textarea.dispatchEvent(new Event('change',{bubbles:true}));
  kept.current=true;setOpen(false);
 };
 return <div ref={root} className="space-y-2">{children}{enabled&&<Dialog.Root open={open} onOpenChange={changeOpen}>
  <Dialog.Trigger asChild><Button type="button" variant="secondary" className="gap-2 text-xs"><Sparkles size={14} aria-hidden/>{t('title')}</Button></Dialog.Trigger>
  <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/40"/><Dialog.Content onCloseAutoFocus={event=>{if(kept.current){event.preventDefault();field()?.focus();kept.current=false;}}} className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 space-y-4 overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-xl">
   <Dialog.Title className="text-base font-semibold">{t('title')}</Dialog.Title><ProtectedInputHelp kind="layout" onChoose={setInstruction}/><Dialog.Description className="text-sm text-muted-foreground">{t('help')}</Dialog.Description>
   <label className="block space-y-1 text-sm"><span>{t('yourWords')}</span><textarea readOnly rows={3} value={original} className={inputCls}/></label>
   <label htmlFor={`${id}-instruction`} className="block space-y-1 text-sm"><span>{t('instruction')}</span><textarea id={`${id}-instruction`} maxLength={500} rows={2} value={instruction} onChange={event=>setInstruction(event.target.value)} disabled={pending} placeholder="format as a paragraph" className={inputCls}/></label>
   <div className="flex flex-wrap items-center justify-between gap-3"><Button type="button" variant="secondary" disabled={pending||quota?.remaining===0||target.kind!=='idp_action'&&!original.trim()} onClick={generate}>{pending?t('working'):t('generate')}</Button>{quota&&<p role="status" className="text-xs text-muted-foreground">{t('quota',quota)}</p>}</div>
   {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
   {suggestion&&<label className="block space-y-1 text-sm"><span>{t('suggestion')}</span><textarea aria-label={t('suggestion')} rows={5} maxLength={4000} value={suggestion} onChange={event=>setSuggestion(event.target.value)} className={inputCls}/></label>}
   <div className="flex justify-end gap-3"><Dialog.Close asChild><Button type="button" variant="secondary">{t('discard')}</Button></Dialog.Close>{suggestion&&<Button type="button" disabled={pending||!suggestion.trim()} onClick={keep}>{t('keep')}</Button>}</div>
  </Dialog.Content></Dialog.Portal>
 </Dialog.Root>}</div>;
}
