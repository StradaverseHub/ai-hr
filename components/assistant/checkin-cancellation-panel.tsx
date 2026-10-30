'use client';
/** Human-only native scheduled check-in cancellation. The server owns every displayed review fact and
 * re-checks authority; a lost command is recovered by reopening the same review, never by replaying it. */
import Link from 'next/link';
import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {useFormatter,useTranslations} from 'next-intl';
import {z} from 'zod';
import {Button,inputCls} from '@/components/ui';
import {CheckInCancellation as contract,CHECKIN_CANCELLATION_ACTION as action} from '@/lib/assistant-actions/checkin-cancellation-contract';
import {checkGenericPacket,packetActionId,sendGenericModuleAction} from './generic-module-action-transport';
type Subject={subjectId:string;employmentId:string;employeeName:string;companyName:string;scheduledOn:string};
type Choices={kind:'choices';items:Subject[];truncated:boolean}|{kind:'idle'|'unavailable'};
type Item=Subject&{before:string;after:string};
type Review={actionId:string;reviewedDigest:string;createdAt:string;expiresAt:string;content:{employmentId:string;subjectId:string};review:Item};
type Receipt={actionId:string;state:'completed';receipt:{subjectId:string;employmentId:string;eventId:string}};
type Retired={actionId:string;state:'discarded'|'expired'|'refused'};
type IndexRow={actionId:string;state:string;createdAt:string};
type State={kind:'selection'}|{kind:'review';review:Review}|{kind:'completed';receipt:Receipt}|{kind:'retired';receipt:Retired}|{kind:'uncertain';actionId:string|null};
export function CheckInCancellationPanel({resumeActionId,initialCheckinId}:{resumeActionId?:string;initialCheckinId?:string}){
 const t=useTranslations('assistant.workspace.checkInCancellation'),format=useFormatter(),id=useId();
 const [choices,setChoices]=useState<Choices>({kind:'idle'}),[query,setQuery]=useState('');
 const [checkinId,setCheckinId]=useState(initialCheckinId&&z.uuid().safeParse(initialCheckinId).success?initialCheckinId:'');
 const [state,setState]=useState<State>(()=>resumeActionId?{kind:'uncertain',actionId:z.uuid().safeParse(resumeActionId).success?resumeActionId:null}:{kind:'selection'});
 const [consent,setConsent]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[index,setIndex]=useState<IndexRow[]|null>(null),[now,setNow]=useState(()=>Date.now());
 const alive=useRef(true),flight=useRef(false),sequence=useRef(0),abort=useRef<AbortController|null>(null),status=useRef<HTMLParagraphElement>(null);
 const review=state.kind==='review'?state.review:null;
 const clear=()=>{setConsent(false);setConfirmed(false);};
 useEffect(()=>{if(!busy&&state.kind!=='selection')status.current?.focus();},[state,busy]);
 useEffect(()=>{setNow(Date.now());if(!review)return;const timer=setTimeout(()=>setNow(Date.now()),Math.min(2147483647,Math.max(0,Date.parse(review.expiresAt)-Date.now())));return()=>clearTimeout(timer);},[review]);
 async function dispatch(value:unknown){
  if(flight.current)return;
  const packet=checkGenericPacket(value);if(!packet||packet.action!==action){setError(t('unavailable'));return;}
  const op=packet.operation,token=++sequence.current,fallbackId=packetActionId(packet),prior=state.kind==='review'?state.review.actionId:null;
  flight.current=true;setBusy(op);setError('');setIndex(null);const controller=new AbortController();abort.current=controller;
  try{
   const result=await sendGenericModuleAction(packet,controller.signal);if(!alive.current||sequence.current!==token)return;
   if(op==='choices'){setChoices(contract.Choices.parse(result) as Choices);setConsent(false);return;}
   if(op==='list'){setIndex((contract.Index.parse(result) as {reviews:IndexRow[]}).reviews);return;}
   if(result.kind==='prepared'){const saved=contract.Prepared.parse((result as {review:unknown}).review) as Review;clear();setState({kind:'review',review:saved});return;}
   if(result.kind==='completed'){const receipt=contract.Completed.parse((result as {receipt:unknown}).receipt) as Receipt;if(review&&receipt.receipt.subjectId!==review.content.subjectId)throw Error();clear();setState({kind:'completed',receipt});return;}
   if(result.kind==='retired'){const receipt=contract.Retired.parse((result as {receipt:unknown}).receipt) as Retired;clear();setState({kind:'retired',receipt});return;}
   throw Error();
  }catch{if(alive.current&&sequence.current===token){if(op==='choices'){setChoices({kind:'unavailable'});setError(t('choicesUnavailable'));return;}
   clear();if(op!=='list'||prior)setState({kind:'uncertain',actionId:fallbackId??prior});setError(t('unavailable'));}}
  finally{if(sequence.current===token){flight.current=false;abort.current=null;if(alive.current)setBusy(null);}}
 }
 const load=(selected=checkinId,text=query)=>void dispatch({action,operation:'choices',selection:{query:text,...(selected?{subjectId:selected}:{})}});
 useEffect(()=>{alive.current=true;flight.current=false;if(state.kind==='selection')load();return()=>{alive.current=false;sequence.current++;abort.current?.abort();};
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 const listed=choices.kind==='choices'?choices.items:[],selected=listed.find(row=>row.subjectId===checkinId);
 const ready=!!selected&&consent&&busy===null;
 function prepare(event:FormEvent){event.preventDefault();if(!ready||flight.current||!selected)return;
  const input={action,contractVersion:1,employmentId:selected.employmentId,subjectId:selected.subjectId,cancel:true};
  if(!contract.Human.safeParse(input).success){setError(t('invalid'));return;}void dispatch({action,operation:'prepare',input});
 }
 function decide(op:'confirm'|'discard'){
  if(!review||op==='confirm'&&(!confirmed||Date.now()>=Date.parse(review.expiresAt)))return;
  void dispatch({action,operation:op,confirmation:{action,contractVersion:1,actionId:review.actionId,...(op==='confirm'?{reviewedDigest:review.reviewedDigest}:{})}});
 }
 const person=(row:Subject)=>`${row.scheduledOn} · ${row.employeeName} · ${row.companyName}`;
 const stamp=(value:string)=>format.dateTime(new Date(value),{dateStyle:'medium',timeStyle:'short'});
 const expired=review?now>=Date.parse(review.expiresAt):false;
 const statusText=busy?t(busy==='choices'?'loading':'working'):state.kind==='review'?t('reviewNote'):state.kind==='completed'?t('done'):state.kind==='retired'?t('retired'):state.kind==='uncertain'?t(state.actionId?'uncertain':'uncertainUnknown'):'';
 return <section aria-label={t('title')} aria-busy={busy!==null} className="min-w-0 space-y-4">
  <p ref={status} tabIndex={-1} role="status" aria-live="polite" className="text-sm outline-none">{statusText}</p>
  {error&&<p role="alert" className="text-sm">{error}</p>}
  {state.kind==='selection'&&(choices.kind==='unavailable'?<div className="space-y-2"><p className="text-sm">{t('choicesUnavailable')}</p><Link href="/performance" className="inline-flex min-h-11 items-center text-sm underline focus-visible:ring-2 focus-visible:ring-ring">{t('manual')}</Link></div>:
   <form onSubmit={prepare} className="space-y-4"><p className="text-sm text-muted-foreground">{t('intro')}</p><fieldset disabled={busy!==null} className="space-y-4">
    <div className="flex flex-wrap items-end gap-2"><div className="min-w-0 flex-1"><label htmlFor={`${id}-search`} className="block text-sm font-medium">{t('search')}</label><input id={`${id}-search`} maxLength={80} value={query} onChange={event=>setQuery(event.target.value)} className={`${inputCls} mt-1`}/></div><Button type="button" variant="outline" onClick={()=>{setCheckinId('');clear();load('',query);}}>{t('searchButton')}</Button></div>
    <div><label htmlFor={`${id}-employee`} className="block text-sm font-medium">{t('employee')}</label><select id={`${id}-employee`} required value={checkinId} className={`${inputCls} mt-1`} onChange={event=>{const next=event.target.value;setCheckinId(next);clear();load(next,query);}}><option value="">{t('choose')}</option>{listed.map(row=><option key={row.subjectId} value={row.subjectId}>{person(row)}</option>)}</select>
     {choices.kind==='choices'&&listed.length===0&&<p className="mt-1 text-xs">{t('noEmployees')}</p>}{choices.kind==='choices'&&choices.truncated&&<p className="mt-1 text-xs">{t('truncated')}</p>}</div>
    {selected&&<>
     <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} className="mt-1"/>{t('consent')}</label><Button type="submit" disabled={!ready}>{t('prepare')}</Button>
    </>}
   </fieldset></form>)}
  {review&&<div className="min-w-0 space-y-4 rounded-lg border border-border p-4"><h3 className="font-semibold">{t('reviewTitle')}</h3><dl className="space-y-2 text-sm"><div><dt className="font-medium">{t('employee')}</dt><dd className="break-words">{person(review.review)}</dd></div></dl>
   <div className="grid min-w-0 gap-3 text-sm sm:grid-cols-2"><div><p className="font-medium">{t('before')}</p><p className="break-words">{t('scheduled')}</p></div><div><p className="font-medium">{t('after')}</p><p className="break-words">{t('cancelled')}</p></div></div>
   <p className="text-sm font-medium">{t('consequence')}</p><p className="text-xs text-muted-foreground">{t('expires')}: {stamp(review.expiresAt)}</p>
   {expired?<p role="alert" className="text-sm">{t('expired')}</p>:<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy!==null} onChange={event=>setConfirmed(event.target.checked)} className="mt-1"/>{t('confirmConsent')}</label>}
   <div className="flex flex-wrap gap-3"><Button type="button" disabled={busy!==null||!confirmed||expired} onClick={()=>decide('confirm')}>{t('confirm')}</Button><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>decide('discard')}>{t('discard')}</Button></div>
  </div>}
  {state.kind==='uncertain'&&state.actionId&&<Button type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'reopen',actionId:state.actionId})}>{t('reopen')}</Button>}
  {state.kind==='completed'&&<div className="space-y-2 rounded-lg border border-border p-4"><h3 className="font-semibold">{t('done')}</h3><p className="text-sm">{t('doneMessage')}</p></div>}
  {state.kind==='retired'&&<p className="text-sm">{t('retired')}: {t(`states.${state.receipt.state}`)}</p>}
  {(state.kind==='completed'||state.kind==='retired'||state.kind==='uncertain'&&!state.actionId)&&<Button type="button" variant="outline" disabled={busy!==null} onClick={()=>{clear();setState({kind:'selection'});setError('');load();}}>{t('another')}</Button>}
  <Link href="/performance" className="inline-flex min-h-11 items-center text-sm underline">{t('manual')}</Link>
  <div className="space-y-3 border-t border-border pt-4"><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'list'})}>{t('find')}</Button><p className="text-xs text-muted-foreground">{t('indexScope')}</p>
   {index&&(index.length===0?<p className="text-sm">{t('noReviews')}</p>:<ul className="space-y-2 text-sm">{index.map(row=><li key={row.actionId} className="flex flex-wrap items-center gap-3"><span>{stamp(row.createdAt)} · {t(`states.${row.state}`)}</span><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'reopen',actionId:row.actionId})}>{t('reopen')}</Button></li>)}</ul>)}
  </div>
 </section>;
}
