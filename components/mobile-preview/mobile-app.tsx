'use client';

import { useRef, useState, useTransition, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowUpRight, BatteryFull, Check, Clock, Files, Home, Inbox, Moon, RefreshCw, Signal, Sun, UserRound, Users, Wifi } from 'lucide-react';
import { formatDays } from '@/lib/day-format';
import type { MobilePreviewData, PreviewLeave, PreviewRead } from './types';
import styles from './mobile-preview.module.css';

type Tab = 'home' | 'clock' | 'requests' | 'inbox' | 'me' | 'leave' | 'team';

/** Live Monolith presentation. Commands open their existing guarded workflow. No simulated writes. */
export function MobileApp({ data }: { data: MobilePreviewData }) {
  const t = useTranslations('mobilePreview');
  const lt = useTranslations('me.leaveBalanceTable');
  const nt = useTranslations('notifications');
  const ct = useTranslations('claims');
  const locale = useLocale();
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [tab, setTab] = useState<Tab>('home');
  const [appearance, setAppearance] = useState<'light' | 'dark'>('dark');
  const [control, setControl] = useState<'punch' | 'rail'>('punch');
  const [motion, setMotion] = useState(true);
  const [large, setLarge] = useState(false);
  const [day, setDay] = useState(data.today);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const go = (next: Tab) => { setTab(next); setSelectedId(null); bodyRef.current?.scrollTo(0, 0); };
  const date = (iso: string, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) =>
    new Intl.DateTimeFormat(locale, { ...options, timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(`${iso}T00:00:00+08:00`));
  const time = (iso: string) => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(iso));
  const selected = data.leave.status === 'ready' ? data.leave.data.find(c => c.id === selectedId) : null;
  const firstName = data.person.name?.split(/\s+/)[0];
  const initials = data.person.name?.split(/\s+/).slice(0, 2).map(n => n[0]).join('') || '?';
  const readyInbox = data.inbox.status === 'ready' ? data.inbox.data : [];
  const away = data.team.status === 'ready' ? data.team.data.filter(p => p.dates.some(d => d.date === day)) : [];
  const approved = away.filter(p => p.dates.some(d => d.date === day && d.status === 'approved'));
  const pending = away.filter(p => p.dates.some(d => d.date === day && d.status === 'pending'));
  const nav = [
    { id: 'home', icon: Home, label: t('live.home') },
    ...(data.clock.status !== 'disabled' ? [{ id: 'clock', icon: Clock, label: t('live.clock') }] : []),
    { id: 'requests', icon: Files, label: t('live.requests') },
    ...(data.inbox.status !== 'disabled' ? [{ id: 'inbox', icon: Inbox, label: t('live.inbox') }] : []),
    { id: 'me', icon: UserRound, label: t('live.me') },
  ];
  const activeTab = tab === 'leave' ? 'requests' : tab === 'team' ? 'home' : tab;
  const safeHref = (href: string | null) => href?.startsWith('/') && !href.startsWith('//') && !/[\\\r\n]/.test(href) ? href : null;
  const heading = (title: string, detail?: string) => <header className={styles.heading}><h2>{title}</h2>{detail && <p>{detail}</p>}</header>;
  const back = (target: Tab) => <button type="button" className={styles.back} onClick={() => go(target)}><ArrowLeft size={16} />{t('back')}</button>;
  const action = (label: string, href: string) => <a className={styles.action} href={href}>{label}<ArrowUpRight size={18} /></a>;
  const row = (title: string, detail: string, href: string, key?: string) => <a key={key} className={styles.row} href={href}><span><strong>{title}</strong><small>{detail}</small></span><ArrowUpRight size={18} /></a>;
  const section = (label: string, children: ReactNode) => <section className={styles.section}><h3>{label}</h3>{children}</section>;
  const empty = (message: string) => <p className={styles.empty}>{message}</p>;
  const state = <T,>(read: PreviewRead<T>, render: (value: T) => ReactNode) => read.status === 'ready' ? render(read.data)
    : empty(t(read.status === 'disabled' ? 'live.notAvailable' : 'live.unavailable'));

  function workday() {
    if (!data.employment) return empty(t('live.notLinked'));
    return state(data.clock, c => {
      const lastIn = c.events.filter(e => e.direction === 'in').at(-1);
      const lastOut = c.events.filter(e => e.direction === 'out').at(-1);
      return <section className={styles.workday} aria-label={t('live.workday')}>
        <div className={styles.workdayTop}><span>{date(c.date, { weekday: 'long', day: 'numeric', month: 'short' })}</span><span>{c.shiftStart?.slice(0, 5) ?? '—'} / {c.shiftEnd?.slice(0, 5) ?? '—'}</span></div>
        <h3>{t(c.clockedIn ? 'live.clockedIn' : c.events.length ? 'live.dayRecorded' : 'live.startDay')}</h3>
        {control === 'punch' ? <div className={styles.punch}>
          <div><span>{t('live.in')}</span><strong>{lastIn ? lastIn.time : '—'}</strong><small>{lastIn ? t('live.recorded') : t('live.noEvent')}</small></div>
          <div><span>{t('live.out')}</span><strong>{lastOut ? lastOut.time : '—'}</strong><small>{lastOut ? t('live.recorded') : t('live.noEvent')}</small></div>
        </div> : <div className={styles.rail}><Clock size={26} /><span>{lastIn ? lastIn.time : t('live.noEvent')}</span><ArrowUpRight size={24} /></div>}
        <a className={styles.clockAction} href="/attendance/clock"><span>{t(c.clockedIn ? 'live.clockOut' : 'live.openClock')}</span><ArrowUpRight size={23} /></a>
        <p className={styles.workdayNote}>{t('live.clockWorkflow')}</p>
      </section>;
    });
  }

  function leaveBank() {
    return <>{back('requests')}{heading(t('live.leaveBank'), t('live.allTypes'))}
      {state(data.leave, cards => cards.length ? <div className={styles.bank}>
        {cards.map(c => <button key={c.id} type="button" className={styles.balance} onClick={() => { setSelectedId(c.id); bodyRef.current?.scrollTo(0, 0); }}>
          <span className={styles.balanceName}>{c.name}<ArrowUpRight size={16} /></span>
          <strong className={styles.balanceValue}>{c.takenOnly ? formatDays(c.taken) : formatDays(c.available)}</strong>
          <small>{t(c.takenOnly ? 'live.taken' : 'live.available')}</small>
          {c.sharedWith.length > 0 && <p>{t('live.shared', { types: c.sharedWith.join(', ') })}</p>}
        </button>)}
      </div> : empty(t('live.noLeave')))}<p className={styles.footnote}>{t('live.balanceNote')}</p></>;
  }
  function leaveDetail(c: PreviewLeave) {
    return <><button type="button" className={styles.back} onClick={() => setSelectedId(null)}><ArrowLeft size={16} />{t('back')}</button>
      {heading(c.name, `${date(c.cycleStart)} – ${date(c.cycleEnd, { day: 'numeric', month: 'short', year: 'numeric' })}`)}
      <div className={styles.leaveFocus}><strong>{formatDays(c.takenOnly ? c.taken : c.available)}</strong><span>{t(c.takenOnly ? 'live.taken' : 'live.available')}</span></div>
      {c.sharedWith.length > 0 && <p className={styles.footnote}>{t('live.shared', { types: c.sharedWith.join(', ') })}</p>}
      {[[t('live.balance'), c.balance], [t('live.pending'), c.pending], [t('live.taken'), c.taken]].map(([label, value]) => <div className={styles.kv} key={String(label)}><span>{label}</span><strong>{formatDays(value)}</strong></div>)}
      {c.notice && <p className={styles.footnote}>{lt(c.notice)}</p>}
      <p className={styles.footnote}>{t('live.balanceNote')}</p>{c.canRequest && action(t('live.requestLeave'), `/leave?apply=1&applyType=${encodeURIComponent(c.id)}`)}</>;
  }
  function team() {
    return <>{back('home')}{heading(t('live.whosAway'), t('live.teamScope'))}<div className={styles.dates} role="group" aria-label={t('live.chooseDay')}>
      {Array.from({ length: 7 }, (_, n) => new Date(Date.parse(`${data.today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)).map(d => <button type="button" key={d} aria-pressed={day === d} onClick={() => setDay(d)}><span>{date(d, { weekday: 'short' })}</span><strong>{date(d, { day: 'numeric' })}</strong></button>)}
      </div>{state(data.team, () => <><div className={styles.teamBand}><Users size={24} /><strong>{t('live.awayCount', { count: approved.length })}</strong><span>{t('live.pendingCount', { count: pending.length })}</span></div>
      {away.length ? away.map(p => <div className={styles.person} key={p.employmentId}><span className={styles.avatar}>{p.name.split(/\s+/).slice(0, 2).map(n => n[0]).join('')}</span><div><strong>{p.name}</strong>{p.dates.filter(d => d.date === day).map((d, i) => <small key={`${d.status}:${d.session}:${i}`}>{t(d.status === 'approved' ? 'leave.historyStatus.approved' : 'leave.historyStatus.pending')} · {d.session === 'full_day' ? t('live.fullDay') : d.session === 'hourly' ? t('live.hourly') : d.session}</small>)}</div></div>) : empty(t('live.noAway'))}</>)}
      {action(t('live.openTeam'), '/manage/my-team')}
    </>;
  }

  let content: ReactNode;
  switch (tab) {
    case 'home': content = <>{heading(firstName ? t('live.greeting', { name: firstName }) : t('live.home'))}{workday()}
      {section(t('live.needsYou'), state(data.tasks, tasks => tasks.length ? <>{tasks.slice(0, 4).map(task => row(task.subject ?? nt(`task.${task.kind}`), nt(`task.${task.kind}`), safeHref(task.href) ?? '/approvals', task.id))}{tasks.length > 4 && row(t('live.allTasks'), String(tasks.length), '/approvals')}</> : empty(t('live.allClear'))))}
      {data.leave.status !== 'disabled' && <button type="button" className={styles.leaveDoor} onClick={() => go('leave')}><span><small>{t('live.allTypes')}</small><strong>{t('live.planLeave')}</strong></span><ArrowUpRight size={23} /></button>}
      {data.team.status !== 'disabled' && <button type="button" className={styles.teamDoor} onClick={() => go('team')}><Users size={24} /><span>{t('live.whosAway')}<small>{t('live.nextSeven')}</small></span><ArrowUpRight size={20} /></button>}
      </>; break;
    case 'clock': content = <>{heading(t('live.workday'))}{workday()}{section(t('live.eventRecord'), state(data.clock, c => c.events.length ? c.events.map((e, i) => <div className={styles.event} key={`${e.direction}:${e.time}:${i}`}><Check size={16} /><span>{t(e.direction === 'in' ? 'live.in' : 'live.out')}</span><strong>{e.time}</strong></div>) : empty(t('live.noEvent'))))}{row(t('feature.attendance'), t('live.openSystem'), '/attendance/my-records')}</>; break;
    case 'requests': content = <>{heading(t('live.requests'))}{data.leave.status !== 'disabled' && <button type="button" className={styles.leaveDoor} onClick={() => go('leave')}><span><small>{t('live.allTypes')}</small><strong>{t('live.requestLeave')}</strong></span><ArrowUpRight size={23} /></button>}
      {section(t('leave.history'), state(data.requests, r => r.items.length ? <>{r.items.map(item => row(item.type, `${date(item.from)} – ${date(item.to)} · ${item.partial && item.status === 'approved' ? t('live.partiallyApproved') : t(`leave.historyStatus.${item.status}`)}`, data.leaveHistoryHref, item.id))}{row(t('live.viewAll'), t('live.records', { count: r.total }), data.leaveHistoryHref)}</> : empty(t('live.noRequests'))))}
      {data.claims.status !== 'disabled' && section(t('feature.claim'), state(data.claims, claims => <>{claims.map(c => row(c.type, `${date(c.date)} · ${new Intl.NumberFormat(locale, { style: 'currency', currency: 'MYR' }).format(Number(c.amount))} · ${ct(`status_${c.status}`)}`, '/claims', c.id))}{row(t('feature.claim'), t('live.openSystem'), '/claims')}</>))}
      {data.tasks.status === 'ready' && data.tasks.data.length > 0 && section(t('live.needsYou'), data.tasks.data.map(task => row(task.subject ?? nt(`task.${task.kind}`), nt(`task.${task.kind}`), safeHref(task.href) ?? '/approvals', task.id)))}
      </>; break;
    case 'leave': content = selected ? leaveDetail(selected) : leaveBank(); break;
    case 'team': content = team(); break;
    case 'inbox': content = <>{heading(t('live.inbox'))}{state(data.inbox, () => readyInbox.length ? readyInbox.map(n => <article key={n.id} className={styles.update}><span className={styles.updateMeta}>{t(n.read ? 'live.opened' : 'live.unread')} · {new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(n.createdAt))}</span><h3>{n.title}</h3><p>{n.body}</p>{safeHref(n.href) && <a href={safeHref(n.href)!}>{t('live.openRecord')}<ArrowUpRight size={16} /></a>}</article>) : empty(t('live.noUpdates')))}<p className={styles.footnote}>{t('live.inboxNote')}</p></>; break;
    case 'me': content = <>{heading(t('live.yourSpace'))}<section className={styles.identity}><span className={styles.monogram}>{initials}</span><h3>{data.person.name ?? t('live.account')}</h3><p>{data.person.employeeCode ?? t('live.notLinked')}</p><p>{data.employment?.position}</p><small>{data.employment?.company}</small></section>
      {data.employment && row(t('live.employment'), [data.employment.department, data.employment.company].filter(Boolean).join(' · '), '/me')}
      {section(t('live.documents'), state(data.payslips, slips => slips.length ? slips.map(p => row(p.period, p.company, `/me/payslip/${p.id}`, p.id)) : empty(t('live.noDocuments'))))}
      <label className={styles.preference}><span>{t('live.motion')}</span><input type="checkbox" checked={motion} onChange={e => setMotion(e.target.checked)} /></label>
      <label className={styles.preference}><span>{t('live.largerText')}</span><input type="checkbox" checked={large} onChange={e => setLarge(e.target.checked)} /></label>
      </>; break;
  }
  return <div className={styles.preview} data-appearance={appearance} data-motion={motion} data-large={large}>
    <div className={styles.toolbar}>
      <div><strong>Monolith Flow</strong><span>{t('live.liveData')}</span></div>
      <div className={styles.theme} role="group" aria-label={t('live.appearance')}>
        <button type="button" aria-pressed={appearance === 'light'} aria-label={t('live.light')} onClick={() => setAppearance('light')}><Sun size={16} /></button>
        <button type="button" aria-pressed={appearance === 'dark'} aria-label={t('live.dark')} onClick={() => setAppearance('dark')}><Moon size={16} /></button>
      </div>
      <button type="button" className={styles.refresh} disabled={refreshing} onClick={() => startRefresh(() => router.refresh())} aria-label={t('live.refresh')}><RefreshCw size={16} className={refreshing ? styles.spinning : undefined} /></button>
    </div>
    <div className={styles.controlPicker}><label htmlFor="mobile-clock-control">{t('live.clockLayout')}</label><select id="mobile-clock-control" value={control} onChange={e => setControl(e.target.value as 'punch' | 'rail')}><option value="punch">{t('live.punchCard')}</option><option value="rail">{t('live.timeRail')}</option></select></div>
    <div className={styles.phone} aria-label={t('title')} aria-busy={refreshing}>
      <div className={styles.status} aria-hidden="true"><span>{time(data.loadedAt)}</span><span><Signal size={13} /><Wifi size={13} /><BatteryFull size={17} /></span></div>
      <div className={styles.context}><span>AIHR<span className={styles.mark}>.</span></span><span>{data.employment?.company ?? t('live.account')}</span></div>
      <div ref={bodyRef} className={styles.body}><div key={`${tab}:${selectedId ?? ''}`} className={styles.scene}>{content}</div></div>
      <nav className={styles.nav} aria-label={t('live.navigation')}>
        {nav.map(n => <button key={n.id} type="button" onClick={() => go(n.id as Tab)} aria-current={activeTab === n.id ? 'page' : undefined}><n.icon size={20} /><span>{n.label}</span></button>)}
      </nav><div className={styles.homebar} aria-hidden="true" />
    </div><p className={styles.caption} role="status">{refreshing ? t('live.refreshing') : t('live.updated', { time: time(data.loadedAt) })}</p>
  </div>;
}
