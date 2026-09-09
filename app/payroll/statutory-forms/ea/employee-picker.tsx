'use client';

import { useMemo, useState } from 'react';
import { Field, btnPrimary, inputCls } from '@/components/ui';
import { filterEaRows } from './filter';

/**
 * r256 (item 858a1128) — STEP TWO OF THE C.P.8A (EA): WHO the forms are for.
 *
 * An EA is one statement per person, so "generate the EA for ABC Sdn Bhd 2026" is not a document — it is
 * forty documents. The reporter asked for the list, a search on name AND on employee ID, a select-all and
 * a clear, and the ability to generate for one person or many. This is that, and it is the ONLY part of
 * the flow that needs client state.
 *
 * EVERY STRING ARRIVES PRE-TRANSLATED. The page resolves them from two namespaces (`payroll.statutoryForms`
 * for the screen, `people.employeeStatus` for the status badges) and hands them down as plain data: a
 * client component with two namespaces is a file test/i18n-coverage.test.ts Check C skips entirely.
 *
 * ⚠️ THE SELECTION IS SUBMITTED AS HIDDEN INPUTS, NOT AS THE VISIBLE CHECKBOXES. The two search boxes
 * REMOVE rows from the DOM, and a checked checkbox that is no longer rendered is a checkbox the browser
 * does not submit — so searching for "Lim", ticking two people, then searching for "Tan" and ticking a
 * third would have generated one EA instead of three, silently. The tick boxes drive state; the state
 * drives one hidden input per selected id, rendered whatever the search shows.
 *
 * IT SUBMITS AS A GET, so the download route reads plain search params and the result is a normal file
 * response. Nothing here posts, and nothing here generates: the route does, when this button is pressed.
 */
export type EaPickerRow = {
  employmentId: string;
  name: string;
  code: string;
  department: string;
  /** Derived lifecycle status, already labelled in the viewer's language. */
  statusLabel: string;
  /** The raw status key, for the badge colour only. */
  status: string;
};

export type EaPickerStrings = {
  searchName: string;
  searchNamePlaceholder: string;
  searchCode: string;
  searchCodePlaceholder: string;
  selectAll: string;
  clear: string;
  /** "{count} selected", with `{count}` still in it — the count changes as boxes are ticked, so the
   *  page cannot interpolate it on the server. The ONE placeholder this component fills in itself. */
  selectedTemplate: string;
  generate: string;
  colSelect: string;
  colCode: string;
  colName: string;
  colDepartment: string;
  colStatus: string;
  noMatch: string;
};

const STATUS_CLS: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  active_serving_notice: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  probation: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300',
  resigned: 'bg-muted text-muted-foreground',
  blacklisted: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  withhold: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
};

export function EaEmployeePicker({
  rows,
  action,
  hidden,
  strings,
}: {
  rows: EaPickerRow[];
  /** The download route. A plain href — never a callback: a closure crossing this boundary 500s. */
  action: string;
  /** companyId / year / lang, carried through unchanged. */
  hidden: { name: string; value: string }[];
  strings: EaPickerStrings;
}) {
  const [nameQuery, setNameQuery] = useState('');
  const [codeQuery, setCodeQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  // The matching itself lives in `./filter` — pure, so test/statutory-forms-criteria-858a1128.test.ts can
  // run it over rows and prove the employee-ID box really matches on the employee ID. A predicate written
  // inline here would only ever be checked by reading it.
  const visible = useMemo(
    () => filterEaRows(rows, { name: nameQuery, code: codeQuery }),
    [rows, nameQuery, codeQuery],
  );

  const chosen = new Set(selected);
  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  // Select all applies to WHAT IS ON SCREEN, added to whatever is already chosen — the button sits under
  // two search boxes, and "select all" that silently reached past the filter would tick people the
  // operator cannot see.
  const selectAllVisible = () =>
    setSelected((prev) => [...new Set([...prev, ...visible.map((r) => r.employmentId)])]);

  return (
    <form method="get" action={action} className="space-y-4">
      {hidden.map((h) => (
        <input key={h.name} type="hidden" name={h.name} value={h.value} />
      ))}
      {/* THE SELECTION ITSELF — one per chosen person, rendered whatever the search is showing. */}
      {selected.map((id) => (
        <input key={id} type="hidden" name="id" value={id} />
      ))}

      <div className="flex flex-wrap items-end gap-3">
        <Field label={strings.searchName} className="w-full sm:w-64">
          <input
            type="search"
            value={nameQuery}
            onChange={(e) => setNameQuery(e.target.value)}
            maxLength={80}
            placeholder={strings.searchNamePlaceholder}
            className={inputCls}
          />
        </Field>
        <Field label={strings.searchCode} className="w-full sm:w-48">
          <input
            type="search"
            value={codeQuery}
            onChange={(e) => setCodeQuery(e.target.value)}
            maxLength={40}
            placeholder={strings.searchCodePlaceholder}
            className={inputCls}
          />
        </Field>
        <button
          type="button"
          onClick={selectAllVisible}
          className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent"
        >
          {strings.selectAll}
        </button>
        <button
          type="button"
          onClick={() => setSelected([])}
          className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent"
        >
          {strings.clear}
        </button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">
                <span className="sr-only">{strings.colSelect}</span>
              </th>
              <th className="px-3 py-2 font-medium">{strings.colCode}</th>
              <th className="px-3 py-2 font-medium">{strings.colName}</th>
              <th className="px-3 py-2 font-medium">{strings.colDepartment}</th>
              <th className="px-3 py-2 font-medium">{strings.colStatus}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {strings.noMatch}
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr key={r.employmentId} className={chosen.has(r.employmentId) ? 'bg-primary/5' : undefined}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={r.name}
                      checked={chosen.has(r.employmentId)}
                      onChange={() => toggle(r.employmentId)}
                      className="h-4 w-4 rounded border-border"
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.code || '—'}</td>
                  <td className="px-3 py-2 font-medium">{r.name}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.department || '—'}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        STATUS_CLS[r.status] ?? 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {r.statusLabel}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{strings.selectedTemplate.replace('{count}', String(selected.length))}</span>
        {/* Nothing selected is nothing to produce, so the button cannot be pressed — an empty EA download
            is not a useful answer and the route refuses it a second time. */}
        <button className={btnPrimary} disabled={selected.length === 0}>
          {strings.generate}
        </button>
      </div>
    </form>
  );
}
