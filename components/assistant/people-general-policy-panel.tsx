'use client';
import Link from 'next/link';
import {useEffect,useRef,useState} from 'react';
import {useFormatter,useTranslations} from 'next-intl';
import {z} from 'zod';
import {Button} from '@/components/ui';
import * as C from '@/lib/assistant-actions/people-general-policy-contract';
import {PeopleGeneralPolicyAvailability} from '@/lib/assistant-actions/people-general-policy-view';
import {PeopleGeneralPolicyPacket} from '@/lib/assistant-actions/people-general-policy-http';
import {sendPeopleGeneralPolicy} from './people-general-policy-transport';
type Prepared=z.infer<typeof C.PeopleGeneralPolicyPrepared>;
type State={kind:'selection'}|{kind:'review';review:Prepared}|{kind:'completed';receipt:z.infer<typeof C.PeopleGeneralPolicyCompleted>}|{kind:'retired'}|{kind:'uncertain';actionId:string|null};
const action=C.PEOPLE_GENERAL_POLICY_ACTION;
export function PeopleGeneralPolicyPanel({initial,resumeActionId}:{initial:z.infer<typeof PeopleGeneralPolicyAvailability>;resumeActionId?:string}){
 const t=useTranslations('assistant.workspace.peopleGeneralPolicy'),native=useTranslations('peopleGeneral'),format=useFormatter();
 const [desired,setDesired]=useState(initial.kind==='available'?initial.policy:{allowDuplicatedNric:false,allowDuplicatedEmail:false}),[consent,setConsent]=useState(false);
 const [state,setState]=useState<State>(resumeActionId?{kind:'uncertain',actionId:resumeActionId}:{kind:'selection'}),[index,setIndex]=useState<z.infer<typeof C.PeopleGeneralPolicyIndex>['reviews']>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[now,setNow]=useState(Date.now);
 const alive=useRef(true),flight=useRef(false),abort=useRef<AbortController|null>(null),status=useRef<HTMLParagraphElement>(null),review=state.kind==='review'?state.review:null;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;abort.current?.abort();};},[]);
 useEffect(()=>{if(!busy&&state.kind!=='selection')status.current?.focus();},[state,busy]);
 useEffect(()=>{setNow(Date.now());if(!review)return;const timer=setTimeout(()=>setNow(Date.now()),Math.max(0,Date.parse(review.expiresAt)-Date.now()));return()=>clearTimeout(timer);},[review]);
 async function dispatch(value:unknown){if(flight.current)return;const parsed=PeopleGeneralPolicyPacket.safeParse(value);if(!parsed.success){setError(t('unavailable'));return;}const packet=parsed.data;
  const savedId=packet.operation==='reopen'?packet.actionId:packet.operation==='confirm'||packet.operation==='discard'?packet.confirmation.actionId:review?.actionId??(state.kind==='uncertain'?state.actionId:null);
  flight.current=true;setBusy(true);setError('');setConsent(false);const controller=new AbortController();abort.current=controller;
  try{const result=await sendPeopleGeneralPolicy(packet,controller.signal);if(!alive.current)return;
   if(result.kind==='people_general_policy_review_index'){setIndex(result.reviews);return;}
   if(result.kind==='prepared'){if(initial.kind==='available'&&result.review.review.tenantId!==initial.tenantId)throw Error();setState({kind:'review',review:result.review});return;}
   if(result.kind==='completed'){if(initial.kind==='available'&&result.receipt.receipt.tenantId!==initial.tenantId||review&&(result.receipt.receipt.tenantId!==review.review.tenantId||JSON.stringify(result.receipt.receipt.policy)!==JSON.stringify(review.content.desired)))throw Error();setState({kind:'completed',receipt:result.receipt});return;}
   setState({kind:'retired'});
  }catch{if(alive.current){setError(t('unavailable'));if(packet.operation!=='list')setState({kind:'uncertain',actionId:savedId});}}
  finally{flight.current=false;if(alive.current)setBusy(false);}
 }
 const terminalId=state.kind==='uncertain'?state.actionId:review?.actionId,changed=initial.kind==='available'&&(desired.allowDuplicatedNric!==initial.policy.allowDuplicatedNric||desired.allowDuplicatedEmail!==initial.policy.allowDuplicatedEmail);
 const flags=(values:z.infer<typeof C.PeopleGeneralPolicyValues>)=><dl className="space-y-2">{(['allowDuplicatedNric','allowDuplicatedEmail'] as const).map(key=><div key={key} className="flex flex-wrap justify-between gap-3"><dt className="min-w-0 break-words">{native(key)}</dt><dd className="font-semibold">{native(values[key]?'on':'off')}</dd></div>)}</dl>;
 return <section className="space-y-5" aria-busy={busy}>
  <p ref={status} tabIndex={-1} role="status" aria-live="polite">{busy?t('working'):state.kind==='uncertain'?t('uncertain'):state.kind==='completed'?t('completed'):state.kind==='retired'?t('retired'):t('description')}</p>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {state.kind==='selection'&&(initial.kind==='available'?<form className="space-y-4" onSubmit={e=>{e.preventDefault();if(changed)void dispatch({action,operation:'prepare',input:{action,contractVersion:1,expected:initial.policy,desired}});}}><p className="font-medium break-words">{initial.tenantName}</p><p>{t('scope')}</p><fieldset disabled={busy} className="space-y-4">{(['allowDuplicatedNric','allowDuplicatedEmail'] as const).map(key=><label key={key} className="flex items-start gap-3"><input type="checkbox" checked={desired[key]} onChange={e=>setDesired(current=>({...current,[key]:e.target.checked}))}/><span>{native(key)}</span></label>)}<Button className="h-auto min-h-11 whitespace-normal text-left" type="submit" disabled={!changed}>{t('prepare')}</Button></fieldset></form>:<p role="alert">{t('unavailable')}</p>)}
  {review&&<div className="space-y-4"><p className="font-semibold break-words">{review.review.tenantName}</p><p>{t('scope')}</p><div className="grid gap-5 sm:grid-cols-2"><div><h3 className="mb-3 font-medium">{t('before')}</h3>{flags(review.review.before)}</div><div><h3 className="mb-3 font-medium">{t('after')}</h3>{flags(review.review.after)}</div></div><p>{t('expires')}: {format.dateTime(new Date(review.expiresAt),{dateStyle:'medium',timeStyle:'short'})}</p><p>{t('consequence')}</p><p>{native('emailLoginNote')}</p>{now>=Date.parse(review.expiresAt)?<p role="alert">{t('expired')}</p>:<label className="flex items-start gap-3"><input type="checkbox" disabled={busy} checked={consent} onChange={e=>setConsent(e.target.checked)}/><span>{t('consent')}</span></label>}<Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy||!consent||now>=Date.parse(review.expiresAt)} onClick={()=>void dispatch({action,operation:'confirm',confirmation:{action,contractVersion:1,actionId:review.actionId,reviewedDigest:review.reviewedDigest}})}>{t('confirm')}</Button></div>}
  {terminalId&&<div className="flex flex-wrap gap-3"><Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy} onClick={()=>void dispatch({action,operation:'reopen',actionId:terminalId})}>{t('reopen')}</Button><Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy} onClick={()=>void dispatch({action,operation:'discard',confirmation:{action,contractVersion:1,actionId:terminalId}})}>{t('discard')}</Button></div>}
  {state.kind==='completed'&&flags(state.receipt.receipt.policy)}
  <Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy} onClick={()=>void dispatch({action,operation:'list'})}>{t('saved')}</Button>
  {index.length>0&&<ul className="space-y-2">{index.map(r=><li key={r.actionId}><Button className="h-auto min-h-11 whitespace-normal text-left" disabled={busy} onClick={()=>void dispatch({action,operation:'reopen',actionId:r.actionId})}>{t('reopen')} · {format.dateTime(new Date(r.createdAt),{dateStyle:'medium',timeStyle:'short'})}</Button></li>)}</ul>}
  {(state.kind==='completed'||state.kind==='retired')&&<Link href="/assistant/org-people-general" className="inline-flex min-h-11 items-center underline">{t('newReview')}</Link>}
  <Link href="/admin/settings/people-general" className="inline-flex min-h-11 items-center underline">{t('manual')}</Link>
 </section>;
}
