'use client';
import { useOnboardingCopy } from '@/lib/onboarding-copy';
import { useState } from 'react';
import Link from 'next/link';
import { Button, Card, Field, PageHeader, inputCls, tableWrapCls, theadCls, tbodyCls, thCls } from '@/components/ui';
import type { onboardingRequisitions } from '@/packs/lifecycle/service';
type Rows = Awaited<ReturnType<typeof onboardingRequisitions>>;
const statuses = { submitted: 'Submitted', awaiting_approval: 'Awaiting approval', in_progress: 'In progress', ready: 'Ready for Day 1', completed: 'Completed', cancelled: 'Cancelled' };
export function RequisitionsView({ rows }: {
    rows: Rows;
}) {
    const copy = useOnboardingCopy();
    const [query, setQuery] = useState(''), [status, setStatus] = useState('');
    const filtered = rows.filter(r => (!status || r.status === status) && (r.joiner + ' ' + r.number).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    return <div className="space-y-5"><PageHeader title={copy("Requisitions")} description={copy("Equipment and access preparation, approvals and Day 1 handover.")} actions={<Link href="/tasks"><Button variant="outline">{copy("My tasks")}</Button></Link>}/><div className="grid gap-3 sm:grid-cols-2"><Field label={copy("Search joiner or ticket")}><input value={query} onChange={e => setQuery(e.target.value)} className={inputCls}/></Field><Field label={copy("Status")}><select value={status} onChange={e => setStatus(e.target.value)} className={inputCls}><option value="">{copy("All statuses")}</option>{Object.entries(statuses).map(([id, name]) => <option key={id} value={id}>{copy(name)}</option>)}</select></Field></div><Card className={tableWrapCls}><table className="w-full text-sm"><thead className={theadCls}><tr>{[copy("Ticket"), copy("Joiner"), copy("Join date"), copy("Status"), copy("Readiness"), copy("Approvals"), copy("People GBS note")].map(label => <th key={label} className={thCls}>{copy(label)}</th>)}</tr></thead><tbody className={tbodyCls}>{!filtered.length && <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">{copy("No requisitions match. Submitting an onboarding case creates its requisition.")}</td></tr>}{filtered.map(r => <tr key={r.id}><td className="px-3 py-3"><Link className="text-primary hover:underline" href={'/lifecycle/requisitions/onboarding/' + r.caseId + (r.current ? '' : '?generation=' + r.id)}>{r.number}</Link></td><td className="px-3 py-3">{r.joiner}</td><td className="px-3 py-3 tabular-nums">{r.joinDate.split('-').reverse().join('/')}</td><td className="px-3 py-3">{copy(statuses[r.status])}</td><td className="px-3 py-3">{r.ready} {copy(" of ")}{r.active} {copy(" ready")}</td><td className="px-3 py-3">{r.pending} {copy(" pending")}</td><td className="px-3 py-3">{r.unreadNote ? copy("Unread HR note") : copy("—")}</td></tr>)}</tbody></table></Card></div>;
}
