'use client';
import Link from 'next/link';
import {useEffect,useId,useRef,useState} from 'react';
import {useFormatter,useTranslations} from 'next-intl';
import {z} from 'zod';
import {Button,inputCls} from '@/components/ui';
import * as C from '@/lib/assistant-actions/department-archive-contract';
import {checkGenericPacket,packetActionId,sendGenericModuleAction} from './generic-module-action-transport';
type Prepared=z.infer<typeof C.DepartmentArchivePrepared>;
type State={kind:'selection'}|{kind:'review';review:Prepared}|{kind:'completed';receipt:z.infer<typeof C.DepartmentArchiveCompleted>}|{kind:'retired';receipt:z.infer<typeof C.DepartmentArchiveRetired>}|{kind:'uncertain';actionId:string|null};
const action=C.DEPARTMENT_ARCHIVE_ACTION;
export function DepartmentArchivePanel({initialChoices,resumeActionId}:{initialChoices:z.infer<typeof C.DepartmentArchiveChoices>;resumeActionId?:string}){
 const t=useTranslations('assistant.workspace.departmentArchive'),format=useFormatter(),id=useId();
 const [choices,setChoices]=useState(initialChoices),[query,setQuery]=useState(''),[selectedId,setSelectedId]=useState(''),[consent,setConsent]=useState(false);
 const [state,setState]=useState<State>(()=>resumeActionId?{kind:'uncertain',actionId:resumeActionId}:{kind:'selection'}),[index,setIndex]=useState<z.infer<typeof C.DepartmentArchiveIndex>['reviews']>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[now,setNow]=useState(()=>Date.now());
 const alive=useRef(true),flight=useRef(false),abort=useRef<AbortController|null>(null),status=useRef<HTMLParagraphElement>(null);
 const review=state.kind==='review'?state.review:null,selected=choices.kind==='choices'?choices.departments.find(p=>p.departmentId===selectedId):undefined;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;abort.current?.abort();};},[]);
 useEffect(()=>{if(!busy&&state.kind!=='selection')status.current?.focus();},[state,busy]);
 useEffect(()=>{setNow(Date.now());if(!review)return;const timer=setTimeout(()=>setNow(Date.now()),Math.max(0,Date.parse(review.expiresAt)-Date.now()));return()=>clearTimeout(timer);},[review]);
 async function dispatch(value:unknown){
  if(flight.current)return;const packet=checkGenericPacket(value);if(!packet||packet.action!==action){setError(t('unavailable'));return;}
  const previous=review?.actionId??(state.kind==='uncertain'?state.actionId:null),fallback=packetActionId(packet)??previous;
  flight.current=true;setBusy(true);setError('');setConsent(false);const controller=new AbortController();abort.current=controller;
  if(packet.operation==='prepare'){setSelectedId('');setQuery('');}
  try{const result=await sendGenericModuleAction(packet,controller.signal);if(!alive.current)return;
   if(packet.operation==='choices'){setChoices(C.DepartmentArchiveChoices.parse(result));setSelectedId('');return;}
   if(packet.operation==='list'){setIndex(C.DepartmentArchiveIndex.parse(result).reviews);return;}
   if(result.kind==='prepared'&&'review' in result){setState({kind:'review',review:C.DepartmentArchivePrepared.parse(result.review)});return;}
   if(result.kind==='completed'&&'receipt' in result){const receipt=C.DepartmentArchiveCompleted.parse(result.receipt);if(review&&(receipt.receipt.departmentId!==review.content.departmentId||receipt.receipt.archived!==review.content.archived))throw Error();setState({kind:'completed',receipt});return;}
   if(result.kind==='retired'&&'receipt' in result){setState({kind:'retired',receipt:C.DepartmentArchiveRetired.parse(result.receipt)});return;}throw Error();
  }catch{if(alive.current){setError(t('unavailable'));if(packet.operation==='choices'){setChoices({kind:'unavailable'});setSelectedId('');}else if(packet.operation!=='list'){setState({kind:'uncertain',actionId:fallback});}}}
  finally{flight.current=false;if(alive.current)setBusy(false);}
 }
 const terminalId=state.kind==='uncertain'?state.actionId:review?.actionId;
 return <section className="space-y-5" aria-busy={busy}>
  <p ref={status} tabIndex={-1} role="status" aria-live="polite">{busy?t('working'):state.kind==='uncertain'?t('uncertain'):state.kind==='completed'?t('completed'):state.kind==='retired'?t('retired'):t('description')}</p>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  <div className="space-y-2"><p className="text-sm text-muted-foreground">{t('retentionNotice')}</p><Link href="/admin/settings/system-labels" className="inline-flex min-h-11 items-center underline">{t('manual')}</Link></div>
  {state.kind==='selection'&&<form onSubmit={e=>{e.preventDefault();if(selected&&(!selected.inUse||selected.archived))void dispatch({action,operation:'prepare',input:{action,contractVersion:1,departmentId:selected.departmentId,expectedArchived:selected.archived,archived:!selected.archived}});}} className="space-y-4">
   <fieldset disabled={busy} className="space-y-4"><label className="block" htmlFor={id+'-query'}>{t('search')}<input id={id+'-query'} className={inputCls} value={query} maxLength={80} onChange={e=>{setQuery(e.target.value);setSelectedId('');}}/></label>
   <Button className="h-auto min-h-11 whitespace-normal text-left" type="button" onClick={()=>void dispatch({action,operation:'choices',selection:{query}})}>{t('search')}</Button>
   {choices.kind==='choices'?<><label className="block" htmlFor={id+'-department'}>{t('department')}<select id={id+'-department'} className={inputCls} value={selectedId} onChange={e=>setSelectedId(e.target.value)}><option value="">{t('choose')}</option>{choices.departments.map(p=><option key={p.departmentId} value={p.departmentId}>{p.name} · {p.companyName} · {t(p.archived?'archived':'active')}</option>)}</select></label>{choices.departments.length===0&&<p>{t('empty')}</p>}{choices.truncated&&<p>{t('truncated')}</p>}</>:<p role="alert">{t('unavailable')}</p>}
   {selected?.inUse&&!selected.archived&&<p>{t('inUse')}</p>}
   <Button className="h-auto min-h-11 whitespace-normal text-left" type="submit" disabled={!selected||(!selected.archived&&selected.inUse)}>{t('prepare')}</Button></fieldset>
  </form>}
  {review&&<div className="space-y-4"><dl className="grid gap-2"><dt>{t('department')}</dt><dd className="font-medium break-words">{review.review.name}</dd><dt>{t('company')}</dt><dd className="break-words">{review.review.companyName}</dd><dt>{t('before')}</dt><dd>{t(review.review.archived?'archived':'active')}</dd><dt>{t('after')}</dt><dd>{t(review.review.afterArchived?'archived':'active')}</dd><dt>{t('expires')}</dt><dd>{format.dateTime(new Date(review.expiresAt),{dateStyle:'medium',timeStyle:'short'})}</dd></dl>
   <p>{t('consequence')}</p><p className="text-sm text-muted-foreground">{t('retentionReview')}</p>{now>=Date.parse(review.expiresAt)?<p role="alert">{t('expired')}</p>:<label className="flex gap-2"><input type="checkbox" disabled={busy} checked={consent} onChange={e=>setConsent(e.target.checked)}/>{t('consent')}</label>}
   <Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy||!consent||now>=Date.parse(review.expiresAt)} onClick={()=>void dispatch({action,operation:'confirm',confirmation:{action,contractVersion:1,actionId:review.actionId,reviewedDigest:review.reviewedDigest}})}>{t('confirm')}</Button>
  </div>}
  {terminalId&&<div className="flex flex-wrap gap-3"><Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy} onClick={()=>void dispatch({action,operation:'reopen',actionId:terminalId})}>{t('reopen')}</Button><Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy} onClick={()=>void dispatch({action,operation:'discard',confirmation:{action,contractVersion:1,actionId:terminalId}})}>{t('discard')}</Button></div>}
  {state.kind==='completed'&&<p>{state.receipt.receipt.name} · {t(state.receipt.receipt.archived?'archived':'active')}</p>}
  <Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy} onClick={()=>void dispatch({action,operation:'list'})}>{t('saved')}</Button>
  {index.length>0&&<ul className="space-y-2">{index.map(r=><li key={r.actionId}><Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy} onClick={()=>void dispatch({action,operation:'reopen',actionId:r.actionId})}>{t('reopen')} · {format.dateTime(new Date(r.createdAt),{dateStyle:'medium',timeStyle:'short'})}</Button></li>)}</ul>}
  {(state.kind==='completed'||state.kind==='retired')&&<Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy} onClick={()=>{setState({kind:'selection'});setConsent(false);setSelectedId('');setIndex([]);void dispatch({action,operation:'choices',selection:{query:''}});}}>{t('newReview')}</Button>}

 </section>;
}
