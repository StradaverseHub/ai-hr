/**
 * 9a65f808 — GRADE GROUP AS AN EMPLOYEE-ELIGIBILITY CRITERION.
 *
 * The reporter's ask: Employee Eligibility offered job grades one at a time, so expressing
 * "GRADE 12-18 (CONTRACT)" meant finding and ticking seven separate grades, and getting one wrong meant the
 * rule quietly covered the wrong people. The Grade Groups they already think in were offered nowhere on
 * that screen.
 *
 * WHAT WAS BUILT, and therefore what these cases are protecting:
 *   1. A Grade Group picker on the eligibility rule form that EXPANDS to the group's member grades. The
 *      stored axis is still `gradeIds`; no `gradeGroupIds` axis exists. Blocks A and B.
 *   2. The shared criteria builder is UNTOUCHED, so Leave Adjustments and Generate Entitlement — which
 *      render the same builder — gain no control and change no shape. Block B.
 *   3. Expansion snapshots the membership, so a rule can silently fall behind a group that gained a grade.
 *      The drift is DERIVED and shown rather than left to be discovered. Blocks A and D.
 *   4. The payoff the reporter can see: a rule whose grades are whole groups is ASSIGNABLE to an approval
 *      template, where a hand-picked part of a group is refused. Block D drives the real service.
 *
 * ⚠️ BLOCK B IS A SOURCE-SHAPE BLOCK, ON PURPOSE. The defect it guards lives in the CONTRACT BETWEEN two
 * files — a picker whose `name` is not a resolver axis renders, posts and narrows NOBODY, and a unit test
 * of either half passes throughout. Reading both sources is the only way to see it.
 */
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { ORG_CRITERIA_FIELDS, ORG_CRITERIA_RANGE_FIELDS } from '../core/org-criteria';
import { buildOrgCriteriaSections } from '../core/org-criteria-form';
import { createGradeGroup } from '../core/benefit-scheme';
import { createEligibilityRule, createEntitlementTemplate } from '../core/entitlement-template';
import { listEligibilityRuleScopes } from '../core/leave-approval-template';
import {
  applyGradeGroupSelection,
  memberGradeIds,
  partiallyCoveredGradeGroups,
  wholeGradeGroupIds,
  type GradeGroupOption,
} from '../lib/grade-group-coverage';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const FORM = path.join(ROOT, 'components/leave/eligibility-rule-form.tsx');
const BLOCK = path.join(ROOT, 'app/admin/leave/entitlements/templates/entitlement-tables-block.tsx');
const formSrc = fs.readFileSync(FORM, 'utf8');
const blockSrc = fs.readFileSync(BLOCK, 'utf8');

/** The reporter's own vocabulary, in the shape production holds it: seven, seven, five, and a singleton. */
const GROUPS: GradeGroupOption[] = [
  { id: 'contract-12-18', name: 'GRADE 12-18 (CONTRACT)', gradeIds: ['g12', 'g13', 'g14'] },
  { id: 'contract-19-up', name: 'GRADE >= 19 (CONTRACT)', gradeIds: ['g19', 'g20'] },
  { id: 'part-time', name: 'Part Time', gradeIds: ['gpt'] },
  // A group with no members at all is legal data and is the trap in every "covers it" predicate: `every`
  // is vacuously true on an empty list, so an unguarded check reports it as covered by EVERY rule.
  { id: 'empty', name: 'Newly created, no members yet', gradeIds: [] },
];

