/**
 * The Create New Employee wizard's shape and its completeness rules — item 6d671f44.
 *
 * Client-safe (no DB imports), because the SAME rules decide three things and they must not drift:
 *   - which tabs report something outstanding and which are clear, in the browser;
 *   - whether the Activate button is enabled;
 *   - whether `completeEmployeeDraft` will actually accept the draft, on the server.
 * The server re-runs BOTH rules authoritatively — this module is shared, not trusted.
 *
 * ITEM 06f0cb8f SPLIT THE ONE RULE IN TWO, and the split is the whole shape of the new workflow:
 *   - `missingToCreate` — the FOUR things Create asks for (Company, Employee ID, Full Name, Email).
 *     Satisfying it produces a Draft with a HELD Employee ID and nothing else.
 *   - `missingForCreation` — everything an employment actually needs (Department, Employment Type,
 *     Join Date, initial salary…). It is now the ACTIVATE rule, checked when a Draft becomes a person.
 * They are two rules and not one because the reporter's request is precisely that the second one stops
 * blocking the first. Both still run on the server before anything is created, so nothing that used to
 * be checked has stopped being checked; only WHEN it is checked moved.
 *
 * WHAT IS REQUIRED, AND WHERE IT DIFFERS FROM THE TICKET. The reporter listed Identity No and Position
 * among the mandatory fields. Neither is required here, deliberately:
 *   - IDENTITY NO is optional-but-validated. Item e3ce0d4d made `icNumber` nullable precisely so a
 *     non-Malaysian passport holder can be employed; making it mandatory again would re-close that door.
 *     A value that IS supplied must be a valid IC for the company's country pack, checked on the server.
 *   - POSITION is optional because it is optional in `hireEmployee` and in the bulk importer. Making the
 *     wizard stricter than the other two ways of creating an employee is how the three drift apart —
 *     the plan's own warning about import and hand-entry needing the same completion rules.
 * Everything else on their list (Employee Name, Company, Department, Join Date, Employment Type) is
 * required, plus the two the existing hire form already requires: work email and initial basic salary.
 *
 * ITEM bd271009 CHANGED TWO THINGS HERE. Company became the FIRST question (it decides the Employee ID
 * rule) and the Employee ID became conditionally required — see `MissingOptions`. 06f0cb8f then moved
 * both onto the Create screen, which is where `missingToCreate` now judges them.
 */
import { resolveEmployeeIdMode, type EmployeeIdRule } from './employee-id-mode';
import { copyPermanentToCorrespondence } from './address-blocks';

