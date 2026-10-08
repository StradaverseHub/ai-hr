/**
 * r418 (items e74af58c and 5c31d379) — WHICH IDENTITY NUMBER A MALAYSIAN STATUTORY FORM PRINTS FOR A PERSON.
 *
 * PURE and dependency-free (no db, no next-intl, no 'use client'), like `./ic-dob.ts`, so a client screen
 * may import it as safely as the server reads do. ONE rule, used by the Borang 8A read (and so by the EIS
 * (SIP) schedule, which re-shapes that read) and by the Borang A read (and so by the BBCD, which projects
 * from it). Two forms that asked the same person for two different documents is the defect this exists to
 * stop: the reporter's "Employee D", a non-citizen with a passport and no IC, was refused by Borang 8A for
 * having no IC.
 *
 * ── THE RULE (the approved build notes, verbatim in effect) ────────────────────────────────────────────
 * The STATUS is `employee_statutory_my.epf_citizenship` — the same field that decides the person's EPF
 * rate, so a wrong status is corrected in exactly one place and both the rate and the form follow it.
 *   • non_citizen → the PASSPORT number. Missing ⇒ "Passport number".
 *   • pr          → the IC field, read as the MyPR number (the two cards share the 12-digit format and this
 *                   system holds a permanent resident's MyPR number in `ic_number`). Missing ⇒ "MyPR number".
 *   • citizen, or NO statutory row at all (`null`) → the IC. With no IC, the passport is used when a
 *                   nationality is recorded and it is not Malaysian (`isMalaysianNationality`); otherwise
 *                   the person is missing — "IC or passport number" when the recorded nationality is
 *                   non-Malaysian, "IC" otherwise.
 * A citizen with an IC keeps the IC whatever the nationality text says (production holds one Singaporean
 * recorded as a citizen with an IC; that line keeps printing the IC).
 *
 * WHAT THIS DOES NOT DO. It does not validate the number's shape (a fixed-width upload file does that, on
 * its own spec), it does not decide which number an AGENCY UPLOAD FILE carries (the PERKESO ASSIST and KWSP
 * i-Akaun files keep reading the IC field — see r418 in docs/HANDOFF-HISTORY.md), and it never invents a
 * number: an absent one is reported, never printed as something else.
 */
import { isMalaysianNationality } from './ic-dob';

export type EpfCitizenship = 'citizen' | 'pr' | 'non_citizen';

/** Which document the printed number is. `null` only when nothing applicable is on file. */
export type StatutoryIdentityKind = 'ic' | 'mypr' | 'passport';

/**
 * The readiness reason when the applicable number is absent. These strings are what the review screens
 * print beside the person's name ("Employee D (Passport number)"), so they are the precise thing to fill in.
 */
export type StatutoryIdentityMissing = 'IC' | 'MyPR number' | 'Passport number' | 'IC or passport number';

export type StatutoryIdentity = {
  /** The number to print, trimmed. Empty string when `kind` is null. */
  value: string;
  kind: StatutoryIdentityKind | null;
  /** Null when a number was found. */
  missing: StatutoryIdentityMissing | null;
};

const clean = (v: string | null | undefined): string => (v ?? '').trim();

export function statutoryIdentityFor(p: {
  /** `employee_statutory_my.epf_citizenship`; null when the person has no statutory row. */
  epfCitizenship: EpfCitizenship | string | null | undefined;
  /** `person.nationality` — free text / catalog value. */
  nationality: string | null | undefined;
  icNumber: string | null | undefined;
  passportNumber: string | null | undefined;
}): StatutoryIdentity {
  const ic = clean(p.icNumber);
  const passport = clean(p.passportNumber);

  if (p.epfCitizenship === 'non_citizen') {
    return passport
      ? { value: passport, kind: 'passport', missing: null }
      : { value: '', kind: null, missing: 'Passport number' };
  }
  if (p.epfCitizenship === 'pr') {
    return ic ? { value: ic, kind: 'mypr', missing: null } : { value: '', kind: null, missing: 'MyPR number' };
  }
  // citizen, or no statutory row at all.
  if (ic) return { value: ic, kind: 'ic', missing: null };
  const nationalitySet = clean(p.nationality) !== '';
  const foreign = nationalitySet && !isMalaysianNationality(p.nationality);
  if (foreign && passport) return { value: passport, kind: 'passport', missing: null };
  return { value: '', kind: null, missing: foreign ? 'IC or passport number' : 'IC' };
}
