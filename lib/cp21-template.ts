import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * r415 (item 79f3f64d, step 3) — the ONE place the bundled CP21 artwork is read off disk.
 *
 * The file is LHDN's own published CP21 [Pin.1/2025], "Borang Pemberitahuan oleh Majikan bagi Pekerja yang
 * Hendak Meninggalkan Malaysia", unaltered: two A4 pages (595.32 × 841.92 pt, LHDN's own page size), Malay
 * with English, the "LEAVER" tag LHDN prints at the top right, and the "UNTUK RUJUKAN SAHAJA" stamp across
 * both pages. The stamp stays for the reason lib/cp22a-template.ts gives: it is LHDN's own mark on LHDN's
 * own copy.
 *
 * sha256 5d6cfc9608dd6c3c1f2adbc37efd8fe785609c0a2eb9e7c299c77a8b74b4ea1c — pinned in
 * test/r415-cp21.test.ts, so a replaced file fails before any rect in lib/cp21-fields.ts is trusted against
 * artwork it was not measured from.
 *
 * The renderer (lib/cp21-pdf.ts) stays pure over the bytes; routes read through here.
 */
export const CP21_TEMPLATE_PATH = join('public', 'forms', 'cp21-pin-1-2025.pdf');

let cached: Uint8Array | null = null;

export function readCp21Template(): Uint8Array {
  if (!cached) cached = new Uint8Array(readFileSync(join(process.cwd(), CP21_TEMPLATE_PATH)));
  return cached;
}
