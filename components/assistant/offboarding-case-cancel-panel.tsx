'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {Button,inputCls} from '@/components/ui';
import {OffboardingCaseCancel as C} from '@/lib/assistant-actions/offboarding-case-cancel-contract';
import {OffboardingCaseCancelPacket,parseOffboardingCaseCancelResult,type OffboardingCaseCancelResult} from '@/lib/assistant-actions/offboarding-case-cancel-browser-contract';
import type {z} from 'zod';
type Packet=z.infer<typeof OffboardingCaseCancelPacket>;
/** Human-only, no retry: a lost response reopens the same known ID or searches own review metadata. */
export async function readOffboardingCaseCancelResponse(response:Response,packet:Packet){
 if(!response.ok||response.headers.get('content-type')?.split(';')[0].trim()!=='application/json'||!response.body){await response.body?.cancel();throw Error('unavailable');}
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let bytes=0,count=0;
 try{for(;;){const p=await reader.read();if(p.done)break;bytes+=p.value.byteLength;if(bytes>20480||++count>512)throw Error('unavailable');parts.push(p.value);}const joined=new Uint8Array(bytes);let offset=0;for(const p of parts){joined.set(p,offset);offset+=p.byteLength;}return parseOffboardingCaseCancelResult(packet,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(joined)));}catch{await reader.cancel().catch(()=>undefined);throw Error('unavailable');}finally{reader.releaseLock();}
}
export function OffboardingCaseCancelPanel({resumeActionId}:{resumeActionId?:string}){
 const t=useTranslations('assistant.workspace.offboardingCaseCancel');
 const [result,setResult]=useState<OffboardingCaseCancelResult|null>(null),[caseNumber,setCaseNumber]=useState(''),[reason,setReason]=useState(''),[consent,setConsent]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false),[uncertain,setUncertain]=useState<string|null|false>(resumeActionId??false),[now,setNow]=useState(Date.now);
 const alive=useRef(true),flight=useRef(false),abort=useRef<AbortController|null>(null);
 const review=result?.kind==='prepared'?result.review:null,choices=result?.kind==='choices'?result.cases[0]:null;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;abort.current?.abort();};},[]);
 useEffect(()=>{if(!review)return;setNow(Date.now());const timer=setTimeout(()=>setNow(Date.now()),Math.max(0,Math.min(2147483647,Date.parse(review.expiresAt)-Date.now()+1)));return()=>clearTimeout(timer);},[review]);
 async function dispatch(value:unknown){if(flight.current)return;const packet=OffboardingCaseCancelPacket.parse(value);flight.current=true;setBusy(true);setError(false);const controller=new AbortController();abort.current=controller;
 try{const response=await fetch('/api/assistant/module-actions',{method:'POST',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(packet)});const received=await readOffboardingCaseCancelResponse(response,packet);if(!alive.current)return;setResult(received);if(packet.operation!=='list')setUncertain(false);setConfirmed(false);setConsent(false);setReason('');}
 catch{if(alive.current){setError(true);if(packet.operation!=='choices'&&packet.operation!=='list')setUncertain(packet.operation==='reopen'?packet.actionId:packet.operation==='confirm'||packet.operation==='discard'?packet.confirmation.actionId:review?.actionId??null);}}
 finally{flight.current=false;if(alive.current)setBusy(false);}
 }
 const act=(operation:'confirm'|'discard')=>{if(!review)return;void dispatch({action:C.action,operation,confirmation:{action:C.action,contractVersion:1,actionId:review.actionId,...(operation==='confirm'?{reviewedDigest:review.reviewedDigest}:{})}});};
 return <section className="space-y-4" aria-busy={busy}>
  <p role="status" aria-live="polite">{busy?t('working'):''}</p>{error&&<p role="alert">{t('unavailable')}</p>}
  {uncertain!==false&&<div className="space-y-2"><p>{t('uncertain')}</p>{uncertain&&<Button disabled={busy} onClick={()=>void dispatch({action:C.action,operation:'reopen',actionId:uncertain})}>{t('reopen')}</Button>}</div>}
  {!review&&uncertain===false&&result?.kind!=='completed'&&<div className="space-y-3">
   <label className="block">{t('caseNumber')}<input className={inputCls} value={caseNumber} maxLength={100} disabled={busy} onChange={e=>{setCaseNumber(e.target.value);setResult(null);setConsent(false);setReason('');}}/></label>
   <Button disabled={busy||!caseNumber.trim()} onClick={()=>void dispatch({action:C.action,operation:'choices',selection:{caseNumber:caseNumber.trim()}})}>{t('load')}</Button>
   {choices&&<><p className="font-medium">{choices.caseNumber}</p><p>{t('scope')}</p>
    <label className="block">{t('reason')}<textarea className={inputCls} maxLength={500} required disabled={busy} value={reason} onChange={e=>setReason(e.target.value)}/></label>
    <label className="flex gap-2"><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/>{t('caseConsent')}</label>
    <Button disabled={busy||!reason.trim()||!consent} onClick={()=>void dispatch({action:C.action,operation:'prepare',input:{caseId:choices.caseId,caseNumber:choices.caseNumber,reason:reason.trim(),confirmCaseCancellation:true}})}>{t('prepare')}</Button>
   </>}
  </div>}
  {review&&<div className="space-y-3 rounded border p-4"><h2 className="font-semibold">{review.review.caseNumber}</h2>
   <p>{t('dates')}: {review.review.resignationDate} / {review.review.lastWorkingDay??t('none')}</p>
   <p>{t('caseStatus')}: {t(review.review.before.status)} → {t(review.review.after.status)}</p>
   {review.review.before.cancelReason!==null&&<p className="whitespace-pre-wrap break-words">{t('previousReason')}: {review.review.before.cancelReason}</p>}
   <p className="whitespace-pre-wrap break-words">{t('reason')}: {review.review.after.cancelReason}</p><p>{t('scope')}</p>
   <label className="flex gap-2"><input type="checkbox" disabled={busy} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>{t('confirmConsent')}</label>
   <div className="flex flex-wrap gap-2"><Button disabled={busy||!confirmed||uncertain!==false||Date.parse(review.expiresAt)<=now} onClick={()=>act('confirm')}>{t('confirm')}</Button><Button variant="outline" disabled={busy} onClick={()=>act('discard')}>{t('discard')}</Button><Button variant="outline" disabled={busy} onClick={()=>void dispatch({action:C.action,operation:'reopen',actionId:review.actionId})}>{t('reopen')}</Button></div>
  </div>}
  {result?.kind==='completed'&&<p role="status">{t('recorded')}</p>}{result?.kind==='retired'&&<p role="status">{t('retired')}</p>}
  <Button variant="outline" disabled={busy} onClick={()=>void dispatch({action:C.action,operation:'list'})}>{t('find')}</Button>
  {result?.kind==='offboarding_case_cancel_review_index'&&<ul className="space-y-2">{result.reviews.map(row=><li key={row.actionId}><Button variant="outline" disabled={busy||typeof uncertain==='string'&&uncertain!==row.actionId} onClick={()=>void dispatch({action:C.action,operation:'reopen',actionId:row.actionId})}>{t('reopen')} · {row.createdAt}</Button></li>)}</ul>}
  <p><Link className="underline" href="/lifecycle/offboarding">{t('manual')}</Link></p>
 </section>;
}
