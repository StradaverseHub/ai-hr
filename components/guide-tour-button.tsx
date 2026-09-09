'use client';

import { useTranslations } from 'next-intl';
import { Compass } from 'lucide-react';
import { START_TOUR_EVENT } from '@/lib/onboarding-tour';
import { btnPrimary } from '@/components/ui';

/** On a Knowledge Base guide: launches the interactive in-product walkthrough for that guide's module. */
export function GuideTourButton({ tourId }: { tourId: string }) {
  const t = useTranslations('kb');
  return (
    <button
      type="button"
      className={btnPrimary}
      onClick={() => window.dispatchEvent(new CustomEvent(START_TOUR_EVENT, { detail: { tourId } }))}
    >
      <Compass className="size-4" />
      {t('startWalkthrough')}
    </button>
  );
}
