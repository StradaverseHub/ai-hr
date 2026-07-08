import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { packFor } from '@/localization/registry';
import { Button, Card, ErrorBanner, PageHeader } from '@/components/ui';
import { settingsBack } from '@/app/payroll/setup/back';
import { PayrollTabs } from '@/components/payroll-tabs';
import { StatutoryTabs } from '@/components/statutory-tabs';
import { StatutoryConfigForm } from '@/components/statutory-config-form';
import { STATUTORY_BODIES } from '@/localization/my/statutory-tables';
import { latestAvailablePackVersion } from '@/lib/statutory-pack-available';
import { archiveStatutoryAction } from './actions';
import Link from 'next/link';
import { redirect } from 'next/navigation';

const BASE = '/payroll/configuration';

export default async function StatutoryConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; error?: string; section?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.config');
  const { edit, error, section } = await searchParams;
  const back = await settingsBack();
  const pack = packFor('MY');

  // Old deep-links: ?section=epf used to switch the single page into the EPF inline editor. The page is now
  // split into per-body sub-routes (31646c85), so bounce any legacy section link to that body's own tab.
  if (section && (STATUTORY_BODIES as readonly string[]).includes(section) && section !== 'ot') {
    redirect(`${BASE}/${section}`);
  }

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

  // ─────────────────────────────── Edit mode (whole ruleset) ───────────────────────────────
  // The advanced whole-ruleset editor still lives on the index behind ?edit=1 — it preserves existing
  // bookmarks and the "edit everything at once" flow. The per-body tabs add SCOPED entry points into the
  // same form (sections=[...]); they don't remove this full editor.
  if (edit) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader
          title={t('editTitle')}
          back={back}
          actions={
            <Link href={BASE}>
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
        <StatutoryTabs active="overview" />
        <ErrorBanner message={error} />
        <Card className="border-amber-300/60 bg-amber-50/50 p-4 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          {t('safetyNote')}
        </Card>
        <p className="text-sm text-muted-foreground">{t('editIntro')}</p>
        <StatutoryConfigForm ruleset={ruleset} defaultVersion={ruleset.version} />
      </div>
    );
  }

  // ─────────────────────────────── Overview (view mode) ───────────────────────────────
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        back={back}
        actions={
          <Link href={`${BASE}?edit=1`}>
            <Button size="sm">{t('edit')}</Button>
          </Link>
        }
      />
      {/* Config page lives under the Settings tab (arrived via Settings -> Statutory Configuration);
          URL intentionally stays /payroll/configuration so existing bookmarks/actions BASE keep working
          — do not repoint to /payroll/setup. */}
      <PayrollTabs active="setup" />
      <StatutoryTabs active="overview" />
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

      {/* Per-body versions (ADR-0037, #6) — each statutory body resolves its own version + source and now
          links to its own dedicated configuration tab (31646c85). */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold">{t('perBodyTitle')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('perBodySubtitle')}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {/* 'ot' is filtered from this statutory grid (feedback e776d17d) — overtime is now owned by the
              Attendance module. HAZARD H1: filter at the render site only; do NOT remove 'ot' from the
              STATUTORY_BODIES constant, or the relocated OT write path (setComponentOverrideMY body
              validation) and the kernel's own body resolution break. */}
          {STATUTORY_BODIES.filter((b) => b !== 'ot').map((b) => {
            const c = components[b];
            return (
              <Link
                key={b}
                href={`${BASE}/${b}`}
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2 transition-colors hover:border-primary/50 hover:bg-accent/40"
              >
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
              </Link>
            );
          })}
        </div>
      </Card>

      {/* Whole-ruleset version History (published via ?edit=1 or from any body tab's Advanced edit). */}
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

      {/* Per-body override history (ADR-0037, #6) — read-only roll-up across ALL bodies. The publish +
          archive controls live on each body's own tab; this overview is the at-a-glance audit list. */}
      {componentOverrides.length > 0 && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">{t('componentTitle')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('componentIntro')}</p>
          <div className="mt-3 overflow-x-auto">
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
                    <td className="py-2 pr-4 font-medium">
                      <Link href={`${BASE}/${co.body}`} className="text-primary underline-offset-2 hover:underline">
                        {t(`body_${co.body}`)}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">
                      <span className="font-mono">{co.version}</span>
                      {co.archivedAt && (
                        <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {t('archived')}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{co.effectiveFrom}</td>
                    <td className="py-2 text-right text-xs text-muted-foreground">
                      <Link href={`${BASE}/${co.body}`} className="hover:underline">
                        {t('viewBody')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

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
