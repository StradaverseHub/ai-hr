'use client';

/**
 * Create New Employee — the SHORT first screen (item 06f0cb8f).
 *
 * FOUR QUESTIONS: Company, Employee ID, Full Name, Email. Pressing Create makes the record and TAKES the
 * Employee ID there and then; everything else is filled in afterwards on the continue form. That is the
 * whole of the reporter's request — they know a name and an email at the moment an offer is accepted, and
 * the number has to be theirs from then on, not five steps later.
 *
 * WHAT THIS SCREEN REPLACED. Step 1 used to ask for about ten things (Company, Employee ID, Full Name,
 * Email, Nationality, Identity No, Mobile Phone, Date of Birth, Gender, Marital Status) and NOTHING was
 * created until the last of five steps. The six that left are not gone — they are the continue form's
 * Profile Details step, where nothing is blocked on them.
 *
 * THE EMPLOYEE ID BLOCK IS bd271009's, MOVED NOT REWRITTEN. Same `resolveEmployeeIdMode` decision, same
 * rule wording, same on-blur duplicate look-ahead. Only two things changed: the preview is now a
 * PROMISE rather than a sample (pressing Create issues that number and holds it), and the look-ahead
 * consults drafts as well as employees, so an ID another draft is already holding is named as taken.
 */

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { missingToCreate } from '@/lib/employee-draft-schema';
import { resolveEmployeeIdMode, type EmployeeIdRule } from '@/lib/employee-id-mode';
import { createDraftAction, checkEmployeeCodeAction } from './actions';

type Option = { id: string; label: string };

export function CreateEmployeeForm({
  companies,
  employeeIdRules,
}: {
  companies: Option[];
  /** Item bd271009 — the Employee ID rule per company, PLAIN DATA (see the page's boundary note). */
  employeeIdRules: Record<string, EmployeeIdRule>;
}) {
  const t = useTranslations('people.wizard');
  const router = useRouter();
  const [companyId, setCompanyId] = useState('');
  const [employeeIdMode, setEmployeeIdMode] = useState<string | undefined>(undefined);
  const [employeeCode, setEmployeeCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [primaryEmail, setPrimaryEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [dupCode, setDupCode] = useState<string | null>(null);
  const [freeCode, setFreeCode] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const rule: EmployeeIdRule | null = companyId ? (employeeIdRules[companyId] ?? null) : null;
  const decision = useMemo(
    () => resolveEmployeeIdMode(rule, { chosen: employeeIdMode, hasCode: employeeCode.trim() !== '' }),
    [rule, employeeIdMode, employeeCode],
  );

  // The SAME rule the server re-runs (`missingToCreate` inside `createEmployeeDraftWithReservedCode`),
  // shaped as the draft payload it will judge, so the button can never promise a create the server refuses.
  const outstanding = useMemo(
    () =>
      missingToCreate(
        { profile: { fullName, primaryEmail, employeeCode, employeeIdMode }, employment: { companyId } },
        companyId ? { employeeIdRule: rule } : {},
      ),
    [fullName, primaryEmail, employeeCode, employeeIdMode, companyId, rule],
  );

  /** Changing the company changes which numbering rule applies, so a typed ID that the new company
   *  forbids is dropped here rather than carried silently into a server refusal. Mirrors bd271009. */
  const chooseCompany = (next: string) => {
    setCompanyId(next);
    setDupCode(null);
    setFreeCode(null);
    const nextRule = employeeIdRules[next] ?? null;
    if (nextRule?.hasConfig && !nextRule.allowManualOverride) setEmployeeCode('');
  };

  /** Look ahead for a clash while HR is still in the field. Advisory — Create re-checks, in a transaction. */
  const checkCode = (raw: string) => {
    const code = raw.trim();
    setDupCode(null);
    setFreeCode(null);
    if (code === '') return;
    setChecking(true);
    void checkEmployeeCodeAction(code)
      .then((res) => (res.taken ? setDupCode(res.code) : setFreeCode(res.code)))
      .catch(() => {
        /* Advisory only: a failed look-ahead must never block typing. Create still refuses. */
      })
      .finally(() => setChecking(false));
  };

  const create = () =>
    startTransition(async () => {
      setError(null);
      try {
        const res = await createDraftAction({
          companyId,
          fullName,
          primaryEmail,
          employeeIdMode,
          employeeCode,
        });
        // Straight onto the continue form for the record that now exists — not back to the list. HR who
        // has the rest of the details to hand should not have to go and find the row they just made.
        router.push(`/admin/personnel/new?draft=${res.id}`);
      } catch (e) {
        setError((e as Error).message);
      }
    });

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      <Card className="space-y-4 p-5">
        <Field label={t('fields.company')} required requiredAriaLabel={t('requiredField')}>
          <select className={inputCls} value={companyId} onChange={(e) => chooseCompany(e.target.value)}>
            <option value="">{t('selectPrompt')}</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">{t('hints.companyFixed')}</p>
        </Field>

        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
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
                      onChange={() => {
                        setDupCode(null);
                        setFreeCode(null);
                        setEmployeeIdMode(m);
                      }}
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

          {/* Auto. The number shown is the one Create will ISSUE AND HOLD — the wording says so, because
              under the old workflow this same line had to call itself a sample. */}
          {companyId && decision.mode === 'auto' && rule?.sampleCode && (
            <p className="text-sm">
              <span className="font-mono font-semibold">{rule.sampleCode}</span>{' '}
              <span className="text-xs text-muted-foreground">{t('employeeId.reserveNote')}</span>
            </p>
          )}

          {companyId && decision.mode === 'manual' && (
            <Field label={t('fields.employeeCode')} required requiredAriaLabel={t('requiredField')}>
              <input
                className={inputCls}
                maxLength={30}
                value={employeeCode}
                onChange={(e) => {
                  setDupCode(null);
                  setFreeCode(null);
                  setEmployeeCode(e.target.value);
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

          {/* The reporter's rule, made visible where it matters — and it is the OPPOSITE of what this
              same line said before this item, which is exactly why it is said out loud. */}
          <p className="text-xs text-muted-foreground">{t('employeeId.heldFromCreate')}</p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('fields.fullName')} required requiredAriaLabel={t('requiredField')}>
            <input className={inputCls} value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </Field>
          <Field label={t('fields.primaryEmail')} required requiredAriaLabel={t('requiredField')}>
            <input
              type="email"
              className={inputCls}
              value={primaryEmail}
              onChange={(e) => setPrimaryEmail(e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={create} disabled={pending || outstanding.length > 0}>
          {pending ? t('creating') : t('createDraft')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('createDraftNote')}</p>
      </div>
    </div>
  );
}
