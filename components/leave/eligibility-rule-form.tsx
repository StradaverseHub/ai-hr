'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import { Button, Field, btnPrimary, inputCls } from '@/components/ui';
import type { CriteriaSection } from '@/core/org-criteria-form';

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
}: {
  action: (formData: FormData) => Promise<void>;
  countAction: (p: { criteria: Record<string, string[] | string>; asOf: string }) => Promise<number>;
  templates: { value: string; label: string }[];
  criteriaSections: CriteriaSection[];
  initial?: EligibilityRuleInitial;
  today: string;
  submitLabel: string;
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

  const unrestricted = Object.keys(criteria).length === 0;

  return (
    <form action={action} className="space-y-4">
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
                <ChipMultiSelect
                  key={f.name}
                  name={f.name}
                  label={f.label}
                  options={f.options ?? []}
                  defaultSelected={Array.isArray(criteria[f.name]) ? (criteria[f.name] as string[]) : []}
                  addPlaceholder={t('chipAddPlaceholder')}
                  removeLabelFor={(label) => t('chipRemoveLabel', { value: label })}
                  countLabelFor={(n) => t('chipCountLabel', { count: n })}
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
