import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { pcbPaymentsForYear, type PcbPaymentKind } from '@/core/pcb-payment';
import { Card, Field, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { todayInKualaLumpur, yearOptions } from '@/lib/hr-date';
// THE WRITER IS SHARED, NOT FORKED. `recordPcbPaymentAction` sits at the payroll root precisely so this
// screen and the CP39 review screen post to the SAME action — see its header. An action of this screen's
// own would be a second writer of a money-adjacent record, which is how two screens come to disagree
// about what an employer paid a tax authority.
import { recordPcbPaymentAction } from '../../../pcb-payment-actions';

/**
 * 72b100cd (r331) — RECEIPT / TRANSACTION DETAILS: a whole year of PCB payments on one screen.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. It is a SECOND DOOR onto `pcb_payment`, the record r321 already
 * shipped — not a new subsystem, not a new table and emphatically not a second writer. Everything it
 * shows comes from one call to `pcbPaymentsForYear`, which has read a year at a time since the day it
 * was written; everything it saves goes through `recordPcbPaymentAction`, which the CP39 review screen
 * has posted to since r321 and still does.
 *
 * WHY IT EXISTS. Until now the only place to key a receipt number was the bottom of the CP39 screen for
 * ONE month. So an operator maintaining a fact that PCB 2(II) prints had to know to go to CP39, and had
 * to open it twelve times to see a year. That is how a box stays empty for eleven months and is found at
 * filing time. The reporter asked for the year at a glance, and the read for it already existed.
 *
 * ⚠️ THE CP39 BOXES STAY. They are a path somebody uses today and this screen does not replace them —
 * both write the same row through the same action, so whichever is used, the other shows it.
 *
 * ⚠️ NOTHING IS DERIVED, AND AN ABSENT RECEIPT IS NOT AN EMPTY ONE. A receipt number cannot be computed;
 * every value on this screen was typed by a human. A month with no row is labelled NOT RECORDED in words
 * rather than shown as a blank box, because a blank box on a maintenance screen is ambiguous between
 * "nobody has keyed this" and "somebody keyed an empty value" — and on the form it feeds, an absent box
 * asserts nothing while a zero asserts the money does not exist (CLAUDE.md §8).
 *
 * TWENTY-FOUR SLOTS, DERIVED FROM THE YEAR RATHER THAN FROM THE QUERY. The twelve months come from
 * `MONTHS` and the two streams from `KINDS`, and each slot LOOKS ITSELF UP in the map. So the screen
 * shows January through December in order whatever the database returns, and a month with no row cannot
 * go missing from the list — it renders as the empty slot it is. (`pcbPaymentsForYear` is ordered too,
 * as of r331; this screen simply does not depend on it.)
 *
 * GATED LIKE THE REST OF THE STATUTORY SHELF. `scopedAdmin`, not `isAdmin`: an hr_admin grant on ANY
 * company makes `isAdmin` true, and a receipt names one company's payment to LHDN. A companyId in the
 * URL that this admin may not administer is a BARE 404 — not an empty screen, which would invite a retry,
 * and not a silent fallback to another company, which would answer a question that was not asked.
 *
 * NO CLIENT ISLAND. Every control here is a plain element in a server component: the filter is a GET
 * form, each slot is a POST form whose `action` is the shared server action. Nothing is handed across a
 * server→client boundary, which is the class of bug that passes tsc, the suite and `next build` and then
 * 500s on the real page.
 */
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;
const KINDS: readonly PcbPaymentKind[] = ['mtd', 'cp38'];

type Search = { companyId?: string; year?: string; lang?: string };

export default async function Pcb2iiReceiptsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.statutoryForms');
  // The field labels are the CP39 screen's OWN keys, reused verbatim: "Receipt / bank slip / transaction
  // no.", "Payment date", "MTD", "CP38" and "Save" are facts about the payment, true on both screens, so
  // a second wording of them here is two strings that drift. That makes this a MULTI-NAMESPACE file, which
  // i18n-coverage check C skips entirely — so test/72b100cd-pcb2ii-receipts.test.ts resolves every key
  // this page uses, in all six locales, which is stricter than the check it replaces.
  const tPay = await getTranslations('payroll.cp39Form');
  const locale = await getLocale();
  const sp = await searchParams;

  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt && scopeIds.includes(c.id));

  // ⚠️ ASKED-FOR AND FOREIGN is a 404; ABSENT is the first company this admin administers. The two are
  // different questions: an operator arriving from the shelf with no company named is being shown a
  // default, while a URL naming somebody else's company is being refused.
  const requested = typeof sp.companyId === 'string' ? sp.companyId : '';
  if (requested && !scopeIds.includes(requested)) notFound();
  const companyId = requested || companies[0]?.id || '';
  if (!companyId) notFound();

  // THE TENANT'S CLOCK. Between 00:00 and 08:00 MYT the UTC date is still yesterday's, and on 1 January
  // that is a whole year out — which on a screen keyed by year is the wrong year's receipts.
  const today = todayInKualaLumpur();
  const year = /^\d{4}$/.test(sp.year ?? '') ? sp.year! : today.slice(0, 4);
  const years = yearOptions(today, year);

  // ONE READ FOR THE WHOLE YEAR — the call this item turned out to already have. Keyed 'YYYY-MM|kind'.
  const payments = await pcbPaymentsForYear(s, { companyId, year: Number(year) });

  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const monthName = (mm: string) => monthFmt.format(new Date(Date.UTC(2000, Number(mm) - 1, 1)));
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';

  const slots = MONTHS.flatMap((mm) => KINDS.map((kind) => payments.get(`${year}-${mm}|${kind}`)));
  const recorded = slots.filter((r) => r !== undefined).length;

  // Back to the form this maintains, carrying what it needs to open. `lang` rides along when it was on
  // the way in, so returning lands on the same language's entry rather than the default one.
  const backHref = `/payroll/statutory-forms/pcb2ii?companyId=${encodeURIComponent(companyId)}&year=${encodeURIComponent(year)}${
    sp.lang === 'en' || sp.lang === 'ms' ? `&lang=${sp.lang}` : ''
  }`;

  return (
    <div className={pageWideCls}>
      <PageHeader
        back={{ href: backHref, label: t('pcb2iiReceiptsBack') }}
        title={t('pcb2iiReceiptsTitle')}
        description={t('pcb2iiReceiptsSubtitle', { company: companyName, year })}
      />

      {/* A PLAIN GET FORM. The company and year end up in the address bar, so a year of receipts is a URL
          that re-opens, bookmarks and can be sent to a colleague — and there is no client state to hand
          across a boundary. */}
      <Card className="overflow-hidden">
        <form method="get" className="flex flex-wrap items-end gap-3 px-4 py-4">
          <Field label={t('company')}>
            <select name="companyId" defaultValue={companyId} className={inputCls} required>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('year')}>
            <select name="year" defaultValue={year} className={inputCls} required>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </Field>
          <button className={btnPrimary}>{t('pcb2iiReceiptsShow')}</button>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader
          title={t('pcb2iiReceiptsCount', { recorded, total: slots.length })}
          subtitle={t('pcb2iiReceiptsHint')}
        />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('pcb2iiReceiptsCp39Note')}</p>

        <div className="space-y-3 px-4 py-4">
          {MONTHS.map((mm) => {
            const periodKey = `${year}-${mm}`;
            return (
              <div key={mm} className="rounded-xl border border-border">
                <div className="border-b border-border px-3 py-2 text-sm font-medium">
                  {monthName(mm)} {year}
                </div>
                <div className="grid gap-4 p-3 sm:grid-cols-2">
                  {KINDS.map((kind) => {
                    const rec = payments.get(`${periodKey}|${kind}`);
                    return (
                      /* ONE SLOT, ONE FORM, THE SHARED ACTION — and a sibling of every other form on the
                         page, never a child of one. A form inside a form is invalid HTML and browsers drop
                         the inner one, so a nested slot would accept typing and then submit the FILTER,
                         losing the receipt with no error. */
                      <form key={kind} action={recordPcbPaymentAction} className="space-y-2">
                        <input type="hidden" name="companyId" value={companyId} />
                        <input type="hidden" name="periodKey" value={periodKey} />
                        <input type="hidden" name="kind" value={kind} />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm font-medium">
                            {kind === 'mtd' ? tPay('pcbPaymentKindMtd') : tPay('pcbPaymentKindCp38')}
                          </span>
                          {/* ⚠️ THE ABSENCE IS STATED IN WORDS. An empty input alone cannot say whether
                              nobody has keyed this month or somebody keyed nothing into it, and those are
                              different answers to "is this year ready to file". */}
                          {rec ? (
                            <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
                              {t('pcb2iiReceiptsRecorded')}
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-dashed border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                              {t('pcb2iiReceiptsNotRecorded')}
                            </span>
                          )}
                        </div>
                        <Field label={tPay('pcbPaymentReceiptRef')}>
                          <input name="receiptRef" defaultValue={rec?.receiptRef ?? ''} className={inputCls} />
                        </Field>
                        <Field label={tPay('pcbPaymentPaidOn')}>
                          <input type="date" name="paidOn" defaultValue={rec?.paidOn ?? ''} className={inputCls} />
                        </Field>
                        <button className={btnGhost}>{tPay('pcbPaymentSave')}</button>
                      </form>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
