import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { cp21Particulars } from '@/core/reporting';
import { cp21ContinuedCodes, cp21OverflowCodes } from '@/lib/cp21-pdf';
import { cp22aDmy } from '@/lib/cp22a-pdf';
import { CP21_FIELDS } from '@/lib/cp21-fields';
import { CP21_TYPED_PARAMS, cp21TypedQuery, cp21TypedRejections, readCp21Typed } from '@/lib/cp21-review';
import { btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { MONO_UNDERLINE_FIELD as MONO_FIELD } from '@/components/monolith/classes';
import { StatutoryPdfViewer } from '@/components/statutory-pdf-viewer';

/**
 * r415 (item 79f3f64d, step 3) — CP21: ONE EMPLOYEE'S NOTICE OF LEAVING MALAYSIA, IN THE SHARED VIEWER.
 *
 * Where the event-selection screen's Continue lands for CP21. The frame is the download route's own bytes
 * served inline (components/statutory-pdf-viewer.tsx), at the page's TRUE shape — A4, LHDN's own.
 *
 * THE SIDE PANEL ASKS ONLY WHAT NOTHING ELSE CAN ANSWER: A3 (expected departure date), A14 (reason), A15
 * (address outside Malaysia), A16 (expected return date) and A18 (separation scheme). A GET form back to
 * this page; the values ride in the URL into the frame and the download, through `readCp21Typed`, and are
 * never stored. A value that is not an allowed answer is dropped and SAID to be dropped
 * (`cp21TypedRejections`), never silently printed as less. The departure date also sets the period that
 * section B covers, which the panel states beside the frame.
 *
 * IT SAYS WHAT THE FORM DOES NOT CARRY, BEFORE THE DOWNLOAD: the period and why it ends where it does,
 * every box left blank on purpose, any identifier too long for LHDN's cells, any box that needs "see
 * attached", and pay items with no EA box mapped.
 *
 * GATED like its PDF route: `scopedAdmin`, the company-scope check, and a real 404 for a foreign id, an
 * out-of-scope company or a non-Malaysian company. Registered in the function-access matrix beside the
 * CP22A viewer (lib/permissions.ts).
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Search = Record<string, string | string[] | undefined>;

function toQuery(sp: Search): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string') q.set(k, v);
  return q;
}

export default async function Cp21PreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ employmentId: string }>;
  searchParams: Promise<Search>;
}) {
  const { employmentId } = await params;
  if (!UUID.test(employmentId)) notFound();
  const t = await getTranslations('payroll.cp21');
  const tf = await getTranslations('payroll.statutoryForms');

  const query = toQuery(await searchParams);
  const typed = readCp21Typed(query);
  const rejected = cp21TypedRejections(query);

  const { s, scopeIds } = await scopedAdmin();
  const particulars = await cp21Particulars(s, { employmentId, departureDate: typed.departureDate });
  if (!particulars || !scopeIds.includes(particulars.companyId)) notFound();

  const data = { ...particulars, typed };
  const qs = cp21TypedQuery(typed).toString();
  const base = `/payroll/cp21/${employmentId}`;
  const withQs = (path: string, extra?: string) => `${path}${qs || extra ? '?' : ''}${qs}${qs && extra ? '&' : ''}${extra ?? ''}`;

  const overflow = cp21OverflowCodes(data);
  const continued = await cp21ContinuedCodes(data);
  const blanks = CP21_FIELDS.filter((f) => f.source === 'none');
  const backHref = `/payroll/statutory-forms/event?form=my.cp21&companyId=${encodeURIComponent(particulars.companyId)}`;
  const selectCls = `${inputCls} ${MONO_FIELD}`;
  const panelCls = 'rounded-md border border-border px-3 py-2 text-xs monolith:rounded-none';
  const warnCls =
    'rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 monolith:rounded-none';
  const residentKey =
    particulars.employee.resident === true ? 'resident_yes' : particulars.employee.resident === false ? 'resident_no' : 'resident_unknown';

  const sidePanel = (
    <>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border monolith:rounded-none">
        <div className="bg-card p-3">
          <div className="text-xs text-muted-foreground">{t('tileDeparture')}</div>
          <div className="text-sm font-semibold tabular-nums">{typed.departureDate ? cp22aDmy(typed.departureDate) : t('notTyped')}</div>
        </div>
        <div className="bg-card p-3">
          <div className="text-xs text-muted-foreground">{t('tileResident')}</div>
          <div className="text-sm font-semibold">{t(residentKey)}</div>
        </div>
      </div>

      {rejected.length > 0 && (
        <div role="alert" data-cp21-rejected className={warnCls}>
          {t('rejectedNote', { codes: rejected.join(', ') })}
        </div>
      )}

      {/* WHAT SECTION B COVERS — said beside the frame, never in a tooltip. */}
      <div data-cp21-period className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs monolith:rounded-none monolith:border-hairline monolith:bg-transparent">
        <p className="font-medium">{t('periodTitle')}</p>
        <p className="mt-1 text-muted-foreground">
          {particulars.pay.to
            ? typed.departureDate
              ? t('periodNoteDeparture', {
                  from: cp22aDmy(particulars.pay.from),
                  to: cp22aDmy(particulars.pay.to),
                  departure: cp22aDmy(typed.departureDate),
                })
              : t('periodNoteToday', { from: cp22aDmy(particulars.pay.from), to: cp22aDmy(particulars.pay.to) })
            : t('periodNone', { year: particulars.year })}
        </p>
        <p className="mt-1 text-muted-foreground">{t('notReturningNote')}</p>
        <p className="mt-1 text-muted-foreground">{t('totalNote')}</p>
      </div>

      {/* THE FIVE BOXES ONLY THE OPERATOR CAN ANSWER. GET back to this page; nothing is stored. */}
      <form method="get" action={`${base}/preview`} data-cp21-typed className="space-y-3 rounded-md border border-border p-3 monolith:rounded-none">
        <p className="text-sm font-medium">{t('typedTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('typedHint')}</p>
        <label className="flex flex-col gap-1 text-xs">
          <span>{t('a3Label')}</span>
          <input type="date" name={CP21_TYPED_PARAMS.departureDate} defaultValue={typed.departureDate ?? ''} className={selectCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span>{t('a14Label')}</span>
          <input type="text" maxLength={200} name={CP21_TYPED_PARAMS.reason} defaultValue={typed.reason ?? ''} className={selectCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span>{t('a15Label')}</span>
          <textarea
            rows={4}
            maxLength={400}
            name={CP21_TYPED_PARAMS.overseasAddress}
            defaultValue={typed.overseasAddress.join('\n')}
            className={`${inputCls} h-auto py-1.5 ${MONO_FIELD}`}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span>{t('a16Label')}</span>
          <input type="date" name={CP21_TYPED_PARAMS.returnDate} defaultValue={typed.returnDate ?? ''} className={selectCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span>{t('a18Label')}</span>
          <select name={CP21_TYPED_PARAMS.scheme} defaultValue={typed.scheme ?? ''} className={selectCls}>
            <option value="">{t('notStated')}</option>
            <option value="yes">{t('a18Yes')}</option>
            <option value="no">{t('a18No')}</option>
          </select>
        </label>
        <button className={`${btnPrimary} w-full monolith:h-11 monolith:rounded-full monolith:bg-ink monolith:text-bone`}>{t('apply')}</button>
      </form>

      {overflow.length > 0 && <div className={warnCls}>{t('overflowNote', { codes: overflow.join(', ') })}</div>}
      {continued.length > 0 && <div className={warnCls}>{t('continuedNote', { codes: continued.join(', ') })}</div>}
      {particulars.unmappedPayItems.length > 0 && (
        <div className={warnCls}>
          {t('unmappedNote', {
            count: particulars.unmappedPayItems.length,
            names: particulars.unmappedPayItems.map((u) => u.name).join(', '),
          })}
        </div>
      )}

      <div data-cp21-blanks className={panelCls}>
        <p className="font-medium">{t('blankTitle')}</p>
        <ul className="mt-1 space-y-0.5 text-muted-foreground">
          {blanks.map((f) => (
            <li key={f.code}>
              <span className="font-mono">{f.code}</span> {f.label}
            </li>
          ))}
        </ul>
      </div>
      <div className={`${panelCls} text-muted-foreground`}>{t('watermarkNote')}</div>
    </>
  );

  return (
    <div className={pageWideCls}>
      <StatutoryPdfViewer
        title={t('title')}
        subtitle={`${particulars.employer.name} · ${particulars.employee.fullName}`}
        pdfUrl={withQs(`${base}/pdf`, 'inline=1')}
        downloads={[{ href: withQs(`${base}/pdf`), label: t('download') }]}
        back={{ href: backHref, label: t('viewerBack') }}
        openInNewTabLabel={tf('viewer_openNewTab')}
        frameTitle={tf('viewer_frameTitle', { form: t('title') })}
        sidePanel={sidePanel}
        pageShape="a4"
      />
    </div>
  );
}
