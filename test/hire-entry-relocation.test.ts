/**
 * Create New Employee — where the entry point lives, and what it no longer does. Static-source guard.
 *
 * HISTORY, because this file has now guarded two different relocations and the second supersedes the
 * first. Feedback 5c9b73f2 moved new-employee creation from a collapsed "+ Hire an employee"
 * <details> at the BOTTOM of the Personnel list to a prominent top-right "+ Create new employee"
 * button that toggled the SAME inline form above the listing. Item 6d671f44 finishes the journey: the
 * button now opens a DEDICATED step-by-step screen with Save as Draft, and the inline form is gone.
 * The reporter's requirement is literal — "The current employee list screen shall not be used for
 * data entry" — so the assertions below are mostly ABSENCES, which is the only way to pin that.
 *
 * What did NOT change, and is asserted so a future edit cannot quietly drop it: the org cascade rule
 * (`hireOptionVisible`), the standing leave grants, the server-computed provisional end date, and the
 * fact that creation runs the existing writers rather than a bespoke insert.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as personnelActions from '../app/admin/personnel/actions';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const listPage = read('app/admin/personnel/page.tsx');
const wizardPage = read('app/admin/personnel/new/page.tsx');
const wizard = read('app/admin/personnel/new/wizard.tsx');
const wizardActions = read('app/admin/personnel/new/actions.ts');
const draftCore = read('core/employee-draft.ts');

describe('the entry point is a link to a dedicated screen', () => {
  it('renders the Create New Employee link in the PageHeader actions, carrying the tour anchor', () => {
    expect(listPage).toContain('href="/admin/personnel/new"');
    expect(listPage).toMatch(/\{t\('createNewEmployee'\)\}/);
    // The onboarding tour's anchor appears exactly once, on the button, as it has since 5c9b73f2.
    expect((listPage.match(/data-tour="people-hire"/g) ?? []).length).toBe(1);
  });

  it('keeps the older relocation intact: no collapsed <details> entry point came back', () => {
    expect(listPage.includes('<details>')).toBe(false);
    expect(listPage.includes("t('hireAnEmployee')")).toBe(false);
  });
});

describe('the list screen is no longer a data-entry surface', () => {
  it('has no hire form, no hire-form ids and no inline cascade script', () => {
    for (const gone of [
      '<HireFormPanel>',
      'HireFormProvider',
      'HireFormButton',
      'HIRE_ORG_FILTER_SCRIPT',
      'dangerouslySetInnerHTML',
      'id="hire-company"',
      'id="hire-department"',
      'name="initialBasicSalary"',
    ]) {
      expect(listPage.includes(gone), gone).toBe(false);
    }
  });

  it('`hireAction` is REMOVED from the module surface, not merely uncalled', () => {
    // Every export of a 'use server' module is a callable endpoint whether or not a screen posts to
    // it — the exact vestige r80 found for leave decisions. So this is asserted against the loaded
    // module, which source text alone cannot prove.
    expect('hireAction' in personnelActions).toBe(false);
    expect(typeof personnelActions.decideProfileChangeAction).toBe('function');
    // And the reason is written where the next reader will look for the missing action.
    expect(read('app/admin/personnel/actions.ts')).toContain('`hireAction` USED TO LIVE HERE');
  });

  it('the shared hire-employee client component is deleted', () => {
    expect(() => read('components/hire-employee.tsx')).toThrow();
  });
});

describe('the dedicated screen carries the whole job', () => {
  it('is a step-by-step form with the five steps and a review', () => {
    for (const step of ['profile', 'employment', 'statutory', 'payroll', 'review']) {
      expect(wizard.includes(`step === '${step}'`), step).toBe(true);
    }
    expect(wizard).toContain("t('steps.");
  });

  it('saves a draft WITHOUT validating, and only validates on create', () => {
    // A draft that refused to save until it was complete would not be a draft.
    expect(wizard).toContain('saveDraftAction(id ?? undefined, data');
    expect(wizard).toContain('disabled={pending || outstanding.length > 0}');
    expect(wizardActions).toContain('completeEmployeeDraft');
  });

  it('preserves the org cascade rule rather than reimplementing it', () => {
    expect(wizard).toContain('hireOptionVisible({');
    expect(wizardPage).toContain('labelIdsForCompany(session, kind, c.id)');
  });

  it('creation runs the EXISTING writers — no bespoke insert', () => {
    for (const writer of ['hireEmployee', 'setCompensation', 'setPersonComplianceFields', 'pack.statutory.set']) {
      expect(draftCore.includes(writer), writer).toBe(true);
    }
    // The three standing grants survive the move.
    expect(draftCore).toContain("new Set(['ANNUAL', 'SICK', 'HOSPITALIZATION'])");
    // And no movement event is emitted for the initial assignment — that would give every new
    // employee a spurious second Employment History row (the r78 / 4d391ab7 fault).
    expect(draftCore).not.toContain('appendMovement');
    expect(draftCore).toContain('IT ALSO DOES NOT EMIT A MOVEMENT EVENT');
  });

  it('a draft consumes no Employee ID — the counter only advances inside hireEmployee', () => {
    expect(draftCore).toContain('employeeCode: str(p.employeeCode)');
    expect(draftCore).toContain('consumes no Employee ID');
    // Nothing in the draft path calls the code generator directly.
    expect(draftCore).not.toContain('nextEmployeeCode');
    expect(draftCore).not.toContain('generateEmployeeCode');
  });
});
