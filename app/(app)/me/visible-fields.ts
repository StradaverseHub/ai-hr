import {PERSONNEL_FIELDS} from '@/lib/personnel-field-registry';
import {ESS_PROFILE_TABS,PERSONNEL_ESS_SECTION_LABEL_KEYS} from '@/lib/personnel-ess-model';
/** Compatibility exports for source consumers; ESS authority lives on every shared Personnel descriptor.
 * Import/report scope never grants employee visibility or editing. */
/** All eleven Personnel tabs, in the approved Personnel order. */
export const ME_TABS = ['profile','family','job','careerMovement','attendance','bankStatutory','payroll','leave','documents','qualification','others'] as const;
export type MeTabKey = (typeof ME_TABS)[number];

/**
 * Tab label keys, resolved against the `people.detail` namespace.
 *
 * `job` is Personnel's key for the tab whose LABEL is "Employment" (people.detail.tabs.job = "Employment").
 * The key is kept rather than "corrected" to `employment`, because the key is the join between the two
 * screens; renaming it here would only rename it on one of them.
 */
export const ME_TAB_LABEL_KEY: Record<MeTabKey, string> = {
  profile: 'tabs.profile',
  job: 'tabs.job',
  bankStatutory: 'tabs.bankStatutory',
  payroll: 'tabs.payroll',
  family: 'tabs.family',
  documents: 'tabs.documents',
  careerMovement:'tabs.careerMovement',
  attendance:'tabs.attendance',
  leave:'tabs.leave',
  qualification:'tabs.qualification',
  others:'tabs.others',
};

/**
 * The cards each tab shows, in render order, named with Personnel's own section-title keys.
 *
 * Payroll and Documents carry two kinds of card: the Personnel-shaped master-data cards (named from
 * `people.detail.*`) and the employee's OWN self-service lists that only ever existed on /me — payslips,
 * TP1 relief, loans, EA statements, the resignation form. Those keep their `me.*` titles because Personnel
 * Management has no card for them at all; there is no second name to drift from. They are listed in
 * `ME_SELF_SERVICE_SECTIONS` so the document can account for every card on the screen.
 */
export const ME_SECTION_TITLE_KEY:Record<MeTabKey,readonly string[]>=Object.fromEntries<readonly string[]>(ME_TABS.map((tab,index)=>[tab,[...new Set(PERSONNEL_FIELDS.filter(field=>field.tab===ESS_PROFILE_TABS[index]&&field.ess.visibility==='visible').map(field=>PERSONNEL_ESS_SECTION_LABEL_KEYS[field.section]??ME_TAB_LABEL_KEY[tab]))]])) as Record<MeTabKey,readonly string[]>;

/** Cards that exist only on the employee's own screen — no Personnel counterpart, so `me.*` titles. */
export const ME_SELF_SERVICE_SECTIONS: Record<MeTabKey, readonly string[]> = {
  // r260 stage two — the Profile tab gained its own "request a change" card, so the control to correct a
  // wrong passport number sits under the wrong passport number rather than on the Bank tab.
  profile: [],
  job: [],
  bankStatutory: [],
  payroll: ['myPayslips', 'taxReliefTp1', 'myLoans'],
  family: [],
  documents: ['taxStatementEa', 'resignationTitle'],
  careerMovement:[],
  attendance:[],
  leave:[],
  qualification:[],
  others:[],
};

