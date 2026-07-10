'use client';

import { Fragment, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, EmployeeName } from '@/components/ui';
import type { ProcessedPayslipViewRow } from '@/core/payroll-view';
import { deriveHistoryBreakdown } from './history-breakdown';

/**
 * Transaction History grid (feedback 5f8d8395 — R24 5db3ae48's deferred Phase C) — a client component so each
 * processed-payslip row can EXPAND to an itemized breakdown (Earnings / Deductions / Employer Contributions /
 * Recorded items), mirroring the employee payslip-detail layout. The rows arrive already scope-guarded +
 * filtered from the server page and carry the full statutory blob + aggregates, so expand needs NO extra
 * round-trip. Read-only/presentation only — no server action, no domain event.
 *
 * Deliberately does NOT call payslipDetail() (core/payroll.ts): that fn has an ESS release gate that blanks
 * processed-but-unreleased batches. Admin History legitimately includes those, so we feed the admin payroll-view
 * rows and reuse only the LAYOUT (the me.payslip.* section labels), not the gated read.
 */

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Itemized row inside an expanded breakdown — mirrors the payslip-detail Row primitive. */
function Row({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className={muted ? 'text-muted-foreground' : ''}>{label}</span>
      <span className={`tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

const COL_COUNT = 13; // toggle + 12 summary columns

export function HistoryTable({ rows }: { rows: ProcessedPayslipViewRow[] }) {
  const t = useTranslations('payroll.transactions');
  const tList = useTranslations('payroll.list');
  const tBatch = useTranslations('payroll.batch');
  const tSlip = useTranslations('me.payslip'); // reuse the itemized-payslip section/line labels
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="w-8 px-2 py-2" />
            <th className="px-4 py-2 font-medium">{tList('colPeriod')}</th>
            <th className="px-4 py-2 font-medium">{tList('colCycle')}</th>
            <th className="px-4 py-2 font-medium">{tBatch('colEmployee')}</th>
            <th className="px-4 py-2 font-medium">{tList('colCompany')}</th>
            <th className="px-4 py-2 text-right font-medium">{tBatch('colGross')}</th>
            <th className="px-4 py-2 text-right font-medium">{tBatch('colEpf')}</th>
            <th className="px-4 py-2 text-right font-medium">{tBatch('colSocso')}</th>
            <th className="px-4 py-2 text-right font-medium">{tBatch('colEis')}</th>
            <th className="px-4 py-2 text-right font-medium">{tBatch('colPcb')}</th>
            <th className="px-4 py-2 text-right font-medium">{tBatch('totalDeductions')}</th>
            <th className="px-4 py-2 text-right font-medium">{tBatch('colNet')}</th>
            <th className="px-4 py-2 font-medium">{tList('colStatus')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => {
            const b = deriveHistoryBreakdown(r);
            const st = b.st;
            const isOpen = open.has(r.id);
            return (
              <Fragment key={r.id}>
                <tr className="cursor-pointer transition-colors hover:bg-muted/30" onClick={() => toggle(r.id)}>
                  <td className="px-2 py-2.5 text-center align-middle">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(r.id);
                      }}
                      aria-expanded={isOpen}
                      aria-label={isOpen ? t('view.history.hideBreakdown') : t('view.history.showBreakdown')}
                      className="text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <span className={`inline-block text-xs transition-transform ${isOpen ? 'rotate-90' : ''}`}>
                        ▶
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{r.payPeriod}</td>
                  <td className="px-4 py-2.5">
                    {t(`individual.cycle.${r.runType}`)}
                    {r.runSeq > 1 ? ` #${r.runSeq}` : ''}
                  </td>
                  <td className="px-4 py-2.5 font-medium">
                    {/* Employee ID left-of-name (feedback 38668d9b) */}
                    <EmployeeName code={r.employeeCode} name={r.employeeName} />
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{r.company}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{rm(r.gross)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.epfEmployee)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.socsoEmployee)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.eisEmployee)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.pcb)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(r.totalDeductions)}</td>
                  <td className="px-4 py-2.5 text-right font-medium tabular-nums">{rm(r.net)}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant="success">{tList(`status.${r.batchStatus}`)}</Badge>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="bg-muted/20">
                    <td colSpan={COL_COUNT} className="px-4 py-4">
                      <div className="mx-auto grid max-w-3xl gap-5 sm:grid-cols-2">
                        {/* ── Earnings ── */}
                        <section className="sm:col-span-2">
                          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {tSlip('earnings')}
                          </h3>
                          <Row label={tSlip('basicSalary')} value={rm(b.basic)} />
                          {/* f3148da1 — converted OT excess is folded into stored allowance; show base allowance
                              net of it, then a dedicated line for the pay item, so gross still reconciles. */}
                          <Row label={tSlip('allowances')} value={rm(b.allowanceNet)} />
                          <Row label={tSlip('overtime')} value={rm(b.overtime)} />
                          {b.otConvertAmount > 0 && (
                            <Row label={tSlip('otConverted', { item: st.otConvert!.name })} value={rm(b.otConvertAmount)} />
                          )}
                          <Row label={tSlip('bonus')} value={rm(b.bonus)} />
                          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
                            <span>{tSlip('grossPay')}</span>
                            <span className="tabular-nums">{rm(b.gross)}</span>
                          </div>
                        </section>

                        {/* ── Deductions ── */}
                        <section>
                          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {tSlip('deductionsHeading')}
                          </h3>
                          <Row label={tSlip('epf')} value={rm(st.epfEmployee)} />
                          <Row label={tSlip('socso')} value={rm(st.socsoEmployee)} />
                          {Number(st.socsoSkbbk) > 0 && <Row label={tSlip('skbbk')} value={rm(st.socsoSkbbk)} />}
                          <Row label={tSlip('eis')} value={rm(st.eisEmployee)} />
                          <Row label={tSlip('pcb')} value={rm(st.pcb)} />
                          {Number(st.cp38) > 0 && <Row label={tSlip('cp38')} value={rm(st.cp38)} />}
                          {/* Zakat — informational only: PCB is ALREADY net of this (LHDN §E.5 offset). Muted. */}
                          {Number(st.zakat) > 0 && (
                            <Row label={tSlip('zakat')} value={`${rm(st.zakat)} · ${tSlip('zakatOffsetNote')}`} muted />
                          )}
                          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
                            <span>{tSlip('totalDeductions')}</span>
                            <span className="tabular-nums">−{rm(b.totalDeductions)}</span>
                          </div>
                        </section>

                        {/* ── Employer Contributions ── */}
                        <section>
                          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {tSlip('employerContributionsHeading')}
                          </h3>
                          <Row label={tSlip('epf')} value={rm(b.employerContributions.epf)} muted />
                          <Row label={tSlip('socso')} value={rm(b.employerContributions.socso)} muted />
                          <Row label={tSlip('eis')} value={rm(b.employerContributions.eis)} muted />
                          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
                            <span>{t('view.history.totalEmployerContributions')}</span>
                            <span className="tabular-nums">{rm(b.employerContributions.total)}</span>
                          </div>
                        </section>

                        {/* ── Recorded items (no cash impact) ── */}
                        {b.recordLines.length > 0 && (
                          <section className="sm:col-span-2">
                            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              {tSlip('recordLinesHeading')}
                            </h3>
                            {b.recordLines.map((l) => (
                              <Row key={l.code} label={`${l.code} · ${l.name}`} value={rm(l.amount)} muted />
                            ))}
                            <p className="mt-2 text-xs text-muted-foreground">{tSlip('recordLinesNote')}</p>
                          </section>
                        )}

                        {/* ── Net pay ── */}
                        <div className="flex items-baseline justify-between rounded-lg bg-primary/5 px-4 py-3 sm:col-span-2">
                          <span className="text-sm font-semibold">{tSlip('netPay')}</span>
                          <span className="text-lg font-bold tabular-nums text-primary">{rm(b.net)}</span>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={COL_COUNT} className="px-4 py-8 text-center text-muted-foreground">
                {t('view.history.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
