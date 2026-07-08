import type { StatutorySource } from '@/localization/my/statutory-config';
import { MY_HRDF, type StatutoryRuleset } from '@/localization/my/statutory-tables';
import { Button } from '@/components/ui';
import { archiveStatutoryComponentAction } from './actions';

/** A single per-body override row as returned by pack.statutoryConfig.listComponents. */
export type ComponentOverrideRow = {
  id: string;
  body: string;
  version: string;
  effectiveFrom: string;
  archivedAt: string | null;
};

/**
 * Shared server-side helpers for the Statutory Configuration surface (31646c85 — per-body sub-menu
 * redesign). The page was split from one long scroll into an Overview tab + one tab per statutory body
 * (EPF / SOCSO / EIS / PCB / HRDF, mirroring the Leave Settings reorganization 0d147b78). These pure
 * formatters, the SourceMeta/Row/VersionBadge presentational components and the per-body scalar-override
 * label/default builders were previously inlined in page.tsx; factoring them here keeps every sub-page's
 * copy consistent without triplicating the wiring. No calculation logic lives here — presentation only.
 */

export const pct = (n: number): string => {
  const v = n * 100;
  return `${Number.isInteger(v) ? v : v.toFixed(2)}%`;
};
export const rm = (n: number): string => `RM ${n.toLocaleString('en-MY')}`;
export const fmtUpTo = (n: number | null, top: string): string =>
  n == null || !Number.isFinite(n) ? top : rm(n);

export function SourceMeta({ src, label }: { src?: StatutorySource; label: string }) {
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

export function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-mono text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

/** Per-body version + source badge (ADR-0037 #6). Reuses the versions-grid styling so a body's own tab
 *  shows the exact same independent version record the Overview grid surfaces. `source` maps to the
 *  provenance colour and the `src_*` i18n label. */
export function VersionBadge({
  version,
  source,
  label,
}: {
  version: string;
  source: string;
  /** Localized provenance label (t(`src_${source}`)). */
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-xs font-medium">{version}</span>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
          source === 'component'
            ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400'
            : source === 'pack'
              ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400'
              : source === 'override'
                ? 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-400'
                : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
        }`}
      >
        {label}
      </span>
    </div>
  );
}

/** Per-body override history table (ADR-0037 #6), scoped to ONE body's rows on its own tab. Read + the
 *  archive action; the publish form lives above it on the body tab. `rows` should already be filtered to
 *  the body. `t` is the payroll.config translator. Renders nothing when there are no rows. */
export function OverrideHistoryTable({
  rows,
  t,
}: {
  rows: ComponentOverrideRow[];
  t: (k: string) => string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-4 overflow-x-auto border-t border-border pt-3">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="py-1.5 pr-4 font-medium">{t('version')}</th>
            <th className="py-1.5 pr-4 font-medium">{t('effectiveFrom')}</th>
            <th className="py-1.5 font-medium" />
          </tr>
        </thead>
        <tbody>
          {rows.map((co) => (
            <tr key={co.id} className="border-t border-border align-top">
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
  );
}

/** Scalar-override defaults prefilled into the per-body StatutoryComponentForm. Mirrors the object that
 *  used to be inlined in page.tsx; unchanged shape so the action + kernel resolution stay identical. */
export function buildComponentDefaults(ruleset: StatutoryRuleset) {
  return {
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
}

/** Labels for the per-body scalar override form. `cancelHref` defaults to the body's own tab so a cancel
 *  returns the admin where they were. `t` is the payroll.config translator. */
export function buildComponentLabels(
  t: (k: string) => string,
  cancelHref: string,
): Record<string, string> {
  return {
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
    cancel: t('cancel'),
    cancelHref,
  };
}
