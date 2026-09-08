'use client';

/**
 * CONTINUE A DRAFT — the rest of a new employee's details (item 6d671f44, reshaped by 06f0cb8f).
 *
 * IT IS NO LONGER THE CREATION FORM. The record already exists by the time this screen opens: Create
 * (`create-form.tsx`) asked four questions and reserved the Employee ID. What is left is everything an
 * employment actually needs, and none of it is blocking anything — HR fills it in over the following days
 * and presses ACTIVATE when it is complete.
 *
 * FOUR STEPS: Profile Details · Employment · Bank & Statutory · Payroll. Each shows a tick when it has
 * everything it needs and a warning when it does not, computed by ONE shared rule
 * (`lib/employee-draft-schema` `missingByStep`) that the server re-runs before it will create anything.
 * REVIEW IS GONE: it existed to gate one button at the end of a five-step form, and Activate — reachable
 * from every step, naming exactly what is outstanding — is that review.
 *
 * SAVE DRAFT works from any step and does not validate; that is the entire point of a draft. Only
 * Activate validates, and only then does an employment exist.
 *
 * TWO THINGS ARE READ-ONLY HERE, and the server refuses to be told otherwise (`saveEmployeeDraft` pins
 * them): the COMPANY, because it decided which numbering rule the held ID came from, and the EMPLOYEE ID
 * itself, which is held on the row and belongs to this record already. Picked the wrong company? Discard
 * and start again — it is four fields.
 *
 * THE ORG CASCADE MOVED HERE, IT WAS NOT REWRITTEN. The old inline hire form narrowed Business Unit /
 * Department / Position / Cost Centre by the chosen company using a pure-DOM inline script that
 * embedded `hireOptionVisible` via `Function.prototype.toString`. In a client component the same pure
 * rule can simply be called, so the script is gone and the rule is not duplicated. The server-side
 * `CrossCompanyError` guard in `core/org.ts` remains the last line of defence, exactly as before.
 */

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, AlertCircle } from 'lucide-react';
import { Button, Card, EmployeeCode, Field, inputCls } from '@/components/ui';
// 35b7af0a group 1 — the Gender + Marital Status field group, shared with the Personnel profile card.
import { PersonDetailsFields } from '@/components/person-details-fields';
// 35b7af0a group 2 — the Pay Mode / Payment Term / Rate group, shared with the Personnel Payroll tab.
import { PayStructureFields, type PayModeOption } from '@/components/pay-structure-fields';
// 35b7af0a group 3 — the Date of Birth + read-only Age group, shared with the Personnel profile card.
import { BirthDateFields } from '@/components/birth-date-fields';
// 35b7af0a group 4 — the EPF Number + EPF Citizenship group, shared with the Personnel Bank & Statutory tab.
import { EpfRegistrationFields } from '@/components/epf-registration-fields';
// 35b7af0a group 5 — the Bank + Bank Account Number group, shared with the Personnel Bank Information card.
import { BankAccountFields } from '@/components/bank-account-fields';
import { TaxCategoryField } from '@/components/tax-category-field';
import { SocsoEisFields } from '@/components/socso-eis-fields';
// 35b7af0a group 8 — the Nationality picker and the nationality-gated Identity No, shared with the
// Personnel profile card's identity block.
import { IdentityNumberField, NationalityPicker } from '@/components/identity-fields';
import type { ComboboxOption } from '@/components/ui/combobox';
import { hireOptionVisible } from '@/lib/hire-form-filter';
import {
  DRAFT_STEPS,
  draftFamily,
  missingByStep,
  missingForCreation,
  stepKey,
  stepNumber,
  type DraftStepKey,
  type EmployeeDraftData,
  type EmployeeDraftFamilyMember,
} from '@/lib/employee-draft-schema';
// 759dfc7d — the Family tab, the first of the active record's tabs a draft gets (plan work item 1).
import { DraftFamilyStep } from './family-step';
import { saveDraftAction, discardDraftAction, createEmployeeAction } from './actions';

type Option = { id: string; label: string; companies?: string; businessUnitId?: string; buCompanies?: string };

