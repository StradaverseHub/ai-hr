'use client';
import Link from 'next/link';
import {useEffect,useId,useRef,useState} from 'react';
import {useFormatter,useTranslations} from 'next-intl';
import {z} from 'zod';
import {Button,inputCls} from '@/components/ui';
import * as C from '@/lib/assistant-actions/employee-id-template-status-contract';
import {checkGenericPacket,packetActionId,sendGenericModuleAction} from './generic-module-action-transport';
type Prepared=z.infer<typeof C.EmployeeIdTemplateStatusPrepared>;
type State={kind:'selection'}|{kind:'review';review:Prepared}|{kind:'completed';receipt:z.infer<typeof C.EmployeeIdTemplateStatusCompleted>}|{kind:'retired';receipt:z.infer<typeof C.EmployeeIdTemplateStatusRetired>}|{kind:'uncertain';actionId:string|null};
const action=C.EMPLOYEE_ID_TEMPLATE_STATUS_ACTION;
export function EmployeeIdTemplateStatusPanel({initialChoices,resumeActionId}:{initialChoices:z.infer<typeof C.EmployeeIdTemplateStatusChoices>;resumeActionId?:string}){
 const t=useTranslations('assistant.workspace.employeeIdTemplateStatus'),format=useFormatter(),id=useId();
 const [choices,setChoices]=useState(initialChoices),[query,setQuery]=useState(''),[selectedId,setSelectedId]=useState(''),[consent,setConsent]=useState(false);
 const [state,setState]=useState<State>(()=>resumeActionId?{kind:'uncertain',actionId:resumeActionId}:{kind:'selection'}),[index,setIndex]=useState<z.infer<typeof C.EmployeeIdTemplateStatusIndex>['reviews']>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[now,setNow]=useState(()=>Date.now());
 const alive=useRef(true),flight=useRef(false),abort=useRef<AbortController|null>(null),status=useRef<HTMLParagraphElement>(null);
 const review=state.kind==='review'?state.review:null,selected=choices.kind==='choices'?choices.templates.find(p=>p.configId===selectedId):undefined;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;abort.current?.abort();};},[]);
 useEffect(()=>{if(!busy&&state.kind!=='selection')status.current?.focus();},[state,busy]);
 useEffect(()=>{setNow(Date.now());if(!review)return;const timer=setTimeout(()=>setNow(Date.now()),Math.max(0,Date.parse(review.expiresAt)-Date.now()));return()=>clearTimeout(timer);},[review]);
 async function dispatch(value:unknown){
  if(flight.current)return;const packet=checkGenericPacket(value);if(!packet||packet.action!==action){setError(t('unavailable'));return;}
  const previous=review?.actionId??(state.kind==='uncertain'?state.actionId:null),fallback=packetActionId(packet)??previous;
  flight.current=true;setBusy(true);setError('');setConsent(false);const controller=new AbortController();abort.current=controller;
  if(packet.operation==='prepare'){setSelectedId('');setQuery('');}
  try{const result=await sendGenericModuleAction(packet,controller.signal);if(!alive.current)return;
   if(packet.operation==='choices'){setChoices(C.EmployeeIdTemplateStatusChoices.parse(result));setSelectedId('');return;}
   if(packet.operation==='list'){setIndex(C.EmployeeIdTemplateStatusIndex.parse(result).reviews);return;}
   if(result.kind==='prepared'&&'review' in result){setState({kind:'review',review:C.EmployeeIdTemplateStatusPrepared.parse(result.review)});return;}
   if(result.kind==='completed'&&'receipt' in result){const receipt=C.EmployeeIdTemplateStatusCompleted.parse(result.receipt);if(review&&(receipt.receipt.configId!==review.content.configId||receipt.receipt.status!==review.content.status))throw Error();setState({kind:'completed',receipt});return;}
   if(result.kind==='retired'&&'receipt' in result){setState({kind:'retired',receipt:C.EmployeeIdTemplateStatusRetired.parse(result.receipt)});return;}throw Error();
  }catch{if(alive.current){setError(t('unavailable'));if(packet.operation==='choices'){setChoices({kind:'unavailable'});setSelectedId('');}else if(packet.operation!=='list'){setState({kind:'uncertain',actionId:fallback});}}}
  finally{flight.current=false;if(alive.current)setBusy(false);}
 }
 const terminalId=state.kind==='uncertain'?state.actionId:review?.actionId;
 return <section className="space-y-5" aria-busy={busy}>
  <p ref={status} tabIndex={-1} role="status" aria-live="polite">{busy?t('working'):state.kind==='uncertain'?t('uncertain'):state.kind==='completed'?t('completed'):state.kind==='retired'?t('retired'):t('description')}</p>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {state.kind==='selection'&&<form onSubmit={e=>{e.preventDefault();if(selected)void dispatch({action,operation:'prepare',input:{action,contractVersion:1,configId:selected.configId,expectedStatus:selected.status,status:selected.status==='active'?'inactive':'active'}});}} className="space-y-4">
   <fieldset disabled={busy} className="space-y-4"><label className="block" htmlFor={id+'-query'}>{t('search')}<input id={id+'-query'} className={inputCls} value={query} maxLength={80} onChange={e=>{setQuery(e.target.value);setSelectedId('');}}/></label>
   <Button className="h-auto min-h-11 whitespace-normal text-left" type="button" onClick={()=>void dispatch({action,operation:'choices',selection:{query}})}>{t('search')}</Button>
   {choices.kind==='choices'?<><label className="block" htmlFor={id+'-template'}>{t('template')}<select id={id+'-template'} className={inputCls} value={selectedId} onChange={e=>setSelectedId(e.target.value)}><option value="">{t('choose')}</option>{choices.templates.map(p=><option key={p.configId} value={p.configId}>{p.templateName??p.prefix} · {p.companyName} · {t(p.status)}</option>)}</select></label>{choices.templates.length===0&&<p>{t('empty')}</p>}{choices.truncated&&<p>{t('truncated')}</p>}</>:<p role="alert">{t('unavailable')}</p>}
   <Button className="h-auto min-h-11 whitespace-normal text-left" type="submit" disabled={!selected}>{t('prepare')}</Button></fieldset>
  </form>}
  {review&&<div className="space-y-4"><dl className="grid gap-2"><dt>{t('template')}</dt><dd className="font-medium break-words">{review.review.templateName??t('unnamed')}</dd><dt>{t('company')}</dt><dd className="break-words">{review.review.companyName}</dd><dt>{t('prefix')}</dt><dd className="break-words">{review.review.prefix}</dd><dt>{t('suffix')}</dt><dd className="break-words">{review.review.suffix||t('none')}</dd><dt>{t('before')}</dt><dd>{t(review.review.status)}</dd><dt>{t('after')}</dt><dd>{t(review.review.afterStatus)}</dd><dt>{t('expires')}</dt><dd>{format.dateTime(new Date(review.expiresAt),{dateStyle:'medium',timeStyle:'short'})}</dd></dl>
   <p>{t('consequence')}</p>{now>=Date.parse(review.expiresAt)?<p role="alert">{t('expired')}</p>:<label className="flex gap-2"><input type="checkbox" disabled={busy} checked={consent} onChange={e=>setConsent(e.target.checked)}/>{t('consent')}</label>}
   <Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy||!consent||now>=Date.parse(review.expiresAt)} onClick={()=>void dispatch({action,operation:'confirm',confirmation:{action,contractVersion:1,actionId:review.actionId,reviewedDigest:review.reviewedDigest}})}>{t('confirm')}</Button>
  </div>}
  {terminalId&&<div className="flex flex-wrap gap-3"><Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy} onClick={()=>void dispatch({action,operation:'reopen',actionId:terminalId})}>{t('reopen')}</Button><Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy} onClick={()=>void dispatch({action,operation:'discard',confirmation:{action,contractVersion:1,actionId:terminalId}})}>{t('discard')}</Button></div>}
  {state.kind==='completed'&&<p>{state.receipt.receipt.templateName??t('unnamed')} · {t(state.receipt.receipt.status)}</p>}
  <Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy} onClick={()=>void dispatch({action,operation:'list'})}>{t('saved')}</Button>
  {index.length>0&&<ul className="space-y-2">{index.map(r=><li key={r.actionId}><Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy} onClick={()=>void dispatch({action,operation:'reopen',actionId:r.actionId})}>{t('reopen')} · {format.dateTime(new Date(r.createdAt),{dateStyle:'medium',timeStyle:'short'})}</Button></li>)}</ul>}
  {(state.kind==='completed'||state.kind==='retired')&&<Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy} onClick={()=>{setState({kind:'selection'});setConsent(false);setSelectedId('');setIndex([]);void dispatch({action,operation:'choices',selection:{query:''}});}}>{t('newReview')}</Button>}
  <Link href="/admin/settings/employee-id" className="inline-flex min-h-11 items-center underline">{t('manual')}</Link>
 </section>;
}
