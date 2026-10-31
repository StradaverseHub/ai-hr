import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, PageHeader, tableWrapCls, tbodyCls, theadCls, thCls } from '@/components/ui';
import { ASSET_REQUEST_STATUSES, LEVEL, listAssetRequests } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../_guard';
import { LifecycleTabs, Pill, fmt } from '../_ui';

export default async function AssetRequestsPage({ searchParams }: { searchParams: Promise<{ status?: string; error?: string }> }) {
  const { s, level } = await lifecycleSession(0);
  const t = await getTranslations('lifecycle');
  const sp = await searchParams;
  const status = (ASSET_REQUEST_STATUSES as readonly string[]).includes(sp.status ?? '') ? sp.status : undefined;
  const rows = await listAssetRequests(s, { status });
  const approver = level >= LEVEL.manager;
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('requests.title')} description={approver ? t('requests.subtitleAll') : t('requests.subtitleMine')}
        actions={<><Link href="/lifecycle/asset-requests/new"><Button size="sm">{t('hub.requestEquipment')}</Button></Link>{approver && <a className="text-sm text-primary underline-offset-2 hover:underline" href="/lifecycle/export/asset-requests">{t('common.exportCsv')}</a>}</>} />
      <ErrorBanner message={sp.error} />
      <LifecycleTabs level={level} active="assetRequests" />
      <form className="flex flex-wrap items-center gap-2 text-sm">
        <label className="text-muted-foreground" htmlFor="status">{t('common.status')}</label>
        <select id="status" name="status" defaultValue={status ?? ''} className="h-9 rounded-md border border-input bg-card px-2 text-sm">
          <option value="">{t('common.all')}</option>
          {ASSET_REQUEST_STATUSES.map((x) => <option key={x} value={x}>{t(`status.${x}`)}</option>)}
        </select>
        <Button type="submit" size="sm" variant="outline">{t('common.filter')}</Button>
      </form>
      <Card className={tableWrapCls}>
        <table className="w-full text-sm">
          <thead className={theadCls}><tr><th className={thCls}>{t('requests.number')}</th><th className={thCls}>{t('requests.item')}</th>{approver && <th className={thCls}>{t('requests.requester')}</th>}<th className={thCls}>{t('requests.quantity')}</th><th className={thCls}>{t('requests.preferred')}</th><th className={thCls}>{t('common.status')}</th></tr></thead>
          <tbody className={tbodyCls}>
            {rows.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">{t('requests.empty')}</td></tr>}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2"><Link href={`/lifecycle/asset-requests/${r.number}`} className="text-primary underline-offset-2 hover:underline">{r.number}</Link></td>
                <td className="px-3 py-2">{r.itemName}</td>
                {approver && <td className="px-3 py-2">{r.fullName}</td>}
                <td className="px-3 py-2 tabular-nums">{r.quantity}</td>
                <td className="px-3 py-2 tabular-nums">{fmt(r.preferredDate)}</td>
                <td className="px-3 py-2"><Pill value={r.status} label={t(`status.${r.status}`)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
