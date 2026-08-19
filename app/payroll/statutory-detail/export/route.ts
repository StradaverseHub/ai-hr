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
 */
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { payslipForReview } from '@/core/payroll-view';
import { explainStatutory, type StatutoryExplainKey, type StatutoryRuleKind } from '@/core/statutory-explain';
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
const RULE_LABEL: Record<StatutoryRuleKind, string> = {
  rate: 'ruleRate',
  schedule: 'ruleSchedule',
  mtd: 'ruleMtd',
};
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
    ],
    rows: (explanation?.items ?? []).map((i) => [
      t(ITEM_LABEL[i.key]),
      t(RULE_LABEL[i.ruleKind]),
      // EMPTY, never 0.00, for a wage base this run did not record. See the header.
      i.totalBase == null ? '' : money(i.totalBase),
      money(i.employeeReported),
      money(i.employerBorne),
      money(i.employeeTakeHome),
      money(i.employer),
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
