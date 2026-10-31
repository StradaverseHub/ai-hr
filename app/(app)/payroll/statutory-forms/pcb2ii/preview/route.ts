/**
 * 72b100cd (r328) — THE SAME PCB 2(II), OPENED INSTEAD OF SAVED.
 *
 * WHAT THE REPORTER WAS MISSING. The flow was: pick the people, press Download, and a file arrives. There
 * was no way to LOOK at the statement before it left the system. This is that look — and it is the
 * download's own bytes served with `Content-Disposition: inline`, so the browser's PDF viewer opens it
 * and pages through the ticked employees one statement per page.
 *
 * ⚠️ IT IS NOT A SECOND RENDITION OF THE FORM, AND THAT IS THE WHOLE POINT. The obvious "preview" is an
 * HTML mock-up of the sheet on a screen; it is also two versions of one statutory form, drawn by two
 * pieces of code, and the day they disagree the operator has approved a document that is not the one they
 * sent. `lib/pcb2ii-pdf.ts` refuses a second renderer in as many words. So the preview renders through
 * `renderPcb2iiPdf` — the download's renderer, not a cousin of it — and the operator is looking at the
 * file itself.
 *
 * ⚠️ AND IT IS NOT A LIGHTER SURFACE. A preview carries the same names, tax numbers, identity card numbers
 * and twelve months of tax deductions the download carries, so it is gated identically: `scopedAdmin`, the
 * id/shape allowlist, the selection ceiling, the company-scope check and the lang allowlist, with the same
 * bare 404 for a malformed id, a foreign company, an out-of-scope company or an employment with no
 * statement. That is enforced by CONSTRUCTION rather than by care: both routes are one call into
 * `../shared.ts`, and there is no second copy of the gate that could be relaxed here.
 *
 * NO DOMAIN EVENT, and nothing is recorded: looking at a statement is a read.
 */
import { pcb2iiPdfResponse } from '../shared';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

export async function GET(req: Request) {
  return pcb2iiPdfResponse(req, 'inline');
}
