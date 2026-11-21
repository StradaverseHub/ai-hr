'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {REWARD_DASHBOARD_KINDS,type RewardDashboardKind} from '@/packs/rewards/dashboard-model';
import {saveDashboardKindAction} from './dashboard-actions';

/** b945f0cc: the Year-end cycle / Off-cycle switch at the top of the landing page. The choice is saved for this login. */
export function RewardsDashboardKindSwitch({kind}:{kind:RewardDashboardKind}){
 const t=useTranslations('rewardDashboard'),router=useRouter();
 const [current,setCurrent]=useState(kind),[failed,setFailed]=useState(false),[pending,startTransition]=useTransition();
 const choose=(next:RewardDashboardKind)=>{
  if(next===current)return;
  setCurrent(next);setFailed(false);
  startTransition(async()=>{try{await saveDashboardKindAction(next);router.refresh();}catch{setFailed(true);setCurrent(kind);}});
 };
 return <div className="space-y-2"><div role="group" aria-label={t('kindSwitch')} aria-busy={pending} className="inline-flex rounded-md border border-border p-0.5 text-sm">
  {REWARD_DASHBOARD_KINDS.map(option=><button key={option} type="button" aria-pressed={current===option} onClick={()=>choose(option)}
   className={`rounded px-3 py-1.5 ${current===option?'bg-primary text-primary-foreground':'text-muted-foreground hover:text-foreground'}`}>{t(`kinds.${option}`)}</button>)}
 </div>{failed&&<p role="alert" className="text-sm text-destructive">{t('saveFailed')}</p>}</div>;
}
