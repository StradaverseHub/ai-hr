import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { scopedAdmin } from '@/lib/scope';
import { listCards, DASHBOARD_CARD_TYPES, type DashboardCardRow } from '@/core/dashboard-card-config';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { createCardAction, updateCardAction, setStatusAction, deleteCardAction } from './actions';

const PAGE = '/admin/settings/dashboard';

export default async function DashboardCardConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string; edit?: string; new?: string }>;
}) {
  // scopedAdmin also fences the RLS session to an admin — the guard the reverse-completeness test asserts.
  const { s } = await scopedAdmin();
  const t = await getTranslations('dashboardCardConfig');
  const { error, edit, new: newParam } = await searchParams;

  const cards = await listCards(s);
  const editing: DashboardCardRow | null = edit ? cards.find((c) => c.id === edit) ?? null : null;
  const showForm = Boolean(editing || newParam);

  const yesNo = (v: boolean) => (v ? t('yes') : t('no'));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      {error && <ErrorBanner message={error} />}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 pr-4">
          <SectionHeader title={t('catalogTitle')} count={cards.length} />
          <Link href={`${PAGE}?new=1`} className={btnPrimary}>
            {t('createNew')}
          </Link>
        </div>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colName')}</th>
                <th className="px-4 py-2 font-medium">{t('colType')}</th>
                <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('colSelectable')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('colDefault')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('colMandatory')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('colOrder')}</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {cards.map((c) => (
                <tr key={c.id} className={editing?.id === c.id ? 'bg-primary/5' : undefined}>
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{c.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{c.cardKey}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant="default">{t(`type.${c.cardType}`)}</Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={c.status === 'active' ? 'success' : 'default'}>{t(`status.${c.status}`)}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-center">{yesNo(c.employeeSelectable)}</td>
                  <td className="px-4 py-2.5 text-center">{yesNo(c.defaultDisplay)}</td>
                  <td className="px-4 py-2.5 text-center">{yesNo(c.mandatory)}</td>
                  <td className="px-4 py-2.5 text-center tabular-nums">{c.displayOrder}</td>
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
                      <form action={deleteCardAction}>
                        <input type="hidden" name="id" value={c.id} />
                        <ConfirmSubmit
                          title={t('deleteTitle')}
                          description={t('deleteDescription', { name: c.name })}
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
              {cards.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    {t('empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {showForm && (
        <Card className="p-5">
          <SectionHeader title={editing ? t('editTitle') : t('createTitle')} />
          <form action={editing ? updateCardAction : createCardAction} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {editing && <input type="hidden" name="id" value={editing.id} />}

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('fieldKey')}</span>
              {editing ? (
                // card_key is immutable on edit — it binds the row to a concrete renderer.
                <input className={`${inputCls} font-mono`} value={editing.cardKey} readOnly disabled />
              ) : (
                <input name="cardKey" defaultValue="" required placeholder="myCard" className={`${inputCls} font-mono`} />
              )}
              <span className="text-xs text-muted-foreground">{t('fieldKeyHint')}</span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('fieldName')}</span>
              <input name="name" defaultValue={editing?.name ?? ''} required maxLength={120} className={inputCls} />
            </label>

            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-sm font-medium">{t('fieldDescription')}</span>
              <input name="description" defaultValue={editing?.description ?? ''} maxLength={300} className={inputCls} />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('fieldType')}</span>
              <select name="cardType" defaultValue={editing?.cardType ?? 'information'} className={inputCls}>
                {DASHBOARD_CARD_TYPES.map((ct) => (
                  <option key={ct} value={ct}>
                    {t(`type.${ct}`)}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('fieldStatus')}</span>
              <select name="status" defaultValue={editing?.status ?? 'active'} className={inputCls}>
                <option value="active">{t('status.active')}</option>
                <option value="inactive">{t('status.inactive')}</option>
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('fieldOrder')}</span>
              <input name="displayOrder" type="number" min={0} defaultValue={editing?.displayOrder ?? 0} className={inputCls} />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('fieldHref')}</span>
              <input name="href" defaultValue={editing?.href ?? ''} maxLength={200} placeholder="/leave" className={inputCls} />
              <span className="text-xs text-muted-foreground">{t('fieldHrefHint')}</span>
            </label>

            <label className="flex items-center gap-2 sm:col-span-2">
              <input type="checkbox" name="employeeSelectable" defaultChecked={editing?.employeeSelectable ?? true} className="h-4 w-4" />
              <span className="text-sm">{t('fieldSelectable')}</span>
            </label>

            <label className="flex items-center gap-2 sm:col-span-2">
              <input type="checkbox" name="defaultDisplay" defaultChecked={editing?.defaultDisplay ?? false} className="h-4 w-4" />
              <span className="text-sm">{t('fieldDefault')}</span>
            </label>

            <label className="flex items-center gap-2 sm:col-span-2">
              <input type="checkbox" name="mandatory" defaultChecked={editing?.mandatory ?? false} className="h-4 w-4" />
              <span className="text-sm">{t('fieldMandatory')}</span>
            </label>

            <p className="sm:col-span-2 text-xs text-muted-foreground">{t('mandatoryHint')}</p>

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
