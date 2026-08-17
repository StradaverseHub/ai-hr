'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import { Button, Field, btnPrimary, inputCls } from '@/components/ui';
import type { CriteriaOption, CriteriaSection } from '@/core/org-criteria-form';
import {
  applyGradeGroupSelection,
  memberGradeIds,
  partiallyCoveredGradeGroups,
  wholeGradeGroupIds,
  type GradeGroupOption,
} from '@/lib/grade-group-coverage';

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
 *
 * ── THE ONE CONTROL THAT IS THIS SCREEN'S OWN: GRADE GROUP ────────────────────────────────────────────
 * The Grade Group picker is deliberately NOT a field of the shared builder, and `gradeGroupIds` is
 * deliberately NOT a criteria axis. It is an APPLICATOR over the `gradeIds` axis: ticking a group fills in
 * that group's member grades, unticking it takes them back, and what the form posts and the rule stores is
 * `gradeIds` exactly as before. Two consequences, both intended:
 *
 *   - the builder is untouched, so Leave Adjustments and Generate Entitlement — which share it — gain no
 *     control and change no shape. The reporter asked for this on Employee Eligibility, and this is the
 *     only screen that gets it.
 *   - `gradeGroupIds` DOES ride along in the FormData (a `ChipMultiSelect` posts hidden inputs under its
 *     `name`), and the eligibility action ignores it: `criteriaFrom` asks `orgCriteriaFromFields` for the
 *     axes it knows BY NAME rather than sweeping the FormData, so a field that is not an axis cannot
 *     become one. That is the same property that already keeps `embeddedLeaveTypeId` out of the criteria.
 *
 * Reopening a saved rule needs nothing stored: which groups are ticked is DERIVED from the grades the rule
 * already names (`wholeGradeGroupIds`). The other side of that derivation is the drift warning below — see
 * lib/grade-group-coverage.ts for why expansion snapshots the membership and what that costs.
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
  gradeGroups,
  archivedMemberGrades = [],
  initial,
  today,
  submitLabel,
  embeddedLeaveTypeId,
}: {
  action: (formData: FormData) => Promise<void>;
  countAction: (p: { criteria: Record<string, string[] | string>; asOf: string }) => Promise<number>;
  templates: { value: string; label: string }[];
  criteriaSections: CriteriaSection[];
  /** The tenant's grade groups with their membership — plain data, read on the server. REQUIRED rather
   *  than optional: a mount that forgot it would render a screen missing the control the reporter asked
   *  for, and would do it silently. An empty list is a legitimate value (a tenant with no groups yet) and
   *  hides the picker rather than offering an empty one. */
  gradeGroups: GradeGroupOption[];
  /** Names for the group members the ACTIVE grade catalogue no longer offers — see `gradeLabelFor` below.
   *  Optional with an empty default, unlike `gradeGroups`: forgetting it degrades a label, where forgetting
   *  the groups would delete a control. A tenant that has archived no grade held by a group passes none. */
  archivedMemberGrades?: { id: string; name: string }[];
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
   * ── GRADE GROUP ⇄ JOB GRADE, and the two remounts that keep them honest ─────────────────────────────
   *
   * `ChipMultiSelect` is UNCONTROLLED: it seeds its selection from `defaultSelected` on mount and owns it
   * thereafter. So one control cannot change what the other one SHOWS by re-rendering — it has to remount.
   * Each direction gets its own nonce, and they cannot chase each other because each is bumped by the
   * OTHER control's change handler only:
   *
   *   groups changed → recompute `criteria.gradeIds` → bump `gradeNonce` → the Job Grade picker remounts
   *                    holding the expanded grades (the operator can then see and edit exactly what the
   *                    group filled in, which is the whole point of expanding rather than storing a group).
   *   grades changed → bump `groupNonce` → the Grade Group picker remounts, re-deriving its ticks from the
   *                    new grade set. Unticking one member of a group must untick the GROUP, not leave a
   *                    control claiming a coverage the rule no longer has.
   *
   * The group selection is never stored in state: it is `wholeGradeGroupIds(criteria.gradeIds)` on every
   * render, so "what is ticked" and "what the rule covers" are the same fact, computed once.
   */
  const gradeIds = Array.isArray(criteria.gradeIds) ? (criteria.gradeIds as string[]) : [];
  const selectedGroupIds = wholeGradeGroupIds(gradeIds, gradeGroups);
  const partialGroups = partiallyCoveredGradeGroups(gradeIds, gradeGroups);
  const [gradeNonce, setGradeNonce] = useState(0);
  const [groupNonce, setGroupNonce] = useState(0);

  const setGroups = (nextGroupIds: string[]) => {
    setMulti(
      'gradeIds',
      applyGradeGroupSelection({
        gradeIds,
        previousGroupIds: selectedGroupIds,
        nextGroupIds,
        groups: gradeGroups,
      }),
    );
    setGradeNonce((n) => n + 1);
  };

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
  const withStored = (
    options: CriteriaOption[],
    stored: string[],
    /** How an id with no option of its own is rendered. Defaults to the raw value, as described above —
     *  the Job Grade picker overrides it because for THAT axis a name is recoverable (see below). */
    labelFor: (v: string) => string = (v) => v,
  ): CriteriaOption[] => {
    // DE-DUPLICATED against the offered options AND against the rest of `stored`. The Job Grade call below
    // concatenates two lists that legitimately overlap — a rule that stores an archived grade a group also
    // holds names it in both — and two options sharing a `value` give ChipMultiSelect two rows with the
    // same React key and an option count its "all selected" summary can never reach.
    const seen = new Set(options.map((o) => o.value));
    const extra: CriteriaOption[] = [];
    for (const v of stored) {
      if (seen.has(v)) continue;
      seen.add(v);
      extra.push({ value: v, label: labelFor(v) });
    }
    return [...options, ...extra];
  };
  /**
   * …AND EVERY GRADE ANY GROUP HOLDS, for the Job Grade picker only — WITH A NAME ON IT.
   *
   * The same `ChipMultiSelect` rule that motivates `withStored` bites the expansion harder: the control
   * DROPS any `defaultSelected` value it cannot find in `options`, and the offered grades are the ACTIVE
   * ones. A group holding an archived grade would therefore expand to seven grades and post six — silently
   * covering fewer people than the group the operator picked, with nothing on screen to say so. Unioning
   * the groups' membership into the option list keeps the expansion whole, and stays removable.
   *
   * WHAT THE UNION MUST NOT DO IS PUT A BARE UUID ON SCREEN. `withStored`'s raw-value fallback is a
   * last resort for a value whose catalogue row is simply gone; here the row is not gone, it is ARCHIVED,
   * and the server hands us its name for exactly this (`archivedMemberGrades`, prepared beside the
   * groups). So the id renders as "Grade 19 (archived)" — a thing an operator can recognise, judge and
   * untick — and the "(archived)" is not decoration: an archived grade is not on offer anywhere else on
   * this form, and it is here only because a group still holds it.
   *
   * The union stays over EVERY group, not just the ticked ones, and stays computed off props rather than
   * live state, for the reason `storedFor` reads `initial`: an option list that moved with the selection
   * would make a value un-re-selectable the moment it was unticked, and would slide the "all selected"
   * line under the operator mid-edit.
   */
  const allGroupMemberGradeIds = memberGradeIds(
    gradeGroups.map((g) => g.id),
    gradeGroups,
  );
  const archivedGradeNameById = new Map(archivedMemberGrades.map((g) => [g.id, g.name]));
  const gradeLabelFor = (v: string): string => {
    const name = archivedGradeNameById.get(v);
    return name == null ? v : t('ruleGradeArchived', { name });
  };
  const optionsFor = (f: { name: string; options?: CriteriaOption[] }): CriteriaOption[] =>
    f.name === 'gradeIds'
      ? withStored(f.options ?? [], [...storedFor(f.name), ...allGroupMemberGradeIds], gradeLabelFor)
      : withStored(f.options ?? [], storedFor(f.name));

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

      {/* ── GRADE GROUP — this screen's own control, and the reason it stands OUTSIDE the section list ──
          It is not a field of the shared builder (see the header), so it cannot be rendered by the loop
          below. Rendering it beside the Job Grade picker INSIDE the loop was the alternative and it is
          worse in two ways: it would key the control's existence on a field name the builder owns — drop
          `gradeIds` there one day and this control disappears with no error — and it would bury the thing
          the reporter reaches for first inside a collapsed <details>. So it leads the criteria, always
          open, which is also what the approved plan asks for ("the group list comes first because it is
          what you will use"). The individual Job Grade picker is untouched and still offered below.
          Hidden entirely when the tenant has no groups: an empty picker teaches nobody anything. */}
      {gradeGroups.length > 0 ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <ChipMultiSelect
            /* Remounted when the GRADE picker changes, so the ticks re-derive — see the nonce note above. */
            key={`gradeGroupIds-${groupNonce}`}
            name="gradeGroupIds"
            label={t('ruleGradeGroup')}
            options={gradeGroups.map((g) => ({ value: g.id, label: g.name }))}
            defaultSelected={selectedGroupIds}
            addPlaceholder={t('chipAddPlaceholder')}
            removeLabelFor={(label) => t('chipRemoveLabel', { value: label })}
            searchPlaceholder={t('chipSearchPlaceholder')}
            selectAllLabel={t('chipSelectAll')}
            clearAllLabel={t('chipDeselectAll')}
            triggerSummaryFor={(n, allSelected) =>
              allSelected ? t('chipAllSelected') : t('chipCountLabel', { count: n })
            }
            onSelectionChange={setGroups}
          />
          {/* What the group actually did, in job grades — the control it fills in lives inside a collapsed
              section, so without this line the expansion would be invisible until someone opened it. */}
          <p className="text-xs text-muted-foreground">
            {t('ruleGradeGroupApplied', { count: gradeIds.length })}
          </p>
          {/* The snapshot trade-off, on the rule that carries it (lib/grade-group-coverage.ts's header). */}
          <p className="text-xs text-muted-foreground">{t('ruleGradeGroupNote')}</p>
          {/* …and the drift itself, whenever this rule is actually in it. Same condition the approval
              template refuses on, so the two screens never disagree about which rules are affected. */}
          {partialGroups.length > 0 ? (
            <p className="text-xs font-medium text-foreground">
              {t('ruleGradeGroupPartial', { groups: partialGroups.map((g) => g.name).join(', ') })}
            </p>
          ) : null}
        </div>
      ) : null}

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
                  /* The Job Grade picker REMOUNTS when the Grade Group picker fills it in — see the nonce
                     note above. Every other field keys on its name and mounts once, exactly as before. */
                  key={f.name === 'gradeIds' ? `gradeIds-${gradeNonce}` : f.name}
                  name={f.name}
                  label={f.label}
                  options={optionsFor(f)}
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
                  onSelectionChange={(values) => {
                    setMulti(f.name, values);
                    // Editing grades BY HAND must re-derive the group ticks: unticking one member of a
                    // group leaves the rule covering part of it, and a Grade Group control still showing
                    // that group ticked would be claiming a coverage the rule no longer has.
                    if (f.name === 'gradeIds') setGroupNonce((n) => n + 1);
                  }}
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
