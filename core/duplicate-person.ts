/**
 * 05d2709a — SUSPECTED DUPLICATE PERSON RECORDS, and the evidence to judge each one.
 *
 * ═══ WHAT THIS IS ABOUT, AND WHAT IT IS NOT ═══
 *
 * CLAUDE.md §1: USER ≠ PERSON ≠ EMPLOYEE ≠ EMPLOYMENT. One PERSON holding several EMPLOYMENTS is the
 * SUPPORTED shape — somebody with two jobs, or employed by two companies in the group. That is normal and
 * this file must never accuse it of anything.
 *
 * What was found on production on 2026-09-22 is the OTHER shape: ten `full_name`s held by MORE THAN ONE
 * `person_id`, accounting for 22 extra person records, verified per name rather than inferred from a
 * count (LEE CHOO HONG: 3 employments / 3 person_ids / 1 company. DIN BIN AHMAD: 4 / 4 / 2. NIZAM BIN
 * ABU: 4 / 4 / 2. TAN WEI HUN: 3 / 3 / 1). Each of those person records carries its own leave ledger, its
 * own statutory profile and its own place in a payroll run.
 *
 * ═══ ⚠️ WHAT PRODUCTION ACTUALLY SHOWS, MEASURED 2026-09-22 ═══
 *
 * An EARLIER VERSION OF THIS FILE GUESSED WRONG AND THE GUESS IS RECORDED HERE ON PURPOSE. It reasoned
 * that because a non-null IC is unique per tenant, a second record for the same human would have been
 * created with the IC left BLANK — and it therefore treated a difference in IC numbers as meaningless and
 * hid it from the evidence. Production says otherwise: among the duplicated names 29 records HAVE an IC
 * and 3 are blank, against 67 / 8 across all active employments. Duplicates are no likelier to have a
 * blank IC than anybody else. The mechanism was invented, not observed.
 *
 * WHAT WAS OBSERVED IS WORSE, AND IT MAKES THE IC THE STRONGEST EVIDENCE ON THE SCREEN. Per group, the
 * IC numbers are identical except for their LAST TWO DIGITS, and a MyKad opens with the holder's birth
 * date (`localization/my/ic-dob.ts` is this repo's own definition of that) — which agrees exactly with
 * the separately recorded `person.date_of_birth` in every group:
 *
 *   ADLI BIN DAUD    8505****49 / 8505****41 / 8505****43   DOB all 1985-05-15   hired all 2025-05-02
 *   CHONG SOOK FUN   8010****72 / 8010****78 / 8010****70   DOB all 1980-10-26   hired all 2026-01-02
 *   CHUN AH FOO      7108****08 / 7108****00 / 7108****02   DOB all 1971-08-03
 *   DIN BIN AHMAD    9109****49 / 9109****47 / 9109****41   DOB all 1991-09-05
 *   LEE CHOO HONG    8207****61 / 8207****63 / 8207****69   DOB all 1982-07-06   hired all 2023-07-26
 *   NIZAM BIN ABU    8705****41 / 8705****45 / 8705****43   DOB all 1987-05-28
 *   TAN CHOO FIEW    8909****05 / 8909****03 / 8909****09   DOB all 1989-09-16
 *
 * Somebody hit `employee_statutory_my_ic_uq` and nudged the trailing digits until the insert went
 * through. So the unique index is not a reason to DISCOUNT the IC — it is the explanation for what the
 * ICs look like, and the near-identity is evidence these records are ONE PERSON.
 *
 * ═══ ⚠️ A WRONG IC IS NOT A TIDINESS PROBLEM — READ THIS BEFORE PLANNING THE MERGE ROUND ═══
 *
 * EPF, SOCSO and LHDN all key on the IC number. A record carrying a digit-tweaked IC therefore FILES
 * STATUTORY RETURNS UNDER A NUMBER THAT IS NOT THAT PERSON'S: contributions and tax land against an
 * identity that either belongs to somebody else or belongs to nobody. That is money and a statutory
 * filing, not a duplicate row in a list — and it is the reason the merge round has to decide what the
 * surviving IC is, not merely which record survives.
 *
 * NOTHING IN THIS ROUND TOUCHES IT. This module does not repair, flag-for-repair or propose a value for
 * any IC. It reads, it shows what is there, and it says what that means. The correction is the merge
 * round's, after the reporter has said which records are the same person.
 *
 * ═══ ⚠️ THE DETECTION IS A SUGGESTION, NOT A VERDICT ═══
 *
 * "Same name and same joining date" is a HEURISTIC. It will MISS a duplicate entered with a typo in the
 * name, and it will FLAG two genuinely different people who share a common name and started on the same
 * day — which, with Malaysian naming conventions and a January intake, is not a remote possibility.
 *
 * So this module returns EVIDENCE and NEVER A CONFIDENCE SCORE. There is deliberately no percentage, no
 * "likely / possible" band and no ranking of any kind — a number would assert a precision this data does
 * not have, and the reporter would act on it. What it returns instead is, per field, whether the person
 * records AGREE, DISAGREE, or the fact is simply NOT RECORDED — three honest states, one of which is
 * "we do not know", which a score can never express.
 *
 * ⚠️ THE IC COMPARISON IS NAMED, NOT SCORED, AND THE DISTINCTION IS THE WHOLE POINT. It does not measure
 * how CLOSE two numbers are. It asks ONE question a human can check on the screen in two seconds: do
 * these IC numbers encode the SAME DATE OF BIRTH, and does that date agree with the date of birth
 * recorded on the records? Same date, corroborated ⇒ strong evidence of one person. Different dates ⇒
 * evidence of two people, and it is reported as a contradiction. "Identical except the last N digits" is
 * reported alongside as a COUNT OF DIGITS THE READER CAN SEE, never as a measure of closeness — see
 * `compareIcNumbers`.
 *
 * `contradictions` is the failure mode that matters most, and it is surfaced first: two records whose
 * ICs encode different birth dates, or whose recorded dates of birth differ, are evidence they are
 * different PEOPLE. A screen that only ever argued "these look the same" would have no way to say so.
 *
 * ═══ ⚠️ IT READS. IT NEVER WRITES, AND IT NEVER PROPOSES A MERGE ═══
 *
 * There is no insert, update or delete in this file and there is no merge anywhere in this round. Merging
 * two person records means deciding what happens to two leave ledgers, two statutory profiles, two
 * employment histories and any payslip already issued — and `person_id` is referenced widely
 * (`employee_statutory_my` is keyed on it, `tp1_relief` is keyed on it, leave and attendance hang off
 * employment). That is its own item with its own plan, AFTER the reporter has said which pairs are
 * actually the same person. ORDERING: identify, show, confirm, then act.
 *
 * ═══ SCOPE AND ACCESS ═══
 *
 * TWO fences, and they are not the same fence:
 *   · `assertMayReadDuplicates` — THIS module's own guard. Only an admin may ask the question at all,
 *     because the answer is a cross-company list of personal data assembled for comparison. It is checked
 *     here, at the service boundary, not only on the page: a page guard is a UX gate.
 *   · RLS — the DATA fence. Every read goes through `withTenant`, so `employment_rls` / `person_rls` /
 *     `employee_statutory_my_rls` decide which rows exist at all. A company-scoped hr_admin sees only the
 *     companies they administer, which means HALF of a cross-company pair may be invisible to them. That
 *     is correct, and it is why a group needs TWO VISIBLE person records to be reported: showing "a
 *     duplicate" while only one of its records is readable would be an accusation the reader cannot check.
 *
 * ACTIVE EMPLOYMENTS ONLY (`terminated_on IS NULL`) — the same population the production measurement was
 * taken over, and the same reason `core/record-readiness.ts` gives: a leaver's duplicate record is not the
 * thing that would land in the next payroll run.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { isAdmin } from '../lib/authz';
// ADR-0080 D7 — through the REGISTRY, never a `localization/my` import. `core/` is scanned by
// test/country-pack-drift.test.ts and its allowlist only ever shrinks; the MyKad birth-date rule is the
// pack's (`dobFromIC`), not this module's to restate.
import { packFor } from '../localization/registry';
import { todayInKualaLumpur } from '../lib/hr-date';
import { company, employeeStatutoryMy, employment, leaveLedger, payslip, person } from '../db/schema';

/** Raised when a caller who is not an administrator asks for the duplicate list. */
export class DuplicatePersonAccessError extends Error {
  constructor(message = 'Only an HR administrator may review suspected duplicate person records.') {
    super(message);
    this.name = 'DuplicatePersonAccessError';
  }
}

