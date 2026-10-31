'use client';
/** ADR-0151 wave 1: cancel, or change the dates/reason/remark of, one of your own pending leave requests. The
 * person chooses, the server prepares the engine's figures, and the person confirms. A lost confirmation is
 * never retried: the person reopens the same saved review. */
import Link from 'next/link';
import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {useFormatter,useTranslations} from 'next-intl';
import {z} from 'zod';
import {Button,inputCls} from '@/components/ui';
import {OWN_LEAVE_CANCELLATION_ACTION as cancelAction,OWN_LEAVE_EDIT_ACTION as editAction,OwnLeaveChangeChoices,type OwnPendingLeave} from '@/lib/assistant-actions/own-leave-change-contract';
import {LeaveCancellationModuleActionBrowserPacket,LeaveEditModuleActionBrowserPacket,parseLeaveChangeModuleActionBrowserResult,type LeaveChangeModuleActionBrowserPacket,type LeaveChangeModuleActionBrowserResult} from '@/lib/assistant-actions/module-action-http';
import {leaveProposalMatches,resolveProposalChoice} from '@/lib/ai/assistant-action-proposal-hints';
import {ProposalResolutionNote} from './proposal-resolution-note';
type Action=typeof cancelAction|typeof editAction;
type Prepared=Extract<LeaveChangeModuleActionBrowserResult,{kind:'prepared'}>['review'];type Completed=Extract<LeaveChangeModuleActionBrowserResult,{kind:'completed'}>['receipt'];type Retired=Extract<LeaveChangeModuleActionBrowserResult,{kind:'retired'}>['receipt'];
type Row={action:Action;actionId:string;state:string;createdAt:string};
type State={kind:'selection'}|{kind:'review';review:Prepared}|{kind:'completed';receipt:Completed}|{kind:'retired';receipt:Retired}|{kind:'uncertain';actionId:string|null;action:Action};
const fail=()=>Error('Leave change unavailable.');
export async function readOwnLeaveChangeResponse(response:Response,packet:LeaveChangeModuleActionBrowserPacket):Promise<LeaveChangeModuleActionBrowserResult>{
 const reject=async():Promise<never>=>{await response.body?.cancel().catch(()=>undefined);throw fail();};
 if(!response.ok||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!response.body)return reject();
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let bytes=0,fragments=0;
 try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(++fragments>256||bytes>32768)throw fail();parts.push(part.value);}
  const data=new Uint8Array(bytes);let offset=0;for(const part of parts){data.set(part,offset);offset+=part.byteLength;}
  return parseLeaveChangeModuleActionBrowserResult(packet,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)));
 }catch{await reader.cancel().catch(()=>undefined);throw fail();}finally{reader.releaseLock();}
}
/** ADR-0151 §4.3 inline card: the change and dates the person named in chat. The request is preselected
 * only when exactly one of the caller's own pending requests starts on the named date (or, with no date,
 * when only one is pending). Stored reason and remark are shown as they are and sent only if edited. */
