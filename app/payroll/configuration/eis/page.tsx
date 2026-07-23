import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { requireConfigSection } from '../guard';
import { Button, Card, ErrorBanner, PageHeader } from '@/components/ui';
import { settingsBack } from '@/app/payroll/setup/back';
import { PayrollTabs } from '@/components/payroll-tabs';
import { StatutoryTabs } from '@/components/statutory-tabs';
import { StatutoryConfigForm } from '@/components/statutory-config-form';
import type { StatutorySource } from '@/localization/my/statutory-config';
import type { ContribBand } from '@/localization/my/statutory-tables';
import Link from 'next/link';
import { pct, rm, fmtUpTo, Row, SourceMeta, VersionBadge, OverrideHistoryTable } from '../shared';

const BASE = '/payroll/configuration';
const SELF = `${BASE}/eis`;

/** EIS configuration tab (31646c85 — per-body sub-menu redesign). Read-only rate + band summary with its
 *  own built-in version record (ADR-0037 #6); the verified PERKESO band table is edited via Advanced edit
 *  (the shared band-table editor, EIS slice only). No calculation logic changes here. */
export default async function EisConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.config');
  const { edit, error } = await searchParams;
  const back = await settingsBack();
  // Rung 5c (D4): resolve the acting company's pack; 404 unless it declares the EIS section.
  const pack = await requireConfigSection('eis');

  const [{ ruleset, components }, componentOverrides] = await Promise.all([
    pack.statutoryConfig.readActive(s),
    pack.statutoryConfig.listComponents(s),
  ]);
  const src = Object.fromEntries(pack.statutoryConfig.sources.map((x) => [x.key, x])) as Record<string, StatutorySource>;

  if (edit) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader
          title={`${t('body_eis')} · ${t('editTitle')}`}
          back={back}
          actions={
            <Link href={SELF}>
              <Button variant="outline" size="sm">
                {t('view')}
              </Button>
            </Link>
          }
        />
        <PayrollTabs active="setup" />
        <StatutoryTabs active="eis" />
        <ErrorBanner message={error} />
        <Card className="border-amber-300/60 bg-amber-50/50 p-4 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          {t('safetyNote')}
        </Card>
        <StatutoryConfigForm
          ruleset={ruleset}
          defaultVersion={ruleset.version}
          epfScheduleFallback={pack.payroll.epfThirdSchedule}
          sections={['eis']}
          cancelHref={SELF}
          returnTo={SELF}
        />
      </div>
    );
  }

  const sampleBands = (bands: ContribBand[]) => [bands[0], bands[bands.length - 1]];
  const eisOverrides = componentOverrides.filter((co) => co.body === 'eis');

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('body_eis')}
        description={t('subtitle')}
        back={back}
        actions={
          <Link href={`${SELF}?edit=1`}>
            <Button variant="outline" size="sm">
              {t('advancedEdit')}
            </Button>
          </Link>
        }
      />
      <PayrollTabs active="setup" />
      <StatutoryTabs active="eis" />
      <ErrorBanner message={error} />

      <Card className="p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('secEis')}</h2>
          <VersionBadge version={components.eis.version} source={components.eis.source} label={t(`src_${components.eis.source}`)} />
        </div>
        <div className="mt-2 divide-y divide-border">
          <Row label={`${t('rate')} (employer / employee)`} value={`${pct(ruleset.eis.rates.employer)} / ${pct(ruleset.eis.rates.employee)}`} />
          <Row label="Bands" value={String(ruleset.eis.bands.length)} />
          {sampleBands(ruleset.eis.bands).map((b, i) => (
            <Row key={i} label={`≤ ${fmtUpTo(b.upTo, t('topBand'))}`} value={`${rm(b.employer)} / ${rm(b.employee)}`} />
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t('bandsReadOnly', { count: ruleset.eis.bands.length })}</p>
        <SourceMeta src={src.eis} label={t('verified')} />
      </Card>

      {eisOverrides.length > 0 && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">{t('componentTitle')}</h2>
          <OverrideHistoryTable rows={eisOverrides} t={t} />
        </Card>
      )}
    </div>
  );
}
