'use client';
/** ADR-0151 wave 1b: request overtime for one of your own employments. The person enters their own planned
 * window and reason, the server prepares the engine's minute count, and the person confirms. A request is
 * never an approval. A lost confirmation is never retried: the person reopens the same saved review. */
import Link from 'next/link';
import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {useFormatter,useTranslations} from 'next-intl';
import {z} from 'zod';
import {Button,inputCls} from '@/components/ui';
import {formatMinutesToHM} from '@/lib/overtime-duration';
import {OWN_OVERTIME_REQUEST_ACTION as action,OwnOvertimeChoices,OvertimeRequestPreparedReview,OvertimeRequestCompletedReview,OvertimeRequestRetiredReview,OvertimeRequestReviewIndex} from '@/lib/assistant-actions/own-overtime-request-contract';
import {checkGenericPacket,packetActionId,sendGenericModuleAction} from './generic-module-action-transport';
import {resolveProposalChoice,type ProposalResolutionKind} from '@/lib/ai/assistant-action-proposal-hints';
import {ProposalResolutionNote} from './proposal-resolution-note';
type Review=z.infer<typeof OvertimeRequestPreparedReview>;type Receipt=z.infer<typeof OvertimeRequestCompletedReview>;type Retired=z.infer<typeof OvertimeRequestRetiredReview>;type Row=z.infer<typeof OvertimeRequestReviewIndex>['reviews'][number];
type Choices=OwnOvertimeChoices|{kind:'loading'};
type State={kind:'selection'}|{kind:'review';review:Review}|{kind:'completed';receipt:Receipt}|{kind:'retired';receipt:Retired}|{kind:'uncertain';actionId:string|null};
const TIME=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
const fail=()=>Error('Overtime request unavailable.');
/** ADR-0151 §4.3 inline card: the date and planned window the person named in chat. The employment is
 * preselected only when the caller's own fresh choices hold exactly one; the reason and remark stay empty. */
