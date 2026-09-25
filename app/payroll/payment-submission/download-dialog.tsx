'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Field, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import type { SubmissionFormat } from './registry';

/**
 * e78fd03d — THE DOWNLOAD SELECTION POP-UP: you say which file you want, and THEN it asks what it covers.
 *
 * The screen used to carry one Year / Payroll month pair and a SHOW button above the shelves, so a
 * selection was made before anything had been chosen to apply it to. The reporter asked for the other
 * order, and the other order is the right one: the Download button on a row opens this dialog, the dialog
 * asks for company, year and payroll month, and pressing Download in it produces that one file.
 *
 * ── STILL A GET THAT WRITES NOTHING, AND THAT IS NOT AN ACCIDENT OF THIS FILE ─────────────────────
 * The dialog contains a plain `<form method="get">` pointed at the same download route the row's link
 * used to point at. No server action, no fetch, no POST: generating a statutory file records no artefact
 * and appends no domain event (see the registry header), and the shape of this control is what keeps that
 * cheap to believe. `test/payment-submission-module.test.ts` asserts the row and event counts either side.
 *
 * ⚠️ AND IT IS A FORM INSIDE A PORTAL, WHICH IS WHY THERE IS NO NESTING PROBLEM. The page used to warn
 * "TWO SIBLING FORMS, NEVER NESTED" because a form inside a form is invalid HTML and browsers drop the
 * inner one. `Dialog.Portal` appends the content to `document.body`, so every dialog's form is a top-level
 * form no matter where its trigger sits — and the page's own filter form is gone entirely.
 *
 * ── THE SELECTION IS DECLARED BY THE FORMAT, NOT BRANCHED ON ITS GROUP ───────────────────────────
 * `periodKind` comes off the registry entry. A `'month'` format asks for company + year + month; a
 * `'month-cycle'` format asks WHICH RUN of the month as well, because one payroll month can hold a regular
 * run, a bonus run and an advance with different payment dates. Nothing declares `'month-cycle'` today —
 * the only file that would is a bank salary payment file and the salary shelf is deliberately empty — so
 * the cycle field is unreachable in production and does not exist on any row now on the screen. It is here
 * so that adding such a format is adding a registry entry, which is the property the whole module keeps.
 *
 * `cycles` therefore has no generic source: enumerating a month's runs is a database read, and this screen
 * deliberately reads nothing but the company list (`test/payment-submission-screen-seam.test.ts` renders it
 * with no database at all). Whoever adds the salary file supplies them; until then the field renders with
 * nothing to choose, which is visible rather than silent.
 *
 * NO FORMAT ID AND NO AGENCY NAME IS WRITTEN HERE EITHER. Everything this component knows about the file
 * arrives as a prop.
 */

/** One `<option>`: the value that goes in the URL and the words the operator reads. */
export type SelectionOption = { value: string; label: string };

export function DownloadDialog({
  formatId,
  formatLabel,
  periodKind,
  action,
  companies,
  defaultCompanyId,
  years,
  defaultYear,
  months,
  defaultMonth,
  cycles = [],
}: {
  /** The registry id, submitted as the `format` parameter. Opaque to this component. */
  formatId: string;
  /** The row's already-translated name — the dialog's accessible title, so it says WHICH file. */
  formatLabel: string;
  /** What this file has to be told before it can be produced. See the header. */
  periodKind: SubmissionFormat['periodKind'];
  /** The download route. Passed in rather than written here, so there is one spelling of it. */
  action: string;
  companies: SelectionOption[];
  defaultCompanyId: string;
  years: string[];
  defaultYear: string;
  months: SelectionOption[];
  defaultMonth: string;
  /** Only read for a `'month-cycle'` format. See the header for why this is empty today. */
  cycles?: SelectionOption[];
}) {
  const t = useTranslations('payroll.paymentSubmission');
  const [open, setOpen] = useState(false);
  // Year and month are held in state rather than submitted as two fields, because the route takes ONE
  // `periodKey` and a plain GET form cannot join them. The hidden input below is the join, so the screen
  // and the route keep the single spelling of a period they already had.
  const [year, setYear] = useState(defaultYear);
  const [month, setMonth] = useState(defaultMonth);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className={btnPrimary}>
          {t('download')}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg">
          <Dialog.Title className="text-base font-semibold">{formatLabel}</Dialog.Title>
          <Dialog.Description className="mt-1.5 text-sm text-muted-foreground">
            {t('selectionIntro')}
          </Dialog.Description>
          <form method="get" action={action} className="mt-4 space-y-3">
            <input type="hidden" name="format" value={formatId} />
            <input type="hidden" name="periodKey" value={`${year}-${month}`} />
            <Field label={t('company')}>
              <select name="companyId" defaultValue={defaultCompanyId} className={inputCls}>
                {companies.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('year')}>
              <select value={year} onChange={(e) => setYear(e.target.value)} className={inputCls}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('month')}>
              <select value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls}>
                {months.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
            {periodKind === 'month-cycle' && (
              // Present ONLY because the format said it needs one. A `'month'` format renders no such
              // control at all, which is the assertion that keeps this driven by the registry.
              <Field label={t('payCycle')}>
                <select name="cycle" className={inputCls} data-cycle-field={formatId}>
                  {cycles.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild>
                <button type="button" className={btnGhost}>
                  {t('cancel')}
                </button>
              </Dialog.Close>
              <button type="submit" className={btnPrimary}>
                {t('download')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