/**
 * THE MODULE'S OWN GUARD, exported so a test can pin IT rather than pinning RLS by accident.
 *
 * A refusal test that only proves "another tenant's admin sees nothing" is pinning `employment_rls`, and
 * it would stay green if this check were deleted. This one goes red the moment it is.
 */
export function assertMayReadDuplicates(ctx: SessionContext): void {
  if (!isAdmin(ctx)) throw new DuplicatePersonAccessError();
}

/**
 * The PERSON-level facts compared between candidate records. Employment-level facts (company, employee
 * code, joining date) are shown per record but are NOT compared: two companies is the ordinary shape of a
 * group, not a disagreement about who somebody is.
 *
 * ORDERED, and the order is a DISPLAY order, not a ranking of strength. It puts the legal identity
 * documents first because that is where a reader looks first, and every group uses the same order — so it
 * carries no per-pair judgement.
 */
export const DUPLICATE_EVIDENCE_FIELDS = [
  'icNumber',
  'passportNumber',
  'dateOfBirth',
  'fullNameExact',
  'primaryEmail',
  'personalEmail',
  'gender',
  'maritalStatus',
  'bankAccountNo',
] as const;
export type DuplicateEvidenceField = (typeof DUPLICATE_EVIDENCE_FIELDS)[number];

