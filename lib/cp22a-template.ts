import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * r413 (item 79f3f64d, step 2) — the ONE place the bundled CP22A artwork is read off disk.
 *
 * The file is LHDN's own published CP22A [Pin.1/2023], "Borang Pemberitahuan Pemberhentian Kerja (Swasta)",
 * unaltered: two US Letter pages (612 × 792 pt — LHDN's own page size, kept, never re-flowed onto A4), Malay
 * only, and the "UNTUK RUJUKAN SAHAJA" stamp LHDN prints across both pages. The stamp stays for the reason
 * lib/cp22-template.ts gives for the CP22's: it is LHDN's own mark on LHDN's own copy.
 *
 * sha256 01a42b91313ddb584117e776c90c71618073044e6a0f286e06c416ec2f5c756f — pinned in
 * test/r413-cp22a.test.ts, so a replaced file fails before any rect in lib/cp22a-fields.ts is trusted
 * against artwork it was not measured from.
 *
 * The renderer (lib/cp22a-pdf.ts) stays pure over the bytes; routes read through here.
 */
export const CP22A_TEMPLATE_PATH = join('public', 'forms', 'cp22a-pin-1-2023.pdf');

let cached: Uint8Array | null = null;

export function readCp22aTemplate(): Uint8Array {
  if (!cached) cached = new Uint8Array(readFileSync(join(process.cwd(), CP22A_TEMPLATE_PATH)));
  return cached;
}
