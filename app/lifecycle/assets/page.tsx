import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, PageHeader, tableWrapCls, tbodyCls, theadCls, thCls } from '@/components/ui';
import { ASSET_STATUSES, ASSET_TYPES, LEVEL, assetStatusCounts, listAssets, listMyCompanies, type AssetStatus, type AssetType } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../_guard';
import { LifecycleTabs, Pill, fmt } from '../_ui';
import { bulkAssetStatusAction } from '../actions';

const pick = <T extends string>(v: string | undefined, all: readonly T[]): T | undefined => (all as readonly string[]).includes(v ?? '') ? (v as T) : undefined;

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ company?: string; type?: string; status?: string; q?: string; expiring?: string; error?: string }> }) {
  const { s, level } = await lifecycleSession(LEVEL.agent);
  const t = await getTranslations('lifecycle');
  const sp = await searchParams;
  const companies = await listMyCompanies(s);
  const companyId = companies.find((c) => c.id === sp.company)?.id;
  const [rows, counts] = await Promise.all([
    listAssets(s, { companyId, assetType: pick(sp.type, ASSET_TYPES) as AssetType | undefined, status: pick(sp.status, ASSET_STATUSES) as AssetStatus | undefined, search: sp.q, expiringWarranty: sp.expiring === '1' }),
    assetStatusCounts(s, companyId),
  ]);
  const sel = 'h-9 rounded-md border border-input bg-card px-2 text-sm';
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('assets.title')} description={t('assets.subtitle')} actions={<Link href="/lifecycle/assets/new"><Button size="sm">{t('assets.register')}</Button></Link>} />
      <ErrorBanner message={sp.error} />
      <LifecycleTabs level={level} active="assets" />
      <div className="flex flex-wrap gap-3 text-sm">
        {ASSET_STATUSES.map((x) => <span key={x} className="rounded-md border border-border px-3 py-1.5"><span className="font-semibold tabular-nums">{counts[x] ?? 0}</span> <span className="text-muted-foreground">{t(`assetStatus.${x}`)}</span></span>)}
      </div>
      <form className="flex flex-wrap items-center gap-2 text-sm">
        <input name="q" defaultValue={sp.q ?? ''} placeholder={t('assets.search')} aria-label={t('assets.search')} className="h-9 w-56 rounded-md border border-input bg-card px-3 text-sm" />
        <select name="company" defaultValue={sp.company ?? ''} className={sel} aria-label={t('common.company')}><option value="">{t('common.company')}: {t('common.all')}</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select name="type" defaultValue={sp.type ?? ''} className={sel} aria-label={t('assets.type')}><option value="">{t('assets.type')}: {t('common.all')}</option>{ASSET_TYPES.map((x) => <option key={x} value={x}>{t(`assetType.${x}`)}</option>)}</select>
        <select name="status" defaultValue={sp.status ?? ''} className={sel} aria-label={t('common.status')}><option value="">{t('common.status')}: {t('common.all')}</option>{ASSET_STATUSES.map((x) => <option key={x} value={x}>{t(`assetStatus.${x}`)}</option>)}</select>
        <label className="flex items-center gap-1.5"><input type="checkbox" name="expiring" value="1" defaultChecked={sp.expiring === '1'} className="size-4" />{t('assets.expiring')}</label>
        <Button type="submit" size="sm" variant="outline">{t('common.filter')}</Button>
        {level >= LEVEL.manager && <a className="ml-auto text-primary underline-offset-2 hover:underline" href="/lifecycle/export/assets">{t('common.exportCsv')}</a>}
      </form>
      <form action={bulkAssetStatusAction}>
        <Card className={tableWrapCls}>
          <table className="w-full text-sm">
            <thead className={theadCls}><tr><th className="w-8 px-3 py-2" /><th className={thCls}>{t('assets.code')}</th><th className={thCls}>{t('assets.type')}</th><th className={thCls}>{t('assets.model')}</th><th className={thCls}>{t('assets.serial')}</th><th className={thCls}>{t('assets.holder')}</th><th className={thCls}>{t('assets.warranty')}</th><th className={thCls}>{t('common.status')}</th></tr></thead>
            <tbody className={tbodyCls}>
              {rows.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">{t('assets.empty')}</td></tr>}
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="px-3 py-2"><input type="checkbox" name="codes" value={a.code} aria-label={a.code} className="size-4" /></td>
                  <td className="px-3 py-2"><Link href={`/lifecycle/assets/${a.code}`} className="text-primary underline-offset-2 hover:underline">{a.code}</Link></td>
                  <td className="px-3 py-2">{t(`assetType.${a.assetType}`)}</td>
                  <td className="px-3 py-2">{[a.manufacturer, a.model].filter(Boolean).join(' ') || '—'}</td>
                  <td className="px-3 py-2">{a.serialNo ?? '—'}</td>
                  <td className="px-3 py-2">{a.userName ?? '—'}</td>
                  <td className="px-3 py-2 tabular-nums">{fmt(a.warrantyEnd)}</td>
                  <td className="px-3 py-2"><Pill value={a.status} label={t(`assetStatus.${a.status}`)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        {rows.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t('assets.bulk')}</span>
            <select name="status" className={sel} aria-label={t('assets.bulk')}>{ASSET_STATUSES.filter((x) => x !== 'issued').map((x) => <option key={x} value={x}>{t(`assetStatus.${x}`)}</option>)}</select>
            <Button type="submit" size="sm" variant="outline">{t('assets.applyBulk')}</Button>
            <span className="text-xs text-muted-foreground">{t('assets.bulkHint')}</span>
          </div>
        )}
      </form>
    </div>
  );
}
