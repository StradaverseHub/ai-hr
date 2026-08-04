'use client';

/**
 * The Create New Employee wizard (item 6d671f44).
 *
 * FIVE STEPS: Profile · Employment · Bank & Statutory · Payroll · Review. Each step shows a tick when
 * it has everything it needs and a warning when it does not, computed by ONE shared rule
 * (`lib/employee-draft-schema` `missingByStep`) that the server re-runs before it will create anything.
 *
 * SAVE DRAFT works from any step and does not validate — that is the entire point of a draft. Only
 * "Create Employee" validates, and only then does anything exist.
 *
 * COMPANY IS ASKED FIRST (item bd271009). It used to sit on the Employment step, one screen after the
 * Employee ID — so at the moment the wizard asked for an ID it could not yet say which company's Employee
 * ID Auto Running Number Setup applied. Company now leads the Profile step and is READ-ONLY on Employment;
 * the state, the handler and the org cascade below are untouched, only the step that asks moved. Under it
 * sits the rule for the chosen company, an Auto / Manual choice that collapses to a single fixed mode when
 * the rule leaves no choice, and a preview of the ID that would be issued.
 *
 * THE ORG CASCADE MOVED HERE, IT WAS NOT REWRITTEN. The old inline hire form narrowed Business Unit /
 * Department / Position / Cost Centre by the chosen company using a pure-DOM inline script that
 * embedded `hireOptionVisible` via `Function.prototype.toString`. In a client component the same pure
 * rule can simply be called, so the script is gone and the rule is not duplicated. The server-side
 * `CrossCompanyError` guard in `core/org.ts` remains the last line of defence, exactly as before.
 */

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, AlertCircle } from 'lucide-react';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { hireOptionVisible } from '@/lib/hire-form-filter';
import {
  DRAFT_STEPS,
  missingByStep,
  missingForCreation,
  stepKey,
  type DraftStepKey,
  type EmployeeDraftData,
  type MissingOptions,
} from '@/lib/employee-draft-schema';
import { resolveEmployeeIdMode, type EmployeeIdRule } from '@/lib/employee-id-mode';
import {
  saveDraftAction,
  discardDraftAction,
  createEmployeeAction,
  checkEmployeeCodeAction,
} from './actions';

type Option = { id: string; label: string; companies?: string; businessUnitId?: string; buCompanies?: string };
type DraftSummary = {
  id: string;
  label: string;
  companyName: string | null;
  currentStep: number;
  createdByName: string | null;
  updatedAt: string;
  missingCount: number;
};

