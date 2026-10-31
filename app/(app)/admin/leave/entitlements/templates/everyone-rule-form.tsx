'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import { Field, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';

/**
 * r212 (8ebf77ae) — THE ONE-CLICK RULE SHAPE: "everyone this leave type is available to".
 *
 * `createEligibilityRule` with criteria `{}`. EMPTY CRITERIA ALREADY MEANS EVERYONE — that is
 * `resolveOrgCriteriaTargets`' own semantics, stated in its header — so nothing about resolution changes
 * here. What changes is that it becomes a NAMED, deliberate choice instead of something you get by leaving
 * every box empty and hoping, which is exactly what the reporter did by hand for Examination Leave on
 * 2026-08-20.
 *
 * ⚠️ AND THAT IS PRECISELY WHY IT MUST SHOW THE REACH COUNT. Two headers in this codebase say so in almost
 * the same words — `countEligibilityTargetsAction` ("THE SCREEN IS REQUIRED TO SHOW THIS BEFORE IT LETS
 * ANYBODY SAVE … this count is the thing that stops 'no restrictions' becoming an accidental whole-company
 * assignment") and `EligibilityRuleForm` ("the only thing standing between 'no restrictions' and a
 * whole-company assignment"). The service refuses nothing, and `createEligibilityRuleAction` runs
 * `recomputeAfterSave` immediately, so balances move on the click. The first cut of this form was a bare
 * server `<form>` with a plain submit: the one shape in the product that ALWAYS means everybody was the one
 * shape that showed no number.
 *
 * SO THE COUNT IS NOT AN AFFORDANCE HERE, IT IS A GATE, and it is stricter than the full editor's:
 *   · the full editor offers a "Check audience" BUTTON, because its criteria change as you type and a count
 *     fetched for the previous selection would be a confirmation of something you did not ask about;
 *   · this form's criteria never change — they are `{}` — so the count is fetched on mount and re-fetched
 *     only when the effective date moves (the reachable population is dated), and the submit stays DISABLED
 *     until a number is on screen. There is no state in which this form can be submitted unsighted.
 *   · the submit is a `ConfirmSubmit` whose dialog repeats the number, the same control the Stop and Delete
 *     rows on this screen use for far smaller writes.
 *
 * ⚠️ IT POSTS NO CRITERIA FIELD AT ALL, and that is load-bearing: `criteriaFrom` asks
 * `orgCriteriaFromFields` for the axes it knows BY NAME rather than sweeping the FormData, so what is
 * stored is `{}` and not a near-miss. `test/r212-leave-type-inherited-conditions.test.ts` pins it.
 *
 * ⚠️ CLIENT COMPONENT, PLAIN SERIALISABLE PROPS. r123 took a production tab down by handing a translator
 * CLOSURE across this boundary; `test/server-client-boundary.test.ts` pins the class. The two server
 * actions are the exception the framework allows, and everything else arriving here is strings.
 * Substrate: the write is the action's; this renders. // substrate: read-only, no event
 */
export function EveryoneRuleForm({
  action,
  countAction,
  templates,
  today,
  embeddedLeaveTypeId,
}: {
  action: (formData: FormData) => Promise<void>;
  /** The SAME count the full rule editor uses, normalised through the same `orgCriteriaFromFields` the save
   *  goes through — a count computed from a differently-parsed object than the write would use is worse
   *  than no count at all (see `countEligibilityTargetsAction`). */
  countAction: (p: { criteria: Record<string, string[] | string>; asOf: string }) => Promise<number>;
  templates: { value: string; label: string }[];
  today: string;
  /** ee6b7c69 — set only when mounted INSIDE a leave type's Entitlement step, so the save returns there. */
  embeddedLeaveTypeId?: string;
}) {
  const t = useTranslations('admin.entitlementTemplates');
  const [validFrom, setValidFrom] = useState(today);
  const [count, setCount] = useState<number | null>(null);
  const [, startTransition] = useTransition();

  // ⚠️ THE POPULATION IS DATED, so the count is too: `resolveOrgCriteriaTargets` excludes anybody not yet
  // hired or already terminated as at the date asked about. A count fetched for today and shown beside an
  // effective date in January would be a number about the wrong people. Re-fetched, and blanked first —
  // which also re-disables the submit, so the date cannot be changed past a stale confirmation.
  useEffect(() => {
    let live = true;
    setCount(null);
    startTransition(async () => {
      const n = await countAction({ criteria: {}, asOf: validFrom || today });
      if (live) setCount(n);
    });
    return () => {
      live = false;
    };
  }, [validFrom, today, countAction]);

  return (
    <form action={action} className="mb-4 space-y-2 rounded-md border border-border p-3">
      {embeddedLeaveTypeId ? (
        <input type="hidden" name="embeddedLeaveTypeId" value={embeddedLeaveTypeId} />
      ) : null}
      <p className="text-sm font-medium">{t('ruleEveryoneTitle')}</p>
      <p className="text-xs text-muted-foreground">{t('ruleEveryoneHelp')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('ruleName')}>
          <input className={inputCls} name="name" defaultValue={t('ruleEveryoneDefaultName')} required />
        </Field>
        <Field label={t('ruleTemplate')}>
          <select className={inputCls} name="templateLineageId" defaultValue="" required>
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
            onChange={(e) => setValidFrom(e.target.value)}
            required
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">
          {count == null ? t('ruleEveryoneCounting') : t('ruleEveryoneCount', { count })}
        </span>
        {/* Disabled until the number is on screen — see the header: this is the gate, not a hint. */}
        <ConfirmSubmit
          variant="default"
          disabled={count == null}
          title={t('ruleEveryoneTitle')}
          subtitle={count == null ? undefined : t('ruleEveryoneCount', { count })}
          description={t('ruleEveryoneConfirm')}
        >
          {t('ruleEveryoneCreate')}
        </ConfirmSubmit>
      </div>
    </form>
  );
}
