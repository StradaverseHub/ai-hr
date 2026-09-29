/**
 * Feedback 6b4ca488 part 2 — Excel export of the Statutory Explanation.
 *
 * IT RE-RUNS THE SCREEN'S OWN READ AND THE SCREEN'S OWN DERIVATION. Same `payslipForReview`, same
 * `explainStatutory`, same payslip id — so the file cannot say anything the screen it was taken from
 * does not. A route that assembled the six items independently would be free to drift from the
 * explanation it claims to reproduce, which on a statutory reconciliation is the one failure that
 * matters. The existing grid-export route next door is written the same way and for the same reason;
 * this reuses its serializer (`toXlsxReport`) and its Content-Disposition helper rather than adding a
 * second exporter.
 *
 * Read-only, and therefore NO DomainEvent — downloading a report mutates nothing (the posture the grid
 * and balances exports already take).
 *
 * Scope: `scopedAdmin()` exactly like the page, and the payslip id is re-guarded HERE rather than
 * trusted. `payslipForReview` fails CLOSED on an empty scope and returns null for a payslip outside the
 * caller's companies, so a hand-edited download link can never cross the company fence.
 *
 * AN UNRECORDED WAGE BASE EXPORTS AS AN EMPTY CELL, NEVER 0.00. A spreadsheet is where a wrong zero does
 * the most damage: it sums, it charts, and nothing on the sheet says it was a guess. Same rule the grid
 * export already applies to its unrecorded months.
 *
 * 208beb8b — A HAND-SET FIGURE IS DISCLOSED HERE OR IT IS NOT DISCLOSED AT ALL. This is the copy that
 * leaves the product: an explanation that tells the truth on screen and credits the KWSP Third Schedule in
 * the file somebody emails to an auditor is not a fix, it is the same defect with a longer fuse. So the
 * file carries all four parts the screen shows — the 'Set by hand' rule name (through the SAME
 * `RULE_LABEL` map, which tsc keeps exhaustive in both files), the reason, the banner's heading, and two
 * extra columns holding the figure the system had calculated.
 *
 * THOSE TWO COLUMNS APPEAR ONLY WHEN SOMETHING WAS SET BY HAND, and the reason is the same one that keeps
 * an unrecorded base empty: a column of blanks on every ordinary payslip is noise that teaches a reader to
 * skip the one file where it is filled in. Columns and rows are built from the one flag so they cannot go
 * ragged.
 *
 * It reads `explanation.setByHand` and `item.provenance` — `statutoryProvenance`'s answer — and never
 * `statutory.adjustment` itself. Item 70b14723 extends that function; this route follows with no change.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { payslipForReview } from '@/core/payroll-view';
import {
  explainStatutory,
  type StatutoryExplainKey,
  type StatutoryItemExplanation,
  type StatutoryRuleKind,
} from '@/core/statutory-explain';
import { toXlsxReport, type ReportData } from '@/lib/report-export';
import { employeeLabel } from '@/lib/employee-code';

/** STATIC keys, exhaustively mapped — the same map the view uses, for the same reason: a computed `t()`
 *  key is invisible to the i18n coverage scan. */
const ITEM_LABEL: Record<StatutoryExplainKey, string> = {
  epf: 'itemEpf',
  socso: 'itemSocso',
  skbbk: 'itemSkbbk',
  eis: 'itemEis',
  hrdf: 'itemHrdf',
  pcb: 'itemPcb',
};
/** ⚠️ EXHAUSTIVE BY TYPE, and that is load-bearing: adding a `StatutoryRuleKind` breaks tsc HERE as well
 *  as in the view, which is what forces the downloaded copy to be updated in the same pass as the screen.
 *  Never widen it to `Partial<…>` or `Record<string, string>` to make the error go away. */
const RULE_LABEL: Record<StatutoryRuleKind, string> = {
  rate: 'ruleRate',
  schedule: 'ruleSchedule',
  mtd: 'ruleMtd',
  manual: 'ruleManual',
};
/** EPF and PERKESO are BOTH schedule items but they are not the same schedule — EPF is banded by the
 *  KWSP Third Schedule, SOCSO/EIS/SKBBK by PERKESO's. The view carries the identical override, and the
 *  file must name the rule the way the screen it was taken from does or the two disagree on paper. */
const ruleLabelKey = (i: StatutoryItemExplanation) =>
  i.key === 'epf' && i.ruleKind === 'schedule' ? 'ruleScheduleEpf' : RULE_LABEL[i.ruleKind];
const CYCLE_LABEL: Record<string, string> = {
  regular: 'cycleRegular',
  off_cycle: 'cycleOffCycle',
  bonus: 'cycleBonus',
  adjustment: 'cycleAdjustment',
};

/** RFC 5987 Content-Disposition: an ASCII-safe fallback plus a UTF-8 `filename*`. Identical to the one
 *  the grid export carries — kept identical on purpose rather than shared, because the two routes have
 *  no other reason to import from each other. The filename interpolates an operator-controlled employee
 *  code, and a raw quote or a non-Latin-1 character there makes the Response constructor THROW. */
