/**
 * r212 (8ebf77ae) — THE TWO ELIGIBILITY LAYERS STAY SEPARATE, AND THE INHERITED ONE IS SHOWN, NOT RETYPED.
 *
 * The reporter asked why eligibility must be configured twice. It is not the same decision twice — the
 * leave type's own conditions answer MAY THIS EMPLOYEE TAKE IT (a yes/no that gates the offer and the
 * application) and the entitlement rule answers WHICH DAY TABLE APPLIES (a choice among the type's tables,
 * and a yes/no cannot pick between Annual Leave's sixteen). What IS duplicated is the CONDITIONS: both
 * speak one vocabulary, so keying "confirmed staff" in both places lets either copy silently exclude
 * somebody.
 *
 * The fix is to render the inherited half read-only on the screen where the second half is typed — and the
 * whole value of that depends on the two lists never drifting in wording. So these tests pin the DERIVATION
 * rather than the words: every label and every value comes out of the SAME `CriteriaSection[]` the rule
 * editor's pickers are built from (`buildOrgCriteriaSections`), and a criteria vocabulary that stopped
 * carrying an axis fails HERE instead of quietly rendering a blank row on a live screen.
 *
 * ⚠️ THE ONE-CLICK RULE SHAPE IS PINNED AS A SOURCE SHAPE, deliberately. "Everyone this leave type is
 * available to" is `createEligibilityRule` with criteria `{}`, and it works because the form posts NO
 * criteria field at all — `criteriaFrom` (the actions file) asks `orgCriteriaFromFields` for axes BY NAME
 * rather than sweeping the FormData. A control added to that form later would start narrowing the rule with
 * nothing to say so: it would save, resolve and reach fewer people than its name promises. That defect
 * lives in the CONTRACT BETWEEN the form and the reader, so a unit test of either half passes throughout
 * (AGENTS rule 17) — a source-shape assertion across both is what can see it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildOrgCriteriaSections, type CriteriaSection } from '../core/org-criteria-form';
import { ORG_ASSIGNMENT_CRITERIA } from '../core/leave-org-criteria';
import { ORG_CRITERIA_FIELDS, ORG_CRITERIA_RANGE_FIELDS } from '../core/org-criteria';
import {
  criteriaAxisLabeller,
  criteriaValueLabeller,
  inheritedConditions,
} from '../app/admin/leave/entitlements/templates/leave-type-conditions';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The REAL criteria vocabulary, built the way both screens build it. Empty catalogues on purpose: this is
 *  about the AXES and the fixed option sets, not about a tenant's departments. Labels are echoed keys so an
 *  assertion names the key that produced it. */
const sections: CriteriaSection[] = buildOrgCriteriaSections(
  {
    companies: [],
    departments: [],
    grades: [],
    positions: [],
    costCenters: [],
    businessUnits: [],
    locations: [],
    profileOptions: {
      division: [{ id: 'd1', category: 'division', value: 'PROJECT', label: 'Project Division', isActive: true }],
    } as never,
  },
  { crit: (k) => `crit:${k}`, org: (k) => `org:${k}`, employmentType: (k) => `type:${k}` },
);

const LABELS = {
  maritalStatus: 'Marital status',
  minService: 'Minimum service',
  minServiceValue: (n: number, unit: 'months' | 'days') => `${n} ${unit}`,
  maritalValue: (v: string) => `marital:${v}`,
};

