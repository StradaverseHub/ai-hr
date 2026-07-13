import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { packFor } from '@/localization/registry';
import { Button, Card, ErrorBanner, PageHeader } from '@/components/ui';
import { settingsBack } from '@/app/payroll/setup/back';
import { PayrollTabs } from '@/components/payroll-tabs';
import { StatutoryTabs } from '@/components/statutory-tabs';
import { StatutoryConfigForm } from '@/components/statutory-config-form';
import type { StatutorySource } from '@/localization/my/statutory-config';
import type { SocsoBand } from '@/localization/my/statutory-tables';
import Link from 'next/link';
import { rm, fmtUpTo, SourceMeta, VersionBadge, OverrideHistoryTable } from '../shared';

const BASE = '/payroll/configuration';
const SELF = `${BASE}/skbbk`;

/**
 * SKBBK configuration tab (674ff6a5 — "Add SKBBK Tab to Statutory Configuration").
 *
 * SKBBK ("Skim Bukan Bencana Kerja" / Lindung 24 Jam, mandatory from 1 Jun 2026) is an employee-paid leg
 * carried ON the SOCSO bands: `SocsoBand = ContribBand & { skbbk: number }` (statutory-tables.ts), inside
 * `StatutoryRuleset.socso.category1/category2` — the SAME DB-backed, override-editable ruleset (ADR-0037)
 * as EPF/SOCSO. This tab does NOT introduce a new data store: it simply SURFACES the skbbk column in its
 * own tab (read-only summary) and its Advanced edit reuses the SOCSO slice of `StatutoryConfigForm`
 * (`sections={['socso']}`), so an edit round-trips the skbbk amounts back into the SOCSO override and the
 * DomainEvent is appended by `statutoryConfig.save` — no new calculation path. The payroll SKBBK leg is
 * unchanged; it keeps reading the same `socso.category1/category2[].skbbk` figures. */
export default async function SkbbkConfigPage({
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
        <PageHeader title={t('body_skbbk')} back={back} />
        <ErrorBanner message="No localization pack for MY." />
      </div>
    );
  }

  const [{ ruleset, components }, componentOverrides] = await Promise.all([
    pack.statutoryConfig.readActive(s),
    pack.statutoryConfig.listComponents(s),
  ]);
  const src = Object.fromEntries(pack.statutoryConfig.sources.map((x) => [x.key, x])) as Record<string, StatutorySource>;

  if (edit) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader
          title={`${t('body_skbbk')} · ${t('editTitle')}`}
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
        <StatutoryTabs active="skbbk" />
        <ErrorBanner message={error} />
        <Card className="border-amber-300/60 bg-amber-50/50 p-4 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          {t('skbbkEditNote')}
        </Card>
        {/* SKBBK rides on the SOCSO bands — the same 'socso' slice of the shared editor surfaces the SKBBK
            (RM) column, and a save round-trips it back into the SOCSO override (DomainEvent in save()). */}
        <StatutoryConfigForm
          ruleset={ruleset}
          defaultVersion={ruleset.version}
          sections={['socso']}
          cancelHref={SELF}
          returnTo={SELF}
        />
      </div>
    );
  }

  // Category 1 and Category 2 carry an identical SKBBK employee leg (statutory-tables.ts); render Cat 1 as
  // the canonical table and note the equivalence rather than duplicating 64 identical rows.
  const bands: SocsoBand[] = ruleset.socso.category1;
  const socsoOverrides = componentOverrides.filter((co) => co.body === 'socso');

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('body_skbbk')}
        description={t('skbbkDesc')}
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
      <StatutoryTabs active="skbbk" />
      <ErrorBanner message={error} />

      <Card className="p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('secSkbbk')}</h2>
          <VersionBadge version={components.socso.version} source={components.socso.source} label={t(`src_${components.socso.source}`)} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t('skbbkAbout')}</p>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-4 font-medium">{t('colWageTo')}</th>
                <th className="py-1.5 font-medium">{t('colSkbbkRm')}</th>
              </tr>
            </thead>
            <tbody>
              {bands.map((b, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-1.5 pr-4 font-mono tabular-nums">{fmtUpTo(b.upTo, t('topBand'))}</td>
                  <td className="py-1.5 font-mono tabular-nums">{rm(b.skbbk)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-2 text-xs text-muted-foreground">{t('skbbkBothCategories', { count: bands.length })}</p>
        <SourceMeta src={src.socso} label={t('verified')} />
      </Card>

      {socsoOverrides.length > 0 && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">{t('componentTitle')}</h2>
          <OverrideHistoryTable rows={socsoOverrides} t={t} />
        </Card>
      )}
    </div>
  );
}
