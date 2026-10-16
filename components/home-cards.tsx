'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from './ui/button';
import { ConfirmSubmit } from './ui/confirm-submit';
import { loadHomeCardAction, dismissHomeInsightAction, acknowledgeHomeNoticeAction, saveHomeSettingsAction } from '@/app/home/actions';
import { HOME_CARDS, homeDates, type HomeCalendarEntry, type HomeMoment } from '@/lib/home-model';
import { HR_LOCAL_TZ } from '@/lib/hr-date';
type Card = typeof HOME_CARDS[number];
type Success = Extract<Awaited<ReturnType<typeof loadHomeCardAction>>, {
    ok: true;
}>;
type Data<K extends Card> = Extract<Success, {
    kind: K;
}>['data'];
export function refreshHome() { window.dispatchEvent(new Event('home-refresh')); }
export function useHomeCard<K extends Card>(card: K, employmentId: string, from?: string, to?: string) {
    const binding = JSON.stringify([card, employmentId, from, to]);
    const [stored, setStored] = useState<{
        binding: string;
        value: Data<K>;
    } | null>(null), [loading, setLoading] = useState(true), [failed, setFailed] = useState(false), generation = useRef(0);
    const refresh = useCallback(() => { const stamp = ++generation.current; setLoading(true); setFailed(false); const timer = setTimeout(() => { if (stamp === generation.current) {
        generation.current++;
        setLoading(false);
        setFailed(true);
        setStored(null);
    } }, 15000); void loadHomeCardAction({ card, employmentId, ...(from ? { from } : {}), ...(to ? { to } : {}) }).then(result => { if (stamp !== generation.current)
        return; if (result?.ok && result.kind === card)
        setStored({ binding, value: result.data as Data<K> });
    else {
        setStored(null);
        setFailed(true);
    } setLoading(false); }).catch(() => { if (stamp === generation.current) {
        setStored(null);
        setFailed(true);
        setLoading(false);
    } }).finally(() => clearTimeout(timer)); }, [card, employmentId, from, to, binding]);
    useEffect(() => { refresh(); const sync = () => refresh(); window.addEventListener('home-refresh', sync); window.addEventListener('focus', sync); const poll = setInterval(sync, 60000); return () => { generation.current++; clearInterval(poll); window.removeEventListener('home-refresh', sync); window.removeEventListener('focus', sync); }; }, [refresh]);
    return { data: stored?.binding === binding ? stored.value : null, loading, failed, refresh };
}
function Frame({ title, id, state, children }: {
    title: string;
    id?: string;
    state: {
        loading: boolean;
        failed: boolean;
        refresh: () => void;
    };
    children: ReactNode;
}) { const t = useTranslations('home'); return <section id={id} aria-busy={state.loading} className="min-w-0 rounded-xl border border-border bg-card p-5 sm:p-6"><div className="mb-4 flex items-start justify-between gap-3"><h2 className="text-lg font-semibold tracking-tight">{title}</h2><Button type="button" variant="ghost" className="min-h-11 -mt-2 text-xs" disabled={state.loading} onClick={state.refresh}>{t('refresh')}</Button></div>{state.failed ? <div className="space-y-3"><p role="alert" className="text-sm text-muted-foreground">{t('loadFailed')}</p><Button type="button" variant="outline" className="min-h-11" onClick={state.refresh}>{t('retry')}</Button></div> : state.loading && !children ? <p role="status" className="min-h-20 animate-pulse text-sm text-muted-foreground">{t('loading')}</p> : children}</section>; }
export function HomeGreeting({ employmentId, name }: {
    employmentId: string;
    name: string;
}) { const t = useTranslations('home'), state = useHomeCard('greeting', employmentId), [hour, setHour] = useState<number | null>(null); useEffect(() => { if (!state.data) {
    setHour(null);
    return;
} const start = Date.parse(state.data.serverNow), anchor = performance.now(); const update = () => setHour(Number(new Intl.DateTimeFormat('en-GB', { timeZone: HR_LOCAL_TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(start + performance.now() - anchor)))); update(); const timer = setInterval(update, 60000); return () => clearInterval(timer); }, [state.data?.serverNow]); const key = state.data?.kind ?? (hour === null ? 'hello' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'); return <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t(`greeting.${key}`, { name: state.data?.name ?? name })}</h1>; }
export function HomeBrief({ employmentId }: {
    employmentId: string;
}) {
    const t = useTranslations('home'), state = useHomeCard('brief', employmentId), [failure, setFailure] = useState(false);
    async function dismiss(key: string, date: string) { try {
        const result = await dismissHomeInsightAction({ employmentId, key, date });
        if (!result.ok)
            setFailure(true);
        else
            state.refresh();
    }
    catch {
        setFailure(true);
    } }
    return <Frame title={t('brief')} state={state}>{state.data && <div className="space-y-3">{state.data.insights.length ? state.data.insights.map(insight => <div key={insight.key} className="rounded-lg border border-border p-3"><p className="text-sm leading-relaxed">{insight.kind === 'tasks' ? t('insightTasks', { count: insight.count ?? 0 }) : insight.kind === 'payslip' ? t('insightPayslip') : t('insightLeave', { date: insight.date ?? '', name: insight.name ?? '' })}</p><div className="mt-2 flex flex-wrap items-center justify-between gap-2"><Link className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4" href={insight.href}>{t('review')}</Link><Button variant="ghost" className="min-h-11 text-xs" onClick={() => dismiss(insight.key, state.data!.date)}>{t('dismiss')}</Button></div><p className="text-xs text-muted-foreground">{t(`source.${insight.source}`, { date: state.data!.date })}</p></div>) : <p className="text-sm text-muted-foreground">{t('calm')}</p>}{state.data.truncated && <p className="text-xs text-muted-foreground">{t('partial')}</p>}{failure && <p role="alert" className="text-sm text-destructive">{t('saveFailed')}</p>}</div>}</Frame>;
}
export function HomeDay({ employmentId }: {
    employmentId: string;
}) {
    const t = useTranslations('home'), clock = useTranslations('attendance.clock'), format = useFormatter(), state = useHomeCard('day', employmentId), [now, setNow] = useState<number | null>(null);
    useEffect(() => { if (!state.data) {
        setNow(null);
        return;
    } const recorded = Date.parse(state.data.serverNow), anchor = performance.now(), tick = () => setNow(recorded + performance.now() - anchor); tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer); }, [state.data?.serverNow]);
    const data = state.data, seconds = data?.workedSeconds == null ? null : data.workedSeconds + (data.clockedIn && now !== null ? Math.max(0, Math.floor((now - Date.parse(data.serverNow)) / 1000)) : 0);
    return <Frame title={t('day')} state={state}>{data && <div className="space-y-4"><p className="text-3xl font-medium tabular-nums">{now === null ? '—' : format.dateTime(new Date(now), { timeStyle: 'short', timeZone: HR_LOCAL_TZ })}</p><p className="text-sm">{data.shift?.code ?? t('scheduleUnavailable')} · {data.shift?.start ?? '—'} – {data.shift?.end ?? '—'}</p><p className="text-sm text-muted-foreground">{data.locationName ?? t('locationUnavailable')}</p>{data.dayOff ? <p className="rounded-md bg-muted p-3 text-sm">{t(data.dayOff === 'leave' ? 'onLeave' : 'onHoliday')}</p> : data.clockAvailable ? <><p className="text-sm">{data.clockedIn ? t('clockedIn', { time: data.openSince ? format.dateTime(new Date(data.openSince), { timeStyle: 'short', timeZone: HR_LOCAL_TZ }) : '—' }) : t('notClockedIn')}</p>{seconds !== null && <p className="text-sm tabular-nums">{t('worked', { hours: Math.floor(seconds / 3600), minutes: Math.floor(seconds / 60) % 60 })}</p>}<Link className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground" href={'/attendance/clock?employmentId=' + encodeURIComponent(employmentId)}>{clock(data.clockedIn ? 'clockOut' : 'clockIn')}</Link><p className="text-xs text-muted-foreground">{t('clockChecks')}</p><Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href="/attendance/request-status">{t('correction')}</Link></> : <p className="text-sm text-muted-foreground">{t('clockUnavailable')}</p>}{data.wfhEnabled && <Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href={'/home/settings?employmentId=' + encodeURIComponent(employmentId) + '#home-working'}>{t('workingHome')}</Link>}</div>}</Frame>;
}
export function HomeTasks({ employmentId }: {
    employmentId: string;
}) { const t = useTranslations('home'), task = useTranslations('notifications.task'), state = useHomeCard('tasks', employmentId); return <Frame id="home-tasks" title={t('tasks')} state={state}>{state.data && <div className="space-y-3">{state.data.items.length ? <ul className="divide-y divide-border">{state.data.items.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="text-sm font-medium">{item.kind === 'wfh' ? t('wfhRequest') : item.kind === 'feedback' ? t('feedbackRequest') : task(item.kind)}</p>{item.label && <p className="text-xs text-muted-foreground">{item.label}</p>}{item.dueOn && <p className="text-xs">{item.dueOn < state.data!.date ? t('overdue', { date: item.dueOn }) : t('due', { date: item.dueOn })}</p>}</div><Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href={item.href}>{t('review')}</Link></li>)}</ul> : <p className="text-sm text-muted-foreground">{t('noTasks')}</p>}{state.data.truncated && <p className="text-xs text-muted-foreground">{t('partial')}</p>}<p className="text-xs text-muted-foreground">{t('noEffort')}</p></div>}</Frame>; }
export function HomeTimeOff({ employmentId }: {
    employmentId: string;
}) { const t = useTranslations('home'), format = useFormatter(), state = useHomeCard('leave', employmentId); return <Frame title={t('timeOff')} state={state}>{state.data && <div className="space-y-4">{state.data.balances.length ? <dl className="grid grid-cols-2 gap-4">{state.data.balances.slice(0, 4).map(balance => <div key={balance.id}><dt className="text-sm text-muted-foreground">{balance.name}</dt><dd className="text-2xl font-semibold tabular-nums">{format.number(balance.available, { maximumFractionDigits: 2 })}</dd><dd className="text-xs text-muted-foreground">{t('pendingDays', { count: balance.pending })}</dd></div>)}</dl> : <p className="text-sm text-muted-foreground">{t('noBalances')}</p>}{state.data.next ? <p className="text-sm">{t('nextLeave', { name: state.data.next.name, date: state.data.next.date })}</p> : <p className="text-sm text-muted-foreground">{t(state.data.truncated?'partial':'noNextLeave')}</p>}<Link className="inline-flex min-h-11 items-center rounded-md border border-input px-3 text-sm hover:bg-accent" href={'/leave?apply=1&employmentId='+encodeURIComponent(employmentId)}>{t('planLeave')}</Link></div>}</Frame>; }
export function HomeNotices({ employmentId }: {
    employmentId: string;
}) { const t = useTranslations('home'), n = useTranslations('homeNotice'), format = useFormatter(), state = useHomeCard('notices', employmentId); return <Frame title={t('notices')} state={state}>{state.data && <div className="space-y-3">{state.data.items.length ? <ul className="divide-y divide-border">{state.data.items.map(item => <li key={item.id} className="space-y-2 py-3"><div className="flex flex-wrap gap-2 text-xs">{item.pinned && <span>{n('pinned')}</span>}<span>{n(`categories.${item.category}`)}</span>{item.unread && <span>{t('unread')}</span>}{item.requiresAcknowledgement && <span>{n(item.acknowledgedAt ? 'ackDone' : 'requiresAck')}</span>}</div><Link className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline" href={'/notices/' + item.id + '?employmentId=' + encodeURIComponent(employmentId)}>{item.title}</Link><p className="text-sm text-muted-foreground">{item.summary}</p><p className="text-xs text-muted-foreground">{item.sender ?? t('senderUnavailable')}{item.publishedAt && ' · ' + format.dateTime(new Date(item.publishedAt), { dateStyle: 'medium', timeZone: HR_LOCAL_TZ })}</p></li>)}</ul> : <p className="text-sm text-muted-foreground">{t('noNotices')}</p>}<Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href={'/notices?employmentId='+encodeURIComponent(employmentId)}>{t('allNotices')}</Link>{state.data.truncated && <p className="text-xs text-muted-foreground">{t('partial')}</p>}</div>}</Frame>; }
export function HomeAround({ employmentId }: {
    employmentId: string;
}) { const t = useTranslations('home'), state = useHomeCard('around', employmentId); return <Frame title={t('around')} state={state}>{state.data && <div className="space-y-3">{state.data.items.length ? <ul className="space-y-3">{state.data.items.map(item => <li key={item.employmentId} className="text-sm">{t(`availability.${item.status}`, { name: item.name })}</li>)}</ul> : <p className="text-sm text-muted-foreground">{t('privateEmpty')}</p>}<Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href={'/home/settings?employmentId=' + encodeURIComponent(employmentId)}>{t('sharing')}</Link>{state.data.truncated && <p className="text-xs text-muted-foreground">{t('partial')}</p>}</div>}</Frame>; }
export function HomeMoments({ employmentId }: {
    employmentId: string;
}) {
    const t = useTranslations('home'), state = useHomeCard('moments', employmentId), [selected, setSelected] = useState<HomeMoment | null>(null), [message, setMessage] = useState(''), [pending, setPending] = useState(false), [result, setResult] = useState<'sent' | 'failed' | null>(null), request = useRef<string | null>(null);
    async function send() { if (!selected || pending)
        return; setPending(true); request.current ??= crypto.randomUUID(); try {
        const saved = await saveHomeSettingsAction('greeting', { employmentId, recipientEmploymentId: selected.employmentId, requestId: request.current, kind: selected.kind, date: selected.date, message });
        if (saved.ok) {
            setResult('sent');
            setSelected(null);
            request.current = null;
            refreshHome();
        }
        else
            setResult('failed');
    }
    catch {
        setResult('failed');
    }
    finally {
        setPending(false);
    } }
    return <Frame title={t('moments')} state={state}>{state.data && <div className="space-y-3">{state.data.items.length ? <ul className="space-y-3">{state.data.items.map(item => <li key={item.employmentId + item.kind + item.date} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{t(`moment.${item.kind}`, { name: item.name, date: item.date })}</span><Button variant="outline" className="min-h-11" onClick={() => { setSelected(item); setMessage(t(`greetingText.${item.kind}`, { name: item.name })); request.current = null; setResult(null); }}>{t('sayHi')}</Button></li>)}</ul> : <p className="text-sm text-muted-foreground">{t('noMoments')}</p>}{!!state.data.greetings.items.length && <ul className="space-y-3 border-t border-border pt-3">{state.data.greetings.items.map(greeting => <li key={greeting.id} className="rounded-md bg-muted p-3 text-sm"><p className="font-medium">{greeting.sender} · {greeting.date}</p><p className="mt-2 whitespace-pre-wrap break-words">{greeting.message}</p></li>)}</ul>}{result && <p role={result === 'failed' ? 'alert' : 'status'} className="text-sm">{t(result === 'sent' ? 'greetingSent' : 'saveFailed')}</p>}<Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href={'/home/settings?employmentId=' + encodeURIComponent(employmentId)}>{t('sharing')}</Link></div>}<Dialog.Root open={!!selected} onOpenChange={open => { if (!open && !pending)
        setSelected(null); }}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/40"/><Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-6 shadow-lg"><Dialog.Title className="text-lg font-semibold">{t('previewGreeting')}</Dialog.Title><Dialog.Description className="mt-2 text-sm text-muted-foreground">{selected?.name} · {selected?.date}</Dialog.Description><form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); void send(); }}><label className="block text-sm">{t('message')}<textarea className="mt-2 min-h-28 w-full rounded-md border border-input bg-background p-3" value={message} onChange={event => { if (request.current)
        return; setMessage(event.target.value); }} maxLength={500} required disabled={pending || !!request.current}/></label><div className="flex flex-wrap justify-end gap-2"><Dialog.Close asChild><Button type="button" variant="outline" className="min-h-11" disabled={pending}>{t('cancel')}</Button></Dialog.Close><ConfirmSubmit className="min-h-11" title={t('sendGreeting')} description={t('greetingHelp')} confirmLabel={t('sendGreeting')} disabled={pending || !message.trim()}>{t('sendGreeting')}</ConfirmSubmit></div>{result === 'failed' && <p role="alert" className="text-sm text-destructive">{t('saveFailed')}</p>}</form></Dialog.Content></Dialog.Portal></Dialog.Root></Frame>;
}
