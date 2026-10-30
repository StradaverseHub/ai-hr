'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {z} from 'zod';
import {Button,inputCls} from '@/components/ui';
import {PayrollReopen as C} from '@/lib/assistant-actions/reviewed-payroll-reopen-contract';
import {checkGenericPacket,packetActionId,sendGenericModuleAction,type GenericPacket} from './generic-module-action-transport';
type Prepared=z.infer<typeof C.Prepared>;type Done=z.infer<typeof C.Completed>;type Retired=z.infer<typeof C.Retired>;
type State={kind:'draft'}|{kind:'review';review:Prepared}|{kind:'done';receipt:Done}|{kind:'retired';receipt:Retired}|{kind:'uncertain';actionId:string|null;expectedBatchId?:string|null};
export function PayrollReopenPanel({resumeActionId}:{resumeActionId?:string}){
 const statusText=useTranslations('assistant.workspace.payrollCloseActions');const t=useTranslations('assistant.workspace.payrollReopen'),[state,setState]=useState<State>(()=>resumeActionId?{kind:'uncertain',actionId:z.guid().safeParse(resumeActionId).success?resumeActionId:null}:{kind:'draft'});
 const [choices,setChoices]=useState<z.infer<typeof C.Choices>|null>(null),[batchId,setBatchId]=useState(''),[reason,setReason]=useState(''),[authored,setAuthored]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false),[index,setIndex]=useState<z.infer<typeof C.Index>|null>(null),[now,setNow]=useState(Date.now);
 const flight=useRef(false),alive=useRef(true),abort=useRef<AbortController|null>(null),status=useRef<HTMLParagraphElement>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;abort.current?.abort();};},[]);
 const review=state.kind==='review'?state.review:null;
 useEffect(()=>{if(!review)return;setNow(Date.now());const timer=setTimeout(()=>setNow(Date.now()),Math.max(0,Date.parse(review.expiresAt)-Date.now()+1));return()=>clearTimeout(timer);},[review]);
 useEffect(()=>{if(!busy&&state.kind!=='draft')status.current?.focus();},[busy,state]);
 const clear=()=>{setReason('');setAuthored(false);setConfirmed(false);setBatchId('');setChoices(null);};
 async function dispatch(value:unknown){if(flight.current)return;const packet=checkGenericPacket(value);if(!packet||packet.action!==C.action)return;
  if(state.kind==='uncertain'&&(packet.operation==='prepare'||packet.operation==='confirm'||state.actionId&&packetActionId(packet)&&packetActionId(packet)!==state.actionId))return;
  const target=packet.operation==='prepare'?C.Human.parse(packet.input).batchId:state.kind==='review'?state.review.content.batchId:state.kind==='uncertain'?state.expectedBatchId:null;
  flight.current=true;setBusy(true);setError(false);const controller=new AbortController();abort.current=controller;const timer=setTimeout(()=>controller.abort(),15000);
  try{const result=await sendGenericModuleAction(packet as GenericPacket,controller.signal);if(controller.signal.aborted)throw Error();if(!alive.current)return;
   if(result.kind==='choices'||result.kind==='unavailable'){setChoices(C.Choices.parse(result));return;}
   if(result.kind===C.indexKind){setIndex(C.Index.parse(result));return;}
   if(result.kind==='prepared'&&'review'in result){const next=C.Prepared.parse(result.review);if(target&&next.content.batchId!==target)throw Error();clear();setIndex(null);setState({kind:'review',review:next});setNow(Date.now());}
   else if(result.kind==='completed'&&'receipt'in result){const next=C.Completed.parse(result.receipt);if(target&&next.receipt.batchId!==target)throw Error();clear();setIndex(null);setState({kind:'done',receipt:next});}
   else if(result.kind==='retired'&&'receipt'in result){clear();setState({kind:'retired',receipt:C.Retired.parse(result.receipt)});}else throw Error();
  }catch{if(alive.current){setError(true);if(!['choices','list'].includes(packet.operation)){clear();setState({kind:'uncertain',actionId:packetActionId(packet),expectedBatchId:target});}}}
  finally{clearTimeout(timer);flight.current=false;if(alive.current)setBusy(false);}
 }
 function prepare(event:FormEvent){event.preventDefault();const content=C.Human.safeParse({action:C.action,contractVersion:1,batchId,reason,confirmReopenClosedRun:authored,acknowledgeRecordedDownstreamWarnings:authored});if(!content.success){setError(true);return;}void dispatch({action:C.action,operation:'prepare',input:content.data});}
 const expired=review?now>=Date.parse(review.expiresAt):false;
 const known=state.kind==='review'?state.review.actionId:state.kind==='done'||state.kind==='retired'?state.receipt.actionId:state.kind==='uncertain'?state.actionId:null;
 const send=(operation:'reopen'|'discard',id:string)=>dispatch(operation==='reopen'?{action:C.action,operation,actionId:id}:{action:C.action,operation,confirmation:{action:C.action,contractVersion:1,actionId:id}});
 return <section className="space-y-4" aria-label={t('title')}>
  <p ref={status} tabIndex={-1} role="status" className="text-sm">{t(state.kind)}</p>{error&&<p role="alert">{t('unavailable')}</p>}
  {state.kind==='draft'&&<form onSubmit={prepare} className="space-y-4">
   <Button type="button" variant="outline" disabled={busy} onClick={()=>void dispatch({action:C.action,operation:'choices'})}>{t('load')}</Button>
   {choices?.kind==='choices'&&<label className="block space-y-1"><span>{t('run')}</span><select className={inputCls} value={batchId} onChange={e=>setBatchId(e.target.value)} required disabled={busy}><option value="">{t('select')}</option>{choices.batches.map(row=><option key={row.batchId} value={row.batchId}>{row.companyName} · {row.payPeriod}{row.cycleName?` · ${row.cycleName}`:''}</option>)}</select></label>}
   {choices?.kind==='unavailable'&&<p>{t('unavailable')}</p>}
   <label className="block space-y-1"><span>{t('reason')}</span><textarea className={inputCls} maxLength={4000} required value={reason} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>
   <label className="flex gap-2"><input type="checkbox" checked={authored} disabled={busy} onChange={e=>setAuthored(e.target.checked)}/><span>{t('authored')}</span></label>
   <Button type="submit" disabled={busy||!authored||!batchId||!reason.trim()}>{t('prepare')}</Button>
  </form>}
  {review&&<div className="space-y-3 rounded-md border border-border p-4">
   <p>{review.review.companyName} · {review.review.payPeriod} · {review.review.runType} #{review.review.runSeq}{review.review.cycleName?` · ${review.review.cycleName}`:''}</p>
   <p>{t('transition')}</p><p>{t(review.review.parentWillReopen?'parentReopens':'parentOpen')}</p><p>{t('consequence')}</p>
   <p>{t('exportWarning')}: {t(review.review.warnings.paymentDisbursed?'yes':'no')}</p><p>{t('statutoryWarning')}: {review.review.warnings.statutoryFiledCount} / {review.review.warnings.statutoryReportCount}</p>
   <p className="whitespace-pre-wrap">{t('reason')}: {review.content.reason}</p>
   {expired?<p>{t('expired')}</p>:<label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/><span>{t('confirmConsent')}</span></label>}
   <Button disabled={busy||expired||!confirmed} onClick={()=>void dispatch({action:C.action,operation:'confirm',confirmation:{action:C.action,contractVersion:1,actionId:review.actionId,reviewedDigest:review.reviewedDigest}})}>{t('confirm')}</Button>
   <Button variant="outline" disabled={busy} onClick={()=>void send('discard',review.actionId)}>{t('discard')}</Button>
  </div>}
  {state.kind==='done'&&<div className="space-y-2"><p>{t('receipt')}</p><p>{t('current')}: {statusText(`statuses.${state.receipt.receipt.currentStatus}`)} / {statusText(`periodStates.${state.receipt.receipt.currentPeriodStatus}`)}</p><Link href={'/payroll/'+state.receipt.receipt.batchId} className="inline-flex min-h-11 items-center underline">{t('native')}</Link><Button disabled={busy} onClick={()=>void send('reopen',state.receipt.actionId)}>{t('recover')}</Button></div>}
  {state.kind==='uncertain'&&state.actionId&&<Button disabled={busy} onClick={()=>void send('reopen',state.actionId!)}>{t('recover')}</Button>}
  <Button variant="outline" disabled={busy} onClick={()=>void dispatch({action:C.action,operation:'list'})}>{t('find')}</Button>
  {index&&<ul>{index.reviews.map(row=><li key={row.actionId} className="space-x-2 py-2"><span>{statusText(`states.${row.state}`)}</span><Button disabled={busy||!!known&&state.kind==='uncertain'&&known!==row.actionId} onClick={()=>void send('reopen',row.actionId)}>{t('recover')}</Button>{row.state!=='completed'&&<Button variant="outline" disabled={busy||!!known&&state.kind==='uncertain'&&known!==row.actionId} onClick={()=>void send('discard',row.actionId)}>{t('discard')}</Button>}</li>)}</ul>}
  {(state.kind==='done'||state.kind==='retired')&&<Button variant="outline" disabled={busy} onClick={()=>{clear();setState({kind:'draft'});}}>{t('new')}</Button>}
  <Link href="/payroll" className="inline-flex min-h-11 items-center underline">{t('native')}</Link>
 </section>;
}
