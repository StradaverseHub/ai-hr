'use client';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {prepareAssistantImportAction} from '@/app/assistant/file-import-actions';
import {IMPORT_DESTINATIONS,importDraftCsv,type AssistantImportTarget,type ImportDraft} from '@/lib/assistant-import';
import {readAssistantImportFile,type ImportFileSource} from '@/lib/assistant-import-file';
import {useAssistantImportHandoff} from './import-handoff';

/** Ephemeral local UI only. Never serialize this turn into saved chat or provider history. */
export type AttachmentChatTurn={id:string;question:string;answer:ReactNode};

/** One UI lifecycle for the existing protected import preparation. Native authorization, projection,
 * source binding and human confirmation remain in their existing server/import owners. */
export function useAssistantImport({instruction:providedInstruction,onInstructionChange}:{instruction?:string;onInstructionChange?:(value:string)=>void}={}){
 const t=useTranslations('assistant.fileImport'),router=useRouter(),handoff=useAssistantImportHandoff();
 const [source,setSource]=useState<ImportFileSource|null>(null),[part,setPart]=useState(0),[target,setTarget]=useState<AssistantImportTarget>('employee');
 const [localInstruction,setLocalInstruction]=useState(''),[consent,setConsentState]=useState(false),[reviewed,setReviewed]=useState(false),[selectedName,setSelectedName]=useState<string|null>(null),[submittedQuestion,setSubmittedQuestion]=useState('');
 const instruction=providedInstruction??localInstruction,setInstruction=onInstructionChange??setLocalInstruction;
 const [busy,setBusy]=useState<'read'|'prepare'|null>(null),[error,setError]=useState<string|null>(null),[draft,setDraft]=useState<ImportDraft|null>(null),[csv,setCsvState]=useState('');
 const epoch=useRef(0),active=useRef(false),alive=useRef(true),picker=useRef<HTMLInputElement>(null),consentInstruction=useRef<string|null>(null),expiresAt=useRef<number|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;};},[]);
 const invalidate=()=>{epoch.current++;setDraft(null);setCsvState('');setConsentState(false);consentInstruction.current=null;setReviewed(false);setError(null);};
 const discard=()=>{invalidate();expiresAt.current=null;active.current=false;setBusy(null);setSource(null);setSelectedName(null);setSubmittedQuestion('');setInstruction('');};
 useEffect(()=>{
  if(!source)return;
  const timer=setTimeout(()=>{expiresAt.current=null;epoch.current++;active.current=false;setBusy(null);setSource(null);setSelectedName(null);setDraft(null);setCsvState('');setInstruction('');setConsentState(false);consentInstruction.current=null;setReviewed(false);setSubmittedQuestion('');setError(t('expired'));},Math.max(0,(expiresAt.current??Date.now())-Date.now()));
  return()=>clearTimeout(timer);
 },[source,t,setInstruction]);
 async function load(files:File[]){
  if(active.current)return;
  invalidate();expiresAt.current=null;setSource(null);setPart(0);setSubmittedQuestion('');setSelectedName(files[0]?.name??null);
  if(files.length!==1){setError(t('oneFile'));return;}
  active.current=true;setBusy('read');const revision=epoch.current;
  try{const next=await readAssistantImportFile(files[0]);if(alive.current&&epoch.current===revision){expiresAt.current=Date.now()+600000;setSource(next);}}
  catch(e){if(alive.current&&epoch.current===revision)setError(t(e instanceof Error&&e.message==='scan'?'scan':'readError'));}
  finally{if(alive.current&&epoch.current===revision){active.current=false;setBusy(null);if(picker.current)picker.current.value='';}}
 }
 async function prepare(request=instruction){
  if(!source||!consent||!request.trim()||active.current||consentInstruction.current!==request)return false;
  const revision=epoch.current,selected=source.parts[part];if(!selected)return false;
  active.current=true;setBusy('prepare');setError(null);setDraft(null);setReviewed(false);setSubmittedQuestion(request);
  try{
   const result=await prepareAssistantImportAction({target,source:selected.text,sourceKind:selected.kind??'text',instruction:request,consent:true});
   if(!alive.current||revision!==epoch.current)return false;
   if(!result.ok){setError(t('prepareError'));return false;}
   setDraft(result.draft);setCsvState(importDraftCsv(result.draft));return true;
  }catch{if(alive.current&&revision===epoch.current)setError(t('prepareError'));return false;}
  finally{if(alive.current&&revision===epoch.current){active.current=false;setBusy(null);}}
 }
 function review(){
  if(!handoff||!draft||!reviewed||busy||!csv.trim())return;
  const nonce=handoff.put(target,csv);router.push(IMPORT_DESTINATIONS[target]+'?assistantImport='+encodeURIComponent(nonce));
 }
 return{source,part,target,instruction,busy,error,draft,csv,consent,reviewed,selectedName,submittedQuestion,picker,
  attached:selectedName!==null,canReview:!!handoff&&!!draft&&reviewed&&!busy&&!!csv.trim(),load,prepare,review,discard,
  changeInstruction:(value:string)=>{invalidate();setInstruction(value);},changeTarget:(value:AssistantImportTarget)=>{invalidate();setTarget(value);},changePart:(value:number)=>{invalidate();setPart(value);},
  setConsent:(value:boolean)=>{setConsentState(value);consentInstruction.current=value?instruction:null;},setReviewed,
  setCsv:(value:string)=>{setCsvState(value);setReviewed(false);},
 };
}
export type AssistantImportController=ReturnType<typeof useAssistantImport>;