export type EmployeeDraftProfile = {
  fullName?: string;
  /** The Employee ID. On the Create screen it is the value HR types in Manual Key In mode (item
   *  bd271009 makes it required there, blank meaning "issue the running number"). AFTER Create it is a
   *  MIRROR of the reserved code held on the row (item 06f0cb8f) — the column
   *  `employee_draft.reserved_employee_code` is the authority, and the continue form shows this copy
   *  read-only, so a draft cannot carry an ID different from the one being held for it. */
  employeeCode?: string;
  /** The Auto / Manual radio PICK (item bd271009), remembered so a resumed draft reopens on it. It is
   *  advisory: `resolveEmployeeIdMode` re-decides against the LIVE setup every time, so a pick that the
   *  company's rule no longer permits is overruled rather than obeyed. */
  employeeIdMode?: string;
  primaryEmail?: string;
  phone?: string;
  gender?: string;
  dateOfBirth?: string;
  maritalStatus?: string;
  /** 35b7af0a group 8 — the nationality the whole identity fork turns on. Optional, like every other
   *  profile field here: the Personnel screen does not require one either, and making the wizard stricter
   *  than `hireEmployee` and the bulk importer is how the three creation paths drift apart (see the note
   *  above about Identity No and Position). ABSENT ON EVERY DRAFT SAVED BEFORE THIS CHANGE, which is why
   *  it is optional in the type as well as in the rules — an old draft must still open and still create. */
  nationality?: string;
  icNumber?: string;
  /**
   * ITEM a72610af — THE PROFILE FIELDS THE ACTIVATED RECORD HAS AND THE DRAFT DID NOT, all OPTIONAL.
   *
   * OPTIONAL IS NOT AN OVERSIGHT, IT IS THE DECISION 06f0cb8f MADE. That item split creation from
   * completion precisely so details stop blocking creation, and the note on `missingByTab` below says the
   * profile tab carries no required field ON PURPOSE. Adding fields is fine; making one required would
   * reverse that decision, so not one of these is judged by anything except a FORMAT rule.
   *
   * They land through `updatePerson` — the same writer the Personnel Profile tab saves through, and the
   * same one the bulk importer already uses for its address block (core/import.ts) — so a value typed on
   * a draft is written by the code that owns the column rather than by a second inline update.
   *
   * `salutation`, `religion` and `race` are CATALOG-BACKED (`profile_option`), so the wizard offers the
   * tenant's ACTIVE options exactly as it already does for nationality: a value HR can pick here is by
   * construction one `assertProfileValueAllowed` will accept at Activate.
   */
  salutation?: string;
  firstName?: string;
  lastName?: string;
  preferredName?: string;
  religion?: string;
  race?: string;
  /** bf953339 — `phone` above IS the Mobile Phone Number; this is the separate Home Phone Number. */
  homePhone?: string;
  /** The employee's own address, distinct from `primaryEmail` (the work / login address). */
  personalEmail?: string;
  /**
   * ITEM da7463b4 — THE TWO ADDRESS BLOCKS THE ACTIVATED RECORD HAS AND THE DRAFT DID NOT.
   *
   * NO MIGRATION AND NO NEW COLUMN: every one of these is a `person` column that has existed since item
   * 3a25f5ee (permanent/correspondence, migration 0213) and bf953339 (the correspondence phone pair,
   * migration 0304). The draft simply never carried them, so an address typed on the Create New Employee
   * screen had nowhere to go — which is the reporter's complaint, not a feature request.
   *
   * They land through `updatePerson`, the SAME writer `setContactAddressAction` uses on the record and
   * `commitEmployeeImport` uses for its address block. There is no second update and no second idea of
   * which columns these are.
   *
   * OPTIONAL, like every other profile field here, and judged by nothing: `missingByTab` returns no
   * required field on the profile tab ON PURPOSE (item 06f0cb8f split creation from completion so that
   * details stop blocking creation). `permanentState` / `permanentCountry` / `correspondenceState` /
   * `correspondenceCountry` are CATALOG-BACKED, so the wizard offers the tenant's ACTIVE options exactly
   * as it does for nationality and a value HR can pick is one `updatePerson`'s catalog check accepts.
   */
  permanentAddressLine1?: string;
  permanentAddressLine2?: string;
  permanentAddressLine3?: string;
  permanentPostcode?: string;
  permanentCity?: string;
  permanentState?: string;
  permanentCountry?: string;
  correspondenceAddressLine1?: string;
  correspondenceAddressLine2?: string;
  correspondenceAddressLine3?: string;
  correspondencePostcode?: string;
  correspondenceCity?: string;
  correspondenceState?: string;
  correspondenceCountry?: string;
  /** bf953339 — the Correspondence block's OWN mobile/home pair, independent of `phone` / `homePhone`
   *  above so the correspondence contact may differ from the person's own. */
  correspondenceMobilePhone?: string;
  correspondenceHomePhone?: string;
  /**
   * ITEM da7463b4 — "SAME AS PERMANENT ADDRESS", AND IT IS A STORED RULE, NOT A PRESSED BUTTON.
   *
   * 'yes' means the correspondence block is a DERIVED VIEW of the permanent one: correcting the permanent
   * address later moves the correspondence address with it, on the screen AND at Activate
   * (`copyPermanentToCorrespondence`, lib/address-blocks.ts, applied by `completeEmployeeDraft`). Absent
   * or anything else means the two are independent.
   *
   * IT HAS NO COLUMN AND MUST NOT GET ONE. A draft is one jsonb blob, so storing the tick here costs no
   * migration; on the ACTIVATED record the same tick is transient browser state precisely because there
   * is no `person` column for it, and inventing one is out of scope for a drift complaint. That is a real
   * divergence between the two screens and it is recorded in this round's entry rather than smoothed over.
   *
   * A STRING, 'yes' | absent, like the statutory switches — `hasAnyStatutory`-style trimming elsewhere in
   * this blob throws on a boolean, and every other value here is a string.
   */
  sameAsPermanent?: string;
  /**
   * ITEM a72610af — THE PASSPORT BLOCK, landing through the company pack's `setPassport`.
   *
   * ALL SIX ARE OPTIONAL, AND THE ONE RULE THEY CARRY IS ALL-OR-NOTHING, judged by `missingByTab` below
   * rather than by the writer. That is not a style preference: `setPassportProfileMY` throws
   * `PassportRequiredError` on a partial passport, and it can only run AFTER `hireEmployee` has committed
   * — so a half-typed passport discovered there fails an activation that has already created an employee.
   * Judged on the tab instead, where the cost of a refusal is nothing, exactly as the family list is.
   *
   * THE NON-MALAYSIAN "MANDATORY TRIO" RULE IS NOT IMPORTED HERE, deliberately. That writer makes the trio
   * mandatory for a non-Malaysian whenever it is CALLED; `completeEmployeeDraft` calls it only when the
   * draft carries at least one passport value, so a draft that names no passport at all still activates.
   * Doing otherwise would make the wizard stricter than `hireEmployee` and the bulk importer, which the
   * header of this file names as exactly how the three creation paths drift apart.
   */
  passportNumber?: string;
  passportIssueDate?: string;
  passportExpiryDate?: string;
  passportIssuingCountry?: string;
  /** e4b541c6 — the CP39's `Kod Negara`, ISO alpha-2. CHOSEN, never derived from the line above, which
   *  holds a nationality demonym: "Malaysian" is not "MY". */
  passportIssuingCountryCode?: string;
  passportRemark?: string;
};

