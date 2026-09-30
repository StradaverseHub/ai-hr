'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Field, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { RunPicker } from './run-picker';
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
 * `'month-cycle'` format asks WHICH RUN of the month as well, exactly one and required, because a file
 * that PAYS PEOPLE has to say which of them it pays; a `'month-runs'` format (r372, item f022dd70) asks
 * WHICH RUNS, any number of them, ALL TICKED BY DEFAULT, because a statutory return is one filing per
 * month and the whole month is what an employer files unless they say otherwise.
 *
 * ⚠️ THE TWO CYCLE KINDS FAIL SAFE IN OPPOSITE DIRECTIONS AND ARE NOT ONE CONTROL WITH A FLAG.
 *
 * `'month-cycle'` — nothing declares it today; the only file that would is a bank salary payment file and
 * the salary shelf is deliberately empty. `cycles` therefore has no generic source and is supplied by
 * whoever adds that format. AND IF THEY FORGET, THIS DIALOG REFUSES RATHER THAN DEFAULTS: a `<select>`
 * with no options submits NO value at all, so the format would have produced a WHOLE-MONTH payment — every
 * run of the month added together — from a button the operator pressed believing they had picked one run.
 * For a file that moves money that is the worst available failure: plausible, silent, and wrong by a bonus
 * run. So an empty list renders the reason instead of an empty control and Download is disabled. Left
 * exactly as it was; r372 did not touch this branch.
 *
 * `'month-runs'` — an empty list must NOT disable Download, and that is the deliberate difference. Sending
 * no run parameter is the ordinary whole-month file this shelf has always produced, and the builder's own
 * 422 is a better refusal than a greyed-out button because it says what to do about it. The list is
 * FETCHED by `./run-picker` rather than passed in: enumerating a month's runs is a database read, this
 * page deliberately reads nothing but the company list (`test/payment-submission-screen-seam.test.ts`
 * renders it with no database at all), and the company, year and month are chosen inside this pop-up
 * anyway — a server-rendered list would be the wrong month the moment a dropdown changed.
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
  runsEndpoint,
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
  /**
   * r372 — the eligible-runs route, read only by a `'month-runs'` format. A STRING handed down from the
   * server component so there is one spelling of the path, exactly like `action` above; this component
   * still names no route, no format id and no agency of its own.
   */
  runsEndpoint?: string;
}) {
  const t = useTranslations('payroll.paymentSubmission');
  const [open, setOpen] = useState(false);
  // A format that needs a cycle and was given none cannot be downloaded — see the header. Not a validation
  // message on submit: there is nothing the operator can do here, so the control that would silently
  // produce the wrong file is not rendered and the submit is not offered.
  const cycleMissing = periodKind === 'month-cycle' && cycles.length === 0;
  // Year and month are held in state rather than submitted as two fields, because the route takes ONE
  // `periodKey` and a plain GET form cannot join them. The hidden input below is the join, so the screen
  // and the route keep the single spelling of a period they already had.
  const [year, setYear] = useState(defaultYear);
  const [month, setMonth] = useState(defaultMonth);
  // r372 — CONTROLLED, where it used to be `defaultValue`. The run list is a read of ONE company's month,
  // so the picker has to be told when the company changes; an uncontrolled select would leave it showing
  // the first company's runs under a second company's name.
  const [companyId, setCompanyId] = useState(defaultCompanyId);

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
              <select
                name="companyId"
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
                className={inputCls}
                data-field="company"
              >
                {companies.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('year')}>
              {/*
                NO `name`, BY DESIGN — year and month are joined into the one `periodKey` above, and a named
                select here would put a stray `year=`/`month=` on the download URL. `data-field` is the
                stable handle a test addresses them by: pinning `selects[1]` pins a POSITION, and inserting
                a field above them would then re-aim the assertion instead of failing it (CLAUDE.md §8).
              */}
              <select
                value={year}
                onChange={(e) => setYear(e.target.value)}
                className={inputCls}
                data-field="year"
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('month')}>
              <select
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                className={inputCls}
                data-field="month"
              >
                {months.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
            {periodKind === 'month-runs' && runsEndpoint && (
              // r372 (item f022dd70) — the multi-select. Mounted only because the FORMAT declared the
              // kind; a `'month'` format renders no such control at all, which is the assertion that
              // keeps this driven by the registry rather than by a branch on the shelf it sits on.
              //
              // ⚠️ `&& runsEndpoint` DEGRADES SILENTLY, AND THAT IS THE RIGHT DIRECTION HERE — the exact
              // opposite of the `'month-cycle'` branch below, which REFUSES when its list is missing. A
              // `'month-runs'` format mounted without the endpoint renders no control and submits no run
              // parameter, which is the whole month: the file this shelf has always produced, and the one
              // the operator pressing Download is asking for. Below, the same omission would pay a whole
              // month from a control that looked like it had picked one run. The asymmetry is the failure
              // mode, not the code.
              <Field label={t('payCycle')}>
                <RunPicker companyId={companyId} periodKey={`${year}-${month}`} endpoint={runsEndpoint} />
              </Field>
            )}
            {periodKind === 'month-cycle' && (
              // Present ONLY because the format said it needs one. A `'month'` format renders no such
              // control at all, which is the assertion that keeps this driven by the registry.
              <Field label={t('payCycle')}>
                {cycleMissing ? (
                  // The refusal, in words, where the control would have been. An empty select would have
                  // submitted no cycle and produced the whole month's file instead — see the header.
                  <p className="text-sm text-muted-foreground" data-cycle-missing={formatId}>
                    {t('payCycleMissing')}
                  </p>
                ) : (
                  <select name="cycle" required className={inputCls} data-cycle-field={formatId} data-field="cycle">
                    {cycles.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild>
                <button type="button" className={btnGhost}>
                  {t('cancel')}
                </button>
              </Dialog.Close>
              {/* Disabled rather than absent: the button an operator is looking for stays where it is, and
                  the reason it cannot be pressed is the sentence beside the missing field above. */}
              <button type="submit" className={btnPrimary} disabled={cycleMissing}>
                {t('download')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
