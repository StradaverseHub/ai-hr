'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { completeOnboardingAction } from '@/app/onboarding-actions';
import type { TourStep } from '@/lib/onboarding-tour';
import { btnGhost, btnPrimary } from '@/components/ui';

/** Custom event other components dispatch to (re)start a tour: detail.tourId selects which one. */
export const START_TOUR_EVENT = 'aihr:start-tour';

const PAD = 8; // spotlight padding around the target
const BUBBLE_W = 320;
const GAP = 14;

type Box = { top: number; left: number; width: number; height: number };

/**
 * Product tour (ADR-0018): a self-contained spotlight walkthrough. A transparent blocker captures
 * clicks, a box-shadow "hole" dims everything but the target, and a placement-aware bubble explains the
 * step. Supports multiple named tours (shell welcome + per-module walkthroughs launched from KB guides)
 * and cross-page steps — a step with a `route` navigates there first, then waits for its anchor to
 * appear. Lives in the layout so it survives navigation. Finishing/skipping persists completion.
 */
export function OnboardingTour({
  tours,
  autoStartTourId,
}: {
  tours: Record<string, TourStep[]>;
  autoStartTourId: string | null;
}) {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const pathname = usePathname();
  const [activeTourId, setActiveTourId] = useState<string | null>(autoStartTourId);
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  // Client-only overlay — don't render during SSR (its position is measured from the live DOM).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const steps = activeTourId ? (tours[activeTourId] ?? []) : [];
  const step = steps[index];
  const open = activeTourId !== null && steps.length > 0;
  const isLast = index === steps.length - 1;

  // External (re)start with a chosen tour id.
  useEffect(() => {
    const onStart = (e: Event) => {
      const id = (e as CustomEvent<{ tourId?: string }>).detail?.tourId ?? 'welcome';
      if (!tours[id]?.length) return;
      setActiveTourId(id);
      setIndex(0);
    };
    window.addEventListener(START_TOUR_EVENT, onStart as EventListener);
    return () => window.removeEventListener(START_TOUR_EVENT, onStart as EventListener);
  }, [tours]);

  // Navigate to the step's route if we're not already there.
  useEffect(() => {
    if (!open || !step?.route) return;
    if (pathname !== step.route) router.push(step.route);
    // 2dec6406: tour anchors live on the UNFILTERED page. If we're already on the route but with query
    // params (e.g. /approvals?category=leave hides sections whose anchors a later step targets), reset to
    // the bare route so every anchor exists. window.location is fine here — effects run client-side only,
    // and reading it directly avoids a useSearchParams Suspense boundary in the layout.
    else if (window.location.search) router.push(step.route);
  }, [open, step, pathname, router]);

  // Locate + measure the target, retrying so it survives a route change / async render.
  useEffect(() => {
    if (!open || !step) return;
    if (!step.target) {
      setBox(null);
      return;
    }
    let cancelled = false;
    let tries = 0;
    const settle = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    const attempt = () => {
      if (cancelled) return;
      const el = document.querySelector(step.target as string) as HTMLElement | null;
      // A target inside a hidden tab panel (client-state tabs, e.g. /me & /admin/personnel) exists in
      // the DOM but measures 0×0. Ask the tab shell to reveal it (TOUR_REVEAL_EVENT), then keep retrying
      // so the next tick measures a laid-out element instead of spotlighting empty space.
      const hidden = el != null && el.offsetWidth === 0 && el.offsetHeight === 0;
      if (el && !hidden) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        settle(el);
        window.setTimeout(() => !cancelled && settle(el), 300); // after smooth-scroll
      } else if (tries++ < 25) {
        if (hidden) window.dispatchEvent(new CustomEvent('tour:reveal', { detail: step.target }));
        window.setTimeout(attempt, 140); // wait for navigation / render / tab reveal
      } else {
        setBox(null); // give up → centered fallback
      }
    };
    attempt();
    const onMove = () => {
      const el = document.querySelector(step.target as string) as HTMLElement | null;
      if (el) settle(el);
    };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, step, pathname]);

  const finish = useCallback(() => {
    setActiveTourId(null);
    setBox(null);
    void completeOnboardingAction(); // idempotent — first finish marks the user onboarded
  }, []);

  const next = useCallback(() => {
    if (isLast) finish();
    else setIndex((i) => Math.min(steps.length - 1, i + 1));
  }, [isLast, finish, steps.length]);

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
  }, [open, next, finish]);

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
    if (step.placement === 'right' || step.placement === 'left') {
      const wantRight = step.placement === 'right' && box.left + box.width + GAP + BUBBLE_W < vw;
      left = wantRight ? box.left + box.width + GAP : box.left - BUBBLE_W - GAP;
      if (left < GAP) left = box.left + box.width + GAP;
      top = Math.max(GAP, Math.min(box.top, vh - 240));
    } else {
      top = step.placement === 'top' ? box.top - 210 - GAP : box.top + box.height + GAP;
      if (top < GAP) top = box.top + box.height + GAP;
      left = clampL(box.left);
    }
    return { top, left: clampL(left), width: BUBBLE_W };
  }, [box, step]);

  if (!mounted || !open || !step) return null;

  const spotlight = box && step.target;

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label={t('aria')}>
      {/* Click blocker. Centered steps also get the dim here; anchored steps dim via the spotlight. */}
      <div className={spotlight ? 'absolute inset-0' : 'absolute inset-0 bg-foreground/55'} onClick={finish} />

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
