/**
 * M09 — THE EMPLOYEE'S OWN PAYSLIP AS A FILE: one renderer and one file name for every surface that hands it
 * over. The web route (app/(app)/me/payslip/[payslipId]/pdf/route.ts) and the mobile v2 route
 * (app/api/mobile/v2/payslips/[id]/pdf/route.ts) both call this with the document `myPayslipDocument` assembled,
 * so the phone's copy is byte-for-byte the web's copy of the same payslip. Each route keeps only its transport:
 * the session it resolves, its refusal shape and its response headers.
 *
 * A SEPARATE MODULE, NOT document.ts, on purpose: document.ts is the database half (own-and-released read, YTD,
 * logo) and is replaced wholesale in the web route's HTTP-boundary test; this half is pure given the document, so
 * the boundary test keeps exercising the real file name and the real renderer call through it.
 */
import { renderPayslipPdf } from '@/lib/payslip-pdf';
import type { myPayslipDocument } from './document';

export type MyPayslipDocument = NonNullable<Awaited<ReturnType<typeof myPayslipDocument>>>;

export async function myPayslipPdfFile(document: MyPayslipDocument): Promise<{ bytes: Uint8Array; fileName: string }> {
  const {p,data,strings}=document;
  const bytes = await renderPayslipPdf(data, strings.labels);

  // Disambiguate the filename so two cycles in one month don't collide (and silently overwrite on
  // download). A sole regular run keeps the legacy `payslip-<period>-<code>`; non-regular or repeated
  // runs append the run identity. Sanitizer below strips anything outside [A-Za-z0-9._-].
  const runTag =
    p.runType === 'regular' && p.runSeq <= 1
      ? ''
      : `-${p.runType}${p.runSeq > 1 ? `-${p.runSeq}` : ''}`;
  const fname = `payslip-${p.payPeriod}${runTag}-${p.employeeCode ?? 'employee'}`.replace(
    /[^a-zA-Z0-9._-]+/g,
    '-',
  );
  return { bytes, fileName: `${fname}.pdf` };
}
