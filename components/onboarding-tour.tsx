'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { completeOnboardingAction } from '@/app/onboarding-actions';
import type { TourStep } from '@/lib/onboarding-tour';
import { btnGhost, btnPrimary } from '@/components/ui';

/** Custom event other components dispatch to (re)start the tour. */
export const START_TOUR_EVENT = 'aihr:start-tour';

const PAD = 8; // spotlight padding around the target
const BUBBLE_W = 320;
const GAP = 14;

type Box = { top: number; left: number; width: number; height: number };

/**
 * First-login product tour (ADR-0018): a self-contained spotlight walkthrough. A transparent blocker
 * captures clicks, a box-shadow "hole" dims everything but the target, and a placement-aware bubble
 * explains the step. Finishing or skipping persists completion. Replayable via the START_TOUR_EVENT.
 */
export function OnboardingTour({ steps, autoStart }: { steps: TourStep[]; autoStart: boolean }) {
  const t = useTranslations('onboarding');
  const [open, setOpen] = useState(autoStart);
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  // The tour is a client-only overlay; don't render it during SSR (its position is measured from the
  // live DOM, so SSR-ing it causes a hydration mismatch). Mount-gate it instead.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const step = steps[index];
  const isLast = index === steps.length - 1;

  // Locate the current step's target and measure it (null → centered card).
  const measure = useCallback(() => {
    if (!step || !step.target) {
      setBox(null);
      return;
    }
    const el = document.querySelector(step.target) as HTMLElement | null;
    if (!el) {
      setBox(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [step]);

  // Scroll the target into view, then measure; re-measure on scroll/resize while open.
  useEffect(() => {
    if (!open || !step) return;
    if (step.target) {
      const el = document.querySelector(step.target) as HTMLElement | null;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    measure();
    const onMove = () => measure();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    const id = window.setTimeout(measure, 250); // after smooth-scroll settles
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      window.clearTimeout(id);
    };
  }, [open, step, measure]);

  // External (re)start.
  useEffect(() => {
    const onStart = () => {
      setIndex(0);
      setOpen(true);
    };
    window.addEventListener(START_TOUR_EVENT, onStart);
    return () => window.removeEventListener(START_TOUR_EVENT, onStart);
  }, []);

  // Keyboard: Esc skips, ←/→ navigate.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index, isLast]);

  const finish = useCallback(() => {
    setOpen(false);
    void completeOnboardingAction();
  }, []);

  const next = useCallback(() => {
    if (isLast) finish();
    else setIndex((i) => Math.min(steps.length - 1, i + 1));
  }, [isLast, finish, steps.length]);

  // Bubble position from the target box + placement, clamped to the viewport.
  const bubbleStyle = useMemo<React.CSSProperties>(() => {
    if (typeof window === 'undefined') return {};
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const clampL = (l: number) => Math.max(GAP, Math.min(l, vw - BUBBLE_W - GAP));
    if (!box || !step?.target || step.placement === 'center') {
      return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: BUBBLE_W };
    }
    let top = box.top;
    let left = box.left;
    const wantRight = step.placement === 'right' && box.left + box.width + GAP + BUBBLE_W < vw;
    if (step.placement === 'right' || step.placement === 'left') {
      left = wantRight ? box.left + box.width + GAP : box.left - BUBBLE_W - GAP;
      if (left < GAP) left = box.left + box.width + GAP; // flip if no room on the left
      top = Math.max(GAP, Math.min(box.top, vh - 220));
    } else {
      // top / bottom
      top = step.placement === 'top' ? box.top - 200 - GAP : box.top + box.height + GAP;
      if (top < GAP) top = box.top + box.height + GAP;
      left = clampL(box.left);
    }
    return { top, left: clampL(left), width: BUBBLE_W };
  }, [box, step]);

  if (!mounted || !open || !step) return null;

  const spotlight = box && step.target;

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label={t('aria')}>
      {/* Click blocker. For centered steps it also provides the dim; for anchored steps the dim
          comes from the spotlight's box-shadow below. */}
      <div className={spotlight ? 'absolute inset-0' : 'absolute inset-0 bg-foreground/55'} onClick={finish} />

      {/* Spotlight: a hole over the target, everything else dimmed via a huge box-shadow. */}
      {spotlight && (
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-xl ring-2 ring-primary/60 transition-all duration-200 ease-out motion-reduce:transition-none"
          style={{
            top: box.top - PAD,
            left: box.left - PAD,
            width: box.width + PAD * 2,
            height: box.height + PAD * 2,
            boxShadow: '0 0 0 9999px rgba(15, 18, 25, 0.55)',
          }}
        />
      )}

      {/* Bubble */}
      <div
        className="absolute rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-[var(--shadow-pop)] transition-[top,left] duration-200 ease-out motion-reduce:transition-none"
        style={bubbleStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-primary">
          {t('stepOf', { current: index + 1, total: steps.length })}
        </div>
        <h3 className="text-sm font-semibold text-foreground">{t(step.titleKey)}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{t(step.bodyKey)}</p>

        <div className="mt-4 flex items-center justify-between gap-2">
          <button type="button" onClick={finish} className="text-xs font-medium text-muted-foreground hover:text-foreground">
            {t('skip')}
          </button>
          <div className="flex items-center gap-2">
            {index > 0 && (
              <button type="button" onClick={() => setIndex((i) => Math.max(0, i - 1))} className={btnGhost}>
                {t('back')}
              </button>
            )}
            <button type="button" onClick={next} className={btnPrimary}>
              {isLast ? (
                <>
                  <Check className="size-4" />
                  {t('done')}
                </>
              ) : (
                t('next')
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
