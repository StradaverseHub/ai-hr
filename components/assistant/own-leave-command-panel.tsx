'use client';

/** Complete browser owner, deliberately UNMOUNTED. Parent must key this component to the actual
 * authenticated login and bind the fixed route only after migration/dependency/security acceptance.
 * Human input only; no executor callback, endpoint prop, model text, persistence or automatic effect. */
import Link from 'next/link';
import {useEffect,useId,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {useFormatter,useTranslations} from 'next-intl';
import {z} from 'zod';
import {Button,Card,inputCls} from '@/components/ui';
import {OwnLeaveReviewIndexResult} from '@/lib/assistant-actions/own-leave-http';
import {OwnLeaveFinalReceipt,OwnLeaveHumanText,OwnLeaveNomination,OwnLeavePreparedReview,type OwnLeaveConfirmation} from '@/lib/assistant-actions/own-leave-contract';

export type OwnLeaveCommandMessages=Readonly<{
 employment:string;leaveType:string;chooseEmployment:string;chooseLeaveType:string;date:string;reason:string;remark:string;
 prepare:string;preparing:string;confirm:string;confirming:string;discard:string;discarding:string;checking:string;reopen:string;
 explanation:string;confirmNote:string;uncertain:string;prepareUncertain:string;submitted:string;submittedNote:string;
 discarded:string;expired:string;refused:string;unavailable:string;invalidSelection:string;needsRemark:string;openRequests:string;
 findReviews:string;findingReviews:string;savedReviews:string;noSavedReviews:string;openSavedReview:string;indexLimitNote:string;
 savedPending:string;savedCompleted:string;savedDiscarded:string;savedExpired:string;savedRefused:string;savedCreated:string;savedExpires:string;
}>;
export type OwnLeaveCommandEmployment=Readonly<{id:string;label:string;leaveTypes:readonly Readonly<{id:string;label:string}>[]}>;
const endpoint='/api/assistant/own-leave';
const Result=z.discriminatedUnion('kind',[
 OwnLeaveReviewIndexResult,
 z.object({kind:z.literal('prepared'),review:OwnLeavePreparedReview}).strict(),
 z.object({kind:z.literal('completed'),receipt:OwnLeaveFinalReceipt.refine(r=>r.state==='completed')}).strict(),
 z.object({kind:z.literal('retired'),receipt:OwnLeaveFinalReceipt.refine(r=>r.state!=='completed')}).strict(),
 ...(['unavailable','needs_selection','needs_employee_remark','use_leave_form'] as const).map(kind=>z.object({kind:z.literal(kind)}).strict()),
]);
type Result=z.infer<typeof Result>;
type State={kind:'draft'}|{kind:'review';review:z.infer<typeof OwnLeavePreparedReview>}|
 {kind:'uncertain';actionId:string|null}|{kind:'completed';receipt:z.infer<typeof OwnLeaveFinalReceipt>}|
 {kind:'retired';receipt:z.infer<typeof OwnLeaveFinalReceipt>};
type Operation='prepare'|'confirm'|'discard'|'reopen'|'list';
const unavailable=()=>Error('Own-leave response unavailable.');

/** Bounded public response only. Malformed/non-success/foreign receipts remain uncertain; never
 * surface server text, infer rollback, or automatically create/retry another action. */
export async function readOwnLeaveCommandResponse(response:Response,expectedActionId?:string):Promise<Result>{
 const refuse=async():Promise<never>=>{await response.body?.cancel().catch(()=>undefined);throw unavailable();};
 if(!response.ok||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!response.body)return refuse();
 const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>32768))return refuse();
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0,reads=0;
 try{
  while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(++reads>256||bytes>32768)throw unavailable();chunks.push(part.value);}
  const joined=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}
  const result=Result.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(joined)));
  const actionId=result.kind==='prepared'?result.review.actionId:result.kind==='completed'||result.kind==='retired'?result.receipt.actionId:null;
  if(expectedActionId&&actionId!==expectedActionId)throw unavailable();return result;
 }catch{await reader.cancel().catch(()=>undefined);throw unavailable();}finally{reader.releaseLock();}
}

