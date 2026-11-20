'use client';

import { useTranslations } from 'next-intl';
import { Compass } from 'lucide-react';
import { requestTour } from '@/lib/onboarding-tour-events';
import { btnPrimary } from '@/components/ui';

/** On a Knowledge Base guide: launches the interactive in-product walkthrough for that guide's module. */
export function GuideTourButton({ tourId }: { tourId: string }) {
  const t = useTranslations('kb');
  return (
    <button
      type="button"
      data-guide-tour={tourId}
      className={btnPrimary}
      onClick={() => requestTour(tourId)}
    >
      <Compass className="size-4" />
      {t('startWalkthrough')}
    </button>
  );
}
