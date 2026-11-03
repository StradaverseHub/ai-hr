'use client';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Image from 'next/image';
import { RotateCcw, Square } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ClockworkFigure, type ClockworkLabels, type ClockworkTarget } from '@/components/ai-centre/clockwork-figure';
import { AI_ARCHITECTURE_LABEL, aiCentreName } from '@/lib/ai-centre/brand';
import { drawLoginTriangle, LOGIN_STORY, loginStoryAt, loginSwirlPoint } from '@/lib/login-story';

/** A public illustration, not a live AI session. The image contains fictional demonstration data.
 * The shared How it works figure is unchanged. Its real SVG locates the swirl's sink. */
export function NoveriStory() {
  const t = useTranslations('loginEditorial');
  const name = aiCentreName(t('genericAiName'));
  const stage = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), poster = useRef<HTMLImageElement>(null);
  const elapsed = useRef(0), sink = useRef<readonly [number, number]>([382, 174]);
  const [wide, setWide] = useState(false), [reduced, setReduced] = useState(false), [loaded, setLoaded] = useState(false);
  const [stopped, setStopped] = useState(false), [clock, setClock] = useState(false), [active, setActive] = useState<ClockworkTarget | null>(null);
  const [width, setWidth] = useState(850), [replay, setReplay] = useState(0), [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!window.matchMedia) return;
    const screen = window.matchMedia('(min-width: 1024px) and (min-height: 601px)');
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => { setWide(screen.matches); setReduced(motion.matches); if (motion.matches || !screen.matches) setStopped(true); };
    const hidden = () => { if (document.hidden) setStopped(true); };
    sync(); screen.addEventListener('change', sync); motion.addEventListener('change', sync); document.addEventListener('visibilitychange', hidden);
    return () => { screen.removeEventListener('change', sync); motion.removeEventListener('change', sync); document.removeEventListener('visibilitychange', hidden); };
  }, []);

  useEffect(() => {
    if (!stage.current || !wide) return;
    const resize = () => setWidth(stage.current?.clientWidth || 850);
    resize();
    if (!window.ResizeObserver) return;
    const observer = new ResizeObserver(resize); observer.observe(stage.current);
    return () => observer.disconnect();
  }, [wide]);

  useEffect(() => {
    if (!wide || reduced || stopped || !loaded || failed) return;
    let frame = 0, timer = 0, last = 0, previousLayer: ClockworkTarget | null = null;
    const image = poster.current, surface = canvas.current;
    if (!image || !surface) return;
    let ctx: CanvasRenderingContext2D | null;
    try { ctx = surface.getContext('2d'); } catch { setFailed(true); return; }
    if (!ctx) { setFailed(true); return; }
    const context = ctx;
    const tick = (now: number) => {
      if (document.hidden) { setStopped(true); return; }
      if (last) elapsed.current += Math.min(100, now - last);
      last = now;
      const state = loginStoryAt(elapsed.current);
      if (state.clock) setClock(true);
      if (state.clock && state.active !== previousLayer) { previousLayer = state.active; setActive(state.active); }
      if (state.finished) { setStopped(true); return; }
      // The real top plate moves while the watch opens; never guess its screen coordinates.
      const svg = stage.current?.querySelector<SVGSVGElement>('svg[viewBox="0 0 1000 620"]');
      const face = Array.from(stage.current?.querySelectorAll<SVGPolygonElement>('[data-part="interfaces"] polygon') ?? []).find(element => element.points.numberOfItems === 56);
      const matrix = state.swirl < 1 ? svg?.getScreenCTM() : null, bounds = state.swirl < 1 ? stage.current?.getBoundingClientRect() : undefined;
      if (face && matrix && bounds?.width) {
        let x = 0, y = 0;
        for (let i = 0; i < 56; i++) { const point = face.points.getItem(i); const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix); x += screen.x; y += screen.y; }
        sink.current = [(x / 56 - bounds.left) * 850 / bounds.width, (y / 56 - bounds.top) * 850 / bounds.width];
      }
      context.clearRect(0, 0, 850, 527);
      surface.style.visibility = state.swirl === 1 ? 'hidden' : 'visible';
      if (!state.clock) {
        context.drawImage(image, 23, 7, 804, 512);
        if (elapsed.current > 700) { context.strokeStyle = '#c2410c'; context.lineWidth = 2; context.strokeRect(280, 239, 445, 130); }
      } else if (state.swirl < 1) {
        context.globalAlpha = Math.min(1, (1 - state.swirl) * 10);
        const columns = 22, rows = 14;
        const mesh = Array.from({ length: rows + 1 }, (_, row) => Array.from({ length: columns + 1 }, (_, col) => loginSwirlPoint(col / columns, row / rows, state.swirl, sink.current)));
        for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
          drawLoginTriangle(context, image, mesh[row][col], mesh[row][col + 1], mesh[row + 1][col]);
          drawLoginTriangle(context, image, mesh[row][col + 1], mesh[row + 1][col + 1], mesh[row + 1][col]);
        }
        context.globalAlpha = 1;
      }
      if (state.swirl < 1) frame = requestAnimationFrame(tick);
      else timer = window.setTimeout(() => { frame = requestAnimationFrame(tick); }, 75);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [wide, reduced, stopped, loaded, failed, replay]);

  const still = reduced || stopped || failed;
  const showClock = wide && (clock || still);
  const labels = Object.fromEntries(['interfaces', 'harness', 'context', 'capabilities', 'record', 'model', 'foundation', 'guard', 'outcome'].map(key => [key, { name: t(`clock.${key}.name`), part: t(`clock.${key}.part`) }])) as ClockworkLabels;
  function restart() { elapsed.current = 0; setClock(false); setActive(null); setStopped(false); setFailed(false); setReplay(value => value + 1); }
  return <section className="login-story" aria-label={t('storyLabel')}>
    <div ref={stage} className="login-story-stage" data-clock={showClock || undefined} data-still={still || undefined} style={{ '--story-scale': width / 1000 } as CSSProperties}>
      <Image ref={poster} src="/login/ai-centre-demo.png" alt={t('demoAlt')} width={1062} height={677} unoptimized loading="lazy" className="login-story-poster" onLoad={() => setLoaded(true)} onError={() => setFailed(true)}/>
      <canvas ref={canvas} width={850} height={527} aria-hidden className="login-story-canvas"/>
      {showClock && <div className="login-story-watch"><ClockworkFigure key={replay} active={still ? null : active} labels={labels} reduced={still}
        title={t('clockTitle', { name })} caption={t('clockCaption')} mark={name} faceLabel={AI_ARCHITECTURE_LABEL ?? undefined} label={t('clockAlt')}/></div>}
    </div>
    <div className="login-story-caption"><p>{t('demoCaption')}</p>
      {wide && !reduced && <button type="button" onClick={still ? restart : () => setStopped(true)}>
        {still ? <RotateCcw aria-hidden size={14}/> : <Square aria-hidden size={12}/>}{t(still ? 'replay' : 'stop')}
      </button>}
    </div>
    <p className="sr-only">{t('storyDescription')}</p>
  </section>;
}