describe('r212 — the leave type\'s own conditions, worded from the shared criteria vocabulary', () => {
  it('every Organisation-Assignment axis the leave type can narrow by is also a criteria field', () => {
    // THE ANTI-DRIFT PROPERTY, asserted directly. The eight org axes are the same key on both sides by
    // construction (core/leave-org-criteria.ts), and that identity is the reason the inherited list can be
    // derived at all. If the criteria form ever stopped offering one, the inherited row for it would go
    // silently missing on the rule editor — so it fails here instead.
    const byName = new Set(sections.flatMap((s) => s.fields).map((f) => f.name));
    for (const c of ORG_ASSIGNMENT_CRITERIA) {
      expect(byName.has(c.key), `criteria vocabulary is missing ${c.key}`).toBe(true);
    }
    // …and the two axes whose SPELLING differs between the layers, which is the only place that difference
    // is written down (`ELIGIBILITY_TO_CRITERIA_AXIS`).
    expect(byName.has('genders')).toBe(true);
    expect(byName.has('confirmationStatuses')).toBe(true);
  });

  it('gender, probation and an org axis are all labelled from the criteria vocabulary, never restated', () => {
    const rows = inheritedConditions(
      { gender: 'female', probation: 'confirmed_only', orgDivision: ['PROJECT'] },
      sections,
      LABELS,
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));

    // The LABEL is the criteria form's own — `crit:gender`, not a second copy of the word "Gender".
    expect(byKey.get('gender')?.label).toBe('crit:gender');
    expect(byKey.get('gender')?.values).toEqual(['crit:genderFemale']);

    // Probation is `confirmationStatuses` on the other side — one predicate, two labels, and core's own
    // header says so. `confirmed_only` is the criteria value `confirmed`.
    expect(byKey.get('probation')?.label).toBe('crit:confirmationStatus');
    expect(byKey.get('probation')?.values).toEqual(['crit:confirmed']);

    // An org axis carries the profile-option catalogue's OWN label for the stored value, so the read-only
    // summary reads the way the picker beside it does.
    expect(byKey.get('orgDivision')?.label).toBe('org:division');
    expect(byKey.get('orgDivision')?.values).toEqual(['Project Division']);
  });

  it('marital status and minimum service are labelled from this screen, because no criteria axis means them', () => {
    // Marital status was deliberately never made a criteria axis, and `minServiceMonths` is measured in
    // months or DAYS while `minYearsOfService` is measured in years. Forcing either onto a near neighbour
    // would put a wrong word on a read-only summary of a live rule.
    const rows = inheritedConditions(
      { maritalStatus: ['married', 'widowed'], minServiceMonths: 12, minServiceUnit: 'months' },
      sections,
      LABELS,
    );
    expect(rows).toEqual([
      { key: 'maritalStatus', label: 'Marital status', values: ['marital:married', 'marital:widowed'] },
      { key: 'minServiceMonths', label: 'Minimum service', values: ['12 months'] },
    ]);

    // The unit is the leave type's own and an ABSENT unit means months — every row written before the unit
    // column existed must keep its old meaning, exactly as `servedFor` reads it.
    expect(inheritedConditions({ minServiceMonths: 30, minServiceUnit: 'days' }, sections, LABELS)[0].values).toEqual([
      '30 days',
    ]);
    expect(inheritedConditions({ minServiceMonths: 3 }, sections, LABELS)[0].values).toEqual(['3 months']);
  });

  it('a legacy SCALAR value reads identically to the array form — no migration, no backfill', () => {
    // gender / marital / the eight org axes accept a scalar (rows written before multi-select) OR an array.
    // A summary that showed one and not the other would report a live restriction as absent.
    const scalar = inheritedConditions({ orgDivision: 'PROJECT' }, sections, LABELS);
    const array = inheritedConditions({ orgDivision: ['PROJECT'] }, sections, LABELS);
    expect(scalar).toEqual(array);
    expect(scalar[0].values).toEqual(['Project Division']);
  });

  it('no conditions is a real answer, not a blank space', () => {
    expect(inheritedConditions({}, sections, LABELS)).toEqual([]);
    expect(inheritedConditions(null, sections, LABELS)).toEqual([]);
    // …and a leave type carrying ONLY a probation rule is still a restricted type.
    expect(inheritedConditions({ probation: 'probation_only' }, sections, LABELS)).toHaveLength(1);
  });

  it('an axis the vocabulary cannot name is named NOT AT ALL, never as its raw field name', () => {
    const label = criteriaAxisLabeller(sections);
    expect(label('employmentTypes')).toBe('crit:employmentType');
    // `orgDivision` on a screen teaches nobody anything; a screen that cannot name an axis says less.
    expect(label('somethingNobodyDefined')).toBeNull();
    // A value with no option of its own falls back to the stored string, which is still recognisable —
    // exactly what an option deactivated since the rule was written leaves behind.
    expect(criteriaValueLabeller(sections)('orgDivision', 'RETIRED_VALUE')).toBe('RETIRED_VALUE');
  });
});