export type EmployeeDraftEmployment = {
  companyId?: string;
  departmentId?: string;
  positionId?: string;
  costCenterId?: string;
  gradeId?: string;
  reportingManagerEmploymentId?: string;
  employmentType?: string;
  hiredOn?: string;
  provisionalEndOn?: string;
  /**
   * ITEM a72610af — THE PROBATION, CONFIRMATION AND NOTICE FIELDS THE EMPLOYMENT TAB HAS, all OPTIONAL.
   *
   * THEY DO NOT LAND THROUGH `hireEmployee`, and that is the whole reason they were not here already:
   * `HireParams` (core/org.ts) accepts none of them. The columns live on `employment` and their writer is
   * `setEmploymentInfo`. The bulk importer has done hire-then-`setEmploymentInfo` since item 2983802f
   * (core/import.ts) and already carries probation and notice, so both the precedent and the writer exist
   * — `completeEmployeeDraft` composes the same two calls rather than inventing a third path.
   *
   * STRINGS, like every other value in this blob, because they are the raw values of a number input and a
   * unit `<select>`; `setEmploymentInfo` parses and validates both. The 955c7de4 value+unit shape is the
   * one the Personnel screen uses — a period is "3 months" or "2 weeks", never a bare month count.
   *
   * `extendedProbationValue`/`Unit` ARE THE PERIOD, NOT THE EXTENDED CONFIRMATION DATE. That date is
   * MOVEMENT-ONLY (d27961e3: only `createMovementEvent`'s probationExtension may write it, and an
   * untagged save posting it is silently ignored), so it is not here and must not be added.
   */
  probationValue?: string;
  probationUnit?: string;
  extendedProbationValue?: string;
  extendedProbationUnit?: string;
  confirmationDate?: string;
  noticeBeforeConfirmationValue?: string;
  noticeBeforeConfirmationUnit?: string;
  noticeAfterConfirmationValue?: string;
  noticeAfterConfirmationUnit?: string;
};

/** The period units `setEmploymentInfo` accepts (core/org.ts `EMPLOYMENT_PERIOD_UNITS`), restated here
 *  so the client-side rule below and the shared field group can both read them without importing a
 *  server module. `test/draft-activation-field-survival.test.ts` pins the two lists equal. */
export const DRAFT_PERIOD_UNITS = ['month', 'week', 'day'] as const;

export type EmployeeDraftStatutory = {
  bankName?: string;
  bankAccountNo?: string;
  epfNumber?: string;
  socsoNumber?: string;
  taxNumber?: string;
  taxCategory?: string;
  numChildren?: string;
  /** 35b7af0a group 7 — the SOCSO / EIS contribution categories item a7271737 made the single
   *  per-scheme control on the Personnel screen. 'auto' keeps the PERKESO derivation, 'none' is the
   *  scheme off, and SOCSO additionally offers 'first' / 'second'. */
  socsoCategory?: string;
  eisCategory?: string;
  /** LEGACY, kept so a draft saved before group 7 still opens and still creates the same employee.
   *  The wizard no longer writes it; completeEmployeeDraft maps 'no' forward to eisCategory 'none'. */
  eisEligible?: string;
  isResident?: string;
  epfCitizenship?: string;
  /**
   * ITEM a72610af — THE EPF CATEGORY (`people.detail.epfMode`), the five-name election ADR-0046 defines.
   *
   * THE VALUE STORED HERE IS THE UI CATEGORY, not the lawful KWSP enum: 'auto' | 'manual_percentage' |
   * 'semi_auto' | 'none'. `lib/epf-mode-map.ts` `mapEpfUiMode` maps the names down to the lawful enum
   * values AT THE SERVER BOUNDARY, and `completeEmployeeDraft` calls the SAME mapper the
   * Personnel action calls — the client never decides the persisted enum.
   *
   * ⚠️ ITEM 70b14723 ADDED THREE MORE CATEGORIES AND THIS LIST OF FOUR IS STILL RIGHT. Manual (Employee by
   * Amount), Manual (Employer by Amount) and Manual (Employee and Employer by Amount) are NOT offered on a
   * draft, for a STRONGER version of the reason the rates are not (below): a manual category with no figure
   * elects nothing and `resolveEpfElection` REFUSES it outright, so unlike a rateless `voluntary_excess` it
   * is not a lawful election that cannot throw — it is one that WILL throw, inside a writer that only runs
   * after `hireEmployee` has committed. `completeEmployeeDraft` therefore maps any stray manual value to
   * 'auto' explicitly (`epfUiModeNeedsAmount`), and the wizard's own hint names the card that has the
   * boxes. See docs/adr/0087-epf-manual-amount-categories.md §12.
   *
   * THE TWO ELECTED RATES ARE DELIBERATELY NOT HERE, and it is a narrowing worth naming rather than
   * hiding: `resolveEpfElection` REFUSES a rate below the statutory floor, and it runs inside
   * `pack.statutory.set`, which `completeEmployeeDraft` can only call after `hireEmployee` has committed.
   * A below-floor rate typed on a draft would therefore fail an activation that had already created the
   * employee. Judging it here instead would need the floors on the client, and they are derived from the
   * MY pack's statutory tables — a server module this file may not import (it is shared with the
   * browser). A category with no rates is a lawful election that cannot throw: 'a blank side stays
   * statutory', which is what the card's own hint already tells HR. The rates stay where they can be
   * validated against the live tables, on the activated record.
   */
  epfMode?: string;
  /**
   * ITEM a72610af — THE FOUR "EMPLOYER BEARS" SWITCHES, 'yes' | 'no' | absent.
   *
   * STRINGS RATHER THAN BOOLEANS, unlike the family list's checkboxes, and for a concrete reason: every
   * other value in this section is a string, and `hasAnyStatutory` (core/employee-draft.ts) decides
   * whether a statutory row is created at all by trimming each value. A boolean in here would throw
   * there. 'no' and ABSENT both mean the same thing to the writer (`?? false`, the column default), so
   * the distinction costs nothing.
   *
   * What each one means is unchanged from the Personnel card: the contribution is still computed and
   * reported IN FULL; only the employee's share is funded from employer cost instead of being deducted
   * from net pay. `employerBearsSkbbk` is the SKBBK (Lindung 24 Jam) leg that rides on the SOCSO bands.
   */
  employerBearsEpf?: string;
  employerBearsSocso?: string;
  employerBearsEis?: string;
  employerBearsSkbbk?: string;
  /**
   * ITEM a72610af — THE TWO DISABILITY RELIEFS AND THE CHILD RELIEF MODE (item d64d0df4's fields).
   *
   * These are the employee's CIRCUMSTANCE — tenant data. The relief AMOUNT each entitles them to is
   * statutory and lives in the country pack's ruleset, never on a draft and never on the row.
   *
   * They land through `pack.setTax`, NOT through `pack.statutory.set`, because those are two different
   * writers over the same table and the tax one owns these columns. `completeEmployeeDraft` therefore
   * runs the tax write AFTER the statutory write and passes the statutory values through it — the same
   * ordering rule `lib/personnel-tab-sections.ts` declares for the Personnel screen's consolidated save,
   * and for the same reason: `setTaxProfileMY` is a partial-but-total overwrite of the tax columns.
   */
  disabledIndividual?: string;
  disabledSpouse?: string;
  childReliefMode?: string;
  /**
   * ITEM a72610af — THE TRAINING LEVY SWITCH (HRD Corp / HRDF), 'yes' | 'no' | absent.
   *
   * A TRI-STATE, and the absent case is the meaningful one: it means "follow the company's HRDF
   * registration default", which is what every employee does today. Only an explicit yes/no is an
   * override. It lands through `pack.setOthersStatutory`, its own partial-save writer.
   */
  subjectToHrdf?: string;
};

