import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { LEVEL, getRequisition, listAssets, requisitionHistory, staffDirectory } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../../_guard';
import { HistoryCard } from '../../_case-parts';
import { LifecycleTabs, Pill, ProgressBar, fmtTime } from '../../_ui';
import { cancelRequisitionAction, decideRequisitionAction, provisionAction, returnAssetsAction, updateRequisitionAction } from '../../actions';

export default async function RequisitionPage({ params, searchParams }: { params: Promise<{ number: string }>; searchParams: Promise<{ error?: string }> }) {
  const { s, level } = await lifecycleSession(LEVEL.agent);
  const t = await getTranslations('lifecycle');
  const { number } = await params;
  const { error } = await searchParams;
  let data;
  try { data = await getRequisition(s, number); } catch { notFound(); }
  const { requisition: r, items, progress } = data;
  const [history, dir] = await Promise.all([requisitionHistory(s, number), staffDirectory(s, r.companyId)]);
  const names = new Map(dir.map((d) => [d.userId, d.name]));
  const manager = level >= LEVEL.manager;
  const dead = r.status === 'cancelled' || r.approvalStatus === 'rejected';
  const [freeAssets, held] = await Promise.all([
    r.kind !== 'return' && !dead ? listAssets(s, { companyId: r.companyId }).then((a) => a.filter((x) => x.status === 'in_stock' || x.status === 'returned')) : Promise.resolve([]),
    r.kind === 'return' ? listAssets(s, { companyId: r.companyId, holderEmployeeNo: r.employeeNo }).then((a) => a.filter((x) => x.status === 'issued')) : Promise.resolve([]),
  ]);
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const device = r.device as Record<string, string | null | undefined>;
  const canDecide = manager && !dead && (r.approvalStatus === 'pending' || r.approvalStatus === 'pending_l2');
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={`${r.number} · ${r.fullName}`} back={{ href: '/lifecycle/requisitions', label: t('requisitions.title') }} description={`${t(`requisitions.kind.${r.kind}`)} · ${r.employeeNo}`}
        actions={<><Pill value={r.status} label={t(`status.${r.status}`)} /><Pill value={r.approvalStatus} label={t(`approval.${r.approvalStatus}`)} /><ProgressBar percent={pct} label={t('case.progress')} /></>} />
      <ErrorBanner message={error} />
      <LifecycleTabs level={level} active="requisitions" />
      {r.caseId && <p className="text-sm text-muted-foreground">{t('requisitions.fromCase')}</p>}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <SectionHeader title={t('requisitions.checklist')} count={progress.total} subtitle={r.approvalStatus !== 'approved' && r.approvalLevels > 0 ? t('requisitions.completeNeedsApproval') : undefined} />
            <ul className="divide-y divide-border text-sm">
              {items.map((it) => (
                <li key={it.itemKey} className="space-y-2 px-4 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className={it.status === 'pending' ? '' : 'text-muted-foreground'}>{it.name}</div>
                      <div className="text-xs text-muted-foreground">{it.status !== 'pending' && it.doneAt ? t('steps.doneBy', { who: (it.doneBy && names.get(it.doneBy)) || t('steps.someone'), when: fmtTime(it.doneAt) }) : ''}{it.note ? ` · ${it.note}` : ''}</div>
                    </div>
                    <Pill value={it.status === 'done' ? 'completed' : it.status === 'na' ? 'cancelled' : 'pending'} label={t(`item.${it.status}`)} />
                  </div>
                  {!dead && (
                    <form action={provisionAction} className="flex flex-wrap items-center gap-1.5">
                      <input type="hidden" name="number" value={r.number} /><input type="hidden" name="key" value={it.itemKey} />
                      {it.itemKey === 'laptop_issue' && it.status !== 'done' && r.kind !== 'return' && (
                        <select name="assetCode" className="h-8 rounded-md border border-input bg-card px-2 text-xs" aria-label={t('requisitions.assetToIssue')}>
                          <option value="">{t('requisitions.noAssetYet')}</option>
                          {freeAssets.map((a) => <option key={a.code} value={a.code}>{a.code} · {[a.manufacturer, a.model].filter(Boolean).join(' ')}</option>)}
                        </select>
                      )}
                      {it.itemKey === 'asset_return' && r.kind === 'return' && it.status !== 'done' && held.length > 1 && held.map((a) => (
                        <label key={a.code} className="flex items-center gap-1 text-xs"><input type="checkbox" name="assetCodes" value={a.code} className="size-3.5" />{a.code}</label>
                      ))}
                      <input name="note" placeholder={t('common.notes')} aria-label={t('common.notes')} className="h-8 w-36 rounded-md border border-input bg-card px-2 text-xs" />
                      {it.status !== 'done' && <Button type="submit" name="status" value="done" size="sm">{t('item.markDone')}</Button>}
                      {it.status !== 'na' && <Button type="submit" name="status" value="na" size="sm" variant="outline">{t('item.markNa')}</Button>}
                      {it.status !== 'pending' && <Button type="submit" name="status" value="pending" size="sm" variant="ghost">{t('item.reset')}</Button>}
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          {r.kind === 'return' && !dead && (
            <Card className="space-y-2 p-4 text-sm">
              <h2 className="font-semibold">{t('requisitions.returnDevices')}</h2>
              {held.length === 0 ? <p className="text-muted-foreground">{t('requisitions.noIssued', { employeeNo: r.employeeNo })}</p> : (
                <form action={returnAssetsAction} className="space-y-2">
                  <input type="hidden" name="number" value={r.number} />
                  {held.map((a) => <label key={a.code} className="flex items-center gap-2"><input type="checkbox" name="assetCodes" value={a.code} className="size-4" /><Link href={`/lifecycle/assets/${a.code}`} className="text-primary underline-offset-2 hover:underline">{a.code}</Link> {[a.manufacturer, a.model].filter(Boolean).join(' ')}</label>)}
                  <Button type="submit" size="sm">{t('requisitions.receive')}</Button>
                </form>
              )}
            </Card>
          )}
          <HistoryCard rows={history} />
        </div>

        <aside className="space-y-4">
          <Card className="space-y-2 p-4 text-sm">
            <h2 className="font-semibold">{t('requisitions.approval')}</h2>
            <div className="text-muted-foreground">{r.approvalLevels === 0 ? t('requisitions.noApprovalNeeded') : t('requests.levels', { count: r.approvalLevels })}</div>
            {r.approvalLevels > 0 && <><div>L1: {r.l1Action ? `${t(`decision.${r.l1Action}`)} · ${fmtTime(r.l1At)}` : '—'}</div>{r.approvalLevels === 2 && <div>L2: {r.l2Action ? `${t(`decision.${r.l2Action}`)} · ${fmtTime(r.l2At)}` : '—'}</div>}</>}
            {r.approvalNotes && <div><span className="text-muted-foreground">{t('common.notes')}: </span>{r.approvalNotes}</div>}
            {canDecide && (
              <form action={decideRequisitionAction} className="space-y-2 border-t border-border pt-3">
                <input type="hidden" name="number" value={r.number} />
                <Field label={t('common.notes')}><input name="notes" className={inputCls} /></Field>
                <div className="flex gap-2"><Button type="submit" name="decision" value="approve" size="sm">{t('common.approve')}</Button><Button type="submit" name="decision" value="reject" size="sm" variant="outline">{t('common.reject')}</Button></div>
              </form>
            )}
          </Card>

          <Card className="space-y-1.5 p-4 text-sm">
            <h2 className="font-semibold">{t('case.details')}</h2>
            {([[t('case.jobTitle'), r.jobTitle], [t('case.department'), r.department], [t('requisitions.workLocation'), r.workLocation], [t('requisitions.contact'), r.contact], [t('requisitions.username'), r.username],
              [t('case.deviceType'), r.deviceType], [t('requisitions.accessories'), r.accessories], [t('case.accessSystems'), r.accessSystems.join(', ')],
              [t('requisitions.emailStatus'), r.emailStatus], [t('requisitions.adStatus'), r.adStatus], [t('case.itOwner'), r.assignedToUserId ? names.get(r.assignedToUserId) : null],
              [t('requisitions.device'), [device.manufacturer, device.model, device.serial].filter(Boolean).join(' · ')]] as [string, string | null | undefined][])
              .map(([k, v]) => <div key={k}><span className="text-muted-foreground">{k}: </span>{v || '—'}</div>)}
          </Card>

          {r.status !== 'cancelled' && (
            <details className="rounded-lg border border-border bg-card">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">{t('case.edit')}</summary>
              <form action={updateRequisitionAction} className="grid gap-3 border-t border-border p-4">
                <input type="hidden" name="number" value={r.number} />
                <Field label={t('case.jobTitle')}><input name="jobTitle" defaultValue={r.jobTitle ?? ''} className={inputCls} /></Field>
                <Field label={t('case.department')}><input name="department" defaultValue={r.department ?? ''} className={inputCls} /></Field>
                <Field label={t('requisitions.workLocation')}><input name="workLocation" defaultValue={r.workLocation ?? ''} className={inputCls} /></Field>
                <Field label={t('requisitions.contact')}><input name="contact" defaultValue={r.contact ?? ''} className={inputCls} /></Field>
                <Field label={t('requisitions.username')}><input name="username" defaultValue={r.username ?? ''} className={inputCls} /></Field>
                <Field label={t('requisitions.accessories')}><input name="accessories" defaultValue={r.accessories ?? ''} className={inputCls} /></Field>
                <Field label={t('requisitions.emailStatus')}><input name="emailStatus" defaultValue={r.emailStatus ?? ''} className={inputCls} /></Field>
                <Field label={t('requisitions.adStatus')}><input name="adStatus" defaultValue={r.adStatus ?? ''} className={inputCls} /></Field>
                <Field label={t('case.itOwner')}><select name="assignedToUserId" defaultValue={r.assignedToUserId ?? ''} className={inputCls}><option value="">—</option>{dir.map((u) => <option key={u.userId} value={u.userId}>{u.name}</option>)}</select></Field>
                <Field label={t('requisitions.devManufacturer')}><input name="dev_manufacturer" defaultValue={device.manufacturer ?? ''} className={inputCls} /></Field>
                <Field label={t('requisitions.devModel')}><input name="dev_model" defaultValue={device.model ?? ''} className={inputCls} /></Field>
                <Field label={t('requisitions.devSerial')}><input name="dev_serial" defaultValue={device.serial ?? ''} className={inputCls} /></Field>
                <Field label={t('requisitions.devHostname')}><input name="dev_hostname" defaultValue={device.hostname ?? ''} className={inputCls} /></Field>
                <Field label={t('common.notes')}><textarea name="notes" rows={2} defaultValue={r.notes ?? ''} className={`${inputCls} h-auto py-2`} /></Field>
                <Button type="submit" size="sm">{t('common.save')}</Button>
              </form>
            </details>
          )}

          {manager && r.status !== 'cancelled' && r.status !== 'completed' && (
            <form action={cancelRequisitionAction}>
              <input type="hidden" name="number" value={r.number} />
              <ConfirmSubmit size="sm" variant="ghost" className="text-destructive hover:text-destructive" title={t('requisitions.cancelTitle')} description={t('requisitions.cancelDescription')} confirmLabel={t('requisitions.cancel')}
                reasonField={{ name: 'reason', label: t('common.reason'), required: true }}>{t('requisitions.cancel')}</ConfirmSubmit>
            </form>
          )}
          {r.cancelReason && <p className="text-xs text-muted-foreground">{t('common.reason')}: {r.cancelReason}</p>}
        </aside>
      </div>
    </div>
  );
}
