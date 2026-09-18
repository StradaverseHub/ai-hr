/**
 * Item 2983802f — THE TEMPLATE MUST STAY IN STEP WITH THE EMPLOYEE RECORD.
 *
 * The reporter's real ask was not "add these seven fields". It was: the import template keeps falling
 * behind Personnel, please stop it falling behind. Adding the seven columns answers the symptom for one
 * release; this file answers the disease, which is why the plan ordered it FIRST.
 *
 * THE REGISTRY IS THE SCHEMA. There is no hand-written list of "employee fields" in this repo, and
 * inventing one would just be a third list to drift (the template, the validator, and now a registry).
 * The durable registry is the set of COLUMNS on the tables that hold employee information — when
 * Personnel gains a field it gains a column, always, because a field with nowhere to store itself does
 * not exist. So this test enumerates those tables with drizzle's `getTableColumns` and demands that
 * EVERY column is one of two things:
 *
 *   COVERED  — carried by a named import column (employee sheet or family sheet), or
 *   EXCLUDED — deliberately out, with a REASON written down next to it.
 *
 * A field that is neither turns this test red. That is the whole mechanism: a future Personnel change
 * cannot silently widen the gap between the profile and the file, because the person adding the column
 * has to say, in one line, which import column carries it or why none does.
 *
 * IT FAILS IN BOTH DIRECTIONS, on purpose:
 *   · a NEW schema column with no entry            → "not covered and not excluded"
 *   · a COVERED entry naming a column the template no longer has → "names an import column that does not exist"
 *   · a stale entry for a column that was dropped/renamed        → "names a field that no longer exists"
 *   · an import column that carries no field at all              → "no field behind it"
 *
 * Pure and hermetic: drizzle table objects are plain JavaScript, so no DB, no harness, no seed.
 */
import { describe, expect, it } from 'vitest';
import { getTableColumns, type Table } from 'drizzle-orm';
import {
  assignment,
  compensation,
  employeeDependent,
  employment,
  employeeStatutoryMy,
  person,
  personEmergencyContact,
  reportingLine,
} from '../db/schema';
import { DEPENDENT_IMPORT_COLUMNS, IMPORT_COLUMNS } from '../lib/import-schema';

/** Every import column the EMPLOYEE sheet offers. */
const EMPLOYEE_SHEET = new Set<string>([...IMPORT_COLUMNS.required, ...IMPORT_COLUMNS.optional]);
/** Every import column the FAMILY sheet offers. */
const FAMILY_SHEET = new Set<string>([
  ...DEPENDENT_IMPORT_COLUMNS.required,
  ...DEPENDENT_IMPORT_COLUMNS.optional,
]);

/** `employee_code` on the family sheet is the LINK to the employee row, not a dependant field. */
const FAMILY_LINK_COLUMN = 'employee_code';

type Sheet = 'employee' | 'family';

/** A table in the registry: its columns, and which sheet's columns may claim them. */
type RegistryTable = {
  table: Table;
  sheet: Sheet;
  /** schema field → the import column that carries it. */
  covered: Record<string, string>;
  /** Fields deliberately absent from the template, each under a named reason. */
  excluded: { reason: string; fields: string[] }[];
};

/**
 * Plumbing every table carries: surrogate key, tenancy, FK parents, timestamps, soft-delete. None of it
 * is employee INFORMATION — it is how a row is stored, and an import file has no business carrying it.
 */
const PLUMBING = 'row plumbing (surrogate key / tenancy / parent FK / timestamps / soft-delete), not employee information';