describe('9a65f808 · A. the expansion arithmetic (lib/grade-group-coverage.ts)', () => {
  it('a group expands to exactly its members, and several groups union without duplicates', () => {
    expect(memberGradeIds(['contract-12-18'], GROUPS)).toEqual(['g12', 'g13', 'g14']);
    expect(memberGradeIds(['contract-12-18', 'part-time'], GROUPS)).toEqual(['g12', 'g13', 'g14', 'gpt']);
    expect(memberGradeIds([], GROUPS)).toEqual([]);
    // An id naming no group contributes nothing rather than throwing — a saved selection may outlive a group.
    expect(memberGradeIds(['gone'], GROUPS)).toEqual([]);
  });

  it('a group is TICKED only when the rule names every one of its grades', () => {
    // This is what lets a saved rule re-open with its groups showing WITHOUT storing them.
    expect(wholeGradeGroupIds(['g12', 'g13', 'g14'], GROUPS)).toEqual(['contract-12-18']);
    expect(wholeGradeGroupIds(['g12', 'g13'], GROUPS)).toEqual([]);
    expect(wholeGradeGroupIds(['g12', 'g13', 'g14', 'gpt'], GROUPS)).toEqual(['contract-12-18', 'part-time']);
    // Extra grades outside every group do not stop a group being covered.
    expect(wholeGradeGroupIds(['g12', 'g13', 'g14', 'loose'], GROUPS)).toEqual(['contract-12-18']);
  });

  it('the EMPTY group is never reported as covered — `every` on nothing is true', () => {
    // Without the length guard this group would be ticked on every rule in the tenant, including a rule
    // that narrows by no grade at all, and unticking it would then be a no-op nobody could explain.
    expect(wholeGradeGroupIds([], GROUPS)).toEqual([]);
    expect(wholeGradeGroupIds(['g12', 'g13', 'g14'], GROUPS)).not.toContain('empty');
    expect(partiallyCoveredGradeGroups(['g12'], GROUPS).map((g) => g.id)).not.toContain('empty');
  });

  it('partial coverage is "some in, some out" — not "not all in"', () => {
    // A rule naming no grade of a group is not DRIFTING from it, it simply does not use it. Reporting that
    // as partial would put a warning on every rule for every group the tenant has.
    expect(partiallyCoveredGradeGroups(['g12', 'g13'], GROUPS).map((g) => g.name)).toEqual([
      'GRADE 12-18 (CONTRACT)',
    ]);
    expect(partiallyCoveredGradeGroups(['g12', 'g13', 'g14'], GROUPS)).toEqual([]);
    expect(partiallyCoveredGradeGroups(['g19', 'g20'], GROUPS)).toEqual([]);
    expect(partiallyCoveredGradeGroups([], GROUPS)).toEqual([]);
  });

  it('THE SNAPSHOT, stated as a case: a grade joining a group later shows up as drift', () => {
    // The saved rule is unchanged and still resolves; what changed is the group underneath it. Deriving
    // the drift from the stored grades is what makes it visible without storing the group.
    const saved = ['g12', 'g13', 'g14'];
    const afterAnEighthGradeJoined: GradeGroupOption[] = [
      { id: 'contract-12-18', name: 'GRADE 12-18 (CONTRACT)', gradeIds: ['g12', 'g13', 'g14', 'g15'] },
    ];
    expect(wholeGradeGroupIds(saved, afterAnEighthGradeJoined)).toEqual([]);
    expect(partiallyCoveredGradeGroups(saved, afterAnEighthGradeJoined).map((g) => g.name)).toEqual([
      'GRADE 12-18 (CONTRACT)',
    ]);
  });

  describe('applying a change of group selection', () => {
    it('ticking a group ADDS its grades and keeps hand-picked ones', () => {
      expect(
        applyGradeGroupSelection({
          gradeIds: ['loose'],
          previousGroupIds: [],
          nextGroupIds: ['contract-12-18'],
          groups: GROUPS,
        }),
      ).toEqual(['loose', 'g12', 'g13', 'g14']);
    });

    it('unticking a group takes back ONLY its grades — the hand-picked ones survive', () => {
      // "Keep picking individual grades available for the cases where a group is not the right shape" is
      // in the approved plan, and a group control that wiped a hand-built selection would make it a lie.
      expect(
        applyGradeGroupSelection({
          gradeIds: ['loose', 'g12', 'g13', 'g14'],
          previousGroupIds: ['contract-12-18'],
          nextGroupIds: [],
          groups: GROUPS,
        }),
      ).toEqual(['loose']);
    });

    it('tick then untick returns the selection to exactly what it was', () => {
      const before = ['loose', 'g19', 'g20'];
      const after = applyGradeGroupSelection({
        gradeIds: before,
        previousGroupIds: ['contract-19-up'],
        nextGroupIds: ['contract-19-up', 'part-time'],
        groups: GROUPS,
      });
      expect(after).toEqual(['loose', 'g19', 'g20', 'gpt']);
      expect(
        applyGradeGroupSelection({
          gradeIds: after,
          previousGroupIds: ['contract-19-up', 'part-time'],
          nextGroupIds: ['contract-19-up'],
          groups: GROUPS,
        }),
      ).toEqual(before);
    });

    it('a grade two groups both hold survives while EITHER of them is ticked', () => {
      // Production keys one grade to one group, but nothing in the schema enforces it, and the failure
      // mode of assuming otherwise is a grade silently disappearing from a rule the operator did not edit.
      const overlapping: GradeGroupOption[] = [
        { id: 'a', name: 'A', gradeIds: ['x', 'y'] },
        { id: 'b', name: 'B', gradeIds: ['y', 'z'] },
      ];
      expect(
        applyGradeGroupSelection({
          gradeIds: ['x', 'y', 'z'],
          previousGroupIds: ['a', 'b'],
          nextGroupIds: ['b'],
          groups: overlapping,
        }),
      ).toEqual(['y', 'z']);
    });
  });
});

