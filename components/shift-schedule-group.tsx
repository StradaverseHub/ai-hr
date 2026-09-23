'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';
import { weekPatternGroupFor, type WeekPattern } from '@/core/week-pattern';

/**
 * ─── aec53564 (r331) · THE SHIFT'S SCHEDULE GROUP, SHARED LIVE WITH THE WORKING-DAY ROW ─────────────────
 *
 * THE ITEM IN ONE SENTENCE: the working days are editable on the Shift form exactly when nothing else is
 * deciding them.
 *
 * WHY THIS IS A PROVIDER AND NOT SIMPLY A BIGGER ISLAND. Two controls on this form have to agree, and they
 * are in two different sections of it:
 *
 *   · SECTION 2 · WORKING TIMES  — the seven-day row (components/shift-time-fields.tsx).
 *   · SECTION 4 · GENERAL CONTROLS — this select, labelled "Lateness, Early Out & Overtime Settings",
 *                                    which is the shift's `rule_id` and therefore its Schedule Group.
 *
 * The group decides the days, so the days have to follow this select AS IT IS CHANGED — no save, no
 * reload. The obvious fix is to drag the select up beside the days, and it was the wrong one: its label
 * names lateness, early-out and overtime, none of which is a working time, and 6340aecb put it in General
 * Controls for that reason. So the STATE moves instead of the control. A client context provider wraps the
 * whole form; the select writes to it, the day row reads from it, and both stay where the reporter's
 * redesign put them.
 *
 * ⚠️ NO SERVER ACTION IS EVER PASSED INTO THIS TREE AS A PROP (test/rsc-boundary-guard.test.ts and the
 * class of bug behind it). The provider carries DATA ONLY: plain, serializable Schedule Group rows, each
 * already carrying the href the server built for it (app/admin/attendance/schedule/sections.ts
 * `scheduleGroupSectionHref`). The <form action={…}> stays on the server component around it.
 *
 * ⚠️ AND NO SECOND ANSWER TO "DOES THIS GROUP SET A WEEK". That question has exactly one answer in this
 * codebase — `weekPatternFor` in core/week-pattern.ts — and it is asked in components/shift-time-fields.tsx
 * (to grey the row) and again in app/admin/attendance/shift-actions.ts (to refuse the write). This module
 * only says WHICH group is selected right now.
 */

/** One Schedule Group as the form offers it: its identity, its week, and where to go to read it. */
export type ShiftScheduleGroupOption = WeekPattern & {
  id: string;
  name: string;
  isDefault: boolean;
  /** Offered only because the shift already points at it — the form must not silently re-point to Standard. */
  inactive: boolean;
  /** A STRING built on the server, never a function prop: the group's View page, at its Working Day section. */
  href: string;
};

/** The id of the block this select sits in, so the greyed day row can point AT the control that decides it
 *  rather than leaving the reader to hunt for a cause that is further down the page. */
export const SHIFT_SCHEDULE_GROUP_ANCHOR = 'shift-schedule-group';

type ShiftScheduleGroupCtx = {
  groups: readonly ShiftScheduleGroupOption[];
  ruleId: string;
  setRuleId: (v: string) => void;
};

const Ctx = createContext<ShiftScheduleGroupCtx | null>(null);

export function ShiftScheduleGroupProvider({
  groups,
  defaultRuleId,
  children,
}: {
  groups: readonly ShiftScheduleGroupOption[];
  /** The stored `rule_id`, or '' for "the tenant's Standard rule". */
  defaultRuleId: string;
  children: ReactNode;
}) {
  const [ruleId, setRuleId] = useState(defaultRuleId);
  return <Ctx.Provider value={{ groups, ruleId, setRuleId }}>{children}</Ctx.Provider>;
}

/**
 * The Schedule Group this shift resolves to RIGHT NOW, or null.
 *
 * Null means one of two different things and the caller must treat them the same: no provider above (this
 * component is being used somewhere that has no Schedule Group picker) or a tenant with no Standard rule
 * at all. In both, nothing is deciding the week, which is precisely the case where the day row stays
 * editable — so "no group" degrades to today's behaviour rather than to a locked form.
 */
export function useShiftScheduleGroup(): ShiftScheduleGroupOption | null {
  const ctx = useContext(Ctx);
  return ctx ? weekPatternGroupFor(ctx.groups, ctx.ruleId) : null;
}

/**
 * THE SELECT ITSELF — the same field, unchanged in name, position and options. (Its name is spelled ONCE
 * in this file, in the JSX below: test/shift-form-sections.test.ts proves every field the action reads is
 * rendered by someone, and a prose copy of the attribute in a comment would satisfy that check without an
 * input existing. Measured — the first version of this comment did exactly that.)
 *
 * Controlled rather than `defaultValue`, because the day row is now watching it. Blank ⇒ the tenant's
 * Standard rule (88e94371), which `weekPatternGroupFor` resolves exactly as core/attendance-rule.ts
 * `resolveRuleTx` does on the server.
 */
export function ShiftScheduleGroupSelect() {
  const t = useTranslations('admin.attendancePolicy');
  const ctx = useContext(Ctx);
  if (!ctx) return null;
  return (
    <div id={SHIFT_SCHEDULE_GROUP_ANCHOR} className="scroll-mt-24">
      <Field label={t('ruleFieldLabel')}>
        <select
          name="attendanceRuleId"
          value={ctx.ruleId}
          onChange={(e) => ctx.setRuleId(e.target.value)}
          className={inputCls}
        >
          <option value="">{t('ruleFieldStandardDefault')}</option>
          {ctx.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.isDefault ? `${g.name} ${t('ruleDefaultSuffix')}` : g.name}
              {g.inactive ? ` ${t('ruleInactiveSuffix')}` : ''}
            </option>
          ))}
        </select>
      </Field>
      {/* The label above names lateness, early-out and overtime — and since 07ebd04d the SAME record also
          states a working week. Saying so here is the difference between a control whose reach is
          understood and one that greys out a row further up the form for no visible reason. */}
      <p className="mt-1 text-xs text-muted-foreground">{t('ruleFieldWeekHint')}</p>
    </div>
  );
}
