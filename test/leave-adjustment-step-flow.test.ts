/**
 * 18103ba4 — the Leave Adjustments step flow's STRUCTURAL contracts.
 *
 * The rendered behaviour (step switching, the persisted key's remap, every step staying mounted) is pinned
 * by test/leave-adjustment-step-flow.dom.test.tsx, which renders the real component. This file pins the
 * three things a render cannot see:
 *
 *  A. THE FIELD-NAME CONTRACT. Every criteria control on the page posts under a name, and the resolver only
 *     understands the names in ORG_CRITERIA_FIELDS / ORG_CRITERIA_RANGE_FIELDS. A typo there does not throw,
 *     does not fail to compile and does not look wrong on screen — the picker renders, the operator picks
 *     three departments, and the adjustment goes to everybody. That is the single most expensive failure
 *     this screen can have, and it is silent in every other kind of test.
 *
 *  B. THE THREE ABSENT FIELDS STAY ABSENT. Job Title, Employee Group and Employee Class are not held
 *     anywhere in the schema. The plan says so and refuses to invent columns for them inside a UI item; a
 *     later well-meaning edit that adds a picker for one would produce a control that matches nobody.
 *
 *  C. THE REUSE CONTRACT. components/leave-sub-step-bar.tsx exists so secondary flows share one nested step
 *     bar rather than each growing their own. This screen is the same shape and must use it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ORG_CRITERIA_FIELDS, ORG_CRITERIA_RANGE_FIELDS } from '../core/org-criteria';
import { buildOrgCriteriaSections } from '../core/org-criteria-form';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, '..', p), 'utf8');
/**
 * 93249794 REPOINTED THIS FROM THE PAGE TO THE SHARED BUILDER, and it is the same assertion about the same
 * names. The four criteria sections moved verbatim out of `app/admin/leave/adjustments/page.tsx` into
 * `core/org-criteria-form.ts` so the Generate Entitlement screen consumes ONE list rather than a copy of
 * it — the duplicate-maintenance defect 6e9a126e exists to remove, reproduced one layer above the
 * resolver. Following the source is the point: this file guards that every criteria control posts a name
 * the resolver understands, and that is now true of BOTH screens at once instead of one of them.
 */
const pageSrc = read('core/org-criteria-form.ts');
const formSrc = read('components/leave/adjustment-form.tsx');
const actionsSrc = read('app/admin/leave/adjustments/actions.ts');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** Every criteria field name the page emits: the literal `name: '…'` entries plus the `org('…')` helper. */
function pageCriteriaNames(): string[] {
  const names = [...pageSrc.matchAll(/\bname: '([A-Za-z_]+)'/g)].map((m) => m[1]);
  const orgs = [...pageSrc.matchAll(/\borg\('([A-Za-z_]+)'\)/g)].map((m) => m[1]);
  return [...new Set([...names, ...orgs])];
}

describe('18103ba4 · A. every criteria control posts a name the resolver understands', () => {
  it('the page emits only known criteria field names', () => {
    const known = new Set([...ORG_CRITERIA_FIELDS, ...ORG_CRITERIA_RANGE_FIELDS]);
    const emitted = pageCriteriaNames();
    expect(emitted.length).toBeGreaterThan(15); // the eleven axes that shipped in 491c499f, plus this item's
    const unknown = emitted.filter((n) => !known.has(n));
    expect(unknown, `criteria fields the resolver does not read: ${unknown.join(', ')}`).toEqual([]);
  });

  it('the twelve schema-backed axes the plan promised are all offered, less the one ADR-0086 retired', () => {
    // Named individually rather than counted, because "we added twelve" is not checkable and "business
    // unit is missing" is. Job grade / position / cost centre / business unit are real columns;
    // gender / nationality / religion / race live on person; employment status and the hire-date band are
    // derived and stored respectively.
    //
    // ⚠️ UPDATED, NOT DELETED (CLAUDE.md §8). `locationIds` was the fifth real column on this list.
    // ADR-0086 (item 0fe1ca2e, r331) retired the work-site axis with the work-site register — measured
    // unused cross-tenant on production first (0 of 10 entitlement rules, 0 of 1 notice, 0 of 20
    // generation runs). It is asserted ABSENT below rather than quietly dropped from the list, so the
    // promise 18103ba4 made is still readable and its one withdrawal is explicit.
    const emitted = new Set(pageCriteriaNames());
    expect(emitted.has('locationIds'), 'ADR-0086: the Work Site axis is retired, not merely unlisted').toBe(false);
    for (const name of [
      'businessUnitIds',
      'gradeIds',
      'positionIds',
      'costCenterIds',
      'genders',
      'nationalities',
      'religions',
      'races',
      'hiredFrom',
      'hiredTo',
      'employmentStatuses',
      // Derived, and the two the plan said had to be DEFINED rather than read from a field.
      'minYearsOfService',
      'maxYearsOfService',
      'confirmationStatuses',
    ]) {
      expect(emitted.has(name), `${name} offered on the criteria builder`).toBe(true);
    }
  });

  it('the eleven axes that already shipped are still offered — nothing was dropped in the redesign', () => {
    const emitted = new Set(pageCriteriaNames());
    for (const name of [
      'companyIds',
      'departmentIds',
      'employmentTypes',
      'orgDivision',
      'orgBranch',
      'orgRegion',
      'orgLine',
      'orgSection',
      'orgTeam',
      'orgBase',
      'employmentCategory',
    ]) {
      expect(emitted.has(name), `${name} still offered`).toBe(true);
    }
  });

  it('the four groups the reporter asked for are the sections', () => {
    for (const key of ['sectionCompany', 'sectionEmployment', 'sectionEmployee', 'sectionService']) {
      expect(pageSrc).toContain(`t.crit('${key}')`);
    }
  });
});

