import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { cp22aParticulars } from '@/core/reporting';
import { cp22aContinuedCodes, cp22aDmy, cp22aOverflowCodes } from '@/lib/cp22a-pdf';
import { CP22A_FIELDS } from '@/lib/cp22a-fields';
import { CP22A_TYPED_PARAMS, cp22aTypedQuery, readCp22aTyped } from '@/lib/cp22a-review';
import { btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { MONO_UNDERLINE_FIELD as MONO_FIELD } from '@/components/monolith/classes';
import { StatutoryPdfViewer } from '@/components/statutory-pdf-viewer';

/**
 * r413 (item 79f3f64d, step 2) — CP22A: THE CHOSEN LEAVER'S NOTICE, IN THE SHARED VIEWER, THEN DOWNLOAD.
 *
 * Where the event-selection screen's Continue lands for CP22A. The frame is the download route's own bytes
 * served inline (components/statutory-pdf-viewer.tsx), at the page's TRUE shape — US Letter, LHDN's own.
 *
 * THE SIDE PANEL ASKS ONLY WHAT NOTHING ELSE CAN ANSWER: A5 (date the employer learned of a death), A6
 * (retirement type), A8 (separation scheme) and A17 (legal representative). A GET form back to this page;
 * the values ride in the URL into the frame and the download, through `readCp22aTyped`, and are never
 * stored. Everything else is corrected in the downloaded PDF, which stays fully editable.
 *
 * IT SAYS WHAT THE FORM DOES NOT CARRY, BEFORE THE DOWNLOAD (the plan's "the screen names each one"): the
 * period section B covers and why it ends where it does, every box left blank on purpose, any identifier
 * too long for LHDN's cells, any box that needs "see attached", and pay items with no EA box mapped.
 *
 * GATED like its PDF route: `scopedAdmin`, the company-scope check, and a real 404 for a foreign id, an
 * out-of-scope company, a non-Malaysian company or an employment with no leaving date. Registered in the
 * function-access matrix beside the CP22 review screen (lib/permissions.ts).
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Search = Record<string, string | string[] | undefined>;

function toQuery(sp: Search): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string') q.set(k, v);
  return q;
}

const CESSATION_KEY = {
  resigned: 'cessation_resigned',
  retired: 'cessation_retired',
  death: 'cessation_death',
} as const;

export default async function Cp22aPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ employmentId: string }>;
  searchParams: Promise<Search>;
}) {
  const { employmentId } = await params;
  if (!UUID.test(employmentId)) notFound();
  const t = await getTranslations('payroll.cp22a');
  const tf = await getTranslations('payroll.statutoryForms');
  const locale = await getLocale();

  const { s, scopeIds } = await scopedAdmin();
  const particulars = await cp22aParticulars(s, { employmentId });
  if (!particulars || !scopeIds.includes(particulars.companyId)) notFound();

  const typed = readCp22aTyped(toQuery(await searchParams));
  const data = { ...particulars, typed };
  const qs = cp22aTypedQuery(typed).toString();
  const base = `/payroll/cp22a/${employmentId}`;
  const withQs = (path: string, extra?: string) => `${path}${qs || extra ? '?' : ''}${qs}${qs && extra ? '&' : ''}${extra ?? ''}`;

  const overflow = cp22aOverflowCodes(data);
  const continued = await cp22aContinuedCodes(data);
  const blanks = CP22A_FIELDS.filter((f) => f.source === 'none');
  const dateFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const human = (iso: string | null) => (iso ? dateFmt.format(new Date(`${iso}T00:00:00Z`)) : '—');
  const backHref = `/payroll/statutory-forms/event?form=my.cp22a&companyId=${encodeURIComponent(particulars.companyId)}`;
  const selectCls = `${inputCls} ${MONO_FIELD}`;
  const panelCls = 'rounded-md border border-border px-3 py-2 text-xs monolith:rounded-none';
  const warnCls =
    'rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 monolith:rounded-none';

  const sidePanel = (
    <>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border monolith:rounded-none">
        <div className="bg-card p-3">
          <div className="text-xs text-muted-foreground">{t('tileCessation')}</div>
          <div className="text-sm font-semibold tabular-nums">{human(particulars.employee.cessationDate)}</div>
        </div>
        <div className="bg-card p-3">
          <div className="text-xs text-muted-foreground">{t('tileType')}</div>
          <div className="text-sm font-semibold">{t(CESSATION_KEY[particulars.employee.cessation])}</div>
        </div>
      </div>

      {/* WHAT SECTION B COVERS — said beside the frame, never in a tooltip. */}
      <div data-cp22a-period className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs monolith:rounded-none monolith:border-hairline monolith:bg-transparent">
        <p className="font-medium">{t('periodTitle')}</p>
        <p className="mt-1 text-muted-foreground">
          {particulars.pay.to
            ? t('periodNote', {
                from: cp22aDmy(particulars.pay.from),
                to: cp22aDmy(particulars.pay.to),
                cessation: cp22aDmy(particulars.employee.cessationDate),
              })
            : t('periodNone', { year: particulars.year })}
        </p>
        <p className="mt-1 text-muted-foreground">{t('totalNote')}</p>
      </div>

      {/* THE FOUR BOXES ONLY THE OPERATOR CAN ANSWER. GET back to this page; nothing is stored. */}
      <form method="get" action={`${base}/preview`} data-cp22a-typed className="space-y-3 rounded-md border border-border p-3 monolith:rounded-none">
        <p className="text-sm font-medium">{t('typedTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('typedHint')}</p>
        <label className="flex flex-col gap-1 text-xs">
          <span>{t('a5Label')}</span>
          <input type="date" name={CP22A_TYPED_PARAMS.deathNotifiedDate} defaultValue={typed.deathNotifiedDate ?? ''} className={selectCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span>{t('a6Label')}</span>
          <select name={CP22A_TYPED_PARAMS.retirement} defaultValue={typed.retirement ?? ''} className={selectCls}>
            <option value="">{t('notStated')}</option>
            <option value="compulsory">{t('a6Compulsory')}</option>
            <option value="optional">{t('a6Optional')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span>{t('a8Label')}</span>
          <select name={CP22A_TYPED_PARAMS.scheme} defaultValue={typed.scheme ?? ''} className={selectCls}>
            <option value="">{t('notStated')}</option>
            <option value="yes">{t('a8Yes')}</option>
            <option value="no">{t('a8No')}</option>
          </select>
        </label>
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium">{t('a17Title')}</legend>
          <label className="flex flex-col gap-1 text-xs">
            <span>{t('a17Name')}</span>
            <input type="text" maxLength={200} name={CP22A_TYPED_PARAMS.repName} defaultValue={typed.rep.name ?? ''} className={selectCls} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span>{t('a17Ic')}</span>
            <input type="text" maxLength={20} name={CP22A_TYPED_PARAMS.repIcNo} defaultValue={typed.rep.icNo ?? ''} className={selectCls} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span>{t('a17Relationship')}</span>
            <input type="text" maxLength={200} name={CP22A_TYPED_PARAMS.repRelationship} defaultValue={typed.rep.relationship ?? ''} className={selectCls} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span>{t('a17Address')}</span>
            <textarea rows={3} maxLength={400} name={CP22A_TYPED_PARAMS.repAddress} defaultValue={typed.rep.address.join('\n')} className={`${inputCls} h-auto py-1.5 ${MONO_FIELD}`} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span>{t('a17Phone')}</span>
            <input type="text" maxLength={40} name={CP22A_TYPED_PARAMS.repPhone} defaultValue={typed.rep.phone ?? ''} className={selectCls} />
          </label>
        </fieldset>
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

      <div data-cp22a-blanks className={panelCls}>
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
        pageShape="letter"
      />
    </div>
  );
}
