'use client';
/** Human-only qualification register maintenance. The server owns every displayed review fact and
 * re-checks authority; a lost command is recovered by reopening the same review, never by replaying it. */
import Link from 'next/link';
import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {useFormatter,useTranslations} from 'next-intl';
import {z} from 'zod';
import {Button,inputCls} from '@/components/ui';
import {QualificationMaintenance as contract,QUALIFICATION_MAINTENANCE_ACTION as action} from '@/lib/assistant-actions/qualification-maintenance-contract';
import {checkGenericPacket,packetActionId,sendGenericModuleAction} from './generic-module-action-transport';
type Operation='add'|'update'|'archive';
type Fields={qualification:string;description:string|null;fromYm:string|null;toYm:string|null;institute:string|null;major:string|null;graduationDate:string|null;result:string|null;isHighest:boolean};
type Subject={employmentId:string;employeeName:string;employeeCode:string|null;companyName:string};
type Choices={kind:'choices';employees:Subject[];truncated:boolean;qualifications:{id:string;fields:Fields;revision:string}[];options:{value:string;label:string}[]}|{kind:'idle'|'unavailable'};
type Item=Subject&{subjectId:string;operation:Operation;qualificationId:string|null;before:Fields|null;after:Fields|null;clearsHighestId:string|null;clearsHighest:{id:string;fields:Fields}|null};
type Review={actionId:string;reviewedDigest:string;createdAt:string;expiresAt:string;content:{employmentId:string;subjectId:string};review:Item};
type Receipt={actionId:string;state:'completed';receipt:{subjectId:string;employmentId:string;qualificationId:string;eventId:string;operation:Operation}};
type Retired={actionId:string;state:'discarded'|'expired'|'refused'};
type IndexRow={actionId:string;state:string;createdAt:string};
type State={kind:'selection'}|{kind:'review';review:Review}|{kind:'completed';receipt:Receipt}|{kind:'retired';receipt:Retired}|{kind:'uncertain';actionId:string|null};
const empty=():Fields=>({qualification:'',description:null,fromYm:null,toYm:null,institute:null,major:null,graduationDate:null,result:null,isHighest:false});
const keys=['qualification','institute','major','fromYm','toYm','graduationDate','result','description','isHighest'] as const;
export function QualificationMaintenancePanel({resumeActionId,initialEmploymentId}:{resumeActionId?:string;initialEmploymentId?:string}){
 const t=useTranslations('assistant.workspace.qualificationMaintenance'),format=useFormatter(),id=useId();
 const [choices,setChoices]=useState<Choices>({kind:'idle'}),[query,setQuery]=useState('');
 const [employmentId,setEmploymentId]=useState(initialEmploymentId&&z.uuid().safeParse(initialEmploymentId).success?initialEmploymentId:'');
 const [operation,setOperation]=useState<Operation>('add'),[qualificationId,setQualificationId]=useState(''),[fields,setFields]=useState<Fields>(empty);
 const [state,setState]=useState<State>(()=>resumeActionId?{kind:'uncertain',actionId:z.uuid().safeParse(resumeActionId).success?resumeActionId:null}:{kind:'selection'});
 const [consent,setConsent]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[index,setIndex]=useState<IndexRow[]|null>(null),[now,setNow]=useState(()=>Date.now());
 const alive=useRef(true),flight=useRef(false),sequence=useRef(0),abort=useRef<AbortController|null>(null),status=useRef<HTMLParagraphElement>(null);
 const review=state.kind==='review'?state.review:null;
 const clear=()=>{setFields(empty());setQualificationId('');setConsent(false);setConfirmed(false);};
 useEffect(()=>{if(!busy&&state.kind!=='selection')status.current?.focus();},[state,busy]);
 useEffect(()=>{setNow(Date.now());if(!review)return;const timer=setTimeout(()=>setNow(Date.now()),Math.min(2147483647,Math.max(0,Date.parse(review.expiresAt)-Date.now())));return()=>clearTimeout(timer);},[review]);
 async function dispatch(value:unknown){
  if(flight.current)return;
  const packet=checkGenericPacket(value);if(!packet||packet.action!==action){setError(t('unavailable'));return;}
  const op=packet.operation,token=++sequence.current,fallbackId=packetActionId(packet),prior=state.kind==='review'?state.review.actionId:null;
  flight.current=true;setBusy(op);setError('');setIndex(null);const controller=new AbortController();abort.current=controller;
  try{
   const result=await sendGenericModuleAction(packet,controller.signal);if(!alive.current||sequence.current!==token)return;
   if(op==='choices'){setChoices(contract.Choices.parse(result) as Choices);return;}
   if(op==='list'){setIndex((contract.Index.parse(result) as {reviews:IndexRow[]}).reviews);return;}
   if(result.kind==='prepared'){const saved=contract.Prepared.parse((result as {review:unknown}).review) as Review;clear();setState({kind:'review',review:saved});return;}
   if(result.kind==='completed'){const receipt=contract.Completed.parse((result as {receipt:unknown}).receipt) as Receipt;if(review&&receipt.receipt.subjectId!==review.content.subjectId)throw Error();clear();setState({kind:'completed',receipt});return;}
   if(result.kind==='retired'){const receipt=contract.Retired.parse((result as {receipt:unknown}).receipt) as Retired;clear();setState({kind:'retired',receipt});return;}
   throw Error();
  }catch{if(alive.current&&sequence.current===token){if(op==='choices'){setChoices({kind:'unavailable'});setError(t('choicesUnavailable'));return;}
   clear();if(op!=='list'||prior)setState({kind:'uncertain',actionId:fallbackId??prior});setError(t('unavailable'));}}
  finally{if(sequence.current===token){flight.current=false;abort.current=null;if(alive.current)setBusy(null);}}
 }
 const load=(selected=employmentId,text=query)=>void dispatch({action,operation:'choices',selection:{query:text,...(selected?{employmentId:selected}:{})}});
 useEffect(()=>{alive.current=true;flight.current=false;if(state.kind==='selection')load();return()=>{alive.current=false;sequence.current++;abort.current?.abort();};
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 const listed=choices.kind==='choices'?choices.employees:[],selected=listed.find(row=>row.employmentId===employmentId);
 const records=choices.kind==='choices'?choices.qualifications:[],record=records.find(row=>row.id===qualificationId);
 const ready=!!selected&&consent&&busy===null&&(operation==='add'||!!record)&&(operation==='archive'||fields.qualification.trim().length>0);
 const update=(key:keyof Fields,value:string|boolean)=>{setFields(previous=>({...previous,[key]:typeof value==='string'&&value===''&&key!=='qualification'?null:value}));setConsent(false);};
 function prepare(event:FormEvent){event.preventDefault();if(!ready||flight.current||!selected)return;
  const input={action,contractVersion:1,employmentId:selected.employmentId,subjectId:selected.employmentId,operation,qualificationId:operation==='add'?null:qualificationId,fields:operation==='archive'?null:fields};
  if(!contract.Human.safeParse(input).success){setError(t('invalid'));return;}void dispatch({action,operation:'prepare',input});
 }
 function decide(op:'confirm'|'discard'){
  if(!review||op==='confirm'&&(!confirmed||Date.now()>=Date.parse(review.expiresAt)))return;
  void dispatch({action,operation:op,confirmation:{action,contractVersion:1,actionId:review.actionId,...(op==='confirm'?{reviewedDigest:review.reviewedDigest}:{})}});
 }
 const person=(row:Subject)=>row.employeeCode?t('employeeValue',{name:row.employeeName,code:row.employeeCode,company:row.companyName}):t('employeeNoCode',{name:row.employeeName,company:row.companyName});
 const stamp=(value:string)=>format.dateTime(new Date(value),{dateStyle:'medium',timeStyle:'short'});
 const display=(value:string|boolean|null|undefined)=>typeof value==='boolean'?t(value?'yes':'no'):value==null||value===''?t('blank'):value;
 const expired=review?now>=Date.parse(review.expiresAt):false;
 const statusText=busy?t(busy==='choices'?'loading':'working'):state.kind==='review'?t('reviewNote'):state.kind==='completed'?t('done'):state.kind==='retired'?t('retired'):state.kind==='uncertain'?t(state.actionId?'uncertain':'uncertainUnknown'):'';
 return <section aria-label={t('title')} aria-busy={busy!==null} className="min-w-0 space-y-4">
  <p ref={status} tabIndex={-1} role="status" aria-live="polite" className="text-sm outline-none">{statusText}</p>
  {error&&<p role="alert" className="text-sm">{error}</p>}
  {state.kind==='selection'&&(choices.kind==='unavailable'?<div className="space-y-2"><p className="text-sm">{t('choicesUnavailable')}</p><Link href="/admin/personnel" className="inline-flex min-h-11 items-center text-sm underline focus-visible:ring-2 focus-visible:ring-ring">{t('manual')}</Link></div>:
   <form onSubmit={prepare} className="space-y-4"><p className="text-sm text-muted-foreground">{t('intro')}</p><fieldset disabled={busy!==null} className="space-y-4">
    <div className="flex flex-wrap items-end gap-2"><div className="min-w-0 flex-1"><label htmlFor={`${id}-search`} className="block text-sm font-medium">{t('search')}</label><input id={`${id}-search`} maxLength={80} value={query} onChange={event=>setQuery(event.target.value)} className={`${inputCls} mt-1`}/></div><Button type="button" variant="outline" onClick={()=>{setEmploymentId('');clear();load('',query);}}>{t('searchButton')}</Button></div>
    <div><label htmlFor={`${id}-employee`} className="block text-sm font-medium">{t('employee')}</label><select id={`${id}-employee`} required value={employmentId} className={`${inputCls} mt-1`} onChange={event=>{const next=event.target.value;setEmploymentId(next);clear();setOperation('add');load(next,query);}}><option value="">{t('choose')}</option>{listed.map(row=><option key={row.employmentId} value={row.employmentId}>{person(row)}</option>)}</select>
     {choices.kind==='choices'&&listed.length===0&&<p className="mt-1 text-xs">{t('noEmployees')}</p>}{choices.kind==='choices'&&choices.truncated&&<p className="mt-1 text-xs">{t('truncated')}</p>}</div>
    {selected&&<>
     <div><label htmlFor={`${id}-operation`} className="block text-sm font-medium">{t('operation')}</label><select id={`${id}-operation`} value={operation} className={`${inputCls} mt-1`} onChange={event=>{setOperation(event.target.value as Operation);clear();}}>{(['add','update','archive'] as const).map(value=><option key={value} value={value}>{t(`operations.${value}`)}</option>)}</select></div>
     {operation!=='add'&&<div><label htmlFor={`${id}-record`} className="block text-sm font-medium">{t('record')}</label><select id={`${id}-record`} required value={qualificationId} className={`${inputCls} mt-1`} onChange={event=>{const next=records.find(row=>row.id===event.target.value);setQualificationId(next?.id??'');setFields(next?{...next.fields}:empty());setConsent(false);}}><option value="">{t('choose')}</option>{records.map(row=><option key={row.id} value={row.id}>{row.fields.qualification}{row.fields.institute?` · ${row.fields.institute}`:''}</option>)}</select>{records.length===0&&<p className="mt-1 text-xs">{t('noRecords')}</p>}</div>}
     {operation==='archive'?<p role="note" className="text-sm font-medium">{t('archiveNote')}</p>:<div className="grid min-w-0 gap-4 sm:grid-cols-2">
      {keys.filter(key=>key!=='isHighest').map(key=><div key={key} className={key==='description'?'sm:col-span-2':undefined}><label htmlFor={`${id}-${key}`} className="block text-sm font-medium">{t(`fields.${key}`)}</label>{key==='description'?<textarea id={`${id}-${key}`} value={fields[key]??''} maxLength={4000} onChange={event=>update(key,event.target.value)} className={`${inputCls} mt-1 min-h-24`}/>:<input id={`${id}-${key}`} list={key==='qualification'?`${id}-levels`:undefined} type={key==='fromYm'||key==='toYm'?'month':key==='graduationDate'?'date':'text'} required={key==='qualification'} maxLength={4000} value={fields[key]??''} onChange={event=>update(key,event.target.value)} className={`${inputCls} mt-1`}/>}</div>)}
      <datalist id={`${id}-levels`}>{(choices.kind==='choices'?choices.options:[]).map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</datalist>
      <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={fields.isHighest} onChange={event=>update('isHighest',event.target.checked)} className="mt-1"/>{t('fields.isHighest')}</label><p className="text-xs text-muted-foreground sm:col-span-2">{t('highestHelp')}</p>
     </div>}
     <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} className="mt-1"/>{t('consent')}</label><Button type="submit" disabled={!ready}>{t('prepare')}</Button>
    </>}
   </fieldset></form>)}
  {review&&<div className="min-w-0 space-y-4 rounded-lg border border-border p-4"><h3 className="font-semibold">{t('reviewTitle')}</h3><dl className="space-y-2 text-sm"><div><dt className="font-medium">{t('employee')}</dt><dd className="break-words">{person(review.review)}</dd></div><div><dt className="font-medium">{t('operation')}</dt><dd>{t(`operations.${review.review.operation}`)}</dd></div></dl>
   <div className="space-y-3">{keys.map(key=><div key={key} className="grid min-w-0 gap-1 border-t border-border pt-3 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,2fr)]"><p className="font-medium">{t(`fields.${key}`)}</p><div className="min-w-0"><p className="text-xs text-muted-foreground">{t('before')}</p><p className="whitespace-pre-wrap break-words">{display(review.review.before?.[key])}</p></div><div className="min-w-0"><p className="text-xs text-muted-foreground">{t('after')}</p><p className="whitespace-pre-wrap break-words">{display(review.review.after?.[key])}</p></div></div>)}</div>
   {review.review.clearsHighest&&<aside role="note" className="space-y-3 rounded-md border border-border bg-muted/30 p-3"><p className="text-sm font-medium">{t('highestTransfer')}</p><dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">{(['qualification','institute','graduationDate'] as const).map(key=><div key={key} className="min-w-0"><dt className="font-medium">{t(`fields.${key}`)}</dt><dd className="whitespace-pre-wrap break-words">{display(review.review.clearsHighest!.fields[key])}</dd></div>)}<div className="min-w-0"><dt className="font-medium">{t('fields.isHighest')}</dt><dd className="space-y-1"><p>{t('before')}: {display(review.review.clearsHighest.fields.isHighest)}</p><p>{t('after')}: {t('no')}</p></dd></div></dl></aside>}<p className="text-sm font-medium">{t('consequence')}</p><p className="text-xs text-muted-foreground">{t('expires')}: {stamp(review.expiresAt)}</p>
   {expired?<p role="alert" className="text-sm">{t('expired')}</p>:<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy!==null} onChange={event=>setConfirmed(event.target.checked)} className="mt-1"/>{t('confirmConsent')}</label>}
   <div className="flex flex-wrap gap-3"><Button type="button" disabled={busy!==null||!confirmed||expired} onClick={()=>decide('confirm')}>{t('confirm')}</Button><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>decide('discard')}>{t('discard')}</Button></div>
  </div>}
  {state.kind==='uncertain'&&state.actionId&&<Button type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'reopen',actionId:state.actionId})}>{t('reopen')}</Button>}
  {state.kind==='completed'&&<div className="space-y-2 rounded-lg border border-border p-4"><h3 className="font-semibold">{t('done')}</h3><p className="text-sm">{t(`doneOperations.${state.receipt.receipt.operation}`)}</p></div>}
  {state.kind==='retired'&&<p className="text-sm">{t('retired')}: {t(`states.${state.receipt.state}`)}</p>}
  {(state.kind==='completed'||state.kind==='retired'||state.kind==='uncertain'&&!state.actionId)&&<Button type="button" variant="outline" disabled={busy!==null} onClick={()=>{clear();setState({kind:'selection'});setError('');load();}}>{t('another')}</Button>}
  <div className="space-y-3 border-t border-border pt-4"><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'list'})}>{t('find')}</Button><p className="text-xs text-muted-foreground">{t('indexScope')}</p>
   {index&&(index.length===0?<p className="text-sm">{t('noReviews')}</p>:<ul className="space-y-2 text-sm">{index.map(row=><li key={row.actionId} className="flex flex-wrap items-center gap-3"><span>{stamp(row.createdAt)} · {t(`states.${row.state}`)}</span><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'reopen',actionId:row.actionId})}>{t('reopen')}</Button></li>)}</ul>)}
  </div>
 </section>;
}
