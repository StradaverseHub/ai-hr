'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ORG_ASSIGNMENT_CRITERIA, type OrgAssignmentCriterionKey } from '@/core/leave-org-criteria';
import { resolvePlacement, ESS_PLACEMENTS } from '@/lib/leave-groups';
import { isStatutoryApplyLeaveType, STATUTORY_APPLY_SEEDED_CODES } from '@/lib/leave-statutory';
import { MARITAL_STATUSES } from '@/lib/person-vocabulary';
import type { LeaveFormulaEntry } from '@/core/leave-formula';
import { cn } from '@/lib/utils';
import { Button, Field, inputCls } from '@/components/ui';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import {
  ApplicationLimitsForm,
  BalanceSourceForm,
  CarryPolicyForm,
  EarningMethodForm,
  LeaveVisualForm,
  MaxConsecutiveForm,
  NegativeBalanceForm,
  ViewConfigSection,
  asEligList,
  type Action,
  type LeaveEligibilityRule,
  type LeaveTypeRules,
} from './leave-type-sub-forms';

/**
 * a6fe37fc ROUND 2 — THE NEW LEAVE TYPE SCREEN, five tabs, built ALONGSIDE the old one.
 *
 * The old screen (`/admin/leave/entitlements` + `components/leave-type-panel.tsx`) is UNTOUCHED and is
 * still what the menu links to; this round adds and removes nothing (migration order, Round 2). What
 * changes here is the ARRANGEMENT: the four steps and six sub-steps of the old panel become the five
 * tabs of IA §2, in the order the decisions are actually made —
 *
 *   1 identity     what the leave type is        (F6 F8 F27 F28 F30 F32 + F39 arriving from Payroll impact)
 *   2 eligibility  who may take it at all        (F13)
 *   3 entitlement  how many days, and who gets which table (F9 F10 F11 F12 F20 F21 F22)
 *   4 application  what an application must satisfy (F14–F19 F23 F24 F25 F29)
 *   5 approvers    who approves it               (F7, moved out of General setting)
 *
 * ⚠️ THE STORAGE-KEY RULE, AND WHY IT HAS A TEST OF ITS OWN.
 * The tab keys must NEVER be named `approval`, `display` or `calculation`. Those are the RETIRED
 * accordion keys of the pre-c979aa8b panel, and re-using one would make an administrator's stored
 * `leaveTypeCards:<id>` payload hydrate onto the WRONG tab. `test/leave-type-config-categories.test.ts`
 * asserted exactly that and was DELETED in c9e18c7e; of the 29 test files that read the old panel, NONE
 * asserts those three strings absent — so nothing would catch a wrong key here: tsc, the targeted tests
 * and the full gate all pass. `test/leave-config-types-tabs.test.ts` is that missing guard, written
 * against THIS file before a single tab was named.
 *
 * ⚠️ EVERY SUB-FORM KEEPS ITS TRI-STATE MARKER AND ITS HIDDEN `name` (IA §1.2's list, walked form by
 * form). A form that posts `updateTypeAction` without its marker does not fail to save — it saves, and
 * WIPES the columns a neighbouring form owns. No form was merged with another and none was split: 24
 * sub-forms in, 24 sub-forms out, 27 markers in, 27 markers out.
 *
 * ⚠️ NO SERVER ACTION CHANGED SIGNATURE AND NO NEW ACTION WAS WRITTEN. One consequence is visible and
 * is deliberate rather than overlooked: `updateLeaveTypeAction` redirects to `/admin/leave/entitlements`
 * (app/admin/_redirects.ts ENTITLEMENTS), so a save made here lands back on the OLD screen. Re-pointing
 * that constant is a Round 5 act — it would move every save on the old screen too — so the note at the
 * top of the page says so instead.
 */

/** The five tabs, in walk order. THE KEYS ARE STORAGE KEYS (see the header's storage-key rule). */
export const TAB_KEYS = ['identity', 'eligibility', 'entitlement', 'application', 'approvers'] as const;
export type TabKey = (typeof TAB_KEYS)[number];

/**
 * The RETIRED step / sub-step keys a stored `leaveTypeCards:<id>` payload may still hold, and the tab
 * each one's CONTENT now lives on. Without this an administrator who last used the old screen is snapped
 * back to tab 1 by the new one.
 *
 *  · `general`  → the old General step. Its Details and Leave Year Type sub-steps are tab 1; its Earning
 *                 and Carry Forward sub-steps moved to tab 3, so `generalSubStep` refines it below.
 *  · `ess`      → the old Condition step: Criteria is tab 2, Leave Application Rules is tab 4, so
 *                 `essSubStep` refines it below.
 *  · `entitlement` → the same content, the same name: the tables and Run Accrual are tab 3.
 *  · `custom`   → Custom Settings held the view configuration, visibility, placement and visual — tab 1.
 *  · `eligibility` → the step b8fcae73 retired. The old panel sent it to Entitlement because that is
 *                 where its per-company policy timeline went; that timeline no longer exists anywhere
 *                 (6e9a126e), so the honest destination is the tab that now answers the question its
 *                 name asks.
 *  · `workflow` → the Approval Workflow sub-step e4238594 removed. The old panel had nowhere to send it
 *                 and fell back to Details; tab 5 is where that question is answered now.
 */
const RETIRED_STEP_TO_TAB: Record<string, TabKey> = {
  general: 'identity',
  ess: 'eligibility',
  entitlement: 'entitlement',
  custom: 'identity',
  eligibility: 'eligibility',
};
const RETIRED_GENERAL_SUB_STEP_TO_TAB: Record<string, TabKey> = {
  details: 'identity',
  yearType: 'identity',
  earning: 'entitlement',
  carry: 'entitlement',
  workflow: 'approvers',
};
const RETIRED_ESS_SUB_STEP_TO_TAB: Record<string, TabKey> = {
  criteria: 'eligibility',
  rules: 'application',
};

/** ADR-0048: the four non-full-day durations an admin can enable on a leave type. */
const DURATION_OPTIONS = ['half_day_am', 'half_day_pm', 'hourly'] as const;

/** Supporting-document config: the closed set of allowed mime types (PDF / JPG / PNG). */
const DOC_MIME_OPTIONS = [
  { mime: 'application/pdf', label: 'fileTypePdf' as const },
  { mime: 'image/jpeg', label: 'fileTypeJpg' as const },
  { mime: 'image/png', label: 'fileTypePng' as const },
] as const;

/** The five day types, in the order the reporter listed them; mirrors core/leave.ts. */
const DAY_TYPE_INCLUSION_OPTIONS = ['offDay', 'restDay', 'publicHoliday', 'companyHoliday', 'shutdownDay'] as const;

/** Gender stays a SHORTER, deliberate list: 'undisclosed' is a valid PROFILE value but never a rule value. */
const ELIGIBILITY_GENDER_OPTIONS = ['male', 'female'] as const;
const ELIGIBILITY_MARITAL_OPTIONS = MARITAL_STATUSES;

/** Everything one leave type stores that these tabs render. Plain, serialisable data only — the page
 *  that mounts this is a SERVER component (test/server-client-boundary.test.ts). */
