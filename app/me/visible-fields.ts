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
 * ── SCOPE ───────────────────────────────────────────────────────────────────────────────────────────
 * Stage one (r259) was a READ surface: the two write paths that already existed on /me (the direct
 * contact self-edit, and the approval-gated change request — ADR-0012, core/profile.ts) were preserved
 * exactly as they were.
 *
 * Stage two (r260) WIDENED the second of those. Which fields may be asked about is declared once in
 * `lib/profile-requestable-fields.ts`, and every `labelKey` there is an entry of
 * `ME_VISIBLE_FIELD_LABEL_KEYS` below — enforced by test/profile-requestable-fields.test.ts, so an
 * employee can never be offered a change to a field they are not shown, and a request, a record and (in
 * stage three) a permission can never call one field by three different names. Stage two also added the
 * rejection reason. Stage three — the per-field permission SETTING and the approver-choice setting — is
 * still not built.
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
  // r260 stage two — the Profile tab gained its own "request a change" card, so the control to correct a
  // wrong passport number sits under the wrong passport number rather than on the Bank tab.
  profile: ['requestChangeProfileHeading'],
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
  /**
   * The COLUMN NAMES this entry withholds, as they are spelled on the admin reads (`employeeDetail`,
   * the MY pack's statutory row, `listDependents`, `compensationHistoryDetailed`).
   *
   * This is what turns a sentence for the reporter into a guard. test/me-profile-visibility.test.ts and
   * test/me-profile-scope.test.ts both drive their redaction check from `ME_WITHHELD_COLUMNS` below —
   * one greps app/me/record.ts + app/me/page.tsx, the other inspects the object a live read returns — so
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
export const ME_HIDDEN_FIELDS: readonly HiddenField[] = [
  // ── 1. Other people's data ────────────────────────────────────────────────────────────────────────
  {
    tab: 'bankStatutory',
    field: 'Duplicate income-tax-number warning',
    reason:
      'It names the OTHER employees filed under the same tax reference. A warning meant for HR would tell an employee who else shares their number.',
    columns: ['taxNumberSharedWith'],
  },
  {
    tab: 'job',
    field: 'Cost centre and cost-recharge allocation',
    reason:
      'Which companies this salary is charged to is the group’s internal accounting, not a fact about the person, and the percentages disclose an inter-company arrangement.',
    columns: ['costAllocation'],
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
    columns: ['remarks', 'occupation', 'companyName', 'employerAddress', 'spouseWorking'],
  },

  {
    tab: 'family',
    field: 'Dependant identity, address, marriage and study details',
    reason:
      'The Family card shows who is on the record and whether each child counts toward tax relief. A dependant’s own IC/passport, home address, marriage date and schooling are another person’s details, held for a payroll purpose and not printed back onto a self-service screen. (The dependant’s passport number and gender columns share their names with the employee’s own — which ARE shown — so they are named here rather than in `columns`.)',
    columns: [
      'icOrPassport',
      'residentialAddress',
      'marriageDate',
      'marriageStatus',
      'schoolName',
      'studyLevel',
      'studyCountry',
      'childReliefCategory',
      'childReliefPercentage',
      'deceasedOn',
    ],
  },

  // ── 2. The employer's commercial position ─────────────────────────────────────────────────────────
  {
    tab: 'bankStatutory',
    field: 'Employer-borne EPF / SOCSO / EIS / SKBBK / tax flags',
    reason:
      'These record which contributions the COMPANY absorbs on the employee’s behalf — an employment-cost arrangement, not the employee’s statutory position.',
    columns: [
      'employerBearsEpf',
      'employerBearsSocso',
      'employerBearsEis',
      'employerBearsSkbbk',
      'employerBearsTax',
    ],
  },
  {
    tab: 'bankStatutory',
    field: 'Child-relief rate table (full / half categories)',
    reason:
      'Tenant-level tax configuration shared by every employee; the employee’s own relief COUNT is shown, the grid behind it is not.',
    columns: ['childReliefTable', 'childReliefMode'],
  },
  {
    tab: 'payroll',
    field: 'Payroll policy assignment (which pay template applies)',
    reason:
      'Internal payroll configuration. What it produces — pay mode, payment term, the payslip — is shown; the template name is not.',
    columns: ['payrollPolicyId', 'payrollPolicyName', 'payrollPolicyStatus'],
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
    columns: ['contractRemark'],
  },

  {
    tab: 'job',
    field: 'Attendance, holiday-calendar and shift configuration',
    reason:
      'Which holiday calendar, shift pattern and geofence apply to this employment are operational settings HR assigns and changes. What they produce — the public holidays on the leave calendar, the clock-in the employee actually makes — is on My Absence and at the top of this screen; the assignment itself is not a field on the person.',
    columns: [
      'holidayGroupId',
      'holidayGroupName',
      'defaultShiftId',
      'shiftType',
      'geofencingEnabled',
      'geofenceRadiusM',
    ],
  },
  {
    tab: 'payroll',
    field: 'CP38 instalment orders',
    reason:
      'An LHDN order telling the EMPLOYER to deduct a fixed instalment of an employee’s tax arrears. The deduction itself appears on the employee’s own payslip, which My Profile shows; the order record — its reference, its start and end month, HR’s remark on it — is the employer’s compliance file, and the employee receives the order from LHDN directly.',
    columns: ['cp38Ref', 'cp38Amount'],
  },
  {
    tab: 'payroll',
    field: 'Zakat contribution setup',
    reason:
      'The state, method and rate by which zakat is computed for this employee is payroll configuration on the employer’s side; the amount it produces is a line on the employee’s own payslip and on their EA statement, both of which My Profile shows.',
  },
  {
    tab: 'profile',
    field: 'HR’s Permanent and Correspondence address block',
    reason:
      'Not a policy decision — an honest one about the data. `person` still carries TWO sets of address columns: the home address the employee maintains here, and the Permanent / Correspondence pair the Personnel screen writes. My Profile shows the one its own Save button changes, because showing both would put two different addresses on one card under a button that moves neither. Unifying them needs a database change, which is the next step and not this one.',
    columns: [
      'permanentAddressLine1',
      'permanentAddressLine2',
      'permanentAddressLine3',
      'permanentPostcode',
      'permanentCity',
      'permanentState',
      'permanentCountry',
      'correspondenceAddressLine1',
      'correspondenceAddressLine2',
      'correspondenceAddressLine3',
      'correspondencePostcode',
      'correspondenceCity',
      'correspondenceState',
      'correspondenceCountry',
      'correspondenceMobilePhone',
      'correspondenceHomePhone',
    ],
  },

  // ── 3. Internal judgements about this person ──────────────────────────────────────────────────────
  {
    tab: 'job',
    field: 'Blacklist flag and blacklist reason',
    reason:
      'An internal HR decision about re-employment. Disclosing it on a self-service screen would be the employee learning it from a web page.',
    columns: ['blacklistedAt', 'blacklistReason'],
  },
  {
    tab: 'payroll',
    field: 'Salary revision remarks and the full revision history',
    reason:
      'The CURRENT salary, currency and effective date are shown. The remark on each past revision is HR’s reasoning, and the increment history is a performance conversation, not a field.',
    columns: ['remarks', 'createdByName'],
  },
  {
    tab: 'documents',
    field: 'HR personnel-file documents (the Documents repository)',
    reason:
      'The file can hold a warning letter or an investigation note, and there is no per-document “visible to employee” switch yet. Payslips, EA statements and review letters — the documents meant FOR the employee — are shown.',
  },
  {
    tab: 'profile',
    field: 'Emergency contact remark',
    reason:
      'The register’s free-text note is HR’s (“call the sister first, the mother is overseas”). Who the contacts are, how to reach them, their address and their priority are all shown.',
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
    'icNumber',
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
    // The ONE home address on this card — the legacy `person.address_line1..country` block, which is the
    // block the contact self-edit writes. HR's Permanent / Correspondence pair is a different set of
    // columns and is NOT on this screen; see app/me/record.ts and the "one address" section of
    // docs/me-profile-field-visibility.md for why, and what would have to happen to unify them.
    'addressLine1',
    'addressLine2',
    'addressLine3',
    'postcode',
    'city',
    'stateLabel',
    'country',
    // The emergency-contact register, rendered as a table. `emergency.address` is here because the
    // self-edit fold-out posts it; `emergency.remarks` is withheld.
    'emergency.name',
    'emergency.relationship',
    'emergency.mobilePhone',
    'emergency.homePhone',
    'emergency.address',
    'emergency.priority',
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
    // r260 — the PCB category is now named with PERSONNEL'S OWN key. It used to render `me.pcbCategory`,
    // a second wording for a field HR already names `people.detail.taxCategoryLabel` on the
    // Identification & Tax card (components/tax-category-field.tsx, the 35b7af0a shared group). That is
    // precisely the drift this manifest exists to prevent, and stage two had to fix it because the field
    // is requestable: a request, a record and a permission may not call one field three things.
    'taxCategoryLabel',
    'epfNumber',
    'epfCitizenship',
    'socsoEisNumber',
    'socsoCategoryLabel',
    'eisCategoryLabel',
    'taxNumber',
    'incomeTaxResident',
    // 04b88724 — the Personnel card split one field into Physical children (this head count, which is
    // what `num_children` is and what Form E / CP8D / EA read) and Qualifying children (PCB). My Profile
    // follows the HEAD COUNT under Personnel's new caption; the qualifying figure is accounted for in
    // ME_UNRENDERED_PERSONNEL_FIELDS below.
    'childrenPhysical',
    'disabledIndividualLabel',
    'disabledSpouseLabel',
    'subjectToHrdf',
  ],
  payroll: [
    // `employmentInfo.company` labels WHICH employment this pay belongs to — an employee may hold two
    // (ADR-0009) and an unlabelled figure tells them nothing.
    'employmentInfo.company',
    'compensation',
    'salaryCurrency',
    'effectiveDate',
    'paymentMethod',
    'payMode',
    'paymentTerm',
    'rateAmount',
  ],
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

/**
 * Every column name the withheld list above forbids, flattened — the machine-readable half of the list.
 *
 * test/me-profile-visibility.test.ts greps app/me/record.ts and app/me/page.tsx for these;
 * test/me-profile-scope.test.ts looks for them in the object a LIVE read hands the page. Neither test
 * carries a list of its own any more, which is the point: the reporter's list, the document and the two
 * guards are one declaration, and extending the guard is something you do by writing a sentence for the
 * reporter rather than by remembering to edit an array in a test.
 */
