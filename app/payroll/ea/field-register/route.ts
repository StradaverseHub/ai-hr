/**
 * r220 (item 61c2e30f) — the EA field register, downloadable from the Statutory Forms shelf.
 *
 * Every box on the C.P.8A with its official section, its official box number, the agency's own wording,
 * the kind of value it takes and what feeds it today — or "nothing feeds this yet". It is what turns
 * "is the EA right?" into a box-by-box check somebody can work down with the blank form beside them.
 *
 * SERVED FROM THE CONSTANT, NOT FROM `docs/`. `renderEaFieldRegisterMarkdown()` is a pure function over
 * `lib/ea-field-register.ts`, and `docs/forms/ea-cp8a-field-register.md` is generated from the same
 * function (scripts/gen-ea-field-register.ts), with a test holding the two together. So this route reads
 * no file at runtime: it cannot 404 because a deploy did not carry `docs/`, and what an operator downloads
 * is byte-identical to what the repository reviews.
 *
 * `requireAdmin`, like the blank form beside it: there is no company and no employee in this response, and
 * it is admin-only because it belongs to the Statutory Forms screen.
 *
 * NOT LOCALIZED, deliberately. The register's third column is the AGENCY'S OWN MALAY WORDING — the string
 * a reader checks against LHDN's page — and its last column names internal captions. Translating the
 * scaffolding around those would produce six documents whose load-bearing content is identical and whose
 * wording drifts; the form itself is what comes in two languages, and it already does.
 */
import { requireAdmin } from '@/lib/authz';
import { renderEaFieldRegisterMarkdown } from '@/lib/ea-field-register';

export const runtime = 'nodejs';

export async function GET() {
  await requireAdmin();
  return new Response(renderEaFieldRegisterMarkdown(), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="ea-cp8a-field-register.md"',
      'Cache-Control': 'private, no-store',
    },
  });
}
