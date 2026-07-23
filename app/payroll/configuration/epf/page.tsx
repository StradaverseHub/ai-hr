import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { packFor } from '@/localization/registry';
import { Button, Card, ErrorBanner, PageHeader } from '@/components/ui';
import { settingsBack } from '@/app/payroll/setup/back';
import { PayrollTabs } from '@/components/payroll-tabs';
import { StatutoryTabs } from '@/components/statutory-tabs';
import { StatutoryConfigForm } from '@/components/statutory-config-form';
import { StatutoryComponentForm } from '@/components/statutory-component-form';
import type { StatutorySource } from '@/localization/my/statutory-config';
import Link from 'next/link';
import {
  pct,
  rm,
  Row,
  SourceMeta,
  VersionBadge,
  OverrideHistoryTable,
  buildComponentDefaults,
  buildComponentLabels,
} from '../shared';

const BASE = '/payroll/configuration';
const SELF = `${BASE}/epf`;

/** EPF / KWSP configuration tab (31646c85 — per-body sub-menu redesign). Shows only EPF: its own built-in
 *  version record (ADR-0037 #6), the scalar rate view + inline scalar override, and an Advanced-edit entry
 *  into the band-table editor (Third Schedule Part A / E). No calculation logic changes here. */
export default async function EpfConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.config');
  const { edit, error } = await searchParams;
  const back = await settingsBack();
  const pack = packFor('MY');

  if (!pack) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader title={t('body_epf')} back={back} />
        <ErrorBanner message="No localization pack for MY." />
      </div>
    );
  }

  const [{ ruleset, components }, componentOverrides] = await Promise.all([
    pack.statutoryConfig.readActive(s),
    pack.statutoryConfig.listComponents(s),
  ]);
  const src = Object.fromEntries(pack.statutoryConfig.sources.map((x) => [x.key, x])) as Record<string, StatutorySource>;

  // ── Advanced edit: scoped band-table editor (EPF slice + shared ceilings). State + hidden payload still
  //    carry the FULL ruleset, so unrendered slices round-trip byte-identically; only EPF/Ceilings render. ──
  if (edit) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader
          title={`${t('body_epf')} · ${t('editTitle')}`}
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
        <StatutoryTabs active="epf" />
        <ErrorBanner message={error} />
        <Card className="border-amber-300/60 bg-amber-50/50 p-4 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          {t('safetyNote')}
        </Card>
        <StatutoryConfigForm
          ruleset={ruleset}
          defaultVersion={ruleset.version}
          epfScheduleFallback={pack.payroll.epfThirdSchedule}
          sections={['epf', 'ceilings']}
          cancelHref={SELF}
          returnTo={SELF}
        />
      </div>
    );
  }

  const epfOverrides = componentOverrides.filter((co) => co.body === 'epf');

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('body_epf')}
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
      <StatutoryTabs active="epf" />
      <ErrorBanner message={error} />

      <Card className="p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('secEpf')}</h2>
          <VersionBadge version={components.epf.version} source={components.epf.source} label={t(`src_${components.epf.source}`)} />
        </div>
        <div className="mt-2 divide-y divide-border">
          <Row label={t('epfEmployeeRate')} value={pct(ruleset.epf.employeeRate)} />
          <Row label={t('epfEmployerRateLow')} value={pct(ruleset.epf.employerRateLow)} />
          <Row label={t('epfEmployerRateHigh')} value={pct(ruleset.epf.employerRateHigh)} />
          <Row label={t('epfEmployerThreshold')} value={rm(ruleset.epf.employerThreshold)} />
          {/* contribCeiling is a statutory contribution ceiling shown alongside EPF (feedback e776d17d). */}
          <Row label={t('contribCeiling')} value={rm(ruleset.contribCeiling)} />
        </div>
        <SourceMeta src={src.epf} label={t('verified')} />
      </Card>

      {/* Inline scalar override — publish an effective-dated EPF rate override that merges onto the current
          EPF slice (Part A / Part E / non-citizen bands survive). Returns to this tab on save. */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold">{t('componentTitle')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('componentIntro')}</p>
        <StatutoryComponentForm
          defaults={buildComponentDefaults(ruleset)}
          labels={buildComponentLabels(t, SELF)}
          lockedBody="epf"
          returnTo={SELF}
        />
        <OverrideHistoryTable rows={epfOverrides} t={t} />
      </Card>
    </div>
  );
}
