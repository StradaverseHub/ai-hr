import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { packFor } from '@/localization/registry';
import { Button, Card, ErrorBanner, PageHeader } from '@/components/ui';
import { PayrollTabs } from '@/components/payroll-tabs';
import { StatutoryConfigForm } from '@/components/statutory-config-form';
import type { ContribBand } from '@/localization/my/statutory-tables';
import type { StatutorySource } from '@/localization/my/statutory-config';
import { archiveStatutoryAction } from './actions';
import Link from 'next/link';

const pct = (n: number) => {
  const v = n * 100;
  return `${Number.isInteger(v) ? v : v.toFixed(2)}%`;
};
const rm = (n: number) => `RM ${n.toLocaleString('en-MY')}`;
const fmtUpTo = (n: number | null, top: string) => (n == null || !Number.isFinite(n) ? top : rm(n));

function SourceMeta({ src, label }: { src?: StatutorySource; label: string }) {
  if (!src) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
      {src.verified && (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
          ✓ {label}
        </span>
      )}
      <span className="min-w-0">{src.authority}</span>
      <a
        href={src.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline-offset-2 hover:underline"
      >
        ↗ source
      </a>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-mono text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

export default async function StatutoryConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.config');
  const { edit, error } = await searchParams;
  const pack = packFor('MY');

  if (!pack) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader title={t('title')} />
        <ErrorBanner message="No localization pack for MY." />
      </div>
    );
  }

  const [{ ruleset, source, row }, history] = await Promise.all([
    pack.statutoryConfig.readActive(s),
    pack.statutoryConfig.list(s),
  ]);
  const sources = pack.statutoryConfig.sources;
  const src = Object.fromEntries(sources.map((x) => [x.key, x])) as Record<string, StatutorySource>;

  // ─────────────────────────────── Edit mode ───────────────────────────────
  if (edit) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader
          title={t('editTitle')}
          actions={
            <Link href="/payroll/configuration">
              <Button variant="outline" size="sm">
                {t('view')}
              </Button>
            </Link>
          }
        />
        <PayrollTabs active="configuration" />
        <ErrorBanner message={error} />
        <Card className="border-amber-300/60 bg-amber-50/50 p-4 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          {t('safetyNote')}
        </Card>
        <p className="text-sm text-muted-foreground">{t('editIntro')}</p>
        <StatutoryConfigForm
          ruleset={ruleset}
          defaultVersion={ruleset.version}
        />
      </div>
    );
  }

  // ─────────────────────────────── View mode ───────────────────────────────
  const sampleBands = (bands: ContribBand[]) => [bands[0], bands[bands.length - 1]];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          <Link href="/payroll/configuration?edit=1">
            <Button size="sm">{t('edit')}</Button>
          </Link>
        }
      />
      <PayrollTabs active="configuration" />
      <ErrorBanner message={error} />

      {/* Active-set banner */}
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
              source === 'override'
                ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400'
                : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
            }`}
          >
            {source === 'override' ? t('activeOverride') : t('activeDefault')}
          </span>
          <span className="font-mono text-sm font-medium">{ruleset.version}</span>
        </div>
        {row && (
          <div className="text-xs text-muted-foreground">
            {t('effectiveFrom')} {row.effectiveFrom}
            {row.notes ? ` · ${row.notes}` : ''}
          </div>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {/* EPF */}
        <Card className="p-4">
          <h2 className="text-sm font-semibold">{t('secEpf')}</h2>
          <div className="mt-2 divide-y divide-border">
            <Row label={t('epfEmployeeRate')} value={pct(ruleset.epf.employeeRate)} />
            <Row label={t('epfEmployerRateLow')} value={pct(ruleset.epf.employerRateLow)} />
            <Row label={t('epfEmployerRateHigh')} value={pct(ruleset.epf.employerRateHigh)} />
            <Row label={t('epfEmployerThreshold')} value={rm(ruleset.epf.employerThreshold)} />
          </div>
          <SourceMeta src={src.epf} label={t('verified')} />
        </Card>

        {/* Overtime */}
        <Card className="p-4">
          <h2 className="text-sm font-semibold">{t('secOt')}</h2>
          <div className="mt-2 divide-y divide-border">
            <Row label={t('otWageCeiling')} value={rm(ruleset.ot.wageCeiling)} />
            <Row label={t('contribCeiling')} value={rm(ruleset.contribCeiling)} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{t('otMultipliersNote')}</p>
          <SourceMeta src={src.ot} label={t('verified')} />
        </Card>

        {/* SOCSO */}
        <Card className="p-4">
          <h2 className="text-sm font-semibold">{t('secSocso')}</h2>
          <div className="mt-2 divide-y divide-border">
            <Row label={`${t('rate')} (employer / employee)`} value={`${pct(ruleset.socso.rates.employer)} / ${pct(ruleset.socso.rates.employee)}`} />
            <Row label="Category 1 / 2 bands" value={`${ruleset.socso.category1.length} / ${ruleset.socso.category2.length}`} />
            {sampleBands(ruleset.socso.category1).map((b, i) => (
              <Row key={i} label={`Cat 1 ≤ ${fmtUpTo(b.upTo, t('topBand'))}`} value={`${rm(b.employer)} / ${rm(b.employee)}`} />
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t('bandsReadOnly', { count: ruleset.socso.category1.length })}
          </p>
          <SourceMeta src={src.socso} label={t('verified')} />
        </Card>

        {/* EIS */}
        <Card className="p-4">
          <h2 className="text-sm font-semibold">{t('secEis')}</h2>
          <div className="mt-2 divide-y divide-border">
            <Row label={`${t('rate')} (employer / employee)`} value={`${pct(ruleset.eis.rates.employer)} / ${pct(ruleset.eis.rates.employee)}`} />
            <Row label="Bands" value={String(ruleset.eis.bands.length)} />
            {sampleBands(ruleset.eis.bands).map((b, i) => (
              <Row key={i} label={`≤ ${fmtUpTo(b.upTo, t('topBand'))}`} value={`${rm(b.employer)} / ${rm(b.employee)}`} />
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t('bandsReadOnly', { count: ruleset.eis.bands.length })}
          </p>
          <SourceMeta src={src.eis} label={t('verified')} />
        </Card>
      </div>

      {/* PCB — full width */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold">{t('secPcb')}</h2>
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

      {/* History */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold">{t('history')}</h2>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t('noHistory')}</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-4 font-medium">{t('version')}</th>
                  <th className="py-1.5 pr-4 font-medium">{t('effectiveFrom')}</th>
                  <th className="py-1.5 pr-4 font-medium">{t('fieldNotes')}</th>
                  <th className="py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className="border-t border-border align-top">
                    <td className="py-2 pr-4">
                      <span className="font-mono font-medium">{h.version}</span>
                      {h.archivedAt && (
                        <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {t('archived')}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{h.effectiveFrom}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{h.notes ?? '—'}</td>
                    <td className="py-2 text-right">
                      {!h.archivedAt && (
                        <form action={archiveStatutoryAction}>
                          <input type="hidden" name="id" value={h.id} />
                          <Button type="submit" variant="ghost" size="sm">
                            {t('archive')}
                          </Button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
