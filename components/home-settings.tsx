'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import {useRouter} from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from './ui/button';
import { ConfirmSubmit } from './ui/confirm-submit';
import { loadHomeSettingsAction, saveHomeSettingsAction } from '@/app/home/actions';
import { registerUnsavedGuard } from '@/lib/unsaved-changes';
import { refreshHome } from './home-cards';
type View = Extract<Awaited<ReturnType<typeof loadHomeSettingsAction>>, {
    ok: true;
}>;
const fields = ['wfhEnabled', 'wfhApprovalRequired', 'availabilityEnabled', 'birthdaysEnabled', 'anniversariesEnabled'] as const;
export function HomeSettings({ employmentId, today, initialDate }: {
    employmentId?: string;
    today: string;
    initialDate?: string;
}) {
    const a=useTranslations('assistantConversation'),router=useRouter(),[leaveOpen,setLeaveOpen]=useState(false),continuation=useRef<(()=>void)|null>(null);
    const t = useTranslations('homeSettings'), [view, setView] = useState<View | null>(null), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), generation = useRef(0), dirty = useRef(new Set<string>()), request = useRef<{
        requestId: string;
        policyId: string;
        from: string;
        to: string;
    } | null>(null);
    const load = useCallback(() => { const stamp = ++generation.current; setFailed(false); void loadHomeSettingsAction(employmentId).then(result => { if (stamp !== generation.current)
        return; if (result.ok)
        setView(result);
    else {
        setView(null);
        setFailed(true);
    } }).catch(() => { if (stamp === generation.current) {
        setView(null);
        setFailed(true);
    } }); }, [employmentId]);
    useEffect(() => { load(); return () => { generation.current++; }; }, [load]);
    const prompt=useCallback((proceed:()=>void)=>{continuation.current=proceed;setLeaveOpen(true);},[]);
    useEffect(()=>registerUnsavedGuard({isDirty:()=>dirty.current.size>0,prompt}),[prompt]);
    useEffect(()=>{
      const unload=(event:BeforeUnloadEvent)=>{if(dirty.current.size){event.preventDefault();event.returnValue='';}};
      const click=(event:MouseEvent)=>{
       if(!dirty.current.size||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;
       const anchor=event.target instanceof Element?event.target.closest('a'):null;
       if(!anchor||anchor.hasAttribute('download')||anchor.target==='_blank'||anchor.closest('[data-unsaved-guard="ignore"]'))return;
       const url=new URL(anchor.href,window.location.href);
       if(url.origin!==window.location.origin||url.pathname===window.location.pathname&&url.search===window.location.search)return;
       event.preventDefault();event.stopImmediatePropagation();prompt(()=>router.push(url.pathname+url.search+url.hash));
      };
      window.addEventListener('beforeunload',unload);document.addEventListener('click',click,true);
      return()=>{window.removeEventListener('beforeunload',unload);document.removeEventListener('click',click,true);};
    },[prompt,router]);
    async function save(kind: 'sharing' | 'policy' | 'wfh' | 'decision', input: unknown) { if (busy)
        return; const stamp = generation.current; setBusy(true); setNotice(''); try {
        const result = await saveHomeSettingsAction(kind, input);
        if (stamp !== generation.current)
            return;
        if (result.ok) {
            const next = await loadHomeSettingsAction(employmentId);
            if (stamp !== generation.current)
                return;
            if (!next.ok) {
                setNotice(t('savedRefreshFailed'));
                return;
            }
            const companyId = kind === 'policy' ? (input as {
                companyId: string;
            }).companyId : null;
            dirty.current.delete(kind === 'policy' ? 'policy:' + companyId : kind);
            request.current = null;
            setNotice(t('saved'));
            setView(previous => previous ? { ...previous, preferences: kind === 'sharing' ? next.preferences : previous.preferences, requests: kind === 'wfh' || kind === 'decision' ? next.requests : previous.requests, decisions: kind === 'decision' ? next.decisions : previous.decisions, companies: kind === 'policy' ? previous.companies.map(company => company.id === companyId ? next.companies.find(fresh => fresh.id === companyId) ?? company : company) : previous.companies } : next);
            refreshHome();
        }
        else {
            if(kind==='wfh'&&result.code!=='unavailable')request.current=null;
            setNotice(t('failed'));
        }
    }
    catch {
        if (stamp === generation.current)
            setNotice(t('failed'));
    }
    finally {
        if (stamp === generation.current)
            setBusy(false);
    } }
    const check = (fd: FormData, key: string) => fd.get(key) === 'on';
    if (failed)
        return <section className="space-y-3"><p role="alert">{t('loadFailed')}</p><Button className="min-h-11" onClick={load}>{t('retry')}</Button></section>;
    if (!view)
        return <p role="status">{t('loading')}</p>;
    return <><div className="space-y-6">{notice && <p role="status" className="rounded-md border border-border p-3 text-sm">{notice}</p>}{view.preferences && employmentId && <section className="rounded-xl border border-border bg-card p-5"><h2 className="text-lg font-semibold">{t('sharing')}</h2><p className="mt-2 text-sm text-muted-foreground">{t('privateHelp')}</p><form key={'sharing' + view.preferences.sharing.revision} className="mt-4 space-y-3" onChange={() => { dirty.current.add('sharing'); }} onSubmit={event => { event.preventDefault(); const fd = new FormData(event.currentTarget); void save('sharing', { employmentId, expectedRevision: view.preferences!.sharing.revision, availability: check(fd, 'availability'), birthday: check(fd, 'birthday'), anniversary: check(fd, 'anniversary'), weekStartsOn: Number(fd.get('weekStartsOn')) }); }}>{(['availability', 'birthday', 'anniversary'] as const).map(key => <label key={key} className="flex min-h-11 items-center gap-3"><input type="checkbox" name={key} defaultChecked={view.preferences!.sharing[key]} disabled={busy}/>{t(key)}</label>)}<label className="block text-sm">{t('weekStarts')}<select name="weekStartsOn" className="mt-1 min-h-11 rounded-md border border-input bg-background px-3" defaultValue={view.preferences.sharing.weekStartsOn} disabled={busy}><option value={1}>{t('monday')}</option><option value={0}>{t('sunday')}</option></select></label><Button type="submit" className="min-h-11" disabled={busy}>{t('save')}</Button></form></section>}
 {view.preferences && employmentId && <section id="home-working" className="rounded-xl border border-border bg-card p-5"><h2 className="text-lg font-semibold">{t('homeWorking')}</h2><p className="mt-2 text-sm text-muted-foreground">{t('clockUnchanged')}</p>{view.preferences.policy?.wfhEnabled ? <form className="mt-4 space-y-3" onChange={() => { if (!request.current)
        dirty.current.add('wfh'); }} onSubmit={event => { event.preventDefault(); const fd = new FormData(event.currentTarget); request.current ??= { requestId: crypto.randomUUID(), policyId: view.preferences!.policy!.id, from: String(fd.get('from')), to: String(fd.get('to')) }; void save('wfh', { employmentId, ...request.current }); }}><p className="text-sm">{t(view.preferences.policy.wfhApprovalRequired ? 'approvalRequired' : 'effectiveOnRequest')}</p><div className="flex flex-wrap gap-3"><label className="text-sm">{t('from')}<input type="date" name="from" required min={today} defaultValue={initialDate ?? today} disabled={busy || !!request.current} className="mt-1 block min-h-11 rounded-md border border-input bg-background px-3"/></label><label className="text-sm">{t('to')}<input type="date" name="to" required min={today} defaultValue={initialDate ?? today} disabled={busy || !!request.current} className="mt-1 block min-h-11 rounded-md border border-input bg-background px-3"/></label></div><ConfirmSubmit className="min-h-11" title={t('submitRequest')} description={t('requestHelp')} confirmLabel={t('submitRequest')} disabled={busy}>{t('submitRequest')}</ConfirmSubmit></form> : <p className="mt-3 text-sm text-muted-foreground">{t('disabled')}</p>}<ul className="mt-4 divide-y divide-border">{view.requests?.items.map(row => <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"><span>{row.from} – {row.to} · {t(`status.${row.status}`)}</span>{(row.status === 'pending' || row.status === 'approved' && row.from > today) && <form onSubmit={event => { event.preventDefault(); void save('decision', { id: row.id, expectedRevision: row.revision, decision: 'cancelled' }); }}><ConfirmSubmit variant="outline" className="min-h-11" title={t('cancelRequest')} description={t('cancelHelp')} confirmLabel={t('cancelRequest')} disabled={busy}>{t('cancelRequest')}</ConfirmSubmit></form>}</li>)}</ul></section>}
 {!!view.decisions.items.length && <section className="rounded-xl border border-border bg-card p-5"><h2 className="text-lg font-semibold">{t('decisions')}</h2><ul className="divide-y divide-border">{view.decisions.items.map(row => <li key={row.id} className="space-y-3 py-3"><p className="text-sm font-medium">{row.employeeCode} · {row.name}</p><p className="text-sm">{row.from} – {row.to}</p><div className="flex gap-2">{(['approved', 'rejected'] as const).map(decision => <form key={decision} onSubmit={event => { event.preventDefault(); void save('decision', { id: row.id, expectedRevision: row.revision, decision }); }}><ConfirmSubmit variant="outline" className="min-h-11" title={t(`decision.${decision}`)} description={t('decisionHelp')} confirmLabel={t(`decision.${decision}`)} disabled={busy}>{t(`decision.${decision}`)}</ConfirmSubmit></form>)}</div></li>)}</ul></section>}
 {!!view.companies.length && <section className="space-y-4 rounded-xl border border-border bg-card p-5"><h2 className="text-lg font-semibold">{t('companyPolicies')}</h2><p className="text-sm text-muted-foreground">{t('policyHelp')}</p>{view.companies.map(company => <form key={company.id + ':' + (company.policy?.revision ?? 0)} className="rounded-md border border-border p-4" onChange={() => { dirty.current.add('policy:' + company.id); }} onSubmit={event => { event.preventDefault(); const fd = new FormData(event.currentTarget); void save('policy', { companyId: company.id, expectedRevision: company.policy?.revision ?? 0, ...Object.fromEntries(fields.map(key => [key, check(fd, key)])) }); }}><h3 className="font-medium">{company.name}</h3>{fields.map(key => <label key={key} className="flex min-h-11 items-center gap-3"><input type="checkbox" name={key} defaultChecked={company.policy?.[key] ?? key === 'wfhApprovalRequired'} disabled={busy}/>{t(key)}</label>)}<ConfirmSubmit className="mt-3 min-h-11" title={t('savePolicy')} description={t('policyConfirm')} confirmLabel={t('savePolicy')} disabled={busy}>{t('savePolicy')}</ConfirmSubmit></form>)}</section>}</div><AlertDialog.Root open={leaveOpen} onOpenChange={setLeaveOpen}><AlertDialog.Portal><AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40"/><AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-6 shadow-lg"><AlertDialog.Title className="font-semibold">{t('discard')}</AlertDialog.Title><div className="mt-5 flex flex-wrap justify-end gap-2"><AlertDialog.Cancel asChild><Button className="min-h-11" variant="outline">{a('keepEditing')}</Button></AlertDialog.Cancel><AlertDialog.Action asChild><Button className="min-h-11" onClick={()=>{dirty.current.clear();const run=continuation.current;continuation.current=null;run?.();}}>{a('discardContinue')}</Button></AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root></>;
}
