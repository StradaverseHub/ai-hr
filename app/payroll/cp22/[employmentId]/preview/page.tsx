import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { cp22Particulars } from '@/core/reporting';
import { cp22FieldValues } from '@/lib/cp22-pdf';
import { CP22_FIELDS, CP22_SECTIONS, cp22Section } from '@/lib/cp22-fields';
import { CP22_REVIEW_PARAMS, cp22ContinuedCodes, cp22ReviewFrom } from '@/lib/cp22-review';
import { Card, Field, PageHeader, btnGhost, btnPrimary, inputCls } from '@/components/ui';

/**
 * 88076362 — the review step the reporter asked for, between the joiner list and the download.
 *
 * "TODAY YOU PRESS DOWNLOAD BESIDE A NEW JOINER AND A FINISHED FORM ARRIVES. THERE IS NOWHERE TO CHECK OR
 * CORRECT ANYTHING FIRST." That is the whole item. This screen shows what every one of the 53 boxes will
 * say, lets the five values worth correcting before production be corrected, and then offers the three
 * things the reporter asked for: view it, download the form, download the same content as plain text.
 *
 * GET-DRIVEN, NO CLIENT STATE, NO SERVER ACTION. The corrections travel in the query string, so the
 * reviewed form is a URL: it can be re-opened, bookmarked, and sent to a colleague, and the back button
 * works. That also means this file is a server component with no interactivity to hand across the
 * boundary — no closure ever reaches a client component, which is the 500-on-every-request trap.
 *
 * THE FIVE EDITABLE BOXES ARE NOT AN EDITOR FOR THE FORM. Everything else is corrected in the downloaded
 * PDF, which stays fully editable in the operator's own reader — that is the contract lib/cp22-pdf.ts
 * keeps and it is why the form is never flattened. Re-implementing fifty boxes as web inputs would be a
 * second, drifting copy of a government form. The five are the ones the reporter named, and the one that
 * matters most is the tax reference: on production 21 of 33 employees have none on file.
 *
 * "SUBMIT TO" IS SHOWN, AND SAID NOT TO PRINT. CP22 [Pin.1/2021] has no "Kepada / To" block — LHDN
 * removed the one the 2020 page had. The box is here because the operator still wants their record to say
 * where it went, and the note under it says plainly that it will not appear on the form. See
 * lib/cp22-review.ts.
 *
 * GATED LIKE ITS SIBLING ROUTES: `scopedAdmin`, not `isAdmin` — an hr_admin grant on ANY company makes
 * `isAdmin` true, and this screen shows one named person's IC, passport, tax number, home address and
 * salary. A foreign id, an out-of-scope company and a non-Malaysian company are all the same `notFound()`.
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Search = Record<string, string | string[] | undefined>;

/** The screen's own params → the URLSearchParams the shared review module reads. One conversion, here. */
function toQuery(sp: Search): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string') q.set(k, v);
  return q;
}

