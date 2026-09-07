import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listConfigs, formatEmployeeCode, exceedsCp39EmployeeNoLength, type ConfigRow } from '@/core/employee-id-config';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { Pager } from '@/components/pager';
import { Badge } from '@/components/ui/badge';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { createConfigAction, updateConfigAction, setStatusAction, deleteConfigAction } from './actions';

const PAGE = '/admin/settings/employee-id';

/** Safe preview of the first ID the setup would issue (prefix + zero-padded start number + suffix). Never
 *  throws — an over-long combination is caught by the service on save; here it just falls back to a dash. */
function previewCode(prefix: string, startNumber: number, numberLength: number, suffix: string): string {
  try {
    return formatEmployeeCode(prefix.toUpperCase(), Math.max(startNumber, 0), numberLength, suffix.toUpperCase());
  } catch {
    return '—';
  }
}

export default async function EmployeeIdConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string; edit?: string; new?: string; page?: string; size?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('employeeIdConfig');
  const sp = await searchParams;
  const { error, edit, new: newParam } = sp;

  const all = await listCompanies(s);
  const companies = all.filter((c) => scopeIds.includes(c.id));
  const configs = await listConfigs(s, scopeIds);

  const companyName = (id: string | null) => (id == null ? t('scopeGlobal') : companies.find((c) => c.id === id)?.name ?? '—');
  // 9da61c86 — a list of records like its System Settings siblings, so it carries the same bar: the
  // record count, the rows-per-page choice and the position. `editing` is looked up in the WHOLE set, not
  // the page — an ?edit= link must open its row whichever page that row is on.
  const pq = parsePageQuery(sp);
  const { rows: pageConfigs, state: pgState } = paginateRows(configs, pq);

  const editing: ConfigRow | null = edit ? configs.find((c) => c.id === edit) ?? null : null;
  const showForm = Boolean(editing || newParam);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      {error && <ErrorBanner message={error} />}

      <p className="rounded-[1.25rem] border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
        {t('gapNotice')}
      </p>

      {/* Non-blocking CP39 heads-up (feedback de2823cc): long formats stay fully allowed, but the LHDN
          CP39 file's employee-no field is fixed at 10 chars, so surface a gentle note when any saved
          template would generate longer IDs. */}
      {configs.some((c) => exceedsCp39EmployeeNoLength(c.prefix, c.numberLength, c.suffix)) && (
        <p className="rounded-[1.25rem] border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          {t('cp39LengthNote')}
        </p>
      )}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 pr-4">
          <SectionHeader title={t('catalogTitle')} count={configs.length} />
          <Link href={`${PAGE}?new=1`} className={btnPrimary}>
            {t('createNew')}
          </Link>
        </div>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colTemplate')}</th>
                <th className="px-4 py-2 font-medium">{t('colScope')}</th>
                <th className="px-4 py-2 font-medium">{t('colPrefix')}</th>
                <th className="px-4 py-2 font-medium">{t('colSuffix')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('colStart')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('colLength')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('colCurrent')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('colManualOverride')}</th>
                <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pageConfigs.map((c) => (
                <tr key={c.id} className={editing?.id === c.id ? 'bg-primary/5' : undefined}>
                  <td className="px-4 py-2.5">
                    {c.templateName ? c.templateName : <span className="text-muted-foreground">{t('templateUnnamed')}</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    {c.companyId == null ? (
                      <Badge variant="default">{t('scopeGlobal')}</Badge>
                    ) : (
                      <span className="text-muted-foreground">{companyName(c.companyId)}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono font-medium">{c.prefix}</td>
                  <td className="px-4 py-2.5 font-mono">{c.suffix || <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-4 py-2.5 text-center tabular-nums">{c.startNumber}</td>
                  <td className="px-4 py-2.5 text-center tabular-nums">{c.numberLength}</td>
                  <td className="px-4 py-2.5 text-center tabular-nums">{c.currentRunningNumber}</td>
                  <td className="px-4 py-2.5 text-center">{c.allowManualOverride ? t('yes') : t('no')}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant={c.status === 'active' ? 'success' : 'default'}>{t(`status.${c.status}`)}</Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-3">
                      <Link href={`${PAGE}?edit=${c.id}`} className="text-xs font-medium text-primary hover:underline">
                        {t('edit')}
                      </Link>
                      <form action={setStatusAction}>
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="status" value={c.status === 'active' ? 'inactive' : 'active'} />
                        <button className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">
                          {c.status === 'active' ? t('deactivate') : t('activate')}
                        </button>
                      </form>
                      <form action={deleteConfigAction}>
                        <input type="hidden" name="id" value={c.id} />
                        <ConfirmSubmit
                          title={t('deleteTitle')}
                          description={t('deleteDescription', { prefix: c.prefix })}
                          confirmLabel={t('delete')}
                          size="sm"
                        >
                          {t('delete')}
                        </ConfirmSubmit>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
              {configs.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">
                    {t('empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager basePath={PAGE} state={pgState} />
      </Card>

      {showForm && (
        <Card className="p-5">
          <SectionHeader title={editing ? t('editTitle') : t('createTitle')} />
          <form action={editing ? updateConfigAction : createConfigAction} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {editing && <input type="hidden" name="id" value={editing.id} />}

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('fieldScope')}</span>
              {editing ? (
                // Scope is immutable on edit (it decides the uniqueness index) — show it read-only.
                <input className={inputCls} value={companyName(editing.companyId)} readOnly disabled />
              ) : (
                <select name="companyId" defaultValue="" className={inputCls}>
                  <option value="">{t('scopeGlobal')}</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
              <span className="text-xs text-muted-foreground">{t('fieldScopeHint')}</span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('fieldTemplateName')}</span>
              <input
                name="templateName"
                defaultValue={editing?.templateName ?? ''}
                maxLength={80}
                placeholder={t('fieldTemplateNamePlaceholder')}
                className={inputCls}
              />
              <span className="text-xs text-muted-foreground">{t('fieldTemplateNameHint')}</span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('fieldPrefix')}</span>
              <input
                name="prefix"
                defaultValue={editing?.prefix ?? ''}
                required
                maxLength={29}
                placeholder="EMP"
                className={`${inputCls} font-mono uppercase`}
              />
              <span className="text-xs text-muted-foreground">{t('fieldPrefixHint')}</span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('fieldSuffix')}</span>
              <input
                name="suffix"
                defaultValue={editing?.suffix ?? ''}
                maxLength={29}
                placeholder="MY"
                className={`${inputCls} font-mono uppercase`}
              />
              <span className="text-xs text-muted-foreground">{t('fieldSuffixHint')}</span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('fieldStart')}</span>
              <input name="startNumber" type="number" min={0} defaultValue={editing?.startNumber ?? 1} className={inputCls} />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('fieldLength')}</span>
              <input name="numberLength" type="number" min={1} max={15} defaultValue={editing?.numberLength ?? 4} className={inputCls} />
              <span className="text-xs text-muted-foreground">{t('fieldLengthHint')}</span>
            </label>

            {editing && (
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">{t('fieldCurrent')}</span>
                <input name="currentRunningNumber" type="number" min={0} defaultValue={editing.currentRunningNumber} className={inputCls} />
                <span className="text-xs text-muted-foreground">{t('fieldCurrentHint')}</span>
              </label>
            )}

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('fieldStatus')}</span>
              <select name="status" defaultValue={editing?.status ?? 'active'} className={inputCls}>
                <option value="active">{t('status.active')}</option>
                <option value="inactive">{t('status.inactive')}</option>
              </select>
            </label>

            <label className="flex items-start gap-2 sm:col-span-2">
              <input
                type="checkbox"
                name="allowManualOverride"
                // Item bd271009 — a NEW setup starts with manual entry PERMITTED, matching what migration
                // 0355 wrote onto every existing active row. The switch now actually hides the wizard's
                // Manual Key In option, so defaulting it off would quietly take a capability away from
                // every setup created from here on.
                defaultChecked={editing?.allowManualOverride ?? true}
                className="mt-0.5 size-4 accent-primary"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{t('fieldAllowManualOverride')}</span>
                <span className="text-xs text-muted-foreground">{t('fieldAllowManualOverrideHint')}</span>
              </span>
            </label>

            <p className="sm:col-span-2 text-sm text-muted-foreground">
              {t('previewLabel')}:{' '}
              <span className="font-mono font-semibold text-foreground">
                {previewCode(editing?.prefix ?? 'EMP', editing?.startNumber ?? 1, editing?.numberLength ?? 4, editing?.suffix ?? '')}
              </span>
            </p>

            {/* Same non-blocking CP39 note inside the form when the template being edited exceeds 10 chars. */}
            {editing && exceedsCp39EmployeeNoLength(editing.prefix, editing.numberLength, editing.suffix) && (
              <p className="sm:col-span-2 text-xs text-muted-foreground">{t('cp39LengthNote')}</p>
            )}

            <div className="sm:col-span-2 flex items-center gap-3">
              <button type="submit" className={btnPrimary}>
                {t('save')}
              </button>
              <Link href={PAGE} className="text-sm font-medium text-muted-foreground hover:text-foreground">
                {t('cancel')}
              </Link>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
