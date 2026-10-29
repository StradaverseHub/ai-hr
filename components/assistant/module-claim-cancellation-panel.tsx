'use client';
/** ADR-0151 wave 1: cancel one of your own pending claims. The person picks the claim and confirms the
 * exact stored values; the server cancels through the native claims service. A lost response is never
 * retried: the person reopens the same saved review to learn what happened. */
import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {useFormatter,useTranslations} from 'next-intl';
import {z} from 'zod';
import {Button,inputCls} from '@/components/ui';
import {OWN_CLAIM_CANCELLATION_ACTION as action,OwnClaimCancellationChoices,ClaimCancellationPreparedReview,ClaimCancellationCompletedReview,ClaimCancellationRetiredReview,ClaimCancellationReviewIndex} from '@/lib/assistant-actions/own-claim-cancellation-contract';
import {ClaimCancellationModuleActionBrowserPacket,parseClaimCancellationModuleActionBrowserResult,type ClaimCancellationModuleActionBrowserResult} from '@/lib/assistant-actions/module-action-http';
import {claimProposalMatches,resolveProposalChoice} from '@/lib/ai/assistant-action-proposal-hints';
import {ProposalResolutionNote} from './proposal-resolution-note';
type Packet=z.infer<typeof ClaimCancellationModuleActionBrowserPacket>;type Review=z.infer<typeof ClaimCancellationPreparedReview>;type Receipt=z.infer<typeof ClaimCancellationCompletedReview>;type Retired=z.infer<typeof ClaimCancellationRetiredReview>;type Row=z.infer<typeof ClaimCancellationReviewIndex>['reviews'][number];
type State={kind:'selection'}|{kind:'review';review:Review}|{kind:'completed';receipt:Receipt}|{kind:'retired';receipt:Retired}|{kind:'uncertain';actionId:string|null};
const fail=()=>Error('Claim cancellation unavailable.');
export async function readModuleClaimCancellationResponse(response:Response,packet:Packet):Promise<ClaimCancellationModuleActionBrowserResult>{
 const reject=async():Promise<never>=>{await response.body?.cancel().catch(()=>undefined);throw fail();};
 if(!response.ok||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!response.body)return reject();
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let bytes=0,fragments=0;
 try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(++fragments>256||bytes>32768)throw fail();parts.push(part.value);}
  const data=new Uint8Array(bytes);let offset=0;for(const part of parts){data.set(part,offset);offset+=part.byteLength;}
  return parseClaimCancellationModuleActionBrowserResult(packet,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)));
 }catch{await reader.cancel().catch(()=>undefined);throw fail();}finally{reader.releaseLock();}
}
/** ADR-0151 §4.3 inline card: the incurred date the person named in chat. The claim is preselected only when
 * exactly one of the caller's own pending claims matches (or, with no date, only one is pending). */
