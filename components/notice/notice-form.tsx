'use client';

import { useState } from 'react';

import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import { Markdown } from '@/components/markdown';
import { Button, Field, inputCls } from '@/components/ui';
import { cn } from '@/lib/utils';

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
  employmentIds: string;
  employmentIdsHelp: string;
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
              <Field label={labels.employmentIds}>
                <textarea
                  name="employmentIdsRaw"
                  rows={3}
                  defaultValue={values.employmentIds.join('\n')}
                  className={cn(inputCls, 'w-full')}
                  placeholder={labels.employmentIdsHelp}
                />
              </Field>
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

      <Button type="submit" size="sm">
        {labels.submit}
      </Button>
    </form>
  );
}
