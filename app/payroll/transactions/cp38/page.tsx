import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { readEmployeeChoices } from '@/core/employee-choice';
import { CP38_STATUSES, listCp38Across, listCp38Revisions, type Cp38Status } from '@/packs/payroll/service';
import { parseKeysetPageQuery, keysetPageState } from '@/lib/pagination';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { formatDmy } from '@/lib/date-display';
import { Badge, Button, Card, EmployeeName, Field, PageHeader, SectionHeader, inputCls, pageWideCls } from '@/components/ui';
import { Pager } from '@/components/pager';
import { CollapsibleEmployeePanel, EmployeeScopePanel } from '@/components/collapsible-employee-panel';
import type { Cp38HistoryEntry, Cp38HistoryLabels } from '@/components/cp38/history-list';
import { Cp38AddButton, Cp38EmployeeHistoryButton, Cp38RowActions, type Cp38DialogLabels } from './cp38-dialog';

/**
 * 038c304b — Payroll > Transaction Entry > CP38 Deduction: every employee's CP38 instalment for the companies the
 * administrator can see, laid out like the Zakat page (the shared employee panel on the left, a header with the
 * chosen person and Add, then one list). The records are the employee's own (employee_cp38): a change here is on the
 * employee's Payroll tab straight away and the other way round, because both screens call the same core/cp38.ts
 * writers (bc6b5490: Edit and Delete always offered, closed payslips never recalculated, a processed run that is not
 * closed marked Reprocess Required, correction History on every record).
 *
 * READS (ADR 0181, docs/SCALE-AND-RELEASE-RULES.md rules 2 and 3) — none of the Zakat page's load-everything readers:
 *  - the employee panel is the shared REMOTE picker (core/employee-choice.ts readEmployeeChoices: one bounded page plus
 *    the selection; later pages through /api/employee-choices), not every employee;
 *  - the list is one keyset page and a capped count (core/cp38.ts listCp38Across, "1,000+"), filtered in SQL by
 *    company (one uuid[] parameter), the chosen employee and status;
 *  - History for the page's rows is one read by their ids, and the chosen employee's whole history (deleted records
 *    included) one read by employment.
 * Leavers stay in the list (their history) and can be chosen to narrow it; Add is offered only for an active one.
 *
 * GUARD: scopedAdmin (company scope from the switcher) and the Payroll module. The writers refuse anything outside
 * the scope or the caller's payroll administration on their own; this page only decides what to show.
 */

