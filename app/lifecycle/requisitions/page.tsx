import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, PageHeader, tableWrapCls, tbodyCls, theadCls, thCls } from '@/components/ui';
import { LEVEL, listRequisitions } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../_guard';
import { LifecycleTabs, Pill, fmt } from '../_ui';

const KINDS = ['requisition', 'return', 'standalone'] as const;
const STATUSES = ['open', 'in_progress', 'completed', 'cancelled'] as const;
const APPROVALS = ['pending', 'pending_l2', 'approved', 'rejected'] as const;
const pick = <T extends string>(v: string | undefined, all: readonly T[]): T | undefined => (all as readonly string[]).includes(v ?? '') ? (v as T) : undefined;

export default async function RequisitionsList({ searchParams }: { searchParams: Promise<{ kind?: string; status?: string; approval?: string; error?: string }> }) {
  const { s, level } = await lifecycleSession(LEVEL.agent);
  const t = await getTranslations('lifecycle');
  const sp = await searchParams;
  const rows = await listRequisitions(s, { kind: pick(sp.kind, KINDS), status: pick(sp.status, STATUSES), approval: pick(sp.approval, APPROVALS) });
  const sel = 'h-9 rounded-md border border-input bg-card px-2 text-sm';
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('requisitions.title')} description={t('requisitions.subtitle')} actions={<Link href="/lifecycle/requisitions/new"><Button size="sm">{t('requisitions.new')}</Button></Link>} />
      <ErrorBanner message={sp.error} />
      <LifecycleTabs level={level} active="requisitions" />
      <form className="flex flex-wrap items-center gap-2 text-sm">
        <select name="kind" defaultValue={sp.kind ?? ''} className={sel} aria-label={t('requisitions.type')}><option value="">{t('requisitions.type')}: {t('common.all')}</option>{KINDS.map((x) => <option key={x} value={x}>{t(`requisitions.kind.${x}`)}</option>)}</select>
        <select name="status" defaultValue={sp.status ?? ''} className={sel} aria-label={t('common.status')}><option value="">{t('common.status')}: {t('common.all')}</option>{STATUSES.map((x) => <option key={x} value={x}>{t(`status.${x}`)}</option>)}</select>
        <select name="approval" defaultValue={sp.approval ?? ''} className={sel} aria-label={t('requisitions.approval')}><option value="">{t('requisitions.approval')}: {t('common.all')}</option>{APPROVALS.map((x) => <option key={x} value={x}>{t(`approval.${x}`)}</option>)}</select>
        <Button type="submit" size="sm" variant="outline">{t('common.filter')}</Button>
        {level >= LEVEL.manager && <a className="ml-auto text-primary underline-offset-2 hover:underline" href="/lifecycle/export/requisitions">{t('common.exportCsv')}</a>}
      </form>
      <Card className={tableWrapCls}>
        <table className="w-full text-sm">
          <thead className={theadCls}><tr><th className={thCls}>{t('requests.number')}</th><th className={thCls}>{t('requisitions.type')}</th><th className={thCls}>{t('case.name')}</th><th className={thCls}>{t('case.employeeNo')}</th><th className={thCls}>{t('common.status')}</th><th className={thCls}>{t('requisitions.approval')}</th><th className={thCls}>{t('common.created')}</th></tr></thead>
          <tbody className={tbodyCls}>
            {rows.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">{t('requisitions.empty')}</td></tr>}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2"><Link href={`/lifecycle/requisitions/${r.number}`} className="text-primary underline-offset-2 hover:underline">{r.number}</Link></td>
                <td className="px-3 py-2">{t(`requisitions.kind.${r.kind}`)}</td><td className="px-3 py-2">{r.fullName}</td><td className="px-3 py-2">{r.employeeNo}</td>
                <td className="px-3 py-2"><Pill value={r.status} label={t(`status.${r.status}`)} /></td>
                <td className="px-3 py-2"><Pill value={r.approvalStatus} label={t(`approval.${r.approvalStatus}`)} /></td>
                <td className="px-3 py-2 tabular-nums">{fmt(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
