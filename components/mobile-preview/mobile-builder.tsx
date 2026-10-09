'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Check, Clock, Files, Home, Inbox, Moon, Save, Send, ShieldCheck, Smartphone, Sun, Undo2, UserRound, Users } from 'lucide-react';
import { changeMobileDesignAction } from '@/app/mobile-preview/actions';
import { DEFAULT_MOBILE_DESIGN, MOBILE_ACCENTS, type MobileBuilderState, type MobileDesign } from '@/lib/mobile-design';
import { MobileApp, type Tab } from './mobile-app';
import type { MobilePreviewData } from './types';
import styles from './mobile-builder.module.css';

/** Editing is always non-mutating for HR records. Only the deliberately selected live mode enables clocking. */
export function MobileBuilder({ initial, data }: { initial: MobileBuilderState; data: MobilePreviewData }) {
  const t = useTranslations('mobilePreview.builder');
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [design, setDesign] = useState(initial.draft);
  const [mode, setMode] = useState<'draft' | 'published'>('draft');
  const [screen, setScreen] = useState<Tab>('home');
  const [appearance, setAppearance] = useState<'light' | 'dark'>(initial.draft.appearance === 'light' ? 'light' : 'dark');
  const [panel, setPanel] = useState<'design' | 'history'>('design');
  const [pending, setPending] = useState(false), locked = useRef(false);
  const [message, setMessage] = useState(''), [error, setError] = useState('');
  const [review, setReview] = useState<{ command: 'publish' | 'rollback'; revision?: number } | null>(null);
  const dirty = JSON.stringify(design) !== JSON.stringify(state.draft);
  const current = state.releases[0];
  const displayed = mode === 'draft' ? design : current?.config ?? DEFAULT_MOBILE_DESIGN;
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => { if (dirty || pending) event.preventDefault(); };
    window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before);
  }, [dirty, pending]);
  function edit<K extends keyof MobileDesign>(key: K, value: MobileDesign[K]) { setDesign(d => ({ ...d, [key]: value })); setMessage(''); setError(''); setReview(null); }
  async function change(command: 'save' | 'publish' | 'rollback', revision?: number) {
    if (locked.current) return;
    locked.current = true; setPending(true); setMessage(''); setError('');
    try {
      const result = await changeMobileDesignAction(command, state.draftRevision, command === 'save' ? design : revision);
      if (!result.ok) { setError(result.error); return; }
      setState(result.state); setDesign(result.state.draft); setReview(null); setMessage(command === 'save' ? 'saved' : command === 'publish' ? 'published' : 'restored');
    } catch { setError('unavailable'); }
    finally { locked.current = false; setPending(false); }
  }
  async function logo(file: File | undefined) {
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 2_000_000) { setError('logoInvalid'); return; }
    if (locked.current) return; locked.current = true; setPending(true);
    const src = URL.createObjectURL(file);
    try {
      const image = new Image(); image.src = src; await image.decode();
      if (image.naturalWidth > 6000 || image.naturalHeight > 6000) throw new Error();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 96;
      const context = canvas.getContext('2d'); if (!context) throw new Error();
      const ratio = Math.min(96 / image.naturalWidth, 96 / image.naturalHeight);
      const w = image.naturalWidth * ratio, h = image.naturalHeight * ratio;
      context.drawImage(image, (96 - w) / 2, (96 - h) / 2, w, h);
      const value = canvas.toDataURL('image/png'); if (value.length > 48000) throw new Error();
      edit('logo', value);
    } catch { setError('logoInvalid'); } finally { URL.revokeObjectURL(src); locked.current = false; setPending(false); }
  }
  function order(key: 'homeOrder' | 'navigationOrder') {
    return <ol className={styles.order}>{design[key].map((id, index) => <li key={id}><span>{t(id)}</span><div>
      {([-1, 1] as const).map(delta => <button type="button" key={delta} disabled={index + delta < 0 || index + delta >= design[key].length} aria-label={t(delta === -1 ? 'moveUp' : 'moveDown', { name: t(id) })} onClick={() => {
        const next = [...design[key]]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; edit(key, next as never);
      }}>{delta === -1 ? <ArrowUp size={15} /> : <ArrowDown size={15} />}</button>)}
    </div></li>)}</ol>;
  }
  const screens = [{ id: 'home', icon: Home }, { id: 'clock', icon: Clock }, { id: 'leave', icon: Files }, { id: 'team', icon: Users }, { id: 'requests', icon: Send }, { id: 'inbox', icon: Inbox }, { id: 'me', icon: UserRound }] as const;
  return <section className={styles.builder} aria-label={t('title')}>
    <header className={styles.header}><div><h1>{t('title')}</h1><p>{t('tenantOnly')}</p></div><div className={styles.actions}>
      <span className={styles.draftState}><span data-dirty={dirty} />{dirty ? t('unsaved') : t('draftSaved')}</span>
      <button type="button" disabled={pending || !dirty || mode !== 'draft'} onClick={() => void change('save')}><Save size={16} />{t(pending ? 'working' : 'save')}</button>
      <button type="button" className={styles.primary} disabled={pending || dirty || mode !== 'draft' || Boolean(current && JSON.stringify(current.config) === JSON.stringify(state.draft))} onClick={() => setReview({ command: 'publish' })}><Send size={16} />{t('publish')}</button>
    </div></header>
    {(message || error) && <div className={styles.notice} data-error={!!error} role={error ? 'alert' : 'status'}>{t(error || message)}{['conflict', 'unavailable'].includes(error) && <button type="button" onClick={() => { if (!dirty || window.confirm(t('discard'))) router.refresh(); }}>{t('reload')}</button>}</div>}
    {review && <div className={styles.publishReview}><div><h2>{t(review.command === 'publish' ? 'publishReview' : 'rollbackReview')}</h2><p>{t(review.command === 'publish' ? 'publishHelp' : 'rollbackHelp', { revision: review.revision ?? 0 })}</p></div><button type="button" disabled={pending} onClick={() => setReview(null)}>{t('cancel')}</button><button type="button" className={styles.primary} disabled={pending} onClick={() => void change(review.command, review.revision)}>{t(review.command === 'publish' ? 'confirmPublish' : 'confirmRollback')}</button></div>}
    <div className={styles.workspace}>
      <aside className={styles.navigator}><h2>{t('screens')}</h2><nav aria-label={t('screens')}>{screens.map(item => <button type="button" key={item.id} aria-label={t(item.id)} aria-current={screen === item.id ? 'page' : undefined} onClick={() => setScreen(item.id)}><item.icon size={17} /><span>{t(item.id)}</span></button>)}</nav>
        <div className={styles.boundary}><ShieldCheck size={20} /><p>{t('protected')}</p></div>
      </aside>
      <div className={styles.stage}>
        <div className={styles.stageToolbar}><div role="group" aria-label={t('previewMode')} className={styles.segments}>{(['draft', 'published'] as const).map(value => <button type="button" key={value} aria-pressed={mode === value} disabled={pending} onClick={() => { setMode(value); setReview(null); }}>{t(value === 'published' ? 'publishedView' : value)}</button>)}<button type="button" disabled={pending || dirty} onClick={() => window.location.assign('/mobile-preview?live=1')}>{t('live')}</button></div>
          <div className={styles.appearance} role="group" aria-label={t('appearance')}>{(['light', 'dark'] as const).map(value => <button type="button" key={value} disabled={pending} aria-pressed={appearance === value} aria-label={t(value)} onClick={() => setAppearance(value)}>{value === 'light' ? <Sun size={16} /> : <Moon size={16} />}</button>)}</div>
        </div>
        <p className={styles.stageNote}>{mode === 'draft' ? t('previewOnly') : current ? t('publishedVersion', { revision: current.revision }) : t('defaultVersion')}</p>
        <div className={styles.phoneStage}><MobileApp key={`${mode}:${screen}`} data={data} design={displayed} designOnly embedded previewAppearance={appearance} initialTab={screen} onNavigate={setScreen} /></div>
        <p className={styles.stageFooter}><Smartphone size={15} />{t('sharedApp')}</p>
      </div>
      <aside className={styles.inspector}><div className={styles.inspectorTabs} role="group" aria-label={t('inspector')}>{(['design', 'history'] as const).map(value => <button type="button" key={value} aria-pressed={panel === value} onClick={() => setPanel(value)}>{t(value)}</button>)}</div>
        {panel === 'design' ? <fieldset disabled={pending || mode !== 'draft'}>
          <section><h2>{t('branding')}</h2><label>{t('brandName')}<input value={design.brandName} maxLength={32} onChange={e => edit('brandName', e.target.value)} /></label>
            <label>{t('logo')}<input type="file" accept="image/png,image/jpeg" onChange={e => void logo(e.target.files?.[0])} /></label>{design.logo && <button type="button" className={styles.textButton} onClick={() => edit('logo', null)}>{t('removeLogo')}</button>}
            <span className={styles.label}>{t('accent')}</span><div className={styles.swatches} role="group" aria-label={t('accent')}>{(Object.keys(MOBILE_ACCENTS) as MobileDesign['accent'][]).map(value => <button type="button" key={value} aria-pressed={design.accent === value} aria-label={t(value)} style={{ background: MOBILE_ACCENTS[value].button }} onClick={() => edit('accent', value)}>{design.accent === value && <Check size={17} />}</button>)}</div>
          </section>
          <section><h2>{t('appearance')}</h2>{(['appearance', 'clockLayout', 'leaveLayout', 'corners', 'motion'] as const).map(key => <label key={key}>{t(key)}<select value={design[key]} onChange={e => edit(key, e.target.value as never)}>{({ appearance: ['dark', 'light', 'system'], clockLayout: ['flow', 'punch', 'rail'], leaveLayout: ['ledger', 'list'], corners: ['crisp', 'soft'], motion: ['standard', 'reduced'] }[key]).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>)}</section>
          <section><h2>{t('homeOrder')}</h2>{order('homeOrder')}</section>
          <section><h2>{t('navigationOrder')}</h2><p className={styles.help}>{t('navigationHelp')}</p>{order('navigationOrder')}</section>
          <button type="button" className={styles.textButton} onClick={() => { setDesign(structuredClone(DEFAULT_MOBILE_DESIGN)); setReview(null); }}>{t('reset')}</button>
        </fieldset> : <div className={styles.history}><p className={styles.help}>{t('historyHelp')}</p>{!state.releases.length && <p>{t('noReleases')}</p>}{state.releases.map((release, index) => <article key={release.revision}><div><strong>{t('version', { revision: release.revision })}</strong>{index === 0 && <span>{t('current')}</span>}</div><time dateTime={release.publishedAt}>{new Date(release.publishedAt).toLocaleString()}</time><p>{release.config.brandName} · {t(release.config.clockLayout)}</p>{index > 0 && <button type="button" disabled={pending || dirty} onClick={() => setReview({ command: 'rollback', revision: release.revision })}><Undo2 size={15} />{t('restore')}</button>}</article>)}</div>}
      </aside>
    </div>
  </section>;
}
