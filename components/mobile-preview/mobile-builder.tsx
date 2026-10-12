'use client';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Clock, Files, Home, Inbox, Moon, Save, Send, ShieldCheck, Smartphone, Sun, Undo2, UserRound, Users } from 'lucide-react';
import { changeMobileDesignAction } from '@/app/mobile-preview/actions';
import { UNSAVED_GUARD_IGNORE_SELECTOR } from '@/lib/unsaved-changes';
import { DEFAULT_MOBILE_DESIGN, MOBILE_ACCENTS, type MobileBuilderState, composeMobileDesign, parseMobileDesign, type MobileDesignV2 } from '@/lib/mobile-design';
import { CompositionNavigator, CompositionInspector, StyleControls } from './composer-controls';
import { MobileApp, type Tab } from './mobile-app';
import type { MobilePreviewData } from './types';
import styles from './mobile-builder.module.css';

/** Editing is always non-mutating for HR records. Only the deliberately selected live mode enables clocking. */
export function MobileBuilder({ initial, data }: { initial: MobileBuilderState; data: MobilePreviewData }) {
  const t = useTranslations('mobilePreview.builder');
  const [state, setState] = useState(initial);
  const [history, setHistory] = useState<{ past: MobileDesignV2[]; present: MobileDesignV2; future: MobileDesignV2[] }>({ past: [], present: composeMobileDesign(initial.draft), future: [] });
  const design = history.present;
  function setDesign(value: MobileDesignV2 | ((d: MobileDesignV2) => MobileDesignV2)) { setReview(null); setMessage(''); setError(''); setHistory(h => { const next = typeof value === 'function' ? value(h.present) : value; if (JSON.stringify(next) === JSON.stringify(h.present)) return h; return { past: [...h.past.slice(-39), h.present], present: next, future: [] }; }); }
  function undo() { setReview(null); setHistory(h => h.past.length ? { past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future] } : h); }
  function redo() { setReview(null); setHistory(h => h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h); }
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const navigate = (id: Tab) => { setScreen(id); setSelectedBlock(null); };
  let valid = true; try { parseMobileDesign(design); } catch { valid = false; }
  const [mode, setMode] = useState<'draft' | 'published'>('draft');
  const [screen, setScreen] = useState<Tab>('home');
  const [appearance, setAppearance] = useState<'light' | 'dark'>(initial.draft.appearance === 'light' ? 'light' : 'dark');
  const [panel, setPanel] = useState<'design' | 'section' | 'history'>('design');
  const [pending, setPending] = useState(false), locked = useRef(false), discarding = useRef(false);
  const [message, setMessage] = useState(''), [error, setError] = useState('');
  const [review, setReview] = useState<{ command: 'publish' | 'rollback'; revision?: number } | null>(null);
  const dirty = JSON.stringify(design) !== JSON.stringify(composeMobileDesign(state.draft));
  const current = state.releases[0];
  const displayed = mode === 'draft' ? design : current?.config ?? DEFAULT_MOBILE_DESIGN;
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => { if (!discarding.current && (dirty || pending)) { event.preventDefault(); event.returnValue = ''; } };
    const leave = (event: MouseEvent) => {
      if (!dirty || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download') || anchor.closest('[data-mobile-builder]') || anchor.closest(UNSAVED_GUARD_IGNORE_SELECTOR)) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      event.preventDefault(); event.stopPropagation();
      if (window.confirm(t('discard'))) { discarding.current = true; window.location.assign(url.href); }
    };
    window.addEventListener('beforeunload', before); document.addEventListener('click', leave, true);
    return () => { window.removeEventListener('beforeunload', before); document.removeEventListener('click', leave, true); };
  }, [dirty, pending, t]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (pending || mode !== 'draft' || !(event.metaKey || event.ctrlKey) || event.altKey || !['z', 'y'].includes(event.key.toLowerCase()) || (event.target as Element | null)?.closest('input,textarea,select,[contenteditable=true]')) return;
      event.preventDefault();
      if (event.shiftKey || event.key.toLowerCase() === 'y') redo(); else undo();
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [pending, mode]);
  function edit<K extends keyof MobileDesignV2>(key: K, value: MobileDesignV2[K]) { setDesign(d => { const next = { ...d, [key]: value }; if (key === 'accent') { const colors = MOBILE_ACCENTS[value as MobileDesignV2['accent']]; next.composition = { ...d.composition, themes: { light: { ...d.composition.themes.light, accent: colors.light, button: colors.button, onButton: colors.onButton }, dark: { ...d.composition.themes.dark, accent: colors.dark, button: colors.button, onButton: colors.onButton } } }; } return next; }); setMessage(''); setError(''); setReview(null); }
  async function change(command: 'save' | 'publish' | 'rollback', revision?: number) {
    if (locked.current) return;
    locked.current = true; setPending(true); setMessage(''); setError('');
    try {
      const result = await changeMobileDesignAction(command, state.draftRevision, command === 'save' ? design : revision);
      if (!result.ok) { setError(result.error); return; }
      setState(result.state); setDesign(composeMobileDesign(result.state.draft)); setReview(null); setMessage(command === 'save' ? 'saved' : command === 'publish' ? 'published' : 'restored');
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
  const screens = [{ id: 'home', icon: Home }, { id: 'clock', icon: Clock }, { id: 'leave', icon: Files }, { id: 'team', icon: Users }, { id: 'requests', icon: Send }, { id: 'inbox', icon: Inbox }, { id: 'me', icon: UserRound }] as const;
  return <section data-mobile-builder className={styles.builder} aria-label={t('title')}>
    <header className={styles.header}><div><h1>{t('title')}</h1><p><strong>{state.tenantName}</strong> · {t('tenantOnly')}</p></div><div data-tour="mobile-publication" className={styles.actions}>
      <button type="button" disabled={pending || mode !== 'draft' || !history.past.length} onClick={undo}>{t('composer.undo')}</button><button type="button" disabled={pending || mode !== 'draft' || !history.future.length} onClick={redo}>{t('composer.redo')}</button>
      <span className={styles.draftState}><span data-dirty={dirty} />{dirty ? t('unsaved') : t('draftSaved')}</span>
      <button type="button" disabled={pending || !dirty || !valid || mode !== 'draft'} onClick={() => void change('save')}><Save size={16} />{t(pending ? 'working' : 'save')}</button>
      <button type="button" className={styles.primary} disabled={pending || dirty || mode !== 'draft' || Boolean(current && JSON.stringify(current.config) === JSON.stringify(state.draft))} onClick={() => setReview({ command: 'publish' })}><Send size={16} />{t('publish')}</button>
    </div></header>
    {!valid && <p className={styles.notice} role="alert">{t('composer.validation')}</p>}
    {(message || error) && <div className={styles.notice} data-error={!!error} role={error ? 'alert' : 'status'}>{t(error || message)}{['conflict', 'unavailable'].includes(error) && <button type="button" onClick={() => { if (!dirty || window.confirm(t('discard'))) { discarding.current = true; window.location.reload(); } }}>{t('reload')}</button>}</div>}
    {review && <div className={styles.publishReview}><div><h2>{state.tenantName} · {t(review.command === 'publish' ? 'publishReview' : 'rollbackReview')}</h2><p>{t(review.command === 'publish' ? 'publishHelp' : 'rollbackHelp', { revision: review.revision ?? 0 })}</p></div><button type="button" disabled={pending} onClick={() => setReview(null)}>{t('cancel')}</button><button type="button" className={styles.primary} disabled={pending || dirty || !valid} onClick={() => void change(review.command, review.revision)}>{t(review.command === 'publish' ? 'confirmPublish' : 'confirmRollback')}</button></div>}
    <div className={styles.workspace}>
      <aside data-tour="mobile-navigation" className={styles.navigator}><h2>{t('screens')}</h2><nav aria-label={t('screens')}>{screens.map(item => <button type="button" key={item.id} aria-label={t(item.id)} aria-current={screen === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><item.icon size={17} /><span>{t(item.id)}</span></button>)}</nav>
        <CompositionNavigator design={design} change={setDesign} disabled={pending || mode !== 'draft'} screen={screen} navigate={navigate} selected={selectedBlock} select={id => { setSelectedBlock(id); setPanel('section'); }} />
        <div className={styles.boundary}><ShieldCheck size={20} /><p>{t('protected')}</p></div>
      </aside>
      <div className={styles.stage}>
        <div className={styles.stageToolbar}><div role="group" aria-label={t('previewMode')} className={styles.segments}>{(['draft', 'published'] as const).map(value => <button type="button" key={value} aria-pressed={mode === value} disabled={pending} onClick={() => { setMode(value); setSelectedBlock(null); navigate('home'); setReview(null); }}>{t(value === 'published' ? 'publishedView' : value)}</button>)}<button type="button" disabled={pending || dirty} onClick={() => window.location.assign('/mobile-preview?live=1')}>{t('live')}</button></div>
          <div className={styles.appearance} role="group" aria-label={t('appearance')}>{(['light', 'dark'] as const).map(value => <button type="button" key={value} disabled={pending} aria-pressed={appearance === value} aria-label={t(value)} onClick={() => setAppearance(value)}>{value === 'light' ? <Sun size={16} /> : <Moon size={16} />}</button>)}</div>
        </div>
        <p className={styles.stageNote}>{mode === 'draft' ? t('previewOnly') : current ? t('publishedVersion', { revision: current.revision }) : t('defaultVersion')}</p>
        <div className={styles.phoneStage}><MobileApp key={`${mode}:${screen}`} data={data} design={displayed} designOnly embedded previewAppearance={appearance} initialTab={screen} onNavigate={navigate} selectedBlock={selectedBlock} onSelectBlock={mode === 'draft' ? id => { setSelectedBlock(id); setPanel('section'); } : undefined} /></div>
        <p className={styles.stageFooter}><Smartphone size={15} />{t('sharedApp')}</p>
      </div>
      <aside data-tour="mobile-design" className={styles.inspector}><div className={styles.inspectorTabs} role="group" aria-label={t('inspector')}>{(['design', 'section', 'history'] as const).map(value => <button type="button" key={value} aria-pressed={panel === value} onClick={() => setPanel(value)}>{t(value)}</button>)}</div>
        {panel === 'section' ? <CompositionInspector design={design} change={setDesign} disabled={pending || mode !== 'draft'} screen={screen} navigate={navigate} selected={selectedBlock} /> : panel === 'design' ? <><StyleControls design={design} change={setDesign} disabled={pending || mode !== 'draft'} appearance={appearance} /><fieldset disabled={pending || mode !== 'draft'}>
          <section><h2>{t('branding')}</h2><label>{t('brandName')}<input value={design.brandName} maxLength={32} onChange={e => edit('brandName', e.target.value)} /></label>
            <label>{t('logo')}<input type="file" accept="image/png,image/jpeg" onChange={e => void logo(e.target.files?.[0])} /></label>{design.logo && <button type="button" className={styles.textButton} onClick={() => edit('logo', null)}>{t('removeLogo')}</button>}
            <span className={styles.label}>{t('accent')}</span><div className={styles.swatches} role="group" aria-label={t('accent')}>{(Object.keys(MOBILE_ACCENTS) as MobileDesignV2['accent'][]).map(value => <button type="button" key={value} aria-pressed={design.accent === value} aria-label={t(value)} style={{ background: MOBILE_ACCENTS[value].button }} onClick={() => edit('accent', value)}>{design.accent === value && <Check size={17} />}</button>)}</div>
          </section>
          <section><h2>{t('appearance')}</h2>{(['appearance', 'clockLayout', 'leaveLayout', 'motion'] as const).map(key => <label key={key}>{t(key)}<select value={design[key]} onChange={e => edit(key, e.target.value as MobileDesignV2[typeof key])}>{({ appearance: ['dark', 'light', 'system'], clockLayout: ['flow', 'punch', 'rail'], leaveLayout: ['ledger', 'list'], corners: ['crisp', 'soft'], motion: ['standard', 'reduced'] }[key]).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>)}</section>
          <button type="button" className={styles.textButton} onClick={() => { setDesign(composeMobileDesign(DEFAULT_MOBILE_DESIGN)); setReview(null); }}>{t('reset')}</button>
        </fieldset></> : <div className={styles.history}><p className={styles.help}>{t('historyHelp')}</p>{!state.releases.length && <p>{t('noReleases')}</p>}{state.releases.map((release, index) => <article key={release.revision}><div><strong>{t('version', { revision: release.revision })}</strong>{index === 0 && <span>{t('current')}</span>}</div><time dateTime={release.publishedAt}>{new Date(release.publishedAt).toLocaleString()}</time><p>{release.config.brandName} · {t(release.config.clockLayout)}</p>{index > 0 && <button type="button" disabled={pending || dirty} onClick={() => setReview({ command: 'rollback', revision: release.revision })}><Undo2 size={15} />{t('restore')}</button>}</article>)}</div>}
      </aside>
    </div>
  </section>;
}