export const ME_WITHHELD_COLUMNS: readonly string[] = [
  ...new Set(ME_HIDDEN_FIELDS.flatMap((f) => f.columns ?? [])),
];

/**
 * ── THE PERSONNEL → MY PROFILE DIRECTION, WHICH IS THE ONE THAT SILENTLY DRIFTS ─────────────────────
 *
 * Every `people.detail.*` FIELD LABEL the Personnel record renders and My Profile does not, each with the
 * reason it is not there. test/me-profile-visibility.test.ts reads the Personnel screen's own
 * `label={t('…')}` list and requires every key on it to be either in `ME_VISIBLE_FIELD_LABEL_KEYS` above
 * or in this map — so a field added to a shared Personnel group turns the suite red instead of quietly
 * never appearing on the employee's copy of their own record.
 *
 * WHY THIS MAP EXISTS AT ALL, given the plan said "reuse the Personnel section components, do NOT fork
 * them". Two of the three Personnel cards My Profile mirrors are not components: Contact & Address and
 * Employment Information are inline `<form action={…}>` markup inside
 * app/admin/personnel/[employmentId]/page.tsx, so there is nothing to mount. The shared field groups that
 * DO exist (person-details-fields, birth-date-fields, epf-registration-fields, …) are EDIT controls —
 * `mode: 'form'` renders a `name`-carrying `<select>` bound to a server action — and mounting one inside a
 * read surface would put a submittable control into a card that already has two real forms on it, which
 * is precisely what app/me/read-field.tsx exists to prevent. So My Profile renders the same catalogue
 * KEYS through a read-only field, and this map plus the guard closes the gap that forking would otherwise
 * leave open. Stage two, which makes fields requestable, is where the shared controls become the right
 * tool.
 *
 * A key is on this map for one of three reasons, and the sentence says which:
 *   • WITHHELD — it is on `ME_HIDDEN_FIELDS` above and in the reporter's document;
 *   • NOT A CARD THIS SCREEN CARRIES — it belongs to a Personnel tab My Profile does not mirror
 *     (Qualification, Movement, Attendance, Leave, Documents), or to a screen of its own (/leave);
 *   • AN HR CONTROL, NOT A FACT — a picker, a placeholder, a copy button or a filter, whose VALUE the
 *     employee already reads elsewhere on My Profile.
 */
export const ME_UNRENDERED_PERSONNEL_FIELDS: Readonly<Record<string, string>> = {
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