/**
 * ⚠️ TWO FIELDS WHOSE DIFFERENCE MEANS NOTHING, FOR TWO COMPLETELY DIFFERENT REASONS.
 *
 * Both are still SHOWN — their values are exactly what a human compares — but neither counts towards
 * `contradictions`, the list that raises "these may be different people". A warning that fires on almost
 * every pair is a warning nobody reads, and both of these would.
 *
 * `primaryEmail` → **assigned_by_employer**. The work email is a fact about the EMPLOYMENT, not about the
 * human: the same person employed by two companies in one group has two work addresses, and that is
 * normal rather than evidence of two humans. It is also `NOT NULL`, so it is always recorded and would
 * therefore resolve on every single pair. `personalEmail` is deliberately NOT in this set — that one IS a
 * fact about the person, and a disagreement there is a real disagreement.
 *
 * `fullNameExact` → **cosmetic_only**, AND THIS ONE WAS A LIVE DEFECT CAUGHT BY RENDERING THE SCREEN.
 * The group key IS the normalised name, so within a group two spellings can differ ONLY in capitalisation
 * and spacing — by construction, never substantively. The first build counted that as a disagreement, and
 * the rendered page duly told a reader that "LEE CHOO HONG" and "Lee  Choo Hong" MAY BE DIFFERENT PEOPLE.
 * That is the exact opposite of what a cosmetic difference suggests: it points at two data-entry events
 * for one human. The spelling is still shown, because which record was typed how is useful; it simply
 * carries no verdict.
 *
 * ⚠️ `icNumber` IS NOT IN THIS SET, AND USED TO BE. It has its own richer comparison
 * (`compareIcNumbers`) which can argue BOTH ways, so a flat "never counts" would throw away the single
 * strongest piece of evidence on the screen. See the header for the production measurement that
 * overturned the earlier exclusion.
 *
 * Nothing else is excluded: passport number, personal email, date of birth, gender, marital status and
 * the bank account carry no constraint and belong to the human, so a difference there is a difference.
 */
export type DuplicateNonContradictionReason = 'assigned_by_employer' | 'cosmetic_only';

/**
 * THE ONE SOURCE. The screen explains each exclusion INLINE, beside the field it is about, by looking the
 * reason up here — so a note can never name a different set than the rule, and a field added to this map
 * without a matching explanation is a missing i18n key the tests catch rather than a silent omission.
 */
export const DUPLICATE_FIELD_NOT_A_CONTRADICTION: Readonly<
  Partial<Record<DuplicateEvidenceField, DuplicateNonContradictionReason>>
> = {
  primaryEmail: 'assigned_by_employer',
  fullNameExact: 'cosmetic_only',
};

/**
 * Three states, and the third one is the point.
 *  · `same`      — every person record in the group records this fact, and they all record the SAME value.
 *  · `differs`   — at least two person records record it and they DISAGREE. Evidence of different people.
 *  · `unknown`   — fewer than two person records have it filled in. Not evidence either way, and saying so
 *                  is the whole reason this is not a boolean.
 */
export type DuplicateAgreementState = 'same' | 'differs' | 'unknown';

export type DuplicateFieldAgreement = {
  field: DuplicateEvidenceField;
  state: DuplicateAgreementState;
  /** The DISTINCT recorded values, sorted — so the reader sees what actually differs, not just that it does. */
  values: string[];
  /** How many of the group's person records have this fact recorded at all. */
  recordedBy: number;
};

/** One ACTIVE employment inside a candidate group, with everything a human needs to judge it. */
export type DuplicateEmploymentRecord = {
  employmentId: string;
  personId: string;
  /**
   * A stable letter (A, B, C…) for the PERSON record this employment belongs to, assigned from the
   * group's own ordering. Two rows sharing a letter are ONE person record with two employments — the
   * supported shape — and the screen has to be able to show that, or it would read as more duplicates
   * than there are.
   */
  personLabel: string;
  employeeCode: string | null;
  companyId: string;
  company: string;
  /** `company.country` — resolves WHICH jurisdiction's rule reads this record's IC (ADR-0080 D3). */
  companyCountry: string | null;
  /** As stored. NOT normalised: a difference in spelling or case is itself evidence. */
  fullName: string;
  hiredOn: string;
  joinDate: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  maritalStatus: string | null;
  primaryEmail: string;
  personalEmail: string | null;
  icNumber: string | null;
  passportNumber: string | null;
  bankAccountNo: string | null;
  /** Payslip rows issued against THIS employment. A paid record is the one nobody may quietly remove. */
  payslipCount: number;
  /** Leave ledger entries against THIS employment. Entries, not a balance — see `leaveLedgerEntries`. */
  leaveLedgerEntries: number;
};

