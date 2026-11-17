import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { btnGhost, btnPrimary } from '@/components/ui';
import { EXPORT_COLUMNS, EXPORT_MAX_ROWS, RESTRICTED_EXPORT_COLUMNS, exportColumnChoices, exportTemplates, type ExportKind } from '@/packs/recruitment/service';
import { selectCls } from './shared';

/**
 * Recruitment slice 16 — "Export" on the Candidates board, the talent pool and a job's interviews: a small form that downloads the
 * current view (its filters travel as hidden fields) as CSV or Excel, with the default columns, a saved column set, or the columns
 * ticked here. The file is made on request from what the viewer may read and is not stored; the route records who exported what.
 */
export async function ExportPanel({ s, kind, companyIds, filters, returnTo }: {
  s: SessionContext; kind: ExportKind; companyIds: string[]; filters: Record<string, string | undefined>; returnTo: string;
}) {
  const [t, locale] = await Promise.all([getTranslations('recruitment.exports'), getLocale()]);
  const [choices, templates] = await Promise.all([exportColumnChoices(s, companyIds, kind, locale), exportTemplates(s, companyIds, kind)]);
  const defaults = new Set(EXPORT_COLUMNS[kind].filter(([, on]) => on).map(([k]) => k));
  return (
    <details className="group rounded-xl border border-border bg-card">
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold">{t(`open.${kind}`)}</summary>
      <form method="get" action="/recruitment/export" className="space-y-3 border-t border-border px-4 py-3">
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="returnTo" value={returnTo} />
        {Object.entries(filters).filter(([, v]) => v).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <fieldset className="flex flex-wrap gap-4 text-sm">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">{t('format')}</legend>
          <label className="flex items-center gap-1.5"><input type="radio" name="format" value="xlsx" defaultChecked className="accent-primary" />{t('xlsx')}</label>
          <label className="flex items-center gap-1.5"><input type="radio" name="format" value="csv" className="accent-primary" />{t('csv')}</label>
        </fieldset>
        {templates.length > 0 && (
          <label className="block space-y-1 text-sm">
            <span className="block text-xs font-medium text-muted-foreground">{t('template')}</span>
            <select name="template" defaultValue="" className={selectCls}>
              <option value="">{t('templateNone')}</option>
              {templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
        )}
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-muted-foreground">{templates.length ? t('columnsOr') : t('columnsLegend')}</legend>
          <div className="grid max-h-56 gap-1 overflow-auto text-sm sm:grid-cols-2">
            {choices.fixed.map((c) => (
              <label key={c} className="flex items-center gap-1.5">
                <input type="checkbox" name="columns" value={c} defaultChecked={defaults.has(c)} className="accent-primary" />
                {t(`columns.${c}` as 'columns.candidateName')}{(RESTRICTED_EXPORT_COLUMNS as readonly string[]).includes(c) ? ` (${t('restricted')})` : ''}
              </label>
            ))}
            {choices.custom.map((c) => (
              <label key={c.key} className="flex items-center gap-1.5"><input type="checkbox" name="columns" value={c.key} className="accent-primary" />{c.label}</label>
            ))}
          </div>
        </fieldset>
        <p className="text-xs text-muted-foreground">{t('note', { max: EXPORT_MAX_ROWS })}</p>
        <div className="flex gap-2">
          <button type="submit" className={btnPrimary}>{t('download')}</button>
          <button type="reset" className={btnGhost}>{t('reset')}</button>
        </div>
      </form>
    </details>
  );
}
