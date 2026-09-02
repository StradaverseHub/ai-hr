/**
 * r242 (item b36a8a91) — IS THIS EA READY TO BE FILED, AND IF NOT, WHICH BOX IS EMPTY AND WHERE DOES THE
 * DETAIL LIVE?
 *
 * THE PROBLEM IT SOLVES. The review screen prints every box on the C.P.8A, and a box with nothing behind
 * it looks exactly like a box whose real value is zero. So an operator either reads fifty rows against a
 * mental list of what should be there, or files a statement with an empty PERKESO number in it. The panel
 * this module feeds says one of two things at the top of the form — ready for review, or review required —
 * and when something is missing it NAMES the box and says where on the employee's record it belongs.
 *
 * ⚠️ WHAT "MISSING" MEANS, AND WHY THE DEFINITION IS THE WHOLE OF THIS FILE (AGENTS 28).
 * A box flagged "missing" asserts that somebody's record is incomplete, on a tax document. That claim has
 * to be one we can stand behind, so:
 *
 *   • ONLY a box the field register (lib/ea-field-register.ts) says is fed by the employee's own STAFF
 *     RECORD is ever checked. The register is the authority on which box takes its value from where, and
 *     `eaReadinessChecks()` DROPS any check whose source it does not call `staff`-fed — so this file
 *     cannot outlive a change to the form's mapping, it can only go quiet.
 *   • A PAYROLL-DERIVED FIGURE IS NEVER CHECKED, AT ANY VALUE. Zero is a legitimate answer to "how much
 *     bonus was paid" — reporting it as missing would tell an operator to go and correct a record that is
 *     already correct, which is the same class of false statement as printing 0.00 in a box with no source.
 *     No amount on this form is a readiness check, and there is no arithmetic in this file at all.
 *   • A BOX THE FORM DOES NOT ASK THIS EMPLOYEE FOR IS NOT MISSING. The C.P.8A takes an identity card OR a
 *     passport, so neither is missing while the other is on file; and a fund number is asked for because
 *     contributions were made, so an employee with no contribution to that fund all year is not flagged
 *     for having no number. Under-reporting is the safer failure: an unflagged box asserts nothing, while
 *     a wrongly-flagged one asserts a fault that is not there.
 *
 * IT COUNTS AND NAMES BOXES. IT DOES NOT COMPUTE ANY OF THEM. Every value it reads comes from the EA
 * statement the screen has already loaded, so there is no second derivation of an EA figure here and
 * nothing on the panel can disagree with the form printed beneath it. The import list is the guarantee:
 * the field register is the ONLY thing this module imports, and nothing it imports can produce a figure.
 */
import { EA_REGISTER } from './ea-field-register';

/**
 * The `payroll.ea` caption keys this panel is allowed to name a box with — the SCREEN's own vocabulary,
 * which is what the reader sees printed against the box two rows further down.
 *
 * A union rather than `keyof EaPdfLabels`, because the two vocabularies are not the same and pretending
 * they are would be a lie in the type: the income tax number is drawn on the PDF from the agency's own
 * Malay wording (`EA_FORM_WORDS.employeeTin`, printed in Malay whatever language the reader has chosen),
 * while the statement screen prints `payroll.ea.incomeTaxNo`. Every key here is one the statement already
 * dereferences with a literal, so test/i18n-coverage.test.ts's static sweep covers all six locales.
 */
export type EaBoxCaption = 'name' | 'icNo' | 'passportNo' | 'incomeTaxNo' | 'epfNo' | 'socsoNo';

/**
 * Where on the employee's record the detail belongs, as the operator would navigate to it.
 *
 * Two values, because the identifiers this form needs live on exactly two tabs of Personnel Management:
 * the identity document sits on Profile, and the tax / fund numbers on Bank & Statutory. Naming the tab
 * rather than linking to it keeps this module free of a route and free of a permission question — the
 * screen owns both.
 */
export type EaReadinessWhere = 'profile' | 'bankStatutory';

/** Everything this module reads, and it is a subset of `EaStatement` on purpose. */
export type EaReadinessInput = {
  employee: {
    name: string;
    ic: string | null;
    passport: string | null;
    taxNo: string | null;
    epfNo: string | null;
    socsoNo: string | null;
  };
  /** Read ONLY to decide whether the form asks this employee for a fund number — never as a figure. */
  partE: { epf: number; socso: number };
};

export type EaReadinessCheck = {
  /**
   * The `EaPdfData` path(s) the field register records for this box, written exactly as the register
   * writes them. This is the join: a path the register does not call `staff`-fed is not checked.
   */
  sources: string[];
  /**
   * The `payroll.ea` caption key(s) that NAME the box, in the screen's own vocabulary — the same keys the
   * statement prints in Section A, so the panel and the row beneath it call the box the same thing. Two
   * keys where the form takes either document.
   */
  captions: EaBoxCaption[];
  where: EaReadinessWhere;
  /** True when the employee's record holds the detail. */
  onRecord: (s: EaReadinessInput) => boolean;
  /** Absent ⇒ the form asks every employee for this box. */
  askedOf?: (s: EaReadinessInput) => boolean;
};

