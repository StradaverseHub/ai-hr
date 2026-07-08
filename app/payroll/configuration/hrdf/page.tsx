import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { packFor } from '@/localization/registry';
import { Card, ErrorBanner, PageHeader } from '@/components/ui';
import { settingsBack } from '@/app/payroll/setup/back';
import { PayrollTabs } from '@/components/payroll-tabs';
import { StatutoryTabs } from '@/components/statutory-tabs';
import { StatutoryComponentForm } from '@/components/statutory-component-form';
import { MY_HRDF } from '@/localization/my/statutory-tables';
import {
  pct,
  Row,
  VersionBadge,
  OverrideHistoryTable,
  buildComponentDefaults,
  buildComponentLabels,
} from '../shared';

const BASE = '/payroll/configuration';
const SELF = `${BASE}/hrdf`;

/** HRDF (HRD Corp / PSMB levy) configuration tab (31646c85 — per-body sub-menu redesign). A NET-NEW
 *  dedicated view surface: previously HRDF appeared only in the versions grid + the bottom override picker.
 *  Shows the mandatory/optional levy rates, HRDF's own built-in version record (ADR-0037 #6), and an inline
 *  scalar override form. No SourceMeta (the sources list carries no hrdf entry). No calculation change. */
export default async function HrdfConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.config');
  const { error } = await searchParams;
  const back = await settingsBack();
  const pack = packFor('MY');

  if (!pack) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader title={t('body_hrdf')} back={back} />
        <ErrorBanner message="No localization pack for MY." />
      </div>
    );
  }

  const [{ ruleset, components }, componentOverrides] = await Promise.all([
    pack.statutoryConfig.readActive(s),
    pack.statutoryConfig.listComponents(s),
  ]);
  const hrdf = ruleset.hrdf ?? MY_HRDF;
  const hrdfOverrides = componentOverrides.filter((co) => co.body === 'hrdf');

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('body_hrdf')} description={t('subtitle')} back={back} />
      <PayrollTabs active="setup" />
      <StatutoryTabs active="hrdf" />
      <ErrorBanner message={error} />

      <Card className="p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('secHrdf')}</h2>
          <VersionBadge version={components.hrdf.version} source={components.hrdf.source} label={t(`src_${components.hrdf.source}`)} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t('hrdfNote')}</p>
        <div className="mt-2 divide-y divide-border">
          <Row label={t('hrdfMandatory')} value={pct(hrdf.mandatoryRate)} />
          <Row label={t('hrdfOptional')} value={pct(hrdf.optionalRate)} />
        </div>
      </Card>

      {/* Inline scalar override — publish an effective-dated HRDF levy-rate override. Returns to this tab. */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold">{t('componentTitle')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('componentIntro')}</p>
        <StatutoryComponentForm
          defaults={buildComponentDefaults(ruleset)}
          labels={buildComponentLabels(t, SELF)}
          lockedBody="hrdf"
          returnTo={SELF}
        />
        <OverrideHistoryTable rows={hrdfOverrides} t={t} />
      </Card>
    </div>
  );
}
