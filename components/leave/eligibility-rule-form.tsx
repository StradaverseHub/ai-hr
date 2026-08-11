'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import { Button, Field, btnPrimary, inputCls } from '@/components/ui';
import type { CriteriaOption, CriteriaSection } from '@/core/org-criteria-form';

/**
 * 6e9a126e RELEASE TWO — EMPLOYEE ELIGIBILITY (the reporter's Step 2): who gets which entitlement table.
 *
 * ⚠️ THE MATCHED COUNT IS NOT DECORATION. An EMPTY criteria object is legal and means EVERYONE —
 * `core/org-criteria.ts`'s own semantics, and how a tenant expresses "one default table". It is also how
 * somebody assigns the entire organisation to a table by accident. The resolver deliberately does not
 * second-guess an explicit request, so this count is the only thing standing between "no restrictions" and
 * a whole-company assignment. The Notice Board and the Leave Adjustments screen carry the same obligation
 * and the same control.
 *
 * ⚠️ IT IS A CLIENT COMPONENT AND IT RESOLVES ITS OWN LABELS. r123 broke a production tab by passing a
 * translator CLOSURE from a server component across this boundary; `test/server-client-boundary.test.ts`
 * pins the class. Everything arriving here is plain serialisable data — the criteria sections are built by
 * the SHARED `buildOrgCriteriaSections` on the server and carry only strings — plus the two server
 * actions, which is the exception the framework allows.
 *
 * ⚠️ EVERY `name` BELOW IS A CONTRACT, not a label: each must be a member of `ORG_CRITERIA_FIELDS` /
 * `ORG_CRITERIA_RANGE_FIELDS`. That is precisely why this component does not define the field list — it
 * renders whatever the shared builder handed it, so the picker and the resolver cannot drift apart. A
 * control whose name is not a real axis renders, posts, and narrows NOBODY, silently.
 */
export type EligibilityRuleInitial = {
  lineageId?: string;
  name: string;
  templateLineageId: string;
  validFrom: string;
  criteria: Record<string, string[] | string>;
};