const filled = (v: string | null | undefined) => (v ?? '').trim() !== '';

/**
 * "Is there a figure here at all", to the cent — the same test lib/ea-pdf.ts applies before it draws a box
 * with no payroll source. It decides whether the form ASKS for a fund number; it never decides whether a
 * figure is missing, and nothing here reports an amount.
 */

/**
 * THE BOXES THIS PANEL IS COMPETENT TO JUDGE — the identifiers, which is the same set the CP39 and
 * contributions listings have always flagged an employee for (`readinessFor`, in the Malaysia pack's own
 * reports module).
 *
 * WHAT IS DELIBERATELY NOT HERE, though the register calls it staff-fed:
 *   • Jawatan (A2) — the title on the assignment in force at the END of the year. A person still employed
 *     on an open assignment legitimately has none, so an empty box is not a fault.
 *   • No. Kakitangan / No. Gaji (A3) — the EMPLOYER's own staff number. It identifies the person to the
 *     employer, not to LHDN, and an employer that does not number its staff is not incomplete.
 *   • Bilangan anak (A8) — a whole number, where zero is an answer and not an absence.
 *   • Tarikh mula / berhenti bekerja (9a / 9b) — the form asks for them only when the employment did not
 *     run the whole year, and a current employee has no leaving date at all.
 * Each of those would be a box flagged on a record that is already correct.
 */
export const EA_READINESS_CHECKS: readonly EaReadinessCheck[] = [
  {
    sources: ['employee.name'],
    captions: ['name'],
    where: 'profile',
    onRecord: (s) => filled(s.employee.name),
  },
  {
    // ONE item over the form's boxes 4 and 5: the C.P.8A takes a new I.C. number or a passport number, and
    // a Malaysian with an I.C. is not missing a passport. Flagged only when the record holds neither.
    sources: ['employee.ic', 'employee.passport'],
    captions: ['icNo', 'passportNo'],
    where: 'profile',
    onRecord: (s) => filled(s.employee.ic) || filled(s.employee.passport),
  },
  {
    sources: ['employee.taxNo'],
    captions: ['incomeTaxNo'],
    where: 'bankStatutory',
    onRecord: (s) => filled(s.employee.taxNo),
  },
  {
    /* ⚠️ NO `askedOf` GATE ON EITHER FUND NUMBER, AND THE ONE THIS ROUND REMOVED IS WORTH RECORDING.
       The first version silenced these two boxes when the employee's own contribution for the year was
       zero, reasoning that somebody who did not contribute has nothing for the box to hold. That reads
       well and is wrong: the EMPLOYEE's EPF share is zero for a member aged 60 and over under the Third
       Schedule while the employer still contributes and the number is still required on the form, and a
       SOCSO category can do the same. So a contribution amount is not a proxy for fund registration — it
       is a proxy for age and category, and using it silently switched the check off for exactly the
       population most likely to be reviewed by hand. The register calls both boxes staff-fed
       unconditionally, and so does this. */
    sources: ['employee.epfNo'],
    captions: ['epfNo'],
    where: 'bankStatutory',
    onRecord: (s) => filled(s.employee.epfNo),
  },
  {
    sources: ['employee.socsoNo'],
    captions: ['socsoNo'],
    where: 'bankStatutory',
    onRecord: (s) => filled(s.employee.socsoNo),
  },
];

/** The `EaPdfData` paths the field register records as coming from the employee's own staff record. */
const staffFedSources = (): Set<string> =>
  new Set(EA_REGISTER.filter((r) => r.feed === 'staff').flatMap((r) => r.sources));

/**
 * The checks the register still backs. A check naming a path the register no longer calls `staff`-fed is
 * dropped rather than trusted — the register is where "this box comes from the employee's record" is
 * decided, and a panel that outvoted it would be asserting something the form's own mapping denies.
 * test/ea-readiness.test.ts fails if anything is dropped, so a silent narrowing cannot ship unnoticed.
 */
export function eaReadinessChecks(): EaReadinessCheck[] {
  const staff = staffFedSources();
  return EA_READINESS_CHECKS.filter((c) => c.sources.every((src) => staff.has(src)));
}

export type EaBoxRef = { captions: EaBoxCaption[]; where: EaReadinessWhere };
export type EaReadiness = {
  /** True when nothing the form takes from the employee's record is missing. It says NOTHING about the figures. */
  ready: boolean;
  missing: EaBoxRef[];
  /**
   * The boxes this form actually asks THIS employee for — `missing` plus the ones that are on file.
   *
   * The panel prints them, so the reader can see the extent of what was checked rather than inferring it
   * from a green line. A box the form does not ask this employee for is not listed, because saying we
   * checked it would be its own small untruth.
   */
  checked: EaBoxRef[];
};

export function eaReadiness(s: EaReadinessInput): EaReadiness {
  const asked = eaReadinessChecks().filter((c) => (c.askedOf ? c.askedOf(s) : true));
  const ref = (c: EaReadinessCheck): EaBoxRef => ({ captions: c.captions, where: c.where });
  const missing = asked.filter((c) => !c.onRecord(s)).map(ref);
  return { ready: missing.length === 0, missing, checked: asked.map(ref) };
}
