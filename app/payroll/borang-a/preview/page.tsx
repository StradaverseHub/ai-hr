import { getLocale, getTranslations } from 'next-intl/server';
import { listCompanies } from '@/core/read';
import { scopedAdmin } from '@/lib/scope';
import { money } from '@/lib/borang-a';
import { todayInKualaLumpur, yearOptions } from '@/lib/hr-date';
import { Card, Field, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { loadBorangA } from '../shared';

/**
 * 9c8dad7a / 3aae0789 — the Borang A review screen: pick a processed payroll month, check the form, then
 * download it three ways.
 *
 * "SHOW ME A REVIEW SCREEN FIRST, NAMING ANYONE MISSING AN EPF MEMBER NUMBER OR IDENTITY CARD NUMBER,
 * BEFORE ANYTHING CAN BE DOWNLOADED." That is the item, and it is why this screen exists beside the
 * generic [formId] figures screen rather than instead of it. The generic screen renders any form's table
 * and can render this one; what it cannot do is carry the contribution-month picker and the upload file's
 * own inputs, because it does not know what a Borang A is. So the shelf card opens the figures screen as
 * every other form does, and the figures screen hands you this one for the documents themselves.
 *
 * GET-DRIVEN, NO CLIENT STATE, NO SERVER ACTION — r191's CP22 and r193's Borang 8A review screens' shape.
 * The typed inputs travel in the query string, so the reviewed form is a URL: it re-opens, bookmarks,
 * sends to a colleague, and the back button works. It also means this file is a server component with no
 * interactivity to hand across the boundary, so no closure ever reaches a client component.
 *
 * TWO SIBLING FORMS, NEVER NESTED. A form inside a form is invalid HTML and browsers drop the inner one,
 * which would silently turn the download buttons into a second "Show". The filter form owns company /
 * year / month; the schedule form owns the contribution month, the upload file's inputs and the three
 * downloads, and carries its own hidden companyId + periodKey for exactly that reason.
 *
 * THE READINESS GATE IS ENFORCED TWICE, AND THAT IS NOT BELT-AND-BRACES. This screen hides the download
 * buttons while anyone is not ready; `loadBorangA` refuses to produce the document at all. Hiding a
 * button is a UI courtesy — a bookmarked download URL would sail straight past it.
 *
 * GATED LIKE ITS SIBLING ROUTES: `scopedAdmin`, not `isAdmin` — an hr_admin grant on ANY company makes
 * `isAdmin` true, and this screen lists every employee's name, identity card number, EPF member number,
 * wage and contribution. Registered in the function-access matrix under `statutoryForms`
 * (lib/permissions.ts): a guarded page.tsx with no column fails test/function-access.test.ts.
 */
export const dynamic = 'force-dynamic';

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

/**
 * The header fields an operator can actually go and fill in, named in their language.
 *
 * A PARTIAL MAP, DELIBERATELY. `missingBorangAHeader` also reports the computed fields (the contribution
 * month, the two period keys, the print date), which cannot be blank in practice and which nobody can "go
 * and set" if they somehow are. Those fall through to the raw key rather than being given a reassuring
 * label that would send somebody looking for a field that does not exist on any screen.
 */
const HEADER_FIELD_LABEL: Record<string, string> = {
  employerRef: 'headerField_employerRef',
  employerName: 'headerField_employerName',
};

const REP_FIELD_LABEL: Record<string, string> = {
  repName: 'repField_name',
  repIc: 'repField_ic',
  repPosition: 'repField_position',
  repPhone: 'repField_phone',
  repEmail: 'repField_email',
};

/** Default to the month just ENDED — the one whose Borang A is actually open. Same rule as the shelf. */
function previousMonth(today: string): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

type Search = Record<string, string | string[] | undefined>;

/** The screen's own params → the URLSearchParams the shared loader reads. One conversion, here. */
function toQuery(sp: Search): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string') q.set(k, v);
  return q;
}