export default async function Cp22PreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ employmentId: string }>;
  searchParams: Promise<Search>;
}) {
  const { employmentId } = await params;
  const sp = await searchParams;
  const t = await getTranslations('payroll.cp22');
  const tf = await getTranslations('payroll.statutoryForms');

  if (!UUID.test(employmentId)) return <NotFound message={t('previewNotFound')} />;

  const { s, scopeIds } = await scopedAdmin();
  const particulars = await cp22Particulars(s, { employmentId });
  if (!particulars || !scopeIds.includes(particulars.companyId)) {
    return <NotFound message={t('previewNotFound')} />;
  }

  const q = toQuery(sp);
  const review = cp22ReviewFrom(particulars, q);
  // The values EXACTLY as the PDF will print them — same function, same corrections applied. If this
  // screen computed its own display values it would be a second copy of the mapping, free to drift from
  // the document it claims to preview.
  const values = cp22FieldValues({
    ...particulars,
    employer: { ...particulars.employer, name: review.employerName ?? '' },
    employee: {
      ...particulars.employee,
      incomeTaxNo: review.incomeTaxNo,
      commencementDate: review.commencementDate,
      expectedDuration: review.expectedDuration,
    },
  });

  // The corrections travel to the three actions as the SAME query string this page was reached with, so
  // "what I am looking at" and "what I download" cannot differ.
  const carried = new URLSearchParams();
  for (const key of Object.values(CP22_REVIEW_PARAMS)) carried.set(key, q.get(key) ?? defaultFor(key, review));
  const qs = carried.toString();
  const base = `/payroll/cp22/${employmentId}`;

  const missing = CP22_FIELDS.filter((f) => f.prefilled && f.type !== 'checkbox' && !(values[f.name] ?? '').trim());
  const blanks = CP22_FIELDS.filter((f) => !f.prefilled);
  // Boxes whose value will NOT fit on the printed form. The list below shows all of it; the PDF says
  // "see attached" on that box, which is what LHDN's own instruction at the head of section D tells you
  // to do. Saying nothing here would let the screen imply the form carries more than it does.
  const continued = await cp22ContinuedCodes(particulars);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('previewTitle')}
        description={t('previewDescription', { name: particulars.employee.fullName })}
        back={{ href: '/payroll/statutory-forms#worklist', label: t('previewBack') }}
      />

      {/* The correction that is owed before anything is produced, not after LHDN asks. */}
      <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
        <span className="font-medium">{t('notFilingTitle')}</span>{' '}
        <span className="text-muted-foreground">{t('notFiling')}</span>
      </div>
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {t('watermarkNote')}
      </div>

      {/* ── The five corrections, and the three actions. ONE form, method=get: pressing any button
             re-reads the page with the corrections in the URL, or hands them to a sibling route. */}
      <Card className="overflow-hidden">
        <form method="get" action={`${base}/preview`} className="space-y-4 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('reviewTaxNo')}>
              <input
                type="text"
                name={CP22_REVIEW_PARAMS.incomeTaxNo}
                defaultValue={review.incomeTaxNo ?? ''}
                maxLength={240}
                placeholder={t('reviewTaxNoPlaceholder')}
                className={inputCls}
              />
            </Field>
            <Field label={t('reviewSubmitTo')}>
              <input
                type="text"
                name={CP22_REVIEW_PARAMS.submitTo}
                defaultValue={review.submitTo ?? ''}
                maxLength={240}
                placeholder={t('reviewSubmitToPlaceholder')}
                className={inputCls}
              />
            </Field>
            <Field label={t('reviewCommencementDate')}>
              <input
                type="date"
                name={CP22_REVIEW_PARAMS.commencementDate}
                defaultValue={review.commencementDate ?? ''}
                className={inputCls}
              />
            </Field>
            <Field label={t('reviewDuration')}>
              <input
                type="text"
                name={CP22_REVIEW_PARAMS.expectedDuration}
                defaultValue={review.expectedDuration ?? ''}
                maxLength={240}
                className={inputCls}
              />
            </Field>
            <Field label={t('reviewEmployerName')} className="sm:col-span-2">
              <input
                type="text"
                name={CP22_REVIEW_PARAMS.employerName}
                defaultValue={review.employerName ?? ''}
                maxLength={240}
                className={inputCls}
              />
            </Field>
          </div>
          {/* Said where it is, not in a tooltip: this one box does not reach the printed form. */}
          <p className="text-xs text-muted-foreground">{t('reviewSubmitToNote')}</p>
          <div className="flex flex-wrap gap-2">
            <button className={btnPrimary}>{t('reviewApply')}</button>
          </div>
        </form>

        <div className="flex flex-wrap gap-2 border-t border-border bg-muted/30 px-4 py-3">
          {/* THREE ACTIONS, all plain links carrying the same corrections. `inline=1` is the only
              difference between View and Download — the same bytes, a different disposition. */}
          <Link href={`${base}/pdf?${qs}&inline=1`} target="_blank" rel="noopener" className={btnGhost}>
            {t('reviewView')}
          </Link>
          <Link href={`${base}/pdf?${qs}`} className={btnPrimary} title={t('downloadTitle')}>
            {t('download')}
          </Link>
          <Link href={`${base}/text?${qs}`} className={btnGhost} title={t('reviewTextTitle')}>
            {t('reviewText')}
          </Link>
        </div>
      </Card>

      {/* ── What is not there. Both lists, because they are different problems: `missing` is a box we
             WOULD fill and cannot because the record is empty (fixable on the staff profile), and
             `blanks` is a box nothing in the system can ever answer. Conflating them would send an
             operator looking for a field that does not exist. */}
      {missing.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{tf('readinessTitle', { count: missing.length })}</p>
          <ul className="mt-1 space-y-0.5">
            {missing.map((f) => (
              <li key={f.code}>
                {f.code}. {f.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      {continued.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {t('continuedNote', { codes: continued.join(', ') })}
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3 text-sm font-medium">{t('previewBoxesTitle')}</div>
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('previewBoxesHint')}</p>
        <div className="space-y-4 p-4">
          {CP22_SECTIONS.map((section) => (
            <div key={section.letter}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {section.letter}. {section.label}
              </h2>
              <dl className="mt-2 divide-y divide-border rounded-md border border-border">
                {CP22_FIELDS.filter((f) => cp22Section(f) === section.letter).map((f) => {
                  const value = f.type === 'checkbox' ? '' : (values[f.name] ?? '');
                  return (
                    <div key={f.code} className="grid gap-1 px-3 py-2 sm:grid-cols-[7rem_1fr_1fr] sm:gap-3">
                      <dt className="font-mono text-xs text-muted-foreground">{f.code}</dt>
                      <dd className="text-xs text-muted-foreground">{f.label}</dd>
                      <dd className="text-sm">
                        {value ? (
                          // A multi-row block holds one line per printed row; showing them stacked is
                          // what the form will look like, not a comma-joined approximation of it.
                          value.split('\n').map((line, i) => <div key={i}>{line}</div>)
                        ) : (
                          <span className="italic text-muted-foreground">
                            {f.prefilled ? t('previewEmpty') : t('previewBlankByDesign')}
                          </span>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          ))}
        </div>
      </Card>

      <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium">{t('previewBlankTitle')}</span> {blanks.map((f) => f.code).join(', ')}
      </div>
    </div>
  );
}

/** The default the URL should carry for a box the request did not send — i.e. the record's own value. */
function defaultFor(key: string, review: Record<string, unknown>): string {
  const field = Object.entries(CP22_REVIEW_PARAMS).find(([, k]) => k === key)?.[0];
  const v = field ? review[field] : null;
  return typeof v === 'string' ? v : '';
}

function NotFound({ message }: { message: string }) {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Card className="px-4 py-8 text-center text-sm text-muted-foreground">{message}</Card>
    </div>
  );
}