export type LeaveTypeTabsData = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  paid: boolean;
  archived: boolean;
  inUse: boolean;
  cascadeApprovalRules: string[];
  cascadeBalanceSourceOf: string[];
  eligibility: LeaveEligibilityRule | null;
  durations: string[] | null;
  requiresDocument: boolean;
  mandatoryAfterDays: number | null;
  allowedMimeTypes: string[] | null;
  maxDocBytes: number;
  employeeRemarkRequired: boolean;
  hrRemarkRequired: boolean;
  backdatingLimitDays: number | null;
  maxDaysPerLeaveYear: number | null;
  maxDaysPeriod: string | null;
  maxConsecutiveDays: number | null;
  maxConsecutiveUnit: 'calendar_days' | 'working_days' | null;
  minAdvanceDays: number | null;
  minAdvanceDayType: 'calendar_days' | 'working_days' | null;
  customMessages: Record<string, string> | null;
  essViewConfig: Record<string, boolean> | null;
  formulaExplanations: Record<string, LeaveFormulaEntry> | null;
  dayTypeInclusion: Record<string, boolean> | null;
  color: string | null;
  icon: string | null;
  leaveUnit: string;
  yearCycleOverride: string | null;
  probationEligibility: string | null;
  visibleToEmployee: boolean | null;
  employeeCanApply: boolean | null;
  essPlacement: string | null;
  role: string | null;
  counting: string;
  perDateApproval: boolean;
  duplicateApplicationPolicy: string | null;
  overrideRules: { trigger: string; action: string; enabled: boolean }[] | null;
  allowNegativeBalance: boolean;
  maxNegativeBalance: number | null;
  balanceSourceTypeId: string | null;
  allowUnpaidLeave: boolean;
  /** IA §3.1 F39 — arrives on tab 1 from the Payroll impact screen, which keeps its own copy this round. */
  sendToPayroll: boolean;
  rules: LeaveTypeRules;
};