describe('9a65f808 · B. the storage decision, pinned across both files that depend on it', () => {
  it('there is NO gradeGroupIds criteria axis — the stored axis is gradeIds, as it always was', () => {
    // Adding an axis means teaching the resolver, the specificity ranking, the approval-template
    // translator and every criteria form at once. Expansion was chosen instead, and this is that choice
    // written down where a future "just add the field" fails.
    expect([...ORG_CRITERIA_FIELDS, ...ORG_CRITERIA_RANGE_FIELDS]).not.toContain('gradeGroupIds');
    expect(ORG_CRITERIA_FIELDS).toContain('gradeIds');
  });

  it('the SHARED criteria builder is untouched, so the other two screens gain nothing', () => {
    // buildOrgCriteriaSections feeds Leave Adjustments and Generate Entitlement as well. A grade-group
    // field added THERE would appear on both — where nothing expands it, so it would post a name no
    // resolver knows and narrow nobody, silently. That is why the control lives at this call site.
    const sections = buildOrgCriteriaSections(
      {
        companies: [], departments: [], grades: [{ id: 'g1', name: 'Grade 1' }], positions: [],
        costCenters: [], businessUnits: [], locations: [], profileOptions: {},
      },
      { crit: (k) => k, org: (k) => k, employmentType: (k) => k },
    );
    const names = sections.flatMap((s) => s.fields.map((f) => f.name));
    expect(names).toContain('gradeIds');
    expect(names).not.toContain('gradeGroupIds');
  });

  it('the picker lives OUTSIDE the section loop, so a builder change cannot make it vanish', () => {
    // Rendering it beside the Job Grade field inside the loop would key its existence on a field name the
    // builder owns. The control would then disappear with no error the day that name changed — the same
    // class of silent absence the axis-name contract above exists to prevent.
    const groupPickerAt = formSrc.indexOf('name="gradeGroupIds"');
    const sectionLoopAt = formSrc.indexOf('criteriaSections.map(');
    expect(groupPickerAt, 'the Grade Group picker must exist').toBeGreaterThan(-1);
    expect(sectionLoopAt, 'the section loop must exist').toBeGreaterThan(-1);
    expect(groupPickerAt, 'the Grade Group picker must render before the sections').toBeLessThan(sectionLoopAt);
  });

  it('the form takes grade groups as a REQUIRED prop, and the block supplies them', () => {
    // Optional-with-a-default would let a second mount forget the control and render a screen missing the
    // thing the item shipped, with nothing failing. It is required, so tsc is the guard at every mount.
    expect(formSrc).toMatch(/\n\s*gradeGroups: GradeGroupOption\[\];/);
    expect(blockSrc).toContain('gradeGroups={gradeGroups}');
    // …read through the leave pack FACADE (test/leave-pack-drift.test.ts), like every other service here.
    expect(blockSrc).toMatch(/^\s*listGradeGroups,$/m);
    expect(blockSrc).toContain("from '@/packs/leave/service'");
  });

  it('a group member the ACTIVE catalogue dropped is nameable, without becoming newly offered', () => {
    // Both halves of one read, and taking either without the other is a defect:
    //   - includeArchived is what makes an archived group member NAMEABLE. Archiving a grade leaves it in
    //     every group that holds it, and the form has to keep offering the id or the group's expansion
    //     silently loses it — so the id is on screen either way, and without a name it was a bare UUID.
    //   - `activeGrades` is what stops it becoming OFFERED: the shared builder feeds Leave Adjustments and
    //     Generate Entitlement too, and an archived grade in its catalogue would appear on all three.
    expect(blockSrc).toContain('listJobGrades(s, { includeArchived: true })');
    expect(blockSrc).toMatch(/grades: activeGrades/);
    expect(blockSrc).toMatch(/archivedAt == null/);
    expect(blockSrc).toContain('archivedMemberGrades');
    expect(formSrc).toContain("t('ruleGradeArchived'");
  });

  it('the rules TABLE lists the drift, not just the form', () => {
    // "Add a check that lists rules whose stored grades no longer equal their group" — the approved plan's
    // words. A warning only on the edit form is a warning nobody meets until they were already editing.
    expect(blockSrc).toContain('partiallyCoveredGradeGroups(');
    expect(blockSrc).toContain("t('ruleGradeGroupPartial'");
  });
});