export function EligibilityRuleForm({
  action,
  countAction,
  templates,
  criteriaSections,
  initial,
  today,
  submitLabel,
  embeddedLeaveTypeId,
}: {
  action: (formData: FormData) => Promise<void>;
  countAction: (p: { criteria: Record<string, string[] | string>; asOf: string }) => Promise<number>;
  templates: { value: string; label: string }[];
  criteriaSections: CriteriaSection[];
  initial?: EligibilityRuleInitial;
  today: string;
  submitLabel: string;
  /** ee6b7c69 — set only when this form is mounted INSIDE a leave type's Entitlement step. Posted as a
   *  hidden field so the save returns to that step (with its `#type-<id>` selection intact) rather than
   *  bouncing HR onto the standalone Entitlement Tables screen the embed exists to make unnecessary. A
   *  plain string: nothing about this prop crosses the boundary as anything but data. */
  embeddedLeaveTypeId?: string;
}) {
  const t = useTranslations('admin.entitlementTemplates');
  const [criteria, setCriteria] = useState<Record<string, string[] | string>>(initial?.criteria ?? {});
  const [validFrom, setValidFrom] = useState(initial?.validFrom ?? today);
  const [count, setCount] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  const setMulti = (name: string, values: string[]) =>
    setCriteria((prev) => {
      const next = { ...prev };
      if (values.length) next[name] = values;
      else delete next[name];
      // A changed audience invalidates the number on screen. Showing a stale count beside new criteria is
      // worse than showing none — it is a confirmation of something the operator did not ask about.
      setCount(null);
      return next;
    });

  const setScalar = (name: string, value: string) =>
    setCriteria((prev) => {
      const next = { ...prev };
      if (value) next[name] = value;
      else delete next[name];
      setCount(null);
      return next;
    });

  const check = () =>
    startTransition(async () => {
      setCount(await countAction({ criteria, asOf: validFrom || today }));
    });

  /**
   * 74d00fd2 — WHAT WAS STORED STAYS OFFERABLE. `ChipMultiSelect` drops any `defaultSelected` value absent
   * from its `options`, and `buildOrgCriteriaSections` offers ACTIVE catalogue rows only. So reopening a
   * saved rule after a nationality (or division, section, team…) was deactivated would silently drop that
   * value from the picker, and a plain Save would then WIDEN the rule — no error, no warning, more people.
   * Union whatever this rule already stores back onto the offered list, the same remedy
   * components/leave-type-panel.tsx applies to the Condition-step criteria (#165baee5); a value with no
   * display label left renders as its raw stored string, which is still recognisable and still removable.
   *
   * Read from `initial`, NOT from live `criteria`: the option list must be stable for the life of the form.
   * Deriving it from the live selection would make a retired value un-re-selectable the moment it is
   * unticked, and would move the "every option is picked" line under the operator's feet mid-edit.
   */
  const storedFor = (name: string): string[] => {
    const v = initial?.criteria?.[name];
    return Array.isArray(v) ? v : [];
  };
  const withStored = (options: CriteriaOption[], stored: string[]): CriteriaOption[] => [
    ...options,
    ...stored.filter((v) => !options.some((o) => o.value === v)).map((v) => ({ value: v, label: v })),
  ];

  const unrestricted = Object.keys(criteria).length === 0;

  return (
    <form action={action} className="space-y-4">
      {embeddedLeaveTypeId ? (
        <input type="hidden" name="embeddedLeaveTypeId" value={embeddedLeaveTypeId} />
      ) : null}
      {initial?.lineageId ? <input type="hidden" name="lineageId" value={initial.lineageId} /> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('ruleName')}>
          <input className={inputCls} name="name" defaultValue={initial?.name ?? ''} required />
        </Field>
        <Field label={t('ruleTemplate')}>
          <select className={inputCls} name="templateLineageId" defaultValue={initial?.templateLineageId ?? ''} required>
            <option value="">{t('rulePickTemplate')}</option>
            {templates.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('effectiveFrom')}>
          <input
            className={inputCls}
            type="date"
            name="validFrom"
            value={validFrom}
            onChange={(e) => {
              setValidFrom(e.target.value);
              setCount(null);
            }}
            required
          />
        </Field>
      </div>

      {/* The criteria the SHARED builder produced. Rendered, never enumerated here. */}
      {criteriaSections.map((section) => (
        <details key={section.key} className="rounded-md border border-border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{section.title}</summary>
          <div className="grid gap-3 border-t border-border p-3 sm:grid-cols-2">
            {section.fields.map((f) =>
              f.kind === 'multi' ? (
                /* 74d00fd2 — the bulk affordances, which are OPT-IN props of the shared control and are
                   passed HERE, at this call site, so no other screen's picker changes. Search + Select all
                   + Deselect all are the same three the Leave Adjustments and Generate Entitlement builders
                   already pass (this is the same criteria builder); `triggerSummaryFor` is this screen's
                   own, because 26 collapsed <details> sections of pickers all reading "Add…" is unreadable
                   — the count belongs where it can be seen without opening anything.
                   ⚠️ Deselect all clears only what the SEARCH BOX is currently showing. Typing "ind" and
                   pressing it unticks Indonesian and leaves the other six picks alone. That is deliberate
                   and stated in the approved plan. */
                <ChipMultiSelect
                  key={f.name}
                  name={f.name}
                  label={f.label}
                  options={withStored(f.options ?? [], storedFor(f.name))}
                  defaultSelected={Array.isArray(criteria[f.name]) ? (criteria[f.name] as string[]) : []}
                  addPlaceholder={t('chipAddPlaceholder')}
                  removeLabelFor={(label) => t('chipRemoveLabel', { value: label })}
                  searchPlaceholder={t('chipSearchPlaceholder')}
                  selectAllLabel={t('chipSelectAll')}
                  clearAllLabel={t('chipDeselectAll')}
                  /* Both sentences the strip below used to print, now on the control and at ANY count —
                     the old count line only appeared past four, which is exactly the range where the chips
                     were already legible. `countLabelFor` is deliberately NOT passed alongside: it would be
                     dead, since supplying this suppresses the below-control lines. */
                  triggerSummaryFor={(n, allSelected) =>
                    allSelected ? t('chipAllSelected') : t('chipCountLabel', { count: n })
                  }
                  onSelectionChange={(values) => setMulti(f.name, values)}
                />
              ) : (
                <Field key={f.name} label={f.label}>
                  <input
                    className={inputCls}
                    type={f.kind === 'date' ? 'date' : 'number'}
                    name={f.name}
                    defaultValue={typeof criteria[f.name] === 'string' ? (criteria[f.name] as string) : ''}
                    onChange={(e) => setScalar(f.name, e.target.value)}
                  />
                </Field>
              ),
            )}
            {section.note ? <p className="text-xs text-muted-foreground sm:col-span-2">{section.note}</p> : null}
          </div>
        </details>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={check} disabled={pending}>
          {t('ruleCheckAudience')}
        </Button>
        {count != null ? (
          <span className="text-sm">{t('ruleMatchedCount', { count })}</span>
        ) : (
          <span className="text-xs text-muted-foreground">{t('ruleCheckHint')}</span>
        )}
        {unrestricted ? <span className="text-sm font-medium">{t('ruleEveryoneWarning')}</span> : null}
        <button type="submit" className={btnPrimary}>
          {submitLabel}
        </button>
      </div>

      {/* The residual the plan requires be stated on screen rather than implied away: a rule narrowed by
          grade, gender, nationality, religion or race is resolved at TODAY'S value however far back a
          past-date question reaches, because none of those columns is effective-dated anywhere in this
          schema. Department, position, business unit, cost centre, location and employment type ARE dated
          and are resolved as at the date being asked about. */}
      <p className="text-xs text-muted-foreground">{t('ruleUndatedAxesNote')}</p>
    </form>
  );
}
