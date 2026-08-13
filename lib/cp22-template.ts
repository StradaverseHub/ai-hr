import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The ONE place the bundled CP22 artwork is read off disk.
 *
 * The renderer (lib/cp22-pdf.ts) is pure over the template BYTES so it stays unit-testable with no
 * filesystem; every route reads through here instead of inlining a path, so if the asset ever moves there
 * is one line to change and one test (test/cp22-pdf.test.ts) that fails first.
 *
 * The file is LHDN's own published CP22 [Pin.1/2021] — the TWO-PAGE edition that superseded Pin. 1/2020,
 * unaltered: same layout, same wording, same Malay and English, and the same "UNTUK RUJUKAN SAHAJA"
 * watermark LHDN prints across both pages. THAT WATERMARK IS NOT REMOVED. It is LHDN's own mark, and it is
 * there because since 1 September 2024 a CP22 is filed through e-CP22 on MyTax and a paper form is not
 * accepted — so it is telling the truth about the document. Erasing a government stamp to make our output
 * look tidier would misrepresent what LHDN published; the screens say why it is there instead.
 *
 * The bytes are never modified: the renderer overlays AcroForm widgets on top and saves a copy. `public/`
 * is served by Next as static assets too, which is deliberate: the blank fillable copy is generated
 * through the same renderer so both downloads carry the same field set.
 */
export const CP22_TEMPLATE_PATH = join('public', 'forms', 'cp22-pin-1-2021.pdf');

let cached: Uint8Array | null = null;

export function readCp22Template(): Uint8Array {
  // Cached for the life of the process: the bytes are a build artefact, not tenant data, and re-reading
  // 172 KB on every download is pure waste. Node's require cache gives the module the same lifetime.
  if (!cached) cached = new Uint8Array(readFileSync(join(process.cwd(), CP22_TEMPLATE_PATH)));
  return cached;
}
