'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import styles from './mobile-preview.module.css';

/** Deliberate thumb drag, with keyboard and single-tap alternatives. Track clicks never confirm. */
export function SlideConfirm({ direction, onConfirm }: { direction: 'in' | 'out'; onConfirm: () => void }) {
  const t = useTranslations('mobilePreview.gesture');
  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLButtonElement>(null);
  const active = useRef<{ id: number; x: number; start: number } | null>(null);
  const position = useRef(0);
  const completed = useRef(false);
  const [progress, setProgress] = useState(0);
  const [travel, setTravel] = useState(0);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const measure = () => setTravel(Math.max(0, (track.current?.clientWidth ?? 0) - (thumb.current?.offsetWidth ?? 52) - 12));
    measure();
    const observer = new ResizeObserver(measure);
    if (track.current) observer.observe(track.current);
    return () => observer.disconnect();
  }, []);
  const move = (value: number) => { position.current = Math.max(0, Math.min(100, value)); setProgress(position.current); };
  const reset = () => { active.current = null; setDragging(false); move(0); };
  const confirm = () => {
    if (completed.current) return;
    completed.current = true; active.current = null; setDragging(false); onConfirm();
  };
  function begin(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || event.isPrimary === false || active.current || completed.current || travel <= 0) return;
    event.preventDefault(); event.currentTarget.focus();
    active.current = { id: event.pointerId, x: event.clientX, start: position.current };
    event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
  }
  function drag(event: PointerEvent<HTMLButtonElement>) {
    const origin = active.current;
    if (!origin || origin.id !== event.pointerId || travel <= 0) return;
    move(origin.start + (event.clientX - origin.x) / travel * 100);
  }
  function release(event: PointerEvent<HTMLButtonElement>) {
    if (active.current?.id !== event.pointerId) return;
    // Re-read the release coordinate, so a fast final movement cannot miss its last pointermove.
    drag(event);
    if (position.current >= 98) confirm(); else reset();
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (active.current || completed.current) return;
    if (['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'Home', 'End', 'Escape', 'Enter', ' '].includes(event.key)) event.preventDefault();
    if (event.key === 'End') move(100);
    else if (event.key === 'Home' || event.key === 'Escape') reset();
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') move(position.current + 10);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') move(position.current - 10);
    else if ((event.key === 'Enter' || event.key === ' ') && position.current >= 98) confirm();
  }
  const label = t(direction === 'in' ? 'slideIn' : 'slideOut');
  return <div className={styles.slideControl}>
    <div ref={track} className={styles.slideTrack} data-dragging={dragging}>
      <span className={styles.slideLabel} aria-hidden="true" style={{ opacity: 1 - progress / 125 }}>{label}</span>
      <button ref={thumb} type="button" role="slider" aria-label={label} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(progress)} aria-valuetext={progress >= 98 ? t('release') : t('progress', { percent: Math.round(progress) })}
        aria-description={t('keyboardHelp')} className={styles.slideThumb} style={{ transform: `translateX(${progress / 100 * travel}px)` }}
        onPointerDown={begin} onPointerMove={drag} onPointerUp={release} onPointerCancel={reset}
        onLostPointerCapture={() => { if (active.current) reset(); }} onKeyDown={keyboard} onBlur={reset}>
        <ArrowRight size={23} aria-hidden="true" />
      </button>
    </div>
    <button type="button" className={styles.tapAlternative} onClick={confirm}>{t(direction === 'in' ? 'tapIn' : 'tapOut')}</button>
  </div>;
}