export function EmployeeWizard({
  today,
  draftId,
  initialData,
  initialStep,
  drafts,
  companies,
  businessUnits,
  departments,
  positions,
  costCenters,
  grades,
  managers,
  probationDefaults,
  employeeIdRules,
}: {
  today: string;
  draftId: string | null;
  initialData: EmployeeDraftData;
  initialStep: number;
  drafts: DraftSummary[];
  companies: Option[];
  businessUnits: Option[];
  departments: Option[];
  positions: Option[];
  costCenters: Option[];
  grades: Option[];
  managers: Option[];
  probationDefaults: Record<string, string>;
  /** Item bd271009 — the Employee ID rule per company, PLAIN DATA (see the page's boundary note). */
  employeeIdRules: Record<string, EmployeeIdRule>;
}) {
  const t = useTranslations('people.wizard');
  const router = useRouter();
  const [id, setId] = useState<string | null>(draftId);
  const [data, setData] = useState<EmployeeDraftData>(initialData);
  const [step, setStep] = useState<DraftStepKey>(stepKey(initialStep));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  // The Business Unit is a FILTER on the department list, not a stored field — the assignment writer
  // takes a department, and the department carries its own BU. Kept in component state, never in the
  // draft, so a saved draft cannot carry a value nothing will ever read.
  const [businessUnitId, setBusinessUnitId] = useState('');

  // Item bd271009 — the on-blur duplicate look-ahead. `null` means "nothing to say"; a value is the
  // clashing code, named back to HR verbatim.
  const [dupCode, setDupCode] = useState<string | null>(null);
  const [freeCode, setFreeCode] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const companyId = data.employment?.companyId ?? '';
  const employeeCode = data.profile?.employeeCode ?? '';
  // 8590615a — the single provisional/lifecycle end date the wizard captures MEANS the contract end date
  // when the hire is a contract hire, so it is labelled that way (the field itself is unchanged). Mirrors
  // the same 'full_time' default the probation-default logic in chooseCompany uses.
  const isContractHire = (data.employment?.employmentType ?? 'full_time') === 'contract';

  // The Employee ID rule for the CHOSEN company, and the decision it produces. The option is passed to
  // the completeness rules only once a company is known — before that there is no rule to judge the ID
  // by, and the server makes the identical distinction in `completeEmployeeDraft`.
  const rule: EmployeeIdRule | null = companyId ? (employeeIdRules[companyId] ?? null) : null;
  const missingOpts: MissingOptions = useMemo(
    () => (companyId ? { employeeIdRule: rule } : {}),
    [companyId, rule],
  );
  const decision = useMemo(
    () =>
      resolveEmployeeIdMode(rule, {
        chosen: data.profile?.employeeIdMode,
        hasCode: employeeCode.trim() !== '',
      }),
    [rule, data.profile?.employeeIdMode, employeeCode],
  );

  const missing = useMemo(() => missingByStep(data, missingOpts), [data, missingOpts]);
  const outstanding = useMemo(() => missingForCreation(data, missingOpts), [data, missingOpts]);

  const set = <K extends keyof EmployeeDraftData>(section: K, patch: Partial<NonNullable<EmployeeDraftData[K]>>) => {
    setSaved(false);
    setData((d) => ({ ...d, [section]: { ...(d[section] ?? {}), ...patch } }));
  };

  /** Company change self-heals every dependent pick, so a stale cross-company selection can never be
   *  submitted. Mirrors what the old inline script did by clearing hidden options back to placeholder. */
  const chooseCompany = (next: string) => {
    setBusinessUnitId('');
    setSaved(false);
    setDupCode(null);
    setFreeCode(null);
    setData((d) => {
      const e = { ...(d.employment ?? {}) };
      e.companyId = next;
      e.departmentId = '';
      e.positionId = '';
      e.costCenterId = '';
      // Item bd271009 — the new company may FORBID hand-keying. Drop the typed ID here rather than
      // carrying it silently to a server refusal for a field the screen no longer shows.
      const nextRule = employeeIdRules[next] ?? null;
      const p = { ...(d.profile ?? {}) };
      if (nextRule?.hasConfig && !nextRule.allowManualOverride) p.employeeCode = '';
      // Only fill the probation default when the field is untouched or was another company's default.
      const wasDefault = !e.provisionalEndOn || Object.values(probationDefaults).includes(e.provisionalEndOn);
      if ((e.employmentType ?? 'full_time') === 'full_time' && wasDefault) {
        e.provisionalEndOn = probationDefaults[next] ?? '';
      }
      return { ...d, employment: e, profile: p };
    });
  };

  /** The Auto / Manual pick. Switching to Auto keeps whatever was typed (so switching back does not lose
   *  it) — `completeEmployeeDraft` ignores a code the chosen mode does not use. */
  const chooseMode = (mode: 'auto' | 'manual') => {
    setDupCode(null);
    setFreeCode(null);
    set('profile', { employeeIdMode: mode });
  };

  /** Look ahead for a clash while HR is still in the field. Advisory — the create re-checks. */
  const checkCode = (raw: string) => {
    const code = raw.trim();
    setDupCode(null);
    setFreeCode(null);
    if (code === '') return;
    setChecking(true);
    void checkEmployeeCodeAction(code)
      .then((res) => {
        if (res.taken) setDupCode(res.code);
        else setFreeCode(res.code);
      })
      .catch(() => {
        /* Advisory only: a failed look-ahead must never block typing. The create still refuses. */
      })
      .finally(() => setChecking(false));
  };

  const visible = (o: Option, withBu: boolean) =>
    hireOptionVisible({
      optCompanies: o.companies ?? '',
      optBusinessUnit: withBu ? (o.businessUnitId ?? '') : null,
      optBuCompanies: o.buCompanies ?? '',
      selectedCompany: companyId,
      selectedBusinessUnit: withBu ? businessUnitId : '',
    });

  /** Zero-visible-options empty state (feedback d61f0ff2), carried over from the old inline form: a
   *  select whose company may use NONE of its options says so, instead of presenting a bare
   *  placeholder that reads as a bug. */
  const orgEmpty = (opts: Option[]) =>
    companyId !== '' && opts.length > 0 && opts.every((o) => !visible(o, false));

  const saveDraft = (nextStep?: DraftStepKey) =>
    startTransition(async () => {
      setError(null);
      try {
        const res = await saveDraftAction(id ?? undefined, data, DRAFT_STEPS.indexOf(nextStep ?? step) + 1);
        setId(res.id);
        setSaved(true);
        if (nextStep) setStep(nextStep);
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const discard = () =>
    startTransition(async () => {
      setError(null);
      try {
        if (id) await discardDraftAction(id);
        router.push('/admin/personnel');
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const create = () =>
    startTransition(async () => {
      setError(null);
      try {
        const res = await createEmployeeAction(id ?? undefined, data);
        router.push(`/admin/personnel/${res.employmentId}?from=personnel`);
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const stepIndex = DRAFT_STEPS.indexOf(step);
  const go = (delta: number) => {
    const next = DRAFT_STEPS[Math.min(Math.max(stepIndex + delta, 0), DRAFT_STEPS.length - 1)];
    setStep(next);
  };

  return (
    <div className="space-y-6">
      {/* Continue a draft. Shown only when starting fresh — once a draft is open, the list would just
          be a way to lose the work on screen. */}
      {!id && drafts.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3 text-sm font-semibold">
            {t('continueDraft', { count: drafts.length })}
          </div>
          <ul className="divide-y divide-border">
            {drafts.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <div className="font-medium">{d.label || t('untitledDraft')}</div>
                  <div className="text-xs text-muted-foreground">
                    {[
                      d.companyName,
                      t('stepOf', { current: d.currentStep, total: DRAFT_STEPS.length }),
                      d.missingCount > 0 ? t('missingCount', { count: d.missingCount }) : t('readyToCreate'),
                      t('lastSaved', { when: d.updatedAt.slice(0, 10) }),
                      d.createdByName ? t('startedBy', { name: d.createdByName }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <Link
                  href={`/admin/personnel/new?draft=${d.id}`}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
                >
                  {t('continue')}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Progress strip. A step is complete when its own required fields are satisfied — the same rule
          the server enforces, so a tick can never promise something creation will refuse. */}
      <nav aria-label={t('progressLabel')} className="flex flex-wrap gap-2">
        {DRAFT_STEPS.map((k, i) => {
          const done = missing[k].length === 0 && k !== 'review';
          const current = k === step;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setStep(k)}
              aria-current={current ? 'step' : undefined}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                current ? 'border-primary bg-primary/5 font-medium' : 'border-border hover:bg-muted'
              }`}
            >
              <span className="text-xs tabular-nums text-muted-foreground">{i + 1}</span>
              {t(`steps.${k}`)}
              {done && <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />}
              {!done && k !== 'review' && (
                <AlertCircle className="size-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
              )}
            </button>
          );
        })}
      </nav>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      <Card className="p-5">
        {step === 'profile' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* COMPANY IS THE FIRST QUESTION (item bd271009). It used to be asked on the Employment
                step, one screen AFTER the Employee ID — so the wizard could not name the numbering rule
                at the moment it was asking about the number. Same state, same self-healing handler; only
                the step that asks moved. */}
            <Field label={t('fields.company')} className="sm:col-span-2">
              <select className={inputCls} value={companyId} onChange={(e) => chooseCompany(e.target.value)}>
                <option value="">{t('selectPrompt')}</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">{t('hints.company')}</p>
            </Field>

            {/* The Employee ID, explained where it is asked. */}
            <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4 sm:col-span-2">
              <div className="text-sm font-medium">{t('employeeId.heading')}</div>

              {!companyId && <p className="text-xs text-muted-foreground">{t('employeeId.chooseCompanyFirst')}</p>}

              {companyId && !rule?.hasConfig && (
                <p className="text-xs text-amber-700 dark:text-amber-400">{t('employeeId.noSetup')}</p>
              )}

              {companyId && rule?.hasConfig && (
                <p className="text-xs text-muted-foreground">
                  {rule.scope === 'company'
                    ? t('employeeId.ruleCompany', { sample: rule.sampleCode || rule.prefix })
                    : t('employeeId.ruleGlobal', { sample: rule.sampleCode || rule.prefix })}
                </p>
              )}

              {/* The choice, or the single fixed mode when the rule takes the choice away. */}
              {companyId && decision.choosable && (
                <fieldset>
                  <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
                    {t('employeeId.modeLabel')}
                  </legend>
                  <div className="flex flex-wrap gap-4">
                    {(['auto', 'manual'] as const).map((m) => (
                      <label key={m} className="flex items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name="employeeIdMode"
                          className="size-4 accent-primary"
                          checked={decision.mode === m}
                          onChange={() => chooseMode(m)}
                        />
                        {m === 'auto' ? t('employeeId.modeAuto') : t('employeeId.modeManual')}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              {companyId && decision.forcedBecause === 'manualNotAllowed' && (
                <p className="text-xs text-muted-foreground">{t('employeeId.forcedAuto')}</p>
              )}

              {/* Auto: show what the ID will look like, and say plainly that it is a sample. */}
              {companyId && decision.mode === 'auto' && rule?.sampleCode && (
                <p className="text-sm">
                  <span className="font-mono font-semibold">{rule.sampleCode}</span>{' '}
                  <span className="text-xs text-muted-foreground">{t('employeeId.previewNote')}</span>
                </p>
              )}

              {/* A code typed while hand-keying was still allowed, on a company that has since turned it
                  off. Without this the draft carries an invisible value straight into a server refusal
                  for a field that is no longer on screen. */}
              {companyId && decision.forcedBecause === 'manualNotAllowed' && employeeCode.trim() !== '' && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {t('employeeId.staleCode', { code: employeeCode.trim() })}{' '}
                  <button
                    type="button"
                    className="font-medium underline underline-offset-2"
                    onClick={() => set('profile', { employeeCode: '' })}
                  >
                    {t('employeeId.removeCode')}
                  </button>
                </p>
              )}

              {/* Manual: the ID is required, and a clash is named on the spot. */}
              {companyId && decision.mode === 'manual' && (
                <Field label={t('fields.employeeCode')} required requiredAriaLabel={t('requiredField')}>
                  <input
                    className={inputCls}
                    maxLength={30}
                    value={employeeCode}
                    onChange={(e) => {
                      setDupCode(null);
                      setFreeCode(null);
                      set('profile', { employeeCode: e.target.value });
                    }}
                    onBlur={(e) => checkCode(e.target.value)}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">{t('hints.employeeCode')}</p>
                  {checking && <p className="mt-1 text-xs text-muted-foreground">{t('employeeId.checking')}</p>}
                  {dupCode && (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                      {t('employeeId.duplicate', { code: dupCode })}
                    </p>
                  )}
                  {freeCode && !dupCode && (
                    <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
                      {t('employeeId.available', { code: freeCode })}
                    </p>
                  )}
                </Field>
              )}

              {/* The reporter's rule, made visible where it matters. */}
              <p className="text-xs text-muted-foreground">{t('employeeId.draftCostsNothing')}</p>
            </div>

            <Field label={t('fields.fullName')}>
              <input
                className={inputCls}
                value={data.profile?.fullName ?? ''}
                onChange={(e) => set('profile', { fullName: e.target.value })}
              />
            </Field>
            <Field label={t('fields.primaryEmail')}>
              <input
                type="email"
                className={inputCls}
                value={data.profile?.primaryEmail ?? ''}
                onChange={(e) => set('profile', { primaryEmail: e.target.value })}
              />
            </Field>
            <Field label={t('fields.icNumber')}>
              <input
                className={inputCls}
                value={data.profile?.icNumber ?? ''}
                onChange={(e) => set('profile', { icNumber: e.target.value })}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('hints.icNumber')}</p>
            </Field>
            <Field label={t('fields.phone')}>
              <input
                className={inputCls}
                value={data.profile?.phone ?? ''}
                onChange={(e) => set('profile', { phone: e.target.value })}
              />
            </Field>
            <Field label={t('fields.dateOfBirth')}>
              <input
                type="date"
                className={inputCls}
                value={data.profile?.dateOfBirth ?? ''}
                onChange={(e) => set('profile', { dateOfBirth: e.target.value })}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('hints.dateOfBirth')}</p>
            </Field>
            <Field label={t('fields.gender')}>
              <select
                className={inputCls}
                value={data.profile?.gender ?? ''}
                onChange={(e) => set('profile', { gender: e.target.value })}
              >
                <option value="">{t('notSet')}</option>
                <option value="male">{t('gender.male')}</option>
                <option value="female">{t('gender.female')}</option>
              </select>
            </Field>
            <Field label={t('fields.maritalStatus')}>
              <select
                className={inputCls}
                value={data.profile?.maritalStatus ?? ''}
                onChange={(e) => set('profile', { maritalStatus: e.target.value })}
              >
                <option value="">{t('notSet')}</option>
                <option value="single">{t('marital.single')}</option>
                <option value="married">{t('marital.married')}</option>
              </select>
            </Field>
          </div>
        )}

        {step === 'employment' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* READ-ONLY here (item bd271009): the company is chosen on the Profile step, because it
                decides the Employee ID rule. Two editable copies of one value is how they disagree. */}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t('fields.company')}</span>
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
                {companies.find((c) => c.id === companyId)?.label ?? (
                  <span className="text-muted-foreground">{t('selectPrompt')}</span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('companyOnProfileStep')}{' '}
                <button
                  type="button"
                  className="font-medium underline underline-offset-2"
                  onClick={() => setStep('profile')}
                >
                  {t('steps.profile')}
                </button>
              </p>
            </div>
            <Field label={t('fields.businessUnit')}>
              <select
                className={inputCls}
                value={businessUnitId}
                onChange={(e) => setBusinessUnitId(e.target.value)}
              >
                <option value="">{t('none')}</option>
                {businessUnits.filter((b) => visible(b, false)).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
              {orgEmpty(businessUnits) && (
                <p className="mt-1 text-xs text-muted-foreground">{t('orgLabelsEmptyForCompany')}</p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">{t('hints.businessUnit')}</p>
            </Field>
            <Field label={t('fields.department')}>
              <select
                className={inputCls}
                value={data.employment?.departmentId ?? ''}
                onChange={(e) => set('employment', { departmentId: e.target.value })}
              >
                <option value="">{t('selectPrompt')}</option>
                {departments.filter((d) => visible(d, true)).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
              {orgEmpty(departments) && (
                <p className="mt-1 text-xs text-muted-foreground">{t('orgLabelsEmptyForCompany')}</p>
              )}
            </Field>
            <Field label={t('fields.position')}>
              <select
                className={inputCls}
                value={data.employment?.positionId ?? ''}
                onChange={(e) => set('employment', { positionId: e.target.value })}
              >
                <option value="">{t('none')}</option>
                {positions.filter((p) => visible(p, false)).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              {orgEmpty(positions) && (
                <p className="mt-1 text-xs text-muted-foreground">{t('orgLabelsEmptyForCompany')}</p>
              )}
            </Field>
            <Field label={t('fields.costCenter')}>
              <select
                className={inputCls}
                value={data.employment?.costCenterId ?? ''}
                onChange={(e) => set('employment', { costCenterId: e.target.value })}
              >
                <option value="">{t('none')}</option>
                {costCenters.filter((c) => visible(c, false)).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              {orgEmpty(costCenters) && (
                <p className="mt-1 text-xs text-muted-foreground">{t('orgLabelsEmptyForCompany')}</p>
              )}
            </Field>
            <Field label={t('fields.jobGrade')}>
              <select
                className={inputCls}
                value={data.employment?.gradeId ?? ''}
                onChange={(e) => set('employment', { gradeId: e.target.value })}
              >
                <option value="">{t('none')}</option>
                {grades.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('fields.reportingManager')}>
              <select
                className={inputCls}
                value={data.employment?.reportingManagerEmploymentId ?? ''}
                onChange={(e) => set('employment', { reportingManagerEmploymentId: e.target.value })}
              >
                <option value="">{t('none')}</option>
                {managers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('fields.employmentType')}>
              <select
                className={inputCls}
                value={data.employment?.employmentType ?? 'full_time'}
                onChange={(e) => set('employment', { employmentType: e.target.value })}
              >
                <option value="full_time">{t('employmentType.full_time')}</option>
                <option value="part_time">{t('employmentType.part_time')}</option>
                <option value="contract">{t('employmentType.contract')}</option>
                <option value="intern">{t('employmentType.intern')}</option>
              </select>
            </Field>
            <Field label={t('fields.hiredOn')}>
              <input
                type="date"
                className={inputCls}
                value={data.employment?.hiredOn ?? today}
                onChange={(e) => set('employment', { hiredOn: e.target.value })}
              />
              {/* 89ea527b — Group Join Date and Join Date are the same day at creation and become
                  movement-only afterwards. The wizard captures the one date, as the ticket asks. */}
              <p className="mt-1 text-xs text-muted-foreground">{t('hints.hiredOn')}</p>
            </Field>
            {/* 8590615a — for a CONTRACT hire this one date is the contract end date, so it says so. The
                field, its state and its draft key are unchanged (`provisionalEndOn`); only the label and the
                hint switch, and `hireEmployee` now copies a contract hire's value into
                `employment.contract_end_date` as well, which is what closes the two-homes gap: before this,
                a contract hire's expiry lived in provisional_end_on while Employment Review wrote a
                different column. Two literal `t()` calls rather than a computed key — a template key is
                invisible to test/i18n-coverage.test.ts check C, and this file is single-namespace so both
                keys are actually verified. For every other type the wording is exactly as it was. */}
            <Field
              label={isContractHire ? t('fields.contractEndDate') : t('fields.provisionalEndOn')}
            >
              <input
                type="date"
                className={inputCls}
                value={data.employment?.provisionalEndOn ?? ''}
                onChange={(e) => set('employment', { provisionalEndOn: e.target.value })}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {isContractHire ? t('hints.contractEndDate') : t('hints.provisionalEndOn')}
              </p>
            </Field>
          </div>
        )}

        {step === 'statutory' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('fields.bankName')}>
              <input
                className={inputCls}
                value={data.statutory?.bankName ?? ''}
                onChange={(e) => set('statutory', { bankName: e.target.value })}
              />
            </Field>
            <Field label={t('fields.bankAccountNo')}>
              <input
                className={inputCls}
                value={data.statutory?.bankAccountNo ?? ''}
                onChange={(e) => set('statutory', { bankAccountNo: e.target.value })}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('hints.bankAccount')}</p>
            </Field>
            <Field label={t('fields.epfNumber')}>
              <input
                className={inputCls}
                value={data.statutory?.epfNumber ?? ''}
                onChange={(e) => set('statutory', { epfNumber: e.target.value })}
              />
            </Field>
            <Field label={t('fields.socsoNumber')}>
              <input
                className={inputCls}
                value={data.statutory?.socsoNumber ?? ''}
                onChange={(e) => set('statutory', { socsoNumber: e.target.value })}
              />
            </Field>
            <Field label={t('fields.taxNumber')}>
              <input
                className={inputCls}
                value={data.statutory?.taxNumber ?? ''}
                onChange={(e) => set('statutory', { taxNumber: e.target.value })}
              />
            </Field>
            <Field label={t('fields.taxCategory')}>
              <select
                className={inputCls}
                value={data.statutory?.taxCategory ?? ''}
                onChange={(e) => set('statutory', { taxCategory: e.target.value })}
              >
                <option value="">{t('notSet')}</option>
                <option value="1">{t('taxCategory.1')}</option>
                <option value="2">{t('taxCategory.2')}</option>
                <option value="3">{t('taxCategory.3')}</option>
              </select>
            </Field>
            <Field label={t('fields.numChildren')}>
              <input
                type="number"
                min="0"
                className={inputCls}
                value={data.statutory?.numChildren ?? ''}
                onChange={(e) => set('statutory', { numChildren: e.target.value })}
              />
            </Field>
            <Field label={t('fields.epfCitizenship')}>
              <select
                className={inputCls}
                value={data.statutory?.epfCitizenship ?? ''}
                onChange={(e) => set('statutory', { epfCitizenship: e.target.value })}
              >
                <option value="">{t('notSet')}</option>
                <option value="citizen">{t('citizenship.citizen')}</option>
                <option value="pr">{t('citizenship.pr')}</option>
                <option value="non_citizen">{t('citizenship.non_citizen')}</option>
              </select>
            </Field>
            <Field label={t('fields.eisEligible')}>
              <select
                className={inputCls}
                value={data.statutory?.eisEligible ?? ''}
                onChange={(e) => set('statutory', { eisEligible: e.target.value })}
              >
                <option value="">{t('notSet')}</option>
                <option value="yes">{t('yes')}</option>
                <option value="no">{t('no')}</option>
              </select>
            </Field>
            <Field label={t('fields.isResident')}>
              <select
                className={inputCls}
                value={data.statutory?.isResident ?? ''}
                onChange={(e) => set('statutory', { isResident: e.target.value })}
              >
                <option value="">{t('notSet')}</option>
                <option value="yes">{t('yes')}</option>
                <option value="no">{t('no')}</option>
              </select>
            </Field>
          </div>
        )}

        {step === 'payroll' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('fields.basicSalary')}>
              <input
                type="number"
                min="0.01"
                step="0.01"
                className={inputCls}
                value={data.payroll?.basicSalary ?? ''}
                onChange={(e) => set('payroll', { basicSalary: e.target.value })}
              />
            </Field>
            <Field label={t('fields.monthlyAllowance')}>
              <input
                type="number"
                min="0"
                step="0.01"
                className={inputCls}
                value={data.payroll?.monthlyAllowance ?? ''}
                onChange={(e) => set('payroll', { monthlyAllowance: e.target.value })}
              />
            </Field>
            <Field label={t('fields.payMode')}>
              <select
                className={inputCls}
                value={data.payroll?.payMode ?? 'monthly'}
                onChange={(e) => set('payroll', { payMode: e.target.value })}
              >
                <option value="monthly">{t('payMode.monthly')}</option>
                <option value="daily">{t('payMode.daily')}</option>
                <option value="hourly">{t('payMode.hourly')}</option>
                <option value="custom_period">{t('payMode.custom_period')}</option>
              </select>
            </Field>
            <Field label={t('fields.paymentTerm')}>
              <select
                className={inputCls}
                value={data.payroll?.paymentTerm ?? 'monthly'}
                onChange={(e) => set('payroll', { paymentTerm: e.target.value })}
              >
                <option value="monthly">{t('paymentTerm.monthly')}</option>
                <option value="weekly">{t('paymentTerm.weekly')}</option>
                <option value="biweekly">{t('paymentTerm.biweekly')}</option>
              </select>
            </Field>
            <Field label={t('fields.rateAmount')}>
              <input
                type="number"
                min="0"
                step="0.01"
                className={inputCls}
                value={data.payroll?.rateAmount ?? ''}
                onChange={(e) => set('payroll', { rateAmount: e.target.value })}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('hints.rateAmount')}</p>
            </Field>
            <Field label={t('fields.remarks')}>
              <input
                className={inputCls}
                value={data.payroll?.remarks ?? ''}
                onChange={(e) => set('payroll', { remarks: e.target.value })}
              />
            </Field>
          </div>
        )}

        {step === 'review' && (
          <div className="space-y-4">
            <ul className="divide-y divide-border rounded-lg border border-border">
              {DRAFT_STEPS.filter((k) => k !== 'review').map((k) => (
                <li key={k} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span className="font-medium">{t(`steps.${k}`)}</span>
                  {missing[k].length === 0 ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <Check className="size-3.5" aria-hidden />
                      {t('complete')}
                    </span>
                  ) : (
                    <span className="text-amber-600 dark:text-amber-400">
                      {missing[k].map((f) => t(`fields.${f}`)).join(', ')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              {outstanding.length === 0 ? t('reviewReady') : t('reviewIncomplete')}
            </p>
          </div>
        )}
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => go(-1)} disabled={stepIndex === 0 || pending}>
          {t('back')}
        </Button>
        <Button
          variant="outline"
          onClick={() => go(1)}
          disabled={stepIndex === DRAFT_STEPS.length - 1 || pending}
        >
          {t('next')}
        </Button>
        {/* Deliberately UNVALIDATED: a draft that refused to save until it was complete would not be
            a draft. The reporter's whole ask is "keep what I have and come back to it". */}
        <Button variant="secondary" onClick={() => saveDraft()} disabled={pending}>
          {pending ? t('saving') : t('saveDraft')}
        </Button>
        {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">{t('draftSaved')}</span>}
        <div className="ml-auto flex items-center gap-2">
          {id && (
            <button
              type="button"
              onClick={discard}
              disabled={pending}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {t('discardDraft')}
            </button>
          )}
          <Button onClick={create} disabled={pending || outstanding.length > 0}>
            {pending ? t('creating') : t('createEmployee')}
          </Button>
        </div>
      </div>
    </div>
  );
}
