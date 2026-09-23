/**
 * 2a1a6f42 (r331) — THE SAME C.P.8A (EA), OPENED INSTEAD OF SAVED.
 *
 * WHAT THE REPORTER WAS MISSING, AND WHY IT WAS THE LAST ONE. They asked us to review every statutory form
 * for a form that cannot be looked at before it is downloaded. Borang A, Borang 8A, CP39, CP22 and
 * PCB 2(II) all had a preview; the C.P.8A (EA) had none. Its flow was: pick the people, press Generate, and
 * a file arrives with no way to check it first. This is that look — and it is the download's OWN bytes
 * served with `Content-Disposition: inline`, so the browser's PDF viewer opens it and pages through the
 * ticked employees one statement per page.
 *
 * ⚠️ IT IS NOT A SECOND RENDITION OF THE FORM, AND THAT IS THE WHOLE POINT. The obvious "preview" is an
 * HTML mock-up of the sheet on a screen; it is also two versions of one statutory form, drawn by two
 * pieces of code, and the day they disagree the operator has approved a document that is not the one they
 * sent. `lib/ea-pdf.ts` refuses a second renderer in as many words. So the preview renders through
 * `renderEaPdf` — the download's renderer, not a cousin of it — and the operator is looking at the file
 * itself.
 *
 * ⚠️ AND IT IS NOT A LIGHTER SURFACE. A preview carries the same names, identity card numbers, EPF and
 * SOCSO numbers and a whole year of pay and tax the download carries, so it is gated identically:
 * `scopedAdmin`, the id/shape allowlist, the selection ceiling, the company-scope check and the lang
 * allowlist, with the same bare 404 for a malformed id, a foreign company, an out-of-scope company or an
 * employment with no statement. That is enforced by CONSTRUCTION rather than by care: both routes are one
 * call into `../shared.ts`, and there is no second copy of the gate that could be relaxed here.
 *
 * NO DOMAIN EVENT, and nothing is recorded: looking at a statement is a read.
 */
import { eaPdfResponse } from '../shared';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

export async function GET(req: Request) {
  return eaPdfResponse(req, 'inline');
}