export function OwnLeaveCommandPanel({employments,messages:m,resumeActionId}:{
 employments:readonly OwnLeaveCommandEmployment[];messages:OwnLeaveCommandMessages;resumeActionId?:string;
}){
 const t=useTranslations('ownLeaveReview'),f=useFormatter(),id=useId();
 const validResume=z.string().uuid().safeParse(resumeActionId);
 const [state,setState]=useState<State>(()=>resumeActionId?{kind:'uncertain',actionId:validResume.success?validResume.data:null}:{kind:'draft'});
 const [employmentId,setEmploymentId]=useState(''),[leaveTypeId,setLeaveTypeId]=useState(''),[date,setDate]=useState('');
 const [index,setIndex]=useState<z.infer<typeof OwnLeaveReviewIndexResult>['reviews']|null>(null);
 const [now,setNow]=useState(()=>Date.now());
 const [reason,setReason]=useState(''),[remark,setRemark]=useState(''),[busy,setBusy]=useState<Operation|null>(null),[error,setError]=useState('');
 const inFlight=useRef(false),mounted=useRef(true),controller=useRef<AbortController|null>(null);
 const status=useRef<HTMLParagraphElement>(null);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;controller.current?.abort();};},[]);
 useEffect(()=>{if(!busy&&state.kind!=='draft')status.current?.focus();},[state,busy]);
 const employee=employments.find(row=>row.id===employmentId),types=employee?.leaveTypes??[];
 const clearText=()=>{setReason('');setRemark('');setEmploymentId('');setLeaveTypeId('');setDate('');};
 async function dispatch(operation:Operation,packet:unknown,actionId?:string){
  if(inFlight.current)return;inFlight.current=true;setBusy(operation);setError('');if(operation!=='list')setIndex(null);
  const abort=new AbortController();controller.current=abort;const timer=setTimeout(()=>abort.abort(),15000);
  try{
   const response=await fetch(endpoint,{method:'POST',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',signal:abort.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(packet)});
   const result=await readOwnLeaveCommandResponse(response,actionId);if(!mounted.current)return;
   if((operation==='list'&&result.kind!=='review_index')||(operation!=='list'&&result.kind==='review_index'))throw unavailable();
   if(result.kind==='review_index')setIndex(result.reviews);
   else if(result.kind==='prepared'){if(operation!=='prepare'&&operation!=='reopen')throw unavailable();clearText();setState({kind:'review',review:result.review});}
   else if(result.kind==='completed'){if(operation==='prepare')throw unavailable();clearText();setState({kind:'completed',receipt:result.receipt});}
   else if(result.kind==='retired'){if(operation==='prepare')throw unavailable();clearText();setState({kind:'retired',receipt:result.receipt});}
   else if(operation==='prepare'){setState({kind:'draft'});setError(result.kind==='needs_employee_remark'?m.needsRemark:result.kind==='needs_selection'?m.invalidSelection:m.unavailable);}
   else{setState({kind:'uncertain',actionId:actionId??null});setError(m.unavailable);}
  }catch{
   if(mounted.current){if(operation!=='list'){clearText();setState({kind:'uncertain',actionId:actionId??null});}setError(m.unavailable);}
  }finally{clearTimeout(timer);if(mounted.current)setBusy(null);inFlight.current=false;if(controller.current===abort)controller.current=null;}
 }
 function prepare(event:FormEvent){
  event.preventDefault();if(inFlight.current)return;
  const selection={employmentId,leaveTypeId},nomination=OwnLeaveNomination.safeParse({action:'leave.apply',contractVersion:1,...selection,date,durationType:'full_day'});
  const humanText=OwnLeaveHumanText.safeParse({...(reason?{reason}:{}),...(remark?{employeeRemark:remark}:{})});
  if(!employee||!types.some(row=>row.id===leaveTypeId)||!nomination.success||!humanText.success){setError(m.invalidSelection);return;}
  void dispatch('prepare',{operation:'prepare',nomination:nomination.data,selection,humanText:humanText.data});
 }
 function confirmOrDiscard(operation:'confirm'|'discard'){
  if(state.kind!=='review')return;
  const confirmation:OwnLeaveConfirmation={actionId:state.review.actionId,contractVersion:state.review.contractVersion,reviewedDigest:state.review.reviewedDigest};
  void dispatch(operation,{operation,confirmation},confirmation.actionId);
 }
 const label=(operation:Operation)=>operation==='prepare'?m.preparing:operation==='confirm'?m.confirming:operation==='discard'?m.discarding:operation==='list'?m.findingReviews:m.checking;
 const field=(name:string,value:ReactNode)=><div className="min-w-0"><dt className="text-xs text-muted-foreground">{name}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{value}</dd></div>;
 const n=(value:number)=>f.number(value,{maximumFractionDigits:20});
 const review=state.kind==='review'?state.review:null;
 useEffect(()=>{
  setNow(Date.now());if(!review)return;
  const timer=setTimeout(()=>setNow(Date.now()),Math.min(2147483647,Math.max(0,Date.parse(review.expiresAt)-Date.now()+1)));
  return()=>clearTimeout(timer);
 },[review?.actionId,review?.expiresAt]);
 const expired=review?now>=Date.parse(review.expiresAt):false;
 return <section aria-label={t('title')} aria-busy={busy!==null} className="min-w-0 space-y-4">
  <p ref={status} role="status" aria-live="polite" tabIndex={-1} className="text-sm outline-none">{busy?label(busy):state.kind==='completed'?m.submitted:state.kind==='uncertain'?(state.actionId?m.uncertain:m.prepareUncertain):state.kind==='retired'?(state.receipt.state==='discarded'?m.discarded:state.receipt.state==='expired'?m.expired:m.refused):state.kind==='review'?m.confirmNote:m.explanation}</p>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {state.kind==='draft'&&<form onSubmit={prepare} className="space-y-4">
   <fieldset disabled={busy!==null} className="grid min-w-0 gap-4 sm:grid-cols-2">
    <label htmlFor={id+'-employment'} className="text-sm">{m.employment}<select id={id+'-employment'} required value={employmentId} onChange={e=>{setEmploymentId(e.target.value);setLeaveTypeId('');}} className={inputCls+' mt-1 min-h-11'}><option value="">{m.chooseEmployment}</option>{employments.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
    <label htmlFor={id+'-type'} className="text-sm">{m.leaveType}<select id={id+'-type'} required disabled={!employee} value={leaveTypeId} onChange={e=>setLeaveTypeId(e.target.value)} className={inputCls+' mt-1 min-h-11'}><option value="">{m.chooseLeaveType}</option>{types.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
    <label htmlFor={id+'-date'} className="text-sm">{m.date}<input id={id+'-date'} type="date" required value={date} onChange={e=>setDate(e.target.value)} className={inputCls+' mt-1 min-h-11'}/></label>
    <label htmlFor={id+'-reason'} className="text-sm sm:col-span-2">{m.reason}<textarea id={id+'-reason'} value={reason} onChange={e=>setReason(e.target.value)} maxLength={2000} rows={3} autoComplete="off" className={inputCls+' mt-1'}/></label>
    <label htmlFor={id+'-remark'} className="text-sm sm:col-span-2">{m.remark}<textarea id={id+'-remark'} value={remark} onChange={e=>setRemark(e.target.value)} maxLength={2000} rows={3} autoComplete="off" className={inputCls+' mt-1'}/></label>
   </fieldset>
   <Button type="submit" disabled={busy!==null} className="min-h-11">{busy==='prepare'?m.preparing:m.prepare}</Button>
  </form>}
  {state.kind==='draft'&&!busy&&<Link href="/leave?apply=1" className="inline-flex min-h-11 items-center rounded-md border border-input px-3 py-2 text-sm font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('openForm')}</Link>}
  {review&&<Card className="min-w-0 space-y-4 p-5">
   <header><h2 className="text-base font-semibold">{t('title')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('estimateNote')}</p></header>
   <dl className="grid min-w-0 gap-4 sm:grid-cols-2">{field(t('company'),review.companyName)}{review.employeeCode!==null&&field(t('employeeCode'),review.employeeCode)}{field(t('leaveType'),review.leaveTypeName)}{field(t('date'),f.dateTime(new Date(review.date+'T12:00:00Z'),{dateStyle:'full',timeZone:'Asia/Kuala_Lumpur'}))}{field(t('duration'),t('fullDay'))}{field(t('deduction'),n(review.deductionDays))}{review.availableBalance!==null&&field(t('available'),n(review.availableBalance))}{review.estimatedAvailableAfter!==null&&field(t('after'),n(review.estimatedAvailableAfter))}{field(t('approval'),t('approvalUnknown'))}</dl>
   {(review.humanText.reason!==undefined||review.humanText.employeeRemark!==undefined)&&<dl className="space-y-3 border-t border-border pt-4">{review.humanText.reason!==undefined&&field(t('reason'),review.humanText.reason)}{review.humanText.employeeRemark!==undefined&&field(t('remark'),review.humanText.employeeRemark)}</dl>}
   {review.holidayWarnings.map(w=><p key={`${w.country}:${w.state}:${w.year}`} className="rounded-md border border-amber-600/30 px-3 py-2 text-sm">{t('holidayWarning',{place:[w.country,w.state].filter(Boolean).join(' · '),year:w.year,loaded:w.loaded,required:w.required})}</p>)}
   <p className="text-xs text-muted-foreground">{t('expires',{when:f.dateTime(new Date(review.expiresAt),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})})}</p>
   <div className="flex flex-wrap gap-2"><Button type="button" disabled={busy!==null||expired} onClick={()=>confirmOrDiscard('confirm')} className="min-h-11">{busy==='confirm'?m.confirming:m.confirm}</Button><Button type="button" variant="secondary" disabled={busy!==null} onClick={()=>confirmOrDiscard('discard')} className="min-h-11">{busy==='discard'?m.discarding:m.discard}</Button></div>
   {expired&&<p role="alert" className="text-sm">{m.expired}</p>}
   {!busy&&<Link href={`/leave?apply=1&start=${encodeURIComponent(review.date)}`} className="inline-flex min-h-11 items-center rounded-md border border-input px-3 py-2 text-sm font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('openForm')}</Link>}<p className="text-xs text-muted-foreground">{t('formNote')}</p>
  </Card>}
  {state.kind==='uncertain'&&state.actionId&&<Button type="button" variant="secondary" disabled={busy!==null} onClick={()=>void dispatch('reopen',{operation:'reopen',actionId:state.actionId!},state.actionId!)} className="min-h-11">{busy==='reopen'?m.checking:m.reopen}</Button>}
  {state.kind!=='review'&&<Button type="button" variant="secondary" disabled={busy!==null} onClick={()=>void dispatch('list',{operation:'list'})} className="min-h-11">{busy==='list'?m.findingReviews:m.findReviews}</Button>}
  {index!==null&&<section aria-labelledby={id+'-saved'} className="space-y-3 rounded-md border border-border p-4">
   <h2 id={id+'-saved'} className="text-sm font-semibold">{m.savedReviews}</h2>
   <p className="text-xs text-muted-foreground">{m.indexLimitNote}</p>
   {index.length===0?<p role="status" className="text-sm">{m.noSavedReviews}</p>:<ul className="space-y-3">{index.map(row=>{
    const stateLabel=row.state==='awaiting_confirmation'?m.savedPending:row.state==='completed'?m.savedCompleted:row.state==='discarded'?m.savedDiscarded:row.state==='expired'?m.savedExpired:m.savedRefused;
    const restricted=state.kind==='uncertain'&&state.actionId!==null&&state.actionId!==row.actionId;
    return <li key={row.actionId} className="space-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
     <p className="text-sm font-medium">{stateLabel}</p>
     <dl className="grid gap-2 text-xs sm:grid-cols-2">{field(m.savedCreated,f.dateTime(new Date(row.createdAt),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}))}{field(m.savedExpires,f.dateTime(new Date(row.expiresAt),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}))}</dl>
     <Button type="button" variant="secondary" disabled={busy!==null||restricted} onClick={()=>void dispatch('reopen',{operation:'reopen',actionId:row.actionId},row.actionId)} className="min-h-11" aria-label={`${m.openSavedReview}: ${stateLabel}, ${f.dateTime(new Date(row.createdAt),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})}`}>{m.openSavedReview}</Button>
    </li>;
   })}</ul>}
  </section>}
  {state.kind==='completed'&&<p className="text-sm">{m.submittedNote}</p>}
  {!busy&&(state.kind==='completed'||state.kind==='retired'||state.kind==='uncertain')&&<Link href="/leave" className="inline-flex min-h-11 items-center rounded-md border border-input px-3 py-2 text-sm font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{m.openRequests}</Link>}
 </section>;
}