export default async function BorangAPreviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const t = await getTranslations('payroll.borangA');
  const locale = await getLocale();
  const sp = await searchParams;

  const { scopeIds, s } = await scopedAdmin();
  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt && scopeIds.includes(c.id));
  // An out-of-scope companyId in the URL falls back to the first company this admin CAN administer rather
  // than being honoured — the same rule the [formId] screen and the download routes apply, so the four
  // cannot disagree about which company is being looked at.
  const requested = typeof sp.companyId === 'string' && scopeIds.includes(sp.companyId) ? sp.companyId : '';
  const companyId = requested || companies[0]?.id || '';

  const today = todayInKualaLumpur();
  const spPeriod = typeof sp.periodKey === 'string' ? sp.periodKey : '';
  const fallback = /^\d{4}-\d{2}$/.test(spPeriod) ? spPeriod : previousMonth(today);
  const year = typeof sp.year === 'string' && /^\d{4}$/.test(sp.year) ? sp.year : fallback.slice(0, 4);
  const month = MONTHS.includes(sp.month as (typeof MONTHS)[number]) ? (sp.month as string) : fallback.slice(5, 7);
  const periodKey = `${year}-${month}`;
  const years = yearOptions(today, year);
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const monthName = (mm: string) => monthFmt.format(new Date(Date.UTC(2000, Number(mm) - 1, 1)));
  const periodLabel = `${monthName(month)} ${year}`;
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';

  // `includeIncomplete` — this screen must be able to RENDER the table in order to name who is missing.
  // The download routes call the same function without it and are refused.
  const loaded = companyId
    ? await loadBorangA({ companyId, periodKey, query: toQuery(sp), includeIncomplete: true })
    : ({ ok: false, reason: 'not-found' } as const);

  const filter = (
    <Card className="overflow-hidden print:hidden">
      <form method="get" className="flex flex-wrap items-end gap-3 px-4 py-4">
        <Field label={t('company')}>
          <select name="companyId" defaultValue={companyId} className={inputCls}>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('year')}>
          <select name="year" defaultValue={year} className={inputCls}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('month')}>
          <select name="month" defaultValue={month} className={inputCls}>
            {MONTHS.map((m) => (
              <option key={m} value={m}>
                {monthName(m)}
              </option>
            ))}
          </select>
        </Field>
        <button className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent">
          {t('show')}
        </button>
      </form>
    </Card>
  );

  const header = (
    <PageHeader
      title={t('title')}
      description={`${companyName} · ${periodLabel}`}
      back={{ href: `/payroll/statutory-forms?companyId=${encodeURIComponent(companyId)}&body=epf`, label: t('back') }}
    />
  );

  // THE PROVENANCE NOTICE, above everything and never in a tooltip: what comes off this screen looks like
  // a government form and is not one. That is the single claim the statutory-forms fidelity vocabulary
  // exists to keep honest, and the screen that produces the document is where it has to be said.
  const provenance = (
    <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
      <span className="font-medium">{t('notArtworkTitle')}</span>{' '}
      <span className="text-muted-foreground">{t('notArtwork')}</span>
    </div>
  );

  if (!loaded.ok) {
    return (
      <div className="mx-auto max-w-[100rem] space-y-6">
        {header}
        {provenance}
        {filter}
        <Card>
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {loaded.reason === 'no-batch' ? t('noBatch', { company: companyName, period: periodLabel }) : t('notFound')}
          </p>
        </Card>
      </div>
    );
  }

  const { form, missing, headerMissing, repMissing, fileReadiness, periodOverridden, summary, notes } = loaded;
  const ready = missing.length === 0 && headerMissing.length === 0;
  const rows = form.pages.flatMap((p) => p.rows);

  return (
    <div className="mx-auto max-w-[100rem] space-y-6">
      {header}
      {provenance}
      {filter}

      {/* The +1 rule, stated where the form is produced. It is the fact most likely to be "corrected"
          into the SOCSO rule by somebody comparing the two forms. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
        <div className="bg-card p-4">
          <div className="text-xs text-muted-foreground">{t('tileMonth')}</div>
          <div className="text-lg font-semibold">{form.contributionMonth}</div>
          <div className="text-xs text-muted-foreground">{t('tileMonthHint')}</div>
        </div>
        <div className="bg-card p-4">
          <div className="text-xs text-muted-foreground">{t('tileEmployees')}</div>
          <div className="text-lg font-semibold tabular-nums">{form.employees}</div>
          <div className="text-xs text-muted-foreground">{t('tileSheets', { count: form.pages.length })}</div>
        </div>
        <div className="bg-card p-4">
          <div className="text-xs text-muted-foreground">{t('tileWage')}</div>
          <div className="text-lg font-semibold tabular-nums">RM {money(form.totalWage)}</div>
          <div className="text-xs text-muted-foreground">{t('tileWageHint')}</div>
        </div>
        <div className="bg-card p-4">
          <div className="text-xs text-muted-foreground">{t('tileTotal')}</div>
          <div className="text-lg font-semibold tabular-nums">RM {money(form.totalContribution)}</div>
          <div className="text-xs text-muted-foreground">{t('tileRef', { ref: form.employerRef || '—' })}</div>
        </div>
      </div>

      {notes.map((note) => (
        <div
          key={note}
          className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300"
        >
          ℹ️ {note}
        </div>
      ))}

      {/* A WARNING, NEVER A BLOCK — the request says so in as many words: some employers file late or
          early on purpose. */}
      {periodOverridden && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {t('periodOverridden', { month: form.contributionMonth, payroll: form.payrollPeriodKey })}
        </div>
      )}

      {summary.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('reconTitle')} />
          <dl className="grid gap-px bg-border sm:grid-cols-4">
            {summary.map((item) => (
              <div key={item.label} className="bg-card p-4">
                <dt className="text-xs text-muted-foreground">{item.label}</dt>
                <dd className="text-sm font-semibold tabular-nums">RM {item.value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      {/* NAMED BEFORE THE DOWNLOAD, NOT DISCOVERED AFTER IT. While either list is non-empty there are no
          download buttons below, and the routes refuse the request as well.

          THREE SEPARATE BANNERS, because they are three different problems fixed in three different
          places: the employer reference is set ONCE under Organization; a member number is fixed on one
          person's own record; and the representative block is a company-level detail that does NOT block
          anything. Merging them would send an operator to the wrong screen. */}
      {headerMissing.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{t('headerMissingTitle')}</p>
          <ul className="mt-1 space-y-0.5">
            {headerMissing.map((f) => (
              <li key={f}>{HEADER_FIELD_LABEL[f] ? t(HEADER_FIELD_LABEL[f] as 'headerField_employerRef') : f}</li>
            ))}
          </ul>
          <p className="mt-1">{t('headerMissingHint')}</p>
        </div>
      )}
      {missing.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{t('missingTitle', { count: missing.length })}</p>
          <ul className="mt-1 space-y-0.5">
            {missing.map((m) => (
              <li key={m.employmentId}>
                {m.name} — {m.missing.join(', ')}
              </li>
            ))}
          </ul>
          <p className="mt-1">{t('missingHint')}</p>
        </div>
      )}
      {/* THE UPLOAD FILE'S OWN, STRICTER LIST. A member number the paper can print may still be one a
          19-digit numeric field cannot carry. Shown separately and only when the paper form is otherwise
          ready, so it reads as "and this stops the file too" rather than repeating the block above. */}
      {ready && !fileReadiness.ok && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{t('fileBlockedTitle')}</p>
          <ul className="mt-1 space-y-0.5">
            {fileReadiness.employer.map((e) => (
              <li key={e}>{e}</li>
            ))}
            {fileReadiness.employees.map((e) => (
              <li key={`${e.employmentId}-${e.problem}`}>
                {e.name} — {e.problem}
              </li>
            ))}
          </ul>
          <p className="mt-1">{t('fileBlockedHint')}</p>
        </div>
      )}
      {/* ADVISORY, NEVER BLOCKING. Production carries this block for one company in nine, and the agency
          does not refuse a form over it — the specimen leaves the representative's own Tarikh blank and
          the form is signed by hand at the counter. */}
      {repMissing.length > 0 && (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <p className="font-medium">{t('repMissingTitle')}</p>
          <p className="mt-1">
            {repMissing
              .map((f) => (REP_FIELD_LABEL[f] ? t(REP_FIELD_LABEL[f] as 'repField_name') : f))
              .join(', ')}
          </p>
          <p className="mt-1">{t('repMissingHint')}</p>
        </div>
      )}

      <Card className="overflow-hidden">
        <SectionHeader title={t('scheduleTitle')} count={form.employees} />

        {/* SIBLING of the filter form above, never nested inside it. Carries its own companyId +
            periodKey so a download always asks for the month that is on screen. */}
        <form method="get" action="/payroll/borang-a/preview">
          <input type="hidden" name="companyId" value={companyId} />
          <input type="hidden" name="periodKey" value={periodKey} />
          <input type="hidden" name="year" value={year} />
          <input type="hidden" name="month" value={month} />

          <div className="flex flex-wrap items-end gap-3 px-4 pt-4">
            <Field label={t('epfPeriod')}>
              {/* READ BY VALUE, never by presence: this box is submitted on every request whether or not
                  it was touched, so `has()` would report an override for everybody. */}
              <input type="month" name="epfPeriod" defaultValue={form.contributionPeriodKey} className={inputCls} />
            </Field>
            <Field label={t('shortCode')}>
              <input
                type="text"
                name="code"
                defaultValue={typeof sp.code === 'string' ? sp.code : ''}
                maxLength={3}
                placeholder="ABC"
                className={`${inputCls} w-24`}
              />
            </Field>
            <Field label={t('batchNo')}>
              <input
                type="text"
                name="batch"
                defaultValue={typeof sp.batch === 'string' ? sp.batch : '1'}
                maxLength={5}
                inputMode="numeric"
                className={`${inputCls} w-24`}
              />
            </Field>
            <Field label={t('controlNo')}>
              <input
                type="text"
                name="control"
                defaultValue={typeof sp.control === 'string' ? sp.control : ''}
                maxLength={9}
                inputMode="numeric"
                placeholder="000000000"
                className={`${inputCls} w-36`}
              />
            </Field>
            <button className={btnGhost}>{t('apply')}</button>
          </div>
          <p className="px-4 pt-2 text-xs text-muted-foreground">{t('inputsHint')}</p>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colBil')}</th>
                  <th className="px-4 py-2 font-medium">{t('colMember')}</th>
                  {/*
                    NO "N K" COLUMN HERE, AND THAT IS DELIBERATE — do not "fix" it. cc9f9420 added the
                    reserved N K column to the PRINTED form (catatan 5: "Ruang ketiga (N K) hanya diisi
                    oleh KWSP sahaja"), where it exists so the sheet has the agency's column count. It is
                    permanently blank. This screen is the REVIEW screen: its whole job is to show what an
                    operator must check before filing, and a column that is empty by law has nothing to
                    review. Adding it here would add a dead column to every row and invite somebody to
                    populate it.
                  */}
                  <th className="px-4 py-2 font-medium">{t('colIc')}</th>
                  <th className="px-4 py-2 font-medium">{t('colName')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colWage')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colEmployer')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colEmployee')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r, i) => (
                  <tr key={r.employmentId}>
                    <td className="px-4 py-2 tabular-nums text-muted-foreground">{i + 1}</td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {r.memberNo || <span className="text-red-600">—</span>}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{r.ic || <span className="text-red-600">—</span>}</td>
                    <td className="px-4 py-2 font-medium">{r.name}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {/* NEVER A FALLBACK TO GROSS. A run that predates the wage-basis stamp says so. */}
                      {r.wageRecorded ? money(r.wage) : <span className="text-red-600">{t('wageNotRecorded')}</span>}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(r.employer)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(r.employee)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                      {t('noEmployees')}
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot className="border-t-2 border-border bg-muted/30 text-sm font-semibold">
                {form.pages.length > 1 &&
                  form.pages.map((p) => (
                    <tr key={p.sheet}>
                      <td colSpan={4} className="px-4 py-2">
                        {t('pageCarry', { sheet: p.sheet, of: p.of })}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{money(p.pageWage)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{money(p.carryOutEmployer)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{money(p.carryOutEmployee)}</td>
                    </tr>
                  ))}
                <tr>
                  <td colSpan={4} className="px-4 py-2">
                    {t('grandTotal')}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(form.totalWage)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(form.totalEmployer)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(form.totalEmployee)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/30 px-4 py-3">
            {/* NO DOWNLOAD BUTTONS AT ALL while somebody is not ready — not disabled ones, which are still
                buttons and still get clicked at. The sentence beside them says why. */}
            {ready ? (
              <>
                <button className={btnPrimary} formAction="/payroll/borang-a/pdf" title={t('downloadPdfTitle')}>
                  {t('downloadPdf')}
                </button>
                <button className={btnGhost} formAction="/payroll/borang-a/text" title={t('downloadTextTitle')}>
                  {t('downloadText')}
                </button>
                {fileReadiness.ok ? (
                  <button className={btnGhost} formAction="/payroll/borang-a/file" title={t('downloadFileTitle')}>
                    {t('downloadFile')}
                  </button>
                ) : (
                  <span className="text-xs italic text-muted-foreground">{t('fileBlocked')}</span>
                )}
              </>
            ) : (
              <span className="text-xs italic text-muted-foreground">{t('downloadsBlocked')}</span>
            )}
          </div>
        </form>
      </Card>
    </div>
  );
}