/** One cookie per screen — each collapses independently (the convention f3ae3245 set for Fixed). */
export const CP38_PANEL_COOKIE = 'txn_cp38_panel';
const BASE = '/payroll/transactions/cp38';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Cp38DeductionPage({
  searchParams,
}: {
  searchParams: Promise<{
    employmentId?: string;
    company?: string;
    status?: string;
    page?: string;
    size?: string;
    after?: string;
    before?: string;
    last?: string;
    count?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  await requireModule('payroll', s);
  const t = await getTranslations('payroll.transactions.cp38');
  const tTxn = await getTranslations('payroll.transactions');
  const sp = await searchParams;
  const pq = parseKeysetPageQuery(sp);
  const today = todayInKualaLumpur();
  const thisMonth = `${today.slice(0, 7)}-01`;

  // ── Filters, each scope-guarded: an out-of-scope or malformed value is ignored, never widened ──
  const companies = (await listCompanies(s, { adminOnly: true })).filter((c) => scopeIds.includes(c.id));
  const companyId = sp.company && companies.some((c) => c.id === sp.company) ? sp.company : undefined;
  const status = (CP38_STATUSES as readonly string[]).includes(sp.status ?? '') ? (sp.status as Cp38Status) : undefined;
  const choices = await readEmployeeChoices(s, {
    companyIds: scopeIds,
    labelMode: 'names',
    selectedId: sp.employmentId && UUID.test(sp.employmentId) ? sp.employmentId : undefined,
  });
  const selected = choices.selected;

  const listCompanyIds = companyId ? [companyId] : scopeIds;
  const { rows, ...read } = await listCp38Across(s, {
    companyIds: listCompanyIds,
    employmentId: selected?.employmentId ?? null,
    status: status ?? null,
    today,
    page: pq,
  });
  const pgState = keysetPageState(pq, read, rows.map((r) => r.id));
  const [rowRevisions, employeeRevisions] = await Promise.all([
    rows.length ? listCp38Revisions(s, { cp38Ids: rows.map((r) => r.id) }) : Promise.resolve([]),
    selected ? listCp38Revisions(s, { employmentId: selected.employmentId }) : Promise.resolve([]),
  ]);
  const entry = (h: (typeof rowRevisions)[number]): Cp38HistoryEntry => ({
    id: h.id,
    cp38Id: h.cp38Id,
    action: h.action,
    before: h.before,
    after: h.after,
    actorName: h.actorName, byUser: h.byUser,
    at: h.at.toISOString(),
  });
  const historyByRecord = new Map<string, Cp38HistoryEntry[]>();
  for (const h of rowRevisions) historyByRecord.set(h.cp38Id, [...(historyByRecord.get(h.cp38Id) ?? []), entry(h)]);

  // The filters the list is showing, carried by the pager, the panel and every save's way back.
  const filterParams: Record<string, string> = {
    ...(selected ? { employmentId: selected.employmentId } : {}),
    ...(companyId ? { company: companyId } : {}),
    ...(status ? { status } : {}),
  };
  const returnTo = `${BASE}${Object.keys(filterParams).length ? `?${new URLSearchParams(filterParams)}` : ''}`;
  const panelPreserve: Record<string, string> = {
    ...(companyId ? { company: companyId } : {}),
    ...(status ? { status } : {}),
  };
  const panelDefaultOpen = (await cookies()).get(CP38_PANEL_COOKIE)?.value !== '0';

  const money = (v: string) => Number(v).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const historyLabels: Cp38HistoryLabels = {
    empty: t('history.empty'), edited: t('history.edited'), deleted: t('history.deleted'), system: t('history.system'), administrator: t('history.administrator'),
    field: t('history.field'), before: t('history.before'), after: t('history.after'), open: t('open'), none: t('history.none'),
    fields: { cp38Ref: t('ref'), amount: t('amount'), lastMonthAmount: t('lastMonthAmount'), validFrom: t('from'), validTo: t('to'), remarks: t('remarks') },
  };
  const labels: Cp38DialogLabels = {
    add: t('add'), addTitle: t('addTitle'), edit: t('edit'), editTitle: t('editTitle'), save: t('save'), saving: t('saving'),
    close: t('close'), ref: t('ref'), refPlaceholder: t('refPlaceholder'), amount: t('amount'), from: t('from'), to: t('to'),
    toHint: t('toHint'), remarks: t('remarks'), remarksPlaceholder: t('remarksPlaceholder'),
    lastMonth: { toggle: t('lastMonthToggle'), amount: t('lastMonthAmount'), hint: t('lastMonthHint') },
    delete: t('delete'), deleteTitle: t('deleteTitle'), history: t('history.button'), historyTitle: t('history.title'), historyLabels,
  };
  const statusLabel = (st: Cp38Status) => (st === 'active' ? t('statusActive') : st === 'upcoming' ? t('statusUpcoming') : t('statusEnded'));

  return (
    <div className={pageWideCls}>
      <PageHeader back={{ href: '/payroll/transactions', label: tTxn('title') }} title={t('title')} description={t('subtitle')} />

      <CollapsibleEmployeePanel
        defaultOpen={panelDefaultOpen}
        cookieKey={CP38_PANEL_COOKIE}
        title={t('title')}
        detailHeader={
          selected ? (
            <>
              <div className="min-w-0 flex-1">
                <EmployeeName code={selected.employeeCode} name={selected.name} className="text-sm font-semibold text-foreground" />
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {selected.company} · {selected.department ?? '—'}
                </p>
              </div>
              <Cp38EmployeeHistoryButton history={employeeRevisions.map(entry)} labels={labels} title={t('history.employeeTitle')} />
              {/* Only an active employee can be given a new record (038c304b); a leaver's list stays readable. */}
              {selected.status === 'active' && (
                <Cp38AddButton employmentId={selected.employmentId} returnTo={returnTo} defaultFrom={thisMonth} labels={labels} />
              )}
            </>
          ) : undefined
        }
        panel={
          <Card className="p-4">
            <h2 className="text-sm font-semibold">{t('pickEmployee')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('pickEmployeeHint')}</p>
            <div className="mt-3">
              <EmployeeScopePanel
                remote={{ initial: choices }}
                selectedId={selected?.employmentId ?? null}
                basePath={BASE}
                preserve={panelPreserve}
                allowAll
              />
            </div>
          </Card>
        }
      >
        <Card className="overflow-hidden">
          <SectionHeader title={t('listTitle')} count={read.total.count} countCapped={read.total.capped} />
          {/* Filters (GET form — pure navigation). Carries the panel's ?employmentId. */}
          <form method="GET" className="flex flex-wrap items-end gap-3 px-4 pt-3">
            {selected && <input type="hidden" name="employmentId" value={selected.employmentId} />}
            <Field label={t('filterCompany')}>
              <select name="company" defaultValue={companyId ?? ''} className={inputCls}>
                <option value="">{t('all')}</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('status')}>
              <select name="status" defaultValue={status ?? ''} className={inputCls}>
                <option value="">{t('all')}</option>
                {CP38_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {statusLabel(st)}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit" variant="secondary">
              {t('apply')}
            </Button>
          </form>
          {!selected && <p className="px-4 pt-2 text-xs text-muted-foreground">{t('pickEmployeeAddHint')}</p>}

          <div className="mt-3">
            <Pager basePath={BASE} params={filterParams} state={pgState} />
          </div>
          {rows.length === 0 ? (
            <p className="px-4 pb-4 pt-2 text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <div className="overflow-x-auto px-4 pb-4">
              <table className="w-full min-w-[64rem] text-left text-sm" data-cp38-list="">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">{t('colEmployeeId')}</th>
                    <th className="py-2 pr-3 font-medium">{t('colName')}</th>
                    <th className="py-2 pr-3 font-medium">{t('colCompany')}</th>
                    <th className="py-2 pr-3 font-medium">{t('ref')}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t('amount')}</th>
                    <th className="py-2 pr-3 font-medium">{t('from')}</th>
                    <th className="py-2 pr-3 font-medium">{t('to')}</th>
                    <th className="py-2 pr-3 font-medium">{t('remarks')}</th>
                    <th className="py-2 pr-3 font-medium">{t('status')}</th>
                    <th className="py-2 text-right font-medium">{t('colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border/60 align-top" data-cp38-row={r.id}>
                      <td className="py-2 pr-3 font-mono text-xs">{r.employeeCode ?? '—'}</td>
                      <td className="py-2 pr-3">{r.employeeName}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{r.company}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{r.cp38Ref}</td>
                      <td className="whitespace-nowrap py-2 pr-3 text-right font-medium tabular-nums">
                        {money(r.amount)}
                        {r.lastMonthAmount != null && (
                          <span className="block text-xs font-normal text-muted-foreground">
                            {t('lastMonthShort', { amount: money(r.lastMonthAmount) })}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{formatDmy(r.validFrom)}</td>
                      <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{r.validTo ? formatDmy(r.validTo) : t('open')}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{r.remarks ?? '—'}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={r.status === 'active' ? 'success' : 'default'}>{statusLabel(r.status)}</Badge>
                      </td>
                      <td className="py-2">
                        <Cp38RowActions
                          record={{
                            id: r.id,
                            employmentId: r.employmentId,
                            cp38Ref: r.cp38Ref,
                            amount: r.amount,
                            lastMonthAmount: r.lastMonthAmount,
                            validFrom: r.validFrom,
                            validTo: r.validTo,
                            remarks: r.remarks,
                          }}
                          returnTo={returnTo}
                          labels={labels}
                          history={historyByRecord.get(r.id) ?? []}
                          deleteDescription={t('deleteConfirm', {
                            ref: r.cp38Ref,
                            amount: money(r.amount),
                            from: formatDmy(r.validFrom),
                            to: r.validTo ? formatDmy(r.validTo) : t('open'),
                          })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="px-4 pb-4 text-xs text-muted-foreground">{t('hint')}</p>
        </Card>
      </CollapsibleEmployeePanel>
    </div>
  );
}
