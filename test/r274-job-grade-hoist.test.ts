import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * r274 (d8fa582b) — THE JOB GRADE PICKER IS WHERE THE READER LOOKS.
 *
 * The reporter asked for the Grade Group dropdown to be "populated from the Job Grade labels under System
 * Labels instead of being hard-coded". **It already was, on a different control.**
 * `core/org-criteria-form.ts:133` builds `gradeIds` from `c.grades`, which is `activeGrades` — the live
 * `job_grade` rows with `archivedAt == null`. Every one of their acceptance criteria was already met.
 *
 * They could not find it because of us. The criteria sections render as collapsed `<details>`, and an
 * earlier round noticed this reporter "reaches for grade first" and hoisted a control above them — the
 * grade GROUP picker, the shortcut. The field that actually carries the condition stayed shut inside
 * Employment information. This round lifts the right one.
 *
 * The risk in lifting a field out of a generated loop is that it becomes a SECOND definition of it, which
 * would then drift from the builder that owns its name, label and options. Most of what follows guards
 * against that rather than against the layout.
 */

const FORM = 'components/leave/eligibility-rule-form.tsx';
const BUILDER = 'core/org-criteria-form.ts';
const read = (p: string) => readFileSync(p, 'utf8');
const form = read(FORM);
const builder = read(BUILDER);

describe('§A · the options were always live — this round did not change that', () => {
  it('the builder feeds gradeIds from the grade list it is handed, with no literal grades anywhere', () => {
    expect(builder).toContain("{ name: 'gradeIds', label: t.crit('jobGrade'), kind: 'multi', options: c.grades.map(");
    // A hard-coded grade would be the actual defect the reporter believed in. There is none, and this is
    // what stops one appearing later.
    expect(builder).not.toMatch(/options:\s*\[\s*\{\s*value:\s*'G\d/i);
  });

  it('and the caller hands it ACTIVE grades only', () => {
    const block = read('app/admin/leave/entitlements/templates/entitlement-tables-block.tsx');
    expect(block).toContain('const activeGrades = grades.filter((g) => g.archivedAt == null)');
    expect(block).toContain('grades: activeGrades');
  });
});

describe('§B · lifted, not duplicated', () => {
  it('the hoisted field is FOUND in the builder’s sections, never declared here', () => {
    expect(form).toContain("const gradeField = criteriaSections.flatMap((sec) => sec.fields).find((f) => f.name === 'gradeIds')");
    // If this file ever declares its own name/label/options for the grade picker, the builder stops being
    // the owner and the two can disagree about which grades exist.
    expect(form, 'no local field definition for gradeIds').not.toMatch(/name:\s*'gradeIds'\s*,\s*label:/);
  });

  it('ONE renderer serves the hoisted field and every field still inside a section', () => {
    expect(form).toContain('const renderMulti = (f: CriteriaField) => (');
    // Two CALL sites. The definition reads `const renderMulti = (f…` so it does not match this pattern —
    // checked rather than assumed, because an off-by-one here would let a third copy slip in unnoticed.
    expect((form.match(/renderMulti\(/g) ?? []).length, 'called exactly twice').toBe(2);
    expect((form.match(/const renderMulti = /g) ?? []).length, 'defined exactly once').toBe(1);
    expect(form).toContain('{renderMulti(gradeField)}');
    expect(form).toContain('renderMulti(f)');
  });

  it('and it is drawn ONCE — filtered out of the loop it was lifted from', () => {
    // Without the filter the picker renders twice, both posting `gradeIds`, and the form posts every
    // selection twice over.
    expect(form).toContain("section.fields.filter((f) => f.name !== 'gradeIds').map((f) =>");
  });
});

describe('§C · above the collapsed sections, beside the shortcut', () => {
  it('Job Grade is rendered BEFORE the details loop, which is the whole point', () => {
    const hoisted = form.indexOf('{renderMulti(gradeField)}');
    const loop = form.indexOf('{criteriaSections.map((section) => (');
    expect(hoisted, 'the hoisted render exists').toBeGreaterThan(-1);
    expect(loop, 'the section loop exists').toBeGreaterThan(-1);
    expect(hoisted, 'Job Grade is above the collapsed sections').toBeLessThan(loop);
  });

  it('it renders even when the tenant has NO grade groups', () => {
    // The group picker is hidden without groups (an empty shortcut teaches nobody anything). The field
    // that carries the condition must not be hidden with it.
    const hoisted = form.indexOf('{renderMulti(gradeField)}');
    const groupGate = form.indexOf('{gradeGroups.length > 0 ? (');
    expect(groupGate).toBeGreaterThan(-1);
    expect(hoisted, 'Job Grade is outside the grade-group gate').toBeLessThan(groupGate);
    expect(form).toContain('{gradeField ? (');
  });

  it('the hint says where the list comes from, in all six catalogues', () => {
    const en = JSON.parse(read('messages/en.json'));
    const v = en.admin.entitlementTemplates.ruleJobGradeHint as string;
    expect(typeof v).toBe('string');
    expect(v, 'it names System Labels').toMatch(/System Labels/i);
    for (const loc of ['ms', 'zh', 'ta', 'th', 'vi']) {
      const t = JSON.parse(read(`messages/${loc}.json`)).admin.entitlementTemplates.ruleJobGradeHint;
      expect(typeof t, loc).toBe('string');
      expect(t, `${loc} is still English`).not.toBe(v);
    }
  });
});
