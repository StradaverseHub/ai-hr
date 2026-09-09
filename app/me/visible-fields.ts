/**
 * MY PROFILE — WHAT AN EMPLOYEE SEES OF THEIR OWN RECORD, AND WHAT THEY DO NOT.
 *
 * r259 stage one (board item 9583deac). The approved plan promises the reporter, in writing:
 *
 *   "Some tabs will show less than the administrator's view even when the layout matches — an employee
 *    has no business seeing another person's cost centre or an internal note. The list of exactly which
 *    fields are hidden is written down and shown to you before stage one is built, not decided as we go."
 *
 * THIS FILE IS THAT LIST, and `docs/me-profile-field-visibility.md` is the same list written for the
 * reporter. They are held together by test/me-profile-visibility.test.ts, so the screen, the manifest and
 * the document cannot say three different things.
 *
 * ── WHY THE LABEL KEYS LIVE HERE ────────────────────────────────────────────────────────────────────
 * Every tab label and every card title below is a `people.detail.*` key — the SAME string Personnel
 * Management renders. That is the whole complaint this item was raised about: the employee and HR were
 * looking at two differently-named shapes of one person. Naming a tab here with a `me.*` key of its own
 * would re-open exactly that gap the first time someone renamed one of them, so /me reads Personnel's
 * own catalogue entry and the drift becomes structurally impossible rather than merely discouraged.
 * test/me-profile-visibility.test.ts asserts that every key named here is ALSO rendered by
 * app/admin/personnel/[employmentId]/page.tsx or by a shared component both screens mount — so a rename
 * on the Personnel side turns the suite red instead of silently splitting the two screens again.
 *
 * ── SCOPE OF THIS ROUND ─────────────────────────────────────────────────────────────────────────────
 * Stage one is a READ surface. The two write paths that already existed on /me (the direct contact
 * self-edit, and the approval-gated change request — ADR-0012, core/profile.ts) are preserved exactly as
 * they were; nothing new may be edited from this screen. Stages two and three widen which fields may be
 * requested and add the per-field permission setting; neither is built here.
 */

/** The six tabs the plan names, in the order it names them. Personnel's own keys. */
export const ME_TABS = ['profile', 'job', 'bankStatutory', 'payroll', 'family', 'documents'] as const;
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
export const ME_SECTION_TITLE_KEY: Record<MeTabKey, readonly string[]> = {
  profile: ['personalDetails', 'contactAddressTitle', 'emergencyTitle'],
  job: ['employmentInfo.title', 'directSuperiorTitle'],
  bankStatutory: ['bankCardTitle', 'statutoryMalaysia', 'othersStatutoryTitle'],
  payroll: ['compensation'],
  family: ['family.title'],
  documents: [],
};

/** Cards that exist only on the employee's own screen — no Personnel counterpart, so `me.*` titles. */
export const ME_SELF_SERVICE_SECTIONS: Record<MeTabKey, readonly string[]> = {
  profile: [],
  job: [],
  bankStatutory: ['approvalGatedHeading'],
  payroll: ['myPayslips', 'taxReliefTp1', 'myLoans'],
  family: [],
  documents: ['taxStatementEa', 'resignationTitle'],
};

