/**
 * Feedback 45df860a — PCB / MTD Calculation Detail.
 *
 * ONE SCREEN, TWO DOORS. Transaction View → Transaction Detail and the Individual Payslip both link the
 * PCB amount here with `?payslipId=`. That is the reporter's requirement stated as an architecture:
 * "This avoids having two different PCB calculation engines or two different calculation displays."
 *
 * THE SCOPE GUARD IS THE READ, NOT A COMPARISON. `payslipForReview` is fenced on the caller's authorised
 * `companyIds` and fails CLOSED on an empty scope, so a tampered `payslipId` naming somebody else's
 * payslip is indistinguishable from a payslip that does not exist — the same posture the Individual
 * Payslip screen's `?params` guard has. No second, weaker read exists for this screen: it reads the
 * admin review row exactly as the payslip screen does, and the ESS release gate (`payslipDetail`) is
 * neither used nor widened here.
 *
 * READ-ONLY END TO END. No row is inserted, updated, deleted or recomputed. The tax figures come off the
 * payslip's own `pcbMeta` stamp via `explainPcb` — this screen cannot compute PCB and must never learn
 * how, because a second calculation is exactly how a detail screen ends up contradicting the payslip.
 */
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { currentPcbReliefs, payslipForReview, previousEmploymentForPayslip } from '@/core/payroll-view';
import { explainPcb, pcbClosingSections, pcbSlipSections, pcbWorksheet } from '@/core/pcb-explain';
import { payslipProvenance } from '@/core/payslip-recompute';
import { Card, PageHeader } from '@/components/ui';
import { PcbDetailView } from './pcb-detail-view';
import { SLIP_ITEMS, SLIP_REBATES, pcbSlipData } from './slip-data';

/** The stored `YYYY-MM` as a month name in the reader's own language — the same `Intl` idiom the
 *  Individual Payslip uses, deliberately, so one payroll month is named identically on both screens. */
function monthYear(payPeriod: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(payPeriod ?? '');
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return payPeriod ?? '';
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)),
  );
}

