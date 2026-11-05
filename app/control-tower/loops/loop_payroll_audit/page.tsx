import { ActionButton } from '@/components/ui/action-button';
import { getFormatter, getTranslations } from 'next-intl/server';
import { requireAdminOrAuditReader } from '@/lib/authz';
import { isAdmin, isGroupAdmin } from '@/lib/authz-model';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { auditCompanies, auditLoopDetail, defaultAuditPeriod, type AuditFindingView } from '@/core/payroll-audit/status';
import { recordPayrollAccess } from '@/core/payroll-audit/access-log';
import { auditAdministration } from '@/core/payroll-audit/settings';
import { auditorCompanies, auditorLoopDetail } from '@/core/payroll-audit/auditor-view';
import { AUDIT_CONTROL_BOUNDS, AUDIT_DISPOSITIONS, AUDIT_ROOT_CAUSES, PREPARER_CLOSED_MODES, isPayPeriod } from '@/core/payroll-audit/types';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { AuditLoopColumn, auditPackHref } from '@/components/payroll-audit/audit-loop-column';
import { cn } from '@/lib/utils';
import { OperationsTabs } from '../../operations-tabs';
import { PayrollCycleSubnav } from '@/components/ai-centre/centre-tabs';
import { setLoopPauseAction, setLoopSwitchAction } from '../actions';
import { acknowledgeFindingAction, captureAuditNowAction, disposeAuditFindingAction, grantAuditReaderAction, recordCorrectionCauseAction, revokeAuditReaderAction,
  setAuditSettingsAction } from './actions';

/** AI v2 P2-2b — the Audit loop's own page (approved Phase 2 mock-ups: PayrollLoops.dc.html's Audit column, laid out as
 * Main.dc.html's loop detail at the Prepare level). For one pay month and the companies the viewer administers:
 * what done means and the loop's four steps; its figures; its column; each company's state with its audit pack; the
 * statutory files against their due date; the control findings, each disposed of here by a person with a note; the
 * post-run corrections, each given a root cause from the fixed list; the per-company pause; the limits it never crosses;
 * and who answers for it. Read under the viewer's row-level security (core/payroll-audit/status.ts); guarded by
 * requireAdmin like every Operations page. Viewing it is recorded in the payroll access log.
 * Phase 2 hardening: a login with a current read-only auditor grant (and no administrator role) opens it too, for the
 * companies of their grants only, built from what the loop captured (core/payroll-audit/auditor-view.ts, consistent
 * with the grant, which reads the Audit loop and its pack and nothing else). Their view offers no command: no switch,
 * capture, disposition, root cause, setting, grant or pause, and says so. */
const LOOP = 'loop_payroll_audit';
const ERRORS = ['invalid', 'refused', 'module', 'failed', 'subject', 'groupAdministrator', 'already'] as const;
const SAVED = ['disposed', 'cause', 'captured', 'switch', 'pause', 'settings', 'granted', 'revoked', 'acknowledged'] as const;
const STEPS = ['capture', 'check', 'prepare', 'verify'] as const;
const LIMITS = ['pay', 'block', 'file', 'model'] as const;
const RUN_TYPES: readonly string[] = ['regular', 'off_cycle', 'bonus', 'adjustment'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (value: unknown) => (typeof value === 'string' && value ? value : '—');
const num = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0));

