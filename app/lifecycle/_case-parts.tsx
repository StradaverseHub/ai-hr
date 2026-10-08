import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, Field, SectionHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import type { CaseKind, getCase } from '@/packs/lifecycle/service';
import { HistoryList, Pill, fmtTime } from './_ui';
import { commentAction, tickStepAction, undoStepAction } from './actions';

type CaseData = Awaited<ReturnType<typeof getCase>>;

/** The checklist, grouped by phase: each step with owner team, who/when, Mark done and (managers) Undo. */
export async function Checklist({ kind, data, canUndo, names }: { kind: CaseKind; data: CaseData; canUndo: boolean; names: Map<string, string> }) {
  const t = await getTranslations('lifecycle');
  const c = data.case;
  const phases = Object.keys(data.phases).map(Number).sort((a, b) => a - b);
  return (
    <div className="space-y-4">
      {phases.map((p) => {
        const steps = data.steps.filter((x) => x.phase === p);
        if (steps.length === 0) return null;
        return (
          <Card key={p} className="overflow-hidden">
            <SectionHeader title={data.phases[p]!} />
            <ul className="divide-y divide-border text-sm">
              {steps.map((st) => (
                <li key={st.key} className="flex flex-wrap items-start justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2">
                      <span aria-hidden className={st.done ? 'text-emerald-600' : 'text-muted-foreground'}>{st.done ? '✓' : st.applicability === 'na' ? '–' : '○'}</span>
                      <span className={st.done || st.applicability === 'na' ? 'text-muted-foreground' : ''}>
                        {st.label}{st.hrms && <span className="ml-1.5 rounded bg-muted px-1 text-[10px] uppercase tracking-wide text-muted-foreground">HRMS</span>}
                      </span>
                    </div>
                    <div className="ml-5 text-xs text-muted-foreground">
                      {st.ownerTeam || '—'}
                      {st.done && st.record?.doneAt && <> · {t('steps.doneBy', { who: (st.record.doneBy && names.get(st.record.doneBy)) || t('steps.someone'), when: fmtTime(st.record.doneAt) })}</>}
                      {st.record?.reference && <> · #{st.record.reference}</>}
                      {st.applicability === 'na' && <> · {t('steps.na')}</>}
                      {st.blocked === 'phase_locked' && <> · {t('steps.locked')}</>}
                      {st.blocked === 'outcome_pending' && <> · {t('steps.awaitingOutcome')}</>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {!st.done && !st.blocked && (
                      <form action={tickStepAction} className="flex items-center gap-1.5">
                        <input type="hidden" name="kind" value={kind} /><input type="hidden" name="number" value={c.number} /><input type="hidden" name="key" value={st.key} />
                        <input name="reference" placeholder={t('steps.reference')} aria-label={t('steps.reference')} className="h-8 w-24 rounded-md border border-input bg-card px-2 text-xs" />
                        <Button type="submit" size="sm">{t('steps.markDone')}</Button>
                      </form>
                    )}
                    {st.done && canUndo && c.status !== 'cancelled' && (
                      <form action={undoStepAction}>
                        <input type="hidden" name="kind" value={kind} /><input type="hidden" name="number" value={c.number} /><input type="hidden" name="key" value={st.key} />
                        <ConfirmSubmit size="sm" variant="ghost" title={t('steps.undoTitle')} description={t('steps.undoDescription')} confirmLabel={t('steps.undo')} reasonField={{ name: 'reason', label: t('common.reason') }}>{t('steps.undo')}</ConfirmSubmit>
                      </form>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}

export async function CommentsCard({ kind, number, comments }: { kind: CaseKind; number: string; comments: { id: string; authorName: string | null; body: string; at: Date | string }[] }) {
  const t = await getTranslations('lifecycle');
  return (
    <Card className="overflow-hidden">
      <SectionHeader title={t('common.comments')} count={comments.length} />
      <ul className="divide-y divide-border text-sm">
        {comments.map((c) => (
          <li key={c.id} className="px-4 py-2"><div className="text-xs text-muted-foreground">{c.authorName ?? '—'} · {fmtTime(c.at)}</div><div className="whitespace-pre-wrap">{c.body}</div></li>
        ))}
      </ul>
      <form action={commentAction} className="flex gap-2 border-t border-border p-3">
        <input type="hidden" name="kind" value={kind} /><input type="hidden" name="number" value={number} />
        <input name="body" required placeholder={t('common.commentPlaceholder')} aria-label={t('common.comments')} className={inputCls} />
        <Button type="submit" size="sm">{t('common.add')}</Button>
      </form>
    </Card>
  );
}

export async function RequisitionCard({ data }: { data: CaseData }) {
  const t = await getTranslations('lifecycle');
  const r = data.openRequisition;
  return (
    <Card className="space-y-1 p-4 text-sm">
      <h2 className="font-semibold">{t('case.linkedRequisition')}</h2>
      {r ? (
        <>
          <div className="flex items-center gap-2"><Link href={`/lifecycle/requisitions/${r.number}`} className="text-primary underline-offset-2 hover:underline">{r.number}</Link><Pill value={r.status} label={t(`status.${r.status}`)} /></div>
          <div className="text-muted-foreground">{t(`requisitions.kind.${r.kind}`)} · {t('requisitions.approval')}: {t(`approval.${r.approvalStatus}`)}</div>
        </>
      ) : <p className="text-muted-foreground">{t('case.noRequisition')}</p>}
    </Card>
  );
}

export async function HistoryCard({ rows }: { rows: Parameters<typeof HistoryList>[0]['rows'] }) {
  const t = await getTranslations('lifecycle');
  return <Card className="overflow-hidden"><SectionHeader title={t('common.history')} count={rows.length} /><HistoryList rows={rows} /></Card>;
}

export { ErrorBanner, Field };
