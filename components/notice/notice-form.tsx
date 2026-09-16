'use client';

import { useMemo, useState } from 'react';

import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import { MultiSelectPopover } from '@/components/ui/multi-select-popover';
import { Markdown } from '@/components/markdown';
import { Button, Field, inputCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import { matchesEmployeeSearch } from '@/lib/employee-search';
import { resolveEmploymentSelection, type EmployeePickOption } from '@/lib/employment-selection';

type Opt = { value: string; label: string };
type Action = (fd: FormData) => void | Promise<void>;

export type NoticeFormValues = {
  title: string;
  body: string;
  startOn: string;
  endOn: string;
  showEndDate: boolean;
  targetMode: 'criteria' | 'individual';
  criteria: Record<string, string[] | undefined>;
  employmentIds: string[];
  notifyOnPublish: boolean;
  popupEnabled: boolean;
  popupFrequency: 'once' | 'until_acknowledged';
};

export type NoticeFormLabels = {
  sectionBasics: string;
  sectionContent: string;
  sectionAudience: string;
  sectionDelivery: string;
  fTitle: string;
  fStartOn: string;
  fEndOn: string;
  fShowEndDate: string;
  fBody: string;
  fBodyHelp: string;
  write: string;
  preview: string;
  previewEmpty: string;
  byCriteria: string;
  byIndividual: string;
  companies: string;
  departments: string;
  employmentTypes: string;
  /**
   * r288 (8521e160) — the individual-target picker's copy. ELEVEN PLAIN STRINGS, three of them TEMPLATES
   * carrying a `{query}` / `{count}` / `{name}` placeholder that this component substitutes itself.
   *
   * WHY TEMPLATES AND NOT FUNCTIONS. `MultiSelectPopover` takes `selectedCount`, `matchOption` and
   * `emptyLabelFor` as FUNCTIONS, and this component is a client island mounted from a SERVER page — r124
   * took a whole tab down in production by sending a translator closure across exactly that boundary and
   * test/server-client-boundary.test.ts pins the class. So the strings cross as strings and the functions
   * are built on THIS side, which is the same crossing components/attendance/location-assignment.tsx makes
   * with `selectedCountTemplate`.
   */
  employeePicker: string;
  employeeNoneChosen: string;
  employeeSearch: string;
  employeeNoMatchTemplate: string;
  employeeNonePicked: string;
  employeeSelectedCountTemplate: string;
  employeeSelectAll: string;
  employeeClearAll: string;
  employeeRemoveTemplate: string;
  pasteAlternative: string;
  pasteAlternativeHelp: string;
  /** r289 — the FOURTH template: `{list}`, the pasted references nothing recognised, named rather than
   *  silently ignored. Substituted on THIS side of the boundary like the other three. */
  pasteUnmatchedTemplate: string;
  everyoneWarning: string;
  targetingFrozen: string;
  fNotify: string;
  fNotifyHelp: string;
  fPopup: string;
  fPopupFrequency: string;
  popupOnce: string;
  popupUntilAcknowledged: string;
  submit: string;
};

/**
 * 6e122302 — the Notice Board setup flow: what it says, when it runs, who gets it, how it arrives.
 *
 * ⚠️ EVERY PROP IS SERIALISABLE, DELIBERATELY. This is a client component mounted from a SERVER page, and
 * r124 took a whole tab down in production by passing a translator closure across exactly that boundary.
 * So the copy arrives as a plain `labels` object rather than a `t` function, and
 * test/server-client-boundary.test.ts fails if anyone reaches for the shorter route. The `action` prop is
 * the one exception the framework allows: a server action is a reference React knows how to serialise.
 *
 * STATE IS LOCAL AND MINIMAL — the write/preview tab, the targeting mode, and whether any criterion has
 * been touched. Everything else posts as ordinary form fields, so the whole thing is one submit with no
 * client-side orchestration. There is deliberately NO client fetch for the audience count: the count is
 * server-rendered on the saved notice, computed from the criteria that were actually stored, next to the
 * publish button that uses it. A number computed by the browser from a half-filled form is not the number
 * the publish will use, and showing it there would be worse than showing none.
 *
 * NOT HERE, ON PURPOSE (release two): the acknowledgement section. No "require acknowledgement" checkbox,
 * no agreement text, no name fields. Half of an evidence feature is worse than none of it.
 */
export function NoticeForm({
  action,
  values,
  idField,
  companies,
  departments,
  employmentTypes,
  orgCriteria,
  employees,
  targetingFrozen,
  labels,
}: {
  action: Action;
  values: NoticeFormValues;
  /** The notice id, on the EDIT screen only — posted as a hidden field so one form serves create + update. */
  idField?: string;
  companies: Opt[];
  departments: Opt[];
  employmentTypes: Opt[];
  /** The eight org axes, each already resolved to its label and its catalogue options. */
  orgCriteria: { key: string; label: string; options: Opt[] }[];
  /**
   * r288 — every employment the signed-in administrator's companies hold, read once by the server page.
   * REQUIRED, not optional: an optional list defaulting to `[]` would render a picker that silently offers
   * nobody on any page that forgot to pass it, which is the failure this round exists to remove.
   */
  employees: EmployeePickOption[];
  /** True once the notice is published — the audience snapshot is fixed and the step is read-only. */
  targetingFrozen: boolean;
  labels: NoticeFormLabels;
}) {
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [body, setBody] = useState(values.body);
  const [mode, setMode] = useState<'criteria' | 'individual'>(values.targetMode);
  const [anyCriteria, setAnyCriteria] = useState(
    Object.values(values.criteria).some((v) => (v ?? []).length > 0),
  );

  /**
   * ── r288 (8521e160) · PICK INDIVIDUALLY: TWO WAYS IN, ONE LIST OUT ───────────────────────────────────
   *
   * A SAVED notice is split back across the two doors rather than dumped into the paste box: any stored id
   * this administrator can actually see becomes a CHIP, and anything else (an id outside their company
   * scope, or the free text an earlier save let through) stays in the box where it is visible and
   * editable. The union of the two is the stored list, so opening an individual notice and pressing Save
   * without touching the audience stores exactly what was there before — order is not meaningful
   * downstream (`employment.id IN (…)`), and `cleanNotice` de-duplicates on the way in regardless.
   *
   * Dropping the unknown half instead would be the worst option available: it would silently shrink the
   * audience of a notice on a plain Save.
   */
  const known = useMemo(() => new Set(employees.map((e) => e.id)), [employees]);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(values.employmentIds.filter((id) => known.has(id))),
  );
  const [pastedRaw, setPastedRaw] = useState(() =>
    values.employmentIds.filter((id) => !known.has(id)).join('\n'),
  );

  // The row behind an option id, so a chip can show name and Employee ID as two things rather than one
  // pre-joined string, and so the search rule can read the real fields.
  const employeeById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  // "Irwin Tan · EMP-0008" for the popover row, which is a single line of text by construction. Composed
  // on THIS side of the boundary: the server page hands over data, never sentences.
  const employeeOptions = useMemo(
    () => employees.map((e) => ({ id: e.id, name: e.employeeCode ? `${e.name} · ${e.employeeCode}` : e.name })),
    [employees],
  );
  // THE HOUSE RULE, not a second one (lib/employee-search.ts): partial name OR partial Employee ID, folded
  // so "emp0008" finds "EMP-0008" here exactly as it does in the Personnel switcher and on the two leave
  // screens. A picker that prints an Employee ID and cannot find it when typed is a broken promise.
  const matchEmployee = useMemo(
    () => (option: { id: string }, query: string) => {
      const row = employeeById.get(option.id);
      return row ? matchesEmployeeSearch(row, query) : false;
    },
    [employeeById],
  );
  // The chosen rows in the SERVER'S order (listEmployees sorts by full name), so the strip never reshuffles
  // for a reason the operator cannot see. A `Set` is also why the same person cannot be added twice.
  const pickedRows = useMemo(() => employees.filter((e) => picked.has(e.id)), [employees, picked]);
  // THE ONE LIST OUT — the same rule `createNoticeAction` / `updateNoticeAction` run over the same two
  // posted fields (lib/employment-selection.ts). This copy exists only to decide what the screen SAYS.
  //
  // r289 — AND WHAT IT COULD NOT READ. `unmatched` is what lets the box stop failing silently, and this
  // screen is the one that needed it most: `notice.criteria` is a jsonb column, so an unresolvable token
  // SAVES and only dies at Publish. It is a MESSAGE, not a gate — every one of those tokens is still
  // inside `ids` and is still stored, because dropping them on Save would silently shrink the audience of
  // a notice (the same call the known/unknown split above makes, for the same reason).
  const selection = useMemo(
    () => resolveEmploymentSelection([...picked], pastedRaw, employees),
    [picked, pastedRaw, employees],
  );
  const individualIds = selection.ids;
  const unpick = (id: string) => {
    const next = new Set(picked);
    next.delete(id);
    setPicked(next);
  };
  const removeLabel = (name: string) => labels.employeeRemoveTemplate.replace('{name}', name);

  /**
   * r288 — SAVE IS OFF while Pick individually has nobody in it. The reporter's words: Notice Board should
   * "check who you have chosen while you are choosing, not at the end".
   *
   * It was checked at the end, by `cleanNotice` ("Choose at least one employee…"), which meant writing the
   * whole notice first and being refused on submit. Scoped to individual mode on purpose: an EMPTY criteria
   * set legitimately means everyone and has its own warning. Never while `targetingFrozen` — a published
   * notice posts no audience at all and its Save must keep working for a typo fix.
   */
  const audienceBlocked = !targetingFrozen && mode === 'individual' && individualIds.length === 0;

  return (
    <form action={action} className="space-y-6">
      {idField && <input type="hidden" name="id" value={idField} />}
      {/* ── Section 1 — basic information ──────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {labels.sectionBasics}
        </span>
        <Field label={labels.fTitle}>
          <input
            name="title"
            type="text"
            required
            maxLength={200}
            defaultValue={values.title}
            className={cn(inputCls, 'w-full')}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={labels.fStartOn}>
            <input name="startOn" type="date" required defaultValue={values.startOn} className={cn(inputCls, 'w-full')} />
          </Field>
          <Field label={labels.fEndOn}>
            <input name="endOn" type="date" required defaultValue={values.endOn} className={cn(inputCls, 'w-full')} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            name="showEndDate"
            defaultChecked={values.showEndDate}
            className="size-3.5 border-border"
          />
          {labels.fShowEndDate}
        </label>
      </section>

      {/* ── Section 2 — content ────────────────────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {labels.sectionContent}
        </span>
        <div className="flex gap-1">
          {(['write', 'preview'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium',
                tab === k ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {k === 'write' ? labels.write : labels.preview}
            </button>
          ))}
        </div>
        {/* The textarea stays MOUNTED in both tabs (hidden, not unmounted) so switching to Preview never
            drops what was typed out of the form payload. */}
        <div className={tab === 'write' ? undefined : 'hidden'}>
          <Field label={labels.fBody}>
            <textarea
              name="body"
              rows={12}
              required
              value={body}
              onChange={(e) => setBody(e.currentTarget.value)}
              className={cn(inputCls, 'w-full font-mono text-xs')}
            />
          </Field>
          <p className="mt-1 text-xs text-muted-foreground">{labels.fBodyHelp}</p>
        </div>
        {tab === 'preview' && (
          <div className="rounded-lg border border-border bg-card p-4">
            {body.trim() ? <Markdown>{body}</Markdown> : <p className="text-xs text-muted-foreground">{labels.previewEmpty}</p>}
          </div>
        )}
      </section>

      {/* ── Section 3 — who gets it ────────────────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {labels.sectionAudience}
        </span>
        {targetingFrozen ? (
          // A published notice's audience is the SNAPSHOT that was taken; re-targeting it would silently
          // add or remove people under an announcement others have already read. Said out loud rather than
          // silently ignored, because a control that appears to work and does nothing is worse.
          <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{labels.targetingFrozen}</p>
        ) : (
          <>
            <input type="hidden" name="targetMode" value={mode} />
            <div className="flex flex-wrap gap-4">
              {(['criteria', 'individual'] as const).map((m) => (
                <label key={m} className="flex items-center gap-2 text-xs text-foreground">
                  <input
                    type="radio"
                    name="targetModeRadio"
                    checked={mode === m}
                    onChange={() => setMode(m)}
                    className="size-3.5 border-border"
                  />
                  {m === 'criteria' ? labels.byCriteria : labels.byIndividual}
                </label>
              ))}
            </div>

            {mode === 'criteria' ? (
              <div className="space-y-3" onChange={() => setAnyCriteria(true)}>
                {/* "Posting Company: All Companies / Selected Companies" IS this field — leaving it empty
                    means every company. One vocabulary, so there is no second company-scope control that
                    could disagree with the criteria. */}
                <ChipMultiSelect
                  name="companyIds"
                  label={labels.companies}
                  options={companies}
                  defaultSelected={values.criteria.companyIds ?? []}
                  addPlaceholder={labels.companies}
                  removeLabelFor={(label) => label}
                />
                <ChipMultiSelect
                  name="departmentIds"
                  label={labels.departments}
                  options={departments}
                  defaultSelected={values.criteria.departmentIds ?? []}
                  addPlaceholder={labels.departments}
                  removeLabelFor={(label) => label}
                />
                <ChipMultiSelect
                  name="employmentTypes"
                  label={labels.employmentTypes}
                  options={employmentTypes}
                  defaultSelected={values.criteria.employmentTypes ?? []}
                  addPlaceholder={labels.employmentTypes}
                  removeLabelFor={(label) => label}
                />
                {orgCriteria.map((c) => (
                  <ChipMultiSelect
                    key={c.key}
                    name={c.key}
                    label={c.label}
                    options={c.options}
                    defaultSelected={values.criteria[c.key] ?? []}
                    addPlaceholder={c.label}
                    removeLabelFor={(label) => label}
                  />
                ))}
                {/* THE ACCIDENT THIS EXISTS TO PREVENT: an empty criteria set legitimately means everyone,
                    and the resolver cannot tell that apart from a form nobody finished. The saved notice
                    then shows the resolved headcount before anything is published. */}
                {!anyCriteria && (
                  <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                    {labels.everyoneWarning}
                  </p>
                )}
              </div>
            ) : (
              /**
               * r288 (8521e160) — PICK INDIVIDUALLY IS A PICKER HERE TOO. TWO WAYS IN, ONE LIST OUT.
               *
               * WHAT WAS HERE: this box alone, under a help string inviting a paste of "employee
               * references". Typing a name into it did NOT fail at Save, which is what the ticket said and
               * what a reading of `createNotice` suggests — `notice.criteria` is a **jsonb** column, so
               * `cleanNotice` stores "Irwin" quite happily. The draft page then reports a reach of ONE
               * EMPLOYEE (it counts the stored strings), the publish confirmation repeats that number, and
               * `publishNotice` is where it finally dies, on `employment.id IN (…)` against a **uuid**
               * column. Verified against a real database, not reasoned about
               * (test/r288-employee-pickers.test.ts §A): the failure lands at PUBLISH, one step later and
               * one step worse than reported.
               *
               * THE PICKER IS THE HOUSE ONE, AND IT IS r287's, NOT A FOURTH. `MultiSelectPopover` with the
               * two opt-in props that round added — `matchOption` (the house `matchesEmployeeSearch`) and
               * `emptyLabelFor` (a search that finds nobody must SAY SO and name what was searched). Its
               * form contract does the rest: one hidden `employmentIds` input per chosen id, rendered
               * OUTSIDE its open/closed guard, so what is posted survives the panel closing before submit.
               *
               * THE PASTE BOX STAYS. It is how a bulk audience is set up today and deleting it would be an
               * unrequested regression. Both fields are merged by ONE shared rule
               * (`lib/employment-selection.ts`) that `inputFrom` runs on the server for create AND update.
               */
              <div className="space-y-3">
                <MultiSelectPopover
                  name="employmentIds"
                  label={labels.employeePicker}
                  allLabel={labels.employeeNoneChosen}
                  options={employeeOptions}
                  selected={picked}
                  onChange={setPicked}
                  searchPlaceholder={labels.employeeSearch}
                  selectAllLabel={labels.employeeSelectAll}
                  clearAllLabel={labels.employeeClearAll}
                  selectedCount={(n) => labels.employeeSelectedCountTemplate.replace('{count}', String(n))}
                  matchOption={matchEmployee}
                  // THE TERMINAL STATE THE COMPLAINT IS ABOUT: a search that finds nobody says so, and
                  // names what was searched. An empty panel asserts nothing (CLAUDE.md §8).
                  emptyLabelFor={(query) => labels.employeeNoMatchTemplate.replace('{query}', query)}
                />
                {pickedRows.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {pickedRows.map((e) => {
                      const chipLabel = e.employeeCode ? `${e.name} · ${e.employeeCode}` : e.name;
                      return (
                        <span
                          key={e.id}
                          className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary"
                        >
                          {chipLabel}
                          <button
                            type="button"
                            aria-label={removeLabel(chipLabel)}
                            title={removeLabel(chipLabel)}
                            onClick={() => unpick(e.id)}
                            className="grid size-4 shrink-0 place-items-center rounded-full text-primary/70 transition-colors hover:bg-primary/20 hover:text-primary"
                          >
                            ×
                          </button>
                        </span>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-lg bg-muted px-3 py-2 text-[11px] text-muted-foreground">
                    {labels.employeeNonePicked}
                  </p>
                )}
                <Field label={labels.pasteAlternative}>
                  {/* Controlled, so the Save button moves on the keystroke. The field name and what the
                      server does with it are UNCHANGED — this round changed the control, not the contract. */}
                  <textarea
                    name="employmentIdsRaw"
                    rows={3}
                    value={pastedRaw}
                    onChange={(e) => setPastedRaw(e.currentTarget.value)}
                    className={cn(inputCls, 'w-full font-mono text-xs')}
                  />
                  <p className="pt-1 text-[11px] text-muted-foreground">{labels.pasteAlternativeHelp}</p>
                  {/* r289 — WHAT WE COULD NOT READ, NAMED. Rendered only when there is something to say, so
                      a clean paste stays quiet. It is a sentence, never a block: the notice still saves and
                      these tokens are still stored, they simply no longer count towards the stated reach. */}
                  {selection.unmatched.length > 0 && (
                    <p className="pt-1 text-[11px] font-medium text-destructive">
                      {labels.pasteUnmatchedTemplate.replace('{list}', selection.unmatched.join(', '))}
                    </p>
                  )}
                </Field>
              </div>
            )}
          </>
        )}
      </section>

      {/* ── Section 4 — how it arrives ─────────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {labels.sectionDelivery}
        </span>
        <label className="flex items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            name="notifyOnPublish"
            defaultChecked={values.notifyOnPublish}
            className="size-3.5 border-border"
          />
          {labels.fNotify}
        </label>
        <p className="text-xs text-muted-foreground">{labels.fNotifyHelp}</p>
        <label className="flex items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            name="popupEnabled"
            defaultChecked={values.popupEnabled}
            className="size-3.5 border-border"
          />
          {labels.fPopup}
        </label>
        <Field label={labels.fPopupFrequency}>
          <select
            name="popupFrequency"
            defaultValue={values.popupFrequency}
            className={cn(inputCls, 'w-full')}
          >
            <option value="once">{labels.popupOnce}</option>
            <option value="until_acknowledged">{labels.popupUntilAcknowledged}</option>
          </select>
        </Field>
      </section>

      {/* r288 — Save is OFF, and SAYS WHY, while Pick individually holds nobody. `cleanNotice` refuses the
          same thing server-side and stays the authority; this is the half that tells the operator before
          they have written the whole notice rather than after. */}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={audienceBlocked}>
          {labels.submit}
        </Button>
        {audienceBlocked && (
          <span className="text-[11px] text-muted-foreground">{labels.employeeNonePicked}</span>
        )}
      </div>
    </form>
  );
}