export type EmployeeDraftPayroll = {
  basicSalary?: string;
  monthlyAllowance?: string;
  payMode?: string;
  paymentTerm?: string;
  rateAmount?: string;
  remarks?: string;
};

/**
 * ONE FAMILY MEMBER, CAPTURED ON A DRAFT — item 759dfc7d, work item 1.
 *
 * WHY IT LIVES IN THE BLOB AND NOWHERE ELSE. `employee_dependent` is keyed to a PERSON, and the whole
 * point of a draft is that no person exists yet ("a draft still creates no person and no employment" —
 * db/schema.ts employeeDraft). So a family member entered before Activate has literally nowhere else to
 * be stored, and `completeEmployeeDraft` materialises these entries into real rows at the moment the
 * person is created (core/dependents.ts `materialiseDependents`).
 *
 * THE FIELD SET IS `DependentInput`'s, NAME FOR NAME, and that is deliberate rather than convenient:
 * a draft field with no counterpart on the writer is a field HR types and Activate silently drops — the
 * exact failure this item exists to prevent. `test/employee-draft-family.test.ts` §2 asserts the two
 * shapes still agree, field by field, so adding a column to `employee_dependent` without adding it here
 * fails a test instead of losing somebody's spouse's employer address.
 *
 * BOOLEANS ARE BOOLEANS, unlike the string-typed sections above. Those are strings because they mirror
 * text inputs the wizard round-trips verbatim; a checkbox has no such intermediate form, and storing
 * 'yes'/'no' would add a second encoding for `materialiseDependents` to decode. jsonb holds both.
 * `childReliefPercentage` stays a STRING because its control is a `<select>` whose value is '100' | '50'
 * | '' — parsed once, at materialisation, exactly as `basicSalary` is.
 */
export type EmployeeDraftFamilyMember = {
  /** Stable per-row key for the editor's list. UI-only: `materialiseDependents` never reads it, and the
   *  natural key (name, relationship, date of birth) is what makes activation idempotent. */
  key?: string;
  fullName?: string;
  relationship?: string;
  dateOfBirth?: string;
  gender?: string;
  icOrPassport?: string;
  isBeneficiary?: boolean;
  phone?: string;
  remarks?: string;
  passportNumber?: string;
  residentialAddress?: string;
  isDeceased?: boolean;
  deceasedOn?: string;
  marriageDate?: string;
  marriageStatus?: string;
  spouseWorking?: boolean;
  occupation?: string;
  companyName?: string;
  employerAddress?: string;
  isStudent?: boolean;
  schoolName?: string;
  studyLevel?: string;
  studyCountry?: string;
  childReliefCategory?: string;
  childTaxRelief?: boolean;
  /** '100' | '50' | '' — the `<select>`'s own value; parsed at materialisation. */
  childReliefPercentage?: string;
};

export type EmployeeDraftData = {
  profile?: EmployeeDraftProfile;
  employment?: EmployeeDraftEmployment;
  statutory?: EmployeeDraftStatutory;
  payroll?: EmployeeDraftPayroll;
  /** Item 759dfc7d — the Family tab's records, held here until Activate creates the person they belong to. */
  family?: EmployeeDraftFamilyMember[];
};

/**
 * The draft's family list, defensively. `data` is jsonb and therefore opaque to SQL and to the type
 * system alike: a draft written before this item has no `family` at all, and nothing stops a hand-edited
 * row carrying an object or a string where an array belongs. Every reader goes through here so a
 * malformed blob reads as "no family" instead of throwing on `.map`.
 */
export function draftFamily(data: EmployeeDraftData): EmployeeDraftFamilyMember[] {
  const f = data.family;
  if (!Array.isArray(f)) return [];
  return f.filter((m): m is EmployeeDraftFamilyMember => !!m && typeof m === 'object' && !Array.isArray(m));
}

