import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { LEVEL, getAssetRequest, staffDirectory } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../../_guard';
import { HistoryList, LifecycleTabs, Pill, fmt, fmtTime } from '../../_ui';
import { advanceAssetRequestAction, cancelAssetRequestAction, decideAssetRequestAction, handlerAction } from '../../actions';

const NEXT: Record<string, string> = { approved: 'procured', procured: 'tagged', tagged: 'assigned', assigned: 'completed' };

export default async function AssetRequestPage({ params, searchParams }: { params: Promise<{ number: string }>; searchParams: Promise<{ error?: string }> }) {
  const { s, level } = await lifecycleSession(0);
  const t = await getTranslations('lifecycle');
  const { number } = await params;
  const { error } = await searchParams;
  let data;
  try { data = await getAssetRequest(s, number); } catch { notFound(); }
  const { request: r, item, assetCode, history } = data;
  const manager = level >= LEVEL.manager;
  const own = r.requesterUserId === s.userId;
  const canDecide = manager && !own && (r.status === 'requested' || r.status === 'pending_approval');
  const next = NEXT[r.status];
  const staff = manager ? await staffDirectory(s, r.companyId) : [];
  const stages = ['requested', 'approved', 'procured', 'tagged', 'assigned', 'completed'];
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={`${r.number} · ${item.itemName}`} back={{ href: '/lifecycle/asset-requests', label: t('requests.title') }} actions={<Pill value={r.status} label={t(`status.${r.status}`)} />} />
      <ErrorBanner message={error} />
      <LifecycleTabs level={level} active="assetRequests" />

      <Card className="p-4">
        <ol className="flex flex-wrap gap-2 text-xs">
          {stages.map((x) => {
            const reached = x === 'requested' || stages.indexOf(x) <= stages.indexOf(r.status === 'pending_approval' ? 'requested' : r.status);
            return <li key={x} className={reached ? 'rounded-full bg-primary/10 px-2 py-0.5 text-primary' : 'rounded-full bg-muted px-2 py-0.5 text-muted-foreground'}>{t(`status.${x}`)}</li>;
          })}
          {(r.status === 'rejected' || r.status === 'cancelled') && <li className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">{t(`status.${r.status}`)}</li>}
        </ol>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-2 p-4 text-sm">
          <h2 className="font-semibold">{t('requests.details')}</h2>
          <div><span className="text-muted-foreground">{t('requests.requester')}: </span>{r.fullName}{r.employeeNo ? ` (${r.employeeNo})` : ''}</div>
          <div><span className="text-muted-foreground">{t('requests.item')}: </span>{item.itemCode} · {item.itemName} ({t(`requests.category.${item.category}`)})</div>
          <div><span className="text-muted-foreground">{t('requests.quantity')}: </span>{r.quantity}</div>
          <div><span className="text-muted-foreground">{t('requests.preferred')}: </span>{fmt(r.preferredDate)}</div>
          <div><span className="text-muted-foreground">{t('requests.justification')}: </span>{r.justification ?? '—'}</div>
          {assetCode && <div><span className="text-muted-foreground">{t('requests.asset')}: </span>{level >= LEVEL.agent ? <a className="text-primary underline-offset-2 hover:underline" href={`/lifecycle/assets/${assetCode}`}>{assetCode}</a> : assetCode}</div>}
          {r.cancelReason && <div><span className="text-muted-foreground">{t('common.reason')}: </span>{r.cancelReason}</div>}
        </Card>

        <Card className="space-y-2 p-4 text-sm">
          <h2 className="font-semibold">{t('requests.approval')}</h2>
          <div className="text-muted-foreground">{t('requests.levels', { count: r.approvalLevels })}</div>
          <div>L1: {r.l1Action ? `${t(`decision.${r.l1Action}`)} · ${fmtTime(r.l1At)}` : '—'}</div>
          {r.approvalLevels === 2 && <div>L2: {r.l2Action ? `${t(`decision.${r.l2Action}`)} · ${fmtTime(r.l2At)}` : '—'}</div>}
          {r.approvalNotes && <div><span className="text-muted-foreground">{t('common.notes')}: </span>{r.approvalNotes}</div>}
          {canDecide && (
            <form action={decideAssetRequestAction} className="mt-2 space-y-2 border-t border-border pt-3">
              <input type="hidden" name="number" value={r.number} />
              <Field label={t('common.notes')}><input name="notes" className={inputCls} /></Field>
              <div className="flex gap-2"><Button type="submit" name="decision" value="approve" size="sm">{t('common.approve')}</Button><Button type="submit" name="decision" value="reject" size="sm" variant="outline">{t('common.reject')}</Button></div>
            </form>
          )}
          {manager && own && (r.status === 'requested' || r.status === 'pending_approval') && <p className="text-xs text-muted-foreground">{t('requests.ownNoApprove')}</p>}
        </Card>
      </div>

      {manager && (
        <Card className="space-y-3 p-4 text-sm">
          <h2 className="font-semibold">{t('requests.fulfilment')}</h2>
          <form action={handlerAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="number" value={r.number} />
            <Field label={t('requests.handler')}>
              <select name="handler" defaultValue={r.handlerUserId ?? ''} className={inputCls}>
                <option value="">—</option>
                {staff.map((u) => <option key={u.userId} value={u.userId}>{u.name}</option>)}
              </select>
            </Field>
            <Button type="submit" size="sm" variant="outline">{t('common.save')}</Button>
          </form>
          {next && (
            <form action={advanceAssetRequestAction} className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
              <input type="hidden" name="number" value={r.number} />
              <input type="hidden" name="next" value={next} />
              {next === 'assigned' && <Field label={t('requests.assetCode')}><input name="assetCode" className={inputCls} placeholder="CHGP-LAP-0001" required={item.category === 'hardware'} /></Field>}
              <Button type="submit" size="sm">{t('requests.advanceTo', { stage: t(`status.${next}`) })}</Button>
            </form>
          )}
        </Card>
      )}

      {(own || manager) && !['cancelled', 'rejected', 'completed'].includes(r.status) && (
        <form action={cancelAssetRequestAction}>
          <input type="hidden" name="number" value={r.number} />
          <ConfirmSubmit size="sm" variant="ghost" className="text-destructive hover:text-destructive" title={t('requests.cancelTitle')} description={t('requests.cancelDescription')} confirmLabel={t('common.cancelRequest')}
            reasonField={{ name: 'reason', label: t('common.reason') }}>{t('common.cancelRequest')}</ConfirmSubmit>
        </form>
      )}

      {level >= LEVEL.agent && history.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('common.history')} />
          <HistoryList rows={history} />
        </Card>
      )}
    </div>
  );
}
