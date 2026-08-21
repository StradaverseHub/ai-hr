import { getLocale, getTranslations } from 'next-intl/server';
import { listCompanies } from '@/core/read';
import { scopedAdmin } from '@/lib/scope';
import { BORANG_8A_STATUS_PARAM_PREFIX, money } from '@/lib/borang-8a';
import { todayInKualaLumpur, yearOptions } from '@/lib/hr-date';
import { Card, Field, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { loadBorang8A } from '../shared';
import { Borang8AMycoidNotice, Borang8AUnfinishedNames } from '../notices';
import { isUnfinishedPersonName } from '@/lib/unfinished-name';

/**
 * 8ca344bf — the Borang 8A review screen: pick a processed payroll month, check the form, then download it.
 *
 * "SHOW ME A REVIEW SCREEN FIRST, NAMING ANYONE MISSING AN IDENTITY CARD NUMBER BEFORE ANYTHING CAN BE
 * DOWNLOADED, AND LET ME TYPE A STATUS AGAINST ANY ROW." That is the item, and it is why this screen exists
 * beside the generic [formId] figures screen rather than instead of it. The generic screen renders any
 * form's table and can render this one; what it cannot do is carry a per-row input, because it does not
 * know what a Borang 8A is. So the shelf card opens the figures screen as every other form does, and the
 * figures screen hands you this one for the document itself.
 *
 * GET-DRIVEN, NO CLIENT STATE, NO SERVER ACTION — the r191 CP22 review screen's shape. The typed statuses
 * travel in the query string, so the reviewed form is a URL: it re-opens, bookmarks, sends to a colleague,
 * and the back button works. It also means this file is a server component with no interactivity to hand
 * across the boundary, so no closure ever reaches a client component (the 500-on-every-request trap).
 *
 * TWO SIBLING FORMS, NEVER NESTED. A form inside a form is invalid HTML and browsers drop the inner one,
 * which would silently turn the download buttons into a second "Show". The filter form owns company / year
 * / month; the schedule form owns the typed statuses and the two downloads, and carries its own hidden
 * companyId + periodKey for exactly that reason.
 *
 * THE READINESS GATE IS ENFORCED TWICE, AND THAT IS NOT BELT-AND-BRACES. This screen hides the download
 * buttons while anyone is missing an IC; `loadBorang8A` refuses to produce the document at all. Hiding a
 * button is a UI courtesy — a bookmarked download URL would sail straight past it.
 *
 * GATED LIKE ITS SIBLING ROUTES: `scopedAdmin`, not `isAdmin` — an hr_admin grant on ANY company makes
 * `isAdmin` true, and this screen lists every employee's name, IC and contribution. Registered in the
 * function-access matrix under `statutoryForms` (lib/permissions.ts): a guarded page.tsx with no column
 * fails test/function-access.test.ts rather than becoming a screen nobody can grant or revoke.
 */
export const dynamic = 'force-dynamic';

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

/**
 * The header fields an operator can actually go and fill in, named in their language.
 *
 * A PARTIAL MAP, DELIBERATELY. `missingBorang8AHeader` also reports the computed fields (the contribution
 * month, the deadline, the two period keys), which cannot be blank in practice and which nobody can "go
 * and set" if they somehow are. Those fall through to the raw key rather than being given a reassuring
 * label that would send somebody looking for a field that does not exist on any screen.
 */
const HEADER_FIELD_LABEL: Record<string, string> = {
  employerCode: 'headerField_employerCode',
  employerName: 'headerField_employerName',
};

/** Default to the month just ENDED — the one whose Borang 8A is actually open. Same rule as the shelf. */
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

export default async function Borang8APreviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const t = await getTranslations('payroll.borang8a');
  const locale = await getLocale();
  const sp = await searchParams;

  const { s, scopeIds } = await scopedAdmin();
  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt && scopeIds.includes(c.id));
  // An out-of-scope companyId in the URL falls back to the first company this admin CAN administer rather
  // than being honoured — the same rule the [formId] screen and the download routes apply, so the three
  // cannot disagree about which company is being looked at.
  const requested = typeof sp.companyId === 'string' && scopeIds.includes(sp.companyId) ? sp.companyId : '';
  const companyId = requested || companies[0]?.id || '';

  const today = todayInKualaLumpur();
  const spPeriod = typeof sp.periodKey === 'string' ? sp.periodKey : '';
  const fallback = /^\d{4}-\d{2}$/.test(spPeriod) ? spPeriod : previousMonth(today);
  const year = typeof sp.year === 'string' && /^\d{4}$/.test(sp.year) ? sp.year : fallback.slice(0, 4);
  const month = MONTHS.includes(sp.month as (typeof MONTHS)[number]) ? (sp.month as string) : fallback.slice(5, 7);
  const periodKey = `${year}-${month}`;
  // Always includes the selected year, so an older link cannot resolve correctly while the select silently
  // shows a different one beside the figures.
  const years = yearOptions(today, year);
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const monthName = (mm: string) => monthFmt.format(new Date(Date.UTC(2000, Number(mm) - 1, 1)));
  const periodLabel = `${monthName(month)} ${year}`;
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';

  // `includeIncomplete` — this screen must be able to RENDER the table in order to name who is missing an
  // IC. The download routes call the same function without it and are refused.
  const loaded = companyId
    ? await loadBorang8A({ companyId, periodKey, query: toQuery(sp), includeIncomplete: true })
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
      back={{ href: `/payroll/statutory-forms?companyId=${encodeURIComponent(companyId)}&body=perkeso`, label: t('back') }}
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

  const { form, missing, headerMissing, summary, notes } = loaded;
  // TWO KINDS OF GAP, ONE GATE — and the employer-level one is why this screen must render at all when a
  // gap exists. `borang8AFrom` used to throw on a blank employer code, so a company that had simply never
  // filled it in got a 500 on the screen whose whole job is to say what is missing. Found by rendering it.
  const ready = missing.length === 0 && headerMissing.length === 0;
  const rows = form.pages.flatMap((p) => p.rows);

  return (
    <div className="mx-auto max-w-[100rem] space-y-6">
      {header}
      {provenance}
      {filter}

      {/* The two dating rules, stated where the form is produced. They are the two facts most likely to be
          "corrected" into the EPF rule by somebody comparing the two forms. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
        <div className="bg-card p-4">
          <div className="text-xs text-muted-foreground">{t('tileMonth')}</div>
          <div className="text-lg font-semibold">{form.contributionMonth}</div>
          <div className="text-xs text-muted-foreground">{t('tileMonthHint')}</div>
        </div>
        <div className="bg-card p-4">
          <div className="text-xs text-muted-foreground">{t('tileDue')}</div>
          <div className="font-mono text-lg font-semibold">{form.paymentDueDate}</div>
          <div className="text-xs text-muted-foreground">{t('tileDueHint')}</div>
        </div>
        <div className="bg-card p-4">
          <div className="text-xs text-muted-foreground">{t('tileEmployees')}</div>
          <div className="text-lg font-semibold tabular-nums">{form.employees}</div>
          <div className="text-xs text-muted-foreground">{t('tileSheets', { count: form.pages.length })}</div>
        </div>
        <div className="bg-card p-4">
          <div className="text-xs text-muted-foreground">{t('tileTotal')}</div>
          <div className="text-lg font-semibold tabular-nums">RM {money(form.total)}</div>
          <div className="text-xs text-muted-foreground">
            {t('tileEmployerCode', { code: form.employerCode || '—' })}
          </div>
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

      {/* The reconciliation strip the build notes asked for: the run's own SOCSO total beside the form's,
          with what this form deliberately does NOT carry named rather than silently dropped. */}
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

          TWO SEPARATE BANNERS, because they are two different problems fixed in two different places: the
          employer code is set ONCE under Organization and its absence gaps every page at once, while an
          identity card number is fixed on one person's own record. Merging them into a single list would
          send an operator to the wrong screen. */}
      {headerMissing.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{t('headerMissingTitle')}</p>
          <ul className="mt-1 space-y-0.5">
            {headerMissing.map((f) => (
              <li key={f}>{HEADER_FIELD_LABEL[f] ? t(HEADER_FIELD_LABEL[f] as 'headerField_employerCode') : f}</li>
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
              <li key={m.employmentId}>{m.name}</li>
            ))}
          </ul>
          <p className="mt-1">{t('missingHint')}</p>
        </div>
      )}

      <Card className="overflow-hidden">
        <SectionHeader title={t('scheduleTitle')} count={form.employees} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('statusHint')}</p>

        {/* SIBLING of the filter form above, never nested inside it. Carries its own companyId + periodKey
            so a download always asks for the month that is on screen. */}
        <form method="get" action="/payroll/borang-8a/preview">
          <input type="hidden" name="companyId" value={companyId} />
          <input type="hidden" name="periodKey" value={periodKey} />

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colStart')}</th>
                  <th className="px-4 py-2 font-medium">{t('colStop')}</th>
                  <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                  <th className="px-4 py-2 font-medium">{t('colIc')}</th>
                  <th className="px-4 py-2 font-medium">{t('colName')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colContribution')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.employmentId}>
                    <td className="px-4 py-2 font-mono text-xs">{r.startDate || '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs">{r.stopDate || '—'}</td>
                    <td className="px-4 py-2">
                      {/* ALWAYS SUBMITTED, EVEN WHEN EMPTY — which is exactly why the loader reads these by
                          VALUE and never by presence. An empty box means "no status", not "status: yes". */}
                      <input
                        type="text"
                        name={`${BORANG_8A_STATUS_PARAM_PREFIX}${r.employmentId}`}
                        defaultValue={r.status}
                        maxLength={12}
                        placeholder={t('statusPlaceholder')}
                        aria-label={t('statusAria', { name: r.name })}
                        className={`${inputCls} h-8 w-28 text-xs`}
                      />
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{r.ic || <span className="text-red-600">—</span>}</td>
                    <td className="px-4 py-2 font-medium">{r.name}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(r.contribution)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                      {t('noEmployees')}
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot className="border-t-2 border-border bg-muted/30 text-sm font-semibold">
                {form.pages.map((p) => (
                  <tr key={p.sheet}>
                    <td colSpan={5} className="px-4 py-2">
                      {t('pageTotal', { sheet: p.sheet, of: p.of })}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(p.pageTotal)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={5} className="px-4 py-2">
                    {t('grandTotal')}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(form.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/30 px-4 py-3">
            <button className={btnGhost}>{t('apply')}</button>
            {/* NO DOWNLOAD BUTTONS AT ALL while somebody is missing an IC — not disabled ones, which are
                still buttons and still get clicked at. The sentence beside them says why. */}
            {ready ? (
              <>
                <button className={btnPrimary} formAction="/payroll/borang-8a/pdf" title={t('downloadPdfTitle')}>
                  {t('downloadPdf')}
                </button>
                <button className={btnGhost} formAction="/payroll/borang-8a/text" title={t('downloadTextTitle')}>
                  {t('downloadText')}
                </button>
                {/* 18c1d92b — the PERKESO ASSIST upload file. A THIRD button rather than a mode on the
                    text one: the two produce different bytes for different readers, and an operator who
                    downloads the wrong one finds out at the portal. The route refuses before it offers
                    anything, so this is not gated separately here — the paper form's readiness gate above
                    is the same gate the file's own loader starts from. */}
                <button className={btnGhost} formAction="/payroll/borang-8a/file" title={t('downloadFileTitle')}>
                  {t('downloadFile')}
                </button>
                {/* The same route asked for the field-by-field check instead of the file.
                    ⚠️ `report=1` IS THE BUTTON'S OWN name/value, NOT a query string on formAction and NOT
                    a hidden input, and both alternatives are wrong here for opposite reasons. This form is
                    method="get", so per the HTML spec the browser DISCARDS the action URL's query string
                    and rebuilds it from the fields — `formAction=".../file?report=1"` would silently hand
                    over the FILE. And a hidden input is submitted by every button in the form (the
                    presence-is-a-value trap), so the two download buttons above would start returning the
                    report. A submit button's name/value pair is sent only when THAT button submits. */}
                <button
                  className={btnGhost}
                  formAction="/payroll/borang-8a/file"
                  formTarget="_blank"
                  name="report"
                  value="1"
                  title={t('checkFileTitle')}
                >
                  {t('checkFile')}
                </button>
              </>
            ) : (
              <span className="text-xs italic text-muted-foreground">{t('downloadsBlocked')}</span>
            )}
            {/* 5dbce839 — the MyCoID box, when it is going out empty. Beside the buttons that produce the
                file and NOT a gate on them: the specification marks the field optional, so refusing the
                download would be wrong, and `missingBorang8AHeader` keeps mycoid out of the blocking set
                for exactly that reason. The whole condition lives in the component, which is what lets
                both halves of it be a render rather than a source scan. */}
            <Borang8AMycoidNotice mycoid={form.mycoid} title={t('mycoidNoticeTitle')} body={t('mycoidNoticeBody')} />
            {/* r218 — and the names those records carry. Same place, same standing, same reason: what
                goes INTO the file is as much a filing question as whether the boxes line up, and a
                placeholder name pads exactly like a person's. The CP39 has carried this warning since
                7ee14bbc; the rule is shared so the two screens cannot disagree. */}
            <Borang8AUnfinishedNames
              people={form.pages
                .flatMap((pg) => pg.rows)
                .filter((r) => isUnfinishedPersonName(r.name))
                .map((r) => ({ ic: r.ic, name: r.name }))}
              title={t('unfinishedNameTitle')}
              hint={t('unfinishedNameHint')}
            />
          </div>
        </form>
      </Card>
    </div>
  );
}
