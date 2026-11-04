'use client';

import type { ReactNode } from 'react';
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
  // Group only the original ledger population. Identity includes run and employment so even a caller
  // rendering several slices cannot merge two employees' or cycles' identically named pay items.
  const groups = new Map<string, PayslipSourceTxnRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.batchId, row.employmentId, row.componentCode, row.kind]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const renderRows = (entries: PayslipSourceTxnRow[]) => (
      <ul className="divide-y divide-border/60">
        {entries.map((r) => {
          const kindLabel = t(`individual.kindLabel.${KIND_KEY[r.kind] ?? 'earning'}`);
          const item = payItemLabel({ code: r.componentCode, name: r.componentName }) || kindLabel;
          const paid = r.consumedByThisRun
            ? t('view.history.sourcePaidByThisRun')
            : r.consumedBatchId != null
              ? t('view.history.sourcePaidByOtherRun')
              : t('view.history.sourceNotMarkedPaid');
          const unit = ['amount','qty','hours','days','units'].includes(r.unit ?? '') ? r.unit! : null;
          return (
            <li key={r.id} className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
              <span className="text-muted-foreground">
                <span className="tabular-nums">{r.txnDate}</span>
                <span className="ms-2">{item}</span>
                <span className="ms-2 text-xs">
                  {kindLabel} · {t(`individual.sourceValue.${SOURCE_KEY[r.source] ?? 'manual'}`)} · {paid}
                </span>
                <span className="ms-2 text-xs">{t('individual.inputType')}: {unit ? t(`individual.unitLabel.${unit}`) : t('view.history.sourceInputNotRecorded')}{r.quantity != null && <> · {r.quantity}{unit ? ' '+t(`individual.unitLabel.${unit}`) : ''}</>}</span>
                {r.notes && <span className="ms-2 text-xs italic">{r.notes}</span>}
              </span>
              <span className="tabular-nums text-muted-foreground">{rm(r.amount)}</span>
            </li>
          );
        })}
      </ul>
  );
  return (
    <section className="sm:col-span-2">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('view.history.sourceHeading')}
      </h3>
      {[...groups].map(([key, entries]) => entries.length > 1 ? (
        <details id={`source-txn-${entries[0].id}`} key={key} className="mb-2 rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">{payItemLabel({code: entries[0].componentCode, name: entries[0].componentName}) || t(`individual.kindLabel.${KIND_KEY[entries[0].kind] ?? 'earning'}`)} · {t('view.history.sourceEntryCount', {count: entries.length})}</summary>
          {renderRows(entries)}
        </details>
      ) : <div key={key}>{renderRows(entries)}</div>)}
      <p className="mt-2 text-xs text-muted-foreground">{t('view.history.sourceNote')}</p>
    </section>
  );
}

/** Opens the existing per-code source population; this does not claim that a source input is a paid allocation. */
export function SourceTxnLink({code, rows, children}: {code:string;rows:PayslipSourceTxnRow[];children:ReactNode}) {
  const t=useTranslations('payroll.transactions');
  const sameCode=rows.filter(row=>row.componentCode===code);
  const first=sameCode.find(row=>sameCode.filter(other=>other.batchId===row.batchId && other.employmentId===row.employmentId && other.kind===row.kind).length>1);
  if(!first)return <>{children}</>;
  const id=`source-txn-${first.id}`;
  return <a href={`#${id}`} title={t('view.history.sourceHeading')} className="underline decoration-dotted underline-offset-4 hover:decoration-solid"
    onClick={event=>{const panel=document.getElementById(id);if(panel instanceof HTMLDetailsElement){event.preventDefault();panel.open=true;panel.querySelector('summary')?.focus();panel.scrollIntoView?.({block:'nearest'});}}}>{children}</a>;
}
