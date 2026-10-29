'use client';
/** ADR-0151 wave 1b: an assigned approver approves or rejects one pending claim, attendance request or
 * replacement-leave (TOIL) request from their own inbox. Only an item from the server's choices list can
 * be chosen; the review card shows the server's stored facts, never local state. A lost confirmation is
 * never retried: the approver reopens the same saved review. */
import Link from 'next/link';
import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {useFormatter,useTranslations} from 'next-intl';
import {z} from 'zod';
import {Button,inputCls} from '@/components/ui';
import {formatMinutesToHM} from '@/lib/overtime-duration';
import {ASSIGNED_CLAIM_DECISION_ACTION,ASSIGNED_ATTENDANCE_DECISION_ACTION,ASSIGNED_DECISION_CONTRACTS,type AssignedDecisionAction,type AssignedDecision,AssignedClaimItem,AssignedAttendanceItem,AssignedToilItem} from '@/lib/assistant-actions/assigned-decision-contract';
import {checkGenericPacket,packetActionId,sendGenericModuleAction} from './generic-module-action-transport';
import {resolveProposalChoice,type ProposalResolutionKind} from '@/lib/ai/assistant-action-proposal-hints';
import {ProposalResolutionNote} from './proposal-resolution-note';
import {useReviewedDecisionBatch} from './reviewed-decision-batch-context';
type ClaimItem=z.infer<typeof AssignedClaimItem>;type AttendanceItem=z.infer<typeof AssignedAttendanceItem>;type ToilItem=z.infer<typeof AssignedToilItem>;type Item=ClaimItem|AttendanceItem|ToilItem;
type Kind='claim'|'attendance'|'toil';
type Review={actionId:string;reviewedDigest:string;createdAt:string;expiresAt:string;content:{employmentId:string;subjectId:string;decision:AssignedDecision;note?:string};review:Item};
type Receipt={actionId:string;state:'completed';receipt:{subjectId:string;employmentId:string;decision:AssignedDecision;recorded:'final'|'level';currentStatus:'pending'|'approved'|'rejected'|'cancelled'|'paid'}};
type Retired={actionId:string;state:'discarded'|'expired'|'refused'};type Row={actionId:string;state:string;createdAt:string};
type Choices={kind:'choices';items:Item[];truncated:boolean}|{kind:'unavailable'}|{kind:'loading'};
/** The three contracts differ only in their item schema; the panel reads them through one shape and narrows by kind. */
type Contract={Choices:z.ZodType;Index:z.ZodType;Prepared:z.ZodType;Completed:z.ZodType;Retired:z.ZodType};
type State={kind:'selection'}|{kind:'review';review:Review}|{kind:'completed';receipt:Receipt}|{kind:'retired';receipt:Retired}|{kind:'uncertain';actionId:string|null};
const NOTE_LIMIT=1000;
const fail=()=>Error('Assigned decision unavailable.');
export const assignedDecisionKind=(action:AssignedDecisionAction):Kind=>action===ASSIGNED_CLAIM_DECISION_ACTION?'claim':action===ASSIGNED_ATTENDANCE_DECISION_ACTION?'attendance':'toil';
/** ADR-0151 §4.3 inline card: a chat proposal carries no hints for a decision. The item is preselected only
 * when the approver's own fresh inbox holds exactly one; the decision and note always stay the approver's. */