describe('9a65f808 · C. the five new strings exist in all six locales', () => {
  it('every admin.entitlementTemplates key the Grade Group control reads resolves everywhere', () => {
    // A screen reading a namespace that never got its keys renders MISSING_MESSAGE on every line and
    // still returns 200. The form reads ONE namespace, which is why these belong in it.
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const) {
      const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
      const ns = dict?.admin?.entitlementTemplates ?? {};
      for (const key of [
        'ruleGradeGroup',
        'ruleGradeGroupApplied',
        'ruleGradeGroupNote',
        'ruleGradeGroupPartial',
        // The label for a group member the active grade catalogue no longer offers. Missing it does not
        // blank a line — it puts a raw UUID on a picker, which is the defect it was added to close.
        'ruleGradeArchived',
      ]) {
        expect(typeof ns[key], `messages/${loc}.json → admin.entitlementTemplates.${key}`).toBe('string');
      }
      // The placeholders the call sites pass, present in every locale's copy — a translation that dropped
      // one formats to a sentence missing the group's name, which is the sentence's whole content.
      expect(ns.ruleGradeGroupApplied, `[${loc}] ruleGradeGroupApplied {count}`).toContain('{count}');
      expect(ns.ruleGradeGroupPartial, `[${loc}] ruleGradeGroupPartial {groups}`).toContain('{groups}');
      // …and this one degrades WORSE than a blank: drop {name} and the option reads "(archived)" with no
      // grade in it, which is less use than the id it replaced.
      expect(ns.ruleGradeArchived, `[${loc}] ruleGradeArchived {name}`).toContain('{name}');
    }
  });
});