export function LeaveTypeTabs({
  type,
  orgAssignmentOptions,
  balanceSourceOptions,
  formulaTemplate,
  entitlementTablesSection,
  accrualSection,
  approvalReadoutSection,
  updateTypeAction,
  archiveTypeAction,
  deleteTypeAction,
  setTypeRulesAction,
}: {
  type: LeaveTypeTabsData;
  /** The ACTIVE picker values for each of the eight org fields, keyed by profile_option category. */
  orgAssignmentOptions: Record<string, { value: string; label: string }[]>;
  /** The types THIS one may draw its balance from — prepared once at page level, not per panel. */
  balanceSourceOptions: { id: string; name: string }[];
  formulaTemplate: Record<string, LeaveFormulaEntry> | null;
  /** THIS TYPE'S Entitlement Tables + eligibility rules — the SAME shared block the all-types screen
   *  mounts, filtered to one type (IA §2.3: one component, two mount points, never two implementations). */
  entitlementTablesSection?: ReactNode;
  /** Run Earned Accrual — one server-composed node shared by every type. */
  accrualSection?: ReactNode;
  /**
   * a6fe37fc ROUND 4 — tab 5's READ-ONLY chain read-out: which chain reaches THIS leave type, its
   * ordered steps and the escalation, per company. Server-composed for the same reason
   * `entitlementTablesSection` is: it resolves through `decideApproval` — THE matcher — over a rule set
   * this page reads ONCE, and a client-side copy of that ranking is the drift IA §2.3 forbids.
   * READ-ONLY by design (IA §2.2): `e4238594` removed a per-leave-type Approval Workflow EDITOR from
   * this exact panel as a duplicate of the Approval screen's, and this is the answer that sub-step
   * never gave, not the sub-step coming back.
   */
  approvalReadoutSection?: ReactNode;
  updateTypeAction: Action;
  archiveTypeAction: Action;
  deleteTypeAction: Action;
  setTypeRulesAction: Action;
}) {
  const t = useTranslations('admin.leave');
  const tTabs = useTranslations('admin.leaveConfigTypes');
  // The eight criterion labels REUSE the existing profile_option category labels (already shipped in all
  // six locales) — zero new keys.
  const tOrg = useTranslations('admin.profileOptions.category');

  const {
    id,
    name,
    code,
    description,
    paid,
    archived,
    inUse,
    cascadeApprovalRules,
    cascadeBalanceSourceOf,
    eligibility,
    durations,
    requiresDocument,
    mandatoryAfterDays,
    allowedMimeTypes,
    maxDocBytes,
    employeeRemarkRequired,
    hrRemarkRequired,
    backdatingLimitDays,
    maxDaysPerLeaveYear,
    maxDaysPeriod,
    maxConsecutiveDays,
    maxConsecutiveUnit,
    minAdvanceDays,
    minAdvanceDayType,
    customMessages,
    essViewConfig,
    formulaExplanations,
    dayTypeInclusion,
    color,
    icon,
    leaveUnit,
    yearCycleOverride,
    probationEligibility,
    visibleToEmployee,
    employeeCanApply,
    essPlacement,
    role,
    counting,
    perDateApproval,
    duplicateApplicationPolicy,
    overrideRules,
    allowNegativeBalance,
    maxNegativeBalance,
    balanceSourceTypeId,
    allowUnpaidLeave,
    sendToPayroll,
    rules,
  } = type;

  // A statutory-entitlement type can never have applications blocked (EA 1955 s.60E/s.60F/s.37/s.60FA).
  // The question is asked ONCE, in lib/leave-statutory.ts, ROLE FIRST with the seeded codes as fallback.
  const isStatutoryApply = isStatutoryApplyLeaveType({ role, code });
  // The Code field is editable ONLY for custom (non-statutory) types: the five seeded statutory codes —
  // plus EMERGENCY — are the semantic keys the leave/payroll engine matches on, so renaming one would
  // silently switch those rules off. Mirrors the service guard as a local literal.
  const codeLocked =
    (STATUTORY_APPLY_SEEDED_CODES as readonly string[]).includes(code) || code === 'EMERGENCY';

  const [activeTab, setActiveTab] = useState<TabKey>('identity');
  const [applyNoticeEnabled, setApplyNoticeEnabled] = useState<boolean>(!!customMessages?.applyNotice);
  /**
   * r258 fix pass — THE RENAME TOGGLE, RESTORED. The first draft of this screen rendered the identity
   * form always-open and said in a comment that this was "presentation only". It is not: on the old panel
   * a leave type's name and code are read-only until an administrator asks for them (components/
   * leave-type-panel.tsx:1745), and an always-editable name field beside a Save button is a different
   * screen to work on — one keystroke in the wrong box and a Save on any other control renames the type.
   * The round's own framing is that only the ARRANGEMENT changes, so the toggle comes across: closed
   * shows the type-level row (Rename · archive / delete), open shows the form with Save + Discard.
   */
  const [editingName, setEditingName] = useState(false);

  /**
   * Hydration. The payload is the SAME `leaveTypeCards:<id>` the old panel writes, because both screens
   * are live until Round 5 and an administrator moving between them should land where they were.
   *
   * Order: this screen's own `activeTab` wins; failing that the retired keys are REMAPPED (never
   * ignored), most specific first — a `generalSubStep` of `earning` says tab 3 even though its step says
   * tab 1. Anything unrecognised leaves tab 1, which is the walk's first step.
   */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`leaveTypeCards:${id}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== 'object') return;
      if (typeof parsed.activeTab === 'string' && (TAB_KEYS as readonly string[]).includes(parsed.activeTab)) {
        setActiveTab(parsed.activeTab as TabKey);
        return;
      }
      const step = typeof parsed.activeStep === 'string' ? parsed.activeStep : null;
      const generalSub = typeof parsed.generalSubStep === 'string' ? parsed.generalSubStep : null;
      const essSub = typeof parsed.essSubStep === 'string' ? parsed.essSubStep : null;
      if (step === 'general' && generalSub && RETIRED_GENERAL_SUB_STEP_TO_TAB[generalSub]) {
        setActiveTab(RETIRED_GENERAL_SUB_STEP_TO_TAB[generalSub]);
        return;
      }
      if (step === 'ess' && essSub && RETIRED_ESS_SUB_STEP_TO_TAB[essSub]) {
        setActiveTab(RETIRED_ESS_SUB_STEP_TO_TAB[essSub]);
        return;
      }
      if (step && RETIRED_STEP_TO_TAB[step]) {
        setActiveTab(RETIRED_STEP_TO_TAB[step]);
        return;
      }
      // The pre-step accordion shape { key: boolean } — first open card wins, in step order.
      const firstOpen = Object.keys(RETIRED_STEP_TO_TAB).find((k) => parsed[k] === true);
      if (firstOpen) setActiveTab(RETIRED_STEP_TO_TAB[firstOpen]);
    } catch {
      /* storage unavailable / malformed ⇒ default tab 1 */
    }
  }, [id]);

  /**
   * Persist. The stored payload is MERGED, never replaced: the old screen's `activeStep` /
   * `generalSubStep` / `essSubStep` are still live keys for as long as that screen exists, and
   * overwriting the object here would silently reset it to step 1 for anyone who goes back.
   */
  const selectTab = (key: TabKey) => {
    setActiveTab(key);
    try {
      const raw = window.localStorage.getItem(`leaveTypeCards:${id}`);
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown> | null) : null;
      const base = parsed && typeof parsed === 'object' ? parsed : {};
      window.localStorage.setItem(`leaveTypeCards:${id}`, JSON.stringify({ ...base, activeTab: key }));
    } catch {
      /* storage write blocked ⇒ the runtime switch still works, it is simply not remembered */
    }
  };

  const tabBtn = (active: boolean) =>
    cn(
      'flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors',
      active
        ? 'border-transparent bg-accent font-semibold text-accent-foreground'
        : 'border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground',
    );

  // Composable labels for the eligibility values (avoids a key-per-permutation matrix across 6 locales).
  const genderLabel = (g: string) =>
    g === 'male' ? t('eligibilityGenderMale') : g === 'female' ? t('eligibilityGenderFemale') : null;
  const maritalLabel = (m: string) =>
    m === 'single'
      ? t('eligibilityMaritalSingle')
      : m === 'married'
        ? t('eligibilityMaritalMarried')
        : m === 'divorced'
          ? t('eligibilityMaritalDivorced')
          : m === 'widowed'
            ? t('eligibilityMaritalWidowed')
            : m === 'separated'
              ? t('eligibilityMaritalSeparated')
              : m === 'other'
                ? t('eligibilityMaritalOther')
                : null;
  // ChipMultiSelect DROPS any defaultSelected absent from its options, so an option list that omitted a
  // stored value would let a plain Save erase a rule nobody meant to touch. Union what is stored on.
  const withStored = (options: { value: string; label: string }[], stored: string[]) => [
    ...options,
    ...stored.filter((v) => !options.some((o) => o.value === v)).map((v) => ({ value: v, label: v })),
  ];
  const orgCriterionOptions = (category: string, key: OrgAssignmentCriterionKey) =>
    withStored(orgAssignmentOptions[category] ?? [], asEligList(eligibility?.[key]));

  const dayTypeLabel = (k: string) => t(`dayTypeInclusion.${k}`);

  return (
    <div id={`type-${id}`} className={cn('space-y-3', archived && 'opacity-60')}>
      {/* Workspace header: the selected type's identity. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        <span className="text-xs text-muted-foreground">{code}</span>
        {archived && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('archivedBadge')}
          </span>
        )}
      </div>

      {/* The five tabs, numbered in the order the decisions are made. */}
      <ol aria-label={tTabs('tabsLabel')} className="flex flex-wrap items-center gap-1.5">
        {TAB_KEYS.map((key, i) => {
          const tabActive = activeTab === key;
          return (
            <li key={key} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden className="hidden h-px w-3 bg-border sm:block" />}
              <button
                type="button"
                onClick={() => selectTab(key)}
                aria-current={tabActive ? 'step' : undefined}
                aria-controls={tabActive ? `tab-${key}-${id}` : undefined}
                className={tabBtn(tabActive)}
              >
                <span
                  aria-hidden
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] tabular-nums',
                    tabActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {i + 1}
                </span>
                {tTabs(`tab.${key}`)}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="space-y-3">
        {/* ── TAB 1 · The leave type ─────────────────────────────────────────────────────────────── */}
        {activeTab === 'identity' && (
          <Card>
            <CardHeader>
              <CardTitle>{tTabs('tab.identity')}</CardTitle>
            </CardHeader>
            <CardContent id={`tab-identity-${id}`} className="space-y-3">
              <p className="text-xs text-muted-foreground">{tTabs('tabHint.identity')}</p>
              {/* F6 — code, name, description, paid/unpaid and the leave unit. TWO markers, one submit:
                  `identity=1` (name / description / paid / code) and `leaveUnit=1` (leave_unit). Behind
                  the SAME Rename toggle the old panel uses (restored in the r258 fix pass): the name and
                  the code are read-only until an administrator asks to change them. */}
              {editingName ? (
                <form action={updateTypeAction} className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <input type="hidden" name="id" value={id} />
                  {/* marker: tells the action to touch name / description / paid / code (tri-state guard) */}
                  <input type="hidden" name="identity" value="1" />
                  <Field label={t('codeLabel')}>
                    {codeLocked ? (
                      // No `name` attr ⇒ nothing posted ⇒ the code column is untouched (tri-state).
                      <input
                        value={code}
                        readOnly
                        aria-label={t('codeLabel')}
                        title={t('codeReadOnlyHint')}
                        className={`${inputCls} w-full cursor-not-allowed opacity-70`}
                      />
                    ) : (
                      <input
                        name="code"
                        defaultValue={code}
                        aria-label={t('codeLabel')}
                        title={t('codeEditableHint')}
                        className={`${inputCls} w-full`}
                      />
                    )}
                  </Field>
                  <Field label={t('nameLabel')}>
                    <input name="name" defaultValue={name} aria-label={t('nameLabel')} className={`${inputCls} w-full`} />
                  </Field>
                  <Field label={t('reasonLabel')}>
                    <input
                      name="reason"
                      type="text"
                      maxLength={500}
                      aria-label={t('reasonLabel')}
                      placeholder={t('reasonPlaceholder')}
                      className={`${inputCls} w-full`}
                    />
                  </Field>
                  {/* marker: tells the action to touch leave_unit (tri-state guard) */}
                  <input type="hidden" name="leaveUnit" value="1" />
                  <div className="flex items-end gap-3">
                    <Field label={t('leaveUnitLabel')} className="min-w-0 flex-1">
                      <select
                        name="leaveUnitValue"
                        defaultValue={leaveUnit === 'hour' ? 'hour' : 'day'}
                        aria-label={t('leaveUnitLabel')}
                        title={t('leaveUnitHelp')}
                        className={`${inputCls} w-full`}
                      >
                        <option value="day">{t('leaveUnitDay')}</option>
                        <option value="hour">{t('leaveUnitHour')}</option>
                      </select>
                    </Field>
                    {/* The `identity=1` marker above means an unchecked box is a real "unpaid" choice, not
                        "untouched". Applies to future leave only. */}
                    <Field label={t('paidLabel')}>
                      <div className="flex h-9 items-center">
                        <input
                          type="checkbox"
                          name="paid"
                          defaultChecked={paid}
                          aria-label={t('paidLabel')}
                          className="size-4 rounded"
                        />
                      </div>
                    </Field>
                  </div>
                  <Field label={t('descriptionLabel')} className="col-span-full">
                    <textarea
                      name="description"
                      defaultValue={description ?? ''}
                      aria-label={t('descriptionLabel')}
                      placeholder={t('descriptionPlaceholder')}
                      rows={3}
                      className={`${inputCls} h-auto min-h-[4.5rem] w-full resize-y`}
                    />
                  </Field>
                  <div className="col-span-full flex items-center gap-2">
                    <ConfirmSubmit
                      size="sm"
                      variant="default"
                      title={t('saveConfirmTitle')}
                      description={t('saveConfirmDescription')}
                      confirmLabel={t('saveConfirmConfirm')}
                    >
                      {t('save')}
                    </ConfirmSubmit>
                    {/* Save opens a confirmation; this leaves the edit without saving. Together they are the
                        "Save changes / Discard changes / Cancel" choice a7194511 built for the reporter. */}
                    <Button type="button" size="sm" variant="outline" onClick={() => setEditingName(false)}>
                      {t('discardChanges')}
                    </Button>
                  </div>
                </form>
              ) : (
                /* Closed: the type-level row. Rename opens the form above; archive / unarchive / delete post
                   their own actions and carry no tri-state marker, so they touch no configuration column. */
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span>{t('typeLabel')}</span>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditingName(true)}>
                    {t('rename')}
                  </Button>
                  {archived ? (
                    <form action={archiveTypeAction}>
                      <input type="hidden" name="id" value={id} />
                      <input type="hidden" name="archived" value="false" />
                      <Button type="submit" size="sm" variant="ghost">
                        {t('unarchive')}
                      </Button>
                    </form>
                  ) : inUse ? (
                    <form action={archiveTypeAction}>
                      <input type="hidden" name="id" value={id} />
                      <input type="hidden" name="archived" value="true" />
                      <Button type="submit" size="sm" variant="ghost">
                        {t('archive')}
                      </Button>
                    </form>
                  ) : (
                    <form action={deleteTypeAction}>
                      <input type="hidden" name="id" value={id} />
                      {/* The confirmation NAMES what a delete cascades rather than counting it, because one
                          branch of that cascade changes a leave type that is NOT being deleted. */}
                      <ConfirmSubmit
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        title={t('deleteTypeConfirmTitle')}
                        description={[
                          t('deleteTypeConfirmDescription'),
                          cascadeApprovalRules.length > 0
                            ? t('deleteTypeCascadeRules', { names: cascadeApprovalRules.join(', ') })
                            : null,
                          cascadeBalanceSourceOf.length > 0
                            ? t('deleteTypeCascadeBalanceSource', { names: cascadeBalanceSourceOf.join(', ') })
                            : null,
                        ]
                          .filter(Boolean)
                          .join('\n\n')}
                        confirmLabel={t('deleteConfirmLabel')}
                      >
                        {t('delete')}
                      </ConfirmSubmit>
                    </form>
                  )}
                </div>
              )}

              {/* F8 — the leave year cycle. Its own form and its own `yearCycle=1` marker: the cycle is
                  decided BEFORE the rules that operate inside it, and it is a property of the type. */}
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('subStep.yearType')}</span>
                <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
                  <input type="hidden" name="id" value={id} />
                  {/* preserve the name — this form does not edit it */}
                  <input type="hidden" name="name" value={name} />
                  {/* marker: tells the action to touch the year_cycle_override column (tri-state guard) */}
                  <input type="hidden" name="yearCycle" value="1" />
                  <Field label={t('subStep.yearTypeLabel')}>
                    <select
                      name="yearCycleValue"
                      defaultValue={
                        yearCycleOverride === 'a2a' || yearCycleOverride === 'c2c' || yearCycleOverride === 'a2c'
                          ? yearCycleOverride
                          : ''
                      }
                      aria-label={t('subStep.yearTypeLabel')}
                      className={cn(inputCls, 'w-72')}
                    >
                      {/* The blank option is kept deliberately: it is the state every type that has never
                          made an explicit choice is in. */}
                      <option value="">{t('subStep.yearTypeCompanyDefault')}</option>
                      <option value="a2a">{t('subStep.yearTypeA2a')}</option>
                      <option value="a2c">{t('subStep.yearTypeA2c')}</option>
                      <option value="c2c">{t('subStep.yearTypeC2c')}</option>
                    </select>
                  </Field>
                  <Button type="submit" size="sm">
                    {t('save')}
                  </Button>
                </form>
                <p className="text-xs text-muted-foreground">{t('subStep.yearTypeHelp')}</p>
              </div>

              {/* F27 — may an employee apply for this type. `visibility=1`. It no longer carries
                  visible_to_employee: the placement form below is that column's single writer. */}
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('visibility.sectionTitle')}</span>
                <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
                  <input type="hidden" name="id" value={id} />
                  {/* preserve the name — this form does not edit it */}
                  <input type="hidden" name="name" value={name} />
                  {/* marker: tells the action to touch employee_can_apply (tri-state guard) */}
                  <input type="hidden" name="visibility" value="1" />
                  {/* A DISABLED CHECKBOX POSTS NOTHING, and the action reads that absence as FALSE — so a
                      statutory type needs this hidden twin or its save is refused by the service guard. */}
                  {isStatutoryApply ? <input type="hidden" name="employeeCanApply" value="on" /> : null}
                  <label className="flex items-center gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      name="employeeCanApply"
                      defaultChecked={isStatutoryApply ? true : employeeCanApply !== false}
                      disabled={isStatutoryApply}
                      className="size-3.5 rounded border-border disabled:opacity-60"
                    />
                    {t('visibility.employeeCanApply')}
                  </label>
                  {isStatutoryApply ? (
                    <p className="text-xs text-amber-600 dark:text-amber-500">{t('visibility.statutoryLocked')}</p>
                  ) : null}
                  <Button type="submit" size="sm">
                    {t('save')}
                  </Button>
                </form>
                <p className="text-xs text-muted-foreground">{t('visibility.help')}</p>
              </div>

              {/* F28 — where the type sits on the employee's leave tab. `placement=1`. HIDDEN IS THE
                  SINGLE VISIBILITY SWITCH: choosing Hidden sets visible_to_employee=false, and this
                  sub-form is that column's ONLY writer on the screen. */}
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('placement.sectionTitle')}</span>
                <form
                  action={updateTypeAction}
                  className="flex flex-wrap items-end gap-2 rounded-lg bg-background p-3"
                >
                  <input type="hidden" name="id" value={id} />
                  {/* preserve the name — this form does not edit it */}
                  <input type="hidden" name="name" value={name} />
                  {/* marker: tells the action to touch ess_placement + the shared visibility flag */}
                  <input type="hidden" name="placement" value="1" />
                  <Field label={t('placement.label')}>
                    <select
                      name="placementValue"
                      defaultValue={resolvePlacement(code, essPlacement, visibleToEmployee, role)}
                      className={`${inputCls} w-40`}
                    >
                      {ESS_PLACEMENTS.map((pl) => (
                        <option key={pl} value={pl}>
                          {t(`placement.option.${pl}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Button type="submit" size="sm">
                    {t('save')}
                  </Button>
                </form>
                <p className="text-xs text-muted-foreground">{t('placement.help')}</p>
              </div>

              {/* F32 — colour + icon (`visual=1`). */}
              <LeaveVisualForm t={t} id={id} name={name} color={color} icon={icon} action={updateTypeAction} />

              {/* F30 (+F31) — the employee's Leave Summary: which lines they see and how each is
                  explained. TWO markers, one submit (`essView=1` + `formula=1`). */}
              <ViewConfigSection
                id={id}
                name={name}
                essViewConfig={essViewConfig}
                formulaExplanations={formulaExplanations}
                formulaTemplate={formulaTemplate}
                updateTypeAction={updateTypeAction}
              />

              {/* F39 — "Send to payroll module". IT ARRIVED HERE FROM THE PAYROLL IMPACT SCREEN because
                  it is a property of the leave type and every other per-type setting is on the type.
                  This is now the ONLY place it is editable: a6fe37fc Round 5 (737f4356) emptied
                  app/admin/leave/payroll/page.tsx into a redirect stub, so the second copy is gone and
                  the `payrollImpact=1` marker on `updateTypeAction` has one caller. */}
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('payrollPerTypeTitle')}</span>
                <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
                  <input type="hidden" name="id" value={id} />
                  {/* preserve the name — this form does not edit it */}
                  <input type="hidden" name="name" value={name} />
                  {/* marker: tells the action to touch send_to_payroll (tri-state guard) */}
                  <input type="hidden" name="payrollImpact" value="1" />
                  {/* derived, informational, NOT posted — reflects whether the type is paid */}
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input type="checkbox" checked={!paid} disabled className="size-3.5 rounded border-border" />
                    {t('affectsPayrollDeductionLabel')}
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-foreground">
                    <input
                      type="checkbox"
                      name="sendToPayroll"
                      defaultChecked={sendToPayroll}
                      className="size-3.5 rounded border-border"
                    />
                    {t('sendToPayrollLabel')}
                  </label>
                  <Button type="submit" size="sm">
                    {t('save')}
                  </Button>
                </form>
                <p className="text-xs text-muted-foreground">{t('affectsPayrollDeductionHelp')}</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── TAB 2 · Who is eligible ────────────────────────────────────────────────────────────── */}
        {activeTab === 'eligibility' && (
          <Card>
            <CardHeader>
              <CardTitle>{tTabs('tab.eligibility')}</CardTitle>
            </CardHeader>
            <CardContent id={`tab-eligibility-${id}`} className="space-y-3">
              <p className="text-xs text-muted-foreground">{tTabs('tabHint.eligibility')}</p>
              {/* F13 — the gate: gender, marital status, minimum service, probation and the eight
                  organisation-assignment axes. ONE form, ONE `eligibility=1` marker. Saving stays an
                  explicit Save: a mis-click quietly changing who may take leave is not worth one click. */}
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('eligibilityTitle')}</span>
                <form action={updateTypeAction} className="space-y-3 rounded-lg bg-background p-3">
                  <input type="hidden" name="id" value={id} />
                  {/* preserve the name — this form does not edit it */}
                  <input type="hidden" name="name" value={name} />
                  {/* marker: tells the action to touch the eligibility column (tri-state guard) */}
                  <input type="hidden" name="eligibility" value="1" />
                  <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {/* No <Field> wrapper on the chip pickers: ChipMultiSelect owns its caption, so no
                        <label> element exists to re-activate the trigger after an outside click. */}
                    <ChipMultiSelect
                      name="maritalStatus"
                      label={t('eligibilityMaritalLabel')}
                      options={withStored(
                        ELIGIBILITY_MARITAL_OPTIONS.map((m) => ({ value: m, label: maritalLabel(m) ?? m })),
                        asEligList(eligibility?.maritalStatus),
                      )}
                      defaultSelected={asEligList(eligibility?.maritalStatus)}
                      addPlaceholder={t('eligibilityChipAddPlaceholder')}
                      removeLabelFor={(label) => t('chipRemoveAria', { name: label })}
                    />
                    <ChipMultiSelect
                      name="gender"
                      label={t('eligibilityGenderLabel')}
                      options={withStored(
                        ELIGIBILITY_GENDER_OPTIONS.map((g) => ({ value: g, label: genderLabel(g) ?? g })),
                        asEligList(eligibility?.gender),
                      )}
                      defaultSelected={asEligList(eligibility?.gender)}
                      addPlaceholder={t('eligibilityChipAddPlaceholder')}
                      removeLabelFor={(label) => t('chipRemoveAria', { name: label })}
                    />
                    <Field label={t('eligibilityMinServiceLabel')}>
                      <div className="flex items-center gap-1.5">
                        <input
                          name="minServiceMonths"
                          type="number"
                          min="0"
                          step="1"
                          defaultValue={eligibility?.minServiceMonths ?? ''}
                          placeholder={t('eligibilityProbationNone')}
                          className={cn(inputCls, 'min-w-0 flex-1')}
                        />
                        {/* cn(), not a template string: `inputCls` ends in w-full and Tailwind resolves
                            same-property conflicts by stylesheet order, so a concatenated w-28 loses. */}
                        <select
                          name="minServiceUnit"
                          defaultValue={eligibility?.minServiceUnit ?? 'months'}
                          aria-label={t('eligibilityMinServiceUnitLabel')}
                          className={cn(inputCls, 'w-28 shrink-0')}
                        >
                          <option value="months">{t('expiryUnitMonths')}</option>
                          <option value="days">{t('expiryUnitDays')}</option>
                        </select>
                      </div>
                    </Field>
                    <Field label={t('eligibilityProbationLabel')}>
                      <select
                        name="probation"
                        defaultValue={probationEligibility ?? ''}
                        aria-label={t('eligibilityProbationLabel')}
                        className={inputCls}
                      >
                        <option value="">{t('eligibilityProbationNone')}</option>
                        <option value="confirmed_only">{t('eligibilityProbationConfirmedOnly')}</option>
                        <option value="probation_only">{t('eligibilityProbationProbationOnly')}</option>
                      </select>
                    </Field>
                    {/* One picker per org field, driven by the single ORG_ASSIGNMENT_CRITERIA descriptor.
                        Options are the ACTIVE catalogue values unioned with anything already stored. */}
                    {ORG_ASSIGNMENT_CRITERIA.map((c) => (
                      <ChipMultiSelect
                        key={c.key}
                        name={c.key}
                        label={tOrg(c.labelKey)}
                        options={orgCriterionOptions(c.category, c.key)}
                        defaultSelected={asEligList(eligibility?.[c.key])}
                        addPlaceholder={t('eligibilityChipAddPlaceholder')}
                        removeLabelFor={(label) => t('chipRemoveAria', { name: label })}
                      />
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">{t('eligibilityMultiHint')}</p>
                  <Button type="submit" size="sm">
                    {t('save')}
                  </Button>
                </form>
                <p className="text-xs text-muted-foreground">{t('eligibilityHelp')}</p>
                <p className="text-xs text-muted-foreground">{t('eligibilityUndisclosedNote')}</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── TAB 3 · What they are entitled to ──────────────────────────────────────────────────── */}
        {activeTab === 'entitlement' && (
          <Card>
            <CardHeader>
              <CardTitle>{tTabs('tab.entitlement')}</CardTitle>
            </CardHeader>
            <CardContent id={`tab-entitlement-${id}`} className="space-y-3">
              <p className="text-xs text-muted-foreground">{tTabs('tabHint.entitlement')}</p>
              {/* F9 — how days are earned, and how the figure is tidied. MOVED HERE from General setting:
                  this is the first half of "how many days" and the tables below are the second. */}
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('subStep.earning')}</span>
                <EarningMethodForm t={t} rules={rules} action={setTypeRulesAction} leaveTypeId={id} />
                <p className="text-xs text-muted-foreground">{t('subStep.earningHelp')}</p>
              </div>
              {/* F10 — carry forward, moved here for the same reason. */}
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('subStep.carry')}</span>
                <CarryPolicyForm t={t} rules={rules} action={setTypeRulesAction} leaveTypeId={id} />
                <p className="text-xs text-muted-foreground">{t('subStep.carryStepHelp')}</p>
              </div>
              {/* F11 — the tables themselves and the rules that say who receives them, filtered to this
                  type. The SAME shared block the all-types screen mounts (IA §2.3), which also renders
                  this type's health finding. Each server-composed slot is the SOLE child of its wrapper:
                  two key-less page-created elements in one child array is a React key warning. */}
              <div>{entitlementTablesSection}</div>
              {/* F20 F21 F22 — the BALANCE rules. They were on the old Condition step's application-rule
                  grid; they are not application rules, they are what an application is measured against. */}
              <div className="space-y-2 rounded-lg border border-border bg-background p-3">
                <span className="text-xs font-medium text-muted-foreground">{t('negativeBalanceSectionTitle')}</span>
                <NegativeBalanceForm
                  t={t}
                  id={id}
                  name={name}
                  allowNegativeBalance={allowNegativeBalance}
                  maxNegativeBalance={maxNegativeBalance}
                  action={updateTypeAction}
                />
                <p className="text-xs text-muted-foreground">{t('negativeBalanceHelp')}</p>
              </div>
              <div className="rounded-lg border border-border bg-background p-3">
                <BalanceSourceForm
                  t={t}
                  id={id}
                  name={name}
                  balanceSourceTypeId={balanceSourceTypeId}
                  options={balanceSourceOptions}
                  action={updateTypeAction}
                />
              </div>
              <div className="space-y-1.5 rounded-lg border border-border bg-background p-3">
                <span className="text-xs font-medium text-muted-foreground">{t('allowUplSectionTitle')}</span>
                <form action={updateTypeAction} className="space-y-2">
                  <input type="hidden" name="id" value={id} />
                  {/* preserve the name — this form does not edit it */}
                  <input type="hidden" name="name" value={name} />
                  {/* marker: tells the action to touch the allow_unpaid_leave column (tri-state guard) */}
                  <input type="hidden" name="allowUpl" value="1" />
                  <span className="text-xs font-medium text-foreground">{t('allowUplLabel')}</span>
                  <div className="space-y-1.5">
                    {(['no', 'yes'] as const).map((opt) => (
                      <label key={opt} className="flex items-start gap-2 text-xs text-foreground">
                        <input
                          type="radio"
                          name="allowUnpaidLeaveValue"
                          value={opt}
                          defaultChecked={opt === (allowUnpaidLeave ? 'yes' : 'no')}
                          className="mt-0.5 size-3.5 border-border"
                        />
                        <span>{opt === 'yes' ? t('allowUplYes') : t('allowUplNo')}</span>
                      </label>
                    ))}
                  </div>
                  <Button type="submit" size="sm">
                    {t('save')}
                  </Button>
                </form>
                <p className="text-xs text-muted-foreground">{t('allowUplHelp')}</p>
              </div>
              {/* F12 — Run Earned Accrual. It PROCESSES entitlement rather than defining it, so it sits
                  last; this and the old screen's Entitlement step are its only mounts. */}
              <div>{accrualSection}</div>
            </CardContent>
          </Card>
        )}

        {/* ── TAB 4 · How it is applied for ──────────────────────────────────────────────────────── */}
        {activeTab === 'application' && (
          <Card>
            <CardHeader>
              <CardTitle>{tTabs('tab.application')}</CardTitle>
            </CardHeader>
            <CardContent id={`tab-application-${id}`} className="space-y-3">
              <p className="text-xs text-muted-foreground">{tTabs('tabHint.application')}</p>
              {/* A multi-column flow rather than a grid: a grid row is as tall as its tallest card, which
                  stranded empty space under the short ones. Each card carries `break-inside-avoid`. */}
              <div className="columns-1 gap-3 md:columns-2 xl:columns-3">
                {/* F14 — allowed durations (full day is always available). `durations=1`. */}
                <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
                  <span className="text-xs font-medium text-muted-foreground">{t('allowedDurationsLabel')}</span>
                  <form action={updateTypeAction} className="space-y-2">
                    <input type="hidden" name="id" value={id} />
                    {/* preserve the name — this form does not edit it */}
                    <input type="hidden" name="name" value={name} />
                    {/* marker: tells the action to touch the durations column (tri-state guard) */}
                    <input type="hidden" name="durations" value="1" />
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input type="checkbox" checked disabled className="size-3.5 rounded border-border" />
                      {t('duration_full_day')}
                    </label>
                    {DURATION_OPTIONS.map((d) => (
                      <label key={d} className="flex items-center gap-2 text-xs text-foreground">
                        <input
                          type="checkbox"
                          name="duration"
                          value={d}
                          defaultChecked={durations?.includes(d) ?? false}
                          className="size-3.5 rounded border-border"
                        />
                        {t(`duration_${d}`)}
                      </label>
                    ))}
                    <Button type="submit" size="sm">
                      {t('save')}
                    </Button>
                  </form>
                  <p className="text-xs text-muted-foreground">{t('allowedDurationsHelp')}</p>
                </div>

                {/* F15 — supporting document. `document=1`. */}
                <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
                  <span className="text-xs font-medium text-muted-foreground">{t('documentSectionTitle')}</span>
                  <form action={updateTypeAction} className="space-y-2">
                    <input type="hidden" name="id" value={id} />
                    {/* preserve the name — this form does not edit it */}
                    <input type="hidden" name="name" value={name} />
                    {/* marker: tells the action to touch the document columns (tri-state guard) */}
                    <input type="hidden" name="document" value="1" />
                    <label className="flex items-center gap-2 text-xs text-foreground">
                      <input
                        type="checkbox"
                        name="requiresDocument"
                        defaultChecked={requiresDocument}
                        className="size-3.5 rounded border-border"
                      />
                      {t('requireAttachmentLabel')}
                    </label>
                    <Field label={t('mandatoryAfterDaysLabel')}>
                      <input
                        name="mandatoryAfterDays"
                        type="number"
                        min="0"
                        step="1"
                        defaultValue={mandatoryAfterDays ?? ''}
                        className={`${inputCls} w-full`}
                      />
                    </Field>
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">{t('allowedFileTypesLabel')}</span>
                      <div className="flex flex-wrap gap-3">
                        {DOC_MIME_OPTIONS.map((o) => (
                          <label key={o.mime} className="flex items-center gap-1.5 text-xs text-foreground">
                            <input
                              type="checkbox"
                              name="allowedMimeType"
                              value={o.mime}
                              defaultChecked={allowedMimeTypes?.includes(o.mime) ?? false}
                              className="size-3.5 rounded border-border"
                            />
                            {t(o.label)}
                          </label>
                        ))}
                      </div>
                    </div>
                    <Field label={t('maxFileSizeLabel')}>
                      <input
                        name="maxFileSizeMb"
                        type="number"
                        min="1"
                        max="10"
                        step="1"
                        defaultValue={Math.round(maxDocBytes / (1024 * 1024))}
                        className={`${inputCls} w-full`}
                      />
                    </Field>
                    <label className="flex items-center gap-2 text-xs text-foreground">
                      <input
                        type="checkbox"
                        name="employeeRemarkRequired"
                        defaultChecked={employeeRemarkRequired}
                        className="size-3.5 rounded border-border"
                      />
                      {t('employeeRemarkRequiredLabel')}
                    </label>
                    <label className="flex items-center gap-2 text-xs text-foreground">
                      <input
                        type="checkbox"
                        name="hrRemarkRequired"
                        defaultChecked={hrRemarkRequired}
                        className="size-3.5 rounded border-border"
                      />
                      {t('hrRemarkRequiredLabel')}
                    </label>
                    <Button type="submit" size="sm">
                      {t('saveDocumentRule')}
                    </Button>
                  </form>
                  <p className="text-xs text-muted-foreground">{t('documentSectionHelp')}</p>
                </div>

                {/* F18 — how much of this type in a YEAR. `applicationLimits=1`. */}
                <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('conditionStep.applicationLimitsTitle')}
                  </span>
                  <ApplicationLimitsForm
                    t={t}
                    id={id}
                    name={name}
                    maxDaysPerLeaveYear={maxDaysPerLeaveYear}
                    maxDaysPeriod={maxDaysPeriod}
                    action={updateTypeAction}
                  />
                  <p className="text-xs text-muted-foreground">{t('conditionStep.applicationLimitHelp')}</p>
                </div>

                {/* F19 — how much in ONE GO, and the unit it is read in. `maxConsecutive=1`. */}
                <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('conditionStep.maxConsecutiveTitle')}
                  </span>
                  <MaxConsecutiveForm
                    t={t}
                    id={id}
                    name={name}
                    maxConsecutiveDays={maxConsecutiveDays}
                    maxConsecutiveUnit={maxConsecutiveUnit}
                    action={updateTypeAction}
                  />
                  <p className="text-xs text-muted-foreground">{t('conditionStep.maxConsecutiveHelp')}</p>
                </div>

                {/* F16 (+F29) — backdating, with its custom message. `backdating=1`. Hidden for Emergency
                    Leave: EL is inherently retroactive and is never guarded, so the field would be a
                    value HR could set and the engine would ignore. THE MESSAGE STAYS INSIDE THIS FORM —
                    the action writes customMessages.backdatingLimitDays only when THIS marker is present,
                    so a separate wording card would have to carry the marker and would then clear the
                    limit it does not render. */}
                {code !== 'EMERGENCY' && (
                  <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
                    <span className="text-xs font-medium text-muted-foreground">{t('backdatingSectionTitle')}</span>
                    <form action={updateTypeAction} className="space-y-2">
                      <input type="hidden" name="id" value={id} />
                      {/* preserve the name — this form does not edit it */}
                      <input type="hidden" name="name" value={name} />
                      {/* marker: tells the action to touch backdating_limit_days (tri-state guard) */}
                      <input type="hidden" name="backdating" value="1" />
                      <Field label={t('backdatingLimitDaysLabel')}>
                        <input
                          name="backdatingLimitDays"
                          type="number"
                          min="0"
                          step="1"
                          defaultValue={backdatingLimitDays ?? ''}
                          className={`${inputCls} w-full`}
                        />
                      </Field>
                      <Field label={t('customMessageLabel')}>
                        <textarea
                          name="customMessageBackdating"
                          maxLength={500}
                          rows={2}
                          defaultValue={customMessages?.backdatingLimitDays ?? ''}
                          placeholder={t('customMessagePlaceholder')}
                          className={inputCls}
                        />
                      </Field>
                      <p className="text-xs text-muted-foreground">{t('customMessageHelp')}</p>
                      <Button type="submit" size="sm">
                        {t('save')}
                      </Button>
                    </form>
                    <p className="text-xs text-muted-foreground">{t('backdatingSectionHelp')}</p>
                  </div>
                )}

                {/* F17 (+F29) — advance notice, its unit and its custom message. `minAdvance=1`. Hidden
                    for Emergency Leave for the same reason as backdating. */}
                {code !== 'EMERGENCY' && (
                  <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
                    <span className="text-xs font-medium text-muted-foreground">{t('advanceNoticeSectionTitle')}</span>
                    <form action={updateTypeAction} className="space-y-2">
                      <input type="hidden" name="id" value={id} />
                      {/* preserve the name — this form does not edit it */}
                      <input type="hidden" name="name" value={name} />
                      {/* marker: tells the action to touch min_advance_days (tri-state guard) */}
                      <input type="hidden" name="minAdvance" value="1" />
                      <Field label={t('minAdvanceDaysLabel')}>
                        <input
                          name="minAdvanceDays"
                          type="number"
                          min="0"
                          step="1"
                          defaultValue={minAdvanceDays ?? ''}
                          className={`${inputCls} w-full`}
                        />
                      </Field>
                      {/* REUSES the two option labels Maximum Consecutive Leave already offers, so the
                          same choice never reads as two different ones on one screen. */}
                      <Field label={t('minAdvanceDayTypeLabel')}>
                        <select
                          name="minAdvanceDayType"
                          defaultValue={minAdvanceDayType ?? 'calendar_days'}
                          className={`${inputCls} w-full`}
                        >
                          <option value="calendar_days">{t('conditionStep.maxConsecutiveUnitCalendar')}</option>
                          <option value="working_days">{t('conditionStep.maxConsecutiveUnitWorking')}</option>
                        </select>
                      </Field>
                      <p className="text-xs text-muted-foreground">{t('minAdvanceDayTypeHelp')}</p>
                      <Field label={t('customMessageLabel')}>
                        <textarea
                          name="customMessageMinAdvance"
                          maxLength={500}
                          rows={2}
                          defaultValue={customMessages?.minAdvanceDays ?? ''}
                          placeholder={t('customMessagePlaceholder')}
                          className={inputCls}
                        />
                      </Field>
                      <p className="text-xs text-muted-foreground">{t('advanceCustomMessageHelp')}</p>
                      <Button type="submit" size="sm">
                        {t('save')}
                      </Button>
                    </form>
                    <p className="text-xs text-muted-foreground">{t('advanceNoticeSectionHelp')}</p>
                  </div>
                )}

                {/* F25 — what happens when one of the rules above is not met. `overrideRules=1`, and the
                    whole set is REPLACED on save (a partial write is how a rule HR believes they turned
                    off stays on). The two triggers are the closed set core/leave.ts already detects. */}
                <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
                  <span className="text-xs font-medium text-muted-foreground">{t('overrideSectionTitle')}</span>
                  <form action={updateTypeAction} className="space-y-2">
                    <input type="hidden" name="id" value={id} />
                    {/* preserve the name — this form does not edit it */}
                    <input type="hidden" name="name" value={name} />
                    {/* marker: tells the action to touch the override_rules column (tri-state guard) */}
                    <input type="hidden" name="overrideRules" value="1" />
                    {(
                      [
                        { trigger: 'advance_notice_not_met', actions: ['convert_to_emergency', 'block'] },
                        { trigger: 'insufficient_balance', actions: ['split_unpaid', 'block'] },
                      ] as const
                    ).map((row) => {
                      const stored = (overrideRules ?? []).find((r) => r.trigger === row.trigger);
                      const actions: readonly string[] = row.actions;
                      const currentAction = actions.includes(stored?.action ?? '') ? (stored!.action as string) : '';
                      return (
                        <div
                          key={row.trigger}
                          className="space-y-1.5 border-t border-border pt-2 first:border-t-0 first:pt-0"
                        >
                          <Field label={t(`overrideTrigger.${row.trigger}`)}>
                            <select
                              name={`override_${row.trigger}`}
                              defaultValue={currentAction}
                              aria-label={t(`overrideTrigger.${row.trigger}`)}
                              className={`${inputCls} w-full`}
                            >
                              <option value="">{t('overrideActionNone')}</option>
                              {row.actions.map((a) => (
                                <option key={a} value={a}>
                                  {t(`overrideAction.${a}`)}
                                </option>
                              ))}
                            </select>
                          </Field>
                          {/* DEFAULT OFF. An unticked box does not post, and the action reads absent as
                              enabled:false — configuring a rule and enabling it are two acts. */}
                          <label className="flex items-start gap-2 text-xs text-foreground">
                            <input
                              type="checkbox"
                              name={`overrideOn_${row.trigger}`}
                              defaultChecked={stored?.enabled === true}
                              className="mt-0.5 size-3.5 rounded border-border"
                            />
                            <span>{t('overrideEnabledLabel')}</span>
                          </label>
                        </div>
                      );
                    })}
                    <Button type="submit" size="sm">
                      {t('save')}
                    </Button>
                  </form>
                  <p className="text-xs text-muted-foreground">{t('overrideSectionHelp')}</p>
                </div>

                {/* F23 — may an employee double-book a date. `duplicatePolicy=1`. */}
                <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
                  <span className="text-xs font-medium text-muted-foreground">{t('duplicatePolicySectionTitle')}</span>
                  <form action={updateTypeAction} className="space-y-2">
                    <input type="hidden" name="id" value={id} />
                    {/* preserve the name — this form does not edit it */}
                    <input type="hidden" name="name" value={name} />
                    {/* marker: tells the action to touch duplicate_application_policy (tri-state guard) */}
                    <input type="hidden" name="duplicatePolicy" value="1" />
                    <div className="space-y-1.5">
                      {(['allow', 'restrict_same', 'restrict_any'] as const).map((opt) => {
                        const current = ['allow', 'restrict_same', 'restrict_any'].includes(
                          duplicateApplicationPolicy ?? '',
                        )
                          ? (duplicateApplicationPolicy as string)
                          : 'allow';
                        return (
                          <label key={opt} className="flex items-start gap-2 text-xs text-foreground">
                            <input
                              type="radio"
                              name="duplicatePolicyValue"
                              value={opt}
                              defaultChecked={current === opt}
                              className="mt-0.5 size-3.5 border-border"
                            />
                            <span>
                              {opt === 'allow'
                                ? t('duplicatePolicyAllow')
                                : opt === 'restrict_same'
                                  ? t('duplicatePolicyRestrictSame')
                                  : t('duplicatePolicyRestrictAny')}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    <Button type="submit" size="sm">
                      {t('save')}
                    </Button>
                  </form>
                  <p className="text-xs text-muted-foreground">{t('duplicatePolicyHelp')}</p>
                </div>

                {/* F24 — which day types are counted when a leave's duration is calculated.
                    `dayTypeInclusion=1`. Always editable here: the old screen put a summary behind an
                    Edit button, which is the extra click #165baee5 removed from the criteria form. */}
                <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('dayTypeInclusion.sectionTitle')}
                  </span>
                  <form action={updateTypeAction} className="space-y-2">
                    <input type="hidden" name="id" value={id} />
                    {/* preserve the name — this form does not edit it */}
                    <input type="hidden" name="name" value={name} />
                    {/* marker: tells the action to touch day_type_inclusion (tri-state guard) */}
                    <input type="hidden" name="dayTypeInclusion" value="1" />
                    <div className="flex flex-col gap-1.5">
                      {DAY_TYPE_INCLUSION_OPTIONS.map((k) => (
                        <label key={k} className="flex items-center gap-2 text-xs text-foreground">
                          <input
                            type="checkbox"
                            name={`dayType_${k}`}
                            defaultChecked={dayTypeInclusion?.[k] === true}
                            className="size-3.5 rounded border-border"
                          />
                          {dayTypeLabel(k)}
                        </label>
                      ))}
                    </div>
                    <Button type="submit" size="sm">
                      {t('save')}
                    </Button>
                  </form>
                  <p className="text-xs text-muted-foreground">{t('dayTypeInclusion.help')}</p>
                  <p className="text-xs text-muted-foreground">{t('dayTypeInclusion.statutoryNote')}</p>
                </div>

                {/* F29 — the message an employee sees on the apply form. `applyNotice=1`. It is about
                    applying, so it lands here rather than in the old Custom Settings step. */}
                <div className="mb-3 break-inside-avoid space-y-2 rounded-lg border border-border bg-background p-3">
                  <span className="text-xs font-medium text-muted-foreground">{t('applyNoticeSectionTitle')}</span>
                  <form action={updateTypeAction} className="space-y-2">
                    <input type="hidden" name="id" value={id} />
                    {/* preserve the name — this form does not edit it */}
                    <input type="hidden" name="name" value={name} />
                    {/* marker: tells the action to touch the applyNotice custom-message key (tri-state) */}
                    <input type="hidden" name="applyNotice" value="1" />
                    <label className="flex items-center gap-2 text-xs text-foreground">
                      <input
                        type="checkbox"
                        name="enableApplyNotice"
                        checked={applyNoticeEnabled}
                        onChange={(e) => setApplyNoticeEnabled(e.target.checked)}
                        className="size-3.5 rounded border-border"
                      />
                      {t('applyNoticeEnableLabel')}
                    </label>
                    {applyNoticeEnabled && (
                      <textarea
                        name="customMessageApplyNotice"
                        maxLength={500}
                        rows={3}
                        defaultValue={customMessages?.applyNotice ?? ''}
                        placeholder={t('applyNoticePlaceholder')}
                        className={inputCls}
                      />
                    )}
                    <Button type="submit" size="sm">
                      {t('save')}
                    </Button>
                  </form>
                  <p className="text-xs text-muted-foreground">{t('applyNoticeHelp')}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── TAB 5 · Who approves it ────────────────────────────────────────────────────────────── */}
        {activeTab === 'approvers' && (
          <Card>
            <CardHeader>
              <CardTitle>{tTabs('tab.approvers')}</CardTitle>
            </CardHeader>
            <CardContent id={`tab-approvers-${id}`} className="space-y-3">
              <p className="text-xs text-muted-foreground">{tTabs('tabHint.approvers')}</p>
              {/* a6fe37fc ROUND 4 — THE READ-OUT ROUND 2 DEFERRED, and the reason this tab can answer
                  its own title. Server-composed above (app/admin/leave-config/approval-readout.tsx):
                  which chain reaches this leave type, where it came from, its ordered steps, the
                  escalation, and how many other rules can route a particular employee elsewhere.
                  READ-ONLY — every control that CHANGES a chain is on Approval chains, which it links
                  to. It sits FIRST because it is the question the tab is named after; the per-date
                  switch below is a property of the leave type, not of the chain. */}
              {approvalReadoutSection}
              {/* F7 — per-date (partial) approval. IT ARRIVES HERE FROM *General setting*, where it sat
                  four steps from anything else about approval, and it is genuinely a property of the
                  leave type. Same form, same `partialApproval=1` marker, same column. The old screen
                  KEEPS ITS COPY this round; Round 5 is where it stops being editable in two places. */}
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('partialApprovalSectionTitle')}</span>
                <form action={updateTypeAction} className="space-y-2 rounded-lg bg-background p-3">
                  <input type="hidden" name="id" value={id} />
                  {/* preserve the name — this form does not edit it */}
                  <input type="hidden" name="name" value={name} />
                  {/* marker: tells the action to touch the per_date_approval column (tri-state guard) */}
                  <input type="hidden" name="partialApproval" value="1" />
                  <label className="flex items-center gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      name="perDateApproval"
                      defaultChecked={perDateApproval}
                      className="size-3.5 rounded border-border"
                    />
                    {t('perDateApprovalLabel')}
                  </label>
                  {/* The type is structurally ineligible (REPLACEMENT or calendar-counted), so the flag
                      has no effect even when set. Said out loud rather than silently ignored. */}
                  {(code === 'REPLACEMENT' || counting !== 'working_days') && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {code === 'REPLACEMENT'
                        ? t('perDateApprovalNoteReplacement')
                        : t('perDateApprovalNoteCounting')}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">{t('perDateApprovalMultiStepNote')}</p>
                  <Button type="submit" size="sm">
                    {t('save')}
                  </Button>
                </form>
                <p className="text-xs text-muted-foreground">{t('perDateApprovalHelp')}</p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