export type AssignedDecisionProposalPrefill=Readonly<Record<never,never>>;
export function AssignedDecisionPanel({action,resumeActionId,prefill}:{action:AssignedDecisionAction;resumeActionId?:string;prefill?:AssignedDecisionProposalPrefill}){
 const t=useTranslations('assistant.workspace.decisionActions'),f=useFormatter(),id=useId(),kind=assignedDecisionKind(action),contract=ASSIGNED_DECISION_CONTRACTS[action] as unknown as Contract;
 const [choices,setChoices]=useState<Choices>({kind:'loading'});
 const [state,setState]=useState<State>(()=>resumeActionId?{kind:'uncertain',actionId:z.uuid().safeParse(resumeActionId).success?resumeActionId:null}:{kind:'selection'});
 const [subjectId,setSubjectId]=useState(''),[decision,setDecision]=useState<AssignedDecision|''>(''),[note,setNote]=useState('');
 const [consent,setConsent]=useState(false),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[index,setIndex]=useState<Row[]|null>(null),[now,setNow]=useState(()=>Date.now());
 const flight=useRef(false),alive=useRef(true),sequence=useRef(0),abort=useRef<AbortController|null>(null),status=useRef<HTMLParagraphElement>(null);
 const prefilled=useRef(false),[resolution,setResolution]=useState<ProposalResolutionKind|null>(null);
 const review=state.kind==='review'?state.review:null;
 useEffect(()=>{if(!busy&&state.kind!=='selection')status.current?.focus();},[state,busy]);
 useEffect(()=>{setNow(Date.now());if(!review)return;const timer=setTimeout(()=>setNow(Date.now()),Math.min(2147483647,Math.max(0,Date.parse(review.expiresAt)-Date.now())));return()=>clearTimeout(timer);},[review]);
 const batch=useReviewedDecisionBatch(review,confirm&&now<Date.parse(review?.expiresAt??''),async()=>{if(!review||Date.now()>=Date.parse(review.expiresAt))return;await dispatch({action,operation:'confirm',confirmation:{action,contractVersion:1,actionId:review.actionId,reviewedDigest:review.reviewedDigest}});});
 const clear=()=>{setSubjectId('');setDecision('');setNote('');setConsent(false);setConfirm(false);};
 async function dispatch(value:unknown){
  if(flight.current)return;const packet=checkGenericPacket(value);if(!packet||packet.action!==action){setError(t('unavailable'));return;}
  const op=packet.operation,token=++sequence.current,fallbackId=packetActionId(packet);
  flight.current=true;setBusy(op);setError('');setIndex(null);const controller=new AbortController();abort.current=controller;const timer=setTimeout(()=>controller.abort(),15000);
  try{
   const result=await sendGenericModuleAction(packet,controller.signal);if(!alive.current||sequence.current!==token)return;
   if(op==='choices'){const loaded=contract.Choices.parse(result) as Choices;setChoices(loaded);
    // A chat proposal is applied once, to the first fresh choices: never to a later reload.
    if(prefill&&!prefilled.current&&loaded.kind==='choices'){prefilled.current=true;const found=resolveProposalChoice(loaded.items,()=>true);setResolution(found.kind);if(found.kind==='one')setSubjectId(found.row.subjectId);}
    return;}
   if(op==='list'){setIndex((contract.Index.parse(result) as {reviews:Row[]}).reviews);return;}
   if(result.kind==='prepared'){const prepared=contract.Prepared.parse((result as {review:unknown}).review) as Review;clear();setState({kind:'review',review:prepared});return;}
   if(result.kind==='completed'){const receipt=contract.Completed.parse((result as {receipt:unknown}).receipt) as Receipt;if(state.kind==='review'&&(receipt.receipt.subjectId!==state.review.content.subjectId||receipt.receipt.employmentId!==state.review.content.employmentId||receipt.receipt.decision!==state.review.content.decision))throw fail();clear();setState({kind:'completed',receipt});return;}
   if(result.kind==='retired'){const receipt=contract.Retired.parse((result as {receipt:unknown}).receipt) as Retired;clear();setState({kind:'retired',receipt});return;}
   throw fail();
  }catch{if(alive.current&&sequence.current===token){
   if(op==='choices'){setChoices({kind:'unavailable'});setError(t('choicesUnavailable'));return;}
   const prior=state.kind==='review'?state.review.actionId:null;clear();if(op!=='list'||prior)setState({kind:'uncertain',actionId:fallbackId??prior});setError(t('unavailable'));}}
  finally{clearTimeout(timer);if(sequence.current===token){flight.current=false;abort.current=null;if(alive.current)setBusy(null);}}
 }
 // Choices come from the same guarded POST; a remount (or a strict-mode re-run) starts a fresh load.
 useEffect(()=>{alive.current=true;flight.current=false;if(!batch)void dispatch({action,operation:'choices'});return()=>{alive.current=false;sequence.current++;abort.current?.abort();};
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 const items=choices.kind==='choices'?choices.items:[],selected=items.find(row=>row.subjectId===subjectId);
 // A claim/attendance rejection carries the approver's own explanation; approval notes stay native.
 const noteAllowed=kind!=='claim'||decision==='rejected',noteRequired=(kind==='attendance'||kind==='claim')&&decision==='rejected',noteMissing=noteRequired&&note.trim().length===0,noteTooLong=note.length>NOTE_LIMIT;
 const ready=!!selected&&!!decision&&consent&&!noteMissing&&!(noteAllowed&&noteTooLong);
 function prepare(event:FormEvent){event.preventDefault();if(!ready||!selected||!decision||flight.current)return;
  const input:Record<string,unknown>={action,contractVersion:1,employmentId:selected.employmentId,subjectId:selected.subjectId,decision};if(noteAllowed&&note.trim())input.note=note;
  void dispatch({action,operation:'prepare',input});
 }
 function decide(operation:'confirm'|'discard'){if(!review||operation==='confirm'&&(!confirm||Date.now()>=Date.parse(review.expiresAt)))return;
  void dispatch(operation==='confirm'?{action,operation,confirmation:{action,contractVersion:1,actionId:review.actionId,reviewedDigest:review.reviewedDigest}}:{action,operation,confirmation:{action,contractVersion:1,actionId:review.actionId}});}
 const expired=review?now>=Date.parse(review.expiresAt):false,stamp=(value:string)=>f.dateTime(new Date(value),{dateStyle:'medium',timeStyle:'short'}),day=(value:string)=>f.dateTime(new Date(value+'T00:00:00'),{dateStyle:'medium'});
 const person=(row:Item)=>row.employeeCode?t('employeeValue',{name:row.employeeName,code:row.employeeCode}):row.employeeName;
 // Amounts are shown exactly as the stored string; nothing is recalculated or reformatted.
 const describe=(row:Item)=>kind==='claim'?t('claimLabel',{name:row.employeeName,type:(row as ClaimItem).claimTypeName,date:day((row as ClaimItem).incurredOn),amount:(row as ClaimItem).amount})
  :kind==='attendance'?t('attendanceLabel',{name:row.employeeName,date:day((row as AttendanceItem).date),type:t((row as AttendanceItem).overtime?'overtimeKind':'correctionKind')})
  :t('toilLabel',{name:row.employeeName,date:day((row as ToilItem).submittedOn),days:f.number((row as ToilItem).totalDays)});
 const fact=(label:string,value:string)=><div><dt className="font-medium">{t(label)}</dt><dd className="whitespace-pre-wrap break-words">{value}</dd></div>;
 const facts=(row:Item)=>{const none=t('notProvided');
  if(kind==='claim'){const c=row as ClaimItem;return <>{fact('employee',person(c))}{fact('claimType',c.claimTypeName)}{fact('claimItem',c.itemName??none)}{fact('incurredOn',day(c.incurredOn))}{fact('amount',c.amount)}{fact('claimDescription',c.description??none)}</>;}
  if(kind==='attendance'){const a=row as AttendanceItem,span=(s:string|null,e:string|null)=>s&&e?t('windowValue',{start:s,end:e}):s??e??none;
   return <>{fact('employee',person(a))}{fact('date',day(a.date))}{fact('requestType',t(a.overtime?'overtimeKind':'correctionKind'))}
    {(a.proposedCheckIn!==null||a.proposedCheckOut!==null)&&<>{fact('proposedIn',a.proposedCheckIn??none)}{fact('proposedOut',a.proposedCheckOut??none)}</>}
    {(a.plannedStartTime!==null||a.plannedEndTime!==null)&&fact('plannedWindow',span(a.plannedStartTime,a.plannedEndTime))}
    {a.requestedOtMinutes!==null&&fact('otMinutes',formatMinutesToHM(a.requestedOtMinutes))}{fact('reason',a.reason??none)}</>;}
  const o=row as ToilItem;return <>{fact('employee',person(o))}{fact('submittedOn',day(o.submittedOn))}{fact('totalDays',f.number(o.totalDays))}{fact('totalHours',f.number(o.totalHours))}{fact('lines',f.number(o.lines))}{fact('reason',o.reason??none)}</>;};
 const statusText=busy?(busy==='choices'?t('loading'):t('working')):state.kind==='review'?t('reviewNote'):state.kind==='completed'?t('done'):state.kind==='retired'?t('retired'):state.kind==='uncertain'?t(state.actionId?'uncertain':'uncertainUnknown'):'';
 return <fieldset disabled={batch?.busy} className="min-w-0 space-y-4 border-0 p-0" aria-label={t(`${kind}.title`)} aria-busy={busy!==null}>
  <p ref={status} tabIndex={-1} role="status" aria-live="polite" className="text-sm outline-none">{statusText}</p>
  {error&&<p role="alert" className="text-sm">{error}</p>}
  {!batch&&state.kind==='selection'&&choices.kind!=='loading'&&(choices.kind==='unavailable'?<div className="space-y-2"><p className="text-sm">{t('choicesUnavailable')}</p><Link href="/approvals" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('manual')}</Link></div>
   :items.length===0?<div className="space-y-2"><p className="text-sm">{t(`${kind}.none`)}</p>{choices.truncated&&<p className="text-xs">{t('truncated')}</p>}</div>
   :<form onSubmit={prepare} className="space-y-4">{resolution&&<ProposalResolutionNote kind={resolution}/>}<p className="text-sm text-muted-foreground">{t('intro')}</p><fieldset disabled={busy!==null} className="space-y-4">
   <div><label htmlFor={`${id}-item`} className="block text-sm font-medium">{t(`${kind}.item`)}</label><select id={`${id}-item`} required value={subjectId} className={`${inputCls} mt-1`} onChange={event=>{setSubjectId(event.target.value);setConsent(false);}}><option value="">{t('choose')}</option>{items.map(row=><option key={row.subjectId} value={row.subjectId}>{describe(row)}</option>)}</select></div>
   <fieldset className="space-y-2"><legend className="text-sm font-medium">{t('decision')}</legend>
    <label className="flex items-center gap-2 text-sm"><input type="radio" name={`${id}-decision`} checked={decision==='approved'} onChange={()=>{setDecision('approved');setConsent(false);}}/>{t('approve')}</label>
    <label className="flex items-center gap-2 text-sm"><input type="radio" name={`${id}-decision`} checked={decision==='rejected'} onChange={()=>{setDecision('rejected');setConsent(false);}}/>{t('reject')}</label>
   </fieldset>
   {noteAllowed?<div><label htmlFor={`${id}-note`} className="block text-sm font-medium">{t(noteRequired?'rejectNote':'note')}</label><textarea id={`${id}-note`} required={noteRequired} maxLength={NOTE_LIMIT} value={note} aria-describedby={`${id}-note-help`} aria-invalid={noteMissing||noteTooLong||undefined} className={`${inputCls} mt-1`} onChange={event=>setNote(event.target.value)}/>
    <p id={`${id}-note-help`} className="text-xs text-muted-foreground">{noteMissing?t('rejectNoteRequired'):t('noteHelp')}</p></div>
   :<p className="text-xs text-muted-foreground">{t('claimNoNote')}</p>}
   <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} className="mt-1"/>{t('consent')}</label>
   <Button type="submit" disabled={!ready}>{t('prepare')}</Button>
  </fieldset>{choices.truncated&&<p className="text-xs">{t('truncated')}</p>}</form>)}
  {review&&<div className="space-y-4 rounded-lg border border-border p-4"><h3 className="font-semibold">{t('reviewTitle')}</h3>
   <dl className="space-y-1 text-sm">{facts(review.review)}</dl>
   <dl className="space-y-1 text-sm"><div><dt className="font-medium">{t('yourDecision')}</dt><dd>{t(`decisions.${review.content.decision}`)}</dd></div>{(kind!=='claim'||review.content.decision==='rejected')&&<div><dt className="font-medium">{t('yourNote')}</dt><dd className="whitespace-pre-wrap break-words">{review.content.note??t('notProvided')}</dd></div>}</dl>
   <p className="text-sm font-medium">{t(`${kind}.consequence`)}</p><p className="text-xs text-muted-foreground">{t('expires')}: {stamp(review.expiresAt)}</p>
   {expired?<p role="alert" className="text-sm">{t('expired')}</p>:<label className={batch?'flex min-h-11 items-start gap-2 text-sm':'flex items-start gap-2 text-sm'}><input type="checkbox" checked={confirm} disabled={busy!==null} onChange={event=>setConfirm(event.target.checked)} className="mt-1"/>{t('confirmConsent')}</label>}
   <div className="flex flex-wrap gap-3">{!batch&&<Button className={batch?'min-h-11 h-auto max-w-full whitespace-normal break-words':undefined} type="button" disabled={busy!==null||!confirm||expired} onClick={()=>decide('confirm')}>{t('confirm')}</Button>}<Button className={batch?'min-h-11 h-auto max-w-full whitespace-normal break-words':undefined} type="button" variant="outline" disabled={busy!==null} onClick={()=>decide('discard')}>{t('discard')}</Button></div></div>}
  {state.kind==='uncertain'&&state.actionId&&<Button className={batch?'min-h-11 h-auto max-w-full whitespace-normal break-words':undefined} type="button" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'reopen',actionId:state.actionId})}>{t('reopen')}</Button>}
  {state.kind==='completed'&&<div className="space-y-2 rounded-lg border border-border p-4"><h3 className="font-semibold">{t('done')}</h3>
   <p className="text-sm">{t(state.receipt.receipt.recorded==='level'?'doneLevel':'doneFinal')}</p>
   <dl className="space-y-1 text-sm"><div><dt className="font-medium">{t('recordedDecision')}</dt><dd>{t(`decisions.${state.receipt.receipt.decision}`)}</dd></div><div><dt className="font-medium">{t('currentStatus')}</dt><dd>{t(`statuses.${state.receipt.receipt.currentStatus}`)}</dd></div></dl></div>}
  {state.kind==='retired'&&<p className="text-sm">{t('retiredState')}: {t(`states.${state.receipt.state}`)}</p>}
  {!batch&&(state.kind==='completed'||state.kind==='retired'||state.kind==='uncertain'&&!state.actionId)&&<Button className={batch?'min-h-11 h-auto max-w-full whitespace-normal break-words':undefined} type="button" variant="outline" disabled={busy!==null} onClick={()=>{clear();setState({kind:'selection'});setIndex(null);setError('');void dispatch({action,operation:'choices'});}}>{t('another')}</Button>}
  {!batch&&<div className="space-y-3 border-t border-border pt-4"><Button className={batch?'min-h-11 h-auto max-w-full whitespace-normal break-words':undefined} type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'list'})}>{t('find')}</Button><p className="text-xs text-muted-foreground">{t('indexScope')}</p>
   {index&&(index.length===0?<p className="text-sm">{t('noReviews')}</p>:<ul className="space-y-2 text-sm">{index.map(row=><li key={row.actionId} className="flex flex-wrap items-center gap-3"><span>{stamp(row.createdAt)} · {t(`states.${row.state}`)}</span><Button className={batch?'min-h-11 h-auto max-w-full whitespace-normal break-words':undefined} type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'reopen',actionId:row.actionId})}>{t('reopen')}</Button></li>)}</ul>)}</div>}
 </fieldset>;
}