/**
 * THE TABS A DRAFT GETS, in order — and every `key` is the ACTIVE EMPLOYEE RECORD'S OWN TAB KEY.
 *
 * ITEM 759dfc7d WORK ITEM 2 IS WHY THESE ARE TABS AND NOT STEPS. The draft used to be a five-step
 * wizard with its own vocabulary (`employment`, `statutory`) and its own labels; an activated employee
 * opened a tabbed record with different words for the same sections, so HR had two screens to learn for
 * one person. These keys are now `PersonnelTabKey` values — `profile`, `job`, `bankStatutory`,
 * `payroll`, `family` — and the screen labels them from `people.wizard.tabs.*`, which
 * test/draft-record-tabs.test.ts pins EQUAL to `people.detail.tabs.*` in all six locales. A label can
 * therefore no longer drift between the draft and the record it becomes.
 *
 * WHICH TABS A DRAFT DOES NOT GET, and why it is a rule rather than a list: Career Movement, Attendance,
 * Leave and Documents describe things that have HAPPENED to an employment, and a draft deliberately has
 * no employment for them to have happened to (db/schema.ts employeeDraft — "a draft still creates no
 * person and no employment"). Qualification and Others follow activation too; the plan says so in the
 * reporter's own words and invites them to reject it if they want Qualification earlier.
 *
 * THE ORDER IS THE PLAN'S OWN LIST — Profile, Employment, Bank & Statutory, Payroll, Family — which is
 * also the order the old steps ran in, and keeping it is not cosmetic. `stepNumber`/`stepKey` below map
 * this list onto `employee_draft.current_step`, a column already full of numbers written by the old
 * form; re-ordering the list would change which tab a stored number reopens on. The active record shows
 * Family SECOND rather than last, and that one difference is the price of not moving those numbers.
 *
 * `profile` MEANS SOMETHING NARROWER than it did before 06f0cb8f: Company, Full Name and Email are asked
 * at Create, so what remains is nationality, identity number, phone, date of birth, gender, marital
 * status. None is required by any writer, so this tab carries no required field at all and is complete
 * from the moment it opens — deliberately, because the reporter's complaint was that details blocked
 * creation.
 *
 * THE OLD KEYS `employment` AND `statutory` ARE GONE FROM THIS VOCABULARY, but NOT from the stored blob:
 * `EmployeeDraftData` still has `data.employment` and `data.statutory`, because those names are written
 * into every draft row on production and renaming them would orphan the lot. The tab key names the
 * SCREEN section; the data key names the STORED section; `missingByTab` is where the two meet.
 */
export const DRAFT_TABS = ['profile', 'job', 'bankStatutory', 'payroll', 'family'] as const;
export type DraftTabKey = (typeof DRAFT_TABS)[number];

/**
 * THE STORED STEP NUMBER, DECLARED RATHER THAN COUNTED — and 5 IS BURNED.
 *
 * `employee_draft.current_step` is a pointer into a list that has already changed twice. Until item
 * 06f0cb8f (c33d5518) the list was profile/employment/statutory/payroll/REVIEW and the wizard wrote
 * `indexOf(step) + 1`, so a draft left on the Review step is sitting in production RIGHT NOW as
 * `current_step = 5`. Removing `review` made 5 fall off the end and clamp to `payroll`, which is where
 * that cohort has reopened ever since.
 *
 * ITEM 759dfc7d WORK ITEM 2 CHANGED THE KEYS AND DELIBERATELY NOT THE NUMBERS. `employment` became
 * `job` and `statutory` became `bankStatutory` when the screen moved onto the record's tabs, but each
 * kept the number it already had, so a draft saved by the old wizard reopens on exactly the tab it was
 * left on. The COLUMN is still called `current_step` and is still an integer — there is no migration
 * here, which is the point: the draft is one jsonb blob plus this pointer, and neither changed shape.
 *
 * Numbering positionally would hand 5 to `family` and silently move the Review cohort onto a tab they
 * have never seen. So the mapping is explicit, `family` is 6, and 5 stays retired: `stepKey(5)` still
 * resolves to `payroll`. The general rule below (a number naming no tab resolves to the last tab BEFORE
 * it) means the next tab retired here costs nothing either.
 */
const STEP_NUMBERS: Record<DraftTabKey, number> = {
  profile: 1,
  job: 2,
  bankStatutory: 3,
  payroll: 4,
  family: 6,
};

/** 1-based step number ↔ tab key. `current_step` on the row is this number. */
export function stepNumber(key: DraftTabKey): number {
  return STEP_NUMBERS[key];
}
export function stepKey(n: number): DraftTabKey {
  const exact = DRAFT_TABS.find((k) => STEP_NUMBERS[k] === n);
  if (exact) return exact;
  const first = DRAFT_TABS[0];
  const last = DRAFT_TABS[DRAFT_TABS.length - 1];
  if (n <= STEP_NUMBERS[first]) return first;
  if (n >= STEP_NUMBERS[last]) return last;
  // A number INSIDE the range that names no tab — today only the retired `review` slot. Resolve it to
  // the last tab before it, so a draft parked on a step that no longer exists reopens where it has been
  // reopening rather than jumping forward onto whatever inherited its number.
  return [...DRAFT_TABS].reverse().find((k) => STEP_NUMBERS[k] < n) ?? first;
}

/**
 * WHICH TAB THE DRAFT OPENS ON — `?tab=` first, the stored step second.
 *
 * The tab shell reflects every switch into the address bar as `?tab=<key>` (components/personnel-tabs.tsx
 * `commitTab`), so for anyone who has been on the screen the URL is the FRESHER of the two statements:
 * `current_step` is only written when Save is pressed. A reloaded or shared draft link must therefore
 * reopen the tab the URL names — which is exactly what the ACTIVATED record does with the same parameter
 * (app/admin/personnel/[employmentId]/page.tsx passes it straight to `defaultTab`), and unifying those two
 * screens is the whole of item 759dfc7d work item 2. A URL that names a tab it will not open is worse
 * than no parameter at all.
 *
 * THE STORED STEP REMAINS THE FALLBACK, and it is the one that carries the reporter's actual need: a
 * draft picked up two days later from the Personnel list arrives with no `?tab=` at all and must still
 * reopen where it was left. An unknown value — a misspelling, or one of the six tabs a draft does not
 * get — is IGNORED rather than an error, because a tab name in a URL is a bookmark, not an instruction.
 */
