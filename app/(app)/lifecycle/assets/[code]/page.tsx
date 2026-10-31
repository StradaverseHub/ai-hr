import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { ASSET_STATUSES, LEVEL, assetHistory, getAsset } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../../_guard';
import { HistoryList, LifecycleTabs, Pill, fmt } from '../../_ui';
import { updateAssetAction } from '../../actions';

export default async function AssetPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ error?: string }> }) {
  const { s, level } = await lifecycleSession(LEVEL.agent);
  const t = await getTranslations('lifecycle');
  const { code } = await params;
  const { error } = await searchParams;
  let a;
  try { a = await getAsset(s, code); } catch { notFound(); }
  const history = await assetHistory(s, code);
  const spec: [string, string | null][] = [
    [t('assets.manufacturer'), a.manufacturer], [t('assets.model'), a.model], [t('assets.serial'), a.serialNo], [t('assets.tag'), a.assetTag], [t('assets.hostname'), a.hostname],
    [t('assets.os'), a.os], [t('assets.cpu'), a.cpu], [t('assets.ram'), a.ram], [t('assets.storage'), a.storage], [t('assets.location'), a.location],
    [t('assets.purchaseDate'), fmt(a.purchaseDate)], [t('assets.purchaseCost'), a.purchaseCost], [t('assets.warranty'), fmt(a.warrantyEnd)],
    [t('assets.leased'), a.leased ? `${t('common.yes')}${a.leaseEnd ? ` · ${fmt(a.leaseEnd)}` : ''}` : t('common.no')],
  ];
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={`${a.code} · ${t(`assetType.${a.assetType}`)}`} back={{ href: '/lifecycle/assets', label: t('assets.title') }} actions={<Pill value={a.status} label={t(`assetStatus.${a.status}`)} />} />
      <ErrorBanner message={error} />
      <LifecycleTabs level={level} active="assets" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-1.5 p-4 text-sm">
          <h2 className="font-semibold">{t('assets.custodian')}</h2>
          {a.status === 'issued' ? (
            <>
              <div>{a.userName}{a.userEmployeeNo ? ` (${a.userEmployeeNo})` : ''}</div>
              <div className="text-muted-foreground">{[a.userDepartment, a.userEmail].filter(Boolean).join(' · ') || '—'}</div>
              <div className="text-muted-foreground">{t('assets.issuedOn')}: {fmt(a.issuedOn)}</div>
            </>
          ) : <p className="text-muted-foreground">{t('assets.noCustodian')}</p>}
        </Card>
        <Card className="space-y-1.5 p-4 text-sm">
          <h2 className="font-semibold">{t('assets.specs')}</h2>
          {spec.map(([k, v]) => <div key={k}><span className="text-muted-foreground">{k}: </span>{v || '—'}</div>)}
        </Card>
      </div>
      <details className="rounded-lg border border-border bg-card">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">{t('assets.edit')}</summary>
        <form action={updateAssetAction} className="grid gap-3 border-t border-border p-4 sm:grid-cols-2">
          <input type="hidden" name="code" value={a.code} />
          <Field label={t('assets.manufacturer')}><input name="manufacturer" defaultValue={a.manufacturer ?? ''} className={inputCls} /></Field>
          <Field label={t('assets.model')}><input name="model" defaultValue={a.model ?? ''} className={inputCls} /></Field>
          <Field label={t('assets.serial')}><input name="serialNo" defaultValue={a.serialNo ?? ''} className={inputCls} /></Field>
          <Field label={t('assets.tag')}><input name="assetTag" defaultValue={a.assetTag ?? ''} className={inputCls} /></Field>
          <Field label={t('assets.hostname')}><input name="hostname" defaultValue={a.hostname ?? ''} className={inputCls} /></Field>
          <Field label={t('assets.os')}><input name="os" defaultValue={a.os ?? ''} className={inputCls} /></Field>
          <Field label={t('assets.cpu')}><input name="cpu" defaultValue={a.cpu ?? ''} className={inputCls} /></Field>
          <Field label={t('assets.ram')}><input name="ram" defaultValue={a.ram ?? ''} className={inputCls} /></Field>
          <Field label={t('assets.storage')}><input name="storage" defaultValue={a.storage ?? ''} className={inputCls} /></Field>
          <Field label={t('assets.location')}><input name="location" defaultValue={a.location ?? ''} className={inputCls} /></Field>
          <Field label={t('assets.purchaseDate')}><input name="purchaseDate" type="date" defaultValue={a.purchaseDate ?? ''} className={inputCls} /></Field>
          <Field label={t('assets.purchaseCost')}><input name="purchaseCost" type="number" step="0.01" min="0" defaultValue={a.purchaseCost ?? ''} className={inputCls} /></Field>
          <Field label={t('assets.warranty')}><input name="warrantyEnd" type="date" defaultValue={a.warrantyEnd ?? ''} className={inputCls} /></Field>
          <Field label={t('assets.leaseEnd')}><input name="leaseEnd" type="date" defaultValue={a.leaseEnd ?? ''} className={inputCls} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="leased" defaultChecked={a.leased} className="size-4" />{t('assets.leased')}</label>
          <fieldset className="col-span-full grid gap-3 rounded-md border border-dashed border-border p-3 sm:grid-cols-2">
            <legend className="px-1 text-xs text-muted-foreground">{t('assets.changeStatus')}</legend>
            <Field label={t('common.status')}><select name="status" defaultValue="" className={inputCls}><option value="">{t('assets.keepStatus')}</option>{ASSET_STATUSES.filter((x) => x !== a.status).map((x) => <option key={x} value={x}>{t(`assetStatus.${x}`)}</option>)}</select></Field>
            <p className="self-end text-xs text-muted-foreground">{t('assets.issuedNeedsUser')}</p>
            <Field label={t('assets.holder')}><input name="userName" className={inputCls} /></Field>
            <Field label={t('case.employeeNo')}><input name="userEmployeeNo" className={inputCls} /></Field>
            <Field label={t('case.department')}><input name="userDepartment" className={inputCls} /></Field>
            <Field label={t('assets.email')}><input name="userEmail" type="email" className={inputCls} /></Field>
          </fieldset>
          <div className="col-span-full"><Button type="submit" size="sm">{t('common.save')}</Button></div>
        </form>
      </details>
      <Card className="overflow-hidden"><SectionHeader title={t('common.history')} count={history.length} /><HistoryList rows={history} /></Card>
    </div>
  );
}