export type DuplicateCandidateGroup = {
  /** Grouping key: normalised name + joining date. Stable, and what the React key is built from. */
  key: string;
  /** The name as most of the records spell it — the first in record order. Never a synthesised spelling. */
  displayName: string;
  hiredOn: string;
  /** Every ACTIVE employment in the group, ordered (employee code, then person id, then employment id). */
  records: DuplicateEmploymentRecord[];
  /** Distinct person records, in the same order the letters were assigned. Length ≥ 2 by construction. */
  personIds: string[];
  /** Distinct company names, sorted. More than one is NOT suspicious on its own — see the header. */
  companies: string[];
  agreement: DuplicateFieldAgreement[];
  /**
   * The IC comparison — its own structure rather than a row of `agreement`, because it answers a richer
   * question than same/differs and is the strongest evidence on the screen. See `compareIcNumbers`.
   */
  icEvidence: IcEvidence;
  /**
   * The fields whose state is `differs`, in `DUPLICATE_EVIDENCE_FIELDS` order, MINUS the ones whose
   * difference means nothing (`DUPLICATE_FIELD_NOT_A_CONTRADICTION`). Empty is the common case;
   * non-empty is the finding that matters most, because it is evidence these are two different people
   * rather than one person entered twice.
   */
  contradictions: DuplicateEvidenceField[];
  /** Any employment in the group carries at least one payslip. */
  anyPayslip: boolean;
  /** Any employment in the group carries at least one leave ledger entry. */
  anyLeaveLedger: boolean;
};

export type DuplicatePersonView = {
  /** Active employments the query could see. The denominator for everything below. */
  activeEmployments: number;
  /** Distinct person records behind those employments. */
  activePersons: number;
  /** The candidate groups: same normalised name AND same joining date, held by ≥2 person records. */
  groups: DuplicateCandidateGroup[];
  /** Person records beyond the first in each group — "how many extra records exist". */
  extraPersonRecords: number;
  /**
   * Names shared by more than one person record whose joining dates DIFFER, and which are therefore NOT
   * listed above. A COUNT, never a list: sharing a name is ordinary, and printing every such name would
   * bury the candidates under people who merely have a common name. It is reported so the reader knows
   * the edge of the heuristic instead of assuming the list above is everything.
   */
  sharedNamesWithDifferentHireDates: number;
};

/**
 * The grouping key. Case and whitespace ONLY — deliberately the least aggressive normalisation there is.
 *
 * Folding case and collapsing runs of whitespace catches "LEE CHOO  HONG" vs "Lee Choo Hong", which are
 * the SAME STRING keyed twice, not a judgement about names. Anything beyond that (stripping BIN / BINTI,
 * dropping punctuation, phonetic matching) starts deciding that two different names are one name, which is
 * exactly the precision this feature refuses to claim.
 */
export function normalizeFullName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toUpperCase();
}

const blank = (v: string | null | undefined): boolean => v == null || String(v).trim() === '';

/**
 * Compare ONE person-level fact across the group's person records.
 *
 * Reads ONE representative row per person record (`byPerson`): two employments of the same person share a
 * `person` row and an `employee_statutory_my` row, so counting them twice would report "recorded by 3"
 * for a group of 2 people.
 */
function agreementFor(
  field: DuplicateEvidenceField,
  byPerson: Map<string, DuplicateEmploymentRecord>,
  personIds: string[],
): DuplicateFieldAgreement {
  const raw = personIds.map((id) => valueOf(field, byPerson.get(id)!));
  const recorded = raw.filter((v) => !blank(v)).map((v) => String(v).trim());
  const values = [...new Set(recorded)].sort();
  // Fewer than two records carry it → nothing to compare. "Unknown" is a real answer here, and collapsing
  // it into "same" would let a group with one IC number and three blanks read as corroborated.
  if (recorded.length < 2) return { field, state: 'unknown', values, recordedBy: recorded.length };
  if (values.length > 1) return { field, state: 'differs', values, recordedBy: recorded.length };
  // All the recorded values agree — but if some records do not carry it at all, the group is not fully
  // corroborated on this field, and saying "same" would overstate it.
  if (recorded.length < personIds.length) return { field, state: 'unknown', values, recordedBy: recorded.length };
  return { field, state: 'same', values, recordedBy: recorded.length };
}

function valueOf(field: DuplicateEvidenceField, r: DuplicateEmploymentRecord): string | null {
  switch (field) {
    case 'icNumber':
      return r.icNumber;
    case 'passportNumber':
      return r.passportNumber;
    case 'dateOfBirth':
      return r.dateOfBirth;
    case 'fullNameExact':
      return r.fullName;
    case 'primaryEmail':
      return r.primaryEmail;
    case 'personalEmail':
      return r.personalEmail;
    case 'gender':
      return r.gender;
    case 'maritalStatus':
      return r.maritalStatus;
    case 'bankAccountNo':
      return r.bankAccountNo;
  }
}

