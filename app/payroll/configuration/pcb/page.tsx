import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { requireConfigSection } from '../guard';
import { Button, Card, ErrorBanner, PageHeader } from '@/components/ui';
import { settingsBack } from '@/app/payroll/setup/back';
import { StatutoryTabs } from '@/components/statutory-tabs';
import { StatutoryConfigForm } from '@/components/statutory-config-form';
import type { StatutorySource } from '@/localization/my/statutory-config';
import Link from 'next/link';
import { pct, rm, fmtUpTo, Row, SourceMeta, VersionBadge, OverrideHistoryTable } from '../shared';

const BASE = '/payroll/configuration';
const SELF = `${BASE}/pcb`;

/** PCB (MTD) configuration tab (31646c85 — per-body sub-menu redesign). Read-only reliefs + brackets with
 *  its own built-in version record (ADR-0037 #6); the LHDN bracket table is edited via Advanced edit (the
 *  shared band-table editor, PCB slice only). No calculation logic changes here. */
export default async function PcbConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.config');
  const { edit, error } = await searchParams;
  const back = await settingsBack();
  // Rung 5c (D4): resolve the acting company's pack; 404 unless it declares the PCB section.
  const pack = await requireConfigSection('pcb');

  const [{ ruleset, components }, componentOverrides] = await Promise.all([
    pack.statutoryConfig.readActive(s),
    pack.statutoryConfig.listComponents(s),
  ]);
  const src = Object.fromEntries(pack.statutoryConfig.sources.map((x) => [x.key, x])) as Record<string, StatutorySource>;

  if (edit) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader
          title={`${t('body_pcb')} · ${t('editTitle')}`}
          back={back}
          actions={
            <Link href={SELF}>
              <Button variant="outline" size="sm">
                {t('view')}
              </Button>
            </Link>
          }
        />
        <StatutoryTabs active="pcb" />
        <ErrorBanner message={error} />
        <Card className="border-amber-300/60 bg-amber-50/50 p-4 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          {t('safetyNote')}
        </Card>
        <StatutoryConfigForm
          ruleset={ruleset}
          defaultVersion={ruleset.version}
          epfScheduleFallback={pack.payroll.epfThirdSchedule}
          sections={['pcb']}
          cancelHref={SELF}
          returnTo={SELF}
        />
      </div>
    );
  }

  const pcbOverrides = componentOverrides.filter((co) => co.body === 'pcb');

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('body_pcb')}
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
      <StatutoryTabs active="pcb" />
      <ErrorBanner message={error} />

      <Card className="p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('secPcb')}</h2>
          <VersionBadge version={components.pcb.version} source={components.pcb.source} label={t(`src_${components.pcb.source}`)} />
        </div>
        <div className="mt-2 grid gap-x-8 sm:grid-cols-2">
          <Row label={t('reliefIndividual')} value={rm(ruleset.pcb.reliefs.individual)} />
          <Row label={t('reliefSpouse')} value={rm(ruleset.pcb.reliefs.spouse)} />
          <Row label={t('reliefPerChild')} value={rm(ruleset.pcb.reliefs.perChild)} />
          <Row label={t('reliefEpfCap')} value={rm(ruleset.pcb.reliefs.epfReliefCap)} />
        </div>
        <h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('pcbBands')}</h3>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-4 font-medium">{t('colUpTo')}</th>
                <th className="py-1.5 pr-4 font-medium">{t('colM')}</th>
                <th className="py-1.5 pr-4 font-medium">{t('colR')}</th>
                <th className="py-1.5 pr-4 font-medium">{t('colBCat13')}</th>
                <th className="py-1.5 font-medium">{t('colBCat2')}</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {ruleset.pcb.bands.map((b, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-1.5 pr-4">{fmtUpTo(b.upTo, t('topBand'))}</td>
                  <td className="py-1.5 pr-4">{b.M.toLocaleString('en-MY')}</td>
                  <td className="py-1.5 pr-4">{pct(b.R)}</td>
                  <td className="py-1.5 pr-4">{b.bCat13.toLocaleString('en-MY')}</td>
                  <td className="py-1.5">{b.bCat2.toLocaleString('en-MY')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <SourceMeta src={src.pcb} label={t('verified')} />
      </Card>

      {pcbOverrides.length > 0 && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">{t('componentTitle')}</h2>
          <OverrideHistoryTable rows={pcbOverrides} t={t} />
        </Card>
      )}
    </div>
  );
}
