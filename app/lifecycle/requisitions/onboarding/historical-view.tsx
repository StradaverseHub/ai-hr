'use client';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import { OnboardingBadge,OnboardingBreadcrumb,OnboardingSummary,OnboardingStat } from '@/components/onboarding-workspace';
import { useOnboardingCopy } from '@/lib/onboarding-copy';
import { onboardingDate } from '@/lib/onboarding-presentation';
import { onboardingTimestamp } from '@/lib/onboarding-format';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { requisitionItemCounts,effectiveFacts,requisitionStatus } from '@/lib/onboarding-model';
import type { onboardingDetail } from '@/packs/lifecycle/service';

export function HistoricalOnboardingRequisition({detail,generation}:{detail:Awaited<ReturnType<typeof onboardingDetail>>;generation:string}){
 const copy=useOnboardingCopy(),locale=useLocale(),c=detail.case,r=c.requisitions.find(x=>x.id===generation);
 if(!r)return null;
 const f=effectiveFacts(c),counts=requisitionItemCounts(r);
 const activity=c.history.filter(h=>h.at>=r.createdAt&&(!r.cancelledAt||h.at<=r.cancelledAt));
 const user=(id:string|null)=>detail.directory.find(u=>u.id===id)?.name??c.history.find(h=>h.by===id)?.name??id??copy('Unassigned');
 return <div className="onb-workspace space-y-5"><OnboardingBreadcrumb root="Requisitions" items={[{label:'All requisitions',href:'/lifecycle/requisitions/onboarding'},{label:r.number}]}/><header><h1>{r.number}</h1><p className="onb-muted">{f.fullName} · {c.number}</p></header><p className="onb-sync">{copy('Previous requisition. Its original items, approvals and history are retained.')}</p>
 <OnboardingSummary><OnboardingStat label={copy('Status')} value={<OnboardingBadge tone={r.cancelledAt?'danger':'neutral'}>{copy(requisitionStatus(r))}</OnboardingBadge>}/><OnboardingStat label={copy('Join date')} value={onboardingDate(f.joinDate,locale)} detail={copy('From the onboarding case')}/><OnboardingStat label={copy('Items')} value={counts.ready+' '+copy('of')+' '+counts.total+' '+copy('ready')}/><OnboardingStat label={copy('Created')} value={onboardingDate(todayInKualaLumpur(new Date(r.createdAt)),locale)}/></OnboardingSummary>
 <div className="onb-columns"><div className="onb-main"><section className="onb-panel space-y-3"><h2>{copy('Approvals')}</h2>{r.items.filter(i=>i.steps.length).map(i=><div key={i.id} className="space-y-2 border-t border-border pt-3"><h3>{i.name}</h3><p className="onb-muted">{copy(i.mode==='par'?'In parallel':'In sequence')}{i.workflowName?' · '+i.workflowName:''}</p>{i.steps.map(s=><p key={s.id} className="text-sm">{s.label} · {copy(s.status)}{s.by?' · '+(s.byName??user(s.by)):''}{s.when?' · '+onboardingTimestamp(s.when):''}</p>)}</div>)}{!r.items.some(i=>i.steps.length)&&<p className="onb-muted">{copy('No items on this requisition need approval.')}</p>}</section>
 <section className="onb-panel space-y-3"><h2>{copy('Items')}</h2>{r.items.map(i=><div key={i.id} className="border-t border-border pt-3"><h3 className={i.removed||i.approval==='rejected'?'line-through text-muted-foreground':''}>{i.name}</h3><p className="onb-muted">{copy(i.removed?'Removed':i.approval==='withdrawn'?'Withdrawn':i.approval==='pending'?'Awaiting approval':i.approval==='rejected'?'Rejected':i.state)}</p>{i.reason&&<p className="text-sm">{i.reason}</p>}</div>)}</section>
 <section className="onb-panel space-y-3"><h2>{copy('Notes')}</h2>{r.hrNote&&<><h3>{copy('People GBS note')}</h3><p className="whitespace-pre-wrap text-sm">{r.hrNote}</p></>}{detail.notes.filter(n=>n.context==='requisition'&&!n.deleted&&n.at>=r.createdAt&&(!r.cancelledAt||n.at<=r.cancelledAt)).map(n=><div key={n.id}><strong>{n.name}</strong><span className="onb-cell-sub">{onboardingTimestamp(n.at)}</span><p className="whitespace-pre-wrap text-sm">{n.body}</p></div>)}</section>
 <section className="onb-panel"><h2>{copy('Day 1 handover')}</h2><p className="onb-muted">{r.handedAt?copy('Handover recorded')+' · '+onboardingTimestamp(r.handedAt):copy(r.cancelledAt?'Cancelled':'Handover pending')}</p></section></div>
 <aside className="onb-aside"><section className="onb-panel space-y-3"><h2>{copy('From the onboarding case')}</h2><p>{f.fullName} · {c.number}</p><Link className="text-primary underline" href={'/lifecycle/requisitions/onboarding/'+c.id}>{copy('View current requisition')}</Link>{detail.actor.module&&<Link className="block text-primary underline" href={'/lifecycle/onboarding/cases/'+c.id}>{copy('View onboarding case')}</Link>}</section><section className="onb-panel space-y-3"><h2>{copy('Activity')}</h2><div className="onb-activity space-y-3">{activity.map(h=><div key={h.id}><p>{h.action.replaceAll('.',' ').replaceAll('_',' ')}{h.detail?' · '+h.detail:''}</p><span className="onb-cell-sub">{h.name} · {onboardingTimestamp(h.at)}</span></div>)}</div></section></aside></div></div>;
}