export default async function PcbDetailPage({
  searchParams,
}: {
  searchParams: Promise<{ payslipId?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.pcbDetail');
  const locale = await getLocale();
  const sp = await searchParams;

  // SHAPE-CHECK BEFORE THE QUERY, the same guard the run screens under app/payroll/[batchId] carry. `payslip.id`
  // is a uuid column, so a mangled id out of a shared link — `?payslipId=abc`, a stray space, a truncated
  // copy-paste — reaches Postgres as `invalid input syntax for type uuid` and, with no try/catch here and no
  // app/error.tsx anywhere in the tree, becomes an HTTP 500 rather than the "not found" card this page's own
  // header promises. Treating an unparseable id as absent is both truthful and what the reader expects: there
  // is no such payslip.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const payslipId = typeof sp.payslipId === 'string' && UUID_RE.test(sp.payslipId) ? sp.payslipId : undefined;
  const row = payslipId ? await payslipForReview(s, { companyIds: scopeIds, payslipId }) : null;

  // The relief FALLBACK, consulted ONLY for a payslip calculated before the relief working was recorded
  // on the slip itself. `explainPcb` reports which of the two it used and the screen says so — a silent
  // fallback would explain a closed month with a relief position that did not exist when it ran.
  const fallbackReliefs = row
    ? await currentPcbReliefs(s, {
        companyIds: scopeIds,
        employmentId: row.employmentId,
        asOf: `${row.payPeriod}-28`,
      })
    : null;
  const explanation = row ? explainPcb(row.statutory, fallbackReliefs) : null;
  const prov = row ? payslipProvenance(row.statutory) : null;

  // Item 7f251381 — the Form TP3 figures behind LHDN's Y, K, X and Z, for their OWN labelled rows on the
  // worksheet. The tax YEAR is the payslip's pay period's, parsed the same way the view parses it for the
  // "Calculation source" block, because that is the year `core/payroll.ts` compares `tp3_year` against
  // (`tp3Applies = e.tp3Year === pYear`) when it seeds the accumulators. A pay period that does not parse
  // yields NaN, which matches no declared year — the rows then read 0.00 and "did not apply", which is the
  // truthful answer for a row whose own period is unreadable, not a guess at one.
  const previousEmployment = row
    ? await previousEmploymentForPayslip(s, {
        companyIds: scopeIds,
        employmentId: row.employmentId,
        taxYear: Number(/^\d{4}/.exec(row.payPeriod)?.[0] ?? Number.NaN),
      })
    : null;
  // The worksheet is assembled OUTSIDE the view, in core/, for the reason the whole screen exists: the
  // mapping from a stored figure to an LHDN symbol is the thing that can be wrong, and a mapping inside a
  // React component can only be tested by rendering it. It derives nothing; see core/pcb-explain.ts.
  const worksheet = explanation ? pcbWorksheet(explanation, previousEmployment) : null;

  // ad7bc503 — THE DETAIL BEHIND THE TOTALS (reporter sections 2, 4, 5, 6, 7 and 8).
  //
  // The reads live in `./slip-data.ts` and the SHAPING lives in `core/pcb-explain.ts`, for the reason the
  // worksheet already splits that way: the mapping from a stored box to a line of the agency's form is the
  // thing that can be wrong, and a mapping inside a React component can only be tested by rendering it.
  //
  // ONLY for the computerised-calculation shape. A flat-rate payee has no reliefs, no children relief and
  // no LP at all — not "unsaved ones" — so nothing is read for them and `pcbSlipSections` returns nothing.
  // A payslip whose run recorded no working still gets the schedules: the DECLARATIONS are real and
  // readable even when the month's trace is not, and the rows fed from the trace say so individually.
  //
  // ⚠️ A TRAP REMOVED ON THE WAY PAST, RECORDED SO IT IS NOT RE-INTRODUCED. The shape-check note above
  // used to end its citation with a trailing wildcard, and those two characters OPEN a block comment.
  // TypeScript does not care — they are inside a line comment — but test/pcb-detail.test.ts and
  // test/7f251381-pcb-lhdn-worksheet.test.ts comment-STRIP this file before matching the scope fence in
  // it, so the first block-comment close appearing anywhere below that line deleted every line in
  // between and the guard then failed claiming the fence was gone. Adding the ordinary doc comment this
  // block started life as was enough to trigger it. The citation no longer carries the wildcard, so a
  // block comment here is safe again; do not put one back into a line comment in this file.
  const slipData =
    row && explanation && explanation.kind === 'mtd'
      ? await pcbSlipData(s, {
          companyIds: scopeIds,
          employmentId: row.employmentId,
          taxYear: Number(/^\d{4}/.exec(row.payPeriod)?.[0] ?? Number.NaN),
          month: explanation.month,
        })
      : null;
  const slip =
    explanation && slipData
      ? pcbSlipSections(explanation, {
          profile: slipData.profile,
          catalogue: SLIP_ITEMS,
          rebateCatalogue: SLIP_REBATES,
          currentDeduction: slipData.currentDeduction,
          accumulatedDeduction: slipData.accumulatedDeduction,
          previousDeduction: slipData.previousDeduction,
          currentRebate: slipData.currentRebate,
          accumulatedRebate: slipData.accumulatedRebate,
          accumulatedRemuneration: slipData.accumulatedRemuneration,
        })
      : [];
  // r361 — the official's two numbered steps and its CALCULATION RESULTS band, assembled in core/ and
  // iterated by BOTH surfaces, so the screen and the downloaded document cannot carry a different set or
  // a different order. Empty for a flat-rate payee and for a run with no recorded working.
  const closing = explanation ? pcbClosingSections(explanation) : [];

  const backHref = row
    ? `/payroll/individual-payslip?${new URLSearchParams({
        employmentId: row.employmentId,
        payslipId: row.id,
      }).toString()}`
    : '/payroll/transaction-view';

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        back={{ href: backHref, label: row ? t('backToPayslip') : t('backToTransactionView') }}
      />

      {row && (
        // ad7bc503 section 11 — the whole page as a PDF. A PLAIN LINK and not a button with an action: the
        // document is a GET on ./download, which carries the identical gate to this page (see ./shared.ts),
        // so there is nothing to post and nothing to record. Rendering a statement is a read.
        // ⚠️ AND IT CARRIES THE READER'S OWN LOCALE. Without `lang` the allowlist in ./shared.ts saw null
        // every time, so the Malay branch was unreachable from the product: a Malay-UI admin got an English
        // document, and the two provenance lines — deliberately "the reader's own language AND in English" —
        // both resolved to English. The locale is HANDED ON, never trusted: shared.ts allowlists it down to
        // the two languages the agency itself issues and Helvetica can actually print, so a Tamil, Thai,
        // Vietnamese or Chinese UI still yields the English document rather than pages of '?'.
        <div className="flex justify-end">
          <a
            href={`/payroll/pcb-detail/download?${new URLSearchParams({ payslipId: row.id, lang: locale }).toString()}`}
            className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            {t('slipDownload')}
          </a>
        </div>
      )}

      {!row && (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">{payslipId ? t('notFound') : t('noSelection')}</p>
          <Link href="/payroll/transaction-view" className="mt-3 inline-block text-sm font-medium text-primary underline">
            {t('backToTransactionView')}
          </Link>
        </Card>
      )}

      {row && explanation && (
        <PcbDetailView
          ctx={{
            employeeCode: row.employeeCode,
            employeeName: row.employeeName,
            company: row.company,
            periodLabel: monthYear(row.payPeriod, locale),
            payPeriod: row.payPeriod,
            runType: row.runType,
            runSeq: row.runSeq,
            currency: row.currency ?? null,
            rulesetVersion: prov?.rulesetVersion ?? null,
            // ad7bc503 — the reporter's section 1, completed. All four already come off the SAME
            // `payslipForReview` row this screen has always read; no second read was needed for them.
            identityNumber: row.identityNumber,
            identityIsPassport: row.identityIsPassport,
            taxNumber: row.taxNumber,
            taxCategory: slipData?.profile?.taxCategory ?? null,
          }}
          explanation={explanation}
          worksheet={worksheet}
          slip={slip}
          closing={closing}
        />
      )}
    </div>
  );
}