export type HiddenField = {
  /** Which Personnel tab the field would have appeared on, or 'all' for a whole Personnel tab. */
  tab: MeTabKey | 'all';
  /** The field or card, named the way HR would name it on the Personnel screen. */
  field: string;
  /** Why an employee may not see it. One sentence, in the reporter's language. */
  reason: string;
  /**
   * The COLUMN NAMES this entry withholds, as they are spelled on the admin reads (`employeeDetail`,
   * the MY pack's statutory row, `listDependents`, `compensationHistoryDetailed`).
   *
   * This is what turns a sentence for the reporter into a guard. test/me-profile-visibility.test.ts and
   * test/me-profile-scope.test.ts both drive their redaction check from `ME_WITHHELD_COLUMNS` below —
   * one greps app/(app)/me/record.ts + app/(app)/me/page.tsx, the other inspects the object a live read returns — so
   * adding a withheld field HERE arms both halves, and adding a projection in record.ts without adding
   * it here is what goes red. Both halves used to check a hand-written array of twelve names instead,
   * which is how `payrollPolicyStatus` and `holidayGroupName` could be projected with the suite green.
   *
   * ONLY NAMES THAT ARE UNAMBIGUOUS ACROSS THE READS. The static half greps for the name, so a column
   * whose name is also a name an employee legitimately DOES see cannot be guarded this way: a dependant's
   * `passportNumber` and `gender` are withheld but share their names with the employee's own passport
   * number and gender, which are shown. Those two are named in the reason instead of here, deliberately —
   * a guard that greps for `passportNumber` would fire on the field the screen is supposed to render.
   */
  columns?: readonly string[];
};

/**
 * EVERY FIELD AN EMPLOYEE MAY NOT SEE ON THEIR OWN RECORD, AND WHY.
 *
 * Three kinds of thing are on this list, and the distinction is worth keeping straight:
 *
 *   1. OTHER PEOPLE'S DATA reachable from a field on this person's record (the duplicate-tax-number
 *      warning names other employees; cost allocation names the companies that share this salary).
 *   2. THE EMPLOYER'S OWN COMMERCIAL POSITION (who bears which statutory contribution, which payroll
 *      policy template applies, an internal contract remark). Recorded against the employee, but not
 *      about the employee.
 *   3. AN INTERNAL JUDGEMENT ABOUT THIS PERSON (a blacklist reason, a salary-revision remark, an HR
 *      document that may be a warning letter). The most dangerous class: it IS their data, and it is
 *      still not a thing to hand them without an HR decision.
 */
export const ME_HIDDEN_FIELDS:readonly HiddenField[]=PERSONNEL_FIELDS.filter(field=>field.ess.visibility==='protected').map(field=>({
 tab:ME_TABS[ESS_PROFILE_TABS.indexOf(field.tab as typeof ESS_PROFILE_TABS[number])]??'all',field:field.label,reason:field.ess.reason,
 columns:PERSONNEL_FIELDS.some(visible=>visible.ess.visibility==='visible'&&visible.ownerField===field.ownerField)?[]:[field.ownerField],
}));

export const ME_VISIBLE_FIELD_LABEL_KEYS:Record<MeTabKey,readonly string[]>=Object.fromEntries<readonly string[]>(ME_TABS.map((key,index)=>[key,
 [...new Set(PERSONNEL_FIELDS.filter(field=>field.tab===ESS_PROFILE_TABS[index]&&field.ess.visibility==='visible'&&field.labelKey.startsWith('people.detail.')).map(field=>field.labelKey.slice('people.detail.'.length)))],
])) as Record<MeTabKey,readonly string[]>;

export const ME_WITHHELD_COLUMNS:readonly string[]=[...new Set(ME_HIDDEN_FIELDS.flatMap(field=>field.columns??[]))];