function contentDisposition(base: string, ext: string): string {
  const full = `${base}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request) {
  const { s, scopeIds } = await scopedAdmin();
  const raw = new URL(req.url).searchParams.get('payslipId');
  // Shape-checked before the query for the same reason the page does it: an unparseable uuid reaches
  // Postgres as a syntax error and 500s a download that should simply be empty.
  const payslipId = raw && UUID_RE.test(raw) ? raw : undefined;
  const row = payslipId ? await payslipForReview(s, { companyIds: scopeIds, payslipId }) : null;

  const t = await getTranslations('payroll.statutoryDetail');
  const locale = await getLocale();

  // No payslip (absent, mangled, or outside the caller's companies) ⇒ a header-only workbook, exactly
  // what the screen shows in that state. `toXlsxReport` produces a valid, openable file from it, and it
  // leaks nothing about whether the id existed.
  const explanation = row ? explainStatutory(row.statutory, row.runType) : null;
  const money = (v: number) => v.toFixed(2);
  // ONE flag decides the two extra columns AND the two extra cells per row, so the sheet cannot go ragged.
  const setByHand = explanation?.setByHand ?? null;

  const data: ReportData = {
    filename: `statutory-explanation-${row?.employeeCode ?? 'employee'}-${row?.payPeriod ?? ''}`.replace(/-$/, ''),
    title: t('title'),
    columns: [
      t('colItem'),
      t('colRule'),
      t('colBase'),
      t('colEmployee'),
      t('colEmployerBorne'),
      t('colTakeHome'),
      t('colEmployer'),
      // The system's own figures, headed with the SAME captions the screen puts on its two extra rows —
      // a file that renames what the screen showed is a file that has to be reconciled against it.
      ...(setByHand ? [t('fieldSystemEmployeeShare'), t('fieldSystemEmployerShare')] : []),
    ],
    rows: (explanation?.items ?? []).map((i) => [
      t(ITEM_LABEL[i.key]),
      t(ruleLabelKey(i)),
      // EMPTY, never 0.00, for a wage base this run did not record. See the header.
      i.totalBase == null ? '' : money(i.totalBase),
      money(i.employeeReported),
      money(i.employerBorne),
      money(i.employeeTakeHome),
      money(i.employer),
      // EMPTY for a leg nobody typed — including on an item whose other leg was. In this pair a 0.00 would
      // assert "the rule produced nothing", which is the wrong-zero failure the header forbids, aimed at
      // the one figure a reader is checking the typed amount against.
      ...(setByHand
        ? [
            i.provenance.employee ? money(i.provenance.employee.system) : '',
            i.provenance.employer ? money(i.provenance.employer.system) : '',
          ]
        : []),
    ]),
    layout: {
      orientation: 'landscape',
      freeze: 1,
      // Whose explanation this is, printed ON the file. A statutory workbook that does not name its
      // employee, company and payroll month cannot be filed against a submission.
      subtitle: row
        ? `${employeeLabel(row.employeeCode, row.employeeName)} · ${row.company} · ${monthYear(row.payPeriod, locale)}`
        : t('noSelection'),
      description: row
        ? [
            `${t('fieldCycle')}: ${t(CYCLE_LABEL[row.runType] ?? 'cycleRegular')}${row.runSeq > 1 ? ` #${row.runSeq}` : ''}`,
            `${t('fieldRuleset')}: ${explanation?.rulesetVersion ?? t('notRecordedShort')}`,
            // The caveats travel WITH the file. A reader who opens this workbook a month later has no
            // screen beside it, so an unrecorded working or a whole-month base has to be stated here or
            // it is not stated at all.
            ...(explanation?.basesNotRecorded ? [t('basesNotRecordedHeading')] : []),
            ...(explanation?.basesCoverWholeMonth ? [t('wholeMonthNote')] : []),
            // 208beb8b — the hand-set disclosure travels WITH the file, heading and reason together. A
            // reader who opens this workbook has no banner beside it, so this is the only place it is said.
            ...(setByHand
              ? [
                  t('manualBannerHeading'),
                  // COMMA inside, because the description's own separator is ' · ': a nested ' · ' list
                  // would leave "EPF (KWSP) · HRD Corp levy" indistinguishable from two caveats. The
                  // screen keeps ' · ' — it has a row of its own and nothing to be confused with.
                  `${t('manualBannerItems')}: ${setByHand.keys.map((k) => t(ITEM_LABEL[k])).join(', ')}`,
                  `${t('manualReason')}: ${setByHand.reason || t('notRecordedShort')}`,
                ]
              : []),
          ].join('  ·  ')
        : undefined,
    },
  };

  const file = toXlsxReport(data);
  return new Response(Buffer.from(file.bytes), {
    headers: {
      'Content-Type': file.contentType,
      'Content-Disposition': contentDisposition(data.filename, file.ext),
    },
  });
}

/** The stored `YYYY-MM` as a month name in the reader's own language — the same `Intl` idiom the screen
 *  uses, so the file and the screen name one payroll month identically. */
function monthYear(payPeriod: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(payPeriod ?? '');
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return payPeriod ?? '';
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)),
  );
}
