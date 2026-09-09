/**
 * THE FIELDS AN EMPLOYEE MAY ASK TO CHANGE — ONE DECLARATION, AND EVERY SURFACE READS IT.
 *
 * r260 stage two (board item 9583deac). The approved plan, in the reporter's own words:
 *
 *   "The request-and-approve path you already have is widened to the other fields you allow, instead of
 *    only bank details, family and PCB category."
 *
 * ── THE MECHANISM ALREADY EXISTED; THIS WIDENS IT ───────────────────────────────────────────────────
 * ADR-0012 has shipped two paths by risk since 0029: low-risk contact fields self-edit `person` under
 * RLS, and pay-affecting fields raise a `profile_change_request` an admin approves through
 * `assertCanDecide`. Stage two does NOT add a second store, a second workflow or a second approval
 * guard. It replaces the seven field names that were hard-coded in three different files with the list
 * below, and every one of those files now reads it:
 *
 *   · core/profile.ts        — sanitises a proposal and applies an approved one, per `target`/`column`;
 *   · app/me/actions.ts      — reads the form, one entry per key, instead of naming seven by hand;
 *   · app/me/request-change-card.tsx — renders the form, one control per entry;
 *   · app/me/page.tsx        — draws a pending request BESIDE the master value it would replace;
 *   · the admin approval surfaces — name each proposed field the way the employee's record names it.
 *
 * ── WHY `labelKey` IS A `people.detail.*` KEY AND NOT A WORDING OF ITS OWN ──────────────────────────
 * The plan's instruction, verbatim: widen to a declared set "keyed by the same field keys the
 * visibility manifest uses so a permission and a request can never disagree about what a field is
 * called". `app/me/visible-fields.ts ME_VISIBLE_FIELD_LABEL_KEYS` is that manifest, and every
 * `labelKey` below is one of its entries — which is the SAME catalogue key Personnel Management renders.
 * So the field an employee reads on their record, the field they ask to change, the field the approver
 * sees in the queue and (in stage three) the field a permission is granted over are one name resolved
 * from one place. test/profile-requestable-fields.test.ts fails the build if any entry names a key the
 * employee cannot see on their own record.
 *
 * ── WHAT IS DELIBERATELY NOT HERE, AND WHY THAT IS A STAGE-THREE ANSWER ─────────────────────────────
 * WHICH fields an employer allows is a SETTING, and the plan puts it in stage three: "A setting that
 * controls, field by field, which information an employee may ask to change." Until that exists there
 * has to be a default, so this list IS the default — the fields on the employee's own record whose
 * master HR owns and which feed pay, statutory filing or an identity document. Three classes are left
 * out on purpose and the reporter is told so in docs/me-profile-change-requests.md:
 *   · HR determinations (SOCSO / EIS category, tax residency, HRDF, disability relief) — those are
 *     assessments an employer makes, not facts an employee corrects;
 *   · anything on the withheld list (an employee cannot ask to change what they may not see);
 *   · the low-risk contact fields, which already save immediately and must not acquire a second,
 *     slower way to do the same thing.
 *
 * CLIENT-SAFE. No database import, exactly like lib/person-vocabulary.ts, so a server page, a server
 * action, a core service and (later) a client control can all read one list.
 */

/** Where an approved value is written. Two tables, because ADR-0012's two field families live in two. */
export type ProfileRequestTarget = 'person' | 'statutory';

/** How the request form renders the control for a field. */
export type ProfileRequestInput = 'text' | 'date' | 'number' | 'select';

export type RequestableField = {
  /** The key inside `profile_change_request.proposed` — the jsonb patch's own vocabulary. */
  readonly key: string;
  /**
   * The `people.detail.*` catalogue key this field is named by, on the employee's record AND on the
   * Personnel record. Must be an entry of ME_VISIBLE_FIELD_LABEL_KEYS (guarded).
   */
  readonly labelKey: string;
  /** Which of My Profile's six tabs the field is read on — the tab whose request card offers it. */
  readonly tab: 'profile' | 'bankStatutory';
  /** Which table an approval writes it to. */
  readonly target: ProfileRequestTarget;
  /** The drizzle column name on that table. Named here so core/profile.ts builds its write set from
   *  this list rather than from a parallel `if` ladder that can fall behind it. */
  readonly column: string;
  readonly input: ProfileRequestInput;
  /** `select` only: the allowed values, in render order, each with its `me.*` option label key. */
  readonly options?: readonly { readonly value: string; readonly labelKey: string }[];
  /** Marks a field the employee sees masked on their own record (the bank account number). The
   *  requested value is masked the same way — a pending request may not print in full what the
   *  master value is deliberately not printing. */
  readonly masked?: true;
};