type Query = { period?: string; company?: string; error?: string; saved?: string };
export default async function AuditLoopPage({ searchParams }: { searchParams: Promise<Query> }) {
  const s = await requireAdminOrAuditReader();
  // An auditor (no administrator role) reads their granted companies only, read-only.
  const auditor = !isAdmin(s);
  const [query, t, tl, f] = await Promise.all([searchParams, getTranslations('payrollAudit'), getTranslations('aiCentre.loops'), getFormatter()]);
  const payPeriod = isPayPeriod(query.period) ? query.period : defaultAuditPeriod(todayInKualaLumpur());
  const companies = auditor ? await auditorCompanies(s) : await auditCompanies(s);
  const companyId = typeof query.company === 'string' && UUID.test(query.company) && companies.some(c => c.id === query.company) ? query.company : null;
  const scope = companyId ? { companyIds: [companyId] } : {};
  const detail = auditor ? await auditorLoopDetail(s, { payPeriod, ...scope }) : await auditLoopDetail(s, { payPeriod, ...scope });
  const admin = auditor ? { companies: [], candidates: [] } : await auditAdministration(s, scope);
  for (const item of detail.companies) await recordPayrollAccess(s, { surface: 'audit_view', action: 'view', companyId: item.companyId, payPeriod });
  const error = ERRORS.find(code => code === query.error), saved = SAVED.find(code => code === query.saved);
  const when = (date: Date | null) => (date ? f.dateTime(date, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }) : '—');
  const day = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? f.dateTime(new Date(`${iso.slice(0, 10)}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' }) : '—');
  const month = f.dateTime(new Date(`${payPeriod}-01T00:00:00Z`), { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const due = day(detail.dueDate);
  const name = t('name');
  const what = (item: AuditFindingView) => {
    const e = item.evidence;
    switch (item.controlId) {
      case 'bank_change_before_pay_day': return t('what.bank_change_before_pay_day', { changed: day(str(e.changedOn)), days: num(e.daysBeforePayDay), payDay: day(str(e.payDay)), last4: str(e.accountAfterLast4) });
      case 'shared_bank_account': return t('what.shared_bank_account', { last4: str(e.accountLast4), people: num(e.people), paid: num(e.paidHere) });
      case 'pay_after_last_day': return t('what.pay_after_last_day', { lastDay: day(str(e.lastWorkingDay)) });
      case 'pay_without_attendance': return t('what.pay_without_attendance');
      case 'preparer_closed_run': return t('what.preparer_closed_run', { seq: num(e.runSeq) });
      case 'adjustment_without_reason': return t('what.adjustment_without_reason', { threshold: str(e.threshold) });
      default: return t('what.formula_changed_open_period', { seq: num(e.runSeq) });
    }
  };
  const tile = (key: string, value: string) => (
    <div key={key} className="min-w-0 rounded-xl border border-border bg-card p-4">
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t(`figures.${key}`)}</p>
    </div>
  );
  const hidden = (extra: Record<string, string> = {}) => (<>
    <input type="hidden" name="period" value={payPeriod} />
    {companyId && <input type="hidden" name="company" value={companyId} />}
    {Object.entries(extra).map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />)}
  </>);
  const groupAdmin = isGroupAdmin(s);
  const findingCompany = (item: AuditFindingView) => item.companyId ?? companyId;
  return (
    <div className={pageWideCls}>
      {/* Operations › Payroll cycle › Audit; an auditor sees this page alone, without the administrators' tab rows. */}
      {!auditor && <><OperationsTabs session={s} active="payrollCycle" /><PayrollCycleSubnav active="audit" /></>}
      <PageHeader back={auditor ? undefined : { href: '/control-tower/loops', label: tl('back') }} title={name} description={t('column.doneMeans')}
        actions={<div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full border border-border px-2.5 py-1 text-xs font-medium">{tl('level.prepare')}</span>
          <span data-loop-switch={detail.loop.on ? 'on' : 'off'} className="text-sm">{detail.loop.on ? tl('on') : tl('off')}</span>
          {groupAdmin && !auditor && <form action={setLoopSwitchAction}>
            <input type="hidden" name="loop" value={LOOP} /><input type="hidden" name="from" value="detail" /><input type="hidden" name="enabled" value={String(!detail.loop.on)} />
            <ActionButton type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${tl(detail.loop.on ? 'turnOff' : 'turnOn')} · ${name}`}>{tl(detail.loop.on ? 'turnOff' : 'turnOn')}</ActionButton>
          </form>}
        </div>} />
      {auditor && <p data-audit-read-only role="note" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">{t('auditor.readOnly')}</p>}
      {error && <ErrorBanner message={t(`errors.${error}`)} />}
      {saved && <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">{t(`saved.${saved}`)}</p>}

      <form method="get" data-audit-filter className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('filter.period')}</span>
          <input type="month" name="period" defaultValue={payPeriod} className={cn(inputCls, 'pointer-coarse:min-h-11')} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('filter.company')}</span>
          <select name="company" defaultValue={companyId ?? ''} className={cn(inputCls, 'pointer-coarse:min-h-11')}>
            <option value="">{t('filter.allCompanies', { count: companies.length })}</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <button type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')}>{t('filter.show')}</button>
      </form>
      <p className="text-sm text-muted-foreground">{t('monthLine', { month, due })}</p>

      <ol data-loop-steps className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step, index) => (
          <li key={step} className="min-w-0 rounded-xl border border-border bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">{t('stepLabel', { n: index + 1, step: t(`steps.${step}`) })}</p>
            <p className="mt-1 text-sm">{t(`stepText.${step}`, { due })}</p>
          </li>
        ))}
      </ol>

      <div data-loop-figures className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tile('captures', String(detail.totals.captures))}
        {tile('findings', String(detail.totals.openFindings))}
        {tile('corrections', String(detail.totals.corrections))}
        {tile('filed', t('ofForms', { filed: detail.totals.formsFiled, forms: detail.totals.forms }))}
      </div>
      <p className="text-xs text-muted-foreground">{tl('figures.noSpend')}</p>

      <div className="max-w-md"><AuditLoopColumn summary={detail} /></div>

      <Card className="overflow-hidden">
        <SectionHeader title={t('companies.title')} />
        {detail.companies.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t('companies.none')}</p> : (
          <div className="overflow-x-auto">
            <table data-audit-companies className="w-full min-w-[880px] text-left text-sm">
              <caption className="sr-only">{t('companies.title')}</caption>
              <thead className="border-y border-border bg-muted/40"><tr>{(['company', 'runs', 'payslips', 'statutory', 'findings', 'corrections', 'captures', 'pack'] as const)
                .map(key => <th key={key} scope="col" className="px-4 py-3 font-medium">{t(`companies.columns.${key}`)}</th>)}</tr></thead>
              <tbody className="divide-y divide-border">
                {detail.companies.map(item => (
                  <tr key={item.companyId} data-audit-company={item.companyId} className="align-top">
                    <th scope="row" className="px-4 py-3 font-medium">{item.companyName}<span className={cn('block text-xs font-normal', item.done ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground')}>{item.done ? t('state.done') : t('state.open')}</span></th>
                    <td className="px-4 py-3">{item.runs.length === 0 ? t('companies.noRun') : item.runs.map(run => <span key={run.batchId} className="block">{t('companies.run', { type: t(`runType.${RUN_TYPES.includes(run.runType) ? run.runType : 'other'}`), seq: run.runSeq, status: t(`runStatus.${run.status === 'draft' || run.status === 'processed' || run.status === 'closed' ? run.status : 'other'}`) })}</span>)}</td>
                    <td className="px-4 py-3 tabular-nums">{t('companies.payslips', { released: item.payslips.released, total: item.payslips.total, opened: item.payslips.opened })}</td>
                    <td className="px-4 py-3">{t('ofForms', { filed: item.statutory.filter(form => form.required && form.filed).length, forms: item.statutory.filter(form => form.required).length })}</td>
                    <td className="px-4 py-3 tabular-nums">{t('companies.findings', { open: item.findings.open, disposed: item.findings.disposed })}</td>
                    <td className="px-4 py-3 tabular-nums">{t('companies.corrections', { count: item.corrections.count })}{item.corrections.withoutRootCause > 0 && <span className="block text-xs text-amber-700 dark:text-amber-300">{t('companies.correctionsMissing', { count: item.corrections.withoutRootCause })}</span>}</td>
                    <td className="px-4 py-3">{t('companies.captures', { count: item.captures.count })}{item.captures.head && <span className="block break-all font-mono text-xs text-muted-foreground" title={item.captures.head}>{item.captures.head.slice(0, 16)}</span>}</td>
                    <td className="px-4 py-3">
                      <a href={auditPackHref(item.companyId, payPeriod)} className="inline-flex min-h-9 items-center font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11" aria-label={`${t('companies.pack')} · ${item.companyName}`}>{t('companies.pack')}</a>
                      {!auditor && <form action={captureAuditNowAction} className="mt-1">
                        <input type="hidden" name="period" value={payPeriod} /><input type="hidden" name="company" value={item.companyId} />
                        <ActionButton type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${t('companies.capture')} · ${item.companyName}`}>{t('companies.capture')}</ActionButton>
                      </form>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="px-4 pt-2 text-xs text-muted-foreground">{t('companies.packHelp')}</p>
        <p data-audit-opens-note className="px-4 pb-4 pt-1 text-xs text-muted-foreground">{t('companies.opensNote')}</p>
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={t('statutory.title', { due })} />
        <div className="overflow-x-auto">
          <table data-audit-statutory className="w-full min-w-[720px] text-left text-sm">
            <caption className="sr-only">{t('statutory.title', { due })}</caption>
            <thead className="border-y border-border bg-muted/40"><tr>{(['company', 'form', 'prepared', 'filed'] as const).map(key => <th key={key} scope="col" className="px-4 py-3 font-medium">{t(`statutory.columns.${key}`)}</th>)}</tr></thead>
            <tbody className="divide-y divide-border">
              {detail.companies.flatMap(item => item.statutory.map(form => (
                <tr key={`${item.companyId}:${form.form}`} data-audit-form={form.form}>
                  <td className="px-4 py-3">{item.companyName}</td>
                  <td className="px-4 py-3">{t(`forms.${form.form}`)}</td>
                  <td className="px-4 py-3">{!form.required ? <span className="text-muted-foreground">{t('statutory.notRequired')}</span> : form.prepared ? <>{day(form.preparedOn)}<span className={cn('block text-xs', form.beforeDue ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-300')}>{form.beforeDue ? t('statutory.beforeDue') : t('statutory.late')}</span></> : <span className="text-amber-700 dark:text-amber-300">{t('statutory.notYet')}</span>}</td>
                  <td className="px-4 py-3">{form.filed ? <>{day(form.filedOn)}<span className="block text-xs text-muted-foreground">{t('statutory.receipt')}</span></> : <span className="text-muted-foreground">{t('statutory.notFiled')}</span>}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
        <p className="px-4 pb-4 pt-2 text-xs text-muted-foreground">{t('statutory.help')}</p>
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={t('findings.title')} />
        {detail.findings.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t('findings.none')}</p> : (
          <ul data-audit-findings className="divide-y divide-border border-t border-border">
            {detail.findings.map(item => (
              <li key={item.id} data-audit-finding={item.controlId} data-state={item.disposition ?? 'open'} className="flex flex-col gap-2 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{t(`controls.${item.controlId}`)}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{when(item.detectedAt)}</span>
                </div>
                <p className="m-0">{what(item)}</p>
                {(item.personName || item.employeeCode) && <p className="m-0 text-xs text-muted-foreground">{[item.personName, item.employeeCode].filter(Boolean).join(' · ')}</p>}
                {item.acknowledgement && <p data-finding-acknowledged className="m-0 text-xs"><span className="font-medium">{t('acknowledged.label')}</span> · {item.acknowledgement.reason}
                  <span className="text-muted-foreground"> · {t(`acknowledged.scope.${item.acknowledgement.scope}`)}</span></p>}
                {item.disposition ? (
                  <p className="m-0 text-xs"><span className="font-medium">{t(`dispositions.${item.disposition}`)}</span> · {item.note}{item.disposedAt && <span className="text-muted-foreground"> · {when(item.disposedAt)}</span>}</p>
                ) : auditor ? (
                  <p className="m-0 text-xs text-muted-foreground">{t('findings.openReadOnly')}</p>
                ) : (
                  <form action={disposeAuditFindingAction} className="flex flex-wrap items-end gap-2">
                    {hidden({ finding: item.id })}
                    <label className="flex flex-col gap-1 text-xs"><span className="text-muted-foreground">{t('findings.disposition')}</span>
                      <select name="disposition" required className={cn(inputCls, 'pointer-coarse:min-h-11')} defaultValue={item.acknowledgement ? 'expected' : ''}>
                        <option value="" disabled>{t('findings.choose')}</option>
                        {AUDIT_DISPOSITIONS.map(d => <option key={d} value={d}>{t(`dispositions.${d}`)}</option>)}
                      </select></label>
                    <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs"><span className="text-muted-foreground">{t('findings.note')}</span>
                      <input name="note" required maxLength={1000} defaultValue={item.acknowledgement ? t('acknowledged.note', { reason: item.acknowledgement.reason }) : undefined}
                        className={cn(inputCls, 'pointer-coarse:min-h-11')} /></label>
                    <ActionButton type="submit" className={cn(btnPrimary, 'pointer-coarse:min-h-11')} aria-label={`${t('findings.record')} · ${t(`controls.${item.controlId}`)}`}>{t('findings.record')}</ActionButton>
                  </form>
                )}
                {!auditor && !item.acknowledgement && !item.disposition && <form action={acknowledgeFindingAction} data-acknowledge-finding className="flex flex-wrap items-end gap-2">
                  {hidden({ control: item.controlId, target: findingCompany(item) ?? '', ...(item.employmentId ? { employment: item.employmentId } : {}) })}
                  <label className="flex flex-col gap-1 text-xs"><span className="text-muted-foreground">{t('acknowledged.for')}</span>
                    <select name="scope" defaultValue={item.employmentId ? 'person' : 'company'} className={cn(inputCls, 'pointer-coarse:min-h-11')}>
                      {item.employmentId && <option value="person">{t('acknowledged.scope.person')}</option>}
                      <option value="company">{t('acknowledged.scope.company')}</option>
                    </select></label>
                  <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs"><span className="text-muted-foreground">{t('acknowledged.reason')}</span>
                    <input name="reason" required maxLength={500} className={cn(inputCls, 'pointer-coarse:min-h-11')} /></label>
                  <label className="flex flex-col gap-1 text-xs"><span className="text-muted-foreground">{t('acknowledged.reviewOn')}</span>
                    <input type="date" name="reviewOn" className={cn(inputCls, 'pointer-coarse:min-h-11')} /></label>
                  <ActionButton type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${t('acknowledged.record')} · ${t(`controls.${item.controlId}`)}`}>{t('acknowledged.record')}</ActionButton>
                </form>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={t('corrections.title')} />
        {detail.corrections.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t('corrections.none')}</p> : (
          <ul data-audit-corrections className="divide-y divide-border border-t border-border">
            {detail.corrections.map(item => (
              <li key={item.correctionKey} data-audit-correction={item.action} data-state={item.rootCause ?? 'missing'} className="flex flex-col gap-2 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{t(`corrections.actions.${item.action}`, { seq: item.runSeq })}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{when(item.at)} · {item.companyName}</span>
                </div>
                <p className="m-0 text-xs text-muted-foreground">{item.reason ? t('corrections.reason', { reason: item.reason }) : t('corrections.noReason')}</p>
                {item.rootCause && <p className="m-0 text-xs"><span className="font-medium">{t(`rootCauses.${item.rootCause}`)}</span> · {item.note}</p>}
                {!auditor && <form action={recordCorrectionCauseAction} className="flex flex-wrap items-end gap-2">
                  {hidden({ correction: item.correctionKey })}
                  <label className="flex flex-col gap-1 text-xs"><span className="text-muted-foreground">{t('corrections.cause')}</span>
                    <select name="rootCause" required className={cn(inputCls, 'pointer-coarse:min-h-11')} defaultValue={item.rootCause ?? ''}>
                      <option value="" disabled>{t('corrections.choose')}</option>
                      {AUDIT_ROOT_CAUSES.map(c => <option key={c} value={c}>{t(`rootCauses.${c}`)}</option>)}
                    </select></label>
                  <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs"><span className="text-muted-foreground">{t('corrections.note')}</span>
                    <input name="note" required maxLength={1000} className={cn(inputCls, 'pointer-coarse:min-h-11')} /></label>
                  <ActionButton type="submit" className={cn(btnPrimary, 'pointer-coarse:min-h-11')} aria-label={`${t(item.rootCause ? 'corrections.update' : 'corrections.record')} · ${t(`corrections.actions.${item.action}`, { seq: item.runSeq })}`}>{t(item.rootCause ? 'corrections.update' : 'corrections.record')}</ActionButton>
                </form>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {!auditor && <Card className="overflow-hidden" data-audit-administration>
        <SectionHeader title={t('administration.title')} />
        <p className="px-4 pb-3 text-sm text-muted-foreground">{t('administration.help')}</p>
        <ul className="divide-y divide-border border-t border-border">
          {admin.companies.map(item => (
            <li key={item.companyId} data-audit-admin-company={item.companyId} className="flex flex-col gap-4 px-4 py-4 text-sm">
              <h3 className="m-0 text-sm font-semibold">{item.companyName}</h3>
              <form action={setAuditSettingsAction} data-audit-settings className="flex flex-wrap items-end gap-3">
                {hidden({ target: item.companyId })}
                <label className="flex flex-col gap-1 text-xs"><span className="text-muted-foreground">{t('administration.bankChangeDays')}</span>
                  <input type="number" name="bankChangeDays" min={AUDIT_CONTROL_BOUNDS.bankChangeDays.min} max={AUDIT_CONTROL_BOUNDS.bankChangeDays.max} step={1} required defaultValue={item.settings.bankChangeDays} className={cn(inputCls, 'w-28 pointer-coarse:min-h-11')} /></label>
                <label className="flex flex-col gap-1 text-xs"><span className="text-muted-foreground">{t('administration.adjustmentThreshold')}</span>
                  <input type="number" name="adjustmentThreshold" min={AUDIT_CONTROL_BOUNDS.adjustmentThreshold.min} max={AUDIT_CONTROL_BOUNDS.adjustmentThreshold.max} step={0.01} required defaultValue={item.settings.adjustmentThreshold.toFixed(2)} className={cn(inputCls, 'w-36 pointer-coarse:min-h-11')} /></label>
                <label className="flex flex-col gap-1 text-xs"><span className="text-muted-foreground">{t('administration.preparerClosedMode')}</span>
                  <select name="preparerClosedMode" defaultValue={item.settings.preparerClosedMode} className={cn(inputCls, 'pointer-coarse:min-h-11')}>
                    {PREPARER_CLOSED_MODES.map(mode => <option key={mode} value={mode}>{t(`administration.preparerClosed.${mode}`)}</option>)}
                  </select></label>
                <ActionButton type="submit" className={cn(btnPrimary, 'pointer-coarse:min-h-11')} aria-label={`${t('administration.save')} · ${item.companyName}`}>{t('administration.save')}</ActionButton>
                <span className="text-xs text-muted-foreground">{item.settings.version === null ? t('administration.defaults') : t('administration.version', { version: item.settings.version })}</span>
                <p className="m-0 w-full text-xs text-muted-foreground">{t('administration.loosenHelp')}</p>
              </form>
              <div className="flex flex-col gap-2">
                <p className="m-0 text-xs font-medium">{t('administration.auditorsTitle')}</p>
                {item.readers.length === 0 ? <p className="m-0 text-xs text-muted-foreground">{t('administration.none')}</p> : (
                  <ul data-audit-readers className="m-0 flex list-none flex-col gap-1 p-0">
                    {item.readers.map(reader => (
                      <li key={reader.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span>{reader.label ?? t('administration.loginWithoutRecord', { id: reader.appUserId.slice(0, 8) })}{' '}
                          <span className="ml-1 text-xs text-muted-foreground">{t('administration.grantedOn', { date: f.dateTime(reader.grantedAt, { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' }) })}</span></span>
                        <form action={revokeAuditReaderAction}>
                          {hidden({ grant: reader.id })}
                          <ActionButton type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${t('administration.revoke')} · ${reader.label ?? reader.appUserId.slice(0, 8)} · ${item.companyName}`}>{t('administration.revoke')}</ActionButton>
                        </form>
                      </li>
                    ))}
                  </ul>
                )}
                <form action={grantAuditReaderAction} data-audit-grant className="flex flex-wrap items-end gap-2">
                  {hidden({ target: item.companyId })}
                  <label className="flex min-w-48 flex-col gap-1 text-xs"><span className="text-muted-foreground">{t('administration.login')}</span>
                    <select name="appUser" required defaultValue="" className={cn(inputCls, 'pointer-coarse:min-h-11')}>
                      <option value="" disabled>{t('administration.choose')}</option>
                      {admin.candidates.filter(candidate => !item.readers.some(reader => reader.appUserId === candidate.appUserId)).map(candidate =>
                        <option key={candidate.appUserId} value={candidate.appUserId}>{candidate.label ?? t('administration.loginWithoutRecord', { id: candidate.appUserId.slice(0, 8) })}</option>)}
                    </select></label>
                  <ActionButton type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${t('administration.grant')} · ${item.companyName}`}>{t('administration.grant')}</ActionButton>
                </form>
                <p className="m-0 text-xs text-muted-foreground">{t('administration.auditorsHelp')}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>}

      {!auditor && <Card className="overflow-hidden">
        <SectionHeader title={tl('pause.title')} />
        <p className="px-4 pb-3 text-sm text-muted-foreground">{tl('pause.help')}</p>
        <ul className="divide-y divide-border border-t border-border">
          {detail.companies.map(item => (
            <li key={item.companyId} data-loop-company={item.companyId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 break-words">{item.companyName}</span>
              <span className="flex items-center gap-3">
                <span className={cn('text-xs', item.paused ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>{item.paused ? tl('pause.paused') : tl('pause.running')}</span>
                <form action={setLoopPauseAction}>
                  <input type="hidden" name="loop" value={LOOP} /><input type="hidden" name="from" value="detail" />
                  <input type="hidden" name="company" value={item.companyId} /><input type="hidden" name="paused" value={String(!item.paused)} />
                  <ActionButton type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${tl(item.paused ? 'pause.resume' : 'pause.pause')} · ${item.companyName}`}>{tl(item.paused ? 'pause.resume' : 'pause.pause')}</ActionButton>
                </form>
              </span>
            </li>
          ))}
        </ul>
      </Card>}

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="text-sm font-semibold">{tl('limits.title')}</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{LIMITS.map(limit => <li key={limit}>{t(`limits.${limit}`)}</li>)}</ul>
        </Card>
        <Card className="p-4">
          <h2 className="text-sm font-semibold">{tl('owner.title')}</h2>
          <p className="mt-2 text-sm">{tl('owner.agent', { name })}</p>
          <p className="mt-1 text-sm">{detail.loop.sponsorUserId ? tl('owner.sponsor', { name: detail.loop.sponsorName ?? tl('sponsorUnnamed') }) : tl('owner.noSponsor')}</p>
          <p className="mt-2 text-xs text-muted-foreground">{tl('owner.note')}</p>
        </Card>
      </div>
    </div>
  );
}