const REGISTRY: Record<string, RegistryTable> = {
  // ───────────────────────────────── person — Profile tab ─────────────────────────────────
  person: {
    table: person,
    sheet: 'employee',
    covered: {
      fullName: 'full_name',
      primaryEmail: 'email',
      phone: 'phone',
      // r253 — the home address. The Contact & Address card writes the PERMANENT block (the legacy flat
      // block below is retained for rollback only), so that is where the imported address lands.
      permanentAddressLine1: 'address_line_1',
      permanentAddressLine2: 'address_line_2',
      permanentAddressLine3: 'address_line_3',
      permanentPostcode: 'postcode',
      permanentCity: 'city',
      permanentState: 'state',
      permanentCountry: 'country',
    },
    excluded: [
      { reason: PLUMBING, fields: ['id', 'tenantId', 'createdAt'] },
      {
        reason:
          'derived, never keyed: date of birth is autofilled from the IC by the importer itself (b9fd8fd5), so a column for it would let a file contradict the identity number beside it',
        fields: ['dateOfBirth'],
      },
      {
        reason:
          'legacy free-text address block, no longer rendered or written by any screen (b4682879 backfilled it into the permanent block) — importing into it would write somewhere nothing reads',
        fields: ['address', 'addressLine1', 'addressLine2', 'addressLine3', 'postcode', 'city', 'state', 'country'],
      },
      {
        reason:
          'second address block for post that goes somewhere other than home; the template carries ONE address because that is what the request asked for — add these columns when a customer actually maintains both',
        fields: [
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
      {
        reason:
          'personal-details fields the Profile tab maintains after hire; genuinely importable and the next columns to add, but out of the approved scope for this round (passport / address / emergency contact / probation / notice / superior / family)',
        fields: [
          'homePhone',
          'gender',
          'maritalStatus',
          'firstName',
          'lastName',
          'preferredName',
          'salutation',
          'religion',
          'race',
          'nationality',
          'personalEmail',
        ],
      },
      {
        reason:
          'ADR-0029 concurrent-employment setting chosen per person AFTER their employments exist — it names an employment id, which no row of a creation file can yet refer to',
        fields: ['designatedPaymasterEmploymentId'],
      },
    ],
  },

  // ─────────────────────────────── employment — Employment tab ───────────────────────────────
  employment: {
    table: employment,
    sheet: 'employee',
    covered: {
      companyId: 'company',
      employeeCode: 'employee_code',
      hiredOn: 'hired_on',
      // r253 — probation. `provisionalEndOn` IS the probation end date for a full-time hire (see the
      // column's own comment); it is the one hireEmployee accepts, so that is the one the file writes.
      provisionalEndOn: 'probation_end_date',
      probationMonths: 'probation_months',
      probationDays: 'probation_days',
      confirmationDate: 'confirmation_date',
      // r253 — notice period. The contractual policy pair the Employment tab maintains.
      resignationNoticeMonths: 'resignation_notice_months',
      resignationNoticeDays: 'resignation_notice_days',
    },
    excluded: [
      { reason: PLUMBING, fields: ['id', 'tenantId', 'personId', 'createdAt'] },
      {
        reason:
          'the employment-review workflow reads this column and nothing in the product writes it — an import must not be the only writer of a field HR cannot see or correct afterwards',
        fields: ['probationEndDate'],
      },
      {
        // 44bc1c33 (r306). The reporter DID ask for a bulk path ("bulk assignment/import where required"),
        // so this exclusion is a not-yet, not a never — and it is deliberately not this template.
        //
        // A card id is refused when it collides with another employee's card, employee_code OR ic
        // (core/attendance-card.ts `assertCardIdFree`), because `importAttendancePunches` builds all three
        // into one flat lookup and a collision posts one person's attendance onto another. That rule lives
        // in the service, not in a constraint, so a template column writing `card_id` straight into the row
        // would be a SECOND write path with the rule missing — silently mis-attributing attendance, which
        // feeds overtime, which is pay. A bulk path has to go through the same service and report its
        // clashes the way the punch import already reports unmatched refs; that is its own piece of work.
        reason:
          'assigned on Attendance › Card Assignment (or the employee’s Attendance tab), where the cross-column collision refusal lives — a template column would be a second write path without that rule, and a card colliding with another employee’s code or IC posts their attendance onto the wrong person',
        fields: ['cardId'],
      },
      {
        reason:
          'exit data. A day-one import creates ACTIVE employees; a file that could also terminate them would make one upload capable of ending a workforce',
        fields: [
          'terminatedOn',
          'terminationType',
          'terminationReason',
          'terminationReasonCode',
          'terminationNoticeDays',
          'resignationDate',
          'tenderResignationDate',
          'lastWorkingDate',
          'blacklistedAt',
          'blacklistReason',
        ],
      },
      {
        reason:
          'the redesigned value+unit period pair (955c7de4) alongside the month/day columns this file carries; importing BOTH shapes of the same period would let one file state two different probation lengths',
        fields: [
          'probationValue',
          'probationUnit',
          'extendedProbationValue',
          'extendedProbationUnit',
          'noticeBeforeConfirmationValue',
          'noticeBeforeConfirmationUnit',
          'noticeAfterConfirmationValue',
          'noticeAfterConfirmationUnit',
          'shortNoticeMonths',
          'shortNoticeDays',
        ],
      },
      {
        reason:
          'set by a movement, not by data entry: a probation extension and its recomputed confirmation date are produced by the Movement module and are derived from what it records',
        fields: ['extendedConfirmationDate', 'finalConfirmationDate'],
      },
      {
        reason:
          'contract-employment block, shown only while the current assignment is a contract; a fixed-term intake is a separate request from the day-one load this template serves',
        fields: ['contractStartDate', 'contractEndDate', 'contractRemark', 'internshipEndDate'],
      },
      {
        reason:
          'company transfer / rehire date maintained by a movement, never at creation (it is seeded equal to the group join date this file already carries)',
        fields: ['joinDate'],
      },
      {
        reason:
          'operational configuration chosen per employee after hire (calendar, shift, payroll policy, geofencing, cost split, payment method, grade) — configuration, not employee information, and each has its own screen',
        fields: [
          'gradeId',
          'workState',
          'holidayGroupId',
          'payrollPolicyId',
          'defaultShiftId',
          'shiftType',
          'costAllocation',
          'geofencingEnabled',
          'geofenceRadiusM',
          'paymentMethod',
        ],
      },
      {
        // 870b79e2 (r277, migration 0464) — the Schedule Group. Reason UPDATED by f513ec02 (r281), which
        // built the assignment screen and the reverse check the old wording said were missing; the
        // EXCLUSION is unchanged and was not revisited in that item.
        reason:
          'Schedule Group: the direct sibling of holidayGroupId and payrollPolicyId above and excluded for the same reason — operational configuration chosen per employee after hire, with its own screen (Personnel → Attendance → Schedule Group, f513ec02) rather than a column on the day-one load. r277\'s second reason — that an import column would be this field\'s first and only writer, bypassing a refusal that only ran on SHIFT assignment — no longer holds: core/roster.ts setEmploymentScheduleGroup now runs the same refusal from the GROUP side, against the shift the employee is already on. Adding the column is therefore a question that can be reopened on its merits; this file is where the answer is recorded, and today the answer is still no.',
        fields: ['attendanceRuleId'],
      },
      {
        reason:
          'free-text organisation dimensions (v1 has no master data behind them) — a template offering values it cannot validate is exactly the drift this file exists to stop',
        fields: [
          'orgBranch',
          'orgDivision',
          'orgRegion',
          'orgLine',
          'orgSection',
          'orgTeam',
          'orgBase',
          'employmentCategory',
        ],
      },
    ],
  },

  // ──────────────── assignment — the effective-dated placement created at hire ────────────────
  assignment: {
    table: assignment,
    sheet: 'employee',
    covered: {
      departmentId: 'department',
      positionId: 'position',
      costCenterId: 'cost_center',
      employmentType: 'employment_type',
    },
    excluded: [
      {
        reason: PLUMBING,
        fields: ['id', 'tenantId', 'employmentId', 'createdAt', 'recordedAt', 'supersededAt'],
      },
      {
        reason:
          'the effective-dating itself — the hire date this file already carries opens the first assignment, and a creation file has no later version to close',
        fields: ['validFrom', 'validTo'],
      },
      {
        reason:
          'resolved from the employee row rather than keyed twice: the assignment company is the row company, and one file may not state two',
        fields: ['companyId'],
      },
      {
        reason:
          'placement dimensions the Organisation Assignment card maintains after hire; importable, but out of the approved scope for this round',
        fields: ['businessUnitId', 'locationId'],
      },
    ],
  },

  // ─────────────── employee_statutory_my — Bank & Statutory + Passport (MY pack) ───────────────
  employeeStatutoryMy: {
    table: employeeStatutoryMy,
    sheet: 'employee',
    covered: {
      icNumber: 'ic_number',
      epfNumber: 'epf_number',
      socsoNumber: 'socso_number',
      taxNumber: 'tax_number',
      taxCategory: 'tax_category',
      numChildren: 'num_children',
      eisEligible: 'eis_eligible',
      isResident: 'is_resident',
      epfCitizenship: 'epf_citizenship',
      bankName: 'bank_name',
      bankAccountNo: 'bank_account_no',
      // r253 — Passport Information.
      passportNumber: 'passport_number',
      passportIssueDate: 'passport_issue_date',
      passportExpiryDate: 'passport_expiry_date',
      passportIssuingCountry: 'passport_issuing_country',
    },
    excluded: [
      { reason: PLUMBING, fields: ['id', 'tenantId', 'personId', 'createdAt', 'updatedAt'] },
      {
        reason:
          'passport detail beyond the trio + issuing country: a free-text remark and the CP39 country CODE, which HR picks by hand precisely because it is not derivable from the country name (e4b541c6)',
        fields: ['passportRemark', 'passportIssuingCountryCode', 'oldIcNumber'],
      },
      {
        reason:
          'per-scheme statutory overrides and employer-bears switches — each one changes what an employee is PAID, so it is an explicit decision on the Statutory card, never a spreadsheet cell nobody reads',
        fields: [
          'socsoCategory',
          'eisCategory',
          'subjectToSocso',
          'subjectToSkbbk',
          'employerBearsSocso',
          'employerBearsEis',
          'employerBearsSkbbk',
          'employerBearsEpf',
          'employerBearsTax',
          'subjectToHrdf',
          'epfMode',
          'epfEmployeeRate',
          'epfEmployerRate',
          'taxResidency',
        ],
      },
      {
        reason:
          'TP3 opening balances — prior-employer year-to-date figures loaded by the payroll history import (4157a498), which is the file that carries a year of numbers',
        fields: ['tp3Year', 'tp3NetRemuneration', 'tp3EpfClaimed', 'tp3PcbPaid', 'tp3ZakatPaid'],
      },
      {
        reason:
          'zakat election (ADR-0058) — an employee opt-in with its own card, method and effective dates; not day-one identity data',
        fields: [
          'zakatActive',
          'zakatState',
          'zakatMethod',
          'zakatPercent',
          'zakatFixed',
          'zakatEffectiveFrom',
          'zakatEffectiveTo',
        ],
      },
      {
        reason:
          'third-party payee override (ef720d3a): salary paid into someone else`s account is a banking exception that must be arranged deliberately, not switched on by a column in a bulk file',
        fields: ['enableCustomHolderName', 'customHolderName', 'enableCustomHolderId', 'customHolderId'],
      },
      {
        reason:
          'PCB relief detail derived from, or confirmed against, the Family register the family sheet already loads (child relief mode / grid) or flagged on the Statutory card (OKU)',
        fields: ['childReliefMode', 'childReliefTable', 'disabledIndividual', 'disabledSpouse'],
      },
    ],
  },

  // ───────────────────────────── compensation — Payroll tab ─────────────────────────────
  compensation: {
    table: compensation,
    sheet: 'employee',
    covered: {
      basicSalary: 'basic_salary',
      monthlyAllowance: 'monthly_allowance',
      payMode: 'pay_mode',
      paymentTerm: 'payment_term',
      rateAmount: 'rate_amount',
    },
    excluded: [
      {
        reason: PLUMBING,
        fields: ['id', 'tenantId', 'employmentId', 'createdAt', 'recordedAt', 'updatedAt', 'supersededAt'],
      },
      {
        reason:
          'the effective-dating itself — a hire`s first salary record starts on the hire date this file already carries and has no successor to close',
        fields: ['validFrom', 'validTo'],
      },
      {
        reason: 'single-currency product today; the column exists for a later multi-currency slice',
        fields: ['currency'],
      },
      {
        reason:
          'the reason for a salary CHANGE (87c82b18). A hire has no previous salary to explain, and every imported row would carry the same word',
        fields: ['remarks'],
      },
    ],
  },

  // ───────────────── person_emergency_contact — Emergency Contact card ─────────────────
  personEmergencyContact: {
    table: personEmergencyContact,
    sheet: 'employee',
    covered: {
      fullName: 'emergency_contact_name',
      relationship: 'emergency_contact_relationship',
      mobilePhone: 'emergency_contact_phone',
      homePhone: 'emergency_contact_home_phone',
      address: 'emergency_contact_address',
    },
    excluded: [
      { reason: PLUMBING, fields: ['id', 'tenantId', 'personId', 'createdAt', 'updatedAt', 'archivedAt'] },
      {
        reason:
          'the register holds SEVERAL contacts ranked primary / secondary / other; one employee row can carry one of them, and the importer files it as Primary — a second contact is maintained on the card',
        fields: ['priority'],
      },
      { reason: 'free-text note on the contact, with nothing in a day-one file to put in it', fields: ['remarks'] },
    ],
  },

  // ──────────────────────── employee_dependent — the FAMILY sheet ────────────────────────
  employeeDependent: {
    table: employeeDependent,
    sheet: 'family',
    covered: {
      fullName: 'full_name',
      relationship: 'relationship',
      dateOfBirth: 'date_of_birth',
      gender: 'gender',
      icOrPassport: 'ic_or_passport',
      passportNumber: 'passport_number',
      phone: 'phone',
      isBeneficiary: 'is_beneficiary',
      remarks: 'remarks',
    },
    excluded: [
      { reason: PLUMBING, fields: ['id', 'tenantId', 'personId', 'createdAt', 'updatedAt', 'archivedAt'] },
      {
        reason:
          'spouse-only employment detail maintained on the Family card (occupation, employer, marriage date and status) — a second block of columns that would be blank for every child and parent row',
        fields: [
          'occupation',
          'companyName',
          'employerAddress',
          'marriageDate',
          'marriageStatus',
          'spouseWorking',
          'residentialAddress',
        ],
      },
      {
        reason:
          'child-only education detail (student flag, school, level, country) maintained on the Family card, and blank for every non-child row',
        fields: ['isStudent', 'schoolName', 'studyLevel', 'studyCountry'],
      },
      {
        reason:
          'per-child PCB relief configuration (6c635212) — it changes what the employee is TAXED, and the benefits-vs-tax firewall means HR confirms it on the card rather than importing it',
        fields: ['childReliefCategory', 'childTaxRelief', 'childReliefPercentage'],
      },
      {
        reason:
          'a family member who has died is recorded on the card when it happens; a day-one intake of a workforce does not begin with it',
        fields: ['isDeceased', 'deceasedOn'],
      },
    ],
  },

  // ──────────────────── reporting_line — the Direct Superior edge ────────────────────
  reportingLine: {
    table: reportingLine,
    sheet: 'employee',
    covered: {
      managerEmploymentId: 'direct_superior',
    },
    excluded: [
      { reason: PLUMBING, fields: ['id', 'tenantId', 'createdAt', 'recordedAt', 'supersededAt'] },
      {
        reason:
          'the subordinate IS the employee row the column sits on — naming it again would let a row point the edge at somebody else',
        fields: ['subordinateEmploymentId'],
      },
      {
        reason:
          'the Direct Superior field is the administrative line and always has been (dce55aff); functional / project / dotted / delegate lines are not maintainable from any screen either',
        fields: ['lineType'],
      },
      {
        reason:
          'the edge opens on the employee`s hire date and stays open — a creation file has no history to date and no window to close',
        fields: ['validFrom', 'validTo'],
      },
      {
        reason:
          'approval-delegation fields (reason + org coverage) that belong to `delegate` edges only, which this column never creates',
        fields: ['reason', 'scopeCompanyId', 'scopeBusinessUnitId', 'scopeDepartmentId'],
      },
    ],
  },
};

describe('2983802f · the import template cannot drift from the employee record', () => {
  describe.each(Object.entries(REGISTRY))('%s', (tableName, entry) => {
    const actual = Object.keys(getTableColumns(entry.table));
    const covered = Object.keys(entry.covered);
    const excluded = entry.excluded.flatMap((g) => g.fields);

    it('every field is either carried by an import column or excluded with a named reason', () => {
      const accountedFor = new Set([...covered, ...excluded]);
      const unaccounted = actual.filter((f) => !accountedFor.has(f));
      expect(
        unaccounted,
        `${tableName}: these employee fields are neither carried by an import column nor excluded with a ` +
          `reason. Add a column to lib/import-schema.ts, or add the field to this file's exclusions with ` +
          `one line saying why the template does not carry it.`,
      ).toEqual([]);
    });

    it('no entry names a field that no longer exists (a rename or a drop must not go unnoticed)', () => {
      const real = new Set(actual);
      const stale = [...covered, ...excluded].filter((f) => !real.has(f));
      expect(stale, `${tableName}: these entries name columns that are not on the table any more`).toEqual([]);
    });

    it('no field is listed twice', () => {
      const all = [...covered, ...excluded];
      const dupes = all.filter((f, i) => all.indexOf(f) !== i);
      expect(dupes, `${tableName}: listed under two headings`).toEqual([]);
    });

    it('every covered field names an import column the template actually offers', () => {
      const sheet = entry.sheet === 'family' ? FAMILY_SHEET : EMPLOYEE_SHEET;
      const dangling = Object.entries(entry.covered).filter(([, col]) => !sheet.has(col));
      expect(
        dangling,
        `${tableName}: these fields claim an import column that is not in ` +
          `${entry.sheet === 'family' ? 'DEPENDENT_IMPORT_COLUMNS' : 'IMPORT_COLUMNS'}`,
      ).toEqual([]);
    });

    it('every exclusion carries a real reason, not a placeholder', () => {
      for (const group of entry.excluded) {
        expect(group.fields.length, `${tableName}: an exclusion group with no fields`).toBeGreaterThan(0);
        // Long enough to be a sentence. "TODO" / "n/a" / "later" cannot pass.
        expect(group.reason.length, `${tableName}: "${group.reason}" is not a reason`).toBeGreaterThan(40);
      }
    });
  });

  it('every import column carries a field — a column with nothing behind it is drift in the other direction', () => {
    const claimed = new Set<string>();
    for (const entry of Object.values(REGISTRY)) {
      for (const col of Object.values(entry.covered)) claimed.add(col);
    }
    const employeeOrphans = [...EMPLOYEE_SHEET].filter((c) => !claimed.has(c));
    expect(employeeOrphans, 'employee-sheet columns that map to no employee field').toEqual([]);
    const familyOrphans = [...FAMILY_SHEET].filter((c) => !claimed.has(c) && c !== FAMILY_LINK_COLUMN);
    expect(familyOrphans, 'family-sheet columns that map to no dependant field').toEqual([]);
  });

  it('the seven fields the reporter named as absent are now carried', () => {
    // Named individually rather than as a count, so a future edit that drops one is a failure that says
    // WHICH ask was dropped. These are exactly the gaps item 2983802f reported.
    expect(EMPLOYEE_SHEET.has('passport_number'), 'passport').toBe(true);
    expect(EMPLOYEE_SHEET.has('address_line_1'), 'address').toBe(true);
    expect(EMPLOYEE_SHEET.has('emergency_contact_name'), 'emergency contact').toBe(true);
    expect(EMPLOYEE_SHEET.has('probation_months'), 'probation').toBe(true);
    expect(EMPLOYEE_SHEET.has('resignation_notice_months'), 'notice period').toBe(true);
    expect(EMPLOYEE_SHEET.has('direct_superior'), 'direct superior').toBe(true);
    expect(FAMILY_SHEET.has('relationship'), 'family').toBe(true);
  });
});
