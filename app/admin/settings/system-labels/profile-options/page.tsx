import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listAllProfileOptions, PROFILE_OPTION_CATEGORIES, type ProfileOptionCategory } from '@/core/profile-options';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { SystemLabelsTabs } from '@/components/system-labels-tabs';
import {
  createProfileOptionAction,
  deleteProfileOptionAction,
  seedProfileOptionsAction,
  setProfileOptionActiveAction,
  updateProfileOptionAction,
} from './actions';

// dafd475a — Profile Options is rebuilt from a stack of Cards/inline-rows into a TABLE matching the
// standardized System Labels master-data column set: Code, Label, Description, Criteria, Status, Action —
// the same header set the Organisation Labels grid now uses, so both tabs of the module read consistently.
//   - Code        = the immutable `value` (the catalog's unique key / contract with stored person data).
//   - Label       = the display text (editable).
//   - Description  = the new optional descriptive text (migration 0206; editable).
//   - Criteria     = N/A — this is a FLAT tenant-wide catalog with no company/group scope (unlike org labels).
//   - Status       = Active / Inactive.
//   - Action       = Save / Activate·Deactivate / Delete (unchanged behaviour, incl. the in-use delete guard).
// Inline editing keeps working WITHOUT client JS: each row's Label/Description/Sort inputs live in their own
// table cells and associate with a hidden per-row <form> via the HTML `form=` attribute; the submit lives
// inside that form. core/profile-options.ts governs value-immutability + legacy-value tolerance (unchanged).
// Guard stays requireAdmin (tenant-wide catalog, not company-scoped).
export default async function ProfileOptionsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.profileOptions');
  const { error } = await searchParams;
  const all = await listAllProfileOptions(s, { activeOnly: false });
  const totalCount = Object.values(all).reduce((n, rows) => n + rows.length, 0);

  const categoryLabel = (c: ProfileOptionCategory) => t(`category.${c}`);

  const th = 'px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground';
  const td = 'px-3 py-2 align-middle';

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <SystemLabelsTabs active="profile-options" />
      <ErrorBanner message={error} />

      {totalCount === 0 && (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-muted-foreground">{t('emptyAll')}</p>
          <form action={seedProfileOptionsAction}>
            <Button type="submit">{t('seedDefaults')}</Button>
          </form>
        </Card>
      )}

      {PROFILE_OPTION_CATEGORIES.map((category) => {
        const rows = all[category];
        const addFormId = `po-add-${category}`;
        return (
          <Card key={category} className="overflow-hidden">
            <SectionHeader title={categoryLabel(category)} count={rows.length} />
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className={th}>{t('col.code')}</th>
                    <th className={th}>{t('col.label')}</th>
                    <th className={th}>{t('col.description')}</th>
                    <th className={th}>{t('col.criteria')}</th>
                    <th className={th}>{t('col.status')}</th>
                    <th className={`${th} text-right`}>{t('col.action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td className="px-3 py-4 text-sm text-muted-foreground" colSpan={6}>
                        {t('emptyCategory')}
                      </td>
                    </tr>
                  )}
                  {rows.map((o) => {
                    const editFormId = `po-edit-${o.id}`;
                    return (
                      <tr key={o.id} className={`border-t border-border/60 ${o.isActive ? '' : 'opacity-60'}`}>
                        {/* Code = the immutable value */}
                        <td className={`${td} font-mono text-xs text-muted-foreground`}>{o.value}</td>
                        {/* Label (editable, associated with the row's edit form by id) */}
                        <td className={td}>
                          <input
                            name="label"
                            form={editFormId}
                            defaultValue={o.label}
                            aria-label={t('col.label')}
                            className={`${inputCls} h-8 w-40`}
                          />
                        </td>
                        {/* Description (editable) */}
                        <td className={td}>
                          <input
                            name="description"
                            form={editFormId}
                            defaultValue={o.description ?? ''}
                            aria-label={t('col.description')}
                            placeholder={t('descriptionPlaceholder')}
                            className={`${inputCls} h-8 w-56`}
                          />
                        </td>
                        {/* Criteria — not applicable to this flat tenant-wide catalog */}
                        <td className={`${td} text-xs text-muted-foreground`}>{t('criteriaNa')}</td>
                        {/* Status */}
                        <td className={td}>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                              o.isActive
                                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                : 'bg-muted text-muted-foreground'
                            }`}
                          >
                            {o.isActive ? t('statusActive') : t('statusInactive')}
                          </span>
                        </td>
                        {/* Action */}
                        <td className={`${td} text-right`}>
                          <div className="inline-flex flex-wrap items-center justify-end gap-2">
                            {/* Edit form: hosts the hidden id + Sort input + Save submit; the Label/Description
                                inputs above associate with it via form={editFormId}. */}
                            <form id={editFormId} action={updateProfileOptionAction} className="inline-flex items-center gap-2">
                              <input type="hidden" name="id" value={o.id} />
                              <input
                                name="sortOrder"
                                type="number"
                                step="1"
                                defaultValue={o.sortOrder}
                                aria-label={t('sortOrderLabel')}
                                title={t('sortOrderLabel')}
                                className={`${inputCls} h-8 w-16`}
                              />
                              <Button type="submit" size="sm" variant="secondary">
                                {t('save')}
                              </Button>
                            </form>
                            <form action={setProfileOptionActiveAction}>
                              <input type="hidden" name="id" value={o.id} />
                              <input type="hidden" name="isActive" value={o.isActive ? 'false' : 'true'} />
                              <Button type="submit" size="sm" variant="secondary">
                                {o.isActive ? t('deactivate') : t('activate')}
                              </Button>
                            </form>
                            <form action={deleteProfileOptionAction}>
                              <input type="hidden" name="id" value={o.id} />
                              <ConfirmSubmit
                                size="sm"
                                variant="ghost"
                                className="text-destructive hover:text-destructive"
                                title={t('deleteTitle')}
                                description={t('deleteDescription', { value: o.value })}
                                confirmLabel={t('delete')}
                              >
                                {t('delete')}
                              </ConfirmSubmit>
                            </form>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {/* Add row — inputs associate with the category's add form by id. */}
                  <tr className="border-t border-border bg-muted/20">
                    <td className={td}>
                      <input
                        name="value"
                        form={addFormId}
                        required
                        placeholder={t('valuePlaceholder')}
                        aria-label={t('valueLabel')}
                        className={`${inputCls} h-8 w-40`}
                      />
                    </td>
                    <td className={td}>
                      <input
                        name="label"
                        form={addFormId}
                        placeholder={t('labelPlaceholder')}
                        aria-label={t('col.label')}
                        className={`${inputCls} h-8 w-40`}
                      />
                    </td>
                    <td className={td}>
                      <input
                        name="description"
                        form={addFormId}
                        placeholder={t('descriptionPlaceholder')}
                        aria-label={t('col.description')}
                        className={`${inputCls} h-8 w-56`}
                      />
                    </td>
                    <td className={`${td} text-xs text-muted-foreground`}>{t('criteriaNa')}</td>
                    <td className={td} />
                    <td className={`${td} text-right`}>
                      <form id={addFormId} action={createProfileOptionAction} className="inline-flex items-center justify-end gap-2">
                        <input type="hidden" name="category" value={category} />
                        <input type="hidden" name="sortOrder" value={rows.length} />
                        <Button type="submit" size="sm">
                          {t('add')}
                        </Button>
                      </form>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
      <p className="text-xs text-muted-foreground">{t('legacyNote')}</p>
    </div>
  );
}
