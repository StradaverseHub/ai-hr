'use client';

/**
 * Create New Employee — the SHORT first screen (item 06f0cb8f), now ALSO the body of the prompt that
 * opens over the employee list (item 034a5080).
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
 *
 * ── ITEM 034a5080: ONE BODY, TWO SURFACES ───────────────────────────────────────────────────────────
 * `CreateEmployeeFields` below is the WHOLE four-question body, and it is what both surfaces render:
 * this route (via `CreateEmployeeForm`, unchanged from the caller's point of view) and the prompt over
 * the employee list (app/admin/personnel/create-employee-dialog.tsx). It is one component and not two
 * copies because the Employee ID block is the delicate part of this screen — the mode decision, the
 * look-ahead, the "company changed, drop the typed code" rule — and a second copy of it would be a
 * second answer to "which ID is this employee getting".
 *
 * `onCreated` is the only thing the two surfaces disagree about: the route pushes straight to the
 * continue form (today's behaviour, kept), and the prompt shows a confirmation naming the ID that was
 * ACTUALLY issued before it lets go. Both are client components, so the callback never crosses the
 * server/client boundary — what crosses it is `companies` and `employeeIdRules`, plain data, exactly as
 * before (test/server-client-boundary.test.ts).
 */

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { missingToCreate } from '@/lib/employee-draft-schema';
import { resolveEmployeeIdMode, type EmployeeIdRule } from '@/lib/employee-id-mode';
import { createDraftAction, checkEmployeeCodeAction } from './actions';

export type Option = { id: string; label: string };

/** What the caller is told the moment the record exists. `employeeCode` is the ID the SERVER issued —
 *  never the previewed sample (item 034a5080; see the note on the read-only field below). */
export type CreatedEmployee = {
  id: string;
  employeeCode: string;
  fullName: string;
  companyLabel: string;
};

export function CreateEmployeeFields({
  companies,
  employeeIdRules,
  framed = true,
  onCreated,
  onCancel,
}: {
  companies: Option[];
  /** Item bd271009 — the Employee ID rule per company, PLAIN DATA (see the page's boundary note). */
  employeeIdRules: Record<string, EmployeeIdRule>;
  /** Wrap the fields in a Card (the standalone route). The prompt already has a surface of its own. */
  framed?: boolean;
  /** Called once the record exists, with the ID the server actually issued. */
  onCreated: (created: CreatedEmployee) => void;
  /** Rendered as a Cancel button when supplied — requirement 9 of item 034a5080. The standalone route
   *  omits it: it has the PageHeader's "Back to Personnel Management" and no modal to dismiss. */
  onCancel?: () => void;
}) {
  const t = useTranslations('people.wizard');
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
        // `res.employeeCode` IS THE ISSUED ID and the previewed sample is not — see the read-only field
        // below. Whatever the caller does with this, it must show the server's answer.
        onCreated({
          id: res.id,
          employeeCode: res.employeeCode,
          fullName: fullName.trim(),
          companyLabel: companies.find((c) => c.id === companyId)?.label ?? '',
        });
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const fields = (
    <>
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

        {/* ── AUTO: A FIELD, NOT A SENTENCE (item 034a5080) ───────────────────────────────────────────
            This block used to be one line of prose — `<span>{sample}</span> {t('employeeId.reserveNote')}`
            reading "S000001E is the ID that will be issued and reserved the moment you press Create."
            The reporter quoted that sentence back at us and asked for a field. So: a labelled Field, the
            number in `font-mono text-lg`, and "Auto-generated" under it. `employeeId.reserveNote` is
            RETIRED, not deleted — the key stays in all six locales (CLAUDE.md §8) and nothing reads it.

            `readOnly`, DELIBERATELY NOT `disabled`. A disabled input is not submitted by the browser at
            all, so wrapping this screen in a <form> later would make the field vanish from the payload
            (CLAUDE.md §8). readOnly keeps it in the DOM, keeps it focusable, and lets HR select and copy
            the number — which is the whole point of showing it.

            AND THE VALUE IS NOT `employeeCode` STATE. It is `rule.sampleCode`, read straight off the rule
            and held nowhere. Writing the sample into `employeeCode` would make `hasCode` true, which
            `resolveEmployeeIdMode` reads as Manual Key In — and for a company whose setup forbids manual
            entry the server then refuses the create outright ("was entered by hand, but the selected
            company's Employee ID Auto Running Number Setup does not allow manual entry"). The auto branch
            must send an EMPTY employeeCode; test/create-employee-dialog.dom.test.tsx pins that.

            WHAT THE NUMBER IS. `sampleCode` is `nextRunningNumber(cfg)` read on the server when the page
            was built — a PREVIEW, which is what lib/employee-id-mode.ts calls it. The counter is advanced
            inside the create transaction by `issueEmployeeCode`, which also skips numbers already taken,
            so under two concurrent creates the issued ID can differ from this one. That is exactly why
            the prompt's confirmation names `res.employeeCode` from the server and never this value. */}
        {companyId && decision.mode === 'auto' && rule?.sampleCode && (
          <Field label={t('employeeId.heading')}>
            <input
              type="text"
              readOnly
              aria-readonly="true"
              data-auto-employee-id
              className={`${inputCls} font-mono text-lg font-semibold`}
              value={rule.sampleCode}
            />
            <span className="mt-1 inline-flex w-fit rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {t('employeeId.autoGenerated')}
            </span>
          </Field>
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
    </>
  );

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {framed ? <Card className="space-y-4 p-5">{fields}</Card> : <div className="space-y-4">{fields}</div>}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={create} disabled={pending || outstanding.length > 0}>
          {pending ? t('creating') : t('createDraft')}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            {t('cancel')}
          </Button>
        )}
        <p className="text-xs text-muted-foreground">{t('createDraftNote')}</p>
      </div>
    </div>
  );
}

/**
 * The standalone route's create screen. A thin wrapper over the shared body whose only job is the
 * outcome: straight onto the continue form for the record that now exists — not back to the list. HR who
 * has the rest of the details to hand should not have to go and find the row they just made.
 */
export function CreateEmployeeForm({
  companies,
  employeeIdRules,
}: {
  companies: Option[];
  employeeIdRules: Record<string, EmployeeIdRule>;
}) {
  const router = useRouter();
  return (
    <CreateEmployeeFields
      companies={companies}
      employeeIdRules={employeeIdRules}
      onCreated={(created) => router.push(`/admin/personnel/new?draft=${created.id}`)}
    />
  );
}
