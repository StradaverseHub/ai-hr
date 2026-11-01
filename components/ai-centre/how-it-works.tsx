'use client';
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Ban, Bell, Check, ChevronLeft, ChevronRight, ClipboardList, Eye, HelpCircle, Pause, Play, Scale, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { aiCentreName } from '@/lib/ai-centre/brand';
import { ClockworkFigure, type ClockworkLabels, type ClockworkTarget } from './clockwork-figure';

/** The nine steps of one request (ADR-0170 §4), and which layer each lights. `guard` and `outcome` are parts
 * of the foundation; the others are layers. Fixed: this walkthrough explains the design and reads nothing. */
export const HOW_STEPS = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'] as const;
export const HOW_STEP_TARGET: readonly (ClockworkTarget | null)[] = [null, 'interfaces', 'guard', 'harness', 'context', 'capabilities', 'record', 'outcome', 'interfaces'];
type Layer = 'interfaces' | 'harness' | 'context' | 'capabilities' | 'record';
type Part = 'guard' | 'jobs' | 'outcome' | 'audit';
type Target = Layer | Part;
const LAYERS: readonly Layer[] = ['interfaces', 'harness', 'context', 'capabilities', 'record'];
const PARTS: readonly Part[] = ['guard', 'jobs', 'outcome', 'audit'];
export const HOW_CHAPTERS = ['request', 'jobs', 'families', 'never'] as const;
type Chapter = (typeof HOW_CHAPTERS)[number];
/** Autoplay interval. Never used under reduced motion: there the person steps through. */
const AUTOPLAY_MS = 3600;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function HowItWorks({ adminHref }: { adminHref?: string }) {
  const t = useTranslations('aiCentre.how');
  const [chapter, setChapter] = React.useState<Chapter>('request');
  const chapterRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const onChapterKey = (event: React.KeyboardEvent, index: number) => {
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? HOW_CHAPTERS.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = (next + HOW_CHAPTERS.length) % HOW_CHAPTERS.length;
    setChapter(HOW_CHAPTERS[target]);
    chapterRefs.current[target]?.focus();
  };
  return (
    <div className="space-y-5" data-how-it-works>
      <div role="tablist" aria-label={t('chaptersLabel')} className="inline-flex flex-wrap gap-0.5 rounded-lg bg-muted p-1">
        {HOW_CHAPTERS.map((key, index) => (
          <button key={key} ref={element => { chapterRefs.current[index] = element; }} type="button" role="tab" id={`how-tab-${key}`} aria-controls={`how-panel-${key}`}
            aria-selected={chapter === key} tabIndex={chapter === key ? 0 : -1} onClick={() => setChapter(key)} onKeyDown={event => onChapterKey(event, index)}
            className={cn('min-h-9 rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              chapter === key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
            {t(`chapters.${key}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`how-panel-${chapter}`} aria-labelledby={`how-tab-${chapter}`}>
        {chapter === 'request' && <RequestJourney />}
        {chapter === 'jobs' && <JobsChapter />}
        {chapter === 'families' && <FamiliesChapter />}
        {chapter === 'never' && <NeverChapter />}
      </div>
      {adminHref && <a href={adminHref} className="inline-flex min-h-9 items-center text-sm font-medium text-primary hover:underline">{t('adminLink')}</a>}
    </div>
  );
}

function RequestJourney() {
  const t = useTranslations('aiCentre.how');
  const reduced = usePrefersReducedMotion();
  const [step, setStep] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const map = React.useRef<HTMLDivElement>(null);
  const anchors = React.useRef<Partial<Record<Target, HTMLElement | null>>>({});
  const dots = React.useRef<(HTMLButtonElement | null)[]>([]);
  const [token, setToken] = React.useState<{ x: number; y: number } | null>(null);
  const last = HOW_STEPS.length - 1;
  const target = HOW_STEP_TARGET[step];

  // Autoplay advances one step at a time and stops on the last; reduced motion never autoplays.
  React.useEffect(() => {
    if (!playing || reduced) return;
    if (step >= last) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setStep(value => Math.min(last, value + 1)), AUTOPLAY_MS);
    return () => window.clearTimeout(timer);
  }, [playing, reduced, step, last]);
  React.useEffect(() => { if (reduced) setPlaying(false); }, [reduced]);

  // The request marker sits at the lit layer's right edge; it is re-measured when the layout changes.
  const place = React.useCallback(() => {
    const box = map.current, anchor = target ? anchors.current[target] : null;
    if (!box || !anchor) { setToken(null); return; }
    const outer = box.getBoundingClientRect(), inner = anchor.getBoundingClientRect();
    const isPart = (PARTS as readonly string[]).includes(target!);
    setToken({ x: (isPart ? inner.right + 6 : inner.right - 22) - outer.left - 7, y: inner.top + inner.height / 2 - outer.top - 7 });
  }, [target]);
  React.useLayoutEffect(() => { place(); }, [place]);
  React.useEffect(() => {
    if (!map.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => place());
    observer.observe(map.current);
    return () => observer.disconnect();
  }, [place]);

  const go = (next: number, focus = false) => {
    const value = Math.max(0, Math.min(last, next));
    setStep(value);
    if (focus) dots.current[value]?.focus();
  };
  const onDotKey = (event: React.KeyboardEvent) => {
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? step + 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? step - 1
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (next === null) return;
    event.preventDefault();
    setPlaying(false);
    go(next, true);
  };
  const togglePlay = () => {
    if (reduced) { go(step + 1); return; }
    if (!playing && step >= last) setStep(0);
    setPlaying(value => !value);
  };
  const lit = (key: Target) => target === key;

  const checks = (keys: readonly string[], offered?: readonly boolean[]) => (
    <ul className="mb-3 divide-y divide-border text-sm">
      {keys.map((key, index) => {
        const yes = offered ? offered[index] : true;
        return <li key={key} className="flex items-start gap-2 py-1.5 motion-safe:animate-[ai-centre-tick_350ms_cubic-bezier(.16,1,.3,1)_both]" style={reduced ? undefined : { animationDelay: `${index * 90}ms` }}>
          {yes ? <Check aria-hidden className="mt-0.5 size-4 flex-none text-emerald-700 dark:text-emerald-300" /> : <X aria-hidden className="mt-0.5 size-4 flex-none text-muted-foreground" />}
          <span className={yes ? undefined : 'text-muted-foreground'}>{t(`steps.${key}`)}</span>
        </li>;
      })}
    </ul>
  );
  const extra = step === 1 ? <p className="mb-3 rounded-lg bg-muted px-3 py-2 text-sm">{t('steps.s1Quote')}</p>
    : step === 2 ? checks(['s2c1', 's2c2', 's2c3', 's2c4', 's2c5'])
    : step === 3 ? checks(['s3c1', 's3c2', 's3c3', 's3c4'], [true, true, false, false])
    : step === 6 ? checks(['s6c1', 's6c2', 's6c3'])
    : step === 8 ? <p className="mb-3 inline-flex items-center gap-2.5 rounded-lg border border-input px-3 py-2 text-sm font-medium"><span aria-hidden className="atelier-mark size-6 rounded-full bg-amber-900/10 shadow-[inset_0_0_0_2px_rgb(138_90_46)]" />{t('steps.s8Mark')}</p>
    : null;

  const tc = useTranslations('aiCentre');
  const part = (key: 'interfaces' | 'harness' | 'context' | 'capabilities' | 'record' | 'model' | 'foundation' | 'guard' | 'outcome') => ({ name: t(`layers.${key}`), part: t(`parts.${key}`) });
  const labels: ClockworkLabels = { interfaces: part('interfaces'), harness: part('harness'), context: part('context'), capabilities: part('capabilities'), record: part('record'), model: part('model'), foundation: part('foundation'), guard: part('guard'), outcome: part('outcome') };
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] xl:grid-cols-1">
      {/* Wide screens: the clockwork figure. Below that width its labels would be too small, so the same
          layers show as the stacked list. Either way the step text below carries the meaning. */}
      <div className="hidden xl:block">
        <ClockworkFigure active={target} labels={labels} reduced={reduced} label={t('mapLabel')}
          title={t('title')} caption={t('figureCaption')} mark={aiCentreName(tc('genericName'))} />
      </div>
      <div ref={map} role="img" aria-label={t('mapLabel')} className="relative rounded-2xl border border-border bg-card p-4 sm:p-5 xl:hidden">
        <span aria-hidden data-how-token className={cn('pointer-events-none absolute left-0 top-0 z-10 size-3.5 rounded-full bg-primary shadow-[0_0_0_4px_color-mix(in_srgb,var(--primary)_22%,transparent),0_2px_6px_rgb(0_0_0/0.18)]',
          reduced ? 'transition-opacity duration-200' : 'transition-[transform,opacity] duration-[650ms] ease-[cubic-bezier(.16,1,.3,1)]')}
          style={{ opacity: token ? 1 : 0, transform: token ? `translate(${token.x}px, ${token.y}px)` : undefined }} />
        <ol className="space-y-2">
          {LAYERS.map((layer, index) => (
            <li key={layer} ref={element => { anchors.current[layer] = element; }} data-layer={layer} data-lit={lit(layer) || undefined}
              className={cn('grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-xl border py-3 pl-3.5 pr-9 transition-[border-color,background-color,opacity] duration-200 motion-reduce:transition-none',
                lit(layer) ? 'border-primary bg-primary/5' : 'border-border', target && !lit(layer) && 'opacity-60')}>
              <span aria-hidden className={cn('row-span-2 flex size-8 items-center justify-center rounded-lg text-xs font-semibold transition-colors motion-reduce:transition-none',
                lit(layer) ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>{index + 1}</span>
              <span className="text-sm font-semibold">{t(`layers.${layer}`)}</span>
              <span className="text-xs text-muted-foreground">{t(`layers.${layer}Help`)}</span>
              {layer === 'harness' && (
                <span className={cn('col-start-2 mt-2 flex items-center gap-2 rounded-lg border-[1.5px] border-dashed border-violet-500/50 bg-violet-500/5 px-2.5 py-1.5 text-xs text-violet-700 dark:text-violet-300',
                  lit('harness') && 'ring-4 ring-violet-500/15')}>
                  <Sparkles aria-hidden className="size-3.5" /><span><strong className="font-semibold">{t('layers.model')}</strong> · {t('layers.modelHelp')}</span>
                </span>
              )}
            </li>
          ))}
        </ol>
        <div className={cn('mt-2.5 rounded-xl border bg-[repeating-linear-gradient(135deg,var(--muted)_0_6px,var(--card)_6px_12px)] p-3.5 transition-colors motion-reduce:transition-none',
          target && (PARTS as readonly string[]).includes(target) ? 'border-primary' : 'border-input')}>
          <p className="text-sm font-semibold">{t('layers.foundation')}</p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {PARTS.map(part => (
              <li key={part} ref={element => { anchors.current[part] = element; }} data-part={part}
                className={cn('rounded-full border bg-card px-2.5 py-0.5 text-xs transition-colors motion-reduce:transition-none', lit(part) ? 'border-primary font-medium text-primary' : 'border-border')}>{t(`layers.${part}`)}</li>
            ))}
          </ul>
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <li className="inline-flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-sm border border-input bg-muted" />{t('legend.rules')}</li>
          <li className="inline-flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-sm border border-dashed border-violet-500 bg-violet-500/10" />{t('legend.model')}</li>
          <li className="inline-flex items-center gap-1.5"><span aria-hidden className="size-3 rounded-full shadow-[inset_0_0_0_2px_rgb(138_90_46)]" />{t('legend.person')}</li>
        </ul>
      </div>
      <section className="rounded-2xl border border-border bg-card p-5 xl:grid xl:grid-cols-2 xl:gap-x-7">
        <div aria-live="polite" aria-atomic="true" className="xl:col-start-1">
          <p className="text-xs tabular-nums text-muted-foreground">{t('stepOf', { n: step + 1, total: HOW_STEPS.length })}</p>
          <h2 className="mb-2 mt-1 text-lg font-semibold leading-snug tracking-tight">{t(`steps.${HOW_STEPS[step]}`)}</h2>
          <p className="mb-3 max-w-prose text-sm">{t(`steps.${HOW_STEPS[step]}Body`)}</p>
        </div>
        {/* The step's checks sit beside the text on wide screens; announced with it. */}
        <div aria-live="polite" className="xl:col-start-2 xl:row-span-2 xl:row-start-1">{extra}</div>
        <div className="mt-4 flex flex-wrap items-center gap-2 xl:col-start-1 xl:row-start-2">
          <button type="button" onClick={() => { setPlaying(false); go(step - 1); }} disabled={step === 0}
            className="inline-flex min-h-9 items-center gap-1 rounded-md border border-input bg-card px-3 text-sm font-medium hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ChevronLeft aria-hidden className="size-4" />{t('previous')}</button>
          <button type="button" onClick={togglePlay} aria-pressed={playing}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {playing ? <Pause aria-hidden className="size-4" /> : <Play aria-hidden className="size-4" />}{playing ? t('pause') : t('play')}</button>
          <button type="button" onClick={() => { setPlaying(false); go(step + 1); }} disabled={step === last}
            className="inline-flex min-h-9 items-center gap-1 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('next')}<ChevronRight aria-hidden className="size-4" /></button>
          <div role="tablist" aria-label={t('stepsLabel')} className="ml-auto flex">
            {HOW_STEPS.map((key, index) => (
              <button key={key} ref={element => { dots.current[index] = element; }} type="button" role="tab" aria-selected={index === step} aria-label={t(`steps.${key}`)}
                tabIndex={index === step ? 0 : -1} onClick={() => { setPlaying(false); go(index); }} onKeyDown={onDotKey}
                className="group inline-flex size-7 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span aria-hidden className={cn('size-2 rounded-full transition-[background-color,transform] motion-reduce:transition-none', index === step ? 'scale-125 bg-primary' : 'bg-input group-hover:bg-muted-foreground')} />
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function JobsChapter() {
  const t = useTranslations('aiCentre.how.jobs');
  return (
    <div className="space-y-3">
      <ol className="grid gap-3 md:grid-cols-3">
        {(['k1', 'k2', 'k3'] as const).map(key => (
          <li key={key} className="rounded-xl border border-border bg-card p-4"><h3 className="text-sm font-semibold">{t(key)}</h3><p className="mt-1.5 text-sm text-muted-foreground">{t(`${key}Body`)}</p></li>
        ))}
      </ol>
      <section className="rounded-xl border border-border bg-card p-4"><h3 className="text-sm font-semibold">{t('conditions')}</h3><p className="mt-1.5 text-sm text-muted-foreground">{t('conditionsBody')}</p></section>
    </div>
  );
}

function FamiliesChapter() {
  const t = useTranslations('aiCentre');
  const families = [['watcher', Eye], ['chaser', Bell], ['preparer', ClipboardList], ['decider', Scale], ['explainer', HelpCircle]] as const;
  return (
    <div className="space-y-3">
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {families.map(([key, Icon]) => (
          <li key={key} className="rounded-xl border border-border bg-card p-4">
            <span aria-hidden className="flex size-7 items-center justify-center rounded-md bg-muted"><Icon className="size-3.5" /></span>
            <h3 className="mt-2.5 text-sm font-semibold">{t(`workers.families.${key}`)}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t(`workers.families.${key}Help`)}</p>
            <p className="mt-2.5 inline-flex rounded-full bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-800 dark:text-violet-300">{t(`how.families.${key}Role`)}</p>
          </li>
        ))}
      </ul>
      <p className="max-w-3xl text-sm text-muted-foreground">{t('how.families.intro')}</p>
    </div>
  );
}

function NeverChapter() {
  const t = useTranslations('aiCentre.how.never');
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {(['n1', 'n2', 'n3', 'n4', 'n5', 'n6'] as const).map(key => (
        <li key={key} className="flex gap-2.5 rounded-xl border border-border bg-card p-4">
          <Ban aria-hidden className="mt-0.5 size-4 flex-none text-destructive" />
          <div><h3 className="text-sm font-semibold">{t(key)}</h3><p className="mt-1 text-sm text-muted-foreground">{t(`${key}Body`)}</p></div>
        </li>
      ))}
    </ul>
  );
}
