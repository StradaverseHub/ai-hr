'use client';

import { useEffect, useRef, useState, useTransition, type CSSProperties, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowUpRight, BatteryFull, Check, ChevronDown, Clock, Files, Home, Inbox, Moon, RefreshCw, Signal, Sun, UserRound, Users, Wifi } from 'lucide-react';
import { DEFAULT_MOBILE_DESIGN, mobilePalette, type MobileDesign, type MobileBlock } from '@/lib/mobile-design';
import { formatDays } from '@/lib/day-format';
import type { MobilePreviewData, PreviewLeave, PreviewRead } from './types';
import styles from './mobile-preview.module.css';
import { ClockCard } from './clock-card';
import { useMobileClock } from './use-mobile-clock';

export type Tab = 'home' | 'clock' | 'requests' | 'inbox' | 'me' | 'leave' | 'team' | (string & {});

/** Live Monolith Flow. Clock gestures use Web Clocking; other commands open their guarded workflow. */
export function MobileApp({ data, design = DEFAULT_MOBILE_DESIGN, designOnly = false, embedded = false, previewAppearance, initialTab = 'home', onNavigate, onSelectBlock, selectedBlock }: { data: MobilePreviewData; design?: MobileDesign; designOnly?: boolean; embedded?: boolean; previewAppearance?: 'light' | 'dark'; initialTab?: Tab; onNavigate?: (tab: Tab) => void; onSelectBlock?: (id: string) => void; selectedBlock?: string | null }) {
  const t = useTranslations('mobilePreview');
  const lt = useTranslations('me.leaveBalanceTable');
  const nt = useTranslations('notifications');
  const ct = useTranslations('claims');
  const locale = useLocale();
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [appearance, setAppearance] = useState<'light' | 'dark'>(design.appearance === 'light' ? 'light' : 'dark');
  const [control, setControl] = useState<'flow' | 'punch' | 'rail'>(design.clockLayout);
  const [motion, setMotion] = useState<boolean | null>(null);
  useEffect(() => { if (design.appearance !== 'system') return; const q = matchMedia('(prefers-color-scheme: dark)'); const change = () => setAppearance(q.matches ? 'dark' : 'light'); change(); q.addEventListener('change', change); return () => q.removeEventListener('change', change); }, [design.appearance]);
  const shownAppearance = previewAppearance ?? appearance;
  const [large, setLarge] = useState(false);
  const [day, setDay] = useState(data.today);
  const [expandedPerson, setExpandedPerson] = useState<string | null>(null);
  const [requestView, setRequestView] = useState<'mine' | 'tasks'>('mine');
  const capture = useMobileClock(() => startRefresh(() => router.refresh()));
  const captureLocked = capture.active && !['success', 'error'].includes(capture.phase);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const go = (next: Tab) => { if (captureLocked) return; setTab(next); onNavigate?.(next); setSelectedId(null); bodyRef.current?.scrollTo(0, 0); };
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
    return state(data.clock, c => <ClockCard clock={c} company={data.employment!.company} layout={embedded ? design.clockLayout : control} designOnly={designOnly}
      capture={capture} onHistory={() => go('clock')} showBothActions={tab === 'clock'} />);
  }
  const taskRows = data.tasks.status === 'ready' ? data.tasks.data.map(task => <a key={task.id} className={styles.taskRow} href={safeHref(task.href) ?? '/approvals'}>
    <span className={styles.taskIcon}><Files size={18} /></span><span><strong>{task.subject ?? nt(`task.${task.kind}`)}</strong><small>{nt(`task.${task.kind}`)}</small></span><ArrowUpRight size={17} />
  </a>) : null;
  function teamPeek() {
    if (data.team.status === 'disabled') return null;
    const people = [...approved, ...pending.filter(p => !approved.some(a => a.employmentId === p.employmentId))];
    return <section className={styles.teamPeek}><div><p>{date(day, { weekday: 'long', day: 'numeric', month: 'short' })}</p><h3>{t('live.whosAway')}</h3></div>
      <button type="button" className={styles.teamOpen} onClick={() => go('team')} aria-label={t('live.whosAway')}>
        {people.slice(0, 3).map(p => <span key={p.employmentId} data-pending={!approved.some(a => a.employmentId === p.employmentId)}>{p.name.split(/\s+/).slice(0, 2).map(n => n[0]).join('')}</span>)}
        {!people.length && <Users size={22} />}<ArrowUpRight size={17} />
      </button><p className={styles.teamPeekCopy}>{data.team.status === 'ready' ? `${t('live.awayCount', { count: approved.length })} · ${t('live.pendingCount', { count: pending.length })}` : t('live.unavailable')}</p>
    </section>;
  }

  function leaveBank(navigateBack = true) {
    return <>{navigateBack && back('home')}<div className={styles.bankHeading}>{heading(t('live.leaveBank'), t('live.allTypes'))}{data.leave.status === 'ready' && <span>{data.leave.data.length}</span>}</div>
      {state(data.leave, cards => cards.length ? <div className={styles.bank} data-layout={design.leaveLayout}>
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
      {away.length ? away.map(p => <div className={styles.person} key={p.employmentId} data-pending={!approved.some(a => a.employmentId === p.employmentId)}>
        <button type="button" className={styles.personToggle} aria-expanded={expandedPerson === p.employmentId} aria-controls={`away-${p.employmentId}`} onClick={() => setExpandedPerson(expandedPerson === p.employmentId ? null : p.employmentId)}>
          <span className={styles.avatar}>{p.name.split(/\s+/).slice(0, 2).map(n => n[0]).join('')}</span><span><strong>{p.name}</strong>{p.dates.filter(d => d.date === day).map((d, i) => <small key={`${d.status}:${d.session}:${i}`}>{t(d.status === 'approved' ? 'leave.historyStatus.approved' : 'leave.historyStatus.pending')} · {d.session === 'full_day' ? t('live.fullDay') : d.session === 'hourly' ? t('live.hourly') : d.session}</small>)}</span><ChevronDown size={17} />
        </button><div id={`away-${p.employmentId}`} hidden={expandedPerson !== p.employmentId} className={styles.personDetail}>
          {p.dates.map((d, i) => <p key={`${d.date}:${d.status}:${i}`}><span>{date(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}</span><strong>{t(d.status === 'approved' ? 'leave.historyStatus.approved' : 'leave.historyStatus.pending')} · {d.session === 'full_day' ? t('live.fullDay') : d.session === 'hourly' ? t('live.hourly') : d.session}</strong></p>)}
        </div></div>) : empty(t('live.noAway'))}</>)}
      {action(t('live.openTeam'), '/manage/my-team')}
    </>;
  }

  const composition = design.schemaVersion === 2 ? design.composition : null;
  const palette = mobilePalette(design, shownAppearance);
  const page = composition?.pages.find(p => p.id === tab);
  function widget(block: MobileBlock): ReactNode {
    switch (block.kind) {
      case 'welcome': return heading(block.title || (firstName ? t('live.greeting', { name: firstName }) : t('live.home')), block.body || undefined);
      case 'clock': return workday();
      case 'leave': return block.detail === 'compact' ? data.leave.status !== 'disabled' && <button type="button" className={styles.leaveDoor} onClick={() => go('leave')}><span><small>{t('live.allTypes')}</small><strong>{t('live.planLeave')}</strong></span><ArrowUpRight size={26} /></button> : leaveBank(false);
      case 'team': return teamPeek();
      case 'tasks': return state(data.tasks, tasks => tasks.length ? <>{taskRows?.slice(0, block.detail === 'compact' ? 4 : 20)}</> : empty(t('live.allClear')));
      case 'requests': return state(data.requests, r => r.items.length ? r.items.slice(0, block.detail === 'compact' ? 3 : 20).map(item => row(item.type, `${date(item.from)} – ${date(item.to)} · ${t(`leave.historyStatus.${item.status}`)}`, data.leaveHistoryHref, item.id)) : empty(t('live.noRequests')));
      case 'inbox': return state(data.inbox, items => items.length ? items.slice(0, block.detail === 'compact' ? 3 : 20).map(n => <article key={n.id} className={styles.update}><h3>{n.title}</h3><p>{n.body}</p></article>) : empty(t('live.noUpdates')));
      case 'pay': return state(data.payslips, slips => slips.length ? slips.map(p => row(p.period, p.company, `/me/payslip/${p.id}`, p.id)) : empty(t('live.noDocuments')));
      case 'profile': return <section className={styles.identity}><span className={styles.monogram}>{initials}</span><h3>{data.person.name ?? t('live.account')}</h3><p>{data.person.employeeCode ?? t('live.notLinked')}</p><small>{data.employment?.company}</small></section>;
      case 'text': return <div className={styles.customText}>{block.title && <h3>{block.title}</h3>}{block.body && <p>{block.body}</p>}</div>;
      case 'action': return <button type="button" className={styles.customAction} onClick={() => go(block.target)}>{block.title || composition?.pages.find(p => p.id === block.target)?.title || t(`builder.composer.destination.${['home', 'clock', 'requests', 'inbox', 'me', 'leave', 'team'].includes(block.target) ? block.target : 'home'}`)}<ArrowUpRight size={20} /></button>;
      case 'divider': return <hr className={styles.customDivider} />;
      case 'space': return <div style={{ height: block.size }} aria-hidden="true" />;
    }
  }
  function composed() {
    return <>{page!.title && heading(page!.title)}<div className={styles.composition}>{page!.blocks.map(block => <section key={block.id} className={styles.compositionBlock} data-block-id={block.id} data-block-kind={block.kind} data-home-section={block.kind === 'welcome' ? undefined : block.kind} data-block-width={block.width} data-block-surface={block.surface} data-block-align={block.align} data-selected={selectedBlock === block.id} data-editing={!!onSelectBlock} inert={block.kind !== 'clock' && captureLocked} onClick={() => onSelectBlock?.(block.id)}>
      {onSelectBlock && <button type="button" className={styles.selectBlock} aria-label={t('builder.composer.selectSection', { name: block.title || t(`builder.composer.kind.${block.kind}`) })} onClick={event => { event.stopPropagation(); onSelectBlock(block.id); }}>↗</button>}
      {block.title && !['welcome', 'text', 'action'].includes(block.kind) && <h3 className={styles.blockHeading}>{block.title}</h3>}{widget(block)}
    </section>)}</div></>;
  }
  let content: ReactNode = null;
  switch (tab) {
    case 'home': content = <>{heading(firstName ? t('live.greeting', { name: firstName }) : t('live.home'))}{design.homeOrder.map(id => <div key={id} data-home-section={id} inert={id !== 'clock' && captureLocked}>
      {id === 'clock' ? workday() : id === 'tasks' ? <section className={styles.attention}><div className={styles.sectionTitle}><h3>{t('live.needsYou')}</h3>{data.tasks.status === 'ready' && <span>{data.tasks.data.length}</span>}</div>
        {state(data.tasks, tasks => tasks.length ? <>{taskRows?.slice(0, 4)}{tasks.length > 4 && row(t('live.allTasks'), String(tasks.length), '/approvals')}</> : empty(t('live.allClear')))}</section>
      : id === 'leave' ? data.leave.status !== 'disabled' && <button type="button" className={styles.leaveDoor} onClick={() => go('leave')}><span><small>{t('live.allTypes')}</small><strong>{t('live.planLeave')}</strong></span><ArrowUpRight size={26} /></button>
      : teamPeek()}</div>)}</>; break;
    case 'clock': content = <>{heading(t('live.workday'))}{workday()}<div inert={captureLocked}>{section(t('live.eventRecord'), state(data.clock, c => c.events.length ? c.events.map((e, i) => <div className={styles.event} key={`${e.direction}:${e.time}:${i}`}><Check size={16} /><span>{t(e.direction === 'in' ? 'live.in' : 'live.out')}</span><strong>{e.time}</strong></div>) : empty(t('live.noEvent'))))}{row(t('feature.attendance'), t('live.openSystem'), '/attendance/my-records')}</div></>; break;
    case 'requests': content = <>{heading(t('live.requests'))}{data.tasks.status === 'ready' && data.tasks.data.length > 0 && <div className={styles.segments} role="group" aria-label={t('live.requests')}><button type="button" aria-pressed={requestView === 'mine'} onClick={() => setRequestView('mine')}>{t('gesture.myRequests')}</button><button type="button" aria-pressed={requestView === 'tasks'} onClick={() => setRequestView('tasks')}>{t('live.needsYou')} · {data.tasks.data.length}</button></div>}{requestView === 'tasks' ? taskRows : <>{data.leave.status !== 'disabled' && <button type="button" className={styles.leaveDoor} onClick={() => go('leave')}><span><small>{t('live.allTypes')}</small><strong>{t('live.requestLeave')}</strong></span><ArrowUpRight size={23} /></button>}
      {section(t('leave.history'), state(data.requests, r => r.items.length ? <>{r.items.map(item => row(item.type, `${date(item.from)} – ${date(item.to)} · ${item.partial && item.status === 'approved' ? t('live.partiallyApproved') : t(`leave.historyStatus.${item.status}`)}`, data.leaveHistoryHref, item.id))}{row(t('live.viewAll'), t('live.records', { count: r.total }), data.leaveHistoryHref)}</> : empty(t('live.noRequests'))))}
      {data.claims.status !== 'disabled' && section(t('feature.claim'), state(data.claims, claims => <>{claims.map(c => row(c.type, `${date(c.date)} · ${new Intl.NumberFormat(locale, { style: 'currency', currency: 'MYR' }).format(Number(c.amount))} · ${ct(`status_${c.status}`)}`, '/claims', c.id))}{row(t('feature.claim'), t('live.openSystem'), '/claims')}</>))}
      </>}</>; break;
    case 'leave': content = selected ? leaveDetail(selected) : leaveBank(); break;
    case 'team': content = team(); break;
    case 'inbox': content = <>{heading(t('live.inbox'))}{state(data.inbox, () => readyInbox.length ? readyInbox.map(n => <article key={n.id} className={styles.update}><span className={styles.updateMeta}>{t(n.read ? 'live.opened' : 'live.unread')} · {new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(n.createdAt))}</span><h3>{n.title}</h3><p>{n.body}</p>{safeHref(n.href) && <a href={safeHref(n.href)!}>{t('live.openRecord')}<ArrowUpRight size={16} /></a>}</article>) : empty(t('live.noUpdates')))}<p className={styles.footnote}>{t('live.inboxNote')}</p></>; break;
    case 'me': content = <>{heading(t('live.yourSpace'))}<section className={styles.identity}><span className={styles.monogram}>{initials}</span><h3>{data.person.name ?? t('live.account')}</h3><p>{data.person.employeeCode ?? t('live.notLinked')}</p><p>{data.employment?.position}</p><small>{data.employment?.company}</small></section>
      {data.employment && row(t('live.employment'), [data.employment.department, data.employment.company].filter(Boolean).join(' · '), '/me')}
      {section(t('live.documents'), state(data.payslips, slips => slips.length ? slips.map(p => row(p.period, p.company, `/me/payslip/${p.id}`, p.id)) : empty(t('live.noDocuments'))))}
      <label className={styles.preference}><span>{t('live.motion')}</span><input type="checkbox" checked={motion ?? design.motion === 'standard'} onChange={e => setMotion(e.target.checked)} /></label>
      <label className={styles.preference}><span>{t('live.largerText')}</span><input type="checkbox" checked={large} onChange={e => setLarge(e.target.checked)} /></label>
      </>; break;
  }
  if (page) content = composed();
  const navIcons = { home: Home, clock: Clock, calendar: Files, bell: Inbox, person: UserRound, grid: Files, users: Users, arrow: ArrowUpRight };
  const shownNav = composition ? composition.navigation.items.filter(n => !['clock', 'inbox'].includes(n.target) || nav.some(original => original.id === n.target)).map(n => ({ id: n.target, label: n.label || nav.find(original => original.id === n.target)?.label || composition.pages.find(p => p.id === n.target)?.title || t(n.target === 'team' ? 'live.whosAway' : 'live.requests'), icon: navIcons[n.icon] })) : [nav[0], ...design.navigationOrder.flatMap(id => nav.filter(n => n.id === id)), nav[nav.length - 1]];
  return <div className={styles.preview} data-appearance={shownAppearance} data-motion={motion ?? design.motion === 'standard'} data-large={large} data-corners={design.corners} data-embedded={embedded} data-composed={!!composition} data-navigation={composition?.navigation.style} data-surface={composition?.layout.surface} data-button={composition?.layout.button}
    style={{ '--page': palette.bg, '--pressed': palette.card, '--ink': palette.text, '--muted': palette.muted, '--line': palette.border, '--mark': palette.accent, '--brand-button': palette.button, '--brand-button-ink': palette.onButton, ...(composition ? { '--app-font': composition.typography.family === 'serif' ? 'Georgia, serif' : composition.typography.family === 'mono' ? 'ui-monospace, monospace' : 'var(--font-schibsted), system-ui, sans-serif', '--body-size': `${composition.typography.bodySize}px`, '--heading-size': `${composition.typography.headingSize}px`, '--app-padding': `${composition.layout.padding}px`, '--app-gap': `${composition.layout.gap}px`, '--app-radius': `${composition.layout.radius}px`, '--band': palette.card, '--band-ink': palette.text } : {}) } as CSSProperties}
    onClickCapture={event => { if (designOnly && (event.target as HTMLElement).closest('a')) event.preventDefault(); }}>
    {!embedded && <><div className={styles.toolbar}>
      <div><strong>{design.brandName}</strong><span>{t('live.liveData')}</span></div>
      <div className={styles.theme} role="group" aria-label={t('live.appearance')}>
        <button type="button" aria-pressed={appearance === 'light'} aria-label={t('live.light')} onClick={() => setAppearance('light')}><Sun size={16} /></button>
        <button type="button" aria-pressed={appearance === 'dark'} aria-label={t('live.dark')} onClick={() => setAppearance('dark')}><Moon size={16} /></button>
      </div>
      <button type="button" className={styles.refresh} disabled={refreshing || captureLocked} onClick={() => startRefresh(() => router.refresh())} aria-label={t('live.refresh')}><RefreshCw size={16} className={refreshing ? styles.spinning : undefined} /></button>
    </div>
    <div className={styles.controlPicker}><label htmlFor="mobile-clock-control">{t('live.clockLayout')}</label><select id="mobile-clock-control" disabled={captureLocked} value={control} onChange={e => setControl(e.target.value as 'flow' | 'punch' | 'rail')}><option value="flow">Monolith Flow</option><option value="punch">{t('live.punchCard')}</option><option value="rail">{t('live.timeRail')}</option></select></div>
    </>}<div className={styles.phone} aria-label={t('title')} aria-busy={refreshing}>
      <div className={styles.status} aria-hidden="true"><span>{time(data.loadedAt)}</span><span><Signal size={13} /><Wifi size={13} /><BatteryFull size={17} /></span></div>
      <div className={styles.context}><span className={styles.brand}>{design.logo && <img src={design.logo} alt="" />}{design.brandName}<span className={styles.mark}>.</span></span><span>{data.employment?.company ?? t('live.account')}</span></div>
      <div ref={bodyRef} className={styles.body}><div key={`${tab}:${selectedId ?? ''}`} className={styles.scene}>{content}</div></div>
      <nav className={styles.nav} aria-label={t('live.navigation')}>
        {shownNav.map(n => <button key={n.id} type="button" disabled={captureLocked} onClick={() => go(n.id as Tab)} aria-label={n.label} aria-current={activeTab === n.id ? 'page' : undefined}><n.icon size={20} />{composition?.navigation.labels !== false && <span>{n.label}</span>}</button>)}
      </nav><div className={styles.homebar} aria-hidden="true" />
    </div><p className={styles.caption} role="status">{refreshing ? t('live.refreshing') : t('live.updated', { time: time(data.loadedAt) })}</p>
  </div>;
}
