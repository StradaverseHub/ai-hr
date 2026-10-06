'use client';

/**
 * A DRAFT EMPLOYEE RECORD — the same tabs an activated employee opens (item 6d671f44, reshaped by
 * 06f0cb8f, moved onto tabs by 759dfc7d work item 2).
 *
 * THE FILE IS STILL CALLED `wizard.tsx` AND IT IS NO LONGER A WIZARD. The five-step form is gone: no
 * step strip, no Back, no Next, no order imposed on the person filling it in. What is here instead is
 * `ClientTabs` — literally the shell (components/personnel-tabs.tsx) the activated employee's record
 * uses — showing five of that record's own tabs. The filename is kept only because four tests address
 * this module by path; this header is the correction.
 *
 * IT IS NOT THE CREATION FORM EITHER. The record already exists by the time this screen opens: Create
 * (`create-form.tsx`) asked four questions and reserved the Employee ID. What is left is everything an
 * employment actually needs, and none of it is blocking anything — HR fills it in over the following days
 * and presses ACTIVATE when it is complete.
 *
 * FIVE TABS: Profile · Employment · Bank & Statutory · Payroll · Family, labelled from
 * `people.wizard.tabs.*`, which test/draft-record-tabs.test.ts pins EQUAL to `people.detail.tabs.*` in
 * all six locales — so the words on a draft and the words on the record it becomes cannot drift. The
 * cards inside each tab carry the record's own section names the same way (`people.wizard.sections.*`,
 * pinned against the same detail keys). The six tabs a draft does NOT get — Career Movement, Attendance,
 * Leave, Documents, Qualification and Others — are ABSENT rather than empty: four of them describe
 * things that have happened to an employment, and a draft has none. See DRAFT_TABS in
 * lib/employee-draft-schema.ts for the rule, and for why Qualification waits.
 *
 * WHAT MAKES IT A DRAFT SURVIVED THE MOVE, and each half is asserted rather than hoped for:
 *   - SAVE DRAFT works from any tab and DOES NOT VALIDATE. A draft that refused to save until it was
 *     complete would not be a draft, and the reporter's ask is "keep what I have and come back to it".
 *   - Nothing is validated until Activate, which re-runs ONE shared rule
 *     (`lib/employee-draft-schema` `missingByTab`) that the server runs again before it creates anything.
 *   - The screen keeps saying what is outstanding, BY TAB, immediately above the button it governs, and
 *     each name is a link that moves the shell to that tab (`selectRef`).
 *   - A "Draft — pending activation" badge sits in the record header, so the status is a LABEL ON THE
 *     RECORD rather than a different kind of screen.
 *
 * THE DRAFT IS STILL ONE jsonb BLOB — route A of the plan, and route B stays rejected. A draft creates no
 * person and no employment, which is what keeps it out of headcount, payroll, leave and every report, and
 * out of RLS's way. Real rows in a 'draft' state would invert that invariant and every consumer would
 * have to learn to exclude them. So these tabs read and write `employee_draft.data`, and this change
 * carries no migration at all.
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

import { useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Button, Card, EmployeeCode, Field, SectionHeader, inputCls } from '@/components/ui';
// 759dfc7d work item 2 — the SAME tab shell app/admin/personnel/[employmentId] uses, not a copy of it.
// A second strip would be a second set of tab behaviours to keep in step: the unsaved-changes guard, the
// `?tab=` written into the address bar on every switch (and read back on load, `openingTab` below), and
// the guided-tour reveal.
//
// WHAT KEEPS A HALF-TYPED VALUE ACROSS A TAB SWITCH IS NOT THE SHELL — say it here because the plausible
// wrong answer is easy to write down. `data` lives in `useState` in THIS component, above <ClientTabs>,
// and every input on every tab is controlled from it, so a value is in the record the moment it is typed
// and the panel is only a view of it. The shell does keep hidden panels mounted, which is what preserves
// the DOM state of the activated record's UNCONTROLLED server-rendered forms; unmounting them would cost
// this screen nothing. test/draft-record-tabs.dom.test.tsx proves the mechanism that is real, by reading a
// value back from the header and the outstanding list while the panel it was typed into is hidden.
import { ClientTabs } from '@/components/personnel-tabs';
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
// a72610af — the field groups this screen gained, every one of them the SHARED control the Personnel
// record renders, in its `controlled` branch. Not one of them is a copy: the labels, the option lists and
// the value encodings live in the component, so the draft and the record cannot word a question
// differently. See each component's header for what it is and why it could be shared.
import { PersonNameFields, PersonContactExtraFields } from '@/components/person-name-fields';
// da7463b4 — the two address blocks and the tick that pairs them, both the SHARED controls the Personnel
// Contact & Address card renders. See components/address-fields.tsx for why they were extracted rather
// than copied: this item IS a drift complaint, and a second address form would be the same complaint again.
import {
  AddressBlockFields,
  CorrespondenceAddressTitle,
  CorrespondencePhoneFields,
  PermanentAddressTitle,
  SameAsPermanentTick,
} from '@/components/address-fields';
import { PassportFields, PassportSectionTitle } from '@/components/passport-fields';
import { ConfirmationDateField, EmploymentPeriodField } from '@/components/employment-period-fields';
import { EpfElectionControlled } from '@/components/epf-election';
// r393 (685d2380 step 3b) — the Income Tax Resident select, shared with the Personnel Income Tax (PCB) card.
import { TaxResidencySelect } from '@/components/tax-residency-field';
// r393 (685d2380 step 3b) — the client-safe pack seam: the draft's still-needed list names a refused EPF box
// or income tax residency with the pack's OWN rules (localization/registry.client.ts).
import { clientPackFor } from '@/localization/registry.client';
import { EmployerBearsSwitch } from '@/components/employer-bears-fields';
import {
  ChildReliefModeField,
  ChildReliefModeHint,
  DisabledReliefField,
  DisabledReliefHints,
  HrdfSubjectField,
} from '@/components/tax-relief-fields';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
// r393 (685d2380 step 2) — Payment Method and Payroll Policy, the SAME field groups the Personnel record's
// Payroll tab renders (form mode there, controlled here), so the two screens offer the same answers in the
// same words.
import { PaymentMethodField } from '@/components/payment-method-field';
// r393 (685d2380 step 3a) — the custom payment holder group, shared with the Bank Information card.
import { CustomHolderFields } from '@/components/custom-holder-fields';
import {
  PayrollPolicyField,
  PayrollPolicyHint,
  type AssignablePolicyOption,
} from '@/components/payroll-policy-field';
import { hireOptionVisible } from '@/lib/hire-form-filter';
import {
  DEFAULT_EMPLOYMENT_TYPE,
  DRAFT_TABS,
  draftFamily,
  draftProvisionalEndOn,
  draftShowsEndDateBox,
  draftTaxResidency,
  missingByTab,
  missingForCreation,
  noBasicSalaryAmount,
  openingTab,
  stepNumber,
  withSameAsPermanent,
  type DraftTabKey,
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
  initialTab,
  companies,
  businessUnits,
  departments,
  positions,
  costCenters,
  grades,
  managers,
  nationalityOptions,
  profileOptions,
  relationshipOptions,
  countryOptions,
  stateOptions,
  payrollOn = false,
  payrollPolicies = [],
}: {
  today: string;
  draftId: string;
  /** The Employee ID held for this record since Create (item 06f0cb8f). Null only on a draft written
   *  before that item — it then behaves exactly as it always did and is issued an ID at Activate. */
  reservedEmployeeCode: string | null;
  initialData: EmployeeDraftData;
  initialStep: number;
  /** 759dfc7d — the `?tab=` the shell itself wrote into the address bar, read back by the server page.
   *  Present on a reload or a shared link, absent when the draft is opened from the Personnel list; the
   *  stored `initialStep` is the fallback, and an unknown value is ignored (`openingTab`). */
  initialTab?: string;
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
  /** a72610af — the tenant's ACTIVE Salutation / Religion / Race options, read the SAME way the Personnel
   *  profile card reads them, so a value HR can pick here is one `updatePerson` will accept at Activate.
   *  Trimmed to value+label+id: this is a client component and a catalog row's sort order and active flag
   *  would be columns in the browser bundle that nothing on the page reads. */
  profileOptions: { salutation: ComboboxOption[]; religion: ComboboxOption[]; race: ComboboxOption[] };
  /** 759dfc7d — the `dependentRelationship` and `country` catalogs the Family step needs, resolved on the
   *  server exactly as the Personnel Family tab resolves them. Empty is meaningful for the first: the step
   *  falls back to the five built-in relationships, so an unseeded tenant never sees a blank dropdown. */
  relationshipOptions: { value: string; label: string }[];
  countryOptions: { value: string; label: string }[];
  /** da7463b4 — the `state` catalog the two address blocks need, read exactly as the Personnel Contact &
   *  Address card reads it (active options only). `countryOptions` above is the SAME country catalog that
   *  card uses, so the address blocks share it rather than resolving a second copy of one list. */
  stateOptions: { value: string; label: string }[];
  /** r393 (685d2380 step 2) — is Payroll switched on for this draft's company? Decides whether the Payroll
   *  tab shows the Payroll Policy picker at all (the record's own rule). Absent ⇒ off. */
  payrollOn?: boolean;
  /** r393 — the draft company's ACTIVE payroll policies (`listAssignablePolicies`), plain data. Blank in
   *  the picker is the Monthly default. Empty when Payroll is off. */
  payrollPolicies?: AssignablePolicyOption[];
}) {
  const t = useTranslations('people.wizard');
  // r393 (685d2380 step 3b) — the Active record's own words for the Statutory (Malaysia) sections.
  const td = useTranslations('people.detail');
  const router = useRouter();
  const id = draftId;
  const [data, setData] = useState<EmployeeDraftData>(initialData);
  // WHICH TAB IS OPEN, MIRRORED — the shell owns it, this copy exists only so a save can record it as
  // `employee_draft.current_step` and a draft picked up two days later reopens where it was left. The
  // shell tells us on every switch (`onTabChange`); `selectTabRef` is the other direction, for the
  // outstanding-list links.
  // WHERE THE SCREEN OPENS: the `?tab=` in the address bar if it names one of these five tabs, otherwise
  // the stored step. Resolved ONCE here and used for both the shell's `defaultTab` and this mirror, so a
  // Save pressed on a URL-opened tab writes the number of the tab actually on screen.
  const openingKey = openingTab(initialTab, initialStep);
  const [tab, setTab] = useState<DraftTabKey>(openingKey);
  const selectTabRef = useRef<((key: DraftTabKey) => void) | null>(null);
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
  // r392 (685d2380 step 1) — and it is SHOWN only where the type needs one: Contract ("Contract End Date")
  // and Intern ("Internship End Date"). Full-Time works its probation end out from the Probation Period
  // (`draftProvisionalEndOn`, the same function Activate calls) and Part-Time carries none.
  const employmentType = data.employment?.employmentType ?? DEFAULT_EMPLOYMENT_TYPE;
  const isContractHire = employmentType === 'contract';
  const showsEndDateBox = draftShowsEndDateBox(employmentType);
  const endDate = draftProvisionalEndOn(data.employment);
  // The box's name for the outstanding list. Literal `t()` calls rather than a computed key — a template
  // key is invisible to test/i18n-coverage.test.ts check C. Null for the two types that show no box.
  const endDateLabel = isContractHire
    ? t('fields.contractEndDate')
    : employmentType === 'intern'
      ? t('fields.internshipEndDate')
      : null;
  /**
   * The outstanding list's label for a field name, in the words the TAB uses. Two names are relabelled by
   * r392: `hiredOn` is shown on the tab as "Group Join Date" (its key `fields.hiredOn` is retired), and
   * `provisionalEndOn` takes the box's own type-specific name. Everything else is `fields.<name>` as before
   * — test/employee-draft-wizard.test.ts §2 sweeps every name either rule can return in all six locales.
   */
  const missingFieldLabel = (f: string) => {
    if (f === 'hiredOn') return t('fields.groupJoinDate');
    if (f === 'provisionalEndOn') return endDateLabel ?? t('fields.provisionalEndOn');
    return t(`fields.${f}`);
  };

  // r393 (685d2380 step 3b) — the pack's statutory rules (EPF election, income tax residency), so the tab
  // names what Activate would refuse. 'MY' for the same reason SocsoEisFields is handed country="MY" below.
  const statutoryRules = clientPackFor('MY')?.statutory;
  const missing = useMemo(() => missingByTab(data, statutoryRules), [data, statutoryRules]);
  const outstanding = useMemo(() => missingForCreation(data, statutoryRules), [data, statutoryRules]);
  /**
   * r374 (item 7dbaf677) — IS THERE NO INITIAL BASIC SALARY? The Payroll tab's whole conditional rule.
   *
   * `noBasicSalaryAmount` is the SAME predicate `missingByTab` decides the requirement with, imported
   * rather than restated: a screen that marked Remarks required on its own reading of the box would
   * either ask for a reason the rule does not want, or hold Activate back over a field it never
   * starred. True for blank, whitespace and zero; false for a junk or negative amount, which are
   * refused outright and are not this case.
   */
  const noBasicSalary = noBasicSalaryAmount(data.payroll?.basicSalary);

  const set = <K extends keyof EmployeeDraftData>(section: K, patch: Partial<NonNullable<EmployeeDraftData[K]>>) => {
    setSaved(false);
    setData((d) => {
      const merged = { ...(d[section] ?? {}), ...patch };
      // da7463b4 — "same as permanent address" is a RULE, not a button: while it is ticked the
      // correspondence block is re-derived from the permanent one on EVERY profile edit, so correcting a
      // permanent line later moves the correspondence line with it. Applied to the STORED data rather
      // than only at render, so what is on screen is what a Save writes; `completeEmployeeDraft` applies
      // the same function again at Activate and is the authority.
      const next = section === 'profile' ? withSameAsPermanent(merged as EmployeeDraftData['profile']) : merged;
      return { ...d, [section]: next };
    });
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

  /** SAVE. Deliberately unvalidated, from whichever tab is open — that is the whole of what a draft is. */
  const saveDraft = () =>
    startTransition(async () => {
      setError(null);
      try {
        // `stepNumber`, NOT `indexOf + 1`: the stored number is declared in employee-draft-schema.ts
        // (5 is the retired `review` slot and stays retired), so counting positions here would write the
        // wrong number for every tab after it — and would move the drafts already parked on 5.
        await saveDraftAction(id, data, stepNumber(tab));
        setSaved(true);
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
        const res = await createEmployeeAction(id, data, stepNumber(tab));
        router.push(`/admin/personnel/${res.employmentId}?from=personnel`);
      } catch (e) {
        setError((e as Error).message);
      }
    });

  /**
   * THE TAB LABELS — one STATIC `t()` per tab, never a computed key built from the tab name.
   *
   * A template key is invisible to test/i18n-coverage.test.ts check C, and these five keys are the whole
   * point of the change: they carry the ACTIVE RECORD'S OWN WORDS onto the draft (pinned equal to
   * `people.detail.tabs.*` in all six locales by test/draft-record-tabs.test.ts). Written as a Record so
   * TypeScript refuses a tab with no label, and so the ORDER still comes from DRAFT_TABS rather than
   * from whatever order somebody typed them in here.
   */
  const tabLabel: Record<DraftTabKey, string> = {
    profile: t('tabs.profile'),
    job: t('tabs.job'),
    bankStatutory: t('tabs.bankStatutory'),
    payroll: t('tabs.payroll'),
    family: t('tabs.family'),
  };
  const tabs = DRAFT_TABS.map((key) => ({ key, label: tabLabel[key] }));

  /**
   * THE FIVE PANELS, ONE PER TAB — the SAME fields the wizard's five steps carried, regrouped under the
   * SAME card names the activated record uses.
   *
   * NOTHING WAS RE-ASKED AND NOTHING WAS DROPPED IN THE MOVE. Every control below is the one that was on
   * the step of the same name a commit ago, including the shared field groups 35b7af0a consolidated
   * (Nationality + Identity No, Date of Birth + Age, Gender + Marital Status, Bank, EPF, SOCSO/EIS, Tax
   * Category, Pay Mode/Term/Rate) — those already render the RECORD'S OWN labels, because they are the
   * record's own components. What this change adds around them is the record's tab names and the
   * record's card names, so the two screens finally read as one.
   *
   * THE CARDS PER TAB AND WHY THEY ARE SPLIT THAT WAY: the activated record puts the person's name and
   * identity on "Personal details" and the e-mail and phone on "Contact & address"; it puts the bank on
   * "Bank Information", EPF/SOCSO/EIS on "Statutory (Malaysia)" and the tax fields on "Identification &
   * Tax"; and it groups Employment under "Organisation" and "Employment Dates". The draft now does the
   * same, and `people.wizard.sections.*` is pinned to the record's own keys so the words cannot drift.
   *
   * WHAT IS DELIBERATELY NOT HERE: the record's ADDRESS lines, TP3, pay items, CP38, encashment,
   * emergency contacts, compensation revisions — every one of them is either a child-record register or a
   * column the draft blob has never carried. Adding a control for a field `completeEmployeeDraft` cannot
   * write is exactly the silent drop this item exists to prevent, so a field arrives on this screen only
   * when the activation path can carry it.
   */
  const panels: Partial<Record<DraftTabKey, ReactNode>> = {
    profile: (
      <>
        <Card>
          <SectionHeader title={t('sections.personalDetails')} />
          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
            {/* Full Name and Email were asked at Create and are STILL editable here — the plan pins
                only the Company and the Employee ID, and a name typed with a typo must not cost HR the
                whole record. The Employee ID block that used to sit above them is gone from this screen:
                the ID is settled, and it is shown in the header card, where it cannot be mistaken for a
                field. */}
            {/* a72610af — Salutation, First / Last / Preferred Name, Religion and Race are the SHARED
                group the Personnel Personal Details card renders (components/person-name-fields.tsx).
                Full Name goes in its `afterSalutation` slot so the SIX fields appear in exactly the order
                that card shows them (item 8c284478 put Salutation first deliberately) — the draft and the
                record now read as one form rather than two arrangements of the same questions.
                EVERY ONE OF THEM OPTIONAL: `missingByTab` judges none, because item 06f0cb8f split
                creation from completion precisely so details stop blocking creation. */}
            <PersonNameFields
              mode="controlled"
              value={data.profile ?? {}}
              catalogs={profileOptions}
              onChange={(patch) => set('profile', patch)}
              afterSalutation={
                <Field label={t('fields.fullName')}>
                  <input
                    className={inputCls}
                    value={data.profile?.fullName ?? ''}
                    onChange={(e) => set('profile', { fullName: e.target.value })}
                  />
                </Field>
              }
            />
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
            {/* da7463b4 — THE DATE OF BIRTH AND AGE NOW FILL THEMSELVES FROM THE NRIC HERE TOO.
                They already did on the activated record (item 354a500d) and in the bulk importer
                (feedback b9fd8fd5) and not on the draft, so the Age beside it read "Not Available" for
                the whole time a record was a draft — the exact "the draft screen is not the employee
                screen" complaint this item is. The decision is the SHARED one
                (`deriveDobFromIcInput` + `nextAutofilledDob`, components/ic-dob-autofill.tsx), reached
                through the country pack (`identity.dobFromIC`), never by importing localization/my. */}
            <IdentityNumberField
              mode="controlled"
              nationality={data.profile?.nationality}
              icNumber={data.profile?.icNumber}
              onChange={(icNumber) => set('profile', { icNumber })}
              dateOfBirth={data.profile?.dateOfBirth}
              onDateOfBirthChange={(dateOfBirth) => set('profile', { dateOfBirth })}
            />
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
          {/* a72610af — THE PASSPORT BLOCK, the SAME six fields the Personnel Identity Information card
              renders (components/passport-fields.tsx), under the same heading and in the same order.
              It sits inside Personal Details because that is where the record keeps it.

              OPTIONAL FOR EVERYBODY HERE, including a non-Malaysian. `setPassportProfileMY` makes the
              trio mandatory for a non-Malaysian WHENEVER IT IS CALLED, and `completeEmployeeDraft` calls
              it only when the draft carries a passport value — so this screen never becomes stricter than
              `hireEmployee` or the bulk importer. The one rule it does carry is all-or-nothing, judged by
              `missingByTab` on this tab, where a refusal costs nothing.

              THE ISSUING COUNTRY LIST IS THE NATIONALITY CATALOG, not the country one, because that is
              what the Personnel card is fed (its own comment calls the value a demonym). Passing the
              country catalog here instead would have HR storing "Malaysia" on a draft and "Malaysian" on
              the record — two spellings in one column, which is exactly the drift this item is closing. */}
          <div className="border-t border-border p-4">
            <PassportSectionTitle className="mb-3 text-sm font-medium text-foreground" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <PassportFields
                mode="controlled"
                value={data.profile ?? {}}
                countryOptions={nationalityOptions}
                onChange={(patch) => set('profile', patch)}
              />
            </div>
          </div>
        </Card>
        <Card>
          <SectionHeader title={t('sections.contactAddress')} />
          {/* THE TWO FIELDS CREATE ASKED FOR, still editable — the plan pins only the Company and the
              Employee ID, and an e-mail typed with a typo must not cost HR the whole record. They sit
              under the record's own "Contact & address" heading rather than beside the name, which is
              where the activated record keeps them. */}
          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
            <Field label={t('fields.primaryEmail')}>
              <input
                type="email"
                className={inputCls}
                value={data.profile?.primaryEmail ?? ''}
                onChange={(e) => set('profile', { primaryEmail: e.target.value })}
              />
            </Field>
            {/* da7463b4 — `perm-mobile-phone`, the id the activated record's Contact & Address card gives
                this same field. Two fields on this tab are now labelled "Mobile Phone Number" (this one and
                the Correspondence block's own, exactly as on the record), so the id is what tells them
                apart — and it is the id the "same as permanent" pairing is declared against. */}
            <Field label={t('fields.phone')}>
              <input
                id="perm-mobile-phone"
                className={inputCls}
                value={data.profile?.phone ?? ''}
                onChange={(e) => set('profile', { phone: e.target.value })}
              />
            </Field>
            {/* a72610af — Home Phone and Personal E-mail, the SHARED pair the Personnel Contact & Address
                card renders. The e-mail beside them above is the WORK address (`primaryEmail`, the login);
                these two are the employee's own, and the record has always kept both. */}
            <PersonContactExtraFields
              mode="controlled"
              value={data.profile ?? {}}
              homePhoneId="perm-home-phone"
              onChange={(patch) => set('profile', patch)}
            />
          </div>
          {/* ── da7463b4 — THE TWO ADDRESS BLOCKS, the SAME seven fields the Personnel Contact & Address
              card renders (components/address-fields.tsx), under the same two headings, in the same
              order, validated against the same two catalogs.

              NOTHING NEW WAS MODELLED FOR THIS. Every column already exists on `person` (item 3a25f5ee,
              migration 0213; the correspondence phone pair bf953339, migration 0304) and every value
              lands through `updatePerson`, the writer the record's own card saves through. The draft
              simply never carried them, so an address typed here had nowhere to go — the reporter's
              complaint, which is about drift rather than about a missing feature. This item adds NO
              column and NO migration.

              WHY THE TICK IS BETWEEN THEM AND NOT BESIDE THEM: it governs the block below it. Same
              placement as the record's card. What it MEANS here is stronger than there — see
              SameAsPermanentAddressControlled. */}
          <div className="border-t border-border p-4">
            <PermanentAddressTitle className="mb-3 text-sm font-medium text-foreground" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <AddressBlockFields
                mode="controlled"
                side="perm"
                value={{
                  addressLine1: data.profile?.permanentAddressLine1,
                  addressLine2: data.profile?.permanentAddressLine2,
                  addressLine3: data.profile?.permanentAddressLine3,
                  postcode: data.profile?.permanentPostcode,
                  city: data.profile?.permanentCity,
                  state: data.profile?.permanentState,
                  country: data.profile?.permanentCountry,
                }}
                stateOptions={stateOptions}
                countryOptions={countryOptions}
                onChange={(patch) =>
                  set('profile', {
                    ...(patch.addressLine1 !== undefined ? { permanentAddressLine1: patch.addressLine1 ?? '' } : {}),
                    ...(patch.addressLine2 !== undefined ? { permanentAddressLine2: patch.addressLine2 ?? '' } : {}),
                    ...(patch.addressLine3 !== undefined ? { permanentAddressLine3: patch.addressLine3 ?? '' } : {}),
                    ...(patch.postcode !== undefined ? { permanentPostcode: patch.postcode ?? '' } : {}),
                    ...(patch.city !== undefined ? { permanentCity: patch.city ?? '' } : {}),
                    ...(patch.state !== undefined ? { permanentState: patch.state ?? '' } : {}),
                    ...(patch.country !== undefined ? { permanentCountry: patch.country ?? '' } : {}),
                  })
                }
              />
            </div>
          </div>
          <div className="border-t border-border p-4">
            <SameAsPermanentTick
              checked={data.profile?.sameAsPermanent === 'yes'}
              onChange={(on) => set('profile', { sameAsPermanent: on ? 'yes' : '' })}
            />
          </div>
          <div className="border-t border-border p-4">
            <CorrespondenceAddressTitle className="mb-3 text-sm font-medium text-foreground" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <AddressBlockFields
                mode="controlled"
                side="corr"
                disabled={data.profile?.sameAsPermanent === 'yes'}
                value={{
                  addressLine1: data.profile?.correspondenceAddressLine1,
                  addressLine2: data.profile?.correspondenceAddressLine2,
                  addressLine3: data.profile?.correspondenceAddressLine3,
                  postcode: data.profile?.correspondencePostcode,
                  city: data.profile?.correspondenceCity,
                  state: data.profile?.correspondenceState,
                  country: data.profile?.correspondenceCountry,
                }}
                stateOptions={stateOptions}
                countryOptions={countryOptions}
                onChange={(patch) =>
                  set('profile', {
                    ...(patch.addressLine1 !== undefined ? { correspondenceAddressLine1: patch.addressLine1 ?? '' } : {}),
                    ...(patch.addressLine2 !== undefined ? { correspondenceAddressLine2: patch.addressLine2 ?? '' } : {}),
                    ...(patch.addressLine3 !== undefined ? { correspondenceAddressLine3: patch.addressLine3 ?? '' } : {}),
                    ...(patch.postcode !== undefined ? { correspondencePostcode: patch.postcode ?? '' } : {}),
                    ...(patch.city !== undefined ? { correspondenceCity: patch.city ?? '' } : {}),
                    ...(patch.state !== undefined ? { correspondenceState: patch.state ?? '' } : {}),
                    ...(patch.country !== undefined ? { correspondenceCountry: patch.country ?? '' } : {}),
                  })
                }
              />
              {/* bf953339 — the Correspondence block's OWN Mobile/Home pair, as on the record. Disabled
                  with the rest of the block while the tick is on, because they are copied with it. */}
              <CorrespondencePhoneFields
                mobile={data.profile?.correspondenceMobilePhone}
                home={data.profile?.correspondenceHomePhone}
                disabled={data.profile?.sameAsPermanent === 'yes'}
                onChange={(patch) => set('profile', patch)}
              />
            </div>
          </div>
        </Card>
      </>
    ),
    job: (
      <>
        <Card>
          <SectionHeader title={t('sections.organisation')} />
          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
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
            {/* r392 (685d2380 step 1) — "Direct Superior", the Personnel record's word for it, found by
                SEARCHING (Employee ID or part of a name) with the same Combobox that record uses. CONTROLLED
                MODE: no `name`, so nothing is posted by a hidden input — the pick is written into the draft
                state under the STORED key it has always had (`reportingManagerEmploymentId`), which
                `completeEmployeeDraft` hands `hireEmployee` unchanged. The people offered are unchanged
                too: page.tsx still reads `listManagerCandidates(session, { companyIds: scopeIds })`. */}
            <Field label={t('fields.directSuperior')}>
              <Combobox
                value={data.employment?.reportingManagerEmploymentId ?? ''}
                options={managers.map((m) => ({ value: m.id, label: m.label }))}
                placeholder={t('directSuperiorNone')}
                searchPlaceholder={t('directSuperiorSearch')}
                noResultsLabel={t('directSuperiorNoResults')}
                legacySuffix=""
                onValueChange={(v) => set('employment', { reportingManagerEmploymentId: v })}
              />
            </Field>
            {/* a72610af — THE `??` BELOW IS NO LONGER A DEFAULT, IT IS A GUARD, and the difference is the
                whole of the defect this item fixed. It used to be the only statement of "Full Time" on
                this screen: nobody chose it, nothing wrote it, `missingByTab` correctly reported the
                employment type outstanding, and Activate stayed switched off with the box reading Full
                Time. The value is now SEEDED INTO the draft server-side (`withEmploymentDefaults`, applied
                by page.tsx), so what is shown is what is stored and this expression only ever falls back
                if that seed is somehow skipped. It reads the SHARED constant rather than a second literal
                so the two can never disagree again. */}
            <Field label={t('fields.employmentType')}>
              <select
                className={inputCls}
                value={data.employment?.employmentType ?? DEFAULT_EMPLOYMENT_TYPE}
                onChange={(e) => set('employment', { employmentType: e.target.value })}
              >
                <option value="full_time">{t('employmentType.full_time')}</option>
                <option value="part_time">{t('employmentType.part_time')}</option>
                <option value="contract">{t('employmentType.contract')}</option>
                <option value="intern">{t('employmentType.intern')}</option>
              </select>
            </Field>
          </div>
        </Card>
        <Card>
          <SectionHeader title={t('sections.employmentDates')} />
          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
            {/* a72610af — same correction as the Employment Type select above: today's date is SEEDED
                into the draft by page.tsx, so this `??` is a guard rather than the screen's only
                statement of it. Before that it showed today and stored nothing. */}
            {/* r392 (685d2380 step 1) — labelled "Group Join Date", the Personnel record's name for the
                column this lands in. NOTHING MOVED: `hireEmployee` has always written BOTH hired_on (shown
                as Group Join Date) and join_date (the Join Date for the current company) from this one
                value, and the hint says so. The draft key stays `hiredOn`. */}
            <Field label={t('fields.groupJoinDate')}>
              <input
                type="date"
                className={inputCls}
                value={data.employment?.hiredOn ?? today}
                onChange={(e) => set('employment', { hiredOn: e.target.value })}
              />
              {/* 89ea527b — Group Join Date and Join Date are the same day at creation and become
                  movement-only afterwards. The wizard captures the one date, as the ticket asks. */}
              <p className="mt-1 text-xs text-muted-foreground">{t('hints.groupJoinDate')}</p>
            </Field>
            {/* 8590615a — for a CONTRACT hire this one date is the contract end date, so it says so. The
                field, its state and its draft key are unchanged (`provisionalEndOn`); only the label and the
                hint switch, and `hireEmployee` copies a contract hire's value into
                `employment.contract_end_date` as well, which is what closes the two-homes gap.

                r392 (685d2380 step 1) — THE BOX EXISTS ONLY FOR CONTRACT AND INTERN (`draftShowsEndDateBox`).
                For Full-Time the end of probation is worked out from the Probation Period below and shown
                as a read-only line; Part-Time carries no end date (Activate sends null whatever is stored).
                Literal `t()` calls per type, never a computed key (test/i18n-coverage.test.ts check C). */}
            {showsEndDateBox && (
              <Field label={isContractHire ? t('fields.contractEndDate') : t('fields.internshipEndDate')}>
                <input
                  type="date"
                  className={inputCls}
                  value={data.employment?.provisionalEndOn ?? ''}
                  onChange={(e) => set('employment', { provisionalEndOn: e.target.value })}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {isContractHire ? t('hints.contractEndDate') : t('hints.internshipEndDate')}
                </p>
              </Field>
            )}
            {/* a72610af — PROBATION, EXTENDED PROBATION, THE CONFIRMATION DATE AND THE TWO NOTICE
                PERIODS, each the SHARED control the Personnel Employment Dates card renders
                (components/employment-period-fields.tsx). All OPTIONAL.

                THEY DO NOT LAND THROUGH `hireEmployee` — `HireParams` accepts none of them. The columns
                live on `employment` and `setEmploymentInfo` writes them, which is why the draft could
                not carry them before: `completeEmployeeDraft` now composes hire-then-setEmploymentInfo,
                the same pair `commitEmployeeImport` has used since item 2983802f.

                THE EXTENDED CONFIRMATION DATE IS NOT HERE and must not be added. Item d27961e3 made
                probation extensions Movement-only: `setEmploymentInfo` honours that date solely under the
                `probationExtension` movement tag and silently ignores an untagged save, so a box for it
                on this screen would appear to work and do nothing. */}
            <EmploymentPeriodField
              mode="controlled"
              labelKey="probationPeriod"
              value={data.employment?.probationValue}
              unit={data.employment?.probationUnit}
              onChange={(patch) =>
                set('employment', {
                  ...(patch.value !== undefined ? { probationValue: patch.value } : {}),
                  ...(patch.unit !== undefined ? { probationUnit: patch.unit } : {}),
                })
              }
            />
            {/* r392 (685d2380 step 1) — FULL-TIME ONLY: when probation ends, READ-ONLY, from the SAME
                `draftProvisionalEndOn` that `completeEmployeeDraft` hands `hireEmployee`, so the date on
                this line is the date the employee is created with. A pre-r392 draft with no period keeps
                the end date it already holds, and the line says that is where it came from. */}
            {employmentType === 'full_time' && (
              <p className="self-end text-sm text-muted-foreground sm:col-span-2" data-probation-ends>
                {endDate.source === 'period' && endDate.date
                  ? t('probationEndsOn', { date: endDate.date })
                  : endDate.source === 'stored' && endDate.date
                    ? t('probationEndsOnStored', { date: endDate.date })
                    : t('probationEndsNone')}
              </p>
            )}
            <EmploymentPeriodField
              mode="controlled"
              labelKey="extendedProbationPeriod"
              value={data.employment?.extendedProbationValue}
              unit={data.employment?.extendedProbationUnit}
              onChange={(patch) =>
                set('employment', {
                  ...(patch.value !== undefined ? { extendedProbationValue: patch.value } : {}),
                  ...(patch.unit !== undefined ? { extendedProbationUnit: patch.unit } : {}),
                })
              }
            />
            <ConfirmationDateField
              mode="controlled"
              value={data.employment?.confirmationDate}
              onChange={(confirmationDate) => set('employment', { confirmationDate })}
            />
            <EmploymentPeriodField
              mode="controlled"
              labelKey="noticeBeforeConfirmation"
              value={data.employment?.noticeBeforeConfirmationValue}
              unit={data.employment?.noticeBeforeConfirmationUnit}
              onChange={(patch) =>
                set('employment', {
                  ...(patch.value !== undefined ? { noticeBeforeConfirmationValue: patch.value } : {}),
                  ...(patch.unit !== undefined ? { noticeBeforeConfirmationUnit: patch.unit } : {}),
                })
              }
            />
            <EmploymentPeriodField
              mode="controlled"
              labelKey="noticeAfterConfirmation"
              value={data.employment?.noticeAfterConfirmationValue}
              unit={data.employment?.noticeAfterConfirmationUnit}
              onChange={(patch) =>
                set('employment', {
                  ...(patch.value !== undefined ? { noticeAfterConfirmationValue: patch.value } : {}),
                  ...(patch.unit !== undefined ? { noticeAfterConfirmationUnit: patch.unit } : {}),
                })
              }
            />
          </div>
        </Card>
      </>
    ),
    bankStatutory: (
      <>
        <Card>
          <SectionHeader title={t('sections.bank')} />
          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
            {/* 35b7af0a group 5 — Bank and Bank Account Number are the SAME field group the Personnel Bank
                Information card renders (components/bank-account-fields.tsx). The wizard's Bank was a
                FREE-TEXT box where that card has been a pick-from-the-BNM-catalog select since item
                ef720d3a — so a hire could be created with "may bank" typed by hand, which reads fine to a
                human, shows unremarkably on the Personnel screen, and only surfaces when the first salary
                payment file is built for that employee. A bank name already typed into a draft is
                preserved as its own option rather than silently rewritten. The all-or-nothing rule stays
                the wizard's hint (missingByTab enforces it). */}
            <BankAccountFields
              mode="controlled"
              bankName={data.statutory?.bankName}
              bankAccountNo={data.statutory?.bankAccountNo}
              hint={t('hints.bankAccount')}
              onChange={(patch) => set('statutory', patch)}
            />
          </div>
          {/* r393 (685d2380 step 3a) — the custom payment holder, the SAME field group the Active profile's
              Bank Information card renders (components/custom-holder-fields.tsx). Ticking one opens its box;
              a ticked box left blank is listed as still needed (`missingByTab`) and refused before the
              employee is created. Everything entered lands through `pack.statutory.setBank` at Activate. */}
          <div className="px-4 pb-4" data-custom-holder>
            <CustomHolderFields
              mode="controlled"
              value={{
                enableCustomHolderName: data.statutory?.enableCustomHolderName,
                customHolderName: data.statutory?.customHolderName,
                enableCustomHolderId: data.statutory?.enableCustomHolderId,
                customHolderId: data.statutory?.customHolderId,
              }}
              onChange={(patch) => set('statutory', patch)}
            />
          </div>
        </Card>
        {/* r393 (item 685d2380 step 3b) — STATUTORY (MALAYSIA) IN THE ACTIVE PROFILE'S OWN THREE SECTIONS:
            EPF contribution, SOCSO & EIS information and Income Tax (PCB), with the same legends, fields,
            choices and wording (app/admin/personnel/[employmentId]/page.tsx statutoryCard + IdentityTaxCard),
            every control the SHARED one in its controlled branch. The "Identification & Tax" card the draft
            had is gone (its `sections.identityTax` key is retired, not deleted), and the training levy moved
            to its own Others Statutory card below, as on the record. What each value does at Activate, and
            which refusals are provoked before the employee is created, is in core/employee-draft.ts. */}
        <Card>
          <SectionHeader title={t('sections.statutoryMalaysia')} />
          <div className="flex flex-col gap-6 p-4">
            <fieldset data-draft-section="epf" className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
              <legend className="-ml-1 rounded-md bg-card px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-foreground">
                {td('epfContribTitle')}
              </legend>
              <p className="text-xs text-muted-foreground">{td('epfElectionHint')}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                {/* a72610af, r393 (685d2380 step 3b) — THE WHOLE EPF ELECTION: the seven categories and the
                    rate and amount boxes the Personnel EPF card shows, from the SAME component
                    (components/epf-election.tsx, controlled branch). The boxes are stored as the strings
                    typed; Activate sends them through the SAME `mapEpfUiMode` the record's form does, after
                    the pack's own rule has judged them. A refused box is named on the still-needed list. */}
                <EpfElectionControlled
                  value={{
                    epfMode: data.statutory?.epfMode,
                    epfEmployeeRate: data.statutory?.epfEmployeeRate,
                    epfEmployerRate: data.statutory?.epfEmployerRate,
                    epfEmployeeAmount: data.statutory?.epfEmployeeAmount,
                    epfEmployerAmount: data.statutory?.epfEmployerAmount,
                    epfManualReason: data.statutory?.epfManualReason,
                  }}
                  onChange={(patch) => set('statutory', patch)}
                />
              </div>
              {/* a72610af — the EMPLOYER BEARS switches. The contribution is still computed and reported IN
                  FULL on both legs; what changes is who funds the EMPLOYEE's share — the employer, out of
                  cost, instead of a deduction from net pay. Each is the SAME switch the Personnel card
                  renders, and (r393) now sits in the SAME section it does: EPF here, the other three under
                  SOCSO & EIS. */}
              <EmployerBearsSwitch
                mode="controlled"
                field="employerBearsEpf"
                value={data.statutory?.employerBearsEpf}
                onChange={(employerBearsEpf) => set('statutory', { employerBearsEpf })}
              />
            </fieldset>

            <fieldset data-draft-section="socsoEis" className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
              <legend className="-ml-1 rounded-md bg-card px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-foreground">
                {td('socsoEisCardTitle')}
              </legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{td('subjectToLegend')}</p>
                  {/* r393 (685d2380 step 3b) — "Subject to SKBBK", the Personnel card's own switch, label and
                      hint. Stored 'yes' / 'no'; absent and 'no' both land as the new-employee default, off. */}
                  <label className="flex items-center gap-2 text-sm" title={td('subjectToSkbbkHint')}>
                    <input
                      type="checkbox"
                      checked={data.statutory?.subjectToSkbbk === 'yes'}
                      onChange={(e) => set('statutory', { subjectToSkbbk: e.target.checked ? 'yes' : 'no' })}
                      className="size-4 rounded"
                    />
                    {td('subjectToSkbbk')}
                  </label>
                </div>
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground" title={td('employerBearsHint')}>
                    {td('employerBearsLegend')}
                  </p>
                  <EmployerBearsSwitch
                    mode="controlled"
                    field="employerBearsSocso"
                    value={data.statutory?.employerBearsSocso}
                    onChange={(employerBearsSocso) => set('statutory', { employerBearsSocso })}
                  />
                  <EmployerBearsSwitch
                    mode="controlled"
                    field="employerBearsEis"
                    value={data.statutory?.employerBearsEis}
                    onChange={(employerBearsEis) => set('statutory', { employerBearsEis })}
                  />
                  <EmployerBearsSwitch
                    mode="controlled"
                    field="employerBearsSkbbk"
                    value={data.statutory?.employerBearsSkbbk}
                    onChange={(employerBearsSkbbk) => set('statutory', { employerBearsSkbbk })}
                  />
                </div>
              </div>
            </fieldset>

            <section data-draft-section="incomeTax" className="flex flex-col gap-6 border-t border-border pt-4">
              <h3 className="text-sm font-semibold text-foreground">{td('incomeTaxPcbSection')}</h3>
              <fieldset className="flex flex-col gap-3">
                <legend className="mb-1 w-full text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {td('taxInfoLegend')}
                </legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label={td('taxNumber')}>
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
                  {/* r393 (685d2380 step 3b) — THE FULL LIST of income tax residency choices, the SAME select
                      the Personnel Income Tax (PCB) card renders (components/tax-residency-field.tsx). It
                      replaces the old Yes/No "Tax resident" (`isResident`, kept in the blob as legacy and
                      mapped forward by `draftTaxResidency` when no choice has been made, so a draft saved
                      before this change shows — and activates on — what it always would have). Under "Not
                      subject to income tax" it is disabled and shows that instead, as on the record. */}
                  <Field label={td('incomeTaxResident')}>
                    <TaxResidencySelect
                      mode="controlled"
                      none={data.statutory?.taxCategory === 'none'}
                      value={draftTaxResidency(data.statutory) ?? ''}
                      onChange={(taxResidency) => set('statutory', { taxResidency })}
                      notSetLabel={t('notSet')}
                    />
                  </Field>
                  {/* a72610af — THE TWO DISABILITY RELIEFS (OKU), the SAME controls the Personnel Income Tax
                      (PCB) card renders (components/tax-relief-fields.tsx). Both default to "No", so a draft
                      nobody has touched claims nothing.

                      WHY THEY BELONG AT HIRE rather than only afterwards: monthly tax is worked out from the
                      year to date, so setting a relief later makes the month of the change absorb the whole
                      year-to-date correction. Set here, there is no correction to absorb. */}
                  <DisabledReliefField
                    mode="controlled"
                    field="disabledIndividual"
                    value={data.statutory?.disabledIndividual}
                    onChange={(disabledIndividual) => set('statutory', { disabledIndividual })}
                  />
                  <DisabledReliefField
                    mode="controlled"
                    field="disabledSpouse"
                    value={data.statutory?.disabledSpouse}
                    onChange={(disabledSpouse) => set('statutory', { disabledSpouse })}
                  />
                </div>
                <DisabledReliefHints />
              </fieldset>
              <fieldset className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
                <legend className="-ml-1 rounded-md bg-card px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-foreground">
                  {td('childReliefLegend')}
                </legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {/* a72610af — HOW CHILD RELIEF IS MAINTAINED, the SAME control the Personnel card renders. */}
                  <ChildReliefModeField
                    mode="controlled"
                    value={data.statutory?.childReliefMode}
                    onChange={(childReliefMode) => set('statutory', { childReliefMode })}
                  />
                  {/* The head count typed on a draft, kept as it was. The figures the record works out from
                      the saved family (the qualifying-children count and the relief amount) appear once the
                      employee exists — the plan's "Good to know" says so. */}
                  <Field label={t('fields.numChildren')}>
                    <input
                      type="number"
                      min="0"
                      className={inputCls}
                      value={data.statutory?.numChildren ?? ''}
                      onChange={(e) => set('statutory', { numChildren: e.target.value })}
                    />
                  </Field>
                </div>
                {/* 99b2d6c0 (r336) — the same explanation of "Auto (from table)" the Personnel card now
                    carries, on the screen where the mode is FIRST chosen. */}
                <ChildReliefModeHint />
              </fieldset>
              {/* r393 (685d2380 step 3b) — "Employer bears tax contribution", the Personnel card's own switch,
                  label and hint. Stored 'yes' / 'no'; lands through `pack.statutory.setTax` at Activate. */}
              <fieldset className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm" title={td('employerBearsTaxHint')}>
                  <input
                    type="checkbox"
                    checked={data.statutory?.employerBearsTax === 'yes'}
                    onChange={(e) => set('statutory', { employerBearsTax: e.target.checked ? 'yes' : 'no' })}
                    className="size-4 rounded"
                  />
                  {td('employerBearsTax')}
                </label>
                <p className="text-xs text-muted-foreground">{td('employerBearsTaxHint')}</p>
              </fieldset>
            </section>
          </div>
        </Card>
        {/* r393 (685d2380 step 3b) — OTHERS STATUTORY, its own card as on the record (below Statutory
            (Malaysia), the reporter-specified order there). a72610af — the per-employee TRAINING LEVY switch
            (HRD Corp / HRDF). A TRI-STATE whose default option is not "unset" but "follow the company's HRDF
            registration default", which is what every employee does until somebody overrides them. Feedback
            57840a6e is why that distinction matters: a control that wrote an explicit No by default excluded a
            whole company's staff from the levy for ever. */}
        <Card>
          <SectionHeader title={td('othersStatutoryTitle')} />
          <div data-draft-section="othersStatutory" className="flex flex-col gap-3 p-4">
            <p className="text-xs text-muted-foreground">{td('othersStatutoryHint')}</p>
            <HrdfSubjectField
              mode="controlled"
              value={data.statutory?.subjectToHrdf}
              onChange={(subjectToHrdf) => set('statutory', { subjectToHrdf })}
            />
            <p className="text-xs text-muted-foreground">{td('subjectToHrdfHint')}</p>
          </div>
        </Card>
      </>
    ),
    payroll: (
      <>
      <Card>
        <SectionHeader title={t('sections.compensation')} />
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
            {/* r374 (item 7dbaf677) — THE FLOOR IS ZERO, AND BLANK IS ALLOWED.
                The floor here used to be one sen (a min of 0.01 — DELIBERATELY NOT WRITTEN AS THE
                ATTRIBUTE, so a census grep for that floor across app/ and components/ does not get a
                false hit from this sentence; CLAUDE.md §8 says the same about the import ratchet). It
                was the only such floor on a basic salary anywhere in the tree, and with `missingByTab`
                demanding an amount above zero it kept Activate switched off until somebody typed one.
                A Director paid Director Fees quarterly has no monthly basic, so HR had to invent a
                figure. `min="0"` keeps the browser refusing a NEGATIVE amount — which `setCompensation`
                also refuses now, so the box and the service agree — while leaving blank and zero
                reachable. The placeholder says so in the box itself. */}
            <Field label={t('fields.basicSalary')}>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder={t('fields.basicSalaryBlankPlaceholder')}
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
                `missingByTab` already enforced invisibly and `setCompensation` enforces server-side.

                CLEARING THE RATE ON A SWITCH BACK TO MONTHLY is a wizard-only concern, hence the patch
                here rather than inside the shared component. On the Personnel form the Rate input simply
                unmounts and stops being submitted; the wizard holds a DRAFT object, so a rate typed under
                "hourly" would otherwise sit invisibly in the draft and reach setCompensation on create. */}
            <PayStructureFields
              mode="controlled"
              payMode={(data.payroll?.payMode ?? 'monthly') as PayModeOption}
              paymentTerm={data.payroll?.paymentTerm ?? 'monthly'}
              rateAmount={data.payroll?.rateAmount ?? ''}
              /* r374 — the reporter's requirement 3 names Pay Mode and Payment Term alongside Remarks
                 when there is no basic amount. They are marked required ON SCREEN and NOT by presence:
                 both are <select>s that always carry a value, and this very screen displays "Monthly"
                 for a draft that stores neither field (the `?? 'monthly'` above, with no matching
                 write) — so a presence rule would refuse a draft that looks complete. CLAUDE.md §8. */
              markRequired={noBasicSalary}
              requiredAriaLabel={t('requiredField')}
              onChange={(patch) =>
                set('payroll', {
                  ...patch,
                  ...(patch.payMode === 'monthly' ? { rateAmount: '' } : {}),
                })
              }
            />
            {/* r374 — REMARKS IS WHERE THE REASON GOES, and with no basic amount it is compulsory. That
                is the reporter's own condition (expected_behavior 4-5) and the only thing left of the
                refusal they rejected: a mistyped zero and a deliberate one are indistinguishable on the
                day they are saved, months before any run, and this one sentence tells them apart. The
                star and the hint below are driven by the SAME predicate `missingByTab` uses. */}
            <Field
              label={t('fields.remarks')}
              required={noBasicSalary}
              requiredAriaLabel={t('requiredField')}
            >
              <input
                className={inputCls}
                placeholder={noBasicSalary ? t('fields.remarksNoBasicPlaceholder') : undefined}
                value={data.payroll?.remarks ?? ''}
                onChange={(e) => set('payroll', { remarks: e.target.value })}
              />
            </Field>
            {/* SAID WHERE IT IS NEEDED, not after a save is refused. The outstanding list above the
                Activate button names the tab and the field; this names the RULE, on the tab, the moment
                the amount goes blank or to zero. */}
            {noBasicSalary && (
              <p className="text-xs text-amber-700 sm:col-span-2 dark:text-amber-400">
                {t('hints.noBasicSalary')}
              </p>
            )}
        </div>
      </Card>
      {/* r393 (685d2380 step 2) — HOW THIS EMPLOYEE IS PAID, the record's own select and the record's own
          heading (`sections.payMethodGroup`, pinned equal to people.detail.payMethodGroup). Bank Transfer
          needs the bank and the account number from the Bank & Statutory tab; until both are there
          `missingByTab` lists `paymentMethodBank` above the Activate button — the SAME predicate the
          record's writer refuses with — and the hint below says so where the choice is made. */}
      <Card>
        <SectionHeader title={t('sections.payMethodGroup')} />
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5" data-payment-method>
            <PaymentMethodField
              mode="controlled"
              value={data.payroll?.paymentMethod}
              onChange={(paymentMethod) => set('payroll', { paymentMethod })}
            />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">{t('hints.paymentMethodBankTransfer')}</p>
        </div>
      </Card>
      {/* r393 — THE PAYROLL POLICY, only where Payroll is switched on for this company (the record's
          `payrollOn` rule). The list is the record's: this company's active policies, blank = the Monthly
          default. The company is fixed on a draft (see the header), so a pick can never be left pointing
          at another company's policy by this screen; Activate refuses one that a blob somehow carries. */}
      {payrollOn && (
        <Card>
          <SectionHeader title={t('sections.payrollPolicy')} />
          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2" data-payroll-policy>
            <PayrollPolicyField
              mode="controlled"
              value={data.payroll?.payrollPolicyId}
              policies={payrollPolicies}
              onChange={(payrollPolicyId) => set('payroll', { payrollPolicyId })}
            />
            <PayrollPolicyHint className="text-xs text-muted-foreground sm:col-span-2" />
          </div>
        </Card>
      )}
      </>
    ),
    /* 759dfc7d work item 1 — FAMILY, the one tab of the activated record a draft could never have had,
       because `employee_dependent` is keyed to a person and a draft creates none. It is edited into the
       draft's own blob and materialised into real rows at Activate. It brings its OWN card (titled from
       `people.detail.family.title`, the record's own key) because it is a register with a table and a
       dialog rather than a grid of fields. */
    family: (
      <DraftFamilyStep
        members={draftFamily(data)}
        onChange={setFamily}
        relationshipOptions={relationshipOptions}
        countryOptions={countryOptions}
      />
    ),
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
        {/* 759dfc7d work item 2 — THE STATUS IS A LABEL ON THE RECORD, which is the plan's own sentence:
            "shown as a label on the record — Draft, pending activation — rather than as a different kind
            of screen". It sits in the header beside the ID, the name and the company, so what is
            different about this record is one badge rather than a whole other layout. `ml-auto` puts it
            at the far end of the header row, where the activated record's own status chip sits. */}
        <Badge variant="warning" className="ml-auto normal-case">
          {t('draftStatus')}
        </Badge>
        <p className="basis-full text-xs text-muted-foreground">{t('companyFixedAfterCreate')}</p>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {/* THE RECORD'S OWN TAB SHELL. `defaultTab` reopens the draft where it was left — `openingTab`
          prefers the `?tab=` the shell itself wrote into the address bar (so a reloaded or shared link
          opens the tab it names, exactly as the activated record does) and falls back to the stored
          `current_step`, including the retired 5, mapped onto a tab that still exists.
          `onTabChange` mirrors the switch back so the next save records it; `selectRef` is how the
          outstanding list below moves the shell, through the shell's OWN guarded switch rather than
          around it. `emptyLabel` can never actually show here (every one of the five tabs has a panel),
          and is passed because the shell requires a real string rather than a placeholder. */}
      <ClientTabs
        tabs={tabs}
        panels={panels}
        emptyLabel={t('tabs.empty')}
        defaultTab={openingKey}
        ariaLabel={t('progressLabel')}
        selectRef={selectTabRef}
        onTabChange={setTab}
      />

      {/* WHAT ACTIVATE IS STILL WAITING FOR — the plan's "the screen still says what is outstanding".
          Named in place, immediately above the button it governs, and visible from EVERY tab rather than
          on a step at the end; a disabled button that does not say why is the thing this replaces.
          `tabLabel[k]`, not a computed key: the outstanding list names the same tab the strip does,
          and it names it with the record's word for it. The name is the way to reach it — the button
          calls the shell's OWN `selectTab` through `selectRef`, so a jump is the identical switch a
          click on the strip is. That matters beyond tidiness: the draft registers no unsaved-changes
          scope today (nothing here is written until Save), and routing through the shell means it
          inherits the prompt automatically on the day one is added, instead of being the one path
          around it. */}
      {outstanding.length > 0 && (
        <div className="rounded-lg border border-border px-4 py-3 text-sm">
          <div className="font-medium">{t('activateNeeds')}</div>
          <ul className="mt-1.5 space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
            {DRAFT_TABS.filter((k) => missing[k].length > 0).map((k) => (
              <li key={k}>
                <button
                  type="button"
                  className="font-medium underline underline-offset-2"
                  onClick={() => selectTabRef.current?.(k)}
                >
                  {tabLabel[k]}
                </button>
                {' — '}
                {missing[k].map(missingFieldLabel).join(', ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* BACK AND NEXT ARE GONE with the wizard they belonged to. A draft is filled in over days in
          whatever order suits whoever is filling it in, so the tabs above are the navigation and there is
          no "next" for a screen with no sequence. What is left is the three things that act on the whole
          record: Save, Discard, Activate. */}
      <div className="flex flex-wrap items-center gap-2">
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