describe('18103ba4 · B. the three fields the schema does not hold stay out', () => {
  it('no picker is offered for Job Title, Employee Group or Employee Class', () => {
    const emitted = pageCriteriaNames().map((n) => n.toLowerCase());
    for (const forbidden of ['jobtitle', 'jobtitles', 'employeegroup', 'employeegroups', 'employeeclass', 'employeeclasses']) {
      expect(emitted, `${forbidden} must NOT be a criteria field`).not.toContain(forbidden);
    }
    // …and the resolver has no vocabulary for them either, so a picker could not be wired up by accident.
    const known = [...ORG_CRITERIA_FIELDS, ...ORG_CRITERIA_RANGE_FIELDS].map((f) => f.toLowerCase());
    for (const forbidden of ['jobtitle', 'employeegroup', 'employeeclass']) {
      expect(known.some((k) => k.includes(forbidden))).toBe(false);
    }
  });

  it('the screen SAYS they are unavailable rather than silently omitting them', () => {
    // The reporter listed all three. Leaving them off with no explanation sends someone hunting for a
    // field that was promised; the note names them and says what would have to happen first.
    expect(pageSrc).toContain("t.crit('absentNote')");
    const en = JSON.parse(read('messages/en.json')) as Record<string, never>;
    const note = (en as never as { admin: { leave: { adjustmentsCriteria: { absentNote: string } } } }).admin.leave
      .adjustmentsCriteria.absentNote;
    for (const word of ['Job Title', 'Employee Group', 'Employee Class']) expect(note).toContain(word);
  });
});

describe('18103ba4 · C. the step bar is REUSED, not reinvented', () => {
  it('renders the shared SubStepBar', () => {
    expect(formSrc).toMatch(/import \{ SubStepBar \} from '@\/components\/leave-sub-step-bar'/);
    expect(formSrc).toContain('<SubStepBar');
    expect(formSrc).toContain("const STEP_KEYS = ['types', 'employees', 'details', 'review'] as const");
  });

  it('the persisted key has a remap table, and it is not empty', () => {
    // An unmapped stored key is invisible — per-browser state no render on a server can see. The mechanism
    // has to be present BEFORE a step is ever retired, and 'review' is already a real entry (see the DOM
    // test, which proves where a browser holding it actually lands).
    expect(formSrc).toContain('const STEP_REMAP: Record<string, StepKey> = { review:');
    expect(formSrc).toContain("const STORAGE_KEY = 'leaveAdjustmentFlow'");
  });
});

describe('18103ba4 · the Add / Deduct split recomposes into the signed days the core has always taken', () => {
  it('the action takes the magnitude and applies the direction', () => {
    // The UI changed; the ledger, the batch row, the reversal and test/leave-adjustment-batch.test.ts all
    // still speak signed days. The recomposition therefore lives at the boundary, not in the core.
    expect(actionsSrc).toContain("fd.get('adjustmentType') === 'deduct' ? -amount : amount");
    expect(actionsSrc).toContain("Math.abs(Number(String(fd.get('days') ?? '')))");
    expect(formSrc).toContain('name="adjustmentType"');
  });

  it('the action reads criteria through the SHARED reader, not a hand-rolled copy', () => {
    // The hand-rolled reader that used to live here listed the field names itself, so every axis added to
    // core/org-criteria.ts had to be remembered twice — and the forgotten one narrows nobody, silently.
    expect(actionsSrc).toContain('orgCriteriaFromFields');
    expect(actionsSrc.includes('ORG_ASSIGNMENT_CRITERIA')).toBe(false);
  });
});

