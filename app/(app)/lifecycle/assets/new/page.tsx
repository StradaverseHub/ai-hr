import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { ASSET_TYPES, LEVEL, listMyCompanies } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../../_guard';
import { registerAssetAction } from '../../actions';

export default async function NewAssetPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { s } = await lifecycleSession(LEVEL.agent);
  const t = await getTranslations('lifecycle');
  const { error } = await searchParams;
  const companies = await listMyCompanies(s);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('assets.register')} description={t('assets.registerHint')} back={{ href: '/lifecycle/assets', label: t('assets.title') }} />
      <ErrorBanner message={error} />
      <Card className="p-4">
        <form action={registerAssetAction} className="grid gap-3 sm:grid-cols-2">
          <Field label={t('common.company')} required><select name="companyId" required className={inputCls}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label={t('assets.type')} required><select name="assetType" required className={inputCls}>{ASSET_TYPES.map((x) => <option key={x} value={x}>{t(`assetType.${x}`)}</option>)}</select></Field>
          <Field label={t('assets.manufacturer')}><input name="manufacturer" className={inputCls} /></Field>
          <Field label={t('assets.model')}><input name="model" className={inputCls} /></Field>
          <Field label={t('assets.serial')}><input name="serialNo" className={inputCls} /></Field>
          <Field label={t('assets.tag')}><input name="assetTag" className={inputCls} /></Field>
          <Field label={t('assets.hostname')}><input name="hostname" className={inputCls} /></Field>
          <Field label={t('assets.os')}><input name="os" className={inputCls} /></Field>
          <Field label={t('assets.cpu')}><input name="cpu" className={inputCls} /></Field>
          <Field label={t('assets.ram')}><input name="ram" className={inputCls} /></Field>
          <Field label={t('assets.storage')}><input name="storage" className={inputCls} /></Field>
          <Field label={t('assets.location')}><input name="location" className={inputCls} /></Field>
          <Field label={t('assets.purchaseDate')}><input name="purchaseDate" type="date" className={inputCls} /></Field>
          <Field label={t('assets.purchaseCost')}><input name="purchaseCost" type="number" step="0.01" min="0" className={inputCls} /></Field>
          <Field label={t('assets.warranty')}><input name="warrantyEnd" type="date" className={inputCls} /></Field>
          <Field label={t('assets.leaseEnd')}><input name="leaseEnd" type="date" className={inputCls} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="leased" className="size-4" />{t('assets.leased')}</label>
          <p className="col-span-full text-xs text-muted-foreground">{t('assets.codeHint')}</p>
          <div className="col-span-full"><Button type="submit">{t('assets.registerSubmit')}</Button></div>
        </form>
      </Card>
    </div>
  );
}
