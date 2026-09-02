import Link from 'next/link';
import { Card, SectionHeader } from '@/components/ui';
import type { ReportResult } from '@/localization/country-pack';

/**
 * The body of a generated statutory report: its caveats, its headline figures, the employees who would
 * go up INCOMPLETE, the money totals, and the table itself.
 *
 * LIFTED, NOT COPIED (6babf4f6). This markup was inline in app/payroll/reports/page.tsx and the redesign
 * needs the identical thing on the new per-form screen. Copying it would have produced two tables that
 * drift — one gaining a column, one keeping the red "missing field" cell — for figures that are supposed
 * to be the same figures. The generator was never duplicated (241817ef spent two rounds undoing that
 * kind of duplication); its presentation should not be either.
 *
 * EVERY PROP IS PLAIN DATA, AND THE CAPTIONS ARRIVE PRE-TRANSLATED. Two screens in two namespaces render
 * this (`payroll.reports` and `payroll.statutoryForms`), so resolving the words here would make it a
 * multi-namespace file — the exact shape check C of test/i18n-coverage.test.ts skips entirely, static
 * keys included. No callback and no closure either: a function prop crossing from a server component to
 * a client one returns a 500 on every request while tsc, the suite and `next build` all stay green.
 *
 * `eaYear` IS OPTIONAL AND MEANS SOMETHING. When set, an employee name in the table links to that
 * person's EA statement for the year — which is the ONLY route to a per-employee EA, since an EA is one
 * statement per person and never a company-wide table. Omit it and names render as plain text.
 *
 * `eaLang` IS OPTIONAL TOO, AND CHANGES WHERE THAT NAME GOES (587ee719). Unset — every arrival before
 * this round, and every arrival from Reports — the name opens the on-screen EA statement, in the viewer's
 * own language, exactly as before. Set, the caller came from a shelf entry that names a LANGUAGE ("EA —
 * Bahasa Malaysia"), and the thing that entry promises is the statement in that language: so the name
 * hands over the PDF with `lang` on it, which is the only artefact that can honour the promise. Still a
 * plain href and still no second EA renderer — the route resolves `payroll.ea` for the named locale.
 */
export type StatutoryReportPanelStrings = {
  /** Card heading, e.g. "EPF contributions (KWSP) — 2026-07". */
  heading: string;
  /** Already interpolated with the count, e.g. "3 employees are missing a required number". */
  readinessTitle: string;
  /** Shown in place of the table body when the period produced no payslips. */
  noRows: string;
};

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function StatutoryReportPanel({
  result,
  strings,
  eaYear,
  eaLang,
  actions,
}: {
  result: ReportResult;
  strings: StatutoryReportPanelStrings;
  /** Year (YYYY) to link employee names to their EA statement, or null for plain names. */
  eaYear?: string | null;
  /** 587ee719 — 'en' / 'ms' to hand over the EA PDF pinned to that language; null for the usual screen. */
  eaLang?: 'en' | 'ms' | null;
  /** Download / print / record controls — owned by the screen, which knows what it can produce. */
  actions?: React.ReactNode;
}) {
  return (
    <>
      {result.meta.notes?.map((note, i) => (
        <div
          key={i}
          className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300"
        >
          ℹ️ {note}
        </div>
      ))}

      {result.meta.summary && result.meta.summary.length > 0 && (
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
          {result.meta.summary.map((sItem) => (
            <div key={sItem.label} className="bg-card p-4">
              <div className="text-xs text-muted-foreground">{sItem.label}</div>
              <div className="text-lg font-semibold tabular-nums">{sItem.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Named, not counted. A submission that silently omits three people is the failure this banner
          exists to prevent, and "3 employees" without their names is not actionable. */}
      {result.readiness.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          <div className="font-medium">{strings.readinessTitle}</div>
          <ul className="mt-1 list-inside list-disc text-xs">
            {result.readiness.map((r) => (
              <li key={r.employmentId}>
                {r.name} — {r.missing.join(', ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 lg:grid-cols-5">
        {result.columns
          .filter((c) => c.numeric)
          .map((c) => (
            <div key={c.key} className="bg-card p-4">
              <div className="text-xs text-muted-foreground">{c.label}</div>
              <div className="text-lg font-semibold tabular-nums">{rm(result.totals[c.key])}</div>
            </div>
          ))}
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <SectionHeader title={strings.heading} count={result.rows.length} />
          {actions && <div className="flex flex-wrap items-center gap-2 print:hidden">{actions}</div>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {result.columns.map((c) => (
                  <th key={c.key} className={`px-4 py-2 font-medium ${c.numeric ? 'text-right' : ''}`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {result.rows.map((row, i) => (
                <tr key={i}>
                  {result.columns.map((c) => (
                    <td
                      key={c.key}
                      className={`px-4 py-2.5 ${c.numeric ? 'text-right tabular-nums' : ''} ${
                        row[c.key] == null || row[c.key] === '' ? 'text-red-500' : ''
                      }`}
                    >
                      {c.numeric ? (
                        rm(row[c.key])
                      ) : c.key === 'name' && row.employmentId && eaYear ? (
                        <Link
                          href={
                            /* ⚠️ r242 — BOTH ARRIVALS NOW END ON SCREEN, and the language rides along.
                               587ee719 made an EA-shelf arrival hand back the PDF directly, which was
                               right when the shelf's only promise was "the form". b36a8a91 changed that
                               promise: "Open Form … takes you to the employee list and then straight into
                               that person's completed EA. Nothing downloads when you press it." A name
                               that downloads also puts the round's own readiness panel out of reach of
                               the entry point the round renamed. The language is not lost — it is carried
                               into the statement, which offers the PDF in that language. */
                            eaLang
                              ? `/payroll/reports/ea/${row.employmentId}?year=${eaYear}&lang=${eaLang}`
                              : `/payroll/reports/ea/${row.employmentId}?year=${eaYear}`
                          }
                          className="text-primary hover:underline"
                        >
                          {row.name as string}
                        </Link>
                      ) : (
                        (row[c.key] as string) || (c.key === 'name' ? '' : '—')
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              {result.rows.length === 0 && (
                <tr>
                  <td colSpan={result.columns.length} className="px-4 py-8 text-center text-muted-foreground">
                    {strings.noRows}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
