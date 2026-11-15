import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, Field, Input, PageHeader, btnGhost, btnPrimary } from '@/components/ui';
import {
  agencyFees, recruitmentViewer, referralRewards, rewardPayrollCompanies, rewardPayrollQueue, RecruitmentError,
  FEE_INVOICE_MAX, FEE_NOTE_MAX, REWARD_REASON_MAX, type AgencyFeeRow, type PayrollRewardQueue, type ReferralRewardRow, type RewardState,
} from '@/packs/recruitment/service';
import { decideAgencyFeeAction, decideReferralRewardAction, recordAgencyFeeAction, sendRewardToPayrollAction } from '../actions';
import { Notice, Pill, RecruitmentTabs, SubTabs, klDate, pickCompany, recruitmentErrorText, selectCls, textareaCls } from '../shared';

export const dynamic = 'force-dynamic';

type Search = { company?: string; view?: string; problem?: string; notice?: string };
type View = 'rewards' | 'fees' | 'payroll';

const TONE: Record<RewardState, 'neutral' | 'info' | 'good' | 'warn' | 'bad'> = {
  waiting_record: 'neutral', waiting_probation: 'info', ready: 'warn', hire_left: 'bad', approved: 'good', sent: 'good', declined: 'neutral',
};
const money = (locale: string, amount: string, currency: string) =>
  new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount));
const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;

/**
 * Recruitment › Rewards and fees (slice 23; D-063, D-068).
 *   - Referral rewards (administrators of the job's company): each hired referral with a reward, its state from the hire's
 *     employment (waiting for the employee record, waiting for probation, ready, hire left) and, once decided, the decision.
 *     Ready rewards are approved to one of the referrer's active employments; any undecided reward may be declined with a reason.
 *   - Agency fees (administrators): hired applications from accepted agency submissions; the fee from the invoice, decided by
 *     another administrator. Nothing here pays an agency.
 *   - Send to payroll (payroll administrators of the receiving company, who need no Recruitment role): approved rewards, sent
 *     once as an earning in Individual Transactions. They see the employee and the amount, never the hire or the job.
 * Every amount was typed by a person; this page calculates none.
 */
export default async function RewardsPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const sp = await searchParams;
  const [viewer, payrollCompanies] = await Promise.all([recruitmentViewer(s, scopeIds), rewardPayrollCompanies(s)]);
  const admin = viewer.adminCompanies;
  if (!admin.length && !payrollCompanies.length) redirect('/');
  const [t, nav, locale] = await Promise.all([getTranslations('recruitment.rewards'), getTranslations('nav'), getLocale()]);
  const views: View[] = [...(admin.length ? (['rewards', 'fees'] as const) : []), ...(payrollCompanies.length ? (['payroll'] as const) : [])];
  const view: View = views.includes(sp.view as View) ? (sp.view as View) : views[0];
  const companies = view === 'payroll' ? payrollCompanies : admin;
  const company = pickCompany(companies, sp.company);
  let problem = await recruitmentErrorText(sp.problem);
  let rewards: ReferralRewardRow[] = [], fees: AgencyFeeRow[] = [], queue: PayrollRewardQueue | null = null;
  if (company) {
    try {
      if (view === 'rewards') rewards = await referralRewards(s, company.id);
      else if (view === 'fees') fees = await agencyFees(s, company.id);
      else queue = await rewardPayrollQueue(s, company.id);
    } catch (e) {
      if (!(e instanceof RecruitmentError)) throw e;
      problem = await recruitmentErrorText(e.code);
    }
  }
  const here = `/recruitment/rewards?view=${view}${company ? `&company=${company.id}` : ''}`;
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('purpose')} />
      {admin.length > 0 && <RecruitmentTabs active="rewards" admin approvals={viewer.pendingApprovals} />}
      <ErrorBanner message={problem} />
      <Notice text={sp.notice === 'saved' ? t('saved') : undefined} />
      <SubTabs label={t('views')} items={views.map((v) => ({ key: v, href: `/recruitment/rewards?view=${v}`, text: t(`view.${v}`), current: v === view }))} />
      {companies.length > 1 && (
        <form className="flex flex-wrap items-end gap-2" method="get">
          {hidden('view', view)}
          <Field label={t('company')} className="w-64">
            <select name="company" defaultValue={company?.id} className={selectCls}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <button type="submit" className={btnGhost}>{t('show')}</button>
        </form>
      )}
      {view === 'rewards' && <RewardList rows={rewards} here={here} locale={locale} />}
      {view === 'fees' && <FeeList rows={fees} here={here} locale={locale} />}
      {view === 'payroll' && queue && <PayrollQueue queue={queue} here={here} locale={locale} />}
    </div>
  );
}

