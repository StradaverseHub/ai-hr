'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {Button,inputCls} from '@/components/ui';
import {OffboardingStepUndo as C} from '@/lib/assistant-actions/offboarding-step-undo-contract';
import {OffboardingStepUndoPacket,parseOffboardingStepUndoResult,type OffboardingStepUndoResult} from '@/lib/assistant-actions/offboarding-step-undo-browser-contract';
import type {z} from 'zod';
type Packet=z.infer<typeof OffboardingStepUndoPacket>;
async function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted){void work.catch(()=>undefined);throw Error('unavailable');}let stop:()=>void=()=>{};
 const interrupted=new Promise<never>((_resolve,reject)=>{stop=()=>reject(Error('unavailable'));signal.addEventListener('abort',stop,{once:true});});
 try{return await Promise.race([work,interrupted]);}finally{signal.removeEventListener('abort',stop);}
}
function assertDeadline(deadlineAt?:number){if(deadlineAt!==undefined&&performance.now()>=deadlineAt)throw Error('unavailable');}
/** Human-only, no retry: a lost response reopens the same known ID or searches own review metadata. */
export async function readOffboardingStepUndoResponse(response:Response,packet:Packet,signal?:AbortSignal,deadlineAt?:number){
 if(!response.ok||response.headers.get('content-type')?.split(';')[0].trim()!=='application/json'||!response.body){void response.body?.cancel().catch(()=>undefined);throw Error('unavailable');}
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let bytes=0,count=0;
 try{assertDeadline(deadlineAt);for(;;){const p=await (signal?abortable(reader.read(),signal):reader.read());assertDeadline(deadlineAt);if(p.done)break;bytes+=p.value.byteLength;if(bytes>20480||++count>512)throw Error('unavailable');parts.push(p.value);}const joined=new Uint8Array(bytes);let offset=0;for(const p of parts){joined.set(p,offset);offset+=p.byteLength;}const result=parseOffboardingStepUndoResult(packet,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(joined)));assertDeadline(deadlineAt);return result;}catch{void reader.cancel().catch(()=>undefined);throw Error('unavailable');}finally{reader.releaseLock();}
}
export function OffboardingStepUndoPanel({resumeActionId}:{resumeActionId?:string}){
 const t=useTranslations('assistant.workspace.offboardingStepUndo');
 const [result,setResult]=useState<OffboardingStepUndoResult|null>(null),[caseNumber,setCaseNumber]=useState(''),[stepKey,setStepKey]=useState(''),[reason,setReason]=useState(''),[consent,setConsent]=useState(false),[reopeningConsent,setReopeningConsent]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false),[uncertain,setUncertain]=useState<string|null|false>(resumeActionId??false),[now,setNow]=useState(Date.now);
 const knownReviews=useRef(new Map<string,{caseId:string;stepKey:string}>());
 const alive=useRef(true),flight=useRef(false),abort=useRef<AbortController|null>(null);
 const review=result?.kind==='prepared'?result.review:null,choices=result?.kind==='choices'?result.cases[0]:null;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;abort.current?.abort();};},[]);
 useEffect(()=>{if(!review)return;setNow(Date.now());const timer=setTimeout(()=>setNow(Date.now()),Math.max(0,Math.min(2147483647,Date.parse(review.expiresAt)-Date.now()+1)));return()=>clearTimeout(timer);},[review]);
 async function dispatch(value:unknown){if(flight.current)return;const packet=OffboardingStepUndoPacket.parse(value);flight.current=true;setBusy(true);setError(false);const controller=new AbortController();abort.current=controller;const deadlineAt=performance.now()+30000;const deadline=setTimeout(()=>controller.abort(),30000);
 try{const response=await abortable(fetch('/api/assistant/module-actions',{method:'POST',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(packet)}),controller.signal);assertDeadline(deadlineAt);const received=await readOffboardingStepUndoResponse(response,packet,controller.signal,deadlineAt);
  const identity=received.kind==='prepared'?{actionId:received.review.actionId,caseId:received.review.content.caseId,stepKey:received.review.content.stepKey}:received.kind==='completed'?{actionId:received.receipt.actionId,caseId:received.receipt.receipt.caseId,stepKey:received.receipt.receipt.stepKey}:null;
  const known=identity?knownReviews.current.get(identity.actionId):undefined;if(identity&&known&&(known.caseId!==identity.caseId||known.stepKey!==identity.stepKey))throw Error('unavailable');
  assertDeadline(deadlineAt);if(!alive.current)return;if(identity)knownReviews.current.set(identity.actionId,{caseId:identity.caseId,stepKey:identity.stepKey});setResult(received);if(packet.operation!=='list')setUncertain(false);setConfirmed(false);setConsent(false);setReopeningConsent(false);setReason('');setStepKey('');}
 catch{if(alive.current){setError(true);if(packet.operation!=='choices'&&packet.operation!=='list')setUncertain(packet.operation==='reopen'?packet.actionId:packet.operation==='confirm'||packet.operation==='discard'?packet.confirmation.actionId:review?.actionId??null);}}
 finally{clearTimeout(deadline);controller.abort();flight.current=false;if(alive.current)setBusy(false);}
 }
 const act=(operation:'confirm'|'discard')=>{if(!review)return;void dispatch({action:C.action,operation,confirmation:{action:C.action,contractVersion:1,actionId:review.actionId,...(operation==='confirm'?{reviewedDigest:review.reviewedDigest}:{})}});};
 return <section className="space-y-4" aria-busy={busy}>
  <p role="status" aria-live="polite">{busy?t('working'):''}</p>{error&&<p role="alert">{t('unavailable')}</p>}
  {uncertain!==false&&<div className="space-y-2"><p>{t('uncertain')}</p>{uncertain&&<Button disabled={busy} onClick={()=>void dispatch({action:C.action,operation:'reopen',actionId:uncertain})}>{t('reopen')}</Button>}</div>}
  {!review&&uncertain===false&&result?.kind!=='completed'&&<div className="space-y-3">
   <label className="block">{t('caseNumber')}<input className={inputCls} value={caseNumber} maxLength={100} disabled={busy} onChange={e=>{setCaseNumber(e.target.value);setResult(null);setStepKey('');}}/></label>
   <Button disabled={busy||!caseNumber.trim()} onClick={()=>void dispatch({action:C.action,operation:'choices',selection:{caseNumber:caseNumber.trim()}})}>{t('load')}</Button>
   {choices&&<><label className="block">{t('step')}<select className={inputCls} disabled={busy} value={stepKey} onChange={e=>setStepKey(e.target.value)}><option value="">{t('choose')}</option>{choices.steps.map(step=><option key={step.key} value={step.key}>{step.label}</option>)}</select></label>
    <label className="block">{t('reason')}<textarea className={inputCls} maxLength={500} disabled={busy} value={reason} onChange={e=>setReason(e.target.value)}/></label>
    <label className="flex gap-2"><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/>{t('stepConsent')}</label>
    <label className="flex gap-2"><input type="checkbox" checked={reopeningConsent} disabled={busy} onChange={e=>setReopeningConsent(e.target.checked)}/>{t('reopeningConsent')}</label>
    <Button disabled={busy||!stepKey||!consent} onClick={()=>void dispatch({action:C.action,operation:'prepare',input:{caseId:choices.caseId,caseNumber:choices.caseNumber,stepKey,reason:reason.trim()||null,confirmUndo:true,acceptCaseReopening:reopeningConsent}})}>{t('prepare')}</Button>
   </>}
  </div>}
  {review&&<div className="space-y-3 rounded border p-4"><h2 className="font-semibold">{review.review.caseNumber} · {review.review.stepLabel}</h2>
   <p>{t('dates')}: {review.review.resignationDate} / {review.review.lastWorkingDay??t('none')}</p>
   <p>{t('step')}: {t('done')} → {t('pending')}</p><p>{t('caseStatus')}: {t(review.review.before.caseStatus)} → {t(review.review.after.caseStatus)}</p>
   <p>{t('reason')}: {review.review.reason??t('none')}</p><p>{t('reference')}: {review.review.before.reference??t('none')}</p><p className="whitespace-pre-wrap break-words">{t('notes')}: {review.review.before.notes??t('none')}</p>
   {review.review.reopensCase&&<p>{t('reopeningConsent')}</p>}
   <label className="flex gap-2"><input type="checkbox" disabled={busy} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>{t('confirmConsent')}</label>
   <div className="flex flex-wrap gap-2"><Button disabled={busy||!confirmed||uncertain!==false||Date.parse(review.expiresAt)<=now} onClick={()=>act('confirm')}>{t('confirm')}</Button><Button variant="outline" disabled={busy} onClick={()=>act('discard')}>{t('discard')}</Button><Button variant="outline" disabled={busy} onClick={()=>void dispatch({action:C.action,operation:'reopen',actionId:review.actionId})}>{t('reopen')}</Button></div>
  </div>}
  {result?.kind==='completed'&&<p role="status">{t('recorded')}</p>}{result?.kind==='retired'&&<p role="status">{t('retired')}</p>}
  <Button variant="outline" disabled={busy} onClick={()=>void dispatch({action:C.action,operation:'list'})}>{t('find')}</Button>
  {result?.kind==='offboarding_step_undo_review_index'&&<ul className="space-y-2">{result.reviews.map(row=><li key={row.actionId}><Button variant="outline" disabled={busy||typeof uncertain==='string'&&uncertain!==row.actionId} onClick={()=>void dispatch({action:C.action,operation:'reopen',actionId:row.actionId})}>{t('reopen')} · {row.createdAt}</Button></li>)}</ul>}
  <p><Link className="underline" href="/lifecycle/offboarding">{t('manual')}</Link></p>
 </section>;
}
