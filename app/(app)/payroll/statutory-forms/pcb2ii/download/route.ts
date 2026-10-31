/**
 * 72b100cd (r323) — PCB 2(II) for the people who were TICKED, as one PDF.
 *
 * THE LAST STEP OF THE FLOW: choose the form, choose company and year, choose the people, generate.
 * Everything before this point renders lists; this and its `preview` sibling are the only places in the
 * flow that produce a document, and they produce one only when asked to.
 *
 * ⚠️ THE BODY OF THIS ROUTE IS `../shared.ts`, ON PURPOSE. r328 added `preview/route.ts`, which differs
 * from this file by ONE header value — `inline` instead of `attachment`. The gate (`scopedAdmin`, the
 * UUID shape test, the selection ceiling, the scope check, the lang allowlist, the bare 404), the read
 * and the renderer are therefore written ONCE, next door. A preview with its own copy of that gate is a
 * second, weaker door onto the same tax numbers and identity card numbers, and the copy that drifts is
 * the one nobody looks at again. Read `../shared.ts` before changing anything about this surface.
 *
 * NO DOMAIN EVENT: rendering a statement is a read, and this download is explicitly not a filing.
 */
import { pcb2iiPdfResponse } from '../shared';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

export async function GET(req: Request) {
  return pcb2iiPdfResponse(req, 'attachment');
}
