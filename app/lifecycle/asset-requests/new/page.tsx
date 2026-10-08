import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { listCatalogue, listMyEmployerCompanies } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../../_guard';
import { createAssetRequestAction, loadCatalogueAction } from '../../actions';

export default async function NewAssetRequestPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { s, level } = await lifecycleSession(0);
  const t = await getTranslations('lifecycle');
  const { error } = await searchParams;
  const [catalogue, companies] = await Promise.all([listCatalogue(s), listMyEmployerCompanies(s)]);
  const items = catalogue.filter((c) => c.active);
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={t('requests.new')} back={{ href: '/lifecycle/asset-requests', label: t('requests.title') }} />
      <ErrorBanner message={error} />
      {items.length === 0 ? (
        <Card className="space-y-3 p-6 text-sm text-muted-foreground">
          <p>{t('requests.catalogueEmpty')}</p>
          {level >= 2 && (
            <form action={loadCatalogueAction}><p className="mb-2">{t('requests.catalogueEmptyManager')}</p><Button type="submit" size="sm">{t('requests.loadCatalogue')}</Button></form>
          )}
        </Card>
      ) : companies.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">{t('requests.noEmployer')}</Card>
      ) : (
        <Card className="p-4">
          <form action={createAssetRequestAction} className="grid gap-3 sm:grid-cols-2">
            <Field label={t('requests.item')} required className="col-span-full">
              <select name="catalogueId" required className={inputCls}>
                {items.map((c) => <option key={c.id} value={c.id}>{c.itemCode} · {c.itemName} ({t('requests.levels', { count: c.approvalLevels })})</option>)}
              </select>
            </Field>
            <Field label={t('common.company')} required>
              <select name="companyId" required className={inputCls}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </Field>
            <Field label={t('requests.quantity')}><input name="quantity" type="number" min={1} max={999} defaultValue={1} className={inputCls} /></Field>
            <Field label={t('requests.preferred')}><input name="preferredDate" type="date" className={inputCls} /></Field>
            <Field label={t('requests.justification')} className="col-span-full"><textarea name="justification" rows={3} className={`${inputCls} h-auto py-2`} /></Field>
            <div className="col-span-full"><Button type="submit">{t('requests.submit')}</Button></div>
          </form>
        </Card>
      )}
    </div>
  );
}