/** Letter for the n-th distinct person record in a group: A..Z, then AA, AB… (never runs out). */
function personLabelAt(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * ⚠️ THE IC COMPARISON. NAMED, EXPLAINABLE, AND DELIBERATELY NOT A SCORE.
 *
 * WHAT IT ASKS, AND IT IS ONE QUESTION: do these IC numbers encode the SAME DATE OF BIRTH, and does that
 * date agree with the date of birth recorded on the person records? Both halves are facts a reader can
 * check on the screen against the two columns already in front of them. Nothing here measures how CLOSE
 * two numbers are, and nothing here produces a band, a percentage or a ranking — see the header on why a
 * number would assert a precision this data does not have.
 *
 * WHY THE BIRTH DATE AND NOT THE DIGITS. A MyKad opens with YYMMDD. That is not a fact this module
 * invents: `dobFromIC` in the MY country pack is this repository's own definition of it (with the
 * century rule and a real-calendar-date check), and it is reached through `packFor` rather than by
 * importing `localization/my` — the ADR-0080 D7 seam, whose ratchet only ever shrinks. So the comparison
 * is jurisdiction-resolved: a company whose country has no pack, or an IC that pack cannot read, is
 * `not_comparable` rather than silently assumed Malaysian (ADR-0080 D3, fail closed).
 *
 * WHY IT MUST BE ABLE TO ARGUE BOTH WAYS. Same birth date, corroborated by the profile ⇒ strong evidence
 * of ONE person. DIFFERENT birth dates ⇒ evidence of TWO people, and it is reported as a contradiction.
 * A comparison that could only ever say "these look the same" would not be evidence at all.
 *
 * ⚠️ AND IT CAN FIRE ON GENUINELY DIFFERENT PEOPLE. Two people born on the same day, with a shared
 * common name, hired on the same day, carry ICs that agree on the birth date and differ in the serial —
 * exactly the shape a nudged duplicate has. TWINS are the clean example, and twins with similar names
 * hired together are not a hypothetical in a family firm. `same_birth_date` is therefore reported as
 * EVIDENCE the reporter weighs, never as proof, and the screen states the fact rather than a conclusion.
 */
export type IcVerdict =
  /** Every readable IC encodes the same date of birth, and it agrees with every recorded date of birth. */
  | 'same_birth_date'
  /** Every readable IC encodes the same date of birth, but no profile date of birth exists to check it. */
  | 'same_birth_date_unverified'
  /** The ICs agree with each other and DISAGREE with the date of birth recorded on the records. */
  | 'birth_date_contradicts_profile'
  /** The ICs encode DIFFERENT dates of birth — evidence these are different people. */
  | 'different_birth_dates'
  /** Fewer than two readable ICs, unreadable values, or companies in different jurisdictions. */
  | 'not_comparable';

export type IcEvidence = {
  verdict: IcVerdict;
  /** The ICs as recorded, distinct and sorted — what the reader compares by eye. */
  values: string[];
  /** How many person records carry an IC the jurisdiction's pack can read. */
  readableCount: number;
  /** The date(s) of birth the IC NUMBERS THEMSELVES encode, distinct and sorted. */
  birthDatesInIc: string[];
  /** The date(s) of birth recorded on those same person records, distinct and sorted. */
  birthDatesOnProfile: string[];
  /**
   * When the readable ICs agree on the birth date, how many TRAILING digits they differ in — the literal
   * "identical except the last two digits" a reader can verify by looking. Null whenever the ICs do not
   * agree on the birth date, so it can never be read as a general measure of closeness.
   */
  differingTrailingDigits: number | null;
};

/** One person record's inputs to the IC comparison. */
export type IcComparisonInput = {
  icNumber: string | null;
  dateOfBirth: string | null;
  /** `company.country` of the employment this person record was read through — resolves the pack. */
  companyCountry: string | null;
};

const blankIc = (v: string | null | undefined): boolean => v == null || v.trim() === '';

/** Longest common leading run of two strings, in characters. */
function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

