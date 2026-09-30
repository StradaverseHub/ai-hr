'use client';

import { Fragment, useState } from 'react';
import { paginateRows } from '@/lib/pagination';
import { ClientPager, useClientPageQuery } from '@/components/client-pager';

import { useTranslations } from 'next-intl';
import { Badge, EmployeeName } from '@/components/ui';
import type { ProcessedPayslipViewRow } from '@/core/payroll-view';
import { deriveHistoryBreakdown } from './history-breakdown';
// 6b134681 / 417d4937 — one label format for a pay item, shared with the ESS payslip and the printed
// document: the item's own code and description, never the category it was classified into.
// 417d4937 — and the ONE answer to "what is this recorded line actually called?", which is a different
// question from the one above: a record line's stored name was a free-text remark until r196, so it is
// repaired from the catalogue at READ time with the words that were typed kept beside it as the remark.
import { payItemLabel, recordLineIdentity, type PayItemNames } from '@/core/payslip-earning-lines';
// 3c88d593 — which days of the period a payslip claims, from the payslip's OWN record. Two lines for one
// month is otherwise indistinguishable from a duplicate on this list.
import { payslipSegmentOf } from '@/core/payslip-segment';
import type { EmployerBorneKey } from '@/core/payslip-employer-borne';
import { payslipSkbbkLineShown, payslipSkbbkSubject } from '@/core/payslip-skbbk-line';
// 970e4143 — the day-count composer the other three payslip surfaces already use for these rows.
import { absenceDaysLabel } from '@/core/payslip-absence-lines';
// 417d4937 request 10 — the one-off transactions behind this run's recorded items, listed BESIDE them
// (never matched to them: see the component's own note on why a (code, amount) join would be worse).
import type { PayslipSourceTxnRow } from '@/core/payroll-view';
import { SourceTxnBlock } from './source-txn-block';

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
/** The pay items behind a summarised figure (862ed0ad). Indented under the figure they explain, and
 *  rendered ONLY from what the payslip stored — never re-derived from today's pay-item assignments, which
 *  is how a breakdown ends up disagreeing with the total printed above it.
 *
 *  6b134681 — the line now carries its CODE as well as its description ("B0001 · ANGPOW"), matching the
 *  Recorded items rows below and the printed payslip. A description alone is not an identification: two
 *  pay items may legitimately share a name, and the reporter's whole complaint is that the result screen
 *  stopped naming the item that was keyed. */
function SubLines({ lines, fmt }: { lines: { code: string; name: string; amount: number }[]; fmt: (n: number) => string }) {
  if (lines.length === 0) return null;
  return (
    <ul className="mb-1 ms-3 border-s border-border/60 ps-3">
      {lines.map((l, i) => (
        <li key={`${l.code}-${i}`} className="flex items-baseline justify-between gap-4 py-0.5 text-xs text-muted-foreground">
          <span>{payItemLabel(l)}</span>
          <span className="tabular-nums">{fmt(l.amount)}</span>
        </li>
      ))}
    </ul>
  );
}