export function openingTab(tabParam: string | null | undefined, currentStep: number): DraftTabKey {
  const named = DRAFT_TABS.find((k) => k === tabParam);
  return named ?? stepKey(currentStep);
}

const blank = (v: string | undefined) => (v ?? '').trim() === '';

/** The employment type the Employment tab opens on when a draft carries none. Named because
 *  `withEmploymentDefaults` seeds it and the wizard's select displays it, and those two must not drift. */
export const DEFAULT_EMPLOYMENT_TYPE = 'full_time';

/**
 * THE EMPLOYMENT TAB'S DEFAULTS, WRITTEN INTO THE DRAFT RATHER THAN ONLY DISPLAYED — item a72610af.
 *
 * THE DEFECT THIS EXISTS AGAINST, exactly. The Employment Type select rendered
 * `value={data.employment?.employmentType ?? 'full_time'}` and the Hire Date input
 * `value={data.employment?.hiredOn ?? today}` — DISPLAY fallbacks with no matching write. A draft nobody
 * touched therefore showed "Full Time" and today's date, stored NEITHER, and `missingByTab` below
 * correctly reported both outstanding, so Activate stayed disabled and reopening the draft showed the
 * same two values again. Two of six live production drafts were stuck in exactly that state. Nothing was
 * wrong with the saving or the checking: they agreed with each other, and the screen was showing a
 * default it never wrote down.
 *
 * SO THE SEED HAPPENS ONCE, ON THE SERVER, AGAINST THE DRAFT AS LOADED — never as a client effect, which
 * would re-apply the default on every render and fight anyone who deliberately cleared a field. That is
 * the pattern `withProbationDefault` already used for `provisionalEndOn` (which is why a stuck draft
 * already carried a probation-derived end date while carrying no employment type at all); this function
 * absorbs it so all three defaults are decided in ONE place and in the right order.
 *
 * THE ORDER IS LOAD-BEARING. The probation end date is derived from the employment type, so the type is
 * resolved FIRST and the derivation reads the RESOLVED value. Deriving it from `e.employmentType` while
 * seeding the type separately is how the production rows ended up internally inconsistent.
 *
 * `undefined` IS THE ONLY TRIGGER, and that is the whole precision of the fix: it mirrors the `??` the
 * display fallback used, so what is seeded is exactly what was being shown and nothing more. A value the
 * administrator has CLEARED is `''`, not `undefined` — it stays cleared, `missingByTab` keeps naming it,
 * and the screen keeps showing it blank. Re-filling a box somebody had just emptied would be a second
 * version of this same defect, pointing the other way.
 */
export function withEmploymentDefaults(
  data: EmployeeDraftData,
  seed: { hiredOn: string; provisionalEndOn: string },
): EmployeeDraftData {
  const e = data.employment ?? {};
  const employmentType = e.employmentType ?? DEFAULT_EMPLOYMENT_TYPE;
  const hiredOn = e.hiredOn ?? seed.hiredOn;
  // The probation/provisional end date keeps the rule it has always had — seeded only when the field has
  // never been touched, and only for a full-time hire (every other type's end date is user-supplied).
  // It reads `employmentType` above, not `e.employmentType`, so the two can never disagree.
  const provisionalEndOn =
    e.provisionalEndOn === undefined && employmentType === DEFAULT_EMPLOYMENT_TYPE
      ? seed.provisionalEndOn
      : e.provisionalEndOn;
  if (
    employmentType === e.employmentType &&
    hiredOn === e.hiredOn &&
    provisionalEndOn === e.provisionalEndOn
  ) {
    return data;
  }
  return { ...data, employment: { ...e, employmentType, hiredOn, ...(provisionalEndOn === undefined ? {} : { provisionalEndOn }) } };
}

/**
 * The Employee ID rule the draft is judged against (item bd271009), resolved from the LIVE setup by the
 * caller. Optional, and its ABSENCE is meaningful: omit the property and the Employee ID is not judged at
 * all. Two callers need exactly that — a screen spanning many companies with no single rule to apply, and
 * (item 06f0cb8f) any check made AFTER Create, where the ID is already held and settled.
 */
export type MissingOptions = { employeeIdRule?: EmployeeIdRule | null };

/** ISO yyyy-mm-dd, the only date shape any writer downstream accepts. */
export const DRAFT_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Field names (not messages) still outstanding before a Draft can be ACTIVATED, grouped by THE TAB that
 * owns them. An empty array for a tab is what clears its "still needed" line.
 *
 * ITEM 759dfc7d WORK ITEM 2 RENAMED THIS FROM `missingByStep`, and the rename is the whole point of the
 * rename: it is still THE ONE RULE, run in the browser to say what a tab is missing and re-run
 * authoritatively by `completeEmployeeDraft` (through `missingForCreation`) before anything is created.
 * Moving the screen onto tabs must not create a second, screen-shaped copy of it — a draft that showed
 * one list and refused for another is exactly how "the system should retain all information already
 * entered" turns into a surprise at the last button.
 *
 * THE KEYS ARE TAB KEYS, THE SECTIONS IT READS ARE STORED KEYS. `job` is judged from `data.employment`
 * and `bankStatutory` from `data.statutory`, because the blob's section names are written into every
 * draft row on production and are not renamed here. See the note on DRAFT_TABS.
 *
 * Returns FIELD names so the caller translates; returning English here would put UI strings in a
 * module the server also imports.
 */
