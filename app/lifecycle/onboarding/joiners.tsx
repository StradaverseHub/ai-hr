'use client';
import { useOnboardingCopy } from '@/lib/onboarding-copy';
import { OnboardingDateInput } from '@/components/onboarding-date-input';
import { OnboardingBadge, OnboardingBreadcrumb, OnboardingProgress } from '@/components/onboarding-workspace';
import { onboardingBreakdown, onboardingDate, onboardingRelative } from '@/lib/onboarding-presentation';
import { onboardingTimestamp } from '@/lib/onboarding-format';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { useLocale } from 'next-intl';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { Button, Field, PageHeader, inputCls } from '@/components/onboarding-ui';
import { type OnboardingConfig, type onboardingList, type onboardingOptions } from '@/packs/lifecycle/service';
import { effectiveFacts, matchChecklist, dayDate, currentReq, validDate, requisitionStatus, visibleRecentJoiner, missingCaseFields } from '@/lib/onboarding-model';
type Options = Awaited<ReturnType<typeof onboardingOptions>>;
export function Joiners({ rows, config, options }: {
    rows: Awaited<ReturnType<typeof onboardingList>>;
    config: OnboardingConfig;
    options: Options;
}) {
    const copy = useOnboardingCopy(), router = useRouter();
    const [query, setQuery] = useState(''), [group, setGroup] = useState(''), [status, setStatus] = useState(''), [state, setState] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState('');
    const today = todayInKualaLumpur();
    const latestSync=rows.reduce((latest,row)=>row.case.syncedAt>latest?row.case.syncedAt:latest,'');
    const rangeBad=validDate(from)&&validDate(to)&&from>to;
    const recent = rows.filter(({case:c})=>visibleRecentJoiner(config,c,today));
    const filtered = recent.filter(({ case: c }) => { const f = effectiveFacts(c); return f.fullName.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (!group || f.businessGroup === group) && (!status || c.personnelStatus === status) && (!state || c.state === state) && (rangeBad || !validDate(from) || f.joinDate >= from) && (rangeBad || !validDate(to) || f.joinDate <= to); }).sort((a,b)=>(effectiveFacts(a.case).joinDate||'9999').localeCompare(effectiveFacts(b.case).joinDate||'9999')||a.case.id.localeCompare(b.case.id));
    const anyFilter = !!(query || group || status || state || from || to);
    const clearFilters = () => { setQuery(''); setGroup(''); setStatus(''); setState(''); setFrom(''); setTo(''); };
    const label = (kind: keyof Options, id: string) => options[kind].find(x => x.id === id)?.name ?? id;
    const locale = useLocale();
    const overdue = (row: typeof rows[number]) => row.case.state !== 'cancelled' && (row.case.tasks.some(t => t.status !== 'done' && t.dueOn < today) || row.case.state === 'pending' && validDate(effectiveFacts(row.case).joinDate) && dayDate(effectiveFacts(row.case).joinDate, -7) < today || config.countEquipment && !!currentReq(row.case) && !currentReq(row.case)?.handedAt && effectiveFacts(row.case).joinDate <= today);
    return <div className="onb-workspace"><OnboardingBreadcrumb root="Onboarding" items={[{label:"New Joiners"}]}/><PageHeader title={copy("New Joiners")} description={copy("Track new joiners synced from Personnel Management and their onboarding progress.")}/>
 <div className="onb-sync"><RefreshCw size={18} strokeWidth={1.7} aria-hidden="true"/><p>{copy("Synced from Personnel Management. A Draft record opens an onboarding case here, pre-filled with what Personnel Management already holds. Complete and submit the case to start the checklist and create the IT requisition.")}</p>{latestSync&&<time dateTime={latestSync}>{copy('Latest Personnel sync')} · {onboardingTimestamp(latestSync)}</time>}</div>
 <div className="onb-filter-panel onb-joiner-filters">
   <Field label={copy("Search")}><input type="search" aria-label={copy("Search by name")} placeholder={copy("Search by name")} value={query} onChange={e => setQuery(e.target.value)} className={inputCls}/></Field>
   <Field label={copy("Business Group")}><select value={group} onChange={e => setGroup(e.target.value)} className={inputCls}><option value="">{copy("All")}</option>{options.businessGroup.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
   <Field label={copy("Status")}><select value={status} onChange={e => setStatus(e.target.value)} className={inputCls}><option value="">{copy("All")}</option><option value="Draft">{copy("Draft")}</option><option value="Active">{copy("Active")}</option></select></Field>
   <Field label={copy("Case")}><select value={state} onChange={e => setState(e.target.value)} className={inputCls}><option value="">{copy("All")}</option><option value="pending">{copy("Pending submission")}</option><option value="submitted">{copy("Submitted")}</option><option value="cancelled">{copy("Cancelled")}</option></select></Field>
   <Field label={copy("Join date from")}><OnboardingDateInput label={copy("Join date from")} value={from} onChange={setFrom}/></Field>
   <Field label={copy("Join date to")}><OnboardingDateInput label={copy("Join date to")} value={to} onChange={setTo}/></Field>
   {anyFilter&&<Button variant="secondary" onClick={clearFilters}>{copy("Clear filters")}</Button>}
   {rangeBad&&<p role="alert" className="onb-filter-error">{copy("Join date to must be on or after Join date from.")}</p>}
 </div>
 <p className="onb-list-summary">{filtered.length} {copy("new joiners")} · {filtered.filter(r=>r.case.state==='pending').length} {copy("pending submission")} · {filtered.filter(r=>{const d=effectiveFacts(r.case).joinDate;return d>=today && d<=dayDate(today,7);}).length} {copy("joining in the next 7 days")} · {filtered.filter(overdue).length} {copy("with overdue tasks")}</p>
 <div className="onb-table-wrap"><table className="onb-table onb-joiners-table" aria-label={copy("New joiners")}><thead><tr>{['Full name','Business Group','Join date','Status','Onboarding case ID','IT requisition ID','Progress (hover for pending step)'].map(x=><th key={x}>{copy(x)}</th>)}</tr></thead><tbody>{!filtered.length && <tr className="onb-empty-row"><td colSpan={7}>{copy("No new joiners match your search or filters.")}</td></tr>}{filtered.map(row=>{const c=row.case,f=effectiveFacts(c),r=currentReq(c),match=matchChecklist(config,c),b=onboardingBreakdown(config,c);const href='/lifecycle/onboarding/cases/'+c.id;return <tr key={c.id} onClick={e=>{if(!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.altKey&&e.target instanceof Element&&!e.target.closest('a,button')&&!window.getSelection()?.toString())router.push(href);}}><td><Link className="onb-name" href={href}>{f.fullName||copy("Name needed")}</Link>{row.isNew && <span className="ml-2"><OnboardingBadge tone="new">{copy("NEW")}</OnboardingBadge></span>}<span className="onb-cell-sub">{label('title',f.title)}</span></td><td>{label('businessGroup',f.businessGroup)||copy("Not supplied")}</td><td className="whitespace-nowrap">{onboardingDate(f.joinDate,locale)}<span className="onb-cell-sub">{validDate(f.joinDate)&&<>{copy(f.joinDate<today?'Joined':'Joins')} {onboardingRelative(f.joinDate,today,locale)}</>}</span></td><td><OnboardingBadge tone={c.personnelStatus==='Active'?'success':'neutral'}>{copy(c.personnelStatus)}</OnboardingBadge></td><td className="whitespace-nowrap">{c.number}</td><td>{r ? <><Link className="onb-name" href={'/lifecycle/requisitions/onboarding/'+c.id}>{r.number}</Link><span className="onb-cell-sub">{copy(requisitionStatus(r)==='ready'?'Ready for Day 1':requisitionStatus(r))}</span></> : <><span>—</span><span className="onb-cell-sub">{copy("Created on submission")}</span></>}</td><td>{c.state==='cancelled'?<><OnboardingBadge tone="danger">{copy("Cancelled")}</OnboardingBadge><span className="onb-cell-sub">{c.cancelReason}</span></>:c.state==='pending'?<div className="onb-pending"><OnboardingBadge tone="warning">{copy('Pending submission')}</OnboardingBadge><span className={'onb-cell-sub '+(missingCaseFields(c).length?'onb-pending-missing':'onb-pending-ready')}>{missingCaseFields(c).length?missingCaseFields(c).length+' '+copy('required fields missing'):!match.checklist?copy('Choose an onboarding checklist before submitting.'):copy('Ready to submit')}</span></div>:<OnboardingProgress name={f.fullName} percent={b.percent} next={b.next.name} due={b.next.due?onboardingDate(b.next.due,locale):''} checklist={c.confirmedChecklist?.name??match.checklist?.name??copy("No checklist")} ticket={copy(b.ticket)} breakdown={copy("Checklist")+' '+b.done+' '+copy("of")+' '+b.total+' · '+copy("Equipment")+(config.countEquipment?'':' ('+copy('not counted')+')')+' '+b.ready+' '+copy("of")+' '+b.active+' '+copy("ready")+' · '+copy(b.handed?'Handed over':'Handover pending')}/>}</td></tr>;})}</tbody></table></div></div>;
}