export function compareIcNumbers(records: readonly IcComparisonInput[], now: Date): IcEvidence {
  // Resolve each record's jurisdiction on its OWN company, never on the group's first one: a group can
  // span two companies, and reading one country's identity document under another country's rule is the
  // kind of silent wrong answer ADR-0080 D3 exists to prevent.
  const readable: { raw: string; normalized: string; dob: string; country: string; profileDob: string | null }[] = [];
  const allValues: string[] = [];
  for (const r of records) {
    if (blankIc(r.icNumber)) continue;
    allValues.push(r.icNumber!.trim());
    const pack = packFor(r.companyCountry);
    if (!pack) continue;
    const dob = pack.statutory.dobFromIC(r.icNumber!, now);
    if (dob == null) continue; // not a readable national ID for this jurisdiction
    readable.push({
      raw: r.icNumber!.trim(),
      normalized: pack.statutory.normalizeIC(r.icNumber!),
      dob,
      country: (r.companyCountry ?? '').toUpperCase(),
      profileDob: blankIc(r.dateOfBirth) ? null : r.dateOfBirth!.trim(),
    });
  }

  const base = {
    values: [...new Set(allValues)].sort(),
    readableCount: readable.length,
  };

  const jurisdictions = new Set(readable.map((r) => r.country));
  if (readable.length < 2 || jurisdictions.size > 1) {
    return { ...base, verdict: 'not_comparable', birthDatesInIc: [], birthDatesOnProfile: [], differingTrailingDigits: null };
  }

  const birthDatesInIc = [...new Set(readable.map((r) => r.dob))].sort();
  const birthDatesOnProfile = [...new Set(readable.map((r) => r.profileDob).filter((d): d is string => d != null))].sort();

  if (birthDatesInIc.length > 1) {
    // Evidence of two different people, and it is the one IC outcome that becomes a contradiction.
    return { ...base, verdict: 'different_birth_dates', birthDatesInIc, birthDatesOnProfile, differingTrailingDigits: null };
  }

  // The ICs agree on the birth date. How many trailing digits do they differ in? A COUNT OF DIGITS, and
  // only ever reported in this branch, so it cannot be mistaken for a general closeness measure.
  const lengths = new Set(readable.map((r) => r.normalized.length));
  let differingTrailingDigits: number | null = null;
  if (lengths.size === 1) {
    const len = readable[0].normalized.length;
    let shortest = len;
    for (const a of readable) for (const b of readable) shortest = Math.min(shortest, commonPrefixLength(a.normalized, b.normalized));
    differingTrailingDigits = len - shortest;
  }

  const verdict: IcVerdict =
    birthDatesOnProfile.length === 0
      ? 'same_birth_date_unverified'
      : birthDatesOnProfile.length === 1 && birthDatesOnProfile[0] === birthDatesInIc[0]
        ? 'same_birth_date'
        : 'birth_date_contradicts_profile';

  return { ...base, verdict, birthDatesInIc, birthDatesOnProfile, differingTrailingDigits };
}

/**
 * The IC outcomes that indicate the records describe ONE person whose IC was edited to get past
 * `employee_statutory_my_ic_uq`. Exported because the SCREEN and the SCRIPT both have to say the
 * statutory consequence in exactly the same cases — see the header: EPF, SOCSO and LHDN key on this
 * number, so one of these records is filing under an identity that is not the holder's.
 */
export const IC_VERDICTS_INDICATING_ONE_PERSON: readonly IcVerdict[] = [
  'same_birth_date',
  'same_birth_date_unverified',
  'birth_date_contradicts_profile',
];

/**
 * The normalised names held by MORE THAN ONE person record — the shortlist rule, stated ONCE.
 *
 * ⚠️ IT IS DELIBERATELY EXPORTED AND SHARED, and the reason is a defect this round nearly shipped. The
 * reader narrows query 2 to these names (so the heavy evidence joins run over twenty employments rather
 * than every active one) and `groupDuplicateCandidates` skips the same names (a name held by one person
 * record is the supported shape and is not a candidate). Written out twice, the narrowing and the rule
 * were free to drift: a mutation that broke the rule in one of them left every test green, because the
 * other one was still quietly enforcing it. One function, both callers, no drift possible — and a test
 * that breaks this breaks BOTH sides at once, which is what makes it testable at all.
 *
 * `rows` only has to carry the two fields the rule reads, so the script (which holds a tenant column the
 * screen does not) can call it with its own row shape.
 */
export function namesHeldByMultiplePersons(
  rows: readonly { fullName: string; personId: string }[],
): ReadonlySet<string> {
  const byName = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = normalizeFullName(r.fullName);
    const s = byName.get(key) ?? new Set<string>();
    s.add(r.personId);
    byName.set(key, s);
  }
  return new Set([...byName.entries()].filter(([, persons]) => persons.size >= 2).map(([name]) => name));
}

/**
 * Turn raw candidate rows into ordered, evidenced groups.
 *
 * EXPORTED, and rendered pure, so the SCRIPT and the SCREEN share one definition of what a candidate is
 * and what counts as a contradiction. The script runs as the migration role across every tenant and the
 * screen runs under RLS for one; if they each grouped rows their own way, the list the reporter is handed
 * and the list the reporter opens could disagree about the same people — which is the single thing this
 * item cannot afford.
 */