export function missingByTab(data: EmployeeDraftData): Record<DraftTabKey, string[]> {
  const p = data.profile ?? {};
  const e = data.employment ?? {};
  const pay = data.payroll ?? {};

  // PROFILE DETAILS HAS NO REQUIRED FIELD (item 06f0cb8f). Company, Full Name and Email moved to the
  // Create screen and are `missingToCreate`'s business; what is left here is optional in every writer
  // downstream. The one rule it keeps is a FORMAT rule: a date of birth that is not ISO cannot be stored,
  // so a typo is named on the tab that owns it rather than at Activate.
  const profile: string[] = [];
  if (!blank(p.dateOfBirth) && !DRAFT_DATE_RE.test((p.dateOfBirth ?? '').trim())) profile.push('dateOfBirth');
  // ── The passport block (item a72610af) ─────────────────────────────────────────────────────────
  // NOT REQUIRED — most new joiners will never have one recorded here, and a tab that demanded one would
  // block every one of them. What IS required is that a passport somebody DID start can actually be
  // written: `setPassportProfileMY` refuses a partial block (PassportRequiredError), and it runs AFTER
  // `hireEmployee` has committed, so a half-typed passport discovered there fails an activation that has
  // already created an employee. Judged here, where a refusal costs nothing — the same shape as the Bank
  // tab's all-or-nothing rule and the Family tab's.
  const passportTrio = [p.passportNumber, p.passportIssueDate, p.passportExpiryDate];
  const passportAny = [...passportTrio, p.passportIssuingCountry, p.passportIssuingCountryCode, p.passportRemark]
    .some((v) => !blank(v));
  if (passportAny && passportTrio.some((v) => blank(v))) profile.push('passport');
  // Both passport dates reach Postgres as a `date` and throw THERE — after the employee exists — so a
  // value that is not ISO is named here instead, under the same name as the block it belongs to.
  for (const d of [p.passportIssueDate, p.passportExpiryDate]) {
    if (!blank(d) && !DRAFT_DATE_RE.test((d ?? '').trim()) && !profile.includes('passport')) {
      profile.push('passport');
    }
  }

  const job: string[] = [];
  if (blank(e.departmentId)) job.push('department');
  if (blank(e.employmentType)) job.push('employmentType');
  if (blank(e.hiredOn)) job.push('hiredOn');
  else if (!DRAFT_DATE_RE.test((e.hiredOn ?? '').trim())) job.push('hiredOn');
  if (!blank(e.provisionalEndOn) && !DRAFT_DATE_RE.test((e.provisionalEndOn ?? '').trim()))
    job.push('provisionalEndOn');
  // ── The probation / confirmation / notice block (item a72610af) ────────────────────────────────
  // Every one of them OPTIONAL. The rules below are the ones `setEmploymentInfo` ENFORCES BY THROWING,
  // restated here for the same reason the passport rule is: that writer runs after `hireEmployee` has
  // committed, so its refusals have to be provoked while nothing has been created yet.
  //
  //   • a confirmation date must be ISO and cannot precede the hire date ("Confirmation date cannot be
  //     earlier than the hire date." — core/org.ts). Checked against the draft's OWN hire date, which is
  //     what the writer will compare it to.
  //   • a period value must be a whole number of zero or more ("Period months/days must be whole
  //     numbers of 0 or more."), and its unit must be one the writer knows.
  const hiredOnIso = !blank(e.hiredOn) && DRAFT_DATE_RE.test((e.hiredOn ?? '').trim())
    ? (e.hiredOn ?? '').trim()
    : null;
  if (!blank(e.confirmationDate)) {
    const c = (e.confirmationDate ?? '').trim();
    if (!DRAFT_DATE_RE.test(c)) job.push('confirmationDate');
    else if (hiredOnIso && c < hiredOnIso) job.push('confirmationDate');
  }
  const periodValues = [e.probationValue, e.extendedProbationValue, e.noticeBeforeConfirmationValue, e.noticeAfterConfirmationValue];
  const periodUnits = [e.probationUnit, e.extendedProbationUnit, e.noticeBeforeConfirmationUnit, e.noticeAfterConfirmationUnit];
  const badPeriod =
    periodValues.some((v) => {
      if (blank(v)) return false;
      const n = Number((v ?? '').trim());
      return !Number.isInteger(n) || n < 0;
    }) ||
    periodUnits.some((u) => !blank(u) && !(DRAFT_PERIOD_UNITS as readonly string[]).includes((u ?? '').trim()));
  if (badPeriod) job.push('employmentPeriods');

  // Bank & Statutory has no REQUIRED field of its own — every value on it is optional in the writers
  // that consume it. The one rule it does carry is the importer's: bank name and account number are
  // all-or-nothing, because half a bank instruction cannot pay anybody.
  const s = data.statutory ?? {};
  const bankStatutory: string[] = [];
  if (blank(s.bankName) !== blank(s.bankAccountNo)) bankStatutory.push('bankAccount');

  const payroll: string[] = [];
  const salary = Number((pay.basicSalary ?? '').replace(/[,_]/g, ''));
  if (blank(pay.basicSalary)) payroll.push('basicSalary');
  else if (!Number.isFinite(salary) || salary <= 0) payroll.push('basicSalary');
  // Mirrors setCompensation: a daily or hourly worker without a positive rate cannot be paid.
  if ((pay.payMode === 'daily' || pay.payMode === 'hourly') && !(Number(pay.rateAmount) > 0))
    payroll.push('rateAmount');

  // ── Family (item 759dfc7d) ──────────────────────────────────────────────────────────────────────
  // NO FAMILY MEMBER IS REQUIRED — most new joiners have nothing to record here, and a tab that
  // demanded one would block every one of them. What IS required is that a member somebody DID add can
  // actually be written, because `materialiseDependents` runs AFTER `hireEmployee` has committed: a
  // nameless member discovered there fails an activation that has already created an employee, which is
  // the half-activated state this whole item exists to prevent. Judged here instead, where the cost of a
  // refusal is nothing, and re-judged on the server by `completeEmployeeDraft` before anything is written.
  //
  // The value-set rules (gender, the relationship catalog, marriage status, the relief category and
  // share) are NOT duplicated here: they need the tenant's catalog, so they belong to the server's
  // `assertDependentsValid`, which also runs before `hireEmployee`. Between them the two cover every
  // refusal the writer can make.
  const familySet = new Set<string>();
  for (const m of draftFamily(data)) {
    if (blank(m.fullName)) familySet.add('familyMemberName');
    if (blank(m.relationship)) familySet.add('familyMemberRelationship');
    // Every date the register stores. A value that is not ISO reaches Postgres as a `date` and throws
    // there — after the employee exists — so it is named here, on the tab that owns it.
    for (const d of [m.dateOfBirth, m.marriageDate, m.deceasedOn]) {
      if (!blank(d) && !DRAFT_DATE_RE.test((d ?? '').trim())) familySet.add('familyMemberDate');
    }
  }
  const family = [...familySet];

  return { profile, job, bankStatutory, payroll, family };
}

