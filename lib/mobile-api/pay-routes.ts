import 'server-only';
/**
 * M09 — the route halves of the mobile payslip and EA endpoints (app/api/mobile/v2/payslips/**, …/ea/pdf). Server
 * only: the document owners they wrap (app/(app)/me/payslip/document.ts, app/(app)/me/ea/document.ts) are.
 *
 * THE SAME DOCUMENT AS THE WEB, NOT A SECOND ONE. The detail is `myPayslipDocument` (own and released, YTD from
 * the employee's own released slips) drawn through `payslipPresentationRows` with the web statement's own rate
 * formatter (app/(app)/me/payslip/statement.tsx); the PDFs are `myPayslipPdfFile` and `myEaPdfFile`, which the web routes
 * call too. The only thing this file adds is transport: amounts become two-place decimal strings (the precision the
 * web statement prints, sign kept, no grouping), and every refusal is one `not_found`.
 *
 * LANGUAGE (a known limit, not a choice made here): the payslip's document strings resolve through next-intl's
 * request locale (lib/payslip-pdf-strings.ts calls getTranslations with none), which for a bearer request with no
 * locale cookie is the default, English — the same document a web user without a language cookie downloads. The EA
 * form takes its edition explicitly (`lang`), as on the web.
 */
import type { SessionContext } from '@/db/client';
import { payrollEnabled } from '@/core/mobile-pay';
import { myPayslipDocument } from '@/app/(app)/me/payslip/document';
import { myPayslipPdfFile } from '@/app/(app)/me/payslip/pdf-file';
import { myEaPdfFile } from '@/app/(app)/me/ea/document';
import { payslipPresentationRows } from '@/lib/payslip-pdf';
import { formatRate } from '@/lib/money';
import { MobileBadRequest, type MobileBinary } from './handler';
import { mobileLocale } from './request';
import { EaLangV2, type DocumentRefusal, type EaDocumentRefusal, type PayslipDetailResult, type PayslipRowV2 } from './v2/pay';
import { moneyText } from './money-text';

/** M11 moved the formatter to ./money-text (a core composition needs it); re-exported here unchanged. */
export { moneyText };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = { outcome: 'refused', code: 'not_found' } as const;

/** The `{id}` segment after `/payslips/`: a UUID or a 400 (the app never asks for anything else). */
export function payslipIdOf(req: Request): string {
  const parts = new URL(req.url).pathname.split('/');
  const at = parts.indexOf('payslips');
  const id = at < 0 ? '' : parts[at + 1] ?? '';
  if (!UUID.test(id)) throw new MobileBadRequest('Invalid payslip id');
  return id.toLowerCase();
}

/** A total the document always carries; a missing one is a contract fault (a logged 500), never a printed zero. */
function totalText(n: unknown): string {
  const text = moneyText(n);
  if (text === null) throw new Error('Payslip total is not a recorded amount');
  return text;
}

/** GET v2/payslips/{id} — the caller's own released payslip, as the web statement shows it. */
export async function payslipDetailV2(s: SessionContext, id: string): Promise<PayslipDetailResult> {
  if (!payrollEnabled(s)) return NOT_FOUND;
  const document = await myPayslipDocument(s, id);
  if (!document) return NOT_FOUND;
  const { p, data, strings } = document;
  const labels = strings.labels;
  const rows = payslipPresentationRows(data, labels, (value) => formatRate(value, data.currency));
  const row = (item: (typeof rows.earnings)[number]): PayslipRowV2 => {
    const amount = item.amount == null ? null : moneyText(item.amount);
    return {
      label: item.label, quantity: item.quantity ?? null, sub: item.sub ?? null, amount,
      text: amount !== null ? null : item.amount == null ? item.text ?? '—' : '—',
    };
  };
  return {
    outcome: 'found',
    payslip: {
      id: p.id, employmentId: p.employmentId, employeeCode: data.employeeCode, employee: data.employee, company: data.company,
      period: p.payPeriod, periodLabel: labels.periodLabel, cycleLabel: strings.cycleLabel, currency: data.currency ?? null,
      sections: [
        { title: labels.earnings, rows: rows.earnings.map(row), total: { label: labels.totalEarnings, amount: totalText(data.gross) } },
        { title: labels.deductions, rows: rows.deductions.map(row), total: { label: labels.totalDeductions, amount: totalText(data.totalDeductions) } },
      ],
      net: { label: labels.netPay, amount: totalText(data.net) },
    },
  };
}

/** GET v2/payslips/{id}/pdf — the web route's own file (myPayslipPdfFile), bytes and name. */
export async function payslipPdfV2(s: SessionContext, id: string): Promise<MobileBinary | DocumentRefusal> {
  if (!payrollEnabled(s)) return NOT_FOUND;
  const document = await myPayslipDocument(s, id);
  if (!document) return NOT_FOUND;
  const { bytes, fileName } = await myPayslipPdfFile(document);
  return { outcome: 'file', contentType: 'application/pdf', fileName, bytes };
}

/**
 * GET v2/ea/pdf?employmentId&year&company&lang — the web route's own form (myEaPdfFile). The phone always names the
 * employer, the year and the employment it listed (v2/ea); `lang` is the edition, else the app's language.
 */
export async function eaPdfV2(s: SessionContext, req: Request): Promise<MobileBinary | EaDocumentRefusal> {
  const q = new URL(req.url).searchParams;
  const one = (k: string) => { const all = q.getAll(k); if (all.length > 1) throw new MobileBadRequest(`Repeated ${k}`); return all[0] ?? null; };
  const employmentId = one('employmentId'), year = one('year'), companyId = one('company'), rawLang = one('lang');
  if (!employmentId || !UUID.test(employmentId) || !year || !/^\d{4}$/.test(year) || !companyId || !UUID.test(companyId)) throw new MobileBadRequest('Invalid EA reference');
  const lang = rawLang === null ? null : EaLangV2.safeParse(rawLang).data ?? null;
  if (rawLang !== null && !lang) throw new MobileBadRequest('Unsupported EA edition');
  if (!payrollEnabled(s)) return NOT_FOUND;
  const file = await myEaPdfFile(s, { employmentId: employmentId.toLowerCase(), year, companyId: companyId.toLowerCase() }, {
    lang, fallback: async () => (mobileLocale(req) === 'ms' ? 'ms' : 'en'),
  });
  if (file.outcome === 'not_found') return NOT_FOUND;
  if (file.outcome === 'layout') return { outcome: 'refused', code: 'layout_unavailable' };
  return { outcome: 'file', contentType: 'application/pdf', fileName: file.fileName, bytes: file.bytes };
}
