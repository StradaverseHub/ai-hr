import {routeMessageLayout} from '@/components/route-messages';
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { moduleLayout } from '@/lib/module-layout';
import { UiThemeArea } from '@/components/ui-theme-context';

// Route-segment guard for the performance module (r292). The CONTROL is the service gate in
// core/module-gate.ts; this is the courtesy redirect to /?moduleUnavailable=performance.
// See lib/module-layout.tsx for exactly what a layout does and does not cover.
const PerformanceModuleGuard = moduleLayout('performance');

/**
 * D-P1-32 D3 (APR-025, ADR-0152) — the Performance & Talent area theme. Every page under /performance, employee
 * and administration alike (DQ-16), renders inside `data-area-theme="performance"`, which app/performance/
 * area-theme.css (imported by app/layout.tsx) themes the same in Classic, Monolith and Atelier. The band carries the
 * area title only: tab strips and the cycle render per page, so this layout reads nothing beyond its translations.
 * <UiThemeArea> makes client structural branches (useUiTheme) render Classic structure inside the area.
 */
async function PerformanceLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('nav');
  return (
    <PerformanceModuleGuard>
      <div data-area-theme="performance">
        <div className="pt-band" data-area-band>
          <p className="pt-band-title">{t('performanceTalent')}</p>
        </div>
        <div className="pt-area-body">
          <UiThemeArea>{children}</UiThemeArea>
        </div>
      </div>
    </PerformanceModuleGuard>
  );
}

export default routeMessageLayout('performance',PerformanceLayout);