export type OwnLeaveChangeProposalPrefill=Readonly<{action:Action;startDate?:string;newStartDate?:string;newEndDate?:string}>;
export function OwnLeaveChangePanel({choices:raw,resumeActionId,resumeAction,prefill,onSettled}:{choices:OwnLeaveChangeChoices;resumeActionId?:string;resumeAction?:Action;prefill?:OwnLeaveChangeProposalPrefill;onSettled?:(settled:boolean)=>void}){
 const parsed=OwnLeaveChangeChoices.safeParse(raw),choices=parsed.success?parsed.data:{kind:'unavailable' as const},t=useTranslations('ownLeaveChange'),f=useFormatter(),id=useId();
 const proposedDates=prefill?.action===editAction?prefill:undefined;
 // Resolved once against the caller's own fresh choices; the result is a preselection or a question.
 const [proposal]=useState(()=>prefill&&choices.kind==='choices'?resolveProposalChoice(choices.requests,leaveProposalMatches(prefill)):null),proposed=proposal?.kind==='one'?proposal.row:undefined;
 const [state,setState]=useState<State>(()=>resumeActionId&&resumeAction?{kind:'uncertain',actionId:z.uuid().safeParse(resumeActionId).success?resumeActionId:null,action:resumeAction}:{kind:'selection'});
 // An inline chat card (review R6) drops its suggestion chrome once the review is confirmed or retired.
 useEffect(()=>{onSettled?.(state.kind==='completed'||state.kind==='retired');},[state.kind,onSettled]);
 const [requestId,setRequestId]=useState(proposed?.leaveRequestId??''),[mode,setMode]=useState<Action>(prefill?.action??cancelAction),[start,setStart]=useState(proposed?proposedDates?.newStartDate??proposed.startDate:''),[end,setEnd]=useState(proposed?proposedDates?.newEndDate??proposed.endDate:''),[reason,setReason]=useState(proposed?.reason??''),[remark,setRemark]=useState(proposed?.employeeRemark??'');
 const [consent,setConsent]=useState(false),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[index,setIndex]=useState<Row[]|null>(null),[now,setNow]=useState(()=>Date.now());
 const flight=useRef(false),alive=useRef(true),sequence=useRef(0),abort=useRef<AbortController|null>(null),status=useRef<HTMLParagraphElement>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;abort.current?.abort();};},[]);
 const review=state.kind==='review'?state.review:null;
 useEffect(()=>{if(!busy&&state.kind!=='selection')status.current?.focus();},[state,busy]);
 useEffect(()=>{setNow(Date.now());if(!review)return;const timer=setTimeout(()=>setNow(Date.now()),Math.min(2147483647,Math.max(0,Date.parse(review.expiresAt)-Date.now())));return()=>clearTimeout(timer);},[review]);
 const selected=choices.kind==='choices'?choices.requests.find(row=>row.leaveRequestId===requestId):undefined;
 const choose=(value:string)=>{setRequestId(value);const row=choices.kind==='choices'?choices.requests.find(item=>item.leaveRequestId===value):undefined;setStart(row?proposedDates?.newStartDate??row.startDate:'');setEnd(row?proposedDates?.newEndDate??row.endDate:'');setReason(row?.reason??'');setRemark(row?.employeeRemark??'');setConsent(false);};
 const clear=()=>{setRequestId('');setStart('');setEnd('');setReason('');setRemark('');setConsent(false);setConfirm(false);};
 async function dispatch(value:unknown){
  if(flight.current)return;const action=(value as {action?:unknown})?.action,schema=action===editAction?LeaveEditModuleActionBrowserPacket:LeaveCancellationModuleActionBrowserPacket,checked=schema.safeParse(structuredClone(value));
  if(!checked.success){setError(t('unavailable'));return;}
  const packet=checked.data as LeaveChangeModuleActionBrowserPacket,op=packet.operation,token=++sequence.current,fallbackId=op==='reopen'?packet.actionId:op==='confirm'||op==='discard'?(packet.confirmation as {actionId:string}).actionId:null;
  flight.current=true;setBusy(op);setError('');setIndex(null);const controller=new AbortController();abort.current=controller;
  try{
   const response=await fetch('/api/assistant/module-actions',{method:'POST',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(packet)});
   const result=await readOwnLeaveChangeResponse(response,packet);if(!alive.current||sequence.current!==token)return;
   if(result.kind==='leave_cancellation_review_index'||result.kind==='leave_edit_review_index'){setIndex(result.reviews.map(row=>({action:row.action,actionId:row.actionId,state:row.state,createdAt:row.createdAt})));return;}
   if(result.kind==='choices'||result.kind==='unavailable')return;
   if(result.kind==='completed'&&state.kind==='review'&&result.receipt.receipt.leaveRequestId!==state.review.content.leaveRequestId)throw fail();
   clear();if(result.kind==='prepared')setState({kind:'review',review:result.review});else if(result.kind==='completed')setState({kind:'completed',receipt:result.receipt});else setState({kind:'retired',receipt:result.receipt});
  }catch{if(alive.current&&sequence.current===token){const prior=state.kind==='review'?state.review.actionId:null;clear();if(op!=='list'||prior)setState({kind:'uncertain',actionId:fallbackId??prior,action:packet.action});setError(t('unavailable'));}}
  finally{if(sequence.current===token){flight.current=false;abort.current=null;if(alive.current)setBusy(null);}}
 }
 function prepare(event:FormEvent){event.preventDefault();if(!consent||!selected||flight.current)return;
  if(mode===cancelAction){void dispatch({action:cancelAction,operation:'prepare',input:{action:cancelAction,contractVersion:1,employmentId:selected.employmentId,leaveRequestId:selected.leaveRequestId,cancel:true}});return;}
  // Only text the person actually changed is sent; untouched reason and remark keep their current wording.
  const input:Record<string,unknown>={action:editAction,contractVersion:1,employmentId:selected.employmentId,leaveRequestId:selected.leaveRequestId,startDate:start,endDate:end};
  if(reason!==(selected.reason??''))input.reason=reason;if(remark!==(selected.employeeRemark??''))input.employeeRemark=remark;
  void dispatch({action:editAction,operation:'prepare',input});
 }
 function decide(operation:'confirm'|'discard'){if(!review||operation==='confirm'&&(!confirm||Date.now()>=Date.parse(review.expiresAt)))return;const action=review.action;
  void dispatch(operation==='confirm'?{action,operation,confirmation:{action,contractVersion:1,actionId:review.actionId,reviewedDigest:review.reviewedDigest}}:{action,operation,confirmation:{action,contractVersion:1,actionId:review.actionId}});}
 const day=(value:string)=>f.dateTime(new Date(value+'T00:00:00'),{dateStyle:'medium'}),stamp=(value:string)=>f.dateTime(new Date(value),{dateStyle:'medium',timeStyle:'short'}),expired=review?now>=Date.parse(review.expiresAt):false;
 const describe=(row:OwnPendingLeave)=>t('requestLabel',{type:row.leaveTypeName,start:day(row.startDate),end:day(row.endDate),days:f.number(row.days)});
 const editAfter=review&&'before' in review.review?review.review.after:null,subject=review?('before' in review.review?review.review.before:review.review):null;
 const changed=selected&&(start!==selected.startDate||end!==selected.endDate||reason!==(selected.reason??'')||remark!==(selected.employeeRemark??''));
 return <section className="min-w-0 space-y-4" aria-label={t('title')} aria-busy={busy!==null}>
  <p ref={status} tabIndex={-1} role="status" aria-live="polite" className="text-sm outline-none">{busy?t('working'):state.kind==='review'?t('reviewNote'):state.kind==='completed'?t(state.receipt.action===editAction?'editDone':'cancelDone'):state.kind==='retired'?t('retired'):state.kind==='uncertain'?t('uncertain'):''}</p>
  {error&&<p role="alert" className="text-sm">{error}</p>}
  {state.kind==='selection'&&(choices.kind==='unavailable'?<p role="alert">{t('unavailable')}</p>:choices.requests.length===0?<p className="text-sm">{t('none')}</p>:<form onSubmit={prepare} className="space-y-4">{proposal&&<ProposalResolutionNote kind={proposal.kind}/>}<fieldset disabled={busy!==null} className="space-y-4">
   <div><label htmlFor={`${id}-request`} className="block text-sm font-medium">{t('choose')}</label><select id={`${id}-request`} required value={requestId} className={`${inputCls} mt-1`} onChange={event=>choose(event.target.value)}><option value="">{t('choosePrompt')}</option>{choices.requests.map(row=><option key={row.leaveRequestId} value={row.leaveRequestId}>{describe(row)}</option>)}</select></div>
   <fieldset className="space-y-2"><legend className="text-sm font-medium">{t('modeLabel')}</legend>
    <label className="flex items-center gap-2 text-sm"><input type="radio" name={`${id}-mode`} checked={mode===cancelAction} onChange={()=>{setMode(cancelAction);setConsent(false);}}/>{t('modeCancel')}</label>
    <label className="flex items-center gap-2 text-sm"><input type="radio" name={`${id}-mode`} checked={mode===editAction} onChange={()=>{setMode(editAction);setConsent(false);}}/>{t('modeEdit')}</label>
   </fieldset>
   {mode===editAction&&selected&&<div className="space-y-3">
    <p className="text-xs text-muted-foreground">{t('editScope')}</p>
    <div className="grid gap-3 sm:grid-cols-2"><div><label htmlFor={`${id}-start`} className="block text-sm font-medium">{t('startDate')}</label><input id={`${id}-start`} type="date" required value={start} className={`${inputCls} mt-1`} onChange={event=>setStart(event.target.value)}/></div>
     <div><label htmlFor={`${id}-end`} className="block text-sm font-medium">{t('endDate')}</label><input id={`${id}-end`} type="date" required min={start} value={end} className={`${inputCls} mt-1`} onChange={event=>setEnd(event.target.value)}/></div></div>
    <div><label htmlFor={`${id}-reason`} className="block text-sm font-medium">{t('reason')}</label><textarea id={`${id}-reason`} maxLength={4000} value={reason} className={`${inputCls} mt-1`} onChange={event=>setReason(event.target.value)}/></div>
    <div><label htmlFor={`${id}-remark`} className="block text-sm font-medium">{t('remark')}</label><textarea id={`${id}-remark`} maxLength={4000} value={remark} className={`${inputCls} mt-1`} onChange={event=>setRemark(event.target.value)}/></div>
    <Link href="/leave" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('otherChanges')}</Link>
   </div>}
   <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} className="mt-1"/>{t(mode===editAction?'editConsent':'cancelConsent')}</label>
   <Button type="submit" disabled={!selected||!consent||mode===editAction&&(!changed||!start||!end||end<start)}>{t('prepare')}</Button>
  </fieldset>{choices.truncated&&<p className="text-xs">{t('truncated')}</p>}</form>)}
  {review&&subject&&<div className="space-y-4 rounded-lg border border-border p-4"><h3 className="font-semibold">{t(editAfter?'editReviewTitle':'cancelReviewTitle')}</h3><p className="text-sm">{describe(subject)}</p>
   {editAfter&&<dl className="space-y-1 text-sm"><div><dt className="font-medium">{t('newDates')}</dt><dd>{t('datesLabel',{start:day(editAfter.startDate),end:day(editAfter.endDate)})}</dd></div><div><dt className="font-medium">{t('newDays')}</dt><dd>{f.number(editAfter.days)}</dd></div>
    <div><dt className="font-medium">{t('reason')}</dt><dd>{editAfter.reason??t('empty')}</dd></div><div><dt className="font-medium">{t('remark')}</dt><dd>{editAfter.employeeRemark??t('empty')}</dd></div></dl>}
   <p className="text-sm">{t(editAfter?'editMeaning':'cancelMeaning')}</p><p className="text-xs text-muted-foreground">{t('expires')}: {stamp(review.expiresAt)}</p>
   {expired?<p role="alert" className="text-sm">{t('expired')}</p>:<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirm} disabled={busy!==null} onChange={event=>setConfirm(event.target.checked)} className="mt-1"/>{t(editAfter?'editConfirmConsent':'cancelConfirmConsent')}</label>}
   <div className="flex flex-wrap gap-3"><Button type="button" disabled={busy!==null||!confirm||expired} onClick={()=>decide('confirm')}>{t(editAfter?'editConfirm':'cancelConfirm')}</Button><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>decide('discard')}>{t('discard')}</Button></div></div>}
  {state.kind==='uncertain'&&state.actionId&&<Button type="button" disabled={busy!==null} onClick={()=>void dispatch({action:state.action,operation:'reopen',actionId:state.actionId})}>{t('reopen')}</Button>}
  {state.kind==='completed'&&<div className="space-y-2 rounded-lg border border-border p-4"><h3 className="font-semibold">{t(state.receipt.action===editAction?'editDone':'cancelDone')}</h3><p className="text-sm">{t(state.receipt.action===editAction?'editDoneMeaning':'cancelDoneMeaning')}</p><p className="text-sm">{t('currentStatus')}: {t(`statuses.${state.receipt.receipt.currentStatus}`)}</p></div>}
  {(state.kind==='completed'||state.kind==='retired')&&<Button type="button" variant="outline" disabled={busy!==null} onClick={()=>{clear();setState({kind:'selection'});setIndex(null);setError('');}}>{t('another')}</Button>}
  <div className="space-y-3 border-t border-border pt-4"><div className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action:cancelAction,operation:'list'})}>{t('findCancellations')}</Button><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action:editAction,operation:'list'})}>{t('findEdits')}</Button></div><p className="text-xs text-muted-foreground">{t('indexScope')}</p>
   {index&&(index.length===0?<p className="text-sm">{t('noReviews')}</p>:<ul className="space-y-2 text-sm">{index.map(row=><li key={row.actionId} className="flex flex-wrap items-center gap-3"><span>{stamp(row.createdAt)} · {t(`states.${row.state}`)}</span><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action:row.action,operation:'reopen',actionId:row.actionId})}>{t('reopen')}</Button></li>)}</ul>)}</div>
 </section>;
}