export type HiddenField = {
  /** Which of the six tabs the field would have appeared on, or 'all' for a whole Personnel tab. */
  tab: MeTabKey | 'all';
  /** The field or card, named the way HR would name it on the Personnel screen. */
  field: string;
  /** Why an employee may not see it. One sentence, in the reporter's language. */
  reason: string;
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
export const ME_HIDDEN_FIELDS: readonly HiddenField[] = [
  // ── 1. Other people's data ────────────────────────────────────────────────────────────────────────
  {
    tab: 'bankStatutory',
    field: 'Duplicate income-tax-number warning',
    reason:
      'It names the OTHER employees filed under the same tax reference. A warning meant for HR would tell an employee who else shares their number.',
  },
  {
    tab: 'job',
    field: 'Cost centre and cost-recharge allocation',
    reason:
      'Which companies this salary is charged to is the group’s internal accounting, not a fact about the person, and the percentages disclose an inter-company arrangement.',
  },
  {
    tab: 'job',
    field: 'Delegations (who covers this person’s approvals)',
    reason:
      'An operational authority setting about other employees’ approval rights; changing it is an HR act, and reading it tells an employee who can approve in their name.',
  },
  {
    tab: 'family',
    field: 'Dependant remarks and employer details of a working spouse',
    reason:
      'Free-text HR notes about a family member, and a third party’s employer address, neither of which the employee record needs to show back.',
  },

  // ── 2. The employer's commercial position ─────────────────────────────────────────────────────────
  {
    tab: 'bankStatutory',
    field: 'Employer-borne EPF / SOCSO / EIS / SKBBK / tax flags',
    reason:
      'These record which contributions the COMPANY absorbs on the employee’s behalf — an employment-cost arrangement, not the employee’s statutory position.',
  },
  {
    tab: 'bankStatutory',
    field: 'Child-relief rate table (full / half categories)',
    reason:
      'Tenant-level tax configuration shared by every employee; the employee’s own relief COUNT is shown, the grid behind it is not.',
  },
  {
    tab: 'payroll',
    field: 'Payroll policy assignment (which pay template applies)',
    reason:
      'Internal payroll configuration. What it produces — pay mode, payment term, the payslip — is shown; the template name is not.',
  },
  {
    tab: 'payroll',
    field: 'Pay component catalogue and recurring component setup',
    reason:
      'HR master data for building pay. Every amount it produces already appears on the employee’s own payslip.',
  },
  {
    tab: 'job',
    field: 'Contract remark',
    reason:
      'A free-text HR note on the contract (“renew at revised rate”, “do not extend”). The contract DATES are shown; the note is an internal judgement.',
  },

  // ── 3. Internal judgements about this person ──────────────────────────────────────────────────────
  {
    tab: 'job',
    field: 'Blacklist flag and blacklist reason',
    reason:
      'An internal HR decision about re-employment. Disclosing it on a self-service screen would be the employee learning it from a web page.',
  },
  {
    tab: 'payroll',
    field: 'Salary revision remarks and the full revision history',
    reason:
      'The CURRENT salary, currency and effective date are shown. The remark on each past revision is HR’s reasoning, and the increment history is a performance conversation, not a field.',
  },
  {
    tab: 'documents',
    field: 'HR personnel-file documents (the Documents repository)',
    reason:
      'The file can hold a warning letter or an investigation note, and there is no per-document “visible to employee” switch yet. Payslips, EA statements and review letters — the documents meant FOR the employee — are shown.',
  },
  {
    tab: 'all',
    field: 'Change History / audit trail',
    reason:
      'It names which member of staff changed what and when. It is HR’s record of its own handling of the person.',
  },
  {
    tab: 'all',
    field: 'Data privacy tools (PDPA export / erasure controls)',
    reason: 'Administrative controls that act on the record; a request route, not a self-service button.',
  },
  {
    tab: 'all',
    field: 'Movement history (transfer / termination / blacklist events)',
    reason:
      'The event ledger carries the reasons behind each movement, including exit reasons recorded by HR before anything is communicated.',
  },
];

/**
 * Fields that ARE shown, keyed by the `people.detail.*` label the employee sees them under.
 *
 * The screen renders from this list, so "what the document promises" and "what the page prints" are one
 * declaration. A field added to the screen without being added here does not render; a field added here
 * without a translation fails test/i18n-coverage.test.ts.
 */
export const ME_VISIBLE_FIELD_LABEL_KEYS: Record<MeTabKey, readonly string[]> = {
  profile: [
    'employeeIdLabel',
    'salutation',
    'fullNameIc',
    'firstName',
    'lastName',
    'preferredName',
    'nationality',
    'religion',
    'race',
    'gender',
    'maritalStatus',
    'birthDate',
    'age',
    'identityNricTitle',
    'oldIcNumber',
    'passportNumber',
    'passportIssueDate',
    'passportExpiryDate',
    'passportIssuingCountry',
    'passportInfoTitle',
    'workEmail',
    'phone',
    'homePhone',
    'personalEmail',
    'permanentAddressTitle',
    'correspondenceAddressTitle',
  ],
  job: [
    'employmentInfo.company',
    'employmentInfo.department',
    'employmentInfo.position',
    'employmentInfo.businessUnit',
    'employmentInfo.jobGrade',
    'employmentInfo.employmentType',
    'employmentInfo.category',
    'employmentInfo.division',
    'employmentInfo.branch',
    'employmentInfo.region',
    'employmentInfo.line',
    'employmentInfo.section',
    'employmentInfo.team',
    'employmentInfo.base',
    'locationSelect',
    'employmentInfo.groupJoinDate',
    'employmentInfo.joinDate',
    'employmentInfo.groupService',
    'employmentInfo.currentCompanyService',
    'employmentInfo.confirmationDate',
    'employmentInfo.contractStartDate',
    'employmentInfo.contractEndDate',
    'employmentInfo.tenderResignationDate',
    'employmentInfo.resignationDate',
    'employmentInfo.lastWorkingDate',
    'directSuperiorTitle',
  ],
  bankStatutory: [
    'bank',
    'bankAccount',
    'epfNumber',
    'epfCitizenship',
    'socsoEisNumber',
    'socsoCategoryLabel',
    'eisCategoryLabel',
    'taxNumber',
    'incomeTaxResident',
    'childrenPcbRelief',
    'disabledIndividualLabel',
    'disabledSpouseLabel',
    'subjectToHrdf',
  ],
  payroll: ['compensation', 'salaryCurrency', 'effectiveDate', 'paymentMethod', 'payMode', 'paymentTerm'],
  family: [
    'family.name',
    'family.relationship',
    'family.dateOfBirth',
    'family.childAge',
    'family.contactNumber',
    'family.countsTowardRelief',
  ],
  documents: [],
};
