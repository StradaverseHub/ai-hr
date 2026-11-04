import { getFormatter, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { isGroupAdmin } from '@/lib/authz-model';
import { MAX_THRESHOLD_BP } from '@/core/loops/swing-proposals';
import { payrollLoopSettingsPage } from '@/core/loops/payroll-cycle-views';
import { CHECK_INTERVALS } from '@/core/loops/payroll-loop-settings';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import { OperationsTabs } from '../../../operations-tabs';
import { PayrollCycleSubnav } from '@/components/ai-centre/centre-tabs';
import { decideRuleProposalAction, decideThresholdProposalAction, revokeAcknowledgementAction, setPayrollLearningModeAction, setPayrollLoopSettingAction } from '../actions';
import { learningSettingsView, type LearningSettings } from '@/core/payroll-learning/mode';

/** AI v2 P2-2a — the payroll-cycle loops' settings, per company the viewer administers: how often the Pre-salary loop
 * checks (owner decision 4) and the net-swing threshold with its exclusions (owner decision 5), the threshold proposals
 * the dispositions support, and the history of every change. Nothing applies without an administrator: a proposal is
 * approved or rejected here, and either is recorded with its evidence. A proposal changes the net-swing flag only, never
 * the payroll anomaly detectors. No mock-up covers this page: it follows the loop pages' cards, forms and buttons.
 * Payroll history learning (migration 2012): per company whose payroll the viewer administers, the learning mode now and
 * every change of it. A group administrator switches evidence lines on; any payroll administrator switches them off;
 * classify is only ever reached by an approved proposal, never here (core/payroll-learning/mode.ts). */
const ERRORS = ['invalid', 'refused', 'changed', 'already', 'failed', 'groupAdministrator', 'ownEvidence', 'own', 'learningGroup'] as const;
const SAVED = ['setting', 'approved', 'rejected', 'revoked', 'ruleApproved', 'ruleRejected', 'learning'] as const;

export default async function PayrollLoopSettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const s = await requireAdmin();
  const query = await searchParams;
  const [t, f, view] = await Promise.all([getTranslations('aiCentre.payrollCycle'), getFormatter(), payrollLoopSettingsPage(s)]);
  const error = ERRORS.find(code => code === query.error), saved = SAVED.find(code => code === query.saved);
  // Approving a proposal loosens the flag: a group administrator's (who disposed of none of its flags); anyone may reject.
  const canApprove = isGroupAdmin(s);
  const percent = (bp: number) => f.number(bp / 10_000, { style: 'percent', maximumFractionDigits: 2 });
  // A check's name: an Audit loop control, a payroll anomaly detector, or the net-swing flag.
  const [ta, tc, tn, learning] = await Promise.all([getTranslations('anomaly'), getTranslations('payrollAudit'), getTranslations('aiCentre.payrollLearning'),
    // A learning read that fails leaves the section out; it never stops the page.
    learningSettingsView(s, view.companies.map(c => c.companyId)).catch(() => new Map<string, LearningSettings>())]);
  const checkName = (id: string) => id.startsWith('audit:') ? tc(`controls.${id.slice(6)}`)
    : id.startsWith('anomaly:') ? ta(`detector.${id.slice(8).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}`) : t('acknowledgements.netSwing');
  const when = (at: Date) => f.dateTime(at, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' });
  // A pay item pattern is keyed on its component's id; its current name is shown (the catalogue's, read with the page).
  const pattern = (value: string) => value.startsWith('cause:') ? t(`causes.${value.slice(6)}`)
    : view.patternNames[value] ? t('patternItem', { item: view.patternNames[value] }) : t('patternUnknown');
  return (
    <div className={pageWideCls}>
      <OperationsTabs session={s} active="payrollCycle" />
      <PayrollCycleSubnav active="settings" />
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
                <input id={`threshold-${c.companyId}`} name="threshold" type="number" inputMode="decimal" min={1} max={MAX_THRESHOLD_BP / 100} step={0.5}
                  defaultValue={c.setting.thresholdBp / 100} className={cn(inputCls, 'w-28 pointer-coarse:min-h-11')} />
                <span className="text-sm text-muted-foreground">%</span>
                <button type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${t('settings.save')} · ${t('settings.threshold')} · ${c.companyName}`}>{t('settings.save')}</button>
              </div>
              <p className="text-xs text-muted-foreground">{t('settings.thresholdHelp')}</p>
            </form>
            <form action={setPayrollLoopSettingAction} className="space-y-2" data-setting-form="reminders">
              <input type="hidden" name="company" value={c.companyId} />
              <input type="hidden" name="reminders" value={c.setting.remindersEnabled ? 'off' : 'on'} />
              <p className="text-sm font-medium">{t('settings.reminders')}</p>
              <div className="flex flex-wrap items-center gap-2">
                <span data-reminders={c.setting.remindersEnabled ? 'on' : 'off'} className="text-sm">{c.setting.remindersEnabled ? t('settings.remindersOn') : t('settings.remindersOff')}</span>
                <button type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${t(c.setting.remindersEnabled ? 'settings.remindersTurnOff' : 'settings.remindersTurnOn')} · ${c.companyName}`}>
                  {t(c.setting.remindersEnabled ? 'settings.remindersTurnOff' : 'settings.remindersTurnOn')}</button>
              </div>
              <p className="text-xs text-muted-foreground">{t('settings.remindersHelp')}</p>
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
                      {!canApprove && <p className="mt-1 text-xs text-muted-foreground">{t('proposals.approveGroupOnly')}</p>}
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(canApprove ? ['approved', 'rejected'] as const : ['rejected'] as const).map(decision => (
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
          <div className="border-t border-border px-4 py-3" data-acknowledgements>
            <h3 className="text-sm font-semibold">{t('acknowledgements.title')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('acknowledgements.help')}</p>
            {c.acknowledgements.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">{t('acknowledgements.none')}</p> : (
              <ul className="mt-2 flex list-none flex-col gap-2 p-0">
                {c.acknowledgements.map(ack => (
                  <li key={ack.id} data-acknowledgement={ack.checkId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium">{checkName(ack.checkId)}</span>{' · '}
                      {ack.scope === 'person' ? (ack.personName ?? t('flags.unnamed')) : ack.scope === 'group' ? (ack.departmentName ?? t('acknowledgements.group')) : t('acknowledgements.company')}
                      <span className="block text-xs text-muted-foreground">{t(ack.blocks ? 'acknowledgements.blockLine' : 'acknowledgements.warningLine', { reason: ack.reason,
                        name: ack.createdBy ?? t('flags.unnamed'), when: when(ack.createdAt) })}{ack.reviewOn ? ` · ${t('acknowledgements.reviewOn', { date: ack.reviewOn })}` : ''}</span>
                    </span>
                    <form action={revokeAcknowledgementAction}>
                      <input type="hidden" name="acknowledgement" value={ack.id} />
                      <button type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${t('acknowledgements.revoke')} · ${checkName(ack.checkId)}`}>{t('acknowledgements.revoke')}</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            {c.ruleProposals.length > 0 && <div className="mt-3" data-rule-proposals>
              <h4 className="text-sm font-medium">{t('acknowledgements.proposalsTitle')}</h4>
              <ul className="mt-2 flex list-none flex-col gap-2 p-0">
                {c.ruleProposals.map(rule => (
                  <li key={rule.key} data-rule-proposal={rule.checkId} className="rounded-lg border border-border p-3 text-sm">
                    <p className="m-0 font-medium">{t('acknowledgements.proposal', { check: checkName(rule.checkId), name: rule.personName ?? t('flags.unnamed') })}</p>
                    <p className="m-0 mt-1 text-xs text-muted-foreground">{t('acknowledgements.proposalEvidence', { runs: rule.evidence.runs, expected: rule.evidence.expected,
                      share: percent(rule.evidence.expectedShareBp) })}</p>
                    {!canApprove && <p className="m-0 mt-1 text-xs text-muted-foreground">{t('proposals.approveGroupOnly')}</p>}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {(canApprove ? ['approved', 'rejected'] as const : ['rejected'] as const).map(decision => (
                        <form key={decision} action={decideRuleProposalAction}>
                          <input type="hidden" name="target" value={c.companyId} /><input type="hidden" name="proposal" value={rule.key} /><input type="hidden" name="decision" value={decision} />
                          <button type="submit" className={cn(decision === 'approved' ? btnPrimary : btnGhost, 'pointer-coarse:min-h-11')}
                            aria-label={`${t(`proposals.${decision}`)} · ${checkName(rule.checkId)} · ${rule.personName ?? t('flags.unnamed')}`}>{t(`proposals.${decision}`)}</button>
                        </form>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </div>}
          </div>
          {learning.get(c.companyId) && <LearningSection settings={learning.get(c.companyId)!} companyName={c.companyName} canSwitchOn={canApprove} tn={tn}
            unnamed={t('flags.unnamed')} when={when} />}
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

type TN = Awaited<ReturnType<typeof getTranslations<'aiCentre.payrollLearning'>>>;

/** One company's payroll history learning: the mode now, the switch the viewer may use, and every change. */
function LearningSection({ settings, companyName, canSwitchOn, tn, unnamed, when }: { settings: LearningSettings; companyName: string; canSwitchOn: boolean; tn: TN;
  unnamed: string; when: (at: Date) => string }) {
  const on = settings.mode === 'evidence' || settings.mode === 'classify';
  return (
    <div className="border-t border-border px-4 py-3" data-learning-settings={settings.mode}>
      <h3 className="text-sm font-semibold">{tn('settings.title')}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{tn('settings.help')}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-sm" data-learning-current>{tn('settings.current', { mode: tn(`cycle.mode.${settings.mode}`) })}</span>
        {on ? (
          <form action={setPayrollLearningModeAction}>
            <input type="hidden" name="company" value={settings.companyId} /><input type="hidden" name="mode" value="off" />
            <button type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${tn('settings.switchOff')} · ${companyName}`}>{tn('settings.switchOff')}</button>
          </form>
        ) : canSwitchOn ? (
          <form action={setPayrollLearningModeAction}>
            <input type="hidden" name="company" value={settings.companyId} /><input type="hidden" name="mode" value="evidence" />
            <button type="submit" className={cn(btnPrimary, 'pointer-coarse:min-h-11')} aria-label={`${tn('settings.switchOn')} · ${companyName}`}>{tn('settings.switchOn')}</button>
          </form>
        ) : null}
      </div>
      {!on && !canSwitchOn && <p className="mt-1 text-xs text-muted-foreground" data-learning-group-only>{tn('settings.groupOnly')}</p>}
      <p className="mt-1 text-xs text-muted-foreground">{tn('settings.classify')}</p>
      <h4 className="mt-3 text-sm font-medium">{tn('settings.historyTitle')}</h4>
      {settings.history.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">{tn('settings.noHistory')}</p> : (
        <ul className="mt-1 flex list-none flex-col gap-1 p-0 text-sm" data-learning-history>
          {settings.history.map(row => (
            <li key={`v${row.version}`}>{tn('settings.historyRow', { version: row.version, mode: tn(`cycle.mode.${row.mode}`), name: row.by ?? unnamed, when: when(row.at) })}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
