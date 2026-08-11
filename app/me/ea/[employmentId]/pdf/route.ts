// ADR-0036 (#22 follow-up) — stream a self-serve annual EA (C.P.8A) statement as a downloadable A4 PDF.
// ABAC is inherited from employeeEaStatement → the MY pack's eaStatement, which is RLS-gated: the read
// returns null unless the caller may see the employment (own, a report's/subordinate's via
// can_see_employment, or admin via is_admin_for — db/migrations 0010/0016/0017). So an employee can only
// pull their own (or a subordinate's, or — as admin — their company's) EA. Mirrors the payslip-pdf route.
import { getLocale, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { employeeEaCompanies, employeeEaStatement } from '@/core/reporting';
import { renderEaPdf, type EaPdfData } from '@/lib/ea-pdf';

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
 * leaves every existing link (app/me, the payslip screens) rendering exactly what it rendered before.
 *
 * ONE RENDERER STILL. `lib/ea-pdf.ts` is untouched: only the label bundle handed to it changes. A second
 * EA implementation for a second language is two statements that drift apart for one statutory document.
 */
const EA_LANGS = ['en', 'ms'] as const;
type EaLang = (typeof EA_LANGS)[number];

export async function GET(req: Request, { params }: { params: Promise<{ employmentId: string }> }) {
  const { employmentId } = await params;
  if (!UUID.test(employmentId)) return new Response('Not found', { status: 404 });
  // Year is a 4-char STRING end-to-end (the read filters payPeriod LIKE '<year>-%'); default to the
  // current calendar year as a string, never a number.
  const yearParam = new URL(req.url).searchParams.get('year') ?? '';
  const year = /^\d{4}$/.test(yearParam) ? yearParam : String(new Date().getFullYear());

  // b7b22514 — an EA form belongs to ONE employer, and after an Entity Transfer a year can span two. The
  // caller names which employer's form it wants; unnamed means the employment's current company, which is
  // what every pre-transfer link resolves to. An unrecognised id is refused rather than quietly falling
  // back — silently handing someone the WRONG employer's statement is the failure this route must not have.
  const companyParam = new URL(req.url).searchParams.get('company');

  const s = await getSession();
  if (companyParam) {
    const allowed = await employeeEaCompanies(s, { employmentId, year });
    if (!allowed.some((c) => c.companyId === companyParam)) return new Response('Not found', { status: 404 });
  }
  const ea = await employeeEaStatement(s, {
    employmentId,
    year,
    ...(companyParam ? { companyId: companyParam } : {}),
  }); // RLS-gated: null → 404 (foreign id)
  if (!ea) return new Response('Not found', { status: 404 });

  // Allowlisted, never trusted: an unrecognised `lang` falls back to the request locale rather than being
  // passed to next-intl, which would throw on an unknown locale and 500 a download.
  const langParam = new URL(req.url).searchParams.get('lang');
  const lang: EaLang | null = EA_LANGS.includes(langParam as EaLang) ? (langParam as EaLang) : null;
  const locale = lang ?? (await getLocale());
  const t = await getTranslations({ locale, namespace: 'payroll.ea' });
  const data: EaPdfData = {
    year: ea.year,
    employer: ea.employer,
    employee: ea.employee,
    partB: ea.partB,
    partD: ea.partD,
    partE: ea.partE,
    statutoryVersion: ea.statutoryVersion,
    // 1.2.6 EA Data Overwrite — pass HR's EA-only amendments through so the PDF can print the "Amended"
    // footnote. Built field-by-field here, so this line is REQUIRED or the marker silently drops.
    overrides: ea.overrides,
  };
  const bytes = await renderEaPdf(data, {
    title: t('title'),
    yearEnded: t('yearEnded', { year: ea.year, employer: ea.employer.name }),
    category1: t('category1'),
    category2: t('category2'),
    category3: t('category3'),
    sectionAEmployeeParticulars: t('sectionAEmployeeParticulars'),
    name: t('name'),
    incomeTaxNo: t('incomeTaxNo'),
    icNo: t('icNo'),
    epfNo: t('epfNo'),
    socsoNo: t('socsoNo'),
    mtdCategory: t('mtdCategory'),
    childrenTaxRelief: t('childrenTaxRelief'),
    employmentPeriod: t('employmentPeriod'),
    present: t('present'),
    sectionBEmploymentIncome: t('sectionBEmploymentIncome'),
    grossSalary: t('grossSalary'),
    bonus: t('bonus'),
    allowancesPerquisites: t('allowancesPerquisites'),
    exemptAllowances: t('exemptAllowances'),
    benefitsInKind: t('benefitsInKind'),
    livingAccommodation: t('livingAccommodation'),
    notTracked: t('notTracked'),
    totalGrossRemuneration: t('totalGrossRemuneration'),
    sectionDTotalDeductions: t('sectionDTotalDeductions'),
    monthlyTaxDeduction: t('monthlyTaxDeduction'),
    cp38Deductions: t('cp38Deductions'),
    zakatViaSalary: t('zakatViaSalary'),
    sectionEContributions: t('sectionEContributions'),
    epfKwsp: t('epfKwsp'),
    socso: t('socso'),
    eisSip: t('eisSip'),
    disclaimer: t('disclaimer', { year: ea.year, version: ea.statutoryVersion }),
    amendedNote: t('override.amendedNote'),
  });

  // Substrate: this is a read-only render (no state change), so it appends NO domain event — same as the
  // payslip-pdf route. Deliberate skip.
  // The language rides in the filename ONLY when it was asked for, so every pre-existing link keeps the
  // filename it always produced — and an employer pulling both versions of the same person's statement
  // does not end up with "…(1).pdf" and no way to tell which is which.
  const fname = `ea-${ea.year}-${ea.employer.name}${lang ? `-${lang}` : ''}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fname}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
