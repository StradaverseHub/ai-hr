import { getTranslations } from 'next-intl/server';
import { Card, SectionHeader } from '@/components/ui';
import { formatDmy } from '@/lib/date-display';
import type { listEntitlementRecalcAudit } from '@/packs/leave/service';

/** The existing read-only history, retained under the selected employee's Leave inquiry. */
export async function EntitlementRecalcHistory({ rows }: {
  rows: Awaited<ReturnType<typeof listEntitlementRecalcAudit>>;
}) {
  const t = await getTranslations('people.detail');
  const recalcReasonLabel = (reason: string): string =>
    t.has(`recalcReason.${reason}`) ? t(`recalcReason.${reason}`) : reason;
  return (
    <Card id="section-entitlement-recalc">
      <SectionHeader title={t('recalcHistoryTitle')} count={rows.length} />
      <p className="px-4 pt-3 text-xs text-muted-foreground">{t('recalcHistoryHelp')}</p>
      {rows.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">{t('recalcHistoryEmpty')}</div>
      ) : (
        <div role="region" aria-label={t('recalcHistoryTitle')} tabIndex={0}
          className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">{t('recalcColEffective')}</th>
                <th className="px-4 py-2 font-medium">{t('recalcColType')}</th>
                {/* 9e2a89e9 — the reporter asked for "previous Job Grade, new Job Grade, previous
                    entitlement, new entitlement, effective date, and reason". Three of the six were
                    already here; this is the fourth, and the date column above now carries the date the
                    change TOOK EFFECT rather than the date somebody typed it in. */}
                <th className="px-4 py-2 font-medium">{t('recalcColGrade')}</th>
                <th className="px-4 py-2 font-medium">{t('recalcColReason')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('recalcColPrevious')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('recalcColNew')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('recalcColChange')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  {/* `tookEffectOn` is the change's own effective date where the writer knew it, and the
                      posting date otherwise — one column, never two dates fighting over one heading. */}
                  <td className="px-4 py-2 tabular-nums">{formatDmy(r.tookEffectOn)}</td>
                  <td className="px-4 py-2">{r.leaveTypeName}</td>
                  {/* An em dash where no grade change was recorded, and where the grade has since left
                      the catalogue: an absent value asserts nothing, a guessed one asserts something
                      false. "From no grade to GRADE 16" is a real change and prints as "— → GRADE 16". */}
                  <td className="px-4 py-2 text-xs">
                    {r.gradeChanged ? (
                      <span className="whitespace-nowrap">
                        {r.previousGradeName ?? '—'} → {r.newGradeName ?? '—'}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t('recalcGradeUnchanged')}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{recalcReasonLabel(r.reason)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.previousEntitlement}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.newEntitlement}</td>
                  <td
                    className={`px-4 py-2 text-right tabular-nums font-medium ${
                      r.delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : r.delta < 0 ? 'text-red-600 dark:text-red-400' : ''
                    }`}
                  >
                    {r.delta > 0 ? `+${r.delta}` : r.delta}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
