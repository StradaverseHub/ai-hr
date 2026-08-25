/**
 * r220 (item 61c2e30f) — THE BLANK C.P.8A, so the arrangement can be checked before a filled one is
 * trusted.
 *
 * The reporter's request was to see the EA empty first: hold it next to LHDN's own page, confirm every
 * box, heading and caption is where the agency puts it, and only then read a statement with figures in it.
 * Until now an EA could only be produced for a NAMED employee, for a year that already had payroll behind
 * it, so there was no way to look at the form itself.
 *
 * SAME RENDERER, SAME PAGE, NO DATA: `renderEaPdf(blankEaPdfData(), labels, { blank: true })`. This is the
 * decision app/payroll/cp22/blank/route.ts made for the CP22 and the reason is the same — a second code
 * path that drew a "blank version" would be a second form to keep in step with the agency's arrangement,
 * which is the duplication lib/ea-pdf.ts exists to avoid. The blank is not a picture of the form; it IS
 * the form, with the money column left empty.
 *
 * `blank` is a static segment beneath `app/payroll/ea/`, which has no dynamic sibling, so it cannot
 * shadow anything. (The per-employee statement lives at `app/me/ea/[employmentId]/pdf` and the HTML one at
 * `app/payroll/reports/ea/[employmentId]`.)
 *
 * `requireAdmin` rather than a scoped read, exactly as the blank CP22 does: there is no company and no
 * employee in this response — the bytes are the empty form — so there is nothing for a company scope to
 * narrow. It is admin-only because it belongs to the Statutory Forms screen, not because it is sensitive.
 */
import { getLocale } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { blankEaPdfData, renderEaPdf } from '@/lib/ea-pdf';
import { eaPdfLabels } from '@/lib/ea-pdf-labels';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

/**
 * 587ee719's allowlist, and for the same reason: the LANGUAGE OF THE DOCUMENT, NOT OF THE VIEWER. LHDN
 * accepts the C.P.8A in English or Bahasa Malaysia, the shelf carries a row for each, and the blank copy
 * beside each row must come out in that row's language whatever the screen is set to. An unrecognised
 * value falls back to the request locale rather than reaching next-intl, which would throw on an unknown
 * locale and 500 a download.
 */
const EA_LANGS = ['en', 'ms'] as const;
type EaLang = (typeof EA_LANGS)[number];

export async function GET(req: Request) {
  await requireAdmin();

  const langParam = new URL(req.url).searchParams.get('lang');
  const lang: EaLang | null = EA_LANGS.includes(langParam as EaLang) ? (langParam as EaLang) : null;
  const locale = lang ?? (await getLocale());

  const bytes = await renderEaPdf(blankEaPdfData(), await eaPdfLabels(locale, { blank: true }), { blank: true });

  // The language rides in the filename because both are offered from the same shelf and an operator
  // downloading each of them should not end up with "…(1).pdf" and no way to tell which is which.
  const fname = `ea-cp8a-blank-${lang ?? locale}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fname}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