async function RewardList({ rows, here, locale }: { rows: ReferralRewardRow[]; here: string; locale: string }) {
  const t = await getTranslations('recruitment.rewards');
  if (!rows.length) return <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('noRewards')}</p>;
  return (
    <section aria-labelledby="rewards-title" className="space-y-3">
      <div>
        <h2 id="rewards-title" className="text-base font-semibold">{t('view.rewards')}</h2>
        <p className="text-sm text-muted-foreground">{t('rewardsNote')}</p>
      </div>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {rows.map((r) => {
          const usable = r.payees.filter((p) => p.currency === r.currency);
          return (
            <li key={r.referralId} className="space-y-3 px-4 py-3" data-reward-state={r.state}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <Link href={`/recruitment/applications/${r.applicationId}`} className="font-medium text-primary hover:underline">{r.hireName ?? t('removedHire')}</Link>
                  <p className="text-xs text-muted-foreground">{r.jobTitle} · <span className="font-mono">{r.jobNumber}</span></p>
                  <p className="text-sm">{t('referredBy', { name: r.referrerName ?? t('unknownPerson') })}</p>
                </div>
                <div className="flex flex-col items-end gap-1 text-right">
                  <span className="font-semibold tabular-nums">{money(locale, r.amount, r.currency)}</span>
                  <Pill tone={TONE[r.state]}>{t(`state.${r.state}`)}</Pill>
                  {r.dueOn && !r.decision && <span className="text-xs text-muted-foreground">{t('dueOn', { date: klDate(locale, `${r.dueOn}T00:00:00+08:00`) })}</span>}
                </div>
              </div>
              {r.noProbationDate && !r.decision && <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">{t('noProbationDate')}</p>}
              {r.decision ? (
                <p className="text-sm text-muted-foreground">
                  {t(r.decision.reason ? 'declinedBy' : 'approvedBy', { name: r.decision.decidedBy ?? t('unknownPerson'), date: klDate(locale, r.decision.decidedAt) })}
                  {r.decision.reason && <> — {r.decision.reason}</>}
                  {r.decision.payPeriod && <> · {t('sentFor', { month: r.decision.payPeriod })}</>}
                </p>
              ) : (
                <div className="flex flex-wrap items-start gap-3">
                  {r.state === 'ready' && (usable.length ? (
                    <form action={decideReferralRewardAction} className="flex flex-wrap items-end gap-2">
                      {hidden('referralId', r.referralId)}{hidden('decision', 'approved')}{hidden('returnTo', here)}
                      {usable.length > 1 || r.payees.length > 1 ? (
                        <Field label={t('payee')} className="w-72">
                          <select name="payeeEmploymentId" required className={selectCls} defaultValue="">
                            <option value="" disabled>{t('choosePayee')}</option>
                            {usable.map((p) => <option key={p.employmentId} value={p.employmentId}>{p.companyName}{p.employeeCode ? ` · ${p.employeeCode}` : ''}</option>)}
                          </select>
                        </Field>
                      ) : hidden('payeeEmploymentId', usable[0].employmentId)}
                      <button type="submit" className={btnPrimary}>{t('approve')}</button>
                    </form>
                  ) : <p className="text-sm text-muted-foreground">{t('noPayee')}</p>)}
                  <details className="w-full max-w-md">
                    <summary className="cursor-pointer text-sm text-primary">{t('decline')}</summary>
                    <form action={decideReferralRewardAction} className="mt-2 space-y-2">
                      {hidden('referralId', r.referralId)}{hidden('decision', 'declined')}{hidden('returnTo', here)}
                      <Field label={t('reason')}>
                        <textarea name="reason" required maxLength={REWARD_REASON_MAX} rows={2} className={textareaCls} />
                      </Field>
                      <button type="submit" className={btnGhost}>{t('confirmDecline')}</button>
                    </form>
                  </details>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

async function FeeList({ rows, here, locale }: { rows: AgencyFeeRow[]; here: string; locale: string }) {
  const t = await getTranslations('recruitment.rewards');
  if (!rows.length) return <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('noFees')}</p>;
  return (
    <section aria-labelledby="fees-title" className="space-y-3">
      <div>
        <h2 id="fees-title" className="text-base font-semibold">{t('view.fees')}</h2>
        <p className="text-sm text-muted-foreground">{t('feesNote')}</p>
      </div>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {rows.map((r) => (
          <li key={r.applicationId} className="space-y-3 px-4 py-3" data-fee-state={r.fee?.decision ?? (r.fee ? 'recorded' : 'none')}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <Link href={`/recruitment/applications/${r.applicationId}`} className="font-medium text-primary hover:underline">{r.candidateName ?? t('removedHire')}</Link>
                <p className="text-xs text-muted-foreground">{r.jobTitle} · <span className="font-mono">{r.jobNumber}</span> · {r.agencyName}</p>
                <p className="text-xs text-muted-foreground">{t('hiredOn', { date: klDate(locale, r.hiredAt) })}</p>
              </div>
              {r.fee && (
                <div className="flex flex-col items-end gap-1 text-right">
                  <span className="font-semibold tabular-nums">{money(locale, r.fee.amount, r.fee.currency)}</span>
                  <Pill tone={r.fee.decision === 'approved' ? 'good' : r.fee.decision === 'declined' ? 'neutral' : 'warn'}>
                    {t(`feeState.${r.fee.decision ?? 'recorded'}`)}</Pill>
                </div>
              )}
            </div>
            {r.fee && (
              <p className="text-sm text-muted-foreground">
                {t('recordedBy', { name: r.fee.recordedBy ?? t('unknownPerson'), date: klDate(locale, r.fee.recordedAt) })}
                {r.fee.invoiceRef && <> · {t('invoice', { ref: r.fee.invoiceRef })}</>}
                {r.fee.note && <> · {r.fee.note}</>}
                {r.fee.decision && r.fee.decidedAt && <> · {t(r.fee.decision === 'approved' ? 'approvedBy' : 'declinedBy', { name: r.fee.decidedBy ?? t('unknownPerson'), date: klDate(locale, r.fee.decidedAt) })}</>}
                {r.fee.decisionReason && <> — {r.fee.decisionReason}</>}
              </p>
            )}
            {!r.fee?.decision && (
              <div className="flex flex-wrap items-start gap-4">
                <details className="w-full max-w-xl" open={!r.fee}>
                  <summary className="cursor-pointer text-sm text-primary">{r.fee ? t('correctFee') : t('recordFee')}</summary>
                  <form action={recordAgencyFeeAction} className="mt-2 grid gap-2 sm:grid-cols-2">
                    {hidden('applicationId', r.applicationId)}{hidden('returnTo', here)}
                    <Field label={t('amount')}><Input name="amount" inputMode="decimal" required maxLength={20} defaultValue={r.fee?.amount ?? ''} /></Field>
                    <Field label={t('currency')}><Input name="currency" required maxLength={3} defaultValue={r.fee?.currency ?? r.companyCurrency} /></Field>
                    <Field label={t('invoiceRef')}><Input name="invoiceRef" maxLength={FEE_INVOICE_MAX} defaultValue={r.fee?.invoiceRef ?? ''} /></Field>
                    <Field label={t('note')}><Input name="note" maxLength={FEE_NOTE_MAX} defaultValue={r.fee?.note ?? ''} /></Field>
                    <div className="sm:col-span-2"><button type="submit" className={btnGhost}>{t('saveFee')}</button></div>
                  </form>
                </details>
                {r.fee && (r.fee.recordedByMe ? <p className="text-sm text-muted-foreground">{t('otherDecides')}</p> : (
                  <div className="flex flex-wrap items-start gap-3">
                    <form action={decideAgencyFeeAction}>
                      {hidden('feeId', r.fee.id)}{hidden('decision', 'approved')}{hidden('returnTo', here)}
                      <button type="submit" className={btnPrimary}>{t('approve')}</button>
                    </form>
                    <details className="w-full max-w-md">
                      <summary className="cursor-pointer text-sm text-primary">{t('decline')}</summary>
                      <form action={decideAgencyFeeAction} className="mt-2 space-y-2">
                        {hidden('feeId', r.fee.id)}{hidden('decision', 'declined')}{hidden('returnTo', here)}
                        <Field label={t('reason')}><textarea name="reason" required maxLength={REWARD_REASON_MAX} rows={2} className={textareaCls} /></Field>
                        <button type="submit" className={btnGhost}>{t('confirmDecline')}</button>
                      </form>
                    </details>
                  </div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

async function PayrollQueue({ queue, here, locale }: { queue: PayrollRewardQueue; here: string; locale: string }) {
  const t = await getTranslations('recruitment.rewards');
  return (
    <section aria-labelledby="payroll-title" className="space-y-3">
      <div>
        <h2 id="payroll-title" className="text-base font-semibold">{t('view.payroll')}</h2>
        <p className="text-sm text-muted-foreground">{t('payrollNote')}</p>
      </div>
      {!queue.ledgerPays && <p role="note" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">{t('ledgerOff')}</p>}
      {!queue.rows.length ? <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('noPayroll')}</p> : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {queue.rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-end justify-between gap-3 px-4 py-3" data-payroll-reward={r.id}>
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">{r.payeeName}{r.payeeCode && <span className="ml-1 font-mono text-xs text-muted-foreground">{r.payeeCode}</span>}</p>
                <p className="text-sm tabular-nums">{money(locale, r.amount, r.currency)}</p>
                <p className="text-xs text-muted-foreground">{t('approvedBy', { name: r.approvedBy ?? t('unknownPerson'), date: klDate(locale, r.approvedAt) })}</p>
              </div>
              {queue.ledgerPays && (
                <form action={sendRewardToPayrollAction} className="flex flex-wrap items-end gap-2">
                  {hidden('rewardId', r.id)}{hidden('returnTo', here)}
                  <Field label={t('payMonth')} className="w-36">
                    <select name="payPeriod" required className={selectCls} defaultValue={queue.months[0]}>
                      {queue.months.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </Field>
                  <Field label={t('component')} className="w-64">
                    <select name="componentId" required className={selectCls} defaultValue="">
                      <option value="" disabled>{t('chooseComponent')}</option>
                      {queue.components.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
                    </select>
                  </Field>
                  <button type="submit" className={btnPrimary}>{t('send')}</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
