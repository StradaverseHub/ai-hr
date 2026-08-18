'use client';

import { useTranslations } from 'next-intl';
import type { PayslipSourceTxnRow } from '@/core/payroll-view';
import { payItemLabel } from '@/core/payslip-earning-lines';

/**
 * Feedback 417d4937 (the reporter's request 10) — WHERE EVERY RECORDED ITEM CAME FROM.
 *
 * THE QUESTION THE SCREEN COULD NOT ANSWER. A payslip printed "A0020 - DIRECTOR FEE RM400" and Recorded
 * items showed a code, a description and an amount — nothing about provenance. Establishing whether the
 * line belonged there took a report and a conversation. This block lists the one-off transactions actually
 * recorded against that employee on that run: the date, the pay item, the amount, whether it is an earning
 * or a deduction, how it was entered, and which run paid it.
 *
 * IT IS A SECOND POPULATION, NOT A JOIN. Deliberately: amounts and pay items can repeat inside one run
 * (two RM400 meal allowances on two dates) and nothing links a record line back to the ledger row that
 * produced it. A match invented from (code, amount) would be right most of the time and confidently wrong
 * the rest — worse, on the one screen whose entire purpose is verification, than showing both lists and
 * letting the reader do it. `listPayslipSourceTxns` says the same thing at the read.
 *
 * ONE COMPONENT, TWO SCREENS. Transaction View → History (client) and Payroll → Individual Payslip
 * (server) both print Recorded items and both needed this beneath it. A client component is usable from
 * either, which is what keeps the two from drifting the way the four record-line renderers already did.
 *
 * PRESENTATION ONLY. Every row arrives already scope-guarded by the server read; nothing here authorises,
 * derives or totals anything — there is deliberately NO sum, because these rows restate money that is
 * already counted in the figures above them.
 */

/** i18n key suffix per ledger kind. A computed `t()` key is invisible to the static i18n scan, so the map
 *  is exhaustive over the enum and every value is a key that exists in all six catalogues (pinned by
 *  test/pay-item-identity.test.ts). Same convention as EMPLOYER_BORNE_LABEL in history-table.tsx. */
const KIND_KEY: Record<string, string> = {
  earning: 'earning',
  deduction: 'deduction',
  overtime: 'overtime',
  unpaid: 'unpaid',
  leave: 'leave',
};

/** Likewise for provenance. NULL in the column already resolved to 'manual' by the read (`txnSourceOf`). */
const SOURCE_KEY: Record<string, string> = {
  manual: 'manual',
  attendance: 'attendance',
  leave: 'leave',
  import: 'import',
  system: 'system',
};

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function SourceTxnBlock({ rows }: { rows: PayslipSourceTxnRow[] }) {
  const t = useTranslations('payroll.transactions');
  if (rows.length === 0) return null;
  return (
    <section className="sm:col-span-2">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('view.history.sourceHeading')}
      </h3>
      <ul className="divide-y divide-border/60">
        {rows.map((r) => {
          // The pay item names the row when it has one; a kind-only row (overtime / unpaid / leave) has
          // none and is named by its kind rather than left blank.
          const kindLabel = t(`individual.kindLabel.${KIND_KEY[r.kind] ?? 'earning'}`);
          const item = payItemLabel({ code: r.componentCode, name: r.componentName }) || kindLabel;
          // 417d4937 — the marker the item is named after. `consumed_batch_id` is what stops a later run
          // paying the same money twice; it is stamped at CALCULATION time only, so a row that reached a
          // payslip before migration 0437 shipped still reads "not marked" until the backfill has run.
          const paid = r.consumedByThisRun
            ? t('view.history.sourcePaidByThisRun')
            : r.consumedBatchId != null
              ? t('view.history.sourcePaidByOtherRun')
              : t('view.history.sourceNotMarkedPaid');
          return (
            <li key={r.id} className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
              <span className="text-muted-foreground">
                <span className="tabular-nums">{r.txnDate}</span>
                <span className="ms-2">{item}</span>
                <span className="ms-2 text-xs">
                  {kindLabel} · {t(`individual.sourceValue.${SOURCE_KEY[r.source] ?? 'manual'}`)} · {paid}
                </span>
                {r.notes && <span className="ms-2 text-xs italic">{r.notes}</span>}
              </span>
              <span className="tabular-nums text-muted-foreground">{rm(r.amount)}</span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">{t('view.history.sourceNote')}</p>
    </section>
  );
}