describe('18103ba4 · the new copy exists in all six catalogues', () => {
  it('every key the flow adds is translated everywhere', () => {
    // i18n-coverage check A guards this globally; naming the keys here makes a half-translated flow fail
    // with the flow's name on it rather than as one line in a list of two hundred.
    const flatKeys = [
      'adjustmentsStepReview',
      'adjustmentsFlowAria',
      'adjustmentsAdjustmentType',
      'adjustmentsTypeAdd',
      'adjustmentsTypeDeduct',
      'adjustmentsSelectionMethod',
      'adjustmentsMatched',
      'adjustmentsMatchedCount',
      'adjustmentsMatchedPending',
      'adjustmentsNext',
      'adjustmentsBack',
      'adjustmentsSearchPlaceholder',
      'adjustmentsSelectAll',
      'adjustmentsDeselectAll',
      'adjustmentsReviewRecords',
      'adjustmentsReviewNothing',
      'adjustmentsIssuesTitle',
      'adjustmentsIssuesNone',
      'adjustmentsIssueNotFound',
      'adjustmentsIssueInactive',
      'adjustmentsIssueNotEligible',
      'adjustmentsIssueFrozen',
      'adjustmentsRemarksNote',
    ];
    const critKeys = [
      'sectionCompany',
      'sectionEmployment',
      'sectionEmployee',
      'sectionService',
      'confirmationStatus',
      'confirmed',
      'onProbation',
      'hiredFrom',
      'hiredTo',
      'minYears',
      'maxYears',
      'asAtNote',
      'absentNote',
      'employeeStatus',
      'status_probation',
      'status_active',
      'status_active_serving_notice',
      'status_resigned',
      'status_blacklisted',
      'status_withhold',
    ];
    const missing: string[] = [];
    for (const loc of LOCALES) {
      const dict = JSON.parse(read(`messages/${loc}.json`)) as {
        admin: { leave: Record<string, unknown> & { adjustmentsCriteria: Record<string, unknown> } };
      };
      for (const k of flatKeys) if (!dict.admin.leave[k]) missing.push(`${loc}.admin.leave.${k}`);
      for (const k of critKeys) if (!dict.admin.leave.adjustmentsCriteria[k]) missing.push(`${loc}…adjustmentsCriteria.${k}`);
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });
});

/**
 * 18103ba4 (r155) · D. WHICH GROUP EACH AXIS SITS IN.
 *
 * Employment Category was being offered under "Employee Information", beside gender / nationality /
 * religion / race. Those four are facts about the PERSON; employment category is a fact about the
 * EMPLOYMENT, and it reads from `employment.employment_category` exactly like job grade, position and cost
 * centre one group up. The reporter found the grouping misleading and they were right.
 *
 * ASSERTED AGAINST THE BUILT SECTIONS, not the source text, because the thing that matters is what an
 * operator sees under each heading — and because the same call feeds BOTH the Leave Adjustments screen and
 * the Generate Entitlement screen (93249794 made `buildOrgCriteriaSections` the one list). A source-string
 * check would pass on a field that had been moved into a group that is never rendered.
 *
 * THE FIELD WAS NOT DELETED, and that is the load-bearing half of this block. The reporter's words were
 * "remove all fields contained within it"; employmentCategory is a live narrowing axis the leave
 * eligibility engine reads (test/leave-org-criteria.test.ts drives it), so removing the control would
 * silently WIDEN every adjustment and every generation that uses it — an axis that is not offered narrows
 * nobody, and nothing throws. The approved plan discloses that and offers a reject path instead.
 */
describe('18103ba4 (r155) · D. the criteria groups say what they hold', () => {
  /** The builder needs catalogues + three translators; key-echoing translators keep the labels assertable. */
  const sections = () =>
    buildOrgCriteriaSections(
      {
        companies: [], departments: [], grades: [], positions: [],
        costCenters: [], businessUnits: [], profileOptions: {},
      },
      { crit: (k) => k, org: (k) => k, employmentType: (k) => k },
    );
  const fieldNames = (key: string) => sections().find((s) => s.key === key)!.fields.map((f) => f.name);

  it('employmentCategory is offered under Employment Information, last, after cost centre', () => {
    const employment = fieldNames('employment');
    expect(employment).toContain('employmentCategory');
    expect(employment[employment.length - 1]).toBe('employmentCategory');
    expect(employment[employment.length - 2]).toBe('costCenterIds');
  });

  it('Employee Information is the person-level demographics only, and gender leads it', () => {
    expect(fieldNames('employee')).toEqual(['genders', 'nationalities', 'religions', 'races']);
  });

  it('the move is a REGROUPING: the same set of axes is still offered, none added, none dropped', () => {
    // Every axis the four groups offer, flattened. If a move ever loses a field, this is what catches it —
    // the per-group assertions above would happily pass on three groups and a hole.
    const all = sections().flatMap((s) => s.fields.map((f) => f.name));
    expect(new Set(all).size, 'no axis is offered twice').toBe(all.length);
    expect(all).toContain('employmentCategory');
    for (const name of ['genders', 'nationalities', 'religions', 'races', 'costCenterIds', 'gradeIds']) {
      expect(all, `${name} still offered`).toContain(name);
    }
    // The posted names are the contract; a regrouping that changed one would re-target every saved rule.
    const known = new Set([...ORG_CRITERIA_FIELDS, ...ORG_CRITERIA_RANGE_FIELDS]);
    expect(all.filter((n) => !known.has(n))).toEqual([]);
  });

  it('the "these three do not exist as data" note stays on Employee Information', () => {
    // The note names Job Title / Employee Group / Employee Class. It hangs off the group the reporter asked
    // for them in, and a field move through that group is exactly when a note gets dropped by accident.
    const employee = sections().find((s) => s.key === 'employee')!;
    expect(employee.note).toBe('absentNote');
  });
});