describe('r212 — the one-click "everyone" rule really does post no criteria', () => {
  const block = readFileSync(
    join(ROOT, 'app/admin/leave/entitlements/templates/entitlement-tables-block.tsx'),
    'utf8',
  );

  /** The one-click form's own source: from its create action to the submit label that closes it. */
  function oneClickForm(): string {
    const start = block.indexOf('{!editingRule ? (');
    const end = block.indexOf("{t('ruleEveryoneCreate')}", start);
    expect(start, 'the one-click rule form is gone from the rule editor').toBeGreaterThan(-1);
    expect(end, 'the one-click rule form no longer submits').toBeGreaterThan(start);
    return block.slice(start, end);
  }

  it('the form carries no criteria control, so `criteriaFrom` reads {} — which already means EVERYONE', () => {
    const form = oneClickForm();
    for (const field of [...ORG_CRITERIA_FIELDS, ...ORG_CRITERIA_RANGE_FIELDS]) {
      expect(form.includes(`name="${field}"`), `the one-click form posts the criteria axis ${field}`).toBe(false);
    }
    // It posts exactly the three fields a rule needs and nothing else.
    expect(form).toContain('name="name"');
    expect(form).toContain('name="templateLineageId"');
    expect(form).toContain('name="validFrom"');
    expect(form).toContain('action={createEligibilityRuleAction}');
  });

  it('the sole-table line is READ from the health derivation, never recomputed beside it', () => {
    // r209 shipped a green light over a leave type the engine granted to nobody by measuring the second
    // half of this gate on the wrong set of rules. There is ONE derivation (lib/leave-config-health.ts,
    // itself mirroring the engine) and this screen consumes it — so a block that started deciding for
    // itself would be able to disagree with the health card directly above it.
    expect(block).toContain('soleTableNoRuleNeeded');
    expect(block).toContain('.filter((h) => h.soleTableApplies)');
    // The engine's own two conditions must not reappear here in any form.
    expect(block).not.toContain('liveTemplates.length === 1');
    expect(block).not.toContain('rulesInForce.length === 0');
  });
});

/**
 * THE RENDER CHECK THE STATIC GUARDS CANNOT DO FOR THESE FILES.
 *
 * `test/i18n-coverage.test.ts` case C resolves literal `t('a.b')` keys ONLY in single-namespace files, and
 * skips multi-namespace ones because it cannot attribute a key statically. All three files below read two
 * or more namespaces, so every key they ask for is invisible to it — and a missing one paints
 * `MISSING_MESSAGE` in the browser while passing tsc, the suite and `next build` (AGENTS rule 6). These are
 * SERVER components, so no DOM test can reach them either.
 *
 * So: attribute each literal key to the translator it was called on, and resolve it in all six catalogues.
 */
describe('r212 — every key these server components ask for resolves, in all six locales', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const catalogues = Object.fromEntries(
    LOCALES.map((l) => [l, JSON.parse(readFileSync(join(ROOT, 'messages', `${l}.json`), 'utf8'))]),
  ) as Record<(typeof LOCALES)[number], Record<string, unknown>>;

  const at = (obj: unknown, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);

  /** `const <name> = await getTranslations('<ns>')` → which namespace each translator variable holds. */
  function namespacesOf(src: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of src.matchAll(/const\s+(\w+)\s*=\s*await\s+getTranslations\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      out.set(m[1], m[2]);
    }
    return out;
  }

  for (const file of [
    'app/admin/leave/entitlements/templates/entitlement-tables-block.tsx',
    'app/admin/leave/entitlements/templates/eligibility-explain.tsx',
    'app/admin/leave/entitlements/templates/page.tsx',
  ]) {
    it(`${file}`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8');
      const ns = namespacesOf(src);
      expect(ns.size, 'no translator found — has the file stopped reading i18n?').toBeGreaterThan(0);
      const missing: string[] = [];
      for (const [variable, namespace] of ns) {
        const calls = new RegExp(`\\b${variable}\\(\\s*['"]([a-z][a-zA-Z0-9_]*)['"]`, 'g');
        for (const m of src.matchAll(calls)) {
          for (const locale of LOCALES) {
            const full = `${namespace}.${m[1]}`;
            if (typeof at(catalogues[locale], full) !== 'string') missing.push(`[${locale}] ${full}`);
          }
        }
      }
      expect([...new Set(missing)], missing.join('\n')).toEqual([]);
    });
  }
});
