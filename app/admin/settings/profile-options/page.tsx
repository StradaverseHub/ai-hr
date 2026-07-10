import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listAllProfileOptions, PROFILE_OPTION_CATEGORIES, type ProfileOptionCategory } from '@/core/profile-options';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import {
  createProfileOptionAction,
  deleteProfileOptionAction,
  seedProfileOptionsAction,
  setProfileOptionActiveAction,
  updateProfileOptionAction,
} from './actions';

export default async function ProfileOptionsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.profileOptions');
  const { error } = await searchParams;
  const all = await listAllProfileOptions(s, { activeOnly: false });
  const totalCount = Object.values(all).reduce((n, rows) => n + rows.length, 0);

  const categoryLabel = (c: ProfileOptionCategory) => t(`category.${c}`);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
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
        return (
          <Card key={category} className="overflow-hidden">
            <SectionHeader title={categoryLabel(category)} count={rows.length} />
            {rows.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">{t('emptyCategory')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {rows.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-end gap-3 px-4 py-3">
                    <span className="min-w-28 flex-1 font-mono text-xs text-muted-foreground">
                      {o.value}
                      {!o.isActive && <span className="ml-2 rounded bg-muted px-1.5 py-0.5">{t('inactiveBadge')}</span>}
                    </span>
                    <form action={updateProfileOptionAction} className="flex items-end gap-2">
                      <input type="hidden" name="id" value={o.id} />
                      <Field label={t('labelLabel')}>
                        <input name="label" defaultValue={o.label} className={`${inputCls} w-40`} />
                      </Field>
                      <Field label={t('sortOrderLabel')}>
                        <input
                          name="sortOrder"
                          type="number"
                          step="1"
                          defaultValue={o.sortOrder}
                          className={`${inputCls} w-20`}
                        />
                      </Field>
                      <Button type="submit" variant="secondary">
                        {t('save')}
                      </Button>
                    </form>
                    <form action={setProfileOptionActiveAction}>
                      <input type="hidden" name="id" value={o.id} />
                      <input type="hidden" name="isActive" value={o.isActive ? 'false' : 'true'} />
                      <Button type="submit" variant="secondary">
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
                  </li>
                ))}
              </ul>
            )}
            <form action={createProfileOptionAction} className="flex flex-wrap items-end gap-3 border-t border-border p-4">
              <input type="hidden" name="category" value={category} />
              <Field label={t('valueLabel')}>
                <input name="value" required placeholder={t('valuePlaceholder')} className={`${inputCls} w-40`} />
              </Field>
              <Field label={t('labelOptionalLabel')}>
                <input name="label" placeholder={t('labelPlaceholder')} className={`${inputCls} w-40`} />
              </Field>
              <Field label={t('sortOrderLabel')}>
                <input name="sortOrder" type="number" step="1" defaultValue={rows.length} className={`${inputCls} w-20`} />
              </Field>
              <Button type="submit">{t('add')}</Button>
            </form>
          </Card>
        );
      })}
      <p className="text-xs text-muted-foreground">{t('legacyNote')}</p>
    </div>
  );
}
