'use client';
import Link from 'next/link';
import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {useFormatter,useTranslations} from 'next-intl';
import {z} from 'zod';
import {Button,inputCls} from '@/components/ui';
import {EmployeeDraftDiscard as C,EmployeeDraftDiscardBrowserPacket as Packet,parseEmployeeDraftDiscardBrowserResult} from '@/lib/assistant-actions/employee-draft-discard-contract';

type Prepared=z.infer<typeof C.Prepared>;
type Completed=z.infer<typeof C.Completed>;
type Retired=z.infer<typeof C.Retired>;
type Outcome=z.infer<typeof C.ReservedCodeOutcome>;
type State={kind:'selection'}|{kind:'review';review:Prepared}|{kind:'completed';receipt:Completed}|{kind:'retired';receipt:Retired}|{kind:'uncertain';actionId:string|null}|{kind:'handoff';draftId:string|null};
const consent='discard_saved_draft_captured_input' as const;
const REQUEST_DEADLINE_MS=20000;
/** Exact saved-input review. The browser never calculates the reservation outcome or retries a command. */
export function EmployeeDraftDiscardPanel({resumeActionId,initialDraftId}:{resumeActionId?:string;initialDraftId?:string}){
 const t=useTranslations('assistant.workspace.employeeDraftDiscard'),format=useFormatter(),id=useId();
 const [choices,setChoices]=useState<z.infer<typeof C.Choices>|null>(null),[draftId,setDraftId]=useState(initialDraftId&&z.guid().safeParse(initialDraftId).success?initialDraftId:'');
 const [state,setState]=useState<State>(()=>resumeActionId?{kind:'uncertain',actionId:z.guid().safeParse(resumeActionId).success?resumeActionId:null}:{kind:'selection'});
 const [index,setIndex]=useState<z.infer<typeof C.Index>|null>(null),[agreed,setAgreed]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[now,setNow]=useState(()=>Date.now());
 const active=useRef(true),flight=useRef(false),sequence=useRef(0),abort=useRef<(()=>void)|null>(null),status=useRef<HTMLParagraphElement>(null);
 const review=state.kind==='review'?state.review:null;
 const stamp=(value:string)=>format.dateTime(new Date(value),{dateStyle:'medium',timeStyle:'short'});
 const nativeHref=(selectedId?:string|null)=>selectedId?`/admin/personnel/new?draft=${encodeURIComponent(selectedId)}`:'/admin/personnel/new';
 const clearConsent=()=>{setAgreed(false);setConfirmed(false);};
 useEffect(()=>{if(!busy&&state.kind!=='selection')status.current?.focus();},[state,busy]);
 useEffect(()=>{setNow(Date.now());if(!review)return;const timer=setTimeout(()=>setNow(Date.now()),Math.min(2147483647,Math.max(0,Date.parse(review.expiresAt)-Date.now())));return()=>clearTimeout(timer);},[review]);
 async function send(value:unknown){
  if(flight.current)return;
  const checked=Packet.safeParse(value);if(!checked.success){setError(t('unavailable'));return;}
  const packet=checked.data,op=packet.operation,token=++sequence.current;
  const prior=state.kind==='review'?state.review.actionId:state.kind==='uncertain'?state.actionId:null;
  const actionId=op==='reopen'?packet.actionId:op==='confirm'||op==='retire'?packet.confirmation.actionId:prior;
  flight.current=true;setBusy(op);setError('');const controller=new AbortController();
  let reader:ReadableStreamDefaultReader<Uint8Array>|null=null,responseBody:ReadableStream<Uint8Array>|null=null,timer:ReturnType<typeof setTimeout>|null=null,cancelledBody=false;
  let rejectStopped:(reason:Error)=>void=()=>{};
  const stopped=new Promise<never>((_,reject)=>{rejectStopped=reject;});
  // A settled race still observes late rejection; cancellation must never wait on the transport.
  void stopped.catch(()=>{});
  const cancelBody=()=>{if(cancelledBody||!reader&&!responseBody)return;cancelledBody=true;try{const cancelling=reader?reader.cancel():responseBody?.cancel();void cancelling?.catch(()=>{});}catch{/* already closed */}};
  const stop=()=>{if(timer!==null){clearTimeout(timer);timer=null;}rejectStopped(Error('Request stopped'));controller.abort();cancelBody();};
  const deadlineAt=Date.now()+REQUEST_DEADLINE_MS;
  timer=setTimeout(stop,REQUEST_DEADLINE_MS);abort.current=stop;
  try{
   const pending=fetch('/api/assistant/module-actions',{method:'POST',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(packet)}).then(response=>{
    if(controller.signal.aborted){try{void response.body?.cancel().catch(()=>{});}catch{/* already closed */}throw Error('Request stopped');}
    return response;
   });
   const response=await Promise.race([pending,stopped]);responseBody=response.body;
   if(!response.ok||response.headers.get('content-type')?.split(';')[0]!=='application/json'||!response.body)throw Error();
   reader=response.body.getReader();const parts:Uint8Array[]=[];let bytes=0,finishedBody=false;
   try{for(;;){const part=await Promise.race([reader.read(),stopped]);if(part.done){finishedBody=true;break;}bytes+=part.value.byteLength;if(bytes>65536||parts.length>=1024){cancelBody();throw Error();}parts.push(part.value);}}finally{if(!finishedBody)cancelBody();try{reader.releaseLock();}catch{/* a stopped read may still be pending */}reader=null;}
   const all=new Uint8Array(bytes);let offset=0;for(const part of parts){all.set(part,offset);offset+=part.byteLength;}
   const next=parseEmployeeDraftDiscardBrowserResult(packet,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all)));
   // Synchronous decode/validation also belongs to the same deadline if the event loop was delayed.
   if(controller.signal.aborted||Date.now()>=deadlineAt){stop();throw Error('Request stopped');}
   if(!active.current||sequence.current!==token)return;
   if(next.kind==='choices'||next.kind==='unavailable'){setChoices(next);setAgreed(false);return;}
   if(next.kind==='employee_draft_discard_review_index'){setIndex(next);return;}
   clearConsent();setNow(Date.now());
   if(next.kind==='prepared'){setState({kind:'review',review:next.review});return;}
   if(next.kind==='completed'){setState({kind:'completed',receipt:next.receipt});return;}
   if(next.kind==='retired'){setState({kind:'retired',receipt:next.receipt});return;}
   if(next.kind==='handoff'){setState({kind:'handoff',draftId:op==='prepare'?packet.input.draftId:review?.content.draftId??null});return;}
   throw Error();
  }catch{if(active.current&&sequence.current===token){setError(t('unavailable'));if(op==='choices'){setChoices({kind:'unavailable'});return;}clearConsent();if(op!=='list')setState({kind:'uncertain',actionId});}}
  finally{if(timer!==null)clearTimeout(timer);controller.abort();cancelBody();if(sequence.current===token){flight.current=false;abort.current=null;if(active.current)setBusy(null);}}
 }
 useEffect(()=>{active.current=true;flight.current=false;if(state.kind==='selection')void send({action:C.action,operation:'choices',selection:{}});return()=>{active.current=false;sequence.current++;abort.current?.();};
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 const drafts=choices?.kind==='choices'?choices.drafts:[],selected=drafts.find(row=>row.draftId===draftId),expired=review?now>=Date.parse(review.expiresAt):false;
 function prepare(event:FormEvent){event.preventDefault();if(!selected?.supported||!selected.companyId||!agreed||busy||flight.current)return;void send({action:C.action,operation:'prepare',input:{action:C.action,contractVersion:1,draftId:selected.draftId,companyId:selected.companyId,consent}});}
 function confirm(){if(!review||!confirmed||busy||flight.current)return;if(Date.now()>=Date.parse(review.expiresAt)){setNow(Date.now());setConfirmed(false);return;}void send({action:C.action,operation:'confirm',confirmation:{action:C.action,contractVersion:1,actionId:review.actionId,reviewedDigest:review.reviewedDigest,draftId:review.content.draftId,companyId:review.content.companyId,consent}});}
 function reset(){if(busy||flight.current)return;clearConsent();setIndex(null);setDraftId('');setError('');setState({kind:'selection'});void send({action:C.action,operation:'choices',selection:{}});}
 function outcome(value:Outcome,completed=false){const code=value.kind==='no_reservation'?'':value.reservedEmployeeCode;return t(`${completed?'completedOutcomes':'outcomes'}.${value.kind}`,{code});}
 const statusText=busy?t('working'):state.kind==='review'?t('reviewTitle'):state.kind==='completed'?t('done'):state.kind==='retired'?t('states.'+state.receipt.state):state.kind==='uncertain'?t(state.actionId?'uncertain':'uncertainUnknown'):state.kind==='handoff'?t('handoff'):'';
 return <section aria-label={t('title')} aria-busy={busy!==null} className="min-w-0 space-y-4">
  <p ref={status} role="status" aria-live="polite" tabIndex={-1} className="text-sm outline-none">{statusText}</p>
  {error&&<p role="alert" className="text-sm">{error}</p>}
  {state.kind==='selection'&&<form onSubmit={prepare} className="space-y-4">
   <p className="text-sm text-muted-foreground">{t('intro')}</p>
   {choices?.kind==='unavailable'?<p className="text-sm">{t('choicesUnavailable')}</p>:<>
    <label htmlFor={id+'-draft'} className="block text-sm font-medium">{t('draft')}</label>
    <select id={id+'-draft'} className={inputCls} disabled={busy!==null} value={draftId} onChange={event=>{setDraftId(event.target.value);clearConsent();}}>
     <option value="">{t('choose')}</option>{drafts.map(row=><option key={row.draftId} value={row.draftId}>{row.label||t('unnamed')} · {row.companyName||t('unassigned')}{row.employeeCode?' · '+row.employeeCode:''}</option>)}
    </select>
    {choices?.kind==='choices'&&drafts.length===0&&<p className="text-sm">{t('empty')}</p>}
    {choices?.kind==='choices'&&choices.truncated&&<p className="text-xs text-muted-foreground">{t('truncated')}</p>}
    {selected&&!selected.supported&&<p role="note" className="text-sm">{t(selected.unsupportedReason==='linked_onboarding_case'?'onboardingHandoff':'handoff')} <Link href={nativeHref(selected.draftId)} className="underline">{t('native')}</Link></p>}
    {selected?.supported&&<><label className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={agreed} disabled={busy!==null} onChange={event=>setAgreed(event.target.checked)}/>{t('prepareConsent')}</label><Button type="submit" disabled={busy!==null||!agreed}>{t('prepare')}</Button></>}
   </>}
  </form>}
  {review&&<div className="min-w-0 space-y-4 rounded-lg border border-border p-4">
   <h3 className="font-semibold">{t('reviewTitle')}</h3>
   <dl className="space-y-3 text-sm"><div><dt className="font-medium">{t('draft')}</dt><dd className="break-words">{review.review.draftLabel||t('unnamed')}</dd></div><div><dt className="font-medium">{t('company')}</dt><dd className="break-words">{review.review.companyName}</dd></div><div><dt className="font-medium">{t('reservation')}</dt><dd className="break-words">{outcome(review.review.reservedCodeOutcome)}</dd></div></dl>
   <p className="rounded-md border border-border bg-muted/40 p-3 text-sm font-medium">{t('consequence')}</p>
   <p className="text-xs text-muted-foreground">{t('expires')}: {stamp(review.expiresAt)}</p>
   {expired?<p role="alert" className="text-sm">{t('expired')}</p>:<label className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={busy!==null} onChange={event=>setConfirmed(event.target.checked)}/>{t('confirmConsent')}</label>}
   <div className="flex flex-wrap gap-3"><Button type="button" disabled={busy!==null||!confirmed||expired} onClick={confirm}>{t('confirm')}</Button><Button variant="outline" type="button" disabled={busy!==null} onClick={()=>void send({action:C.action,operation:'retire',confirmation:{action:C.action,contractVersion:1,actionId:review.actionId}})}>{t('retire')}</Button></div>
   <p className="text-xs text-muted-foreground">{t('retireNote')}</p>
  </div>}
  {state.kind==='uncertain'&&<div className="space-y-3">{state.actionId&&<Button variant="outline" type="button" disabled={busy!==null} onClick={()=>void send({action:C.action,operation:'reopen',actionId:state.actionId})}>{t('reopen')}</Button>}</div>}
  {state.kind==='completed'&&<div className="space-y-3"><h3 className="font-semibold">{t('done')}</h3><p className="text-sm">{t('doneNote')}</p><p className="text-sm">{outcome(state.receipt.receipt.reservedCodeOutcome,true)}</p></div>}
  {state.kind==='handoff'&&<p className="text-sm"><Link href={nativeHref(state.draftId)} className="inline-flex min-h-11 items-center underline">{t('native')}</Link></p>}
  {(state.kind==='completed'||state.kind==='retired'||state.kind==='handoff')&&<Button variant="outline" type="button" disabled={busy!==null} onClick={reset}>{t('another')}</Button>}
  <Link href={nativeHref(review?.content.draftId)} className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('native')}</Link>
  <div className="space-y-3 border-t border-border pt-4"><Button variant="outline" type="button" disabled={busy!==null} onClick={()=>void send({action:C.action,operation:'list'})}>{t('find')}</Button>
   {index&&<>{index.reviews.length===0&&<p className="text-sm">{t('noReviews')}</p>}<ul className="space-y-3 text-sm">{index.reviews.map(row=><li key={row.actionId} className="flex flex-wrap items-center gap-3"><span>{stamp(row.createdAt)} · {t('states.'+row.state)}</span><Button variant="outline" type="button" disabled={busy!==null} onClick={()=>void send({action:C.action,operation:'reopen',actionId:row.actionId})}>{t('reopen')}</Button></li>)}</ul></>}
  </div>
 </section>;
}