export function groupDuplicateCandidates(
  rows: readonly Omit<DuplicateEmploymentRecord, 'personLabel'>[],
  /**
   * The instant the MyKad century rule is resolved against, passed in rather than defaulted so every IC
   * in one view resolves under the SAME reading and a fixture can pin it (CLAUDE.md §8 — a date from an
   * instant goes through `todayInKualaLumpur()`; `duplicatePersonCandidates` derives this from it).
   */
  now: Date,
): { groups: DuplicateCandidateGroup[]; sharedNamesWithDifferentHireDates: number } {
  // ── Pass 1: bucket by normalised NAME alone, to answer both questions from one walk. ──
  const byName = new Map<string, Omit<DuplicateEmploymentRecord, 'personLabel'>[]>();
  for (const r of rows) {
    const key = normalizeFullName(r.fullName);
    const list = byName.get(key) ?? [];
    list.push(r);
    byName.set(key, list);
  }

  const groups: DuplicateCandidateGroup[] = [];
  let sharedNamesWithDifferentHireDates = 0;
  // One person record holding several employments under one name is the SUPPORTED shape and is not a
  // candidate — decided by the SHARED rule above, which is also what the reader narrows its second query
  // by, so the two can never come to disagree about who is even in scope.
  const shared = namesHeldByMultiplePersons(rows);

  for (const [nameKey, nameRows] of byName) {
    if (!shared.has(nameKey)) continue;

    // ── Pass 2: within the name, split by joining date. Same name AND same date is the candidate. ──
    const byDate = new Map<string, Omit<DuplicateEmploymentRecord, 'personLabel'>[]>();
    for (const r of nameRows) {
      const list = byDate.get(r.hiredOn) ?? [];
      list.push(r);
      byDate.set(r.hiredOn, list);
    }

    let matchedOnDate = false;
    for (const [hiredOn, dateRows] of byDate) {
      const persons = new Set(dateRows.map((r) => r.personId));
      if (persons.size < 2) continue;
      matchedOnDate = true;

      // ORDERED BEFORE ANYTHING IS DERIVED FROM POSITION. The letters, the display name and the React key
      // are all read off this order, so it has to be total and it has to be a property of the data — never
      // "whatever the query returned". Employee code is what HR calls these records; nulls sort last so a
      // record with no code cannot claim letter A.
      const ordered = [...dateRows].sort(
        (a, b) =>
          (a.employeeCode == null ? 1 : 0) - (b.employeeCode == null ? 1 : 0) ||
          (a.employeeCode ?? '').localeCompare(b.employeeCode ?? '') ||
          a.personId.localeCompare(b.personId) ||
          a.employmentId.localeCompare(b.employmentId),
      );

      const personIds: string[] = [];
      const labels = new Map<string, string>();
      for (const r of ordered) {
        if (labels.has(r.personId)) continue;
        labels.set(r.personId, personLabelAt(personIds.length));
        personIds.push(r.personId);
      }
      const records: DuplicateEmploymentRecord[] = ordered.map((r) => ({
        ...r,
        personLabel: labels.get(r.personId)!,
      }));

      const byPerson = new Map<string, DuplicateEmploymentRecord>();
      for (const r of records) if (!byPerson.has(r.personId)) byPerson.set(r.personId, r);

      const agreement = DUPLICATE_EVIDENCE_FIELDS.map((f) => agreementFor(f, byPerson, personIds));
      // ONE representative per PERSON record: two employments of one person share the person row, and
      // counting the IC twice would make a pair look like a trio.
      const icEvidence = compareIcNumbers(
        personIds.map((id) => {
          const r = byPerson.get(id)!;
          return { icNumber: r.icNumber, dateOfBirth: r.dateOfBirth, companyCountry: r.companyCountry };
        }),
        now,
      );

      groups.push({
        key: `${nameKey}|${hiredOn}`,
        displayName: records[0].fullName,
        hiredOn,
        records,
        personIds,
        companies: [...new Set(records.map((r) => r.company))].sort(),
        agreement,
        icEvidence,
        // ⚠️ THE IC IS DECIDED BY ITS OWN COMPARISON, NOT BY `differs`. Its generic state is `differs`
        // whenever two records carry one — `employee_statutory_my_ic_uq` guarantees it — so the generic
        // rule would flag every fully-recorded pair. What actually counts is whether the two numbers
        // encode DIFFERENT BIRTH DATES; near-identity with the same birth date is evidence the other way.
        // Order stays `DUPLICATE_EVIDENCE_FIELDS` order, which is what the screen lists them in.
        contradictions: DUPLICATE_EVIDENCE_FIELDS.filter((f) => {
          if (f === 'icNumber') return icEvidence.verdict === 'different_birth_dates';
          if (DUPLICATE_FIELD_NOT_A_CONTRADICTION[f] != null) return false;
          return agreement.find((a) => a.field === f)!.state === 'differs';
        }),
        anyPayslip: records.some((r) => r.payslipCount > 0),
        anyLeaveLedger: records.some((r) => r.leaveLedgerEntries > 0),
      });
    }

    // The name is shared by several person records, but no single joining date is. Counted, not listed.
    if (!matchedOnDate) sharedNamesWithDifferentHireDates += 1;
  }

  groups.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.hiredOn.localeCompare(b.hiredOn) || a.key.localeCompare(b.key));
  return { groups, sharedNamesWithDifferentHireDates };
}

