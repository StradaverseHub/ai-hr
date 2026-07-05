import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { packFor } from '@/localization/registry';
import { Button, Card, ErrorBanner, PageHeader } from '@/components/ui';
import { settingsBack } from '@/app/payroll/setup/back';
import { PayrollTabs } from '@/components/payroll-tabs';
import { StatutoryConfigForm } from '@/components/statutory-config-form';
import { StatutoryComponentForm } from '@/components/statutory-component-form';
import { MY_HRDF, STATUTORY_BODIES, type ContribBand } from '@/localization/my/statutory-tables';
import type { StatutorySource } from '@/localization/my/statutory-config';
import { latestAvailablePackVersion } from '@/lib/statutory-pack-available';
import { archiveStatutoryAction, archiveStatutoryComponentAction } from './actions';
import Link from 'next/link';

const BASE = '/payroll/configuration';

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

/** Scalar per-body sections that get an inline Edit form (whole-ruleset bodies use ?edit=1 instead). */
type ScalarSection = 'epf' | 'ot';
const SCALAR_SECTIONS: ScalarSection[] = ['epf', 'ot'];
const isScalarSection = (v: string | undefined): v is ScalarSection =>
  v != null && (SCALAR_SECTIONS as string[]).includes(v);

export default async function StatutoryConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; error?: string; section?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.config');
  const { edit, error, section } = await searchParams;
  const activeSection = isScalarSection(section) ? section : undefined;
  const back = await settingsBack();
  const pack = packFor('MY');

  if (!pack) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader title={t('title')} back={back} />
        <ErrorBanner message="No localization pack for MY." />
      </div>
    );
  }

  const [{ ruleset, source, row, packVersion, issuedAt, components }, history, packs, syncStatus, componentOverrides] =
    await Promise.all([
      pack.statutoryConfig.readActive(s),
      pack.statutoryConfig.list(s),
      pack.statutoryConfig.listPacks(s),
      pack.statutoryConfig.syncStatus(s),
      pack.statutoryConfig.listComponents(s),
    ]);
  const latestAvailable = latestAvailablePackVersion();
  const stale = !!(latestAvailable && (!syncStatus.latestIngested || latestAvailable > syncStatus.latestIngested));
  const sources = pack.statutoryConfig.sources;
  const src = Object.fromEntries(sources.map((x) => [x.key, x])) as Record<string, StatutorySource>;

  // ─────────────────────────────── Edit mode ───────────────────────────────
  if (edit) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader
          title={t('editTitle')}
          back={back}
          actions={
            <Link href="/payroll/configuration">
              <Button variant="outline" size="sm">
                {t('view')}
              </Button>
            </Link>
          }
        />
        {/* Config page lives under the Settings tab (arrived via Settings -> Statutory Configuration);
            URL intentionally stays /payroll/configuration so existing bookmarks/actions BASE keep working
            — do not repoint to /payroll/setup. */}
        <PayrollTabs active="setup" />
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

  // Labels for the per-body scalar override form — shared between the inline section forms and the
  // bottom shared form so copy stays consistent.
  const componentDefaults = {
    epf: {
      employeeRate: ruleset.epf.employeeRate,
      employerRateLow: ruleset.epf.employerRateLow,
      employerRateHigh: ruleset.epf.employerRateHigh,
      employerThreshold: ruleset.epf.employerThreshold,
    },
    ot: {
      wageCeiling: ruleset.ot.wageCeiling,
      restDayExcessMultiplier: ruleset.ot.restDayExcessMultiplier ?? 2,
      holidayExcessMultiplier: ruleset.ot.holidayExcessMultiplier ?? 3,
    },
    hrdf: ruleset.hrdf ?? MY_HRDF,
  };
  const componentLabels = {
    body: t('componentBody'),
    body_epf: t('body_epf'),
    body_ot: t('body_ot'),
    body_hrdf: t('body_hrdf'),
    effectiveFrom: t('effectiveFrom'),
    version: t('version'),
    notes: t('fieldNotes'),
    epfEmployeeRate: t('epfEmployeeRate'),
    epfEmployerRateLow: t('epfEmployerRateLow'),
    epfEmployerRateHigh: t('epfEmployerRateHigh'),
    epfEmployerThreshold: t('epfEmployerThreshold'),
    otWageCeiling: t('otWageCeiling'),
    otRestDayExcessMultiplier: t('otRestDayExcessMultiplier'),
    otHolidayExcessMultiplier: t('otHolidayExcessMultiplier'),
    hrdfMandatory: t('hrdfMandatory'),
    hrdfOptional: t('hrdfOptional'),
    publish: t('componentPublish'),
    cancelEdit: t('cancelEdit'),
    cancelHref: BASE,
  };

  // Concurrency-mitigation hint (ADR-0037 revision): surface the newest live override per body so an
  // admin can eyeball whether it changed since they opened the page. Newest-effective row wins; archived
  // rows are ignored. Pre-existing insert-only model — no locking added in this pass.
  const latestOverrideByBody = new Map<string, { version: string; effectiveFrom: string }>();
  for (const co of componentOverrides) {
    if (co.archivedAt) continue;
    if (!latestOverrideByBody.has(co.body))
      latestOverrideByBody.set(co.body, { version: co.version, effectiveFrom: co.effectiveFrom });
  }
  const lastEditedHint = (body: string) => {
    const o = latestOverrideByBody.get(body);
    return o ? t('lastEdited', { version: o.version, effectiveFrom: o.effectiveFrom }) : null;
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        back={back}
        actions={
          <Link href="/payroll/configuration?edit=1">
            <Button size="sm">{t('edit')}</Button>
          </Link>
        }
      />
      {/* Config page lives under the Settings tab (arrived via Settings -> Statutory Configuration);
          URL intentionally stays /payroll/configuration so existing bookmarks/actions BASE keep working
          — do not repoint to /payroll/setup. */}
      <PayrollTabs active="setup" />
      <ErrorBanner message={error} />

      {/* Active-set banner — three-way: built-in default / vendor pack / tenant override */}
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
              source === 'override'
                ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400'
                : source === 'pack'
                  ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400'
                  : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
            }`}
          >
            {source === 'override' ? t('activeOverride') : source === 'pack' ? t('activePack') : t('activeDefault')}
          </span>
          <span className="font-mono text-sm font-medium">{ruleset.version}</span>
        </div>
        {source === 'override' && row ? (
          <div className="text-xs text-muted-foreground">
            {t('effectiveFrom')} {row.effectiveFrom}
            {row.notes ? ` · ${row.notes}` : ''}
          </div>
        ) : source === 'pack' && packVersion ? (
          <div className="text-xs text-muted-foreground">
            {t('packVersion')} {packVersion}
            {issuedAt ? ` · ${t('issued')} ${issuedAt.slice(0, 10)}` : ''}
          </div>
        ) : null}
      </Card>

      {/* Per-body versions (ADR-0037, #6) — each statutory body resolves its own version + source */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold">{t('perBodyTitle')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('perBodySubtitle')}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {STATUTORY_BODIES.map((b) => {
            const c = components[b];
            return (
              <div key={b} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{t(`body_${b}`)}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{c.version}</div>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    c.source === 'component'
                      ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400'
                      : c.source === 'pack'
                        ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400'
                        : c.source === 'override'
                          ? 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-400'
                          : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                  }`}
                >
                  {t(`src_${c.source}`)}
                </span>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {/* EPF */}
        <Card className="p-4">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-sm font-semibold">{t('secEpf')}</h2>
            {activeSection !== 'epf' && (
              <Link href={`${BASE}?section=epf`}>
                <Button variant="outline" size="sm">
                  {t('editSection', { body: t('body_epf') })}
                </Button>
              </Link>
            )}
          </div>
          {activeSection === 'epf' ? (
            <>
              <p className="mt-2 text-xs text-muted-foreground">{t('editSectionIntro')}</p>
              <StatutoryComponentForm defaults={componentDefaults} labels={componentLabels} lockedBody="epf" />
            </>
          ) : (
            <>
              <div className="mt-2 divide-y divide-border">
                <Row label={t('epfEmployeeRate')} value={pct(ruleset.epf.employeeRate)} />
                <Row label={t('epfEmployerRateLow')} value={pct(ruleset.epf.employerRateLow)} />
                <Row label={t('epfEmployerRateHigh')} value={pct(ruleset.epf.employerRateHigh)} />
                <Row label={t('epfEmployerThreshold')} value={rm(ruleset.epf.employerThreshold)} />
              </div>
              {lastEditedHint('epf') && (
                <p className="mt-2 text-[11px] text-muted-foreground">{lastEditedHint('epf')}</p>
              )}
              <SourceMeta src={src.epf} label={t('verified')} />
            </>
          )}
        </Card>

        {/* Overtime */}
        <Card className="p-4">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-sm font-semibold">{t('secOt')}</h2>
            {activeSection !== 'ot' && (
              <Link href={`${BASE}?section=ot`}>
                <Button variant="outline" size="sm">
                  {t('editSection', { body: t('body_ot') })}
                </Button>
              </Link>
            )}
          </div>
          {activeSection === 'ot' ? (
            <>
              <p className="mt-2 text-xs text-muted-foreground">{t('editSectionIntro')}</p>
              <StatutoryComponentForm defaults={componentDefaults} labels={componentLabels} lockedBody="ot" />
            </>
          ) : (
            <>
              <div className="mt-2 divide-y divide-border">
                <Row label={t('otWageCeiling')} value={rm(ruleset.ot.wageCeiling)} />
                <Row
                  label={t('otRestDayExcessMultiplier')}
                  value={`${ruleset.ot.restDayExcessMultiplier ?? 2}×`}
                />
                <Row
                  label={t('otHolidayExcessMultiplier')}
                  value={`${ruleset.ot.holidayExcessMultiplier ?? 3}×`}
                />
                <Row label={t('contribCeiling')} value={rm(ruleset.contribCeiling)} />
              </div>
              <p className="mt-3 text-xs text-muted-foreground">{t('otMultipliersNote')}</p>
              {lastEditedHint('ot') && (
                <p className="mt-2 text-[11px] text-muted-foreground">{lastEditedHint('ot')}</p>
              )}
              <SourceMeta src={src.ot} label={t('verified')} />
            </>
          )}
        </Card>

        {/* SOCSO */}
        <Card className="p-4">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-sm font-semibold">{t('secSocso')}</h2>
            <Link href={`${BASE}?edit=1`}>
              <Button variant="outline" size="sm">
                {t('editSection', { body: t('body_socso') })}
              </Button>
            </Link>
          </div>
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
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-sm font-semibold">{t('secEis')}</h2>
            <Link href={`${BASE}?edit=1`}>
              <Button variant="outline" size="sm">
                {t('editSection', { body: t('body_eis') })}
              </Button>
            </Link>
          </div>
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
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('secPcb')}</h2>
          <Link href={`${BASE}?edit=1`}>
            <Button variant="outline" size="sm">
              {t('editSection', { body: t('body_pcb') })}
            </Button>
          </Link>
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

      {/* Per-body overrides (ADR-0037, #6) — publish a single-body, effective-dated override + history */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold">{t('componentTitle')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('componentIntro')}</p>
        <StatutoryComponentForm defaults={componentDefaults} labels={componentLabels} />
        {componentOverrides.length > 0 && (
          <div className="mt-4 overflow-x-auto border-t border-border pt-3">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-4 font-medium">{t('componentBody')}</th>
                  <th className="py-1.5 pr-4 font-medium">{t('version')}</th>
                  <th className="py-1.5 pr-4 font-medium">{t('effectiveFrom')}</th>
                  <th className="py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {componentOverrides.map((co) => (
                  <tr key={co.id} className="border-t border-border align-top">
                    <td className="py-2 pr-4 font-medium">{t(`body_${co.body}`)}</td>
                    <td className="py-2 pr-4">
                      <span className="font-mono">{co.version}</span>
                      {co.archivedAt && (
                        <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {t('archived')}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{co.effectiveFrom}</td>
                    <td className="py-2 text-right">
                      {!co.archivedAt && (
                        <form action={archiveStatutoryComponentAction}>
                          <input type="hidden" name="id" value={co.id} />
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

      {/* Vendor pack panel + staleness (ADR-0020 §8) */}
      <Card className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('packsTitle')}</h2>
          <span className="text-xs text-muted-foreground">
            {syncStatus.lastSync
              ? `${t('lastSync')} ${syncStatus.lastSync.ranAt.slice(0, 16).replace('T', ' ')}`
              : t('neverSynced')}
          </span>
        </div>

        {stale && (
          <div className="mt-3 rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            {t('staleWarn', { available: latestAvailable ?? '', ingested: syncStatus.latestIngested ?? '—' })}
          </div>
        )}
        {syncStatus.lastSync && syncStatus.lastSync.failed > 0 && (
          <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {t('syncFailed', { count: syncStatus.lastSync.failed })}
          </div>
        )}

        {packs.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t('packsNone')}</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-4 font-medium">{t('packVersion')}</th>
                  <th className="py-1.5 pr-4 font-medium">{t('version')}</th>
                  <th className="py-1.5 pr-4 font-medium">{t('effectiveFrom')}</th>
                  <th className="py-1.5 pr-4 font-medium">{t('colSignedBy')}</th>
                  <th className="py-1.5 font-medium">{t('colValidUntil')}</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {packs.map((pk) => (
                  <tr key={pk.id} className="border-t border-border">
                    <td className="py-2 pr-4 font-mono font-medium">{pk.packVersion}</td>
                    <td className="py-2 pr-4 font-mono">{pk.rulesetVersion}</td>
                    <td className="py-2 pr-4">{pk.effectiveFrom}</td>
                    <td className="py-2 pr-4">
                      <span className="font-mono text-xs">{pk.signedKeyId}</span>
                      {pk.keyRevoked && (
                        <span className="ml-2 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                          {t('revoked')}
                        </span>
                      )}
                    </td>
                    <td className="py-2">{pk.validUntil.slice(0, 10)}</td>
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
