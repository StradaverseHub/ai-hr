import { getFormatter, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { payrollLoopSettingsPage } from '@/core/loops/payroll-cycle-views';
import { CHECK_INTERVALS } from '@/core/loops/payroll-loop-settings';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import { OperationsTabs } from '../../../operations-tabs';
import { decideThresholdProposalAction, setPayrollLoopSettingAction } from '../actions';

/** AI v2 P2-2a — the payroll-cycle loops' settings, per company the viewer administers: how often the Pre-salary loop
 * checks (owner decision 4) and the net-swing threshold with its exclusions (owner decision 5), the threshold proposals
 * the dispositions support, and the history of every change. Nothing applies without an administrator: a proposal is
 * approved or rejected here, and either is recorded with its evidence. A proposal changes the net-swing flag only, never
 * the payroll anomaly detectors. No mock-up covers this page: it follows the loop pages' cards, forms and buttons. */
const ERRORS = ['invalid', 'refused', 'changed', 'already', 'failed'] as const;
const SAVED = ['setting', 'approved', 'rejected'] as const;

export default async function PayrollLoopSettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const s = await requireAdmin();
  const query = await searchParams;
  const [t, f, view] = await Promise.all([getTranslations('aiCentre.payrollCycle'), getFormatter(), payrollLoopSettingsPage(s)]);
  const error = ERRORS.find(code => code === query.error), saved = SAVED.find(code => code === query.saved);
  const percent = (bp: number) => f.number(bp / 10_000, { style: 'percent', maximumFractionDigits: 2 });
  const when = (at: Date) => f.dateTime(at, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' });
  const pattern = (value: string) => value.startsWith('cause:') ? t(`causes.${value.slice(6)}`) : t('patternItem', { item: value.slice(5).replace(/_/g, ' ') });
  return (
    <div className={pageWideCls}>
      <OperationsTabs session={s} active="loops" />
      <PageHeader back={{ href: '/control-tower/loops/payroll-cycle', label: t('backToCycle') }} title={t('settings.title')} description={t('settings.description')} />
      {error && <ErrorBanner message={t(`errors.${error}`)} />}
      {saved && <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">{t(`saved.${saved}`)}</p>}
      {view.companies.length === 0 && <Card className="p-4 text-sm text-muted-foreground">{t('noCompanies')}</Card>}
      {view.companies.map(c => (
        <Card key={c.companyId} className="overflow-hidden" data-settings-company={c.companyId}>
          <SectionHeader title={c.companyName} subtitle={c.setting.source === 'default' ? t('settings.defaults') : t('settings.version', { version: c.setting.version })} />
          <div className="grid gap-4 px-4 pb-4 md:grid-cols-2">
            <form action={setPayrollLoopSettingAction} className="space-y-2" data-setting-form="interval">
              <input type="hidden" name="company" value={c.companyId} />
              <label htmlFor={`interval-${c.companyId}`} className="block text-sm font-medium">{t('settings.interval')}</label>
              <div className="flex flex-wrap gap-2">
                <select id={`interval-${c.companyId}`} name="interval" defaultValue={c.setting.interval} className={cn(inputCls, 'w-auto pointer-coarse:min-h-11')}>
                  {CHECK_INTERVALS.map(value => <option key={value} value={value}>{t(`interval.${value}`)}</option>)}
                </select>
                <button type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${t('settings.save')} · ${t('settings.interval')} · ${c.companyName}`}>{t('settings.save')}</button>
              </div>
              <p className="text-xs text-muted-foreground">{t('settings.intervalHelp')}</p>
            </form>
            <form action={setPayrollLoopSettingAction} className="space-y-2" data-setting-form="threshold">
              <input type="hidden" name="company" value={c.companyId} />
              <label htmlFor={`threshold-${c.companyId}`} className="block text-sm font-medium">{t('settings.threshold')}</label>
              <div className="flex flex-wrap items-center gap-2">
                <input id={`threshold-${c.companyId}`} name="threshold" type="number" inputMode="decimal" min={1} max={100} step={0.5}
                  defaultValue={c.setting.thresholdBp / 100} className={cn(inputCls, 'w-28 pointer-coarse:min-h-11')} />
                <span className="text-sm text-muted-foreground">%</span>
                <button type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${t('settings.save')} · ${t('settings.threshold')} · ${c.companyName}`}>{t('settings.save')}</button>
              </div>
              <p className="text-xs text-muted-foreground">{t('settings.thresholdHelp')}</p>
            </form>
          </div>
          <div className="border-t border-border px-4 py-3">
            <h3 className="text-sm font-semibold">{t('settings.exclusions')}</h3>
            {c.setting.exclusions.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">{t('settings.noExclusions')}</p> : (
              <ul className="mt-2 flex list-none flex-col gap-2 p-0" data-exclusions>
                {c.setting.exclusions.map(value => (
                  <li key={value} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span>{pattern(value)}</span>
                    <form action={setPayrollLoopSettingAction}>
                      <input type="hidden" name="company" value={c.companyId} /><input type="hidden" name="removeExclusion" value={value} />
                      <button type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${t('settings.remove')} · ${pattern(value)} · ${c.companyName}`}>{t('settings.remove')}</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="border-t border-border px-4 py-3" data-proposals>
            <h3 className="text-sm font-semibold">{t('proposals.title')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('proposals.help')}</p>
            {c.proposals.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">{t('proposals.none')}</p> : (
              <ul className="mt-2 flex list-none flex-col gap-3 p-0">
                {c.proposals.map(p => {
                  const what = p.kind === 'threshold' ? t('proposals.threshold', { from: percent(p.fromThresholdBp), to: percent(p.toThresholdBp ?? p.fromThresholdBp) })
                    : t('proposals.exclusion', { pattern: pattern(p.pattern ?? '') });
                  return (
                    <li key={p.key} data-proposal={p.kind} className="rounded-lg border border-border p-3 text-sm">
                      <p className="font-medium">{what}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{t('proposals.evidence', { flags: p.evidence.flags, expected: p.evidence.expected, problems: p.evidence.problems,
                        share: percent(p.evidence.expectedShareBp), days: p.evidence.windowDays })}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(['approved', 'rejected'] as const).map(decision => (
                          <form key={decision} action={decideThresholdProposalAction}>
                            <input type="hidden" name="company" value={c.companyId} /><input type="hidden" name="proposal" value={p.key} /><input type="hidden" name="decision" value={decision} />
                            <button type="submit" className={cn(decision === 'approved' ? btnPrimary : btnGhost, 'pointer-coarse:min-h-11')}
                              aria-label={`${t(`proposals.${decision}`)} · ${what}`}>{t(`proposals.${decision}`)}</button>
                          </form>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="border-t border-border px-4 py-3">
            <h3 className="text-sm font-semibold">{t('history.settingsTitle')}</h3>
            {c.history.length === 0 && c.decisions.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">{t('history.noChanges')}</p> : (
              <ul className="mt-2 flex list-none flex-col gap-1 p-0 text-sm" data-setting-history>
                {c.history.map(row => (
                  <li key={`v${row.version}`}>{t('history.settingRow', { version: row.version, interval: t(`interval.${row.interval}`), threshold: percent(row.thresholdBp),
                    exclusions: row.exclusions.length, source: t(`history.source.${row.source}`), name: row.by ?? t('flags.unnamed'), when: when(row.at) })}</li>
                ))}
                {c.decisions.filter(row => row.decision === 'rejected').map(row => (
                  <li key={row.id} className="text-muted-foreground">{t('history.rejectedRow', { name: row.by ?? t('flags.unnamed'), when: when(row.at) })}</li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}
