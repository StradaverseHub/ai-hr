'use client';
/** Human-only compensation register maintenance. The server owns every displayed review fact and
 * re-checks authority; a lost command is recovered by reopening the same review, never by replaying it. */
import Link from 'next/link';
import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {useFormatter,useTranslations} from 'next-intl';
import {z} from 'zod';
import {CURRENCIES} from '@/lib/currencies';
import {PERSONNEL_PAY_MODES,PERSONNEL_PAYMENT_TERMS} from '@/lib/personnel-choice-vocabulary';
import {Button,inputCls} from '@/components/ui';
import {CompensationMaintenance as contract,COMPENSATION_MAINTENANCE_ACTION as action} from '@/lib/assistant-actions/compensation-maintenance-contract';
import {checkGenericPacket,packetActionId,sendGenericModuleAction} from './generic-module-action-transport';
type Operation='set'|'edit'|'supersede';
type Fields={basicSalary:string;currency:string;payMode:typeof PERSONNEL_PAY_MODES[number];paymentTerm:typeof PERSONNEL_PAYMENT_TERMS[number];rateAmount:string|null;remarks:string|null;effectiveFrom:string};
type HistoryFields={basicSalary:string;currency:string;monthlyAllowance:string;payMode:string;paymentTerm:string;rateAmount:string|null;remarks:string|null;validFrom:string;validTo:string|null;superseded:boolean};
type Subject={employmentId:string;employeeName:string;employeeCode:string|null;companyName:string};
type Choices={kind:'choices';employees:Subject[];truncated:boolean;history:{id:string;fields:HistoryFields;revision:string}[]}|{kind:'idle'|'unavailable'};
type Item=Subject&{subjectId:string;operation:Operation;compensationId:string|null;recalculationPeriods:string[];changes:{id:string|null;before:HistoryFields|null;after:HistoryFields}[]};
type Review={actionId:string;reviewedDigest:string;createdAt:string;expiresAt:string;content:{employmentId:string;subjectId:string};review:Item};
type Receipt={actionId:string;state:'completed';receipt:{subjectId:string;employmentId:string;compensationId:string;eventId:string;operation:Operation}};
type Retired={actionId:string;state:'discarded'|'expired'|'refused'};
type IndexRow={actionId:string;state:string;createdAt:string};
type State={kind:'selection'}|{kind:'review';review:Review}|{kind:'completed';receipt:Receipt}|{kind:'retired';receipt:Retired}|{kind:'uncertain';actionId:string|null};
const empty=():Fields=>({basicSalary:'',currency:'',payMode:'monthly',paymentTerm:'monthly',rateAmount:null,remarks:null,effectiveFrom:''});
const keys=['basicSalary','currency','monthlyAllowance','payMode','paymentTerm','rateAmount','remarks','validFrom','validTo','superseded'] as const;
export function CompensationMaintenancePanel({resumeActionId,initialEmploymentId}:{resumeActionId?:string;initialEmploymentId?:string}){
 const t=useTranslations('assistant.workspace.compensationMaintenance'),format=useFormatter(),id=useId();
 const [choices,setChoices]=useState<Choices>({kind:'idle'}),[query,setQuery]=useState('');
 const [employmentId,setEmploymentId]=useState(initialEmploymentId&&z.uuid().safeParse(initialEmploymentId).success?initialEmploymentId:'');
 const [operation,setOperation]=useState<Operation>('set'),[compensationId,setCompensationId]=useState(''),[fields,setFields]=useState<Fields>(empty);
 const [state,setState]=useState<State>(()=>resumeActionId?{kind:'uncertain',actionId:z.uuid().safeParse(resumeActionId).success?resumeActionId:null}:{kind:'selection'});
 const [consent,setConsent]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[index,setIndex]=useState<IndexRow[]|null>(null),[now,setNow]=useState(()=>Date.now());
 const alive=useRef(true),flight=useRef(false),sequence=useRef(0),abort=useRef<AbortController|null>(null),status=useRef<HTMLParagraphElement>(null);
 const review=state.kind==='review'?state.review:null;
 const clear=()=>{setFields(empty());setCompensationId('');setConsent(false);setConfirmed(false);};
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
 const records=choices.kind==='choices'?choices.history:[],record=records.find(row=>row.id===compensationId);
 const ready=!!selected&&consent&&busy===null&&(operation==='set'||!!record)&&(operation==='supersede'||contract.Fields.safeParse(fields).success);
 const update=(key:keyof Fields,value:string|boolean)=>{setFields(previous=>({...previous,[key]:typeof value==='string'&&value===''&&key!=='basicSalary'&&key!=='currency'&&key!=='effectiveFrom'?null:value}));setConsent(false);};
 function prepare(event:FormEvent){event.preventDefault();if(!ready||flight.current||!selected)return;
  const input={action,contractVersion:1,employmentId:selected.employmentId,subjectId:selected.employmentId,operation,compensationId:operation==='set'?null:compensationId,fields:operation==='supersede'?null:fields};
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
    <div><label htmlFor={`${id}-employee`} className="block text-sm font-medium">{t('employee')}</label><select id={`${id}-employee`} required value={employmentId} className={`${inputCls} mt-1`} onChange={event=>{const next=event.target.value;setEmploymentId(next);clear();setOperation('set');load(next,query);}}><option value="">{t('choose')}</option>{listed.map(row=><option key={row.employmentId} value={row.employmentId}>{person(row)}</option>)}</select>
     {choices.kind==='choices'&&listed.length===0&&<p className="mt-1 text-xs">{t('noEmployees')}</p>}{choices.kind==='choices'&&choices.truncated&&<p className="mt-1 text-xs">{t('truncated')}</p>}</div>
    {selected&&<>
     <div><label htmlFor={`${id}-operation`} className="block text-sm font-medium">{t('operation')}</label><select id={`${id}-operation`} value={operation} className={`${inputCls} mt-1`} onChange={event=>{setOperation(event.target.value as Operation);clear();}}>{(['set','edit','supersede'] as const).map(value=><option key={value} value={value}>{t(`operations.${value}`)}</option>)}</select></div>
     {operation!=='set'&&<div><label htmlFor={`${id}-record`} className="block text-sm font-medium">{t('record')}</label><select id={`${id}-record`} required value={compensationId} className={`${inputCls} mt-1`} onChange={event=>{const next=records.find(row=>row.id===event.target.value);setCompensationId(next?.id??'');setFields(next?{basicSalary:next.fields.basicSalary,currency:next.fields.currency,payMode:next.fields.payMode as Fields['payMode'],paymentTerm:next.fields.paymentTerm as Fields['paymentTerm'],rateAmount:next.fields.rateAmount,remarks:next.fields.remarks,effectiveFrom:next.fields.validFrom}:empty());setConsent(false);}}><option value="">{t('choose')}</option>{records.filter(row=>!row.fields.superseded&&(operation==='supersede'||row.fields.validTo===null)).map(row=><option key={row.id} value={row.id}>{row.fields.validFrom} · {row.fields.currency} {row.fields.basicSalary}</option>)}</select>{records.length===0&&<p className="mt-1 text-xs">{t('noRecords')}</p>}</div>}
     {operation==='supersede'?<p role="note" className="text-sm font-medium">{t('supersedeNote')}</p>:<div className="grid min-w-0 gap-4 sm:grid-cols-2">
      {(['basicSalary','currency','rateAmount','effectiveFrom'] as const).map(key=><div key={key}><label htmlFor={`${id}-${key}`} className="block text-sm font-medium">{t(`fields.${key}`)}</label><input id={`${id}-${key}`} list={key==='currency'?`${id}-currencies`:undefined} type={key==='effectiveFrom'?'date':'text'} inputMode={key==='basicSalary'||key==='rateAmount'?'decimal':undefined} required={key!=='rateAmount'} maxLength={40} value={fields[key]??''} onChange={event=>update(key,event.target.value)} className={`${inputCls} mt-1`}/></div>)}
      <datalist id={`${id}-currencies`}>{CURRENCIES.map(currency=><option key={currency.code} value={currency.code}>{currency.name}</option>)}</datalist>
      <div><label htmlFor={`${id}-payMode`} className="block text-sm font-medium">{t('fields.payMode')}</label><select id={`${id}-payMode`} value={fields.payMode} onChange={event=>update('payMode',event.target.value)} className={`${inputCls} mt-1`}>{PERSONNEL_PAY_MODES.map(value=><option key={value} value={value}>{value}</option>)}</select></div>
      <div><label htmlFor={`${id}-paymentTerm`} className="block text-sm font-medium">{t('fields.paymentTerm')}</label><select id={`${id}-paymentTerm`} value={fields.paymentTerm} onChange={event=>update('paymentTerm',event.target.value)} className={`${inputCls} mt-1`}>{PERSONNEL_PAYMENT_TERMS.map(value=><option key={value} value={value}>{value}</option>)}</select></div>
      <div className="sm:col-span-2"><label htmlFor={`${id}-remarks`} className="block text-sm font-medium">{t('fields.remarks')}</label><textarea id={`${id}-remarks`} maxLength={2000} value={fields.remarks??''} onChange={event=>update('remarks',event.target.value)} className={`${inputCls} mt-1 min-h-24`}/></div><p className="text-xs text-muted-foreground sm:col-span-2">{t('moneyHelp')}</p>
     </div>}
     <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} className="mt-1"/>{t('consent')}</label><Button type="submit" disabled={!ready}>{t('prepare')}</Button>
    </>}
   </fieldset></form>)}
  {review&&<div className="min-w-0 space-y-4 rounded-lg border border-border p-4"><h3 className="font-semibold">{t('reviewTitle')}</h3><dl className="space-y-2 text-sm"><div><dt className="font-medium">{t('employee')}</dt><dd className="break-words">{person(review.review)}</dd></div><div><dt className="font-medium">{t('operation')}</dt><dd>{t(`operations.${review.review.operation}`)}</dd></div></dl>
   <div className="space-y-5">{review.review.changes.map((change,index)=><div key={change.id??`new-${index}`} className="space-y-3"><h4 className="font-medium">{change.id?t('existingRecord'):t('newRecord')}</h4>{keys.map(key=><div key={key} className="grid min-w-0 gap-1 border-t border-border pt-3 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,2fr)]"><p className="font-medium">{t(`fields.${key}`)}</p><div className="min-w-0"><p className="text-xs text-muted-foreground">{t('before')}</p><p className="whitespace-pre-wrap break-words">{display(change.before?.[key])}</p></div><div className="min-w-0"><p className="text-xs text-muted-foreground">{t('after')}</p><p className="whitespace-pre-wrap break-words">{display(change.after[key])}</p></div></div>)}</div>)}</div>
   {review.review.recalculationPeriods.length>0&&<aside role="note" className="space-y-1 rounded-md border border-border p-3 text-sm"><p className="font-medium">{t('recalculationPeriods')}</p><p>{review.review.recalculationPeriods.join(', ')}</p></aside>}<p className="text-sm font-medium">{t('consequence')}</p><p className="text-xs text-muted-foreground">{t('expires')}: {stamp(review.expiresAt)}</p>
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
