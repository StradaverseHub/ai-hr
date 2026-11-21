import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnGhost, btnPrimary } from '@/components/ui';
import { cn } from '@/lib/utils';
import {
  EXPORT_COLUMNS, EXPORT_KINDS, EXPORT_TEMPLATE_NAME_MAX, RESTRICTED_EXPORT_COLUMNS, exportColumnChoices, exportTemplates, isExportKind, type ExportKind,
} from '@/packs/recruitment/service';
import { deleteExportTemplateAction, saveExportTemplateAction } from '../actions';
import { klDateTime } from '../shared';

/**
 * Settings › Export templates (slice 16, administrators): saved column sets for each export (the Candidates board, the talent pool,
 * a job's interview feedback). Everyone who may export in the company can pick them; only administrators add, rename or delete
 * them. A set holds column names only, never data.
 */
export async function ExportTemplateSettingsSection({ s, companyId, kind: asked }: { s: SessionContext; companyId: string; kind?: string }) {
  const [t, te, locale] = await Promise.all([getTranslations('recruitment.exportTemplates'), getTranslations('recruitment.exports'), getLocale()]);
  const kind: ExportKind = isExportKind(asked) ? asked : 'board';
  const [templates, choices] = await Promise.all([exportTemplates(s, [companyId], kind), exportColumnChoices(s, [companyId], kind, locale)]);
  const href = (k: ExportKind) => `/recruitment/settings?${new URLSearchParams({ company: companyId, section: 'exports', kind: k })}`;
  const label = (c: string) => (c.startsWith('cf.') ? choices.custom.find((x) => x.key === c)?.label ?? t('removedField') : te(`columns.${c}` as 'columns.candidateName'));
  const defaults = new Set(EXPORT_COLUMNS[kind].filter(([, on]) => on).map(([k]) => k));
  const columnBoxes = (checked: (c: string) => boolean, idPrefix: string) => (
    <div className="grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {[...choices.fixed, ...choices.custom.map((c) => c.key)].map((c) => (
        <label key={c} className="flex items-center gap-1.5">
          <input type="checkbox" name="columns" value={c} defaultChecked={checked(c)} id={`${idPrefix}-${c}`} className="accent-primary" />
          {label(c)}{(RESTRICTED_EXPORT_COLUMNS as readonly string[]).includes(c) ? ` (${te('restricted')})` : ''}
        </label>
      ))}
    </div>
  );
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('note')}</p>
      <nav aria-label={t('kindLabel')} className="flex flex-wrap gap-2">
        {EXPORT_KINDS.map((k) => (
          <Link key={k} href={href(k)} aria-current={k === kind ? 'page' : undefined}
            className={cn('rounded-full border px-3 py-1 text-sm', k === kind ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent')}>
            {te(`kinds.${k}`)}
          </Link>
        ))}
      </nav>
      {templates.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-3">
          {templates.map((row) => (
            <li key={row.id} className="space-y-3 rounded-xl border border-border bg-card p-4">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{row.name}</span>
                  <span className="text-xs text-muted-foreground">{t('columnCount', { count: row.columns.length })} · {t('changed', { at: klDateTime(locale, row.updatedAt) })}</span>
                </summary>
                <form action={saveExportTemplateAction} className="mt-3 space-y-3">
                  <input type="hidden" name="templateId" value={row.id} /><input type="hidden" name="companyId" value={companyId} /><input type="hidden" name="kind" value={kind} />
                  <Field label={t('name')}><Input name="name" defaultValue={row.name} maxLength={EXPORT_TEMPLATE_NAME_MAX} required /></Field>
                  <fieldset><legend className="mb-1 text-xs font-medium text-muted-foreground">{t('columns')}</legend>{columnBoxes((c) => row.columns.includes(c), row.id)}</fieldset>
                  <button type="submit" className={btnPrimary}>{t('save')}</button>
                </form>
              </details>
              <p className="text-xs text-muted-foreground">{row.columns.map(label).join(', ')}</p>
              <form action={deleteExportTemplateAction}>
                <input type="hidden" name="templateId" value={row.id} /><input type="hidden" name="companyId" value={companyId} />
                <button type="submit" className={btnGhost} aria-label={t('deleteNamed', { name: row.name })}>{t('delete')}</button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <form action={saveExportTemplateAction} className="space-y-3 rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{t('newTitle', { kind: te(`kinds.${kind}`) })}</h2>
        <input type="hidden" name="companyId" value={companyId} /><input type="hidden" name="kind" value={kind} />
        <Field label={t('name')}><Input name="name" maxLength={EXPORT_TEMPLATE_NAME_MAX} required /></Field>
        <fieldset><legend className="mb-1 text-xs font-medium text-muted-foreground">{t('columns')}</legend>{columnBoxes((c) => defaults.has(c), 'new')}</fieldset>
        <button type="submit" className={btnPrimary}>{t('add')}</button>
      </form>
    </div>
  );
}
