'use client';
import { useOnboardingCopy } from '@/lib/onboarding-copy';
import { useState } from 'react';
import { useLocale } from 'next-intl';
import Link from 'next/link';
import { Field, PageHeader, inputCls } from '@/components/ui';
import { OnboardingBadge, OnboardingBreadcrumb } from '@/components/onboarding-workspace';
import { onboardingDate } from '@/lib/onboarding-presentation';
import type { onboardingRequisitions } from '@/packs/lifecycle/service';
type Rows = Awaited<ReturnType<typeof onboardingRequisitions>>;
const statuses = { submitted: 'Submitted', awaiting_approval: 'Awaiting approval', in_progress: 'In progress', ready: 'Ready for Day 1', completed: 'Completed', cancelled: 'Cancelled' };
export function RequisitionsView({ rows }: { rows: Rows }) {
  const copy=useOnboardingCopy(),locale=useLocale();
  const [query,setQuery]=useState(''),[status,setStatus]=useState('');
  const filtered=rows.filter(r=>(!status||r.status===status)&&(r.joiner+' '+r.number+' '+r.caseNumber).toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a,b)=>(a.joinDate||'9999').localeCompare(b.joinDate||'9999')||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  return <div className="onb-workspace space-y-5"><OnboardingBreadcrumb root="Requisitions" items={[{label:'All requisitions'}]}/><PageHeader title={copy('All requisitions')} description={copy('IT requisitions created from submitted onboarding cases.')}/>
    <div className="onb-filter-panel"><Field label={copy('Search joiner or ticket')}><input type="search" value={query} onChange={e=>setQuery(e.target.value)} className={inputCls}/></Field><Field label={copy('Status')}><select value={status} onChange={e=>setStatus(e.target.value)} className={inputCls}><option value="">{copy('All statuses')}</option>{Object.entries(statuses).map(([id,name])=><option key={id} value={id}>{copy(name)}</option>)}</select></Field></div>
    <div className="onb-table-wrap"><table className="onb-table" aria-label={copy('IT requisitions')}><thead><tr>{['IT requisition ID','Onboarding case ID','New joiner','Join date','Status','Items','Approvals'].map(x=><th key={x}>{copy(x)}</th>)}</tr></thead><tbody>{!filtered.length&&<tr><td colSpan={7}>{copy('No requisitions match. Submitting an onboarding case creates its requisition.')}</td></tr>}{filtered.map(r=><tr key={r.id}><td><Link className="onb-name whitespace-nowrap" href={'/lifecycle/requisitions/onboarding/'+r.caseId+(r.current?'':'?generation='+r.id)}>{r.number}</Link>{!r.current&&<span className="onb-cell-sub">{copy('Previous generation')}</span>}</td><td className="whitespace-nowrap">{r.caseNumber}</td><td>{r.joiner}</td><td className="whitespace-nowrap">{onboardingDate(r.joinDate,locale)}</td><td><OnboardingBadge tone={r.status==='completed'||r.status==='ready'?'success':r.status==='awaiting_approval'?'warning':r.status==='cancelled'?'danger':r.status==='in_progress'?'primary':'neutral'}>{copy(statuses[r.status])}</OnboardingBadge></td><td className="whitespace-nowrap">{r.ready} {copy('of')} {r.total} {copy('ready')}</td><td>{r.pending?r.pending+' '+copy('awaiting approval'):r.unreadNote?<OnboardingBadge tone="warning">{copy('Unread HR note')}</OnboardingBadge>:'—'}</td></tr>)}</tbody></table></div>
  </div>;
}
