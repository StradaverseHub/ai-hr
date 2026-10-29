'use client';
/** ADR-0151 (amendment 2026-10-29): an HR administrator prepares one change to ANOTHER employee's record — a
 * leave adjustment or an assignment-only movement — reviews the server's stored facts, then confirms. Only an
 * employee from the server's search can be chosen and never the administrator's own record; the days, dates,
 * reason and destination are typed here by HR, never filled in by the model. A lost confirmation is never
 * retried: HR reopens the same saved review. */
import Link from 'next/link';
import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {useFormatter,useTranslations} from 'next-intl';
import {z} from 'zod';
import {Button,inputCls} from '@/components/ui';
import {HR_LEAVE_ADJUSTMENT_ACTION,HR_LEAVE_CREDIT_ACTION,HR_PREPARED_CONTRACTS,type HrPreparedAction} from '@/lib/assistant-actions/hr-prepared-contract';
import {checkGenericPacket,packetActionId,sendGenericModuleAction} from './generic-module-action-transport';
type Option={id:string;name:string};
type Subject={employmentId:string;employeeName:string;employeeCode:string|null;companyName:string};
type Choices={kind:'choices';employees:Subject[];truncated:boolean;leaveTypes?:Option[];departments?:Option[];positions?:Option[];businessUnits?:Option[];locations?:Option[]}|{kind:'unavailable'}|{kind:'idle'};
type Item=Record<string,unknown>&Subject&{subjectId:string};
type Review={actionId:string;reviewedDigest:string;createdAt:string;expiresAt:string;content:Record<string,unknown>&{employmentId:string;subjectId:string};review:Item};
type Receipt={actionId:string;state:'completed';receipt:Record<string,unknown>&{subjectId:string;employmentId:string}};
type Retired={actionId:string;state:'discarded'|'expired'|'refused'};type Row={actionId:string;state:string;createdAt:string};
type Contract={Choices:z.ZodType;Index:z.ZodType;Prepared:z.ZodType;Completed:z.ZodType;Retired:z.ZodType};
type State={kind:'selection'}|{kind:'review';review:Review}|{kind:'completed';receipt:Receipt}|{kind:'retired';receipt:Retired}|{kind:'uncertain';actionId:string|null};
const fail=()=>Error('HR action unavailable.');
export const hrPreparedKind=(action:HrPreparedAction)=>action===HR_LEAVE_ADJUSTMENT_ACTION?'leave' as const:action===HR_LEAVE_CREDIT_ACTION?'credit' as const:'movement' as const;
export function HrPreparedPanel({action,resumeActionId,initialEmploymentId}:{action:HrPreparedAction;resumeActionId?:string;initialEmploymentId?:string}){
 const t=useTranslations('assistant.workspace.hrActions'),f=useFormatter(),id=useId(),kind=hrPreparedKind(action),contract=HR_PREPARED_CONTRACTS[action] as unknown as Contract;
 const [choices,setChoices]=useState<Choices>({kind:'idle'});
 const [state,setState]=useState<State>(()=>resumeActionId?{kind:'uncertain',actionId:z.uuid().safeParse(resumeActionId).success?resumeActionId:null}:{kind:'selection'});
 const [query,setQuery]=useState(''),[employmentId,setEmploymentId]=useState(initialEmploymentId&&z.uuid().safeParse(initialEmploymentId).success?initialEmploymentId:'');
 const [form,setForm]=useState<Record<string,string>>({});
 const [consent,setConsent]=useState(false),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[index,setIndex]=useState<Row[]|null>(null),[now,setNow]=useState(()=>Date.now());
 const flight=useRef(false),alive=useRef(true),sequence=useRef(0),abort=useRef<AbortController|null>(null),status=useRef<HTMLParagraphElement>(null);
 const review=state.kind==='review'?state.review:null;
 useEffect(()=>{if(!busy&&state.kind!=='selection')status.current?.focus();},[state,busy]);
 useEffect(()=>{setNow(Date.now());if(!review)return;const timer=setTimeout(()=>setNow(Date.now()),Math.min(2147483647,Math.max(0,Date.parse(review.expiresAt)-Date.now())));return()=>clearTimeout(timer);},[review]);
 const field=(name:string)=>form[name]??'',set=(name:string,value:string)=>{setForm(prev=>({...prev,[name]:value}));setConsent(false);};
 const clear=()=>{setForm({});setConsent(false);setConfirm(false);};
 async function dispatch(value:unknown){
  if(flight.current)return;const packet=checkGenericPacket(value);if(!packet||packet.action!==action){setError(t('unavailable'));return;}
  const op=packet.operation,token=++sequence.current,fallbackId=packetActionId(packet);
  flight.current=true;setBusy(op);setError('');setIndex(null);const controller=new AbortController();abort.current=controller;
  try{
   const result=await sendGenericModuleAction(packet,controller.signal);if(!alive.current||sequence.current!==token)return;
   if(op==='choices'){setChoices(contract.Choices.parse(result) as Choices);return;}
   if(op==='list'){setIndex((contract.Index.parse(result) as {reviews:Row[]}).reviews);return;}
   if(result.kind==='prepared'){const prepared=contract.Prepared.parse((result as {review:unknown}).review) as Review;clear();setState({kind:'review',review:prepared});return;}
   if(result.kind==='completed'){const receipt=contract.Completed.parse((result as {receipt:unknown}).receipt) as Receipt;if(state.kind==='review'&&receipt.receipt.subjectId!==state.review.content.subjectId)throw fail();clear();setState({kind:'completed',receipt});return;}
   if(result.kind==='retired'){const receipt=contract.Retired.parse((result as {receipt:unknown}).receipt) as Retired;clear();setState({kind:'retired',receipt});return;}
   throw fail();
  }catch{if(alive.current&&sequence.current===token){
   if(op==='choices'){setChoices({kind:'unavailable'});setError(t('choicesUnavailable'));return;}
   const prior=state.kind==='review'?state.review.actionId:null;clear();if(op!=='list'||prior)setState({kind:'uncertain',actionId:fallbackId??prior});setError(t('unavailable'));}}
  finally{if(sequence.current===token){flight.current=false;abort.current=null;if(alive.current)setBusy(null);}}
 }
 const load=(selected=employmentId,text=query)=>void dispatch({action,operation:'choices',selection:{query:text,...(selected?{employmentId:selected}:{})}});
 useEffect(()=>{alive.current=true;flight.current=false;if(state.kind==='selection')load();return()=>{alive.current=false;sequence.current++;abort.current?.abort();};
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 const listed=choices.kind==='choices'?choices.employees:[],selected=listed.find(row=>row.employmentId===employmentId);
 const leaveReady=kind==='leave'&&!!field('leaveTypeId')&&!!field('direction')&&/^(?:[1-9]\d{0,2}|0)(?:\.[05])?$/.test(field('days'))&&Number(field('days'))>0&&!!field('effectiveOn')&&field('reason').trim().length>0;
 const destination=['departmentId','positionId','businessUnitId','locationId'].some(name=>!!field(name));
 const movementReady=kind==='movement'&&!!field('kind')&&!!field('effectiveDate')&&destination;
 const creditReady=kind==='credit'&&!!field('workedDate')&&/^\d{2}:\d{2}$/.test(field('claimStart'))&&/^\d{2}:\d{2}$/.test(field('claimEnd'))&&field('claimStart')!==field('claimEnd')&&field('reason').trim().length>0;
 const ready=!!selected&&consent&&(leaveReady||movementReady||creditReady);
 function prepare(event:FormEvent){event.preventDefault();if(!ready||!selected||flight.current)return;
  const base={action,contractVersion:1,employmentId:selected.employmentId,subjectId:selected.employmentId};
  const input=kind==='leave'?{...base,leaveTypeId:field('leaveTypeId'),direction:field('direction'),days:field('days'),effectiveOn:field('effectiveOn'),reason:field('reason')}
   :kind==='credit'?{...base,workedDate:field('workedDate'),claimStart:field('claimStart'),claimEnd:field('claimEnd'),reason:field('reason'),firstScheduleConsent:field('firstScheduleConsent')==='true'}
   :{...base,kind:field('kind'),effectiveDate:field('effectiveDate'),departmentId:field('departmentId')||null,positionId:field('positionId')||null,businessUnitId:field('businessUnitId')||null,locationId:field('locationId')||null,...(field('remarks').trim()?{remarks:field('remarks')}:{})};
  void dispatch({action,operation:'prepare',input});
 }
 function decide(operation:'confirm'|'discard'){if(!review||operation==='confirm'&&(!confirm||Date.now()>=Date.parse(review.expiresAt)))return;
  void dispatch(operation==='confirm'?{action,operation,confirmation:{action,contractVersion:1,actionId:review.actionId,reviewedDigest:review.reviewedDigest}}:{action,operation,confirmation:{action,contractVersion:1,actionId:review.actionId}});}
 const expired=review?now>=Date.parse(review.expiresAt):false,stamp=(value:string)=>f.dateTime(new Date(value),{dateStyle:'medium',timeStyle:'short'}),day=(value:string)=>f.dateTime(new Date(value+'T00:00:00'),{dateStyle:'medium'});
 const person=(row:Subject)=>row.employeeCode?t('employeeValue',{name:row.employeeName,code:row.employeeCode,company:row.companyName}):t('employeeNoCode',{name:row.employeeName,company:row.companyName});
 const fact=(label:string,value:string)=><div><dt className="font-medium">{t(label)}</dt><dd className="whitespace-pre-wrap break-words">{value}</dd></div>;
 const none=t('notChanged');
 // Days are shown exactly as the stored signed string; nothing is recalculated.
 const facts=(row:Item)=>kind==='credit'?<>{fact('employee',person(row))}{fact('workedDate',day(String(row.workedDate)))}{fact('dayType',t(`dayTypes.${String(row.dayType)}`))}{fact('claimStart',String(row.claimStart))}{fact('claimEnd',String(row.claimEnd))}
   {fact('creditDays',row.creditDays==null?t('creditLegacy'):t('creditDaysValue',{days:f.number(Number(row.creditDays))}))}
   {fact('overtimeMinutes',f.number(Number(row.overtimeMinutes)))}{fact('firstSchedule',t(row.firstScheduleEligible?'yes':'no'))}{row.firstScheduleEligible===true&&fact('firstScheduleConsent',t(row.firstScheduleConsent?'yes':'no'))}{fact('reason',String(row.reason))}
   {Number(row.overtimeMinutes)>0&&<p role="note" className="text-sm font-medium">{t('overtimeWarning')}</p>}</>
  :kind==='leave'?<>{fact('employee',person(row))}{fact('leaveType',String(row.leaveTypeName))}{fact('signedDays',String(row.signedDays))}{fact('effectiveOn',day(String(row.effectiveOn)))}{fact('reason',String(row.reason))}</>
  :<>{fact('employee',person(row))}{fact('movementKind',t(`kinds.${String(row.kind)}`))}{fact('effectiveDate',day(String(row.effectiveDate)))}{fact('department',(row.department as string|null)??none)}{fact('position',(row.position as string|null)??none)}{fact('businessUnit',(row.businessUnit as string|null)??none)}{fact('location',(row.location as string|null)??none)}{fact('remarks',(row.remarks as string|null)??t('notProvided'))}</>;
 const select=(name:string,label:string,options:Option[]|undefined)=><div><label htmlFor={`${id}-${name}`} className="block text-sm font-medium">{t(label)}</label><select id={`${id}-${name}`} value={field(name)} className={`${inputCls} mt-1`} onChange={event=>set(name,event.target.value)}><option value="">{t('keepCurrent')}</option>{(options??[]).map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></div>;
 const statusText=busy?(busy==='choices'?t('loading'):t('working')):state.kind==='review'?t('reviewNote'):state.kind==='completed'?t('done'):state.kind==='retired'?t('retired'):state.kind==='uncertain'?t(state.actionId?'uncertain':'uncertainUnknown'):'';
 return <section className="min-w-0 space-y-4" aria-label={t(`${kind}.title`)} aria-busy={busy!==null}>
  <p ref={status} tabIndex={-1} role="status" aria-live="polite" className="text-sm outline-none">{statusText}</p>
  {error&&<p role="alert" className="text-sm">{error}</p>}
  {state.kind==='selection'&&(choices.kind==='unavailable'?<div className="space-y-2"><p className="text-sm">{t('choicesUnavailable')}</p><Link href={kind==='leave'?'/admin/leave-config/adjustments':kind==='credit'?'/admin/leave-config/leave-credit':'/admin/personnel'} className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('manual')}</Link></div>
   :<form onSubmit={prepare} className="space-y-4"><p className="text-sm text-muted-foreground">{t(`${kind}.intro`)}</p><fieldset disabled={busy!==null} className="space-y-4">
   <div className="flex flex-wrap items-end gap-2"><div className="min-w-0 flex-1"><label htmlFor={`${id}-query`} className="block text-sm font-medium">{t('search')}</label><input id={`${id}-query`} value={query} maxLength={80} className={`${inputCls} mt-1`} onChange={event=>setQuery(event.target.value)}/></div><Button type="button" variant="outline" onClick={()=>load('',query)}>{t('searchButton')}</Button></div>
   <div><label htmlFor={`${id}-employee`} className="block text-sm font-medium">{t('employee')}</label><select id={`${id}-employee`} required value={employmentId} className={`${inputCls} mt-1`} onChange={event=>{setEmploymentId(event.target.value);clear();if(kind==='movement'&&event.target.value)load(event.target.value,query);}}><option value="">{t('choose')}</option>{listed.map(row=><option key={row.employmentId} value={row.employmentId}>{person(row)}</option>)}</select>
    {choices.kind==='choices'&&listed.length===0&&<p className="mt-1 text-xs">{t('noEmployees')}</p>}{choices.kind==='choices'&&choices.truncated&&<p className="mt-1 text-xs">{t('truncated')}</p>}</div>
   {kind==='leave'?<>
    <div><label htmlFor={`${id}-type`} className="block text-sm font-medium">{t('leaveType')}</label><select id={`${id}-type`} required value={field('leaveTypeId')} className={`${inputCls} mt-1`} onChange={event=>set('leaveTypeId',event.target.value)}><option value="">{t('choose')}</option>{(choices.kind==='choices'?choices.leaveTypes??[]:[]).map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></div>
    <fieldset className="space-y-2"><legend className="text-sm font-medium">{t('direction')}</legend>{(['add','deduct'] as const).map(value=><label key={value} className="flex items-center gap-2 text-sm"><input type="radio" name={`${id}-direction`} checked={field('direction')===value} onChange={()=>set('direction',value)}/>{t(`directions.${value}`)}</label>)}</fieldset>
    <div><label htmlFor={`${id}-days`} className="block text-sm font-medium">{t('days')}</label><input id={`${id}-days`} inputMode="decimal" required value={field('days')} aria-describedby={`${id}-days-help`} className={`${inputCls} mt-1`} onChange={event=>set('days',event.target.value)}/><p id={`${id}-days-help`} className="text-xs text-muted-foreground">{t('daysHelp')}</p></div>
    <div><label htmlFor={`${id}-on`} className="block text-sm font-medium">{t('effectiveOn')}</label><input id={`${id}-on`} type="date" required value={field('effectiveOn')} className={`${inputCls} mt-1`} onChange={event=>set('effectiveOn',event.target.value)}/></div>
    <div><label htmlFor={`${id}-reason`} className="block text-sm font-medium">{t('reason')}</label><textarea id={`${id}-reason`} required maxLength={500} value={field('reason')} aria-describedby={`${id}-reason-help`} className={`${inputCls} mt-1`} onChange={event=>set('reason',event.target.value)}/><p id={`${id}-reason-help`} className="text-xs text-muted-foreground">{t('reasonHelp')}</p></div>
   </>:kind==='credit'?<>
    <div><label htmlFor={`${id}-worked`} className="block text-sm font-medium">{t('workedDate')}</label><input id={`${id}-worked`} type="date" required value={field('workedDate')} className={`${inputCls} mt-1`} onChange={event=>set('workedDate',event.target.value)}/></div>
    <div className="flex flex-wrap gap-3"><div><label htmlFor={`${id}-start`} className="block text-sm font-medium">{t('claimStart')}</label><input id={`${id}-start`} type="time" required value={field('claimStart')} className={`${inputCls} mt-1`} onChange={event=>set('claimStart',event.target.value)}/></div>
     <div><label htmlFor={`${id}-end`} className="block text-sm font-medium">{t('claimEnd')}</label><input id={`${id}-end`} type="time" required value={field('claimEnd')} className={`${inputCls} mt-1`} onChange={event=>set('claimEnd',event.target.value)}/></div></div>
    <div><label htmlFor={`${id}-reason`} className="block text-sm font-medium">{t('reason')}</label><textarea id={`${id}-reason`} required maxLength={500} value={field('reason')} aria-describedby={`${id}-reason-help`} className={`${inputCls} mt-1`} onChange={event=>set('reason',event.target.value)}/><p id={`${id}-reason-help`} className="text-xs text-muted-foreground">{t('reasonHelp')}</p></div>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={field('firstScheduleConsent')==='true'} onChange={event=>set('firstScheduleConsent',String(event.target.checked))} className="mt-1"/>{t('firstScheduleConsent')}</label>
   </>:<>
    <fieldset className="space-y-2"><legend className="text-sm font-medium">{t('movementKind')}</legend>{(['transfer','orgAssignmentChange'] as const).map(value=><label key={value} className="flex items-center gap-2 text-sm"><input type="radio" name={`${id}-kind`} checked={field('kind')===value} onChange={()=>set('kind',value)}/>{t(`kinds.${value}`)}</label>)}</fieldset>
    <div><label htmlFor={`${id}-date`} className="block text-sm font-medium">{t('effectiveDate')}</label><input id={`${id}-date`} type="date" required value={field('effectiveDate')} aria-describedby={`${id}-date-help`} className={`${inputCls} mt-1`} onChange={event=>set('effectiveDate',event.target.value)}/><p id={`${id}-date-help`} className="text-xs text-muted-foreground">{t('effectiveDateHelp')}</p></div>
    {choices.kind==='choices'&&<>{select('departmentId','department',choices.departments)}{select('positionId','position',choices.positions)}{select('businessUnitId','businessUnit',choices.businessUnits)}{select('locationId','location',choices.locations)}</>}
    <p className="text-xs text-muted-foreground">{t('movementScope')}</p>
    <div><label htmlFor={`${id}-remarks`} className="block text-sm font-medium">{t('remarks')}</label><textarea id={`${id}-remarks`} maxLength={1000} value={field('remarks')} className={`${inputCls} mt-1`} onChange={event=>set('remarks',event.target.value)}/></div>
   </>}
   <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} className="mt-1"/>{t('consent')}</label>
   <Button type="submit" disabled={!ready}>{t('prepare')}</Button>
  </fieldset></form>)}
  {review&&<div className="space-y-4 rounded-lg border border-border p-4"><h3 className="font-semibold">{t('reviewTitle')}</h3>
   <dl className="space-y-1 text-sm">{facts(review.review)}</dl>
   <p className="text-sm font-medium">{t(`${kind}.consequence`)}{kind==='movement'&&review.review.scheduled===true?` ${t('scheduledNote')}`:''}</p><p className="text-xs text-muted-foreground">{t('expires')}: {stamp(review.expiresAt)}</p>
   {expired?<p role="alert" className="text-sm">{t('expired')}</p>:<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirm} disabled={busy!==null} onChange={event=>setConfirm(event.target.checked)} className="mt-1"/>{t('confirmConsent')}</label>}
   <div className="flex flex-wrap gap-3"><Button type="button" disabled={busy!==null||!confirm||expired} onClick={()=>decide('confirm')}>{t('confirm')}</Button><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>decide('discard')}>{t('discard')}</Button></div></div>}
  {state.kind==='uncertain'&&state.actionId&&<Button type="button" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'reopen',actionId:state.actionId})}>{t('reopen')}</Button>}
  {state.kind==='completed'&&<div className="space-y-2 rounded-lg border border-border p-4"><h3 className="font-semibold">{t('done')}</h3>
   <p className="text-sm">{kind==='leave'?t('doneLeave'):kind==='credit'?t('doneCredit',{days:f.number(Number(state.receipt.receipt.daysCredited)),date:day(String(state.receipt.receipt.workedDate))}):t(state.receipt.receipt.recorded==='scheduled'?'doneScheduled':'doneApplied')}</p></div>}
  {state.kind==='retired'&&<p className="text-sm">{t('retiredState')}: {t(`states.${state.receipt.state}`)}</p>}
  {(state.kind==='completed'||state.kind==='retired'||state.kind==='uncertain'&&!state.actionId)&&<Button type="button" variant="outline" disabled={busy!==null} onClick={()=>{clear();setState({kind:'selection'});setIndex(null);setError('');load();}}>{t('another')}</Button>}
  <div className="space-y-3 border-t border-border pt-4"><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'list'})}>{t('find')}</Button><p className="text-xs text-muted-foreground">{t('indexScope')}</p>
   {index&&(index.length===0?<p className="text-sm">{t('noReviews')}</p>:<ul className="space-y-2 text-sm">{index.map(row=><li key={row.actionId} className="flex flex-wrap items-center gap-3"><span>{stamp(row.createdAt)} · {t(`states.${row.state}`)}</span><Button type="button" variant="outline" disabled={busy!==null} onClick={()=>void dispatch({action,operation:'reopen',actionId:row.actionId})}>{t('reopen')}</Button></li>)}</ul>)}</div>
 </section>;
}
