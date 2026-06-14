'use client';

import { useTranslations } from 'next-intl';
import { HelpCircle } from 'lucide-react';
import { START_TOUR_EVENT } from './onboarding-tour';

/** Topbar help control: (re)starts the onboarding tour from anywhere. */
export function TourLauncher() {
  const t = useTranslations('onboarding');
  return (
    <button
      type="button"
      aria-label={t('launch')}
      title={t('launch')}
      onClick={() => window.dispatchEvent(new CustomEvent(START_TOUR_EVENT))}
      className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <HelpCircle className="size-5" />
    </button>
  );
}