/**
 * THE DECLARED SET. Order is render order within each tab.
 *
 * The first seven `statutory`/`person` entries marked "since 0029/#24" are the fields that were ALREADY
 * requestable; they are listed rather than special-cased, so there is one list and not a list plus a
 * legacy branch.
 */
export const PROFILE_REQUESTABLE_FIELDS: readonly RequestableField[] = [
  // ── Profile tab · your name and personal particulars (person) ─────────────────────────────────────
  // A name change is the request HR receives most (marriage, deed poll, a mis-keyed IC name). It is
  // approval-gated rather than self-edited because `person.full_name` is what prints on the payslip,
  // the EA statement and the bank file — ADR-0012's self-edit path has never been allowed to touch it.
  { key: 'salutation', labelKey: 'salutation', tab: 'profile', target: 'person', column: 'salutation', input: 'text' },
  { key: 'fullName', labelKey: 'fullNameIc', tab: 'profile', target: 'person', column: 'fullName', input: 'text' },
  { key: 'firstName', labelKey: 'firstName', tab: 'profile', target: 'person', column: 'firstName', input: 'text' },
  { key: 'lastName', labelKey: 'lastName', tab: 'profile', target: 'person', column: 'lastName', input: 'text' },
  { key: 'preferredName', labelKey: 'preferredName', tab: 'profile', target: 'person', column: 'preferredName', input: 'text' },
  // Nationality drives which identity document is mandatory and is the analytics counterpart of the EPF
  // citizenship the payroll kernel reads; religion and race are PDPA s.40 sensitive demographics that HR
  // reports on. All three are facts about the employee that only HR may write.
  { key: 'nationality', labelKey: 'nationality', tab: 'profile', target: 'person', column: 'nationality', input: 'text' },
  { key: 'religion', labelKey: 'religion', tab: 'profile', target: 'person', column: 'religion', input: 'text' },
  { key: 'race', labelKey: 'race', tab: 'profile', target: 'person', column: 'race', input: 'text' },
  // Since #24 — compliance-sensitive identity. DOB drives the EPF senior / SOCSO age bands, marital
  // status drives the PCB category, gender gates maternity / paternity eligibility.
  { key: 'dateOfBirth', labelKey: 'birthDate', tab: 'profile', target: 'person', column: 'dateOfBirth', input: 'date' },
  {
    key: 'gender',
    labelKey: 'gender',
    tab: 'profile',
    target: 'person',
    column: 'gender',
    input: 'select',
    options: [
      { value: 'male', labelKey: 'gender_male' },
      { value: 'female', labelKey: 'gender_female' },
      { value: 'undisclosed', labelKey: 'gender_undisclosed' },
    ],
  },
  {
    key: 'maritalStatus',
    labelKey: 'maritalStatus',
    tab: 'profile',
    target: 'person',
    column: 'maritalStatus',
    input: 'select',
    options: [
      { value: 'single', labelKey: 'marital_single' },
      { value: 'married', labelKey: 'marital_married' },
      { value: 'divorced', labelKey: 'marital_divorced' },
      { value: 'widowed', labelKey: 'marital_widowed' },
      { value: 'separated', labelKey: 'marital_separated' },
      { value: 'other', labelKey: 'marital_other' },
    ],
  },

  // ── Profile tab · the identity documents (employee_statutory_my) ──────────────────────────────────
  // An IC or passport correction is the second-commonest request and today has no route at all: the
  // employee reads the wrong number on their own record and can only e-mail somebody about it.
  { key: 'icNumber', labelKey: 'icNumber', tab: 'profile', target: 'statutory', column: 'icNumber', input: 'text' },
  { key: 'oldIcNumber', labelKey: 'oldIcNumber', tab: 'profile', target: 'statutory', column: 'oldIcNumber', input: 'text' },
  { key: 'passportNumber', labelKey: 'passportNumber', tab: 'profile', target: 'statutory', column: 'passportNumber', input: 'text' },
  { key: 'passportIssueDate', labelKey: 'passportIssueDate', tab: 'profile', target: 'statutory', column: 'passportIssueDate', input: 'date' },
  { key: 'passportExpiryDate', labelKey: 'passportExpiryDate', tab: 'profile', target: 'statutory', column: 'passportExpiryDate', input: 'date' },
  { key: 'passportIssuingCountry', labelKey: 'passportIssuingCountry', tab: 'profile', target: 'statutory', column: 'passportIssuingCountry', input: 'text' },

  // ── Bank & Statutory tab (employee_statutory_my) ──────────────────────────────────────────────────
  // Since 0029 — the original three areas.
  { key: 'bankName', labelKey: 'bank', tab: 'bankStatutory', target: 'statutory', column: 'bankName', input: 'text' },
  { key: 'bankAccountNo', labelKey: 'bankAccount', tab: 'bankStatutory', target: 'statutory', column: 'bankAccountNo', input: 'text', masked: true },
  {
    key: 'taxCategory',
    labelKey: 'taxCategoryLabel',
    tab: 'bankStatutory',
    target: 'statutory',
    column: 'taxCategory',
    input: 'select',
    options: [
      { value: '1', labelKey: 'pcbOption1' },
      { value: '2', labelKey: 'pcbOption2' },
      { value: '3', labelKey: 'pcbOption3' },
    ],
  },
  { key: 'numChildren', labelKey: 'childrenPcbRelief', tab: 'bankStatutory', target: 'statutory', column: 'numChildren', input: 'number' },
  // New in stage two — the registration numbers an employee is issued and HR records. Each is filed on
  // a statutory return (EPF Form A, SOCSO 8A, CP39), so a wrong one is a wrong filing, not a typo.
  { key: 'epfNumber', labelKey: 'epfNumber', tab: 'bankStatutory', target: 'statutory', column: 'epfNumber', input: 'text' },
  { key: 'socsoNumber', labelKey: 'socsoEisNumber', tab: 'bankStatutory', target: 'statutory', column: 'socsoNumber', input: 'text' },
  { key: 'taxNumber', labelKey: 'taxNumber', tab: 'bankStatutory', target: 'statutory', column: 'taxNumber', input: 'text' },
];