/**
 * Flat list of everything outstanding on the continue-a-draft form. Empty ⇒ the Draft can be ACTIVATED.
 *
 * The name is kept (item 06f0cb8f) because this is still, literally, what creation needs — it is the
 * moment creation happens that moved. Renaming it would have made every call site read as if the rule
 * had changed, when what changed is that a second, much shorter rule now runs first.
 */
export function missingForCreation(data: EmployeeDraftData): string[] {
  const byTab = missingByTab(data);
  return DRAFT_TABS.flatMap((k) => byTab[k]);
}

/**
 * The FOUR things Create asks for (item 06f0cb8f). Satisfying this reserves an Employee ID and produces
 * a Draft; it does not create a person, an employment or anything else.
 *
 * `opts.employeeIdRule` behaves exactly as it did on the old combined rule and for the same reason: its
 * ABSENCE means "do not judge the Employee ID at all". That is what a caller with no single rule to
 * apply needs — and, after Create, what a draft whose ID is ALREADY HELD needs, because a held code is
 * settled and re-asking whether it should have been typed by hand can only produce a false refusal.
 */
export function missingToCreate(data: EmployeeDraftData, opts: MissingOptions = {}): string[] {
  const p = data.profile ?? {};
  const e = data.employment ?? {};
  const out: string[] = [];
  // Company is FIRST, because it decides which Employee ID Auto Running Number Setup applies (item
  // bd271009) — and, from this item on, it is also fixed the moment Create succeeds: the held ID came
  // from this company's numbering rule, so changing the company afterwards would orphan the number.
  if (blank(e.companyId)) out.push('company');
  if ('employeeIdRule' in opts) {
    const decision = resolveEmployeeIdMode(opts.employeeIdRule, {
      chosen: p.employeeIdMode,
      hasCode: !blank(p.employeeCode),
    });
    if (decision.codeRequired && blank(p.employeeCode)) out.push('employeeCode');
  }
  if (blank(p.fullName)) out.push('fullName');
  if (blank(p.primaryEmail) || !EMAIL_RE.test((p.primaryEmail ?? '').trim())) out.push('primaryEmail');
  return out;
}

/** The drafts list needs a name even before one is typed; '' is rendered as "Untitled" by the screen. */
export function draftLabel(data: EmployeeDraftData): string {
  return (data.profile?.fullName ?? '').trim().slice(0, 200);
}


/**
 * APPLY "SAME AS PERMANENT ADDRESS" — item da7463b4. ONE rule, THREE callers, which is the whole design.
 *
 * The wizard calls it on every profile edit so the screen shows what is stored; `saveEmployeeDraft` stores
 * exactly that; and `completeEmployeeDraft` calls it AGAIN before writing, so the server is the authority
 * and a draft blob hand-edited to disagree with its own tick cannot produce a record that disagrees with
 * the screen. Same shape as `missingByTab` above and for the same reason: a rule the browser applies and
 * the server does not re-apply is a rule the browser can be talked out of.
 *
 * NOT IDEMPOTENT-BY-LUCK, idempotent BY CONSTRUCTION: the correspondence side is overwritten from the
 * permanent side outright (including with `undefined`), so applying it twice cannot differ from once, and
 * a permanent field CLEARED clears the correspondence one with it rather than leaving a stale line behind.
 */
export function withSameAsPermanent(profile: EmployeeDraftProfile | undefined): EmployeeDraftProfile {
  const p = profile ?? {};
  return p.sameAsPermanent === 'yes' ? copyPermanentToCorrespondence(p) : p;
}
