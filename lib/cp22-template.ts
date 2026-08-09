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
 * The file is LHDN's own published CP22 (Pin. 1/2020) page, unaltered — same layout, same wording, same
 * Malay and English. It is never modified: the renderer overlays AcroForm widgets on top of it and saves a
 * copy. `public/` is served by Next as static assets too, which is deliberate: the blank fillable copy is
 * generated through the same renderer so both downloads carry the same field set.
 */
export const CP22_TEMPLATE_PATH = join('public', 'forms', 'cp22-pin-1-2020.pdf');

let cached: Uint8Array | null = null;

export function readCp22Template(): Uint8Array {
  // Cached for the life of the process: the bytes are a build artefact, not tenant data, and re-reading
  // 153 KB on every download is pure waste. Node's require cache gives the module the same lifetime.
  if (!cached) cached = new Uint8Array(readFileSync(join(process.cwd(), CP22_TEMPLATE_PATH)));
  return cached;
}
