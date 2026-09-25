/**
 * ad7bc503 — the PCB / MTD Calculation Detail for ONE payslip, as a PDF.
 *
 * The reporter's section 11: "The downloaded document must contain the same calculation details displayed
 * on screen, including all 10 sections and their underlying details." It does, because it is built from
 * the SAME model the screen is — see `../shared.ts`, which holds the gate, the reads, the shaping and the
 * layout, and is where anything about this surface gets changed.
 *
 * ⚠️ THE BODY OF THIS ROUTE IS `../shared.ts`, ON PURPOSE, exactly as on
 * app/payroll/statutory-forms/pcb2ii/download/route.ts. If a preview is ever asked for it differs from
 * this file by ONE header value — `inline` instead of `attachment` — and a preview carrying its own copy
 * of `scopedAdmin`, the id shape test, the scope check and the lang allowlist is a second, weaker door
 * onto the same identity-card number and the same tax figures.
 *
 * NO DOMAIN EVENT: rendering a statement of how a deduction was calculated is a read, and this download
 * is explicitly not a filing.
 */
import { pcbDetailPdfResponse } from '../shared';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

export async function GET(req: Request) {
  return pcbDetailPdfResponse(req, 'attachment');
}