/** Every requestable key, in declaration order. */
export const PROFILE_REQUESTABLE_KEYS: readonly string[] = PROFILE_REQUESTABLE_FIELDS.map((f) => f.key);

const BY_KEY = new Map(PROFILE_REQUESTABLE_FIELDS.map((f) => [f.key, f] as const));

/** The declaration for one proposed key, or undefined when the key is not requestable. */
export function requestableField(key: string): RequestableField | undefined {
  return BY_KEY.get(key);
}

/** The fields offered on one tab's request card. */
export function requestableFieldsForTab(tab: RequestableField['tab']): readonly RequestableField[] {
  return PROFILE_REQUESTABLE_FIELDS.filter((f) => f.tab === tab);
}

/**
 * The bank account number as the employee's own record prints it — last four digits only.
 *
 * Shared by the record card and by the pending-request annotation beside it, because those two must not
 * disagree: printing a requested account number in full next to a master one that is masked would defeat
 * the masking entirely, on the same line.
 */
export function maskAccountNumber(no?: string | null): string | null {
  return no ? `•••• ${String(no).slice(-4)}` : null;
}

/**
 * The i18n namespace that resolves an option's `labelKey` and the "cleared" wording below.
 *
 * The option labels are `me.*` keys because the request FORM is on My Profile and picks from exactly
 * these words. Every other screen that prints a proposed value — the two approval queues — must resolve
 * them from the SAME namespace, or an approver reads a different sentence from the employee who chose
 * it. Named here once so no caller has to remember which namespace that was.
 */
export const PROFILE_REQUEST_OPTION_NAMESPACE = 'me' as const;

/**
 * ONE PROPOSED VALUE, RENDERED. THE ONLY RENDERER — EVERY SCREEN THAT SHOWS A PROPOSED VALUE CALLS THIS.
 *
 * ── WHY IT LIVES HERE AND NOT ON A SCREEN ───────────────────────────────────────────────────────────
 * It did live on a screen for one round, and the two screens immediately disagreed: My Profile resolved
 * a select to its label ("PCB → Married · spouse working") while /admin/personnel resolved it to
 * `.value` — a no-op returning the string it had just matched on — and printed "Tax Category → 2" and
 * "Gender → male" to the person deciding a pay-affecting change. An approver signing off a PCB category
 * must not be reading an LHDN code. Both screens now call this function, so they cannot drift again;
 * test/profile-requestable-fields.test.ts fails the build if a surface hand-rolls its own version.
 *
 * `t` resolves PROFILE_REQUEST_OPTION_NAMESPACE (`me`).
 *
 * ── `mask` IS REQUIRED, ON PURPOSE ──────────────────────────────────────────────────────────────────
 * The one thing the two audiences legitimately differ on is the bank account number: the EMPLOYEE reads
 * their own record masked to the last four digits, so a pending value printed in full beside it would
 * defeat the masking on the same line; the APPROVER is being asked to check that very number against a
 * bank letter and has always been shown it in full (they can read it unmasked on the Personnel card
 * anyway). That is a decision each caller must make out loud, so there is no default to inherit by
 * forgetting.
 */
export function formatProposedValue(
  field: RequestableField,
  value: unknown,
  t: (key: string) => string,
  opts: { mask: boolean },
): string {
  if (value == null || String(value) === '') return t('proposedCleared');
  if (field.masked && opts.mask) return maskAccountNumber(String(value)) ?? t('proposedCleared');
  if (field.input === 'select') {
    const opt = field.options?.find((o) => o.value === String(value));
    return opt ? t(opt.labelKey) : String(value);
  }
  return String(value);
}