/**
 * The screen's read. Admin-only (this module's guard), tenant- and company-scoped by RLS.
 *
 * TWO QUERIES, ON PURPOSE. The first is a narrow walk of every active employment — four columns, one join
 * — which is what decides who is even a candidate. The second gathers the heavy evidence (statutory
 * profile, payslip and ledger counts) for the candidate employments ONLY. Doing it in one query would put
 * two correlated sub-selects on every active employment in the tenant to answer a question about twenty
 * of them.
 */
export async function duplicatePersonCandidates(ctx: SessionContext): Promise<DuplicatePersonView> {
  assertMayReadDuplicates(ctx);
  return withTenant(ctx, async (tx) => {
    // ── Query 1: the candidate walk. ORDER BY so the shortlist is reproducible between loads. ──
    const all = await tx
      .select({
        employmentId: employment.id,
        personId: employment.personId,
        fullName: person.fullName,
        hiredOn: employment.hiredOn,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(isNull(employment.terminatedOn))
      .orderBy(asc(person.fullName), asc(employment.hiredOn), asc(employment.id));

    const activePersons = new Set(all.map((r) => r.personId)).size;

    // The shortlist for query 2: every employment whose NAME is held by ≥2 person records — deliberately
    // the NAME rule, not the narrower name+date one the groups use. The view reports how many names are
    // shared with DIFFERENT joining dates, and that count is derived by the same grouping function from
    // the same rows; handing it only the date-matched rows would make it structurally zero.
    //
    // ⚠️ THE RULE IS NOT RESTATED HERE. `namesHeldByMultiplePersons` is the one definition, shared with
    // `groupDuplicateCandidates` — a second copy of it in this function is what let a broken rule pass a
    // green suite once already, because whichever copy still worked hid the other.
    const shared = namesHeldByMultiplePersons(all);
    const wanted = all.filter((r) => shared.has(normalizeFullName(r.fullName))).map((r) => r.employmentId);

    if (wanted.length === 0) {
      return {
        activeEmployments: all.length,
        activePersons,
        groups: [],
        extraPersonRecords: 0,
        sharedNamesWithDifferentHireDates: 0,
      };
    }

    // ── Query 2: the evidence, for the shortlist only. ──
    const rows = await tx
      .select({
        employmentId: employment.id,
        personId: employment.personId,
        employeeCode: employment.employeeCode,
        companyId: employment.companyId,
        company: company.legalName,
        companyCountry: company.country,
        fullName: person.fullName,
        hiredOn: employment.hiredOn,
        joinDate: employment.joinDate,
        dateOfBirth: person.dateOfBirth,
        gender: person.gender,
        maritalStatus: person.maritalStatus,
        primaryEmail: person.primaryEmail,
        personalEmail: person.personalEmail,
        icNumber: employeeStatutoryMy.icNumber,
        passportNumber: employeeStatutoryMy.passportNumber,
        bankAccountNo: employeeStatutoryMy.bankAccountNo,
        // Correlated counts rather than joins: an employment has many payslips and many ledger rows, and
        // joining either would multiply the record out before anything was compared.
        payslipCount: sql<number>`(select count(*)::int from ${payslip} p where p.employment_id = ${employment.id})`,
        leaveLedgerEntries: sql<number>`(select count(*)::int from ${leaveLedger} l where l.employment_id = ${employment.id})`,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      // LEFT join: a non-Malaysian or an unfinished profile has no statutory row, and an inner join would
      // silently drop exactly the incomplete records this list is most likely to be about.
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(and(isNull(employment.terminatedOn), inArray(employment.id, wanted)))
      .orderBy(asc(person.fullName), asc(employment.hiredOn), asc(employment.employeeCode), asc(employment.id));

    // ⚠️ ONE instant for the whole view, taken off the Kuala Lumpur calendar rather than the host clock
    // (CLAUDE.md §8). It is used ONLY for the MyKad century rule ("2000+YY unless that is in the future"),
    // so what matters is that every IC in one render resolves under the same reading — two ICs resolving
    // under different centuries mid-page would be a difference the data does not contain. End of the MYT
    // day, so "not in the future" means "not after today in KL".
    const now = new Date(`${todayInKualaLumpur()}T23:59:59+08:00`);
    const { groups, sharedNamesWithDifferentHireDates } = groupDuplicateCandidates(rows, now);

    return {
      activeEmployments: all.length,
      activePersons,
      groups,
      // "22 extra person records" in the reporter's words: everything beyond the first in each group.
      extraPersonRecords: groups.reduce((n, g) => n + g.personIds.length - 1, 0),
      sharedNamesWithDifferentHireDates,
    };
  });
}
