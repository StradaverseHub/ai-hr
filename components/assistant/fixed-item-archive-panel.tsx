"use client";
/** Human selection and a separate canonical archive confirmation. Every uncertainty reopens the SAME ID. */
import {useEffect,useRef,useState,type FormEvent} from 'react';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {z} from 'zod';
import {Button,inputCls} from '@/components/ui';
import {FixedItemArchive as C,FIXED_ITEM_ARCHIVE_ACTION as action} from '@/lib/assistant-actions/fixed-item-archive-contract';
import {checkGenericPacket,packetActionId,sendGenericModuleAction} from './generic-module-action-transport';
type Review=z.infer<typeof C.Prepared>;type Done=z.infer<typeof C.Completed>;type Retired=z.infer<typeof C.Retired>;type Index=z.infer<typeof C.Index>;
type State={kind:'select'}|{kind:'review';review:Review}|{kind:'completed';receipt:Done}|{kind:'retired';receipt:Retired}|{kind:'uncertain';actionId:string|null};
const fields=['code','name','amount','currency','validFrom','validTo','prorateOverride','remarks','runType','payrollCycleId'] as const;
export function FixedItemArchivePanel({resumeActionId,initialEmploymentId}:{resumeActionId?:string;initialEmploymentId?:string}){
 const t=useTranslations('assistant.workspace.fixedItemArchive'),[state,setState]=useState<State>(()=>resumeActionId?{kind:'uncertain',actionId:z.guid().safeParse(resumeActionId).success?resumeActionId:null}:{kind:'select'});
 const [choices,setChoices]=useState<z.infer<typeof C.Choices>|null>(null),[employmentId,setEmploymentId]=useState(initialEmploymentId??''),[subjectId,setSubjectId]=useState(''),[query,setQuery]=useState(''),[consent,setConsent]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[index,setIndex]=useState<Index|null>(null),[now,setNow]=useState(Date.now);
 const flight=useRef(false),alive=useRef(true),controller=useRef<AbortController|null>(null),review=state.kind==='review'?state.review:null;
 useEffect(()=>{if(!review)return;setNow(Date.now());const timer=setTimeout(()=>setNow(Date.now()),Math.min(2147483647,Math.max(0,Date.parse(review.expiresAt)-Date.now())));return()=>clearTimeout(timer);},[review]);
 const clear=()=>{setSubjectId('');setConsent(false);setConfirmed(false);};
 async function dispatch(value:unknown){
  if(flight.current)return;const packet=checkGenericPacket(value);if(!packet||packet.action!==action){setError(t('unavailable'));return;}
  flight.current=true;setBusy(true);setError('');setIndex(null);const abort=new AbortController();controller.current=abort;
  try{const result=await sendGenericModuleAction(packet,abort.signal);if(!alive.current)return;
   if(packet.operation==='choices'){setChoices(C.Choices.parse(result));setConsent(false);return;}
   if(packet.operation==='list'){setIndex(C.Index.parse(result));return;}
   clear();if(result.kind==='prepared'){setState({kind:'review',review:C.Prepared.parse(result.review)});return;}
   if(result.kind==='completed'){setState({kind:'completed',receipt:C.Completed.parse(result.receipt)});return;}
   if(result.kind==='retired'){setState({kind:'retired',receipt:C.Retired.parse(result.receipt)});return;}throw Error();
  }catch{if(alive.current){if(packet.operation==='choices'){setChoices({kind:'unavailable'});setError(t('unavailable'));return;}clear();if(packet.operation!=='list')setState({kind:'uncertain',actionId:packetActionId(packet)??review?.actionId??null});setError(t('unavailable'));}}
  finally{flight.current=false;controller.current=null;if(alive.current)setBusy(false);}
 }
 const load=(id=employmentId)=>void dispatch({action,operation:'choices',selection:{query,...(id?{employmentId:id}:{})}});
 useEffect(()=>{alive.current=true;if(state.kind==='select')load();return()=>{alive.current=false;controller.current?.abort();};
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 const selected=choices?.kind==='choices'?choices.employees.find(row=>row.employmentId===employmentId):undefined,items=choices?.kind==='choices'?choices.items:[],item=items.find(row=>row.id===subjectId),expired=review?Date.parse(review.expiresAt)<=now:false;
 const display=(value:unknown)=>value===null?t('none'):typeof value==='boolean'?t(value?'yes':'no'):String(value);
 function prepare(event:FormEvent){event.preventDefault();if(!selected||!item||!consent||busy)return;void dispatch({action,operation:'prepare',input:{action,contractVersion:1,employmentId,subjectId}});}
 const decide=(operation:'confirm'|'discard')=>{if(!review||busy||operation==='confirm'&&(!confirmed||expired))return;void dispatch({action,operation,confirmation:{action,contractVersion:1,actionId:review.actionId,...(operation==='confirm'?{reviewedDigest:review.reviewedDigest}:{})}});};
 return <section className="space-y-5" aria-busy={busy}>
  <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{busy?t('working'):''}</p>{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {state.kind==='select'&&<form onSubmit={prepare} className="space-y-4">
   <div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-sm font-medium">{t('search')}<input value={query} maxLength={80} onChange={e=>setQuery(e.target.value)} className={`${inputCls} mt-1`}/></label><Button type="button" variant="outline" disabled={busy} onClick={()=>load('')}>{t('search')}</Button></div>
   <label className="block text-sm font-medium">{t('employee')}<select value={employmentId} disabled={busy} className={`${inputCls} mt-1`} onChange={e=>{setEmploymentId(e.target.value);clear();load(e.target.value);}}><option value="">{t('choose')}</option>{choices?.kind==='choices'&&choices.employees.map(row=><option key={row.employmentId} value={row.employmentId}>{t('employeeValue',{name:row.employeeName,code:row.employeeCode??'—',company:row.companyName})}</option>)}</select></label>
   {choices?.kind==='choices'&&choices.truncated&&<p className="text-xs text-muted-foreground">{t('truncated')}</p>}
   {selected&&<label className="block text-sm font-medium">{t('item')}<select value={subjectId} disabled={busy} className={`${inputCls} mt-1`} onChange={e=>{setSubjectId(e.target.value);setConsent(false);}}><option value="">{t('choose')}</option>{items.map(row=><option key={row.id} value={row.id}>{row.fields.code} · {row.fields.name} · {row.fields.validFrom}</option>)}</select></label>}
   {selected&&items.length===0&&<p className="text-sm text-muted-foreground">{t('empty')}</p>}
   <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={consent} disabled={busy||!item} onChange={e=>setConsent(e.target.checked)} className="mt-1"/>{t('consent')}</label>
   <Button type="submit" disabled={busy||!selected||!item||!consent}>{t('prepare')}</Button>
  </form>}
  {review&&<div className="space-y-4 rounded-lg border border-border p-4"><h2 className="text-lg font-semibold">{t('reviewTitle')}</h2><p className="text-sm">{t('employeeValue',{name:review.review.employeeName,code:review.review.employeeCode??'—',company:review.review.companyName})}</p>
   <dl className="grid min-w-0 gap-4 text-sm sm:grid-cols-2">{fields.map(key=><div key={key} className="min-w-0"><dt className="font-medium">{t(`fields.${key}`)}</dt><dd className="whitespace-pre-wrap break-words">{display(review.review.before[key])}</dd></div>)}</dl>
   <div className="rounded-md bg-muted/40 p-3 text-sm"><p>{t('before')}: {t('active')}</p><p className="mt-1 font-medium">{t('after')}: {t('archived')}</p></div>
   <p className="text-sm font-medium">{t('consequence')}</p>{review.review.before.code==='BASIC'&&<p className="text-sm">{t('basicNote')}</p>}<p className="text-sm text-muted-foreground">{t('history')}</p><p className="text-sm text-muted-foreground">{t('recalculation')}</p>
   {review.review.processedPeriods.length>0&&<p className="text-sm">{t('processed')}: {review.review.processedPeriods.join(', ')}</p>}
   <p className="text-xs text-muted-foreground">{t('expires')}: {review.expiresAt}</p>
   {expired?<p role="alert" className="text-sm">{t('expired')}</p>:<label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)} className="mt-1"/>{t('confirmConsent')}</label>}
   <div className="flex flex-wrap gap-2"><Button type="button" disabled={busy||!confirmed||expired} onClick={()=>decide('confirm')}>{t('confirm')}</Button><Button type="button" variant="outline" disabled={busy} onClick={()=>decide('discard')}>{t('discard')}</Button></div>
  </div>}
  {state.kind==='uncertain'&&<aside className="space-y-3 rounded-md border border-border p-4"><p className="text-sm">{t('uncertain')}</p>{state.actionId&&<Button type="button" disabled={busy} onClick={()=>void dispatch({action,operation:'reopen',actionId:state.actionId})}>{t('reopen')}</Button>}</aside>}
  {state.kind==='completed'&&<div className="space-y-2"><h2 className="font-semibold">{t('done')}</h2><p className="text-sm">{t('history')}</p><p className="text-sm">{t('recalculation')}</p><p className="break-all text-xs text-muted-foreground">{state.receipt.receipt.eventId}</p></div>}
  {state.kind==='retired'&&<p>{t('retired')}</p>}
  <Button type="button" variant="outline" disabled={busy} onClick={()=>void dispatch({action,operation:'list'})}>{t('resume')}</Button>
  {index&&<ul className="space-y-2">{index.reviews.map(row=><li key={row.actionId}><button type="button" className="min-h-11 text-left text-sm underline" disabled={busy} onClick={()=>void dispatch({action,operation:'reopen',actionId:row.actionId})}>{row.createdAt} · {row.state}</button></li>)}</ul>}
  <p className="text-sm text-muted-foreground">{t('nativeNote')} <Link href="/payroll/transactions/fixed" className="underline">{t('native')}</Link></p>
 </section>;
}