function Row({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className={muted ? 'text-muted-foreground' : ''}>{label}</span>
      <span className={`tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

/** 3c473773 — the me.payslip label key for each employer-borne component. A computed t() key is invisible
 *  to the i18n guard's literal scan, so the map is exhaustive over EmployerBorneKey and every value is a
 *  key that already exists in all six catalogs (test/pay-display-category.test.ts pins that). */
const EMPLOYER_BORNE_LABEL: Record<EmployerBorneKey, 'epf' | 'socso' | 'skbbk' | 'eis' | 'pcb'> = {
  epf: 'epf', socso: 'socso', skbbk: 'skbbk', eis: 'eis', tax: 'pcb',
};

const COL_COUNT = 13; // toggle + 12 summary columns

export function HistoryTable({
  rows,
  hrdfRegisteredCompanyIds,
  payItemNames,
  sourceTxnsByPayslip,
}: {
  rows: ProcessedPayslipViewRow[];
  /** Feedback efece4ce — companies whose HRDF Contribution Rate is set (0.5% / 1.0%). Everything else is
   *  unregistered and levies nothing, which the breakdown must SAY rather than leave blank. */
  hrdfRegisteredCompanyIds: string[];
  /** 417d4937 — code → today's pay item description, read on the SERVER and handed over as plain data.
   *  Optional so a caller with no catalogue to hand degrades to the stored words rather than to nothing. */
  payItemNames?: PayItemNames;
  /** 417d4937 request 10 — the run's one-off ledger rows, keyed `${batchId}:${employmentId}` (the pair a
   *  payslip IS). Grouped on the server so this component does no folding. Absent ⇒ no provenance block,
   *  which is exactly what a caller that did not read them should render. */
  sourceTxnsByPayslip?: Record<string, PayslipSourceTxnRow[]>;
}) {
  const hrdfRegistered = new Set(hrdfRegisteredCompanyIds);
  const t = useTranslations('payroll.transactions');
  const tList = useTranslations('payroll.list');
  const tBatch = useTranslations('payroll.batch');
  const tSlip = useTranslations('me.payslip'); // reuse the itemized-payslip section/line labels
  // r367 — the employer-contributions note. It lives under `payroll.individualPayslip`, where the
  // payslip DOCUMENT already resolves it (lib/payslip-pdf-strings.ts), so this panel reads the one
  // existing sentence rather than minting a sixth translation of it under `me.` or `payroll.`.
  const tIp = useTranslations('payroll.individualPayslip');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const q = useClientPageQuery();
  const { rows: pageRows, state } = paginateRows(rows, q);

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
          {pageRows.map((r) => {
            const b = deriveHistoryBreakdown(r);
            const st = b.st;
            const isOpen = open.has(r.id);
            // 3c88d593 — null for every payslip that covered its whole month, which is every payslip this
            // system issued until an entity transfer split one. Read from the slip's own coverage record,
            // never re-derived from today's assignment history: a correction made afterwards must not be
            // able to restate what an already-issued document covered.
            const segment = payslipSegmentOf(r, r.payPeriod);
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
                  {/* 3c88d593 — WHY THERE ARE TWO AUGUST LINES. This list already showed a transferred
                      employee's two results as two rows, and nothing on it said which days each employer
                      paid for, so the second row read as a duplicate. The badge names the reason and the
                      line under it gives the dates, in the same wording the payslip itself prints. An
                      unsegmented payslip renders exactly the single period it always did. */}
                  <td className="px-4 py-2.5 align-top tabular-nums">
                    <span className="block">{r.payPeriod}</span>
                    {segment && (
                      <>
                        <Badge variant="info" className="mt-1">
                          {t('view.history.splitBadge')}
                        </Badge>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {t('view.history.coverageLine', { from: segment.from, to: segment.to })}
                        </span>
                      </>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {t(`individual.cycle.${r.runType}`)}
                    {r.runSeq > 1 ? ` #${r.runSeq}` : ''}
                  </td>
                  {/* 1372d169 — thirteen columns is the worst case on this screen, and employee + company
                      were the two that wrapped onto a second line. They stay on one line; the wrapper's
                      overflow-x-auto still covers a narrow window. The <th> captions are left wrappable on
                      purpose — TOTAL DEDUCTIONS legitimately uses two header lines. */}
                  <td className="whitespace-nowrap px-4 py-2.5 font-medium">
                    {/* Employee ID left-of-name (feedback 38668d9b) */}
                    <EmployeeName code={r.employeeCode} name={r.employeeName} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{r.company}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{rm(r.gross)}</td>
                  {/* 3c473773 — the same employee-borne figures the expanded breakdown shows. Reading the
                      raw blob here and the net figure there would put two contradictory numbers for one
                      deduction on one screen. */}
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(b.employerBorne.employee.epf)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(b.employerBorne.employee.socso)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(b.employerBorne.employee.eis)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(b.employerBorne.employee.pcb)}</td>
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
                          {/* 862ed0ad — the reporter's example was "an Allowance line reads MYR 200.00 with
                              no indication of which allowances make it up". It now breaks down, from detail
                              the kernel STAMPS at generate time (core/payroll.ts earningsOf). Runs
                              calculated before that stamp never stored it and cannot have it reconstructed,
                              so they say so instead — re-deriving from today's pay-item assignments could
                              print a breakdown that disagrees with the figure above it, which the plan
                              ruled out. */}
                          {/* 417d4937 — wage AND reimburse. A PCB-exempt allowance (Meal Allowance,
                              exemption PCB_NON-TAXABLE) is stamped into the reimburse bucket, is paid,
                              and is inside this very figure; itemising `wage` alone made it the one
                              allowance that appeared to have no name here while Transaction Detail
                              showed it correctly. */}
                          <SubLines lines={b.allowanceLines} fmt={rm} />
                          {b.detailNotRecorded && b.allowanceNet > 0 && (
                            <p className="pb-1 text-[11px] text-muted-foreground">{t('view.history.detailNotRecorded')}</p>
                          )}
                          <Row label={tSlip('overtime')} value={rm(b.overtime)} />
                          {/* 6b134681 — RECONCILED lists, not the raw buckets. The figure beside the label
                              is the DISPLAY box (3c473773) while `componentsByBucket` is the KERNEL's
                              statutory routing, and core/pay-display-category.ts exists because the two
                              diverge: an item declared into the Overtime box but bucketed as `bonus` used
                              to print an itemised row under a zero Bonus total here. The derivation now
                              hands out the lines only when they add up to the figure they explain — the
                              same rule the printed payslip and the ESS payslip apply, so all four payroll
                              result surfaces read one payslip the same way. */}
                          <SubLines lines={b.overtimeLines} fmt={rm} />
                          {b.otConvertAmount > 0 && (
                            <Row label={tSlip('otConverted', { item: st.otConvert!.name })} value={rm(b.otConvertAmount)} />
                          )}
                          <Row label={tSlip('bonus')} value={rm(b.bonus)} />
                          <SubLines lines={b.bonusLines} fmt={rm} />
                          {/* 3c473773 — the Claim box. Present ONLY when a pay item was deliberately
                              categorised into it; the 0393 backfill never produces one, so no existing
                              payslip grows a line and nothing moves off Allowances on release day. */}
                          {b.claim > 0 && <Row label={tSlip('claim')} value={rm(b.claim)} />}
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
                          {/* 3c473773 issue 2 — these are the EMPLOYEE-BORNE figures: the computed share less
                              whatever the employer agreed to fund, read from this payslip's own stored
                              snapshot. The engine has always moved the money; the payslip previously listed
                              a deduction that had not been deducted, beside a total that excluded it, and
                              the reporter reasonably concluded the setting was ignored. The FULL share is
                              unchanged and still what PERKESO/KWSP/LHDN receive — it is restated in the
                              disclosure block below. A payslip with no snapshot renders exactly as before. */}
                          <Row label={tSlip('epf')} value={rm(b.employerBorne.employee.epf)} />
                          <Row label={tSlip('socso')} value={rm(b.employerBorne.employee.socso)} />
                          {/* a96d320c rev 2 — the ELECTION, not the amount: `> 0` could not tell "this
                              employee has no SKBBK" from "has SKBBK, contributed 0.00 this run", and it is
                              the second of those where the zero is the assertion. One predicate, shared
                              with the printed document and the two payslip screens
                              (core/payslip-skbbk-line.ts).

                              ⚠️ THE ZERO-EARNINGS RULE OF THIS ROUND STOPS HERE, DELIBERATELY. The
                              reporter asked for empty Allowance / Overtime / Bonus lines to come off THE
                              PAYSLIP, and the printed document and the two payslip screens now do that.
                              This panel is not a payslip: it is the operator's reconciliation grid for a
                              whole run, read column-wise against the neighbouring employees and against
                              the CSV `history-export.ts` writes — and that export emits Allowance,
                              Overtime and Bonus as FIXED columns. Hiding the rows here would make one
                              employee's panel a different shape from the next and would put the screen out
                              of step with its own download, which is a worse answer for this reader than a
                              0.00. Revisit only if the operator asks. */}
                          {payslipSkbbkLineShown(payslipSkbbkSubject(st), b.employerBorne.employee.skbbk) && (
                            <Row label={tSlip('skbbk')} value={rm(b.employerBorne.employee.skbbk)} />
                          )}
                          <Row label={tSlip('eis')} value={rm(b.employerBorne.employee.eis)} />
                          {/* 45df860a — THE PCB AMOUNT IS THE LINK. The reporter's complaint was that
                              this figure is the one nobody can check and the only one with no way in:
                              "the amount shall be clickable". It opens the SHARED calculation screen in
                              a new tab (`rel="noopener noreferrer"`, because target=_blank otherwise
                              hands the new document a live window.opener handle back to this one),
                              carrying this payslip's id — so the working shown is this employee, this
                              company, this month, this cycle and this run, never a re-selection. */}
                          <Row
                            label={tSlip('pcb')}
                            value={
                              <a
                                href={`/payroll/pcb-detail?payslipId=${encodeURIComponent(r.id)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                title={t('view.history.viewPcbCalculation')}
                                className="text-primary underline underline-offset-2 hover:no-underline"
                              >
                                {rm(b.employerBorne.employee.pcb)}
                              </a>
                            }
                          />
                          {/* 970e4143 — the APPLIED instalment, from the shared decider, never the
                              pre-clamp `st.cp38`. See app/me/payslip/[payslipId]/page.tsx. */}
                          {b.absence.cp38.show && (
                            <Row label={tSlip('cp38')} value={rm(b.absence.cp38.amount)} />
                          )}
                          {/* 3a092cf0 — a real deduction line now, un-muted, with the amount alone in the
                              figure column and the offset note on the label. Third of the three surfaces
                              that render this payslip section; see app/me/payslip/[payslipId]/page.tsx. */}
                          {Number(st.zakat) > 0 && (
                            <Row label={`${tSlip('zakat')} · ${tSlip('zakatOffsetNote')}`} value={rm(st.zakat)} />
                          )}
                          {/* ── 970e4143 — THE ROWS THAT WERE MISSING ENTIRELY ────────────────────────────
                              This panel printed EPF / SOCSO / SKBBK / EIS / PCB / CP38 / Zakat above a
                              TOTAL DEDUCTIONS and had NO other-deductions row at all, so an operator
                              reconciling a run column-wise found the rows falling SHORT of the total by
                              whatever `other_deductions` held: unpaid leave, a manual deduction, a staff
                              loan, a carry-forward recovery. Measured as part of item 970e4143, whose
                              other half was the opposite failure on the payslip surfaces.

                              Same three rows, same decider and same order as the employee's own payslip
                              and the printed document, so one slip reads the same on all four. */}
                          {b.absence.unpaidLeave && (
                            <Row
                              label={`${tSlip('unpaidLeaveLine')} · ${absenceDaysLabel(b.absence.unpaidLeave.days, tSlip('dayUnit'), tSlip('daysUnit'))}`}
                              value={rm(b.absence.unpaidLeave.amount)}
                            />
                          )}
                          {b.absence.absent && (
                            <Row
                              label={`${tSlip('absentLine')} · ${absenceDaysLabel(b.absence.absent.days, tSlip('dayUnit'), tSlip('daysUnit'))}`}
                              value={rm(b.absence.absent.amount)}
                            />
                          )}
                          {b.absence.showResidual && (
                            <Row label={tSlip('otherDeductions')} value={rm(b.absence.residual)} />
                          )}
                          {/* 6b4ca488 — no minus prefix; see the note on the same line in
                              app/payroll/individual-payslip/page.tsx. `b.totalDeductions` is a positive
                              magnitude, and this detail panel is the Transaction View half of the same
                              defect the ticket named. */}
                          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
                            <span>{tSlip('totalDeductions')}</span>
                            <span className="tabular-nums">{rm(b.totalDeductions)}</span>
                          </div>
                        </section>

                        {/* ── Employer-borne statutory contributions (3c473773 issue 2) ──
                            The named disclosure. Without it the deductions above simply do not add up on
                            screen: an EPF share of 629.00 shows as 0.00 and nothing says where it went.
                            Rendered only when this payslip's own blob records employer-borne funding, so a
                            payslip issued before the setting existed is untouched. */}
                        {b.employerBorne.any && (
                          <section>
                            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              {tSlip('employerBorneHeading')}
                            </h3>
                            {b.employerBorne.keys.map((k) => (
                              <Row key={k} label={tSlip(EMPLOYER_BORNE_LABEL[k])} value={rm(b.employerBorne.borne[k])} />
                            ))}
                            <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
                              <span>{tSlip('employerBorneTotal')}</span>
                              <span className="tabular-nums">{rm(b.employerBorne.total)}</span>
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">{tSlip('employerBorneNote')}</p>
                          </section>
                        )}

                        {/* ── Employer Contributions ── */}
                        <section>
                          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {tSlip('employerContributionsHeading')}
                          </h3>
                          <Row label={tSlip('epf')} value={rm(b.employerContributions.epf)} muted />
                          <Row label={tSlip('socso')} value={rm(b.employerContributions.socso)} muted />
                          <Row label={tSlip('eis')} value={rm(b.employerContributions.eis)} muted />
                          {/* HRDF (feedback efece4ce). The row was previously hidden whenever the amount
                              was 0, which made an UNREGISTERED company indistinguishable from a levy that
                              failed to compute — the reporter's "HRDF not calculated" is exactly that
                              ambiguity. The line is always present now: an amount where the company is
                              registered, the reason in words where it is not. Unlike SKBBK/CP38 above, a
                              zero here is a policy statement, not an absent item. */}
                          <Row
                            label={tSlip('hrdf')}
                            value={
                              hrdfRegistered.has(r.companyId)
                                ? rm(b.employerContributions.hrdf)
                                : t('view.history.hrdfNotRegistered')
                            }
                            muted
                          />
                          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
                            <span>{t('view.history.totalEmployerContributions')}</span>
                            <span className="tabular-nums">{rm(b.employerContributions.total)}</span>
                          </div>
                          {/* r367 — THE SENTENCE THAT NOW CARRIES WHAT THE HEADING'S BRACKET USED TO.
                              The heading above read "Employer contributions (not deducted from you)". The
                              bracket was load-bearing here for the same reason it was on the two payslip
                              screens: the row labels in this section and in Deductions above are THE SAME
                              KEYS — `me.payslip.epf`, `socso`, `eis` render in both — so the heading was the
                              only thing in this breakdown separating employee money from employer money.
                              The printed document has carried this sentence under the same box all along
                              (lib/payslip-pdf.ts `empSpec.note`) and no screen resolved the key until now.
                              Already translated in all six catalogues; nothing is added. */}
                          <p className="mt-2 text-xs text-muted-foreground">{tIp('employerContributionsNote')}</p>
                        </section>

                        {/* ── Itemised payroll items ──
                            862ed0ad. This section used to borrow the employee payslip's
                            `me.payslip.recordLinesHeading` — "Recorded items (no cash impact)" — and its
                            note, "these do not affect your gross or net pay". That was true when ADR-0025
                            introduced record lines for non-payable BIKs, and it stopped being true at
                            f1564110 Phase 3, which merges NAMED provenance for every consumed one-off
                            transaction into the same array (deductions carrying a negative sign). So the
                            list can hold both populations and the old heading asserted something false
                            about half of it — on the screen whose entire purpose is verification.

                            The heading and note are now this screen's own and are accurate for a mixed
                            list. The employee-facing payslip still carries the old wording and is NOT
                            touched here: same defect, different screen, and it is reported rather than
                            fixed in passing.

                            The AMOUNTS are rendered exactly as stored — no re-derivation — so a line can
                            never disagree with the figure above it.

                            417d4937 — the NAME is the one thing that is repaired at read time. Until r196
                            the kernel named a consumed one-off's record line from the transaction's
                            free-text remark, and that fix only takes effect when a run is CALCULATED, so
                            every payroll already run kept the old wording ("A0020 - DIRECTOR FEE" against
                            pay item A0040). `recordLineIdentity` shows the catalogue's description against
                            the stored code and keeps the words that were typed beside it as the remark —
                            nothing is rewritten and nothing is hidden. The amount and the code never move.
                            A code the catalogue does not hold (every TXN_* synthetic line) is unchanged. */}
                        {b.recordLines.length > 0 && (
                          <section className="sm:col-span-2">
                            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              {t('view.history.itemsHeading')}
                            </h3>
                            {b.recordLines.map((l, i) => {
                              const id = recordLineIdentity(l, payItemNames);
                              return (
                                <div
                                  key={`${l.code}-${i}`}
                                  className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0"
                                >
                                  <span className="text-muted-foreground">
                                    {id.label}
                                    {id.remark && (
                                      <span className="ms-2 text-xs italic">
                                        {t('view.history.itemRemark', { remark: id.remark })}
                                      </span>
                                    )}
                                  </span>
                                  <span className="tabular-nums text-muted-foreground">{rm(l.amount)}</span>
                                </div>
                              );
                            })}
                            <p className="mt-2 text-xs text-muted-foreground">{t('view.history.itemsNote')}</p>
                          </section>
                        )}

                        {/* ── Where the recorded items came from (417d4937 request 10) ──
                            A SECOND population beside Recorded items, never a join onto it. Renders
                            nothing when the run has no one-off ledger rows. */}
                        <SourceTxnBlock rows={sourceTxnsByPayslip?.[`${r.batchId}:${r.employmentId}`] ?? []} />

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
      <ClientPager state={state} />
    </div>
  );
}