export type OwnOvertimeProposalPrefill=Readonly<{date:string;plannedStartTime:string;plannedEndTime:string}>;
export function OwnOvertimeRequestPanel({resumeActionId,prefill,onSettled}:{resumeActionId?:string;prefill?:OwnOvertimeProposalPrefill;onSettled?:(settled:boolean)=>void}){
 const t=useTranslations('assistant.workspace.overtimeActions'),f=useFormatter(),id=useId();
 const [choices,setChoices]=useState<Choices>({kind:'loading'});
 const [state,setState]=useState<State>(()=>resumeActionId?{kind:'uncertain',actionId:z.uuid().safeParse(resumeActionId).success?resumeActionId:null}:{kind:'selection'});
 // An inline chat card (review R6) drops its suggestion chrome once the review is confirmed or retired.
 useEffect(()=>{onSettled?.(state.kind==='completed'||state.kind==='retired');},[state.kind,onSettled]);
 const [employmentId,setEmploymentId]=useState(''),[date,setDate]=useState(prefill?.date??''),[start,setStart]=useState(prefill?.plannedStartTime??''),[end,setEnd]=useState(prefill?.plannedEndTime??''),[reason,setReason]=useState(''),[remark,setRemark]=useState('');
 const [consent,setConsent]=useState(false),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[index,setIndex]=useState<Row[]|null>(null),[now,setNow]=useState(()=>Date.now());
 const flight=useRef(false),alive=useRef(true),sequence=useRef(0),abort=useRef<AbortController|null>(null),status=useRef<HTMLParagraphElement>(null);
 const prefilled=useRef(false),[resolution,setResolution]=useState<ProposalResolutionKind|null>(null);
 const review=state.kind==='review'?state.review:null;
 useEffect(()=>{if(!busy&&state.kind!=='selection')status.current?.focus();},[state,busy]);
 useEffect(()=>{setNow(Date.now());if(!review)return;const timer=setTimeout(()=>setNow(Date.now()),Math.min(2147483647,Math.max(0,Date.parse(review.expiresAt)-Date.now())));return()=>clearTimeout(timer);},[review]);
 const clear=()=>{setEmploymentId('');setDate('');setStart('');setEnd('');setReason('');setRemark('');setConsent(false);setConfirm(false);};
 async function dispatch(value:unknown){
  if(flight.current)return;const packet=checkGenericPacket(value);if(!packet||packet.action!==action){setError(t('unavailable'));return;}
  const op=packet.operation,token=++sequence.current,fallbackId=packetActionId(packet);
  flight.current=true;setBusy(op);setError('');setIndex(null);const controller=new AbortController();abort.current=controller;
  try{
   const result=await sendGenericModuleAction(packet,controller.signal);if(!alive.current||sequence.current!==token)return;
   if(op==='choices'){const loaded=OwnOvertimeChoices.parse(result);setChoices(loaded);
    // A chat proposal is applied once, to the first fresh choices: never to a later reload.
    if(prefill&&!prefilled.current&&loaded.kind==='choices'){prefilled.current=true;const found=resolveProposalChoice(loaded.employments,()=>true);setResolution(found.kind);if(found.kind==='one')setEmploymentId(found.row.employmentId);}
    return;}
   if(op==='list'){setIndex(OvertimeRequestReviewIndex.parse(result).reviews);return;}
   if(result.kind==='prepared'){const prepared=OvertimeRequestPreparedReview.parse((result as {review:unknown}).review);clear();setState({kind:'review',review:prepared});return;}
   if(result.kind==='completed'){const receipt=OvertimeRequestCompletedReview.parse((result as {receipt:unknown}).receipt);if(state.kind==='review'&&receipt.receipt.employmentId!==state.review.content.employmentId)throw fail();clear();setState({kind:'completed',receipt});return;}
   if(result.kind==='retired'){const receipt=OvertimeRequestRetiredReview.parse((result as {receipt:unknown}).receipt);clear();setState({kind:'retired',receipt});return;}
   throw fail();
  }catch{if(alive.current&&sequence.current===token){
   if(op==='choices'){setChoices({kind:'unavailable'});setError(t('choicesUnavailable'));return;}
   const prior=state.kind==='review'?state.review.actionId:null;clear();if(op!=='list'||prior)setState({kind:'uncertain',actionId:fallbackId??prior});setError(t('unavailable'));}}
  finally{if(sequence.current===token){flight.current=false;abort.current=null;if(alive.current)setBusy(null);}}
 }
 // Choices come from the same guarded POST; a remount (or a strict-mode re-run) starts a fresh load.
 useEffect(()=>{alive.current=true;flight.current=false;void dispatch({action,operation:'choices'});return()=>{alive.current=false;sequence.current++;abort.current?.abort();};
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 const list=choices.kind==='choices'?choices.employments:[],selected=list.find(row=>row.employmentId===employmentId);
 const valid=!!selected&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&TIME.test(start)&&TIME.test(end)&&start!==end&&reason.trim().length>0;
 function prepare(event:FormEvent){event.preventDefault();if(!consent||!valid||!selected||flight.current)return;
  // The person's own words only: an empty remark is left out rather than sent as blank text.
  const input:Record<string,unknown>={action,contractVersion:1,employmentId:selected.employmentId,date,plannedStartTime:start,plannedEndTime:end,reason};if(remark.trim())input.remark=remark;
  void dispatch({action,operation:'prepare',input});
 }
 function decide(operation:'confirm'|'discard'){if(!review||operation==='confirm'&&(!confirm||Date.now()>=Date.parse(review.expiresAt)))return;
  void dispatch(operation==='confirm'?{action,operation,confirmation:{action,contractVersion:1,actionId:review.actionId,reviewedDigest:review.reviewedDigest}}:{action,operation,confirmation:{action,contractVersion:1,actionId:review.actionId}});}
 const expired=review?now>=Date.parse(review.expiresAt):false,stamp=(value:string)=>f.dateTime(new Date(value),{dateStyle:'medium',timeStyle:'short'}),day=(value:string)=>f.dateTime(new Date(value+'T00:00:00'),{dateStyle:'medium'});
 const employment=(row:{companyName:string;employeeCode:string|null})=>row.employeeCode?t('employmentLabel',{company:row.companyName,code:row.employeeCode}):row.companyName;
 const reviewedEmployment=review?list.find(row=>row.employmentId===review.review.employmentId):undefined;
 const statusText=busy?(busy==='choices'?t('loading'):t('working')):state.kind==='review'?t('reviewNote'):state.kind==='completed'?t('done'):state.kind==='retired'?t('retired'):state.kind==='uncertain'?t(state.actionId?'uncertain':'uncertainUnknown'):'';
 return <section className="min-w-0 space-y-4" aria-label={t('title')} aria-busy={busy!==null}>
  <p ref={status} tabIndex={-1} role="status" aria-live="polite" className="text-sm outline-none">{statusText}</p>
  {error&&<p role="alert" className="text-sm">{error}</p>}
  {state.kind==='selection'&&choices.kind!=='loading'&&(choices.kind==='unavailable'?<div className="space-y-2"><p className="text-sm">{t('choicesUnavailable')}</p><Link href="/attendance/requests" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('manual')}</Link></div>:list.length===0?<p className="text-sm">{t('none')}</p>:<form onSubmit={prepare} className="space-y-4">{resolution&&<ProposalResolutionNote kind={resolution}/>}<p className="text-sm text-muted-foreground">{t('intro')}</p><fieldset disabled={busy!==null} className="space-y-4">
   <div><label htmlFor={`${id}-employment`} className="block text-sm font-medium">{t('employment')}</label><select id={`${id}-employment`} required value={employmentId} className={`${inputCls} mt-1`} onChange={event=>{setEmploymentId(event.target.value);setConsent(false);}}><option value="">{t('chooseEmployment')}</option>{list.map(row=><option key={row.employmentId} value={row.employmentId}>{employment(row)}</option>)}</select></div>
   <div><label htmlFor={`${id}-date`} className="block text-sm font-medium">{t('date')}</label><input id={`${id}-date`} type="date" required value={date} className={`${inputCls} mt-1`} onChange={event=>setDate(event.target.value)}/></div>
   <div className="grid gap-3 sm:grid-cols-2"><div><label htmlFor={`${id}-start`} className="block text-sm font-medium">{t('plannedStart')}</label><input id={`${id}-start`} type="time" required value={start} className={`${inputCls} mt-1`} onChange={event=>setStart(event.target.value)}/></div>
    <div><label htmlFor={`${id}-end`} className="block text-sm font-medium">{t('plannedEnd')}</label><input id={`${id}-end`} type="time" required value={end} aria-describedby={`${id}-next-day`} className={`${inputCls} mt-1`} onChange={event=>setEnd(event.target.value)}/></div></div>
   <p id={`${id}-next-day`} className="text-xs text-muted-foreground">{t('nextDayHint')}</p>
   {start&&end&&start===end&&<p role="alert" className="text-sm">{t('sameTime')}</p>}
   <div><label htmlFor={`${id}-reason`} className="block text-sm font-medium">{t('reason')}</label><textarea id={`${id}-reason`} required maxLength={4000} value={reason} className={`${inputCls} mt-1`} onChange={event=>setReason(event.target.value)}/></div>
   <div><label htmlFor={`${id}-remark`} className="block text-sm font-medium">{t('remark')}</label><textarea id={`${id}-remark`} maxLength={4000} value={remark} className={`${inputCls} mt-1`} onChange={event=>setRemark(event.target.value)}/></div>
   <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} className="mt-1"/>{t('consent')}</label>
   <Button type="submit" disabled={!valid||!consent}>{t('prepare')}</Button>
  </fieldset></form>)}
  {review&&<div className="space-y-4 rounded-lg border border-border p-4"><h3 className="font-semibold">{t('reviewTitle')}</h3>
   <dl className="space-y-1 text-sm">
    {reviewedEmployment&&<div><dt className="font-medium">{t('employment')}</dt><dd>{employment(reviewedEmployment)}</dd></div>}
    <div><dt className="font-medium">{t('date')}</dt><dd>{day(review.review.date)}</dd></div>
    <div><dt className="font-medium">{t('window')}</dt><dd>{t('windowValue',{start:review.review.plannedStartTime,end:review.review.plannedEndTime})}{review.review.plannedEndTime<review.review.plannedStartTime?` ${t('nextDay')}`:''}</dd></div>
    <div><dt className="font-medium">{t('minutes')}</dt><dd>{formatMinutesToHM(review.review.requestedOtMinutes)}</dd></div>
    <div><dt className="font-medium">{t('reason')}</dt><dd className="whitespace-pre-wrap break-words">{review.review.reason}</dd></div>
    <div><dt className="font-medium">{t('remark')}</dt><dd className="whitespace-pre-wrap break-words">{review.review.remark??t('empty')}</dd></div>
   </dl>
   <p className="text-sm font-medium">{t('consequence')}</p><p className="text-xs text-muted-foreground">{t('expires')}: {stamp(review.expiresAt)}</p>
   {expired?<p role="alert" className="text-sm">{t('expired')}</p>:<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirm} disabled={busy!==null} onChange={event=>setConfirm(event.target.checked)} className="mt-1"/>{t('confirmConsent')}</label>}
   <div className="flex flex-wrap gap-3"><Button type="button" disabled={busy!==null||!confirm||expired} onClick={()=>decide('confirm')}>{t('confirm')}</Button><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>decide('discard')}>{t('discard')}</Button></div></div>}
  {state.kind==='uncertain'&&state.actionId&&<Button type="button" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'reopen',actionId:state.actionId})}>{t('reopen')}</Button>}
  {state.kind==='completed'&&<div className="space-y-2 rounded-lg border border-border p-4"><h3 className="font-semibold">{t('done')}</h3><p className="text-sm">{t('doneMeaning')}</p>
   <dl className="space-y-1 text-sm"><div><dt className="font-medium">{t('date')}</dt><dd>{day(state.receipt.receipt.date)}</dd></div><div><dt className="font-medium">{t('minutes')}</dt><dd>{formatMinutesToHM(state.receipt.receipt.requestedOtMinutes)}</dd></div>
    <div><dt className="font-medium">{t('currentStatus')}</dt><dd>{t(`statuses.${state.receipt.receipt.currentStatus}`)}</dd></div></dl>
   {state.receipt.receipt.cancelled&&<p className="text-sm">{t('cancelledNote')}</p>}</div>}
  {state.kind==='retired'&&<p className="text-sm">{t('retiredState')}: {t(`states.${state.receipt.state}`)}</p>}
  {(state.kind==='completed'||state.kind==='retired'||state.kind==='uncertain'&&!state.actionId)&&<Button type="button" variant="outline" disabled={busy!==null} onClick={()=>{clear();setState({kind:'selection'});setIndex(null);setError('');void dispatch({action,operation:'choices'});}}>{t('another')}</Button>}
  <div className="space-y-3 border-t border-border pt-4"><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'list'})}>{t('find')}</Button><p className="text-xs text-muted-foreground">{t('indexScope')}</p>
   {index&&(index.length===0?<p className="text-sm">{t('noReviews')}</p>:<ul className="space-y-2 text-sm">{index.map(row=><li key={row.actionId} className="flex flex-wrap items-center gap-3"><span>{stamp(row.createdAt)} · {t(`states.${row.state}`)}</span><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'reopen',actionId:row.actionId})}>{t('reopen')}</Button></li>)}</ul>)}</div>
 </section>;
}