const LEGACY_UNRENDERED_PERSONNEL_FIELDS: Readonly<Record<string, string>> = {
  // ── Withheld — see ME_HIDDEN_FIELDS and docs/me-profile-field-visibility.md ────────────────────────
  'employmentInfo.contractRemark': 'WITHHELD — the HR note on the contract; the contract dates are shown.',
  salaryColRemarks: 'WITHHELD — HR’s reasoning on each salary revision; the current salary is shown.',
  childReliefModeLabel: 'WITHHELD — the tenant’s child-relief rate table; the employee’s relief count is shown.',
  childrenQualifying:
    'WITHHELD (04b88724) — the qualifying-children count the PCB projection counts in. It is worked out from ' +
    'the relief CLASSIFICATION HR records per child and the rate table above, both of which are already ' +
    'withheld for the same reason; showing the figure without them would be a number the employee cannot ' +
    'check. Their own child count is shown as Physical children, and the relief itself lands on the payslip.',
  'emergency.remarks': 'WITHHELD — HR’s free-text note on an emergency contact; the contact itself is shown.',
  'family.remarks': 'WITHHELD — HR’s free-text note about a dependant.',
  'family.occupation': 'WITHHELD — a working spouse’s occupation: a third party’s employment details.',
  'family.companyName': 'WITHHELD — a working spouse’s employer.',
  'family.employerAddress': 'WITHHELD — a working spouse’s employer address.',
  'family.residentialAddress': 'WITHHELD — a dependant’s own home address.',
  'family.passportNumber': 'WITHHELD — a dependant’s identity document.',
  'family.genderLabel': 'WITHHELD — a dependant’s recorded gender; the Family card shows name, relationship, age and relief.',
  'family.marriageDate': 'WITHHELD — a dependant’s marriage date, recorded for relief eligibility.',
  'family.marriageStatusLabel': 'WITHHELD — a dependant’s marital status, recorded for relief eligibility.',
  'family.schoolName': 'WITHHELD — a dependant’s school, recorded for the student-relief test.',
  'family.studyLevel': 'WITHHELD — a dependant’s level of study, recorded for the student-relief test.',
  'family.studyCountry': 'WITHHELD — a dependant’s country of study, recorded for the student-relief test.',
  'family.childReliefCategory': 'WITHHELD — HR’s relief CLASSIFICATION for a child; “Counts toward relief” is shown.',
  'family.childReliefPercentage': 'WITHHELD — the 100% / 50% split between two claiming parents, an HR tax setting.',
  'family.childReliefGuidance': 'WITHHELD — the LHDN rate guidance HR reads while classifying a child.',
  delegationDelegate: 'WITHHELD — approval delegations name other employees’ authority over this person’s approvals.',
  delegationFrom: 'WITHHELD — the delegation window; the delegation itself is withheld.',
  delegationTo: 'WITHHELD — the delegation window; the delegation itself is withheld.',
  cp38Ref: 'WITHHELD — the LHDN instalment order’s reference; the deduction appears on the payslip.',
  cp38Amount: 'WITHHELD — the instalment amount; it appears as a deduction on the employee’s own payslip.',
  cp38From: 'WITHHELD — the instalment order’s first month.',
  cp38To: 'WITHHELD — the instalment order’s last month.',
  cp38Remarks: 'WITHHELD — HR’s note on the instalment order.',
  payComponent: 'WITHHELD — the recurring pay-component setup; every amount it produces is on the payslip.',
  payComponentAmount: 'WITHHELD — part of the recurring pay-component setup.',
  payComponentCurrency: 'WITHHELD — part of the recurring pay-component setup.',
  payComponentEffectiveFrom: 'WITHHELD — part of the recurring pay-component setup.',
  payComponentEffectiveTo: 'WITHHELD — part of the recurring pay-component setup.',
  payComponentProrate: 'WITHHELD — part of the recurring pay-component setup.',
  payComponentRemarks: 'WITHHELD — HR’s note on a recurring pay component.',
  passportRemark: 'WITHHELD — an internal HR note on the passport record; the passport itself is shown.',
  customHolderId: 'WITHHELD — the identification of a THIRD PARTY who holds the bank account.',
  customHolderName: 'WITHHELD — the name of a THIRD PARTY who holds the bank account.',
  holidayCalendar: 'WITHHELD — which holiday calendar HR assigned; the holidays themselves are on My Absence.',
  holidayCalendarGroupOptgroup: 'WITHHELD — a grouping label inside the holiday-calendar picker.',
  holidayCalendarStateOptgroup: 'WITHHELD — a grouping label inside the holiday-calendar picker.',
  // f513ec02 (r281) — the Schedule Group assignment, added to the Personnel Attendance tab this round.
  // Withheld for the same reason as the holiday calendar directly above it, and stated the same way:
  // it is an operational setting HR assigns, and what it DECIDES — whether a day counts as late, when
  // early out starts, which overtime bands apply — already reaches the employee as their own attendance
  // figures. The assignment itself is not a fact about the person.
  scheduleGroup: 'WITHHELD — which Schedule Group HR assigned; what it decides (lateness, early out, overtime) shows on My Attendance.',

  // ── Not a card this screen carries ────────────────────────────────────────────────────────────────
  'qualification.description': 'NOT A CARD HERE — the Qualification tab is not one of the six tabs the plan names.',
  'qualification.fromYm': 'NOT A CARD HERE — Qualification tab.',
  'qualification.toYm': 'NOT A CARD HERE — Qualification tab.',
  'qualification.graduationDate': 'NOT A CARD HERE — Qualification tab.',
  'qualification.institute': 'NOT A CARD HERE — Qualification tab.',
  'qualification.level': 'NOT A CARD HERE — Qualification tab.',
  'qualification.major': 'NOT A CARD HERE — Qualification tab.',
  'qualification.result': 'NOT A CARD HERE — Qualification tab.',
  encashmentOverrideDaysLabel: 'NOT A CARD HERE — leave encashment lives on My Absence (/leave), not on this record.',
  encashmentReasonLabel: 'NOT A CARD HERE — leave encashment lives on My Absence (/leave).',
  'leaveStatus.partiallyApproved': 'NOT A CARD HERE — a leave-request status word; leave moved to My Absence (/leave).',
  tp3NetRemuneration: 'NOT A CARD HERE — the TP3 declaration of pay from a PREVIOUS employer, keyed in by HR at hire.',
  tp3EpfClaimed: 'NOT A CARD HERE — part of the TP3 previous-employer declaration.',
  tp3PcbPaid: 'NOT A CARD HERE — part of the TP3 previous-employer declaration.',
  appliesToYear: 'NOT A CARD HERE — the year selector on the TP3 / statutory-year data-entry forms.',
  'employmentInfo.probationPeriod': 'NOT A CARD HERE — the probation POLICY (value + unit) HR sets; the confirmation date it produces is shown.',
  'employmentInfo.extendedProbationPeriod': 'NOT A CARD HERE — the probation-extension policy; the final confirmation date it produces is shown.',
  'employmentInfo.noticeBeforeConfirmation': 'NOT A CARD HERE — the notice-period policy HR sets on the employment.',
  'employmentInfo.noticeAfterConfirmation': 'NOT A CARD HERE — the notice-period policy HR sets on the employment.',
  'employmentInfo.unit': 'NOT A CARD HERE — the “months / days” unit selector beside those policy numbers.',
  'employmentInfo.value': 'NOT A CARD HERE — the number box beside those policy numbers.',

  // ── An HR control, not a fact ─────────────────────────────────────────────────────────────────────
  basicSalaryMyr: 'AN HR CONTROL — the input on HR’s “add a salary revision” dialog; the salary itself is shown as Basic Salary.',
  salarySearchPlaceholder: 'AN HR CONTROL — the search box over the salary revision history, which is withheld.',
  status: 'AN HR CONTROL — the status filter on that same revision-history table.',
  sameAsPermanent: 'AN HR CONTROL — the “copy Permanent to Correspondence” button on HR’s address form.',
  photoEdit: 'AN HR CONTROL — the profile-photo upload control on the Personnel header.',
  grade: 'AN HR CONTROL — HR’s job-grade picker; the grade itself is shown as Employment Information → Job Grade.',
  directSuperiorLabel: 'AN HR CONTROL — HR’s superior picker; the superior is shown under the Direct Superior card’s own title.',
  passportIssuingCountryCode: 'AN HR CONTROL — the ISO code behind the issuing country, whose NAME is shown.',
};

// Existing control/workflow vocabulary is not a second inventory of business facts.
const visibleKeys=new Set(Object.values(ME_VISIBLE_FIELD_LABEL_KEYS).flat());
export const ME_UNRENDERED_PERSONNEL_FIELDS:Readonly<Record<string,string>>=Object.fromEntries(Object.entries(LEGACY_UNRENDERED_PERSONNEL_FIELDS).filter(([key])=>!visibleKeys.has(key)));
