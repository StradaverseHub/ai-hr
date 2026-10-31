import { eaLayoutFailure } from '@/lib/ea-layout-response';
// Mine uses an explicit own-subject facade, including administrators. Availability and canonical
// aggregation share one read snapshot; inline/download differ only in disposition.
import { getLocale } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { myEaPdfFile, type EaDocumentLang } from '../../document';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 587ee719 — THE LANGUAGE OF THE DOCUMENT, NOT OF THE VIEWER.
 *
 * Until this round the EA PDF resolved `payroll.ea` against whatever UI locale the caller happened to be
 * in, so "the EA in Bahasa Malaysia" was a settings change rather than a form you could ask for — and the
 * Statutory Forms shelf said so in as many words. LHDN accepts the C.P.8A in either language and an
 * employer may need both in the same year, for different people, from the same admin session. So the
 * language is now a REQUEST parameter with its own allowlist, defaulting to the caller's locale, which
 * leaves every existing link (app/(app)/me, the payslip screens) rendering exactly what it rendered before.
 *
 * ONE RENDERER STILL. `lib/ea-pdf.ts` is untouched: only the label bundle handed to it changes. A second
 * EA implementation for a second language is two statements that drift apart for one statutory document.
 */
const EA_LANGS = ['en', 'ms'] as const satisfies readonly EaDocumentLang[];
type EaLang = (typeof EA_LANGS)[number];

export async function GET(req: Request, { params }: { params: Promise<{ employmentId: string }> }) {
  const { employmentId } = await params;
  if (!UUID.test(employmentId)) return new Response('Not found', { status: 404,headers:{'Cache-Control':'private, no-store'} });
  // Year is a 4-char STRING end-to-end (the read filters payPeriod LIKE '<year>-%'); default to the
  // current calendar year as a string, never a number.
  const yearParam = new URL(req.url).searchParams.get('year');
  if(yearParam!==null&&!/^\d{4}$/.test(yearParam))return new Response('Not found',{status:404,headers:{'Cache-Control':'private, no-store'}});
  const year = yearParam ?? todayInKualaLumpur().slice(0,4);

  // b7b22514 — an EA form belongs to ONE employer, and after an Entity Transfer a year can span two. The
  // caller names which employer's form it wants; unnamed means the employment's current company, which is
  // what every pre-transfer link resolves to. An unrecognised id is refused rather than quietly falling
  // back — silently handing someone the WRONG employer's statement is the failure this route must not have.
  const companyParam = new URL(req.url).searchParams.get('company');
  if(companyParam!==null&&!UUID.test(companyParam))return new Response('Not found',{status:404,headers:{'Cache-Control':'private, no-store'}});

  const s = await getSession();
  // Only the supported English/Malay document editions reach the PDF owner. Other UI locales use
  // English unless the reader explicitly selected Malay.
  const langParam = new URL(req.url).searchParams.get('lang');
  const lang: EaLang | null = EA_LANGS.includes(langParam as EaLang) ? (langParam as EaLang) : null;
  // M09 — the statement read, the render and the file name are shared with the mobile v2 route
  // (app/(app)/me/ea/document.ts), so both hand over the same bytes under the same name. The document locale is
  // still the requested one, else this caller's UI locale, resolved only once a statement exists.
  const file = await myEaPdfFile(s, {
    employmentId,
    year,
    ...(companyParam ? { companyId: companyParam } : {}),
  }, { lang, fallback: async () => ((await getLocale())==='ms'?'ms':'en') });
  if (file.outcome === 'not_found') return new Response('Not found', { status: 404,headers:{'Cache-Control':'private, no-store'} });
  if (file.outcome === 'layout') return eaLayoutFailure(file.error, file.locale, file.employee);
  return new Response(Buffer.from(file.bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${new URL(req.url).searchParams.get('disposition')==='inline'?'inline':'attachment'}; filename="${file.fileName}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
