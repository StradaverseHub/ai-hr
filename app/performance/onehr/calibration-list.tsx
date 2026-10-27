import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card, PageHeader } from '@/components/ui';
import { calibrationListTierOrder, type CalibrationListSession } from '@/packs/performance/onehr/calibration-list-model';

/**
 * WP-B1 — the Calibration destination. Read-only: the one control per row is the link into the session,
 * where the existing calibration screen owns every decision. Groups follow calibrationListTierOrder; inside a
 * group the service has already placed open windows first.
 */
export function CalibrationList({ sessions }: { sessions: CalibrationListSession[] }) {
  const t = useTranslations('onehr.calibrationList');
  const groups = calibrationListTierOrder.map((tier) => ({ tier, rows: sessions.filter((s) => s.tier === tier) })).filter((g) => g.rows.length > 0);
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      {!groups.length ? (
        <Card className="p-5"><p className="text-sm text-muted-foreground">{t('empty')}</p></Card>
      ) : groups.map(({ tier, rows }) => (
        <Card key={tier} className="space-y-3 p-5">
          <section aria-labelledby={`calibration-tier-${tier}`} className="space-y-3">
            <h2 id={`calibration-tier-${tier}`} className="font-semibold">{t(`tiers.${tier}`)}</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>{(['session', 'cycle', 'company', 'window', 'people', 'toDo', 'status'] as const).map((k) => <th key={k} className="whitespace-nowrap p-3">{t(`columns.${k}`)}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((s) => (
                    <tr key={s.id}>
                      <td className="p-3"><Link className="text-primary underline" href={s.href}>{s.name}</Link></td>
                      <td className="p-3">{s.cycleName}</td>
                      <td className="p-3">{s.companyName ?? t('groupWide')}</td>
                      <td className="p-3">
                        {t(`window.${s.window}`)}
                        {s.window === 'upcoming' && s.opensOn ? <span className="mt-1 block text-xs text-muted-foreground">{t('opensOn', { date: s.opensOn })}</span>
                          : s.window === 'open' && s.closesOn ? <span className="mt-1 block text-xs text-muted-foreground">{t('closesOn', { date: s.closesOn })}</span> : null}
                      </td>
                      <td className="p-3 tabular-nums">{s.people}</td>
                      <td className="p-3 tabular-nums">{s.toDo}</td>
                      <td className="p-3">{t(`lock.${s.lock}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </Card>
      ))}
    </div>
  );
}