describe('9a65f808 · D. the payoff: a rule built from whole groups is ASSIGNABLE', () => {
  let b: Base;
  const ctx = () => adminCtx(b);

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  /** Three grades, two of them a group; returns the ids the cases narrow by. */
  async function seedGrades() {
    const rows = await owner.db
      .insert(schema.jobGrade)
      .values([
        { tenantId: b.tenantId, code: 'G12', name: 'Grade 12', rank: 1 },
        { tenantId: b.tenantId, code: 'G13', name: 'Grade 13', rank: 2 },
        { tenantId: b.tenantId, code: 'G19', name: 'Grade 19', rank: 3 },
      ])
      .returning({ id: schema.jobGrade.id, code: schema.jobGrade.code });
    const by = new Map(rows.map((r) => [r.code, r.id]));
    return { g12: by.get('G12')!, g13: by.get('G13')!, g19: by.get('G19')! };
  }

  async function seedTemplate() {
    const tpl = await createEntitlementTemplate(ctx(), {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Standard annual',
      serviceBands: [{ fromYears: 0, toYears: null, days: 14 }],
      validFrom: '2026-01-01',
    });
    return tpl.lineageId;
  }

  it('a rule whose gradeIds ARE a whole group is accepted, and scopes to that group', async () => {
    // This is the reporter's headline: "the rules you build that way can be assigned to approval templates
    // without being refused". The picker produces exactly this criteria object, so the service is driven
    // with what the picker would have written rather than with a hand-shaped fixture.
    const { g12, g13 } = await seedGrades();
    const group = await createGradeGroup(ctx(), { name: 'GRADE 12-18 (CONTRACT)', gradeIds: [g12, g13] });
    const templateLineageId = await seedTemplate();
    const expanded = memberGradeIds([group.id], [{ id: group.id, name: 'GRADE 12-18 (CONTRACT)', gradeIds: [g12, g13] }]);

    await createEligibilityRule(ctx(), {
      name: 'Contract 12-18',
      templateLineageId,
      criteria: { gradeIds: expanded },
      validFrom: '2026-01-01',
    });

    const [scope] = await listEligibilityRuleScopes(ctx());
    expect(scope.refusal, `refused: ${scope.refusal}`).toBeNull();
    expect(scope.scopes.map((s) => s.gradeGroupId)).toEqual([group.id]);
  });

  it('…and HALF a group is refused, in the words the approval screen shows', async () => {
    // The other half of the same mechanism, and the reason the form's drift warning exists: this refusal
    // is what an operator meets as a greyed-out row with a badge on the Approval Template screen.
    const { g12, g13 } = await seedGrades();
    await createGradeGroup(ctx(), { name: 'GRADE 12-18 (CONTRACT)', gradeIds: [g12, g13] });
    const templateLineageId = await seedTemplate();

    await createEligibilityRule(ctx(), {
      name: 'Only grade 12',
      templateLineageId,
      criteria: { gradeIds: [g12] },
      validFrom: '2026-01-01',
    });

    const [scope] = await listEligibilityRuleScopes(ctx());
    expect(scope.refusal).toMatch(/covers only part of grade group/i);
    expect(scope.refusal).toContain('GRADE 12-18 (CONTRACT)');
    // A refused rule keeps an EMPTY scope list: there is no half-assignment to fall back to.
    expect(scope.scopes).toEqual([]);
  });

  it('the drift the helper derives and the refusal the service raises name the SAME rule', async () => {
    // Two surfaces, one fact. If these ever disagreed, the eligibility screen would be reassuring an
    // operator about a rule the approval screen was about to refuse — which is the state the reporter
    // was already in when they raised this.
    const { g12, g13, g19 } = await seedGrades();
    const group = await createGradeGroup(ctx(), { name: 'GRADE 12-18 (CONTRACT)', gradeIds: [g12, g13] });
    const solo = await createGradeGroup(ctx(), { name: 'GRADE >= 19 (CONTRACT)', gradeIds: [g19] });
    const templateLineageId = await seedTemplate();
    const groups: GradeGroupOption[] = [
      { id: group.id, name: 'GRADE 12-18 (CONTRACT)', gradeIds: [g12, g13] },
      { id: solo.id, name: 'GRADE >= 19 (CONTRACT)', gradeIds: [g19] },
    ];

    await createEligibilityRule(ctx(), {
      name: 'Drifted',
      templateLineageId,
      criteria: { gradeIds: [g12, g19] },
      validFrom: '2026-01-01',
    });

    expect(partiallyCoveredGradeGroups([g12, g19], groups).map((g) => g.name)).toEqual([
      'GRADE 12-18 (CONTRACT)',
    ]);
    const [scope] = await listEligibilityRuleScopes(ctx());
    expect(scope.refusal).toContain('GRADE 12-18 (CONTRACT)');
    expect(scope.refusal).not.toContain('GRADE >= 19 (CONTRACT)');
  });

  it('a rule narrowing by NO grade is assignable and unaffected — the item adds nothing to it', async () => {
    // Stated positively: "nothing already saved changes" is a promise in the approved plan, and the axis
    // this item touches is the one axis it must leave alone when it is not used.
    const templateLineageId = await seedTemplate();
    await createEligibilityRule(ctx(), {
      name: 'Everyone in Acme',
      templateLineageId,
      criteria: { companyIds: [b.companyId] },
      validFrom: '2026-01-01',
    });

    const [scope] = await listEligibilityRuleScopes(ctx());
    expect(scope.refusal).toBeNull();
    // A null grade group is the wildcard "any grade", which is what naming no grade means.
    expect(scope.scopes).toEqual([{ gradeGroupId: null, employmentType: null }]);
  });

  it('deleting a grade group a rule was BUILT from leaves the rule alone — expansion is why', async () => {
    // The trade-off's good side, and worth pinning because it is the reason expansion is safe: the rule
    // stores grades, so the group is not a foreign key it can be orphaned by. (The delete guard only
    // covers approval rules — an eligibility rule has never referenced a group and still does not.)
    const { g12, g13 } = await seedGrades();
    const group = await createGradeGroup(ctx(), { name: 'Temporary band', gradeIds: [g12, g13] });
    const templateLineageId = await seedTemplate();
    await createEligibilityRule(ctx(), {
      name: 'Built from a group',
      templateLineageId,
      criteria: { gradeIds: [g12, g13] },
      validFrom: '2026-01-01',
    });

    await owner.db.delete(schema.gradeGroupMember).where(eq(schema.gradeGroupMember.gradeGroupId, group.id));
    await owner.db.delete(schema.gradeGroup).where(eq(schema.gradeGroup.id, group.id));

    const rows = await owner.db.select().from(schema.entitlementEligibilityRule);
    expect(rows).toHaveLength(1);
    expect((rows[0].criteria as { gradeIds?: string[] }).gradeIds?.slice().sort()).toEqual(
      [g12, g13].slice().sort(),
    );
  });
});
