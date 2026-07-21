import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import {
  delegationsScoped,
  employmentPickerList,
  listApprovalHistory,
  myEmploymentIdsAll,
} from '@/core/read';
import {
  APPROVAL_HISTORY_ACTIONS,
  APPROVAL_HISTORY_MODULES,
  isApprovalHistoryAction,
  isApprovalHistoryModule,
  shapeApprovalHistoryItems,
} from '@/lib/approval-history';
import { Card, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';

const PAGE = 50;
const MYT = 'Asia/Kuala_Lumpur';

/** Today's date in the tenant-local (MYT) calendar, yyyy-mm-dd. */
const mytToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: MYT }).format(new Date());
const isDate = (v?: string) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');
const isUuid = (v?: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v ?? '');
/** yyyy-mm-dd (an MYT calendar day) → the ISO instant of that day's 00:00 MYT. */
const mytStartIso = (d: string) => new Date(`${d}T00:00:00+08:00`).toISOString();
const nextDay = (d: string) =>
  new Date(new Date(`${d}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);

/**
 * Full approval-activity history (feedback 44a89810) — the view-only decision log behind the bell's
 * History tab. Same viewer gate as /approvals (admin or manager). Visibility, name resolution and the
 * "on behalf of" derivation all live in app.approval_history (migration 0288) via listApprovalHistory —
 * this page only assembles filters, searchParams-driven like /approvals and /admin/audit.
 *
 * Hand-over-period pinning: choosing one of the viewer's own past delegation windows auto-fills the date
 * bounds (valid_from 00:00 MYT inclusive → valid_to next-day 00:00 MYT exclusive) and pins the decider
 * filter to the stand-in — so "what did my stand-in decide while I was away" is one click.
 */
export default async function ApprovalHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{
    period?: string;
    from?: string;
    to?: string;
    module?: string;
    action?: string;
    decider?: string;
    page?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const admin = isAdmin(s);
  const manager = (s.roles ?? []).includes('manager');
  if (!admin && !manager) redirect('/');
  const sp = await searchParams;
  const t = await getTranslations('approvalHistory');
  const locale = await getLocale();
  const page = Math.max(0, Number(sp.page) || 0);

  // The viewer's own hand-over periods (viewer = DELEGATOR). app.self_delegations self-scopes and
  // resolves both names under the definer boundary; history:true keeps past windows selectable.
  const [myEmps, delegations] = await Promise.all([
    myEmploymentIdsAll(s),
    delegationsScoped(s, { isAdmin: false, history: true, asOf: mytToday() }),
  ]);
  const myEmpIds = new Set(myEmps.map((e) => e.employmentId));
  const periods = delegations.filter((d) => myEmpIds.has(d.delegatorEmploymentId));
  const period = sp.period ? periods.find((p) => p.id === sp.period) : undefined;

  const fromDate = period ? period.validFrom : isDate(sp.from) ? sp.from : undefined;
  const toDate = period ? (period.validTo ?? undefined) : isDate(sp.to) ? sp.to : undefined;
  const decider = period ? period.delegateEmploymentId : isUuid(sp.decider) ? sp.decider : undefined;
  const moduleKey = sp.module && isApprovalHistoryModule(sp.module) ? sp.module : undefined;
  const action = sp.action && isApprovalHistoryAction(sp.action) ? sp.action : undefined;

  const [rowsPlusOne, people] = await Promise.all([
    listApprovalHistory(s, {
      from: fromDate ? mytStartIso(fromDate) : undefined,
      to: toDate ? mytStartIso(nextDay(toDate)) : undefined,
      module: moduleKey,
      action,
      deciderEmploymentId: decider,
      limit: PAGE + 1, // one extra to know whether a next page exists
      offset: page * PAGE,
    }),
    employmentPickerList(s, scopeIds),
  ]);
  const hasNext = rowsPlusOne.length > PAGE;
  const items = shapeApprovalHistoryItems(rowsPlusOne.slice(0, PAGE));
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: MYT });

  const qs = (over: Record<string, string | number | undefined>) => {
    const merged = {
      period: sp.period,
      from: sp.from,
      to: sp.to,
      module: sp.module,
      action: sp.action,
      decider: sp.decider,
      page: sp.page,
      ...over,
    };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, String(v));
    return `/approvals/history?${p.toString()}`;
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />

      <Card>
        <form className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
          <Field label={t('period')}>
            <select name="period" defaultValue={sp.period ?? ''} className={inputCls}>
              <option value="">{t('periodPlaceholder')}</option>
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.delegateName} · {p.validFrom} → {p.validTo ?? t('ongoing')}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('from')}>
            <input name="from" type="date" defaultValue={fromDate ?? ''} className={inputCls} />
          </Field>
          <Field label={t('to')}>
            <input name="to" type="date" defaultValue={toDate ?? ''} className={inputCls} />
          </Field>
          <Field label={t('area')}>
            <select name="module" defaultValue={sp.module ?? ''} className={inputCls}>
              <option value="">{t('allAreas')}</option>
              {APPROVAL_HISTORY_MODULES.map((m) => (
                <option key={m} value={m}>
                  {t(`module.${m}` as 'module.leave')}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('action')}>
            <select name="action" defaultValue={sp.action ?? ''} className={inputCls}>
              <option value="">{t('allActions')}</option>
              {APPROVAL_HISTORY_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {t(`actionLabel.${a}` as 'actionLabel.approved')}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('decider')}>
            <select name="decider" defaultValue={decider ?? ''} className={inputCls}>
              <option value="">{t('allDeciders')}</option>
              {people.map((p) => (
                <option key={p.employmentId} value={p.employmentId}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-center gap-2">
            <button className={btnPrimary}>{t('filter')}</button>
            <Link href="/approvals/history" className="text-sm text-muted-foreground hover:text-foreground">
              {t('reset')}
            </Link>
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={t('rows')} count={items.length} />
        {items.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colDate')}</th>
                <th className="px-4 py-2 font-medium">{t('colRequest')}</th>
                <th className="px-4 py-2 font-medium">{t('colAction')}</th>
                <th className="px-4 py-2 font-medium">{t('colDecider')}</th>
                <th className="px-4 py-2 font-medium">{t('colOnBehalf')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((h) => (
                <tr key={h.id}>
                  <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-muted-foreground">
                    {fmt.format(new Date(h.occurredAt))}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="font-medium">{t(`module.${h.moduleKey}` as 'module.leave')}</span>
                    {h.subjectName && <span className="text-muted-foreground"> · {h.subjectName}</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        h.actionKey === 'rejected' || h.actionKey === 'terminated'
                          ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                          : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      }`}
                    >
                      {t(`actionLabel.${h.actionKey}` as 'actionLabel.approved')}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {h.isAuto ? (
                      <span className="text-muted-foreground">{t('systemAutomatic')}</span>
                    ) : (
                      (h.deciderName ?? '—')
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {!h.isAuto && h.onBehalfOfName ? h.onBehalfOfName : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(page > 0 || hasNext) && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm">
            {page > 0 ? (
              <Link href={qs({ page: page - 1 || undefined })} className="text-primary hover:underline">
                ← {t('newer')}
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-muted-foreground">{t('pageIndicator', { page: page + 1 })}</span>
            {hasNext ? (
              <Link href={qs({ page: page + 1 })} className="text-primary hover:underline">
                {t('older')} →
              </Link>
            ) : (
              <span />
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
