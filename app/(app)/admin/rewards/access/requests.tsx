'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Button,Card,Field,inputCls} from '@/components/ui';
import type {RewardAccessAdministration,RewardAccessRequest} from '@/packs/rewards/service';
import {decideRewardAccessRequestAction} from './actions';
export function RewardAccessRequests({requests,value}:{requests:RewardAccessRequest[];value:RewardAccessAdministration}){
 const t=useTranslations('rewardsAccessControl');
 const pending=requests.filter(request=>request.status==='pending');
 return <Card className="space-y-3 p-4 sm:p-6"><h2 className="font-semibold">{t('waiting',{count:pending.length})}</h2><p className="text-sm text-muted-foreground">{t('independent')}</p>
 {pending.length?pending.map(request=><Request key={request.id} request={request} value={value}/>):<p className="text-sm text-muted-foreground">{t('noPending')}</p>}
 {requests.some(request=>request.status!=='pending')&&<details><summary className="cursor-pointer text-sm font-medium">{t('history')}</summary><ul className="mt-3 space-y-2 text-sm">{requests.filter(request=>request.status!=='pending').map(request=><li key={request.id}>{t(`statuses.${request.status}`)} · {request.requestedName??t('administrator')} · {request.decidedAt}{request.reason&&<p className="text-muted-foreground">{request.reason}</p>}</li>)}</ul></details>}
 </Card>;
}
function Request({request,value}:{request:RewardAccessRequest;value:RewardAccessAdministration}){
 const t=useTranslations('rewardsAccessControl'),r=useTranslations('rewards'),router=useRouter();
 const [reason,setReason]=useState(''),[error,setError]=useState(''),[busy,start]=useTransition();
 const name=(id:string)=>value.users.find(user=>user.id===id)?.name??value.members.find(member=>member.userId===id)?.name??t('unavailable');
 const assignment=(member:RewardAccessRequest['changes'][number]['after'])=>member?`${name(member.userId)} · ${r(`roles.${member.role}`)}${member.validFrom?` · ${member.validFrom} – ${member.validTo??t('openEnded')}`:''}${member.coversUserId?` · ${t('proxyFor',{name:name(member.coversUserId)})}`:''}`:t('none');
 function decide(approve:boolean){start(async()=>{setError('');try{const result=await decideRewardAccessRequestAction(request.id,approve,reason);if(result.ok)router.refresh();else setError(result.error);}catch{setError('system');}});}
 return <details className="rounded-md border p-4"><summary className="cursor-pointer text-sm font-medium">{t('requested',{name:request.requestedName??t('administrator'),count:request.changes.length})} · {request.requestedAt}</summary>
 <ul className="my-4 space-y-3">{request.changes.map((change,index)=>{const review=value.reviews.find(row=>row.id===change.unitId);return <li key={index} className="rounded-md bg-muted/40 p-3 text-sm"><p className="font-medium">{review?`${review.company} / ${review.unit} · ${review.cycle}`:t('unavailable')}</p><p className="mt-1">{t('before')}: {assignment(change.before)}</p><p>{t('after')}: {assignment(change.after)}</p>{change.after?.restoreReason&&<p>{t('restoreReason')}: {change.after.restoreReason}</p>}</li>;})}</ul>
 {request.canDecide?<div className="space-y-3"><Field label={t('rejectionReason')}><textarea className={inputCls} maxLength={2000} value={reason} onChange={event=>setReason(event.target.value)}/></Field><div className="flex flex-wrap gap-2"><Button type="button" disabled={busy} onClick={()=>decide(true)}>{t('approve')}</Button><Button type="button" variant="outline" disabled={busy||reason.trim().length<10} onClick={()=>decide(false)}>{t('reject')}</Button></div></div>:<p className="text-sm text-muted-foreground">{t('needsChecker')}</p>}
 {error&&<p role="alert" className="mt-3 text-sm text-destructive">{t('decisionFailed')}</p>}
 </details>;
}
