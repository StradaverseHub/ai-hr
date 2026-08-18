/**
 * 7ad37961 — stream ONE employee's completed LHDN TP1 for ONE deduction month as a PDF.
 *
 * ROUTE SHAPE COPIED FROM THE CP22 (app/payroll/cp22/[employmentId]/pdf/route.ts): Node runtime because
 * pdf-lib needs it, every path segment validated before any query, an RLS-gated read whose null is a 404,
 * `attachment` + `private, no-store`, and NO domain event — rendering a form is a read, and downloading
 * it is not filing. "I generated the form" stays a separate, deliberate act.
 *
 * `scopedAdmin` RATHER THAN `isAdmin`, for the reason that route documents: an hr_admin grant on ANY
 * company makes `isAdmin` true, and this document carries a named person's IC or passport, their tax
 * number and every relief they claimed. It fails closed twice — the session must be an admin AND the
 * employment must be one they are scoped to — and a foreign id, an out-of-scope company and an unknown
 * month are ALL the same 404, so the URL cannot be used to enumerate any of them.
 *
 * A route.ts IS NOT A PAGE and is deliberately NOT listed in the function-access matrix in
 * lib/permissions.ts — that matrix is an exact set over page.tsx files, and adding a handler to it would
 * fail the reverse-completeness case rather than satisfy it.
 *
 * WHAT IS PRINTED IS WHAT IS STORED. Every figure comes from the declaration row; the structure, the
 * wording and the limits come from the country pack catalogue. Nothing is computed here.
 */
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import {
  getTp1AccumulatedForPerson,
  getTp1ByIdForPerson,
  getTp1FormIdentity,
  listTp1DeclarationsForPersonYear,
  TP1_FORM_CODE,
  TP1_ITEMS,
  TP1_REBATES,
  type Tp1CatalogueItem,
} from '@/core/tax-relief';
import { isTp1Categories2026, type Tp1ItemAmounts } from '@/db/schema';
import { renderTp1Pdf, type Tp1PdfItem } from '@/lib/tp1-pdf';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

export async function GET(req: Request, { params }: { params: Promise<{ year: string; month: string }> }) {
  const { year: rawYear, month: rawMonth } = await params;
  const year = /^\d{4}$/.test(rawYear) ? Number(rawYear) : NaN;
  const month = /^\d{1,2}$/.test(rawMonth) ? Number(rawMonth) : NaN;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return notFound();
  if (!Number.isInteger(month) || month < 1 || month > 12) return notFound();

  const employmentId = new URL(req.url).searchParams.get('employmentId');
  if (!employmentId) return notFound();

  const { s, scopeIds } = await scopedAdmin();
  const employees = await listEmployees(s, scopeIds);
  const emp = employees.find((e) => e.employmentId === employmentId);
  if (!emp) return notFound();

  const rows = await listTp1DeclarationsForPersonYear(s, { personId: emp.personId, assessmentYear: year });
  const winner =
    rows.find((r) => r.deductionMonth === month) ??
    (month === 1 ? rows.find((r) => r.deductionMonth == null) : undefined);
  if (!winner) return notFound();

  const [row, accumulated, identity, t] = await Promise.all([
    getTp1ByIdForPerson(s, { personId: emp.personId, id: winner.id }),
    getTp1AccumulatedForPerson(s, {
      personId: emp.personId,
      assessmentYear: year,
      excludeRowId: winner.id,
    }),
    getTp1FormIdentity(s, { personId: emp.personId, companyId: emp.companyId }),
    getTranslations('taxRelief'),
  ]);
  if (!row) return notFound();

  const payload = isTp1Categories2026(row.categories) ? row.categories : null;
  const entryOf = (code: string): Tp1ItemAmounts | undefined =>
    payload ? (payload.items[code] ?? payload.rebates?.[code]) : undefined;

  // Null, not zero: an unfilled box prints EMPTY. A printed 0.00 asserts "nothing was claimed under this
  // head", which is a statement about a legal declaration that nobody made.
  const figure = (v: unknown): number | null => (v == null ? null : Number(v));

  const toPdfItem = (def: Tp1CatalogueItem, group: 'items' | 'rebates'): Tp1PdfItem => {
    const entry = entryOf(def.code);
    return {
      code: def.code,
      description: t(`${group}.${def.code}.label`),
      limit: def.limit,
      current: figure(entry?.amount),
      accumulated: figure(accumulated.items[def.code]),
      frequency: def.frequency ? t(`frequency.${def.frequency}`) : null,
      perSubLimit: def.perSubLimit,
      subItems: def.subItems.map((sub) => ({
        code: sub.code,
        description: t(`${group}.${def.code}.sub.${sub.code}`),
        limit: sub.limit,
        current: figure(entry?.subItems?.[sub.code]),
        accumulated: figure(accumulated.subItems[def.code]?.[sub.code]),
        frequency: sub.frequency ? t(`frequency.${sub.frequency}`) : null,
      })),
    };
  };

  const bytes = await renderTp1Pdf({
    formCode: TP1_FORM_CODE,
    deductionMonth: row.deductionMonth ?? month,
    deductionYear: year,
    employer: identity.employer,
    employee: identity.employee,
    items: TP1_ITEMS.map((d) => toPdfItem(d, 'items')),
    rebates: TP1_REBATES.map((d) => toPdfItem(d, 'rebates')),
    total: row.tp1Amount,
    declaration: {
      text: t('declarationText'),
      declaredOn: row.declaredAt ? row.declaredAt.toISOString().slice(0, 10) : null,
    },
    consent:
      row.status === 'approved'
        ? {
            status: row.status,
            approvedMonth: row.approvedMonth,
            approvedYear: row.approvedYear,
            date: row.approvedAt ? row.approvedAt.toISOString().slice(0, 10) : null,
            // Resolved through approved_by rather than copied onto the row; not joined yet, so the box
            // prints its blank rule — which is what the paper form's own blank Name box is.
            name: null,
            position: row.approverPosition,
          }
        : null,
    // The provenance band. Stated in the reader's own language and in English, because this claim is the
    // one thing a reader must not have to take on trust.
    provenance: [t('pdfProvenanceMs'), t('pdfProvenanceEn')],
  });

  const fname = `tp1-${year}-${String(row.deductionMonth ?? month).padStart(2, '0')}-${emp.name}`.replace(
    /[^a-zA-Z0-9._-]+/g,
    '-',
  );
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fname}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

const notFound = () => new Response('Not found', { status: 404 });