export type ClaimCancellationProposalPrefill=Readonly<{incurredOn?:string}>;
export function ModuleClaimCancellationPanel({choices:raw,resumeActionId,prefill,onSettled}:{choices:OwnClaimCancellationChoices;resumeActionId?:string;prefill?:ClaimCancellationProposalPrefill;onSettled?:(settled:boolean)=>void}){
 const parsed=OwnClaimCancellationChoices.safeParse(raw),choices=parsed.success?parsed.data:{kind:'unavailable' as const},t=useTranslations('assistant.workspace.claimActions'),f=useFormatter(),id=useId();
 const [proposal]=useState(()=>prefill&&choices.kind==='choices'?resolveProposalChoice(choices.claims,claimProposalMatches(prefill)):null);
 const [state,setState]=useState<State>(()=>resumeActionId?{kind:'uncertain',actionId:z.uuid().safeParse(resumeActionId).success?resumeActionId:null}:{kind:'selection'});
 // An inline chat card (review R6) drops its suggestion chrome once the review is confirmed or retired.
 useEffect(()=>{onSettled?.(state.kind==='completed'||state.kind==='retired');},[state.kind,onSettled]);
 const [claimId,setClaimId]=useState(proposal?.kind==='one'?proposal.row.claimId:''),[consent,setConsent]=useState(false),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[index,setIndex]=useState<Row[]|null>(null),[now,setNow]=useState(()=>Date.now());
 const flight=useRef(false),alive=useRef(true),sequence=useRef(0),abort=useRef<AbortController|null>(null),status=useRef<HTMLParagraphElement>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;abort.current?.abort();};},[]);
 const review=state.kind==='review'?state.review:null;
 useEffect(()=>{if(!busy&&state.kind!=='selection')status.current?.focus();},[state,busy]);
 useEffect(()=>{setNow(Date.now());if(!review)return;const timer=setTimeout(()=>setNow(Date.now()),Math.min(2147483647,Math.max(0,Date.parse(review.expiresAt)-Date.now())));return()=>clearTimeout(timer);},[review]);
 const clear=()=>{setClaimId('');setConsent(false);setConfirm(false);};
 async function dispatch(value:unknown){
  if(flight.current)return;const checked=ClaimCancellationModuleActionBrowserPacket.safeParse(structuredClone(value));if(!checked.success){setError(t('cancelUnavailable'));return;}
  const packet=checked.data,op=packet.operation,token=++sequence.current,fallbackId=op==='reopen'?packet.actionId:op==='confirm'||op==='discard'?packet.confirmation.actionId:null;
  flight.current=true;setBusy(op);setError('');setIndex(null);const controller=new AbortController();abort.current=controller;
  try{
   const response=await fetch('/api/assistant/module-actions',{method:'POST',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(packet)});
   const result=await readModuleClaimCancellationResponse(response,packet);if(!alive.current||sequence.current!==token)return;
   if(result.kind==='claim_cancellation_review_index'){setIndex(result.reviews);return;}
   if(result.kind==='choices'||result.kind==='unavailable')return;
   if(result.kind==='completed'&&state.kind==='review'&&result.receipt.receipt.claimId!==state.review.content.claimId)throw fail();
   clear();if(result.kind==='prepared')setState({kind:'review',review:result.review});else if(result.kind==='completed')setState({kind:'completed',receipt:result.receipt});else setState({kind:'retired',receipt:result.receipt});
  }catch{if(alive.current&&sequence.current===token){const prior=state.kind==='review'?state.review.actionId:null;clear();if(op!=='list'||prior)setState({kind:'uncertain',actionId:fallbackId??prior});setError(t('cancelUnavailable'));}}
  finally{if(sequence.current===token){flight.current=false;abort.current=null;if(alive.current)setBusy(null);}}
 }
 function prepare(event:FormEvent){event.preventDefault();if(!consent||choices.kind!=='choices'||flight.current)return;const selected=choices.claims.find(row=>row.claimId===claimId);if(!selected)return;void dispatch({action,operation:'prepare',input:{action,contractVersion:1,employmentId:selected.employmentId,claimId:selected.claimId,cancel:true}});}
 function decide(operation:'confirm'|'discard'){if(!review||operation==='confirm'&&(!confirm||Date.now()>=Date.parse(review.expiresAt)))return;void dispatch(operation==='confirm'?{action,operation,confirmation:{action,contractVersion:1,actionId:review.actionId,reviewedDigest:review.reviewedDigest}}:{action,operation,confirmation:{action,contractVersion:1,actionId:review.actionId}});}
 const expired=review?now>=Date.parse(review.expiresAt):false,stamp=(value:string)=>f.dateTime(new Date(value),{dateStyle:'medium',timeStyle:'short'}),day=(value:string)=>f.dateTime(new Date(value+'T00:00:00'),{dateStyle:'medium'});
 const describe=(row:{claimTypeName:string;incurredOn:string;amount:string})=>t('cancelClaimLabel',{type:row.claimTypeName,date:day(row.incurredOn),amount:row.amount});
 return <section className="min-w-0 space-y-4" aria-label={t('cancelTitle')} aria-busy={busy!==null}>
  <p ref={status} tabIndex={-1} role="status" aria-live="polite" className="text-sm outline-none">{busy?t('working'):state.kind==='review'?t('cancelReviewNote'):state.kind==='completed'?t('cancelDone'):state.kind==='retired'?t('cancelRetired'):state.kind==='uncertain'?t('cancelUncertain'):''}</p>
  {error&&<p role="alert" className="text-sm">{error}</p>}
  {state.kind==='selection'&&(choices.kind==='unavailable'?<p role="alert">{t('cancelUnavailable')}</p>:choices.claims.length===0?<p className="text-sm">{t('cancelNone')}</p>:<form onSubmit={prepare} className="space-y-4">{proposal&&<ProposalResolutionNote kind={proposal.kind}/>}<fieldset disabled={busy!==null} className="space-y-4">
   <div><label htmlFor={`${id}-claim`} className="block text-sm font-medium">{t('cancelChoose')}</label><select id={`${id}-claim`} required value={claimId} className={`${inputCls} mt-1`} onChange={event=>setClaimId(event.target.value)}><option value="">{t('cancelChoosePrompt')}</option>{choices.claims.map(row=><option key={row.claimId} value={row.claimId}>{describe(row)}</option>)}</select></div>
   <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} className="mt-1"/>{t('cancelConsent')}</label>
   <Button type="submit" disabled={!claimId||!consent}>{t('cancelPrepare')}</Button>
  </fieldset>{choices.truncated&&<p className="text-xs">{t('cancelTruncated')}</p>}</form>)}
  {review&&<div className="space-y-4 rounded-lg border border-border p-4"><h3 className="font-semibold">{t('cancelReviewTitle')}</h3><p className="text-sm">{describe(review.review)}</p><p className="text-sm">{t('cancelMeaning')}</p><p className="text-xs text-muted-foreground">{t('expires')}: {stamp(review.expiresAt)}</p>
   {expired?<p role="alert" className="text-sm">{t('expired')}</p>:<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirm} disabled={busy!==null} onChange={event=>setConfirm(event.target.checked)} className="mt-1"/>{t('cancelConfirmConsent')}</label>}
   <div className="flex flex-wrap gap-3"><Button type="button" disabled={busy!==null||!confirm||expired} onClick={()=>decide('confirm')}>{t('cancelConfirm')}</Button><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>decide('discard')}>{t('discard')}</Button></div></div>}
  {state.kind==='uncertain'&&state.actionId&&<Button type="button" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'reopen',actionId:state.actionId})}>{t('reopen')}</Button>}
  {state.kind==='completed'&&<div className="space-y-2 rounded-lg border border-border p-4"><h3 className="font-semibold">{t('cancelDone')}</h3><p className="text-sm">{t('cancelDoneMeaning')}</p><p className="text-sm">{t('currentStatus')}: {t(`nativeStates.${state.receipt.receipt.currentStatus}`)}</p></div>}
  {(state.kind==='completed'||state.kind==='retired')&&<Button type="button" variant="outline" disabled={busy!==null} onClick={()=>{clear();setState({kind:'selection'});setIndex(null);setError('');}}>{t('newSelection')}</Button>}
  <div className="space-y-3 border-t border-border pt-4"><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'list'})}>{t('cancelFindReviews')}</Button><p className="text-xs text-muted-foreground">{t('indexScope')}</p>
   {index&&(index.length===0?<p className="text-sm">{t('noReviews')}</p>:<ul className="space-y-2 text-sm">{index.map(row=><li key={row.actionId} className="flex flex-wrap items-center gap-3"><span>{stamp(row.createdAt)} · {t(`cancelStates.${row.state}`)}</span><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'reopen',actionId:row.actionId})}>{t('reopen')}</Button></li>)}</ul>)}</div>
 </section>;
}
