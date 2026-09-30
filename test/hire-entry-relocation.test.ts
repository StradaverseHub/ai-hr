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
 * ITEM 034a5080 IS THE THIRD RELOCATION, and it moves the BUTTON only: Create New Employee now opens a
 * prompt over the list instead of navigating to the route. The route, the step-by-step-replacement tab
 * shell, the deleted inline hire form and the removed `hireAction` are all untouched by it — see the
 * quoted old claim in the first describe for what changed and why it is not a loosening.
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
// 034a5080 — the prompt that now opens over the list. The href and the tour anchor moved here.
const createDialog = read('app/admin/personnel/create-employee-dialog.tsx');
/** Comments stripped, for the reason test/function-access.test.ts strips them: this file's assertions are
 *  about what the code DOES, and the headers here explain the very idioms being asserted absent. */
const codeOf = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const createDialogCode = codeOf(createDialog);

describe('the entry point opens a prompt, and is still a link to the dedicated screen', () => {
  /**
   * ── UPDATED BY ITEM 034a5080, AND THE UPDATE IS THE ITEM ───────────────────────────────────────────
   *
   * THE OLD CLAIM, quoted so the reversal is readable rather than merely absent:
   *
   *     it('renders the Create New Employee link in the PageHeader actions, carrying the tour anchor', () => {
   *       expect(listPage).toContain('href="/admin/personnel/new"');
   *       expect(listPage).toMatch(/\{t\('createNewEmployee'\)\}/);
   *       // The onboarding tour's anchor appears exactly once, on the button, as it has since 5c9b73f2.
   *       expect((listPage.match(/data-tour="people-hire"/g) ?? []).length).toBe(1);
   *     });
   *
   * WHY IT CHANGED. 6d671f44's reporter wrote "The current employee list screen shall not be used for
   * data entry", so the button became a plain Link off this page. 034a5080's reporter asks for the
   * opposite for the four-question create: "the system shall display a Create New Employee prompt/modal
   * instead of navigating the user to a separate full screen." Both are the same product owner and the
   * second supersedes the first for THIS button only — the inline hire form 6d671f44 deleted is still
   * deleted, and the list is still not a data-entry surface (the describe below is untouched).
   *
   * WHAT IS PINNED NOW, and it is not weaker. The href and the tour anchor did not disappear; they MOVED
   * into app/admin/personnel/create-employee-dialog.tsx with the button they belong to, and the trigger is
   * still a real Link so ⌘-click, middle-click and a JS-less browser still reach the full screen. So the
   * anchor is still asserted to appear EXACTLY ONCE — counted across both files, which is stronger than
   * counting it in one of them, because a second copy anywhere now fails.
   */
  it('renders the Create New Employee prompt trigger, still linking the route and carrying the tour anchor', () => {
    // The trigger's LABEL is resolved on the server page (so the dialog file keeps to one message
    // namespace — test/i18n-coverage.test.ts check C), and the component is rendered where the Link was.
    expect(listPage).toMatch(/\{t\('createNewEmployee'\)\}/);
    expect(listPage).toContain('<CreateEmployeeDialog');
    // The route is NOT abandoned: the trigger is an <a href>, intercepted on a plain left click only.
    expect(createDialogCode).toContain('href="/admin/personnel/new"');
    expect(createDialogCode).toContain('e.preventDefault()');
    // Exactly once, across the list page and the component — 5c9b73f2's invariant, counted wider. In
    // CODE, not in prose: the dialog's header comment names the attribute it carries, and the first draft
    // of this count read 2 because of that sentence.
    const anchors = [listPage, createDialog].reduce(
      (n, src) => n + (codeOf(src).match(/data-tour="people-hire"/g) ?? []).length,
      0,
    );
    expect(anchors).toBe(1);
  });

  it('the prompt renders the SHARED create body, not a second copy of the Employee ID block', () => {
    // The whole risk of 034a5080 is two answers to "which Employee ID is this employee getting". There is
    // one: `CreateEmployeeFields` in app/admin/personnel/new/create-form.tsx, which both surfaces render.
    expect(createDialogCode).toContain('CreateEmployeeFields');
    expect(createDialogCode).toContain("from './new/create-form'");
    // And the confirmation reports the code the SERVER issued, never the previewed sample. The behaviour
    // is pinned by rendering in test/create-employee-dialog.dom.test.tsx; this is the shape of it.
    expect(createDialogCode).toContain('created.employeeCode');
    expect(createDialogCode).not.toContain('sampleCode');
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
  it('is the ACTIVE RECORD\'S OWN TAB SHELL now, not a step-by-step form (759dfc7d work item 2)', () => {
    // THE STEP-BY-STEP FORM IS GONE, and its absence is the change. It used to render one step at a time
    // behind `{step === 'profile' && …}` with a Back and a Next; the reporter's objection was that the
    // same person, once activated, opened a screen with different tabs, different section names and a
    // different layout — two screens to learn for one employee.
    for (const step of ['profile', 'employment', 'statutory', 'payroll', 'review']) {
      expect(wizard.includes(`step === '${step}'`), step).toBe(false);
    }
    // What replaced it is the SHELL THE ACTIVATED RECORD USES, imported rather than reimplemented, so a
    // second tab strip cannot drift from the first.
    expect(wizard).toContain("import { ClientTabs } from '@/components/personnel-tabs'");
    expect(wizard).toContain('<ClientTabs');
    // Five tabs, each labelled by a STATIC key (never `t(`tabs.${k}`)`) so i18n coverage check C sees it,
    // and test/draft-record-tabs.test.ts pins each value equal to the record's own `people.detail.tabs`.
    for (const tab of ['profile', 'job', 'bankStatutory', 'payroll', 'family']) {
      expect(wizard.includes(`t('tabs.${tab}')`), tab).toBe(true);
    }
    // And the four tabs a draft must NOT get — they describe things that have happened to an employment,
    // and a draft has none — are not smuggled in as empty panels.
    for (const absent of ['careerMovement', 'attendance', 'leave', 'documents', 'qualification', 'others']) {
      expect(wizard.includes(`t('tabs.${absent}')`), absent).toBe(false);
    }
    // Back and Next went with the sequence they moved along.
    expect(wizard).not.toContain("t('back')");
    expect(wizard).not.toContain("t('next')");
  });

  it('saves a draft WITHOUT validating, and only validates on Activate', () => {
    // A draft that refused to save until it was complete would not be a draft.
    expect(wizard).toContain('saveDraftAction(id, data');
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

  it('a draft HOLDS its Employee ID, and Activate spends the held one rather than issuing a second', () => {
    // THIS GUARD WAS INVERTED BY ITEM 06f0cb8f, deliberately, and the inversion is the item. It used to
    // assert that `core/employee-draft.ts` never touched the code generator — that was 6d671f44's rule
    // that a draft consumes no Employee ID. The reporter asked for the opposite: the ID must be taken at
    // Create and held, so no second draft, no hand-entry and no bulk import can be given it.
    //
    // What still has to be true, and is what this now pins: Activate must hand `hireEmployee` the HELD
    // code, never a blank. A blank would run the generator a second time and the employee would end up
    // with a different ID from the one HR was shown — and possibly printed on an offer letter — while
    // the reserved number was released to nobody.
    expect(draftCore).toContain('employeeCode: employeeCodeToIssue');
    expect(draftCore).toContain(
      "const employeeCodeToIssue = reservedCode ?? (decision.mode === 'manual' ? typedCode : undefined);",
    );
    // NB: assert a phrase that is not line-wrapped in the source — a comment split across two `//`
    // lines does not contain the sentence as a contiguous string.
    expect(draftCore).toContain('The held code, NEVER blank');
    // The issue happens ONCE, inside the reservation. `issueEmployeeCode` / `issueLegacyEmployeeCode`
    // return the config id and the number as well as the string, which is what makes a discard able to
    // give the number back — see §7 of test/employee-draft-wizard.test.ts.
    expect(draftCore).toContain('issueEmployeeCode(tx, ctx.tenantId, companyId)');
    expect(draftCore).toContain('issueLegacyEmployeeCode(tx, ctx.tenantId)');
    // And the activation path excludes the draft's OWN hold, or every Activate would refuse itself.
    expect(draftCore).toContain('fromEmployeeDraftId: reservedCode ? id : undefined');
  });

  it('the four-field Create screen is a screen of its own, and it is the reserving one', () => {
    const createForm = read('app/admin/personnel/new/create-form.tsx');
    // Exactly four questions. Asserted as an ABSENCE of the six that left, because the failure mode this
    // item exists to prevent is a field creeping back onto the first screen and making it long again.
    for (const gone of ['NationalityPicker', 'IdentityNumberField', 'BirthDateFields', 'PersonDetailsFields']) {
      expect(createForm.includes(gone), gone).toBe(false);
    }
    expect(createForm).toContain('missingToCreate(');
    expect(createForm).toContain('createDraftAction(');
    // …and those six are on the continue form, not deleted.
    for (const moved of ['NationalityPicker', 'IdentityNumberField', 'BirthDateFields', 'PersonDetailsFields']) {
      expect(wizard.includes(moved), moved).toBe(true);
    }
    // The continue form has no company picker at all: the company is fixed once the ID is held.
    expect(wizard.includes('chooseCompany')).toBe(false);
  });

  it('the employee list shows drafts as ROWS with a Draft status, not as a separate panel', () => {
    // The reporter's complaint in one line: a half-finished record sat in an amber card above the table
    // with no status against it. It is a row now, with the held Employee ID and a Draft badge.
    expect(listPage.includes("t('draftsHeading')")).toBe(false);
    // 420ebab5 moved the row's MARKUP into <DraftRow> so the whole row could be made clickable and could
    // be rendered in a test (this page is an async server component). The requirement is unchanged and is
    // still asserted end to end — the listing emits the row inside its table, and the row still carries
    // the Draft badge and the held Employee ID.
    expect(listPage).toContain('<DraftRow');
    expect(read('app/admin/personnel/draft-row.tsx')).toContain('<StatusBadge status="draft"');
    expect(listPage).toContain('d.reservedEmployeeCode');
    // And Draft is an option on the status filter, so HR can pull up exactly who is outstanding.
    //
    // 579255c3 moved the literal into a NAMED constant (app/admin/personnel/list-query.ts), because the
    // same value now has three readers — the filter option, the Draft headcount card, and the export —
    // and three copies of a magic string is how one of them gets missed. Asserted at both ends rather
    // than loosened: the page must use the constant, and the constant must still be 'draft'.
    expect(listPage).toContain('value: DRAFT_BUCKET');
    expect(read('app/admin/personnel/list-query.ts')).toContain("export const DRAFT_BUCKET = 'draft'");
  });
});
