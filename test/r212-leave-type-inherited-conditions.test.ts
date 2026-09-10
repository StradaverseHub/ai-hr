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
import { ELIGIBILITY_AXIS_LABEL_KEY } from '../lib/entitlement-status';

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

  /** The one-click form's own source — its own file since the reach count made it a client island. */
  const everyoneForm = readFileSync(
    join(ROOT, 'app/admin/leave/entitlements/templates/everyone-rule-form.tsx'),
    'utf8',
  );

  it('it is mounted only while CREATING — an edit already has criteria on screen to clear', () => {
    const start = block.indexOf('{!editingRule ? (\n                <EveryoneRuleForm');
    expect(start, 'the one-click rule form is gone from the rule editor, or is no longer create-only').toBeGreaterThan(-1);
  });

  it('the form carries no criteria control, so `criteriaFrom` reads {} — which already means EVERYONE', () => {
    for (const field of [...ORG_CRITERIA_FIELDS, ...ORG_CRITERIA_RANGE_FIELDS]) {
      expect(
        everyoneForm.includes(`name="${field}"`),
        `the one-click form posts the criteria axis ${field}`,
      ).toBe(false);
    }
    // It posts exactly the three fields a rule needs and nothing else.
    expect(everyoneForm).toContain('name="name"');
    expect(everyoneForm).toContain('name="templateLineageId"');
    expect(everyoneForm).toContain('name="validFrom"');
  });

  /**
   * ⚠️ THE OBLIGATION NOTHING PINNED, AND THE FIRST CUT OF THIS FORM BROKE.
   *
   * Two headers in this codebase say the same thing in almost the same words —
   * `countEligibilityTargetsAction` ("THE SCREEN IS REQUIRED TO SHOW THIS BEFORE IT LETS ANYBODY SAVE …
   * this count is the thing that stops 'no restrictions' becoming an accidental whole-company assignment")
   * and `EligibilityRuleForm` ("the only thing standing between 'no restrictions' and a whole-company
   * assignment"). The one-click shape ALWAYS means everybody, the service refuses nothing, and
   * `createEligibilityRuleAction` runs `recomputeAfterSave` on the click — so it is the one write on this
   * screen that must never be submittable unsighted. It shipped as a bare form with a plain submit.
   *
   * Asserted on the SOURCE because it is a structural obligation, not a rendering: a future edit that
   * quietly drops the count action or swaps the confirm back for a `<button type="submit">` fails here.
   */
  it('the one-click form shows the reach COUNT and confirms before it writes', () => {
    const form = everyoneForm;
    // It asks the SAME count action the full rule editor asks, normalised through the same parser the save
    // uses — a count from a differently-parsed object is worse than no count.
    expect(form, 'the one-click form no longer counts who it reaches').toContain('countAction({ criteria: {}');
    expect(form).toContain("t('ruleEveryoneCount', { count })");
    // …and the submit is the confirm control, disabled until a number is on screen.
    expect(form).toContain('<ConfirmSubmit');
    expect(form).toContain('disabled={count == null}');
    expect(form, 'a plain submit button bypasses the confirmation').not.toContain("type=\"submit\"");
    // The block must hand it both actions; a mount that forgot either would render a form that cannot count.
    expect(block).toContain('countAction={countEligibilityTargetsAction}');
    expect(block).toContain('action={createEligibilityRuleAction}');
  });

  it('the sole-table line is READ from the health derivation, never recomputed beside it', () => {
    // r209 shipped a green light over a leave type the engine granted to nobody by measuring the second
    // half of this gate on the wrong set of rules. There is ONE derivation (lib/leave-config-health.ts,
    // itself mirroring the engine) and this screen consumes it — so a block that started deciding for
    // itself would be able to disagree with the health card directly above it.
    expect(block).toContain('soleTableNoRuleNeeded');
    // The LINE'S OWN source, not merely the flag appearing somewhere in the file: the block already reads
    // `soleTableApplies` for the per-table marker, so a file-wide search would have kept passing while this
    // list quietly started deciding for itself.
    const start = block.indexOf('const soleTableTypeNames');
    expect(start, 'the sole-table list is gone').toBeGreaterThan(-1);
    const decl = block.slice(start, block.indexOf(';', start));
    expect(decl, 'the sole-table line stopped reading the health derivation').toContain('h.soleTableApplies');
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
    // a6fe37fc Round 5 — the standalone screen moved to /admin/leave-config/entitlement-tables and the
    // old address is a redirect stub (which reads no i18n at all). The two mounted components above did
    // NOT move; only the page around them did.
    'app/admin/leave-config/entitlement-tables/page.tsx',
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

/**
 * r212 — THE AXIS LABEL MAP CANNOT DRIFT FROM THE PICKER IT BORROWS FROM.
 *
 * The employee's own breakdown panel is a CLIENT island fed by `core/read.ts`, which has neither a
 * translator nor a catalogue — so it cannot call `buildOrgCriteriaSections` (that module reaches
 * `core/org-criteria.ts`, which imports `db/client`) and cannot be handed resolved labels either. It reads
 * `ELIGIBILITY_AXIS_LABEL_KEY` instead. That is a second place naming the axes, and the ONLY thing that
 * stops it becoming a second vocabulary is this test: the real builder is run with translators that echo
 * their keys, and the two are compared field by field.
 *
 * An axis added, renamed or relabelled in the builder fails HERE, instead of painting a raw `orgDivision`
 * or a `MISSING_MESSAGE` inside a translated sentence on a live screen (AGENTS rule 6).
 */
describe('r212 — the criteria axis labels the employee panel resolves', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const catalogues = Object.fromEntries(
    LOCALES.map((l) => [l, JSON.parse(readFileSync(join(ROOT, 'messages', `${l}.json`), 'utf8'))]),
  ) as Record<(typeof LOCALES)[number], Record<string, unknown>>;
  const at = (obj: unknown, dotted: string): unknown =>
    dotted
      .split('.')
      .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);

  /** The two namespaces `buildOrgCriteriaSections` labels its FIELDS from — and the echo prefixes the
   *  fixture above feeds it, so a mapped key can be compared against the label the builder produced. */
  const NS = {
    criteria: { path: 'admin.leave.adjustmentsCriteria', echo: 'crit:' },
    orgCategory: { path: 'admin.profileOptions.category', echo: 'org:' },
  } as const;

  const fields = sections.flatMap((section) => section.fields);

  it('every criteria field the real builder produces is in the map, pointing at the SAME key', () => {
    const wrong: string[] = [];
    for (const f of fields) {
      const mapped = ELIGIBILITY_AXIS_LABEL_KEY[f.name];
      if (!mapped) {
        wrong.push(`${f.name}: absent from ELIGIBILITY_AXIS_LABEL_KEY`);
        continue;
      }
      const expected = `${NS[mapped.ns].echo}${mapped.key}`;
      if (expected !== f.label) wrong.push(`${f.name}: map says ${expected}, builder says ${f.label}`);
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('the map names no axis the builder does not offer', () => {
    // A stale entry is not harmless: it would keep resolving after the axis it named was removed, so the
    // panel would go on printing a label for a criterion nothing can store any more.
    const offered = new Set(fields.map((f) => f.name));
    const extra = Object.keys(ELIGIBILITY_AXIS_LABEL_KEY).filter((k) => !offered.has(k));
    expect(extra, `axes in the map that no criteria field offers: ${extra.join(', ')}`).toEqual([]);
  });

  it('every mapped key resolves in all six locales', () => {
    const missing: string[] = [];
    for (const [axis, k] of Object.entries(ELIGIBILITY_AXIS_LABEL_KEY)) {
      for (const locale of LOCALES) {
        const dotted = `${NS[k.ns].path}.${k.key}`;
        if (typeof at(catalogues[locale], dotted) !== 'string') missing.push(`[${locale}] ${axis} → ${dotted}`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });
});

/**
 * r212 — THE DYNAMIC-KEY PATH THE SOURCE SCAN ABOVE CANNOT SEE, AND WHY IT NEEDS ITS OWN CASE.
 *
 * The explain panel resolves each rule's status through `t(STATE_KEY[r.state], …)` — a key looked up in a
 * map, not written as a literal — so neither `test/i18n-coverage.test.ts` case C nor the attribute-and-
 * resolve scan above can attribute it. That is precisely the class AGENTS rule 6 is about: a missing one
 * paints `MISSING_MESSAGE` in the browser and still returns 200. The panel is a SERVER component, so no DOM
 * test can reach it either (the employee panel's own five-state map IS covered by a render, in
 * `test/r212-eligibility-notice.dom.test.tsx`).
 *
 * ⚠️ THIS DOES NOT MAKE THE STATIC GUARDS A SUBSTITUTE FOR A RENDER IN GENERAL. It covers exactly the five
 * keys named below, read out of the map's own source; a sixth state added with no copy fails at tsc (the
 * map is typed `Record<EligibilityRuleNotice['state'], string>`) and then here.
 */
describe('r212 — the explain panel\'s five rule-state keys resolve, in all six locales', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const NAMESPACE = 'admin.entitlementTemplates';

  it('every key in STATE_KEY exists in every catalogue', () => {
    const src = readFileSync(
      join(ROOT, 'app/admin/leave/entitlements/templates/eligibility-explain.tsx'),
      'utf8',
    );
    const start = src.indexOf('const STATE_KEY');
    expect(start, 'STATE_KEY is gone — has the explain panel stopped mapping rule states?').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('};', start));
    const keys = [...body.matchAll(/:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
    expect(keys.length, 'STATE_KEY no longer lists the five rule states').toBe(5);

    const missing: string[] = [];
    for (const locale of LOCALES) {
      const catalogue = JSON.parse(readFileSync(join(ROOT, 'messages', `${locale}.json`), 'utf8'));
      for (const key of keys) {
        const node = `${NAMESPACE}.${key}`
          .split('.')
          .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), catalogue);
        if (typeof node !== 'string') missing.push(`[${locale}] ${NAMESPACE}.${key}`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });
});

/**
 * r212 — NEITHER SCREEN MAY DECIDE THE VERDICT FOR ITSELF AGAIN.
 *
 * `eligibilityNoticeFrom` hands both renderers one `verdict`. Before it did, each tested the SAME object's
 * fields in its own order and they printed opposite sentences about one employee — the admin panel
 * "not employed on that date, so no rule can reach them", the employee's panel "that table applies to
 * everyone", for a leaver on a sole-table leave type. The engine tests pin what the verdict IS; only a
 * source assertion can see a screen quietly re-deriving it, because one of the two is a server component
 * no DOM test can render (AGENTS rule 17: a defect that lives in the CONTRACT between two files is
 * invisible to a unit test of either half).
 */
describe('r212 — one verdict, read by both screens', () => {
  const renderers = {
    'app/admin/leave/entitlements/templates/eligibility-explain.tsx': 'notice.verdict',
    'components/leave/LeaveDetailsPanel.tsx': 'eligibility.verdict',
  } as const;

  for (const [file, reader] of Object.entries(renderers)) {
    it(`${file} reads the shared verdict and re-derives none of its own`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(src, `${file} no longer reads the shared verdict`).toContain(reader);
      // The two fields whose ORDER was the disagreement. Either may be READ (the window is a legitimate
      // caveat beside a winner); neither may open a ternary chain that decides what the answer is.
      expect(src, `${file} re-derives the verdict from soleTableApplies`).not.toMatch(
        /soleTableApplies\s*\?/,
      );
      expect(src, `${file} re-derives the verdict from activeAtDate`).not.toMatch(
        /!\s*\w+\.activeAtDate\s*\?/,
      );
    });
  }
});