export function EmployeeWizard({
  today,
  draftId,
  reservedEmployeeCode,
  initialData,
  initialStep,
  companies,
  businessUnits,
  departments,
  positions,
  costCenters,
  grades,
  managers,
  nationalityOptions,
  relationshipOptions,
  countryOptions,
}: {
  today: string;
  draftId: string;
  /** The Employee ID held for this record since Create (item 06f0cb8f). Null only on a draft written
   *  before that item — it then behaves exactly as it always did and is issued an ID at Activate. */
  reservedEmployeeCode: string | null;
  initialData: EmployeeDraftData;
  initialStep: number;
  companies: Option[];
  businessUnits: Option[];
  departments: Option[];
  positions: Option[];
  costCenters: Option[];
  grades: Option[];
  managers: Option[];
  /** 35b7af0a group 8 — the tenant's nationality catalog (System Labels > Profile Options), the SAME list
   *  the Personnel profile card offers. PLAIN DATA, like every other prop crossing this boundary. */
  nationalityOptions: ComboboxOption[];
  /** 759dfc7d — the `dependentRelationship` and `country` catalogs the Family step needs, resolved on the
   *  server exactly as the Personnel Family tab resolves them. Empty is meaningful for the first: the step
   *  falls back to the five built-in relationships, so an unseeded tenant never sees a blank dropdown. */
  relationshipOptions: { value: string; label: string }[];
  countryOptions: { value: string; label: string }[];
}) {
  const t = useTranslations('people.wizard');
  const router = useRouter();
  const id = draftId;
  const [data, setData] = useState<EmployeeDraftData>(initialData);
  const [step, setStep] = useState<DraftStepKey>(stepKey(initialStep));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  // The Business Unit is a FILTER on the department list, not a stored field — the assignment writer
  // takes a department, and the department carries its own BU. Kept in component state, never in the
  // draft, so a saved draft cannot carry a value nothing will ever read.
  const [businessUnitId, setBusinessUnitId] = useState('');

  // FIXED FOR THE LIFE OF THIS DRAFT (item 06f0cb8f). The company decided which numbering rule the held
  // Employee ID came from, so it is read from the draft and never written back — there is no company
  // picker on this screen at all, and `saveEmployeeDraft` re-pins it server-side.
  const companyId = data.employment?.companyId ?? '';
  const employeeCode = reservedEmployeeCode ?? data.profile?.employeeCode ?? '';
  // 8590615a — the single provisional/lifecycle end date the wizard captures MEANS the contract end date
  // when the hire is a contract hire, so it is labelled that way (the field itself is unchanged).
  const isContractHire = (data.employment?.employmentType ?? 'full_time') === 'contract';

  const missing = useMemo(() => missingByStep(data), [data]);
  const outstanding = useMemo(() => missingForCreation(data), [data]);

  const set = <K extends keyof EmployeeDraftData>(section: K, patch: Partial<NonNullable<EmployeeDraftData[K]>>) => {
    setSaved(false);
    setData((d) => ({ ...d, [section]: { ...(d[section] ?? {}), ...patch } }));
  };

  /** 759dfc7d — family needs its own setter: `set` MERGES an object into a section, and merging into a
   *  LIST is how a removed member comes back (index 2 of a shorter array survives the spread). The whole
   *  array is replaced instead. */
  const setFamily = (family: EmployeeDraftFamilyMember[]) => {
    setSaved(false);
    setData((d) => ({ ...d, family }));
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
        // `stepNumber`, NOT `indexOf + 1`: the stored number is declared in employee-draft-schema.ts
        // (5 is the retired `review` slot and stays retired), so counting positions here would write the
        // wrong number for every step after it.
        await saveDraftAction(id, data, stepNumber(nextStep ?? step));
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
        await discardDraftAction(id);
        router.push('/admin/personnel');
      } catch (e) {
        setError((e as Error).message);
      }
    });

  /** ACTIVATE. The held Employee ID becomes a real employment carrying that same ID. */
  const activate = () =>
    startTransition(async () => {
      setError(null);
      try {
        const res = await createEmployeeAction(id, data, stepNumber(step));
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
      {/* THE RECORD THAT ALREADY EXISTS (item 06f0cb8f) — its held Employee ID, its name and its company,
          the three things Create settled. Shown at the top, unmissable and unmoving, because the single
          biggest change this item makes is that HR is now editing something rather than filling in a form
          that might yet become something. `EmployeeCode` is the same monospaced treatment the employee
          list and the profile screen give the ID, so the number reads as identical in all three places. */}
      <Card className="flex flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3">
        <div>
          <div className="text-xs font-medium text-muted-foreground">{t('fields.employeeCode')}</div>
          <div className="mt-0.5">
            {employeeCode ? (
              <EmployeeCode code={employeeCode} />
            ) : (
              // A draft from before this item holds no ID; it is issued at Activate, as it always was.
              <span className="text-sm text-muted-foreground">{t('employeeId.issuedAtActivate')}</span>
            )}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">{t('fields.fullName')}</div>
          <div className="mt-0.5 truncate text-sm font-medium">
            {data.profile?.fullName?.trim() || t('untitledDraft')}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">{t('fields.company')}</div>
          <div className="mt-0.5 truncate text-sm">
            {companies.find((c) => c.id === companyId)?.label ?? '—'}
          </div>
        </div>
        <p className="basis-full text-xs text-muted-foreground">{t('companyFixedAfterCreate')}</p>
      </Card>

      {/* Progress strip. A step is complete when its own required fields are satisfied — the same rule
          the server enforces, so a tick can never promise something Activate will refuse. */}
      <nav aria-label={t('progressLabel')} className="flex flex-wrap gap-2">
        {DRAFT_STEPS.map((k, i) => {
          const done = missing[k].length === 0;
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
              {!done && <AlertCircle className="size-3.5 text-amber-600 dark:text-amber-400" aria-hidden />}
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
            {/* Full Name and Email were asked at Create and are STILL editable here — the plan pins
                only the Company and the Employee ID, and a name typed with a typo must not cost HR the
                whole record. The Employee ID block that used to sit above them is gone from this screen:
                the ID is settled, and it is shown in the header card, where it cannot be mistaken for a
                field. */}
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
            {/* 35b7af0a group 8 — Nationality and the Identity No (NRIC) are the SAME field group the
                Personnel profile card renders (components/identity-fields.tsx). The wizard had a BARE
                Identity No box and did not ask for a nationality AT ALL, so every hire it created arrived
                with person.nationality NULL — and item 357faecf gates the Personnel screen's NRIC card on
                exactly that column, so the number the wizard had just collected was HIDDEN the moment HR
                opened the new employee, until somebody set a nationality by hand. Asked here, immediately
                above the field it governs, because the Identity No disappears for a passport holder (who
                has no NRIC) and a control that vanishes for no visible reason reads as a bug. */}
            <NationalityPicker
              mode="controlled"
              value={data.profile?.nationality}
              options={nationalityOptions}
              onChange={(nationality) => set('profile', { nationality })}
            />
            <IdentityNumberField
              mode="controlled"
              nationality={data.profile?.nationality}
              icNumber={data.profile?.icNumber}
              onChange={(icNumber) => set('profile', { icNumber })}
            />
            <Field label={t('fields.phone')}>
              <input
                className={inputCls}
                value={data.profile?.phone ?? ''}
                onChange={(e) => set('profile', { phone: e.target.value })}
              />
            </Field>
            {/* 35b7af0a group 3 — Date of Birth is the SAME field group the Personnel profile card renders
                (components/birth-date-fields.tsx), and it brings the Age with it. The wizard had a bare date
                box and NO age, because the age counter lived in core/leave.ts — a server module a client
                component cannot import — so "Age (auto-calculated)", which the reporter listed as a Profile
                field, simply did not exist at hire. The counter now lives in lib/completed-years.ts and both
                screens read it. Age is display-only: no draft key, no column, recomputed on every render.
                The wizard's own guidance about deriving a blank DOB from the identity number is passed in as
                the hint, so nothing is lost by sharing the field. */}
            <BirthDateFields
              mode="controlled"
              dateOfBirth={data.profile?.dateOfBirth}
              today={today}
              hint={t('hints.dateOfBirth')}
              onChange={(v) => set('profile', { dateOfBirth: v })}
            />
            {/* 35b7af0a group 1 — Gender and Marital Status are no longer the wizard's own selects with
                the wizard's own labels. They are the SAME field group the Personnel profile card renders
                (components/person-details-fields.tsx), drawing on the master lists in
                lib/person-vocabulary.ts. This is not only de-duplication: the wizard's private copy had
                fallen four marital values and one gender value behind the profile screen, so HR could not
                hire anybody as divorced, widowed, separated or undisclosed — while a leave rule written
                for exactly those values was already possible (#12129e77). One list, one set of labels,
                and a value HR can pick here is by construction one core/profile.ts will accept. */}
            <PersonDetailsFields
              mode="controlled"
              gender={data.profile?.gender}
              maritalStatus={data.profile?.maritalStatus}
              onGenderChange={(v) => set('profile', { gender: v })}
              onMaritalStatusChange={(v) => set('profile', { maritalStatus: v })}
            />
          </div>
        )}

        {step === 'employment' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* The company USED to be a second, editable copy here (bd271009 made it read-only). It is
                gone entirely now: it is in the header card above, on every step, because since 06f0cb8f it
                is not merely "chosen elsewhere" but FIXED — the held Employee ID came from this company's
                numbering rule, so changing it would orphan the number. */}
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
            {/* 35b7af0a group 5 — Bank and Bank Account Number are the SAME field group the Personnel Bank
                Information card renders (components/bank-account-fields.tsx). The wizard's Bank was a
                FREE-TEXT box where that card has been a pick-from-the-BNM-catalog select since item
                ef720d3a — so a hire could be created with "may bank" typed by hand, which reads fine to a
                human, shows unremarkably on the Personnel screen, and only surfaces when the first salary
                payment file is built for that employee. A bank name already typed into a draft is
                preserved as its own option rather than silently rewritten. The all-or-nothing rule stays
                the wizard's hint (missingByStep enforces it). */}
            <BankAccountFields
              mode="controlled"
              bankName={data.statutory?.bankName}
              bankAccountNo={data.statutory?.bankAccountNo}
              hint={t('hints.bankAccount')}
              onChange={(patch) => set('statutory', patch)}
            />
            {/* 35b7af0a group 4 — EPF Number and EPF Citizenship are the SAME field group the Personnel
                Bank & Statutory tab renders (components/epf-registration-fields.tsx). The wizard's private
                copy had drifted in wording and carried a fourth "— Not set —" citizenship option that
                cannot be stored: `epf_citizenship` is NOT NULL DEFAULT 'citizen', so leaving it blank at
                hire produced 'citizen' anyway and the profile screen then showed "Malaysian citizen" for a
                foreign worker whose recruiter had deliberately left it unset. Three real choices now, the
                same three on both screens. The default is DISPLAYED, not written into the draft —
                completeEmployeeDraft creates the statutory row only when some statutory field is non-blank
                (hasAnyStatutory), so writing 'citizen' just because the field was shown would conjure a
                statutory row for every hire that has none today. */}
            <EpfRegistrationFields
              mode="controlled"
              epfNumber={data.statutory?.epfNumber}
              epfCitizenship={data.statutory?.epfCitizenship}
              onChange={(patch) => set('statutory', patch)}
            />
            {/* 35b7af0a group 7 — SOCSO/EIS is the SAME group the Personnel Bank & Statutory tab renders
                (components/socso-eis-fields.tsx). The wizard was a whole consolidation behind: item
                a7271737 made the CATEGORY the single per-scheme control on that screen, and the wizard
                still offered the legacy "EIS eligible" yes/no with no SOCSO category at all — so a hire
                created here could not be put in SOCSO First or Second category, and the same employee
                opened on Personnel a minute later showed a different question with more answers. The
                number also now defaults to a Malaysian employee's IC exactly as that card does. */}
            <SocsoEisFields
              mode="controlled"
              value={{
                socsoNumber: data.statutory?.socsoNumber,
                socsoCategory: data.statutory?.socsoCategory,
                eisCategory: data.statutory?.eisCategory,
              }}
              icNumber={data.profile?.icNumber}
              // 35b7af0a group 8 — the wizard now ASKS for the nationality (Profile step), so the
              // IC-derived number default fires here exactly as it does on the Personnel card. It had to
              // be `undefined` before: defaultSocsoEisNumber keys on nationality, and inferring
              // "Malaysian" from a 12-digit IC would have filed a foreign worker's SOCSO number silently.
              // `completeEmployeeDraft` applies the same default server-side, so a number merely shown
              // here is also the number stored.
              nationality={data.profile?.nationality}
              country="MY"
              onChange={(patch) => set('statutory', patch)}
            />
            <Field label={t('fields.taxNumber')}>
              <input
                className={inputCls}
                value={data.statutory?.taxNumber ?? ''}
                onChange={(e) => set('statutory', { taxNumber: e.target.value })}
              />
            </Field>
            {/* 35b7af0a group 6 — Tax Category is the SAME control the Personnel Identification & Tax
                card renders (components/tax-category-field.tsx). The wizard's private select labelled its
                options "1", "2" and "3"; the Personnel card has always named the five circumstances they
                stand for. Whoever creates the hire now sees exactly what whoever edits it sees, which is
                the point of this item — a category picked wrongly here is invisible afterwards and is
                simply the wrong monthly tax until somebody notices. */}
            <TaxCategoryField
              mode="controlled"
              value={data.statutory?.taxCategory}
              onChange={(taxCategory) => set('statutory', { taxCategory })}
              notSetLabel={t('notSet')}
            />
            <Field label={t('fields.numChildren')}>
              <input
                type="number"
                min="0"
                className={inputCls}
                value={data.statutory?.numChildren ?? ''}
                onChange={(e) => set('statutory', { numChildren: e.target.value })}
              />
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
            {/* 35b7af0a group 2 — Pay Mode, Payment Term and Rate are the SAME component the Personnel
                Payroll tab and the salary-history edit flow already used
                (components/pay-structure-fields.tsx). The wizard's private copy had drifted in wording
                (its Payment Term said "Fortnightly" where every other screen says "Bi-Weekly") and never
                carried the rule: it showed a bare Rate box on every hire, including monthly ones where a
                rate means nothing. Now the box appears only for a non-monthly pay mode, is labelled
                "per day" / "per hour", and is required for daily/hourly — the same rule
                `missingByStep` already enforced invisibly and `setCompensation` enforces server-side.

                CLEARING THE RATE ON A SWITCH BACK TO MONTHLY is a wizard-only concern, hence the patch
                here rather than inside the shared component. On the Personnel form the Rate input simply
                unmounts and stops being submitted; the wizard holds a DRAFT object, so a rate typed under
                "hourly" would otherwise sit invisibly in the draft and reach setCompensation on create. */}
            <PayStructureFields
              mode="controlled"
              payMode={(data.payroll?.payMode ?? 'monthly') as PayModeOption}
              paymentTerm={data.payroll?.paymentTerm ?? 'monthly'}
              rateAmount={data.payroll?.rateAmount ?? ''}
              onChange={(patch) =>
                set('payroll', {
                  ...patch,
                  ...(patch.payMode === 'monthly' ? { rateAmount: '' } : {}),
                })
              }
            />
            <Field label={t('fields.remarks')}>
              <input
                className={inputCls}
                value={data.payroll?.remarks ?? ''}
                onChange={(e) => set('payroll', { remarks: e.target.value })}
              />
            </Field>
          </div>
        )}

        {/* 759dfc7d — FAMILY. The one tab of the active record a draft could never have, because
            `employee_dependent` is keyed to a person and a draft creates none. It is edited into the
            draft's own blob here and materialised into real rows at Activate. It sits OUTSIDE the
            two-column grid the other steps use: its own card carries a table and a dialog, and it
            manages its own layout so it matches the Personnel Family tab rather than this form. */}
        {step === 'family' && (
          <DraftFamilyStep
            members={draftFamily(data)}
            onChange={setFamily}
            relationshipOptions={relationshipOptions}
            countryOptions={countryOptions}
          />
        )}

      </Card>

      {/* WHAT ACTIVATE IS STILL WAITING FOR. This is what the Review step used to be, minus the step:
          named in place, immediately above the button it governs, on every step rather than only the last
          one. A disabled button that does not say why is the thing this replaces. */}
      {outstanding.length > 0 && (
        <div className="rounded-lg border border-border px-4 py-3 text-sm">
          <div className="font-medium">{t('activateNeeds')}</div>
          <ul className="mt-1.5 space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
            {DRAFT_STEPS.filter((k) => missing[k].length > 0).map((k) => (
              <li key={k}>
                <button
                  type="button"
                  className="font-medium underline underline-offset-2"
                  onClick={() => setStep(k)}
                >
                  {t(`steps.${k}`)}
                </button>
                {' — '}
                {missing[k].map((f) => t(`fields.${f}`)).join(', ')}
              </li>
            ))}
          </ul>
        </div>
      )}

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
          <button
            type="button"
            onClick={discard}
            disabled={pending}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {t('discardDraft')}
          </button>
          <Button onClick={activate} disabled={pending || outstanding.length > 0}>
            {pending ? t('activating') : t('activate')}
          </Button>
        </div>
      </div>
      {/* The one consequence of Discard that is not obvious, said where the button is: a held number is
          only returned when it is the last one issued. Discarding after somebody else has been created
          behind this draft leaves a gap in the sequence. */}
      <p className="text-xs text-muted-foreground">{t('discardReleasesTip')}</p>
    </div>
  );
}
