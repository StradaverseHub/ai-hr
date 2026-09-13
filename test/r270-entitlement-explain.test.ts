/**
 * r270 — THE EXPLAIN PANEL SAYS THE WHOLE SENTENCE, NAMES WHY ONE SCHEME BEAT ANOTHER, AND ITS TWO
 * LINKS STILL LAND SOMEWHERE.
 *
 * Three approved builds and one repoint, and every one of them is a claim about what an administrator
 * READS rather than about what the engine computes. Nothing here changes an entitlement: the figures
 * were all being calculated already and nobody could see four of them.
 *
 *   §A  995387c6 — two controls that would have become dead this round. The explain panel's "Open
 *       scheme" built `?editRule=` at the Entitlement tables route, which stops answering that
 *       parameter when the Benefit schemes section leaves it; Company rules linked to the same route
 *       saying that is where you set who receives which table. Both now point at Leave types, and the
 *       destination is pinned ACROSS BOTH FILES (CLAUDE.md §8) because the defect lives in the contract
 *       between them: a link that names a parameter no page reads type-checks, builds and renders.
 *
 *   §B  65e4073a build 2 — "Resolves to GP1215, through the scheme GP1215" never said the employee's
 *       grade, their service, the band that applied or the days. `eligibilityExplainSentence` composes
 *       the rest, three variants because there are three ways to win. The cases below FORMAT the real
 *       catalogues rather than inspecting the composer's output, because a malformed ICU string throws
 *       at RENDER time and returns a 200 with the sentence missing.
 *
 *   §C  65e4073a build 3 — two schemes each narrowing ONE axis tie on specificity and are then
 *       separated by `validFrom`, silently. `winReasonFor` reports which term decided; the pair test
 *       below drives it against `beatsEligibility` itself, so a reason that disagreed with the ranking
 *       would fail here rather than mislead an operator on screen.
 *
 *   §D  65e4073a build 4 — the wording that caused the ticket. "Ask HR to NAME you in a benefit
 *       scheme" used *name* to mean *describe*; the reporter read it as *list by name*.
 *
 *   §E  the facts reader, against the database — including the case that matters most on the
 *       reporter's account: 47 of their 74 live employments have NO JOB GRADE RECORDED, and the
 *       sentence for one of those must not contain the word Grade at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import en from '../messages/en.json';
import { hireEmployee } from '../core/org';
import {
  beatsEligibility,
  createEligibilityRule,
  createEntitlementTemplate,
  eligibilityNoticeFrom,
  explainEntitlementEligibility,
  winReasonFor,
  type EligibilityRuleRow,
} from '../core/entitlement-template';
import { entitlementExplainFactsFor } from '../core/entitlement-scheme-view';
import { eligibilityExplainSentence, type EligibilityNotice } from '../lib/entitlement-status';
import type { ServiceBand } from '../core/leave-compute';
import { withTenant } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// §A · the two links
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('§A · 995387c6 — neither link points at a parameter nobody reads any more', () => {
  it('the explain panel opens the rule editor on Leave types, with the anchor that selects the type', () => {
    const src = read('app/admin/leave/entitlements/templates/eligibility-explain.tsx');
    // The destination, resolved through the map so this page and the submenu cannot disagree.
    expect(src, 'the editor link must resolve through the leave-config map').toContain(
      "leaveConfigScreenHref('leaveTypes')",
    );
    expect(src).toContain('editRule=');
    // ⚠️ THE ANCHOR. `LeaveTypeWorkspace` seeds its selection from items[0] and applies the hash only
    // afterwards, so an anchorless hard load lands on the FIRST leave type alphabetically while the rule
    // being edited belongs to another — the block's own header records this. Without `#type-<id>` the
    // link navigates and opens nothing, which is the same failure it is being repaired from.
    expect(src, 'the rule-editor link must carry #type-<leaveTypeId>').toMatch(/#type-\$\{encodeURIComponent\(leaveTypeId\)\}/);
    // And it must NOT still hang editRule off this panel's own explain query.
    expect(src, 'the old self-referential editRule link must be gone').not.toMatch(
      /linkFor\(chosen\.employmentId\)\}&editRule=/,
    );
  });

  it('and the destination really reads it — the contract, pinned across both files', () => {
    // CLAUDE.md §8: when a defect lives in the contract between two files, pin it across both. A link
    // naming `editRule` is indistinguishable from a working one until the page that must answer it is
    // read; tsc, `next build` and a 200 all pass either way.
    const dest = read('app/admin/leave-config/types/page.tsx');
    expect(dest, 'Leave types must declare editRule in its searchParams').toMatch(/editRule\?: string/);
    expect(dest, 'and hand it to the block that renders the rule editor').toContain('editRule={editRule}');
    const block = read('app/admin/leave/entitlements/templates/entitlement-tables-block.tsx');
    expect(block, 'the block resolves the lineage against its RUNNING rules').toContain(
      '.find((x) => x.lineageId === editRule)',
    );
  });

  it('Company rules points at Leave types, where the schemes are, and still hosts no editor', () => {
    const src = read('app/admin/leave-config/company-rules/page.tsx');
    expect(src).toContain("leaveConfigScreenHref('leaveTypes')");
    expect(src, 'the pointer must not name the tab the schemes left').not.toContain(
      "leaveConfigScreenHref('entitlementTables')",
    );
    // The property r266 put there is untouched: this page only POINTS at eligibility.
    expect(src).not.toContain('<EntitlementTablesBlock');
    expect(src).not.toContain('EligibilityRuleForm');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// §B · the sentence
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const WON: ServiceBand[] = [
  { fromYears: 0, toYears: 2, days: 16 },
  { fromYears: 2, toYears: 5, days: 18 },
  { fromYears: 5, toYears: null, days: 20 },
];

const notice = (over: Partial<EligibilityNotice>): EligibilityNotice => ({
  verdict: 'resolved',
  activeAtDate: true,
  soleTableApplies: false,
  defaultTableApplies: false,
  winningRuleName: 'GP1215',
  winningTableName: 'GP1215',
  rules: [],
  usesUndatedAxis: false,
  ...over,
});

/** next-intl's own core, with `onError` rethrowing — see the r127 lesson in leave-config-round4. */
async function translator(loc: string) {
  const { createTranslator } = await import('next-intl');
  const messages = (await import(`../messages/${loc}.json`)).default as Record<string, unknown>;
  return createTranslator({
    locale: loc,
    messages,
    namespace: 'admin.entitlementTemplates',
    onError: (e) => {
      throw e;
    },
  });
}

const say = async (
  n: EligibilityNotice,
  p: { employee: string; criteriaClause?: string | null },
  loc = 'en',
) => {
  const s = eligibilityExplainSentence(n, p);
  if (!s) return null;
  const t = await translator(loc);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (t as any)(s.key, s.values) as string;
};

describe('§B · 65e4073a build 2 — the whole sentence, from facts that were already computed', () => {
  it('the scheme path says the drawn sentence, end to end', async () => {
    const out = await say(
      notice({
        gradeName: 'Grade 17',
        serviceYears: 7,
        winningBand: WON[2],
        daysAtService: 20,
      }),
      { employee: 'Ahmad', criteriaClause: 'job grade 16-19, full time' },
    );
    // The mockup's promise (docs/mockups/65e4073a-leave-table-rules.png, panel 3), word for word in its
    // shape: who they are, which scheme, in what words, which table, how many days, for what service.
    expect(out).toBe(
      'Ahmad is Grade 17 with 7 years of service. The scheme “GP1215” (job grade 16-19, full time) ' +
        'covers them, and its table GP1215 gives 20 days for 5 or more years of service.',
    );
  });

  it('NO JOB GRADE RECORDED ⇒ the grade is not mentioned, not rendered as a blank or a null', async () => {
    // 47 of the reporter's 74 live employments. This is the case the whole nullability exists for.
    const out = await say(
      notice({ gradeName: null, serviceYears: 7, winningBand: WON[2], daysAtService: 20 }),
      { employee: 'Ahmad', criteriaClause: 'job grade 16-19, full time' },
    );
    expect(out).toBe(
      'Ahmad has 7 years of service. The scheme “GP1215” (job grade 16-19, full time) covers them, ' +
        'and its table GP1215 gives 20 days for 5 or more years of service.',
    );
    expect(out).not.toMatch(/\bGrade\b(?!\s*1)/); // "job grade 16-19" is the RULE's words, not a claim about Ahmad
    expect(out).not.toMatch(/null|undefined|NaN/);
  });

  it('no hire date and no grade ⇒ the sentence simply starts at the scheme', async () => {
    const out = await say(notice({ gradeName: null, serviceYears: null, winningBand: WON[0], daysAtService: 16 }), {
      employee: 'Ahmad',
    });
    expect(out).toBe(
      'The scheme “GP1215” covers them, and its table GP1215 gives 16 days for 0 to 2 years of service.',
    );
    // The criteria clause is dropped whole rather than rendered as empty brackets.
    expect(out).not.toContain('()');
  });

  it('a band that does not resolve says the table APPLIES and invents no day count', async () => {
    const out = await say(notice({ gradeName: 'Grade 17', serviceYears: 7, winningBand: null, daysAtService: null }), {
      employee: 'Ahmad',
    });
    expect(out).toBe('Ahmad is Grade 17 with 7 years of service. The scheme “GP1215” covers them, and its table GP1215 applies.');
    expect(out).not.toMatch(/\b0 days\b/);
  });

  it('the default-table path names no scheme, and the sole-table path says none is needed', async () => {
    const dflt = await say(
      notice({
        verdict: 'default_table',
        defaultTableApplies: true,
        winningRuleName: null,
        gradeName: 'Grade 17',
        serviceYears: 7,
        winningBand: WON[2],
        daysAtService: 20,
      }),
      { employee: 'Ahmad' },
    );
    expect(dflt).toBe(
      'Ahmad is Grade 17 with 7 years of service. No benefit scheme describes them, so this leave ' +
        'type’s default entitlement table GP1215 applies, and it gives 20 days for 5 or more years of service.',
    );
    // 76ffdcf2's rule: never name a scheme where none was consulted.
    expect(dflt).not.toContain('The scheme');

    const sole = await say(
      notice({
        verdict: 'sole_table',
        soleTableApplies: true,
        winningRuleName: null,
        gradeName: null,
        serviceYears: 3,
        winningBand: WON[1],
        daysAtService: 18,
      }),
      { employee: 'Ahmad' },
    );
    expect(sole).toBe(
      'Ahmad has 3 years of service. GP1215 is the only entitlement table in force for this leave ' +
        'type, so it reaches everybody and no benefit scheme is needed: it gives 18 days for 2 to 5 years of service.',
    );
  });

  it('nothing resolved ⇒ no sentence at all: there are no days to explain', () => {
    for (const verdict of ['no_match', 'no_rules', 'not_active'] as const) {
      expect(
        eligibilityExplainSentence(notice({ verdict, winningRuleName: null, winningTableName: null }), {
          employee: 'Ahmad',
        }),
        verdict,
      ).toBeNull();
    }
  });

  it.each(LOCALES)('%s FORMATS all three variants in every shape — a malformed arm is a render-time 200', async (loc) => {
    const t = await translator(loc);
    const shapes: Partial<EligibilityNotice>[] = [
      { gradeName: 'Grade 17', serviceYears: 7, winningBand: WON[2], daysAtService: 20 },
      { gradeName: 'Grade 17', serviceYears: null, winningBand: WON[0], daysAtService: 16 },
      { gradeName: null, serviceYears: 1, winningBand: WON[0], daysAtService: 1 },
      { gradeName: null, serviceYears: null, winningBand: null, daysAtService: null },
    ];
    const verdicts = [
      { verdict: 'resolved' as const },
      { verdict: 'default_table' as const, defaultTableApplies: true, winningRuleName: null },
      { verdict: 'sole_table' as const, soleTableApplies: true, winningRuleName: null },
    ];
    for (const v of verdicts) {
      for (const shape of shapes) {
        const s = eligibilityExplainSentence(notice({ ...v, ...shape }), {
          employee: 'Ahmad',
          criteriaClause: 'job grade 16-19',
        })!;
        expect(s, `${loc} ${v.verdict}`).not.toBeNull();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out = (t as any)(s.key, s.values) as string;
        expect(out.trim().length, `${loc} · ${s.key} formatted to nothing`).toBeGreaterThan(0);
        expect(out, `${loc} · ${s.key} left ICU unformatted`).not.toMatch(/\{[a-zA-Z]+,\s*(plural|select)/);
        expect(out, `${loc} · ${s.key} leaked a raw placeholder`).not.toMatch(/\{(employee|table|days|from|to|rule|clause|grade|years)\}/);
        expect(out, `${loc} · ${s.key}`).not.toMatch(/null|undefined|NaN/);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// §C · why one scheme beat another
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const ruleRow = (over: Partial<EligibilityRuleRow>): EligibilityRuleRow => ({
  id: 'id',
  lineageId: 'lin',
  name: 'r',
  templateLineageId: 'tpl',
  criteria: {},
  validFrom: '2026-01-01',
  validTo: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

describe('§C · 65e4073a build 3 — the reason the winner won, reported and never decided', () => {
  it('names the FIRST term of beatsEligibility on which the pair differs, and agrees with it', () => {
    const cases: { a: EligibilityRuleRow; b: EligibilityRuleRow; reason: string }[] = [
      {
        // Two narrowed axes vs one — the only term that differs is specificity.
        a: ruleRow({ criteria: { employmentTypes: ['full_time'], departmentIds: ['d1'] } }),
        b: ruleRow({ criteria: { employmentTypes: ['full_time'] } }),
        reason: 'more_specific',
      },
      {
        // ONE axis each ⇒ a real tie on specificity, broken by the start date. This is the pair the
        // reporter could hit and never see: nothing on screen said a second scheme had reached them.
        a: ruleRow({ criteria: { departmentIds: ['d1'] }, validFrom: '2026-06-01' }),
        b: ruleRow({ criteria: { employmentTypes: ['full_time'] }, validFrom: '2026-01-01' }),
        reason: 'later_start',
      },
      {
        // Tied on both ⇒ the row created last. A genuine ambiguity, reported as one.
        a: ruleRow({ criteria: { departmentIds: ['d1'] }, createdAt: new Date('2026-02-02T00:00:00Z') }),
        b: ruleRow({ criteria: { employmentTypes: ['full_time'] }, createdAt: new Date('2026-01-01T00:00:00Z') }),
        reason: 'later_created',
      },
    ];
    for (const c of cases) {
      // The winner really is the winner — the reason is asserted about the pair the ranking produces.
      expect(beatsEligibility(c.a, c.b), `${c.reason}: a must beat b`).toBe(true);
      expect(beatsEligibility(c.b, c.a), `${c.reason}: and b must not beat a`).toBe(false);
      expect(winReasonFor(c.a, c.b), c.reason).toBe(c.reason);
    }
    // One candidate is not a comparison, and the panel renders nothing for it.
    expect(winReasonFor(ruleRow({}), null)).toBe('sole_candidate');
  });

  it('the panel renders a reason on the WINNING row only, and nothing for a single candidate', () => {
    const src = read('app/admin/leave/entitlements/templates/eligibility-explain.tsx');
    expect(src).toContain('sole_candidate: null');
    expect(src).toContain("more_specific: 'explainWhyChosenSpecific'");
    expect(src).toContain("later_start: 'explainWhyChosenLater'");
    expect(src).toContain("later_created: 'explainWhyChosenLater'");
    // Keyed on the LINEAGE: several rules can read "Matches", and nothing makes two names differ.
    expect(src).toContain('r.id === winningLineageId && whyChosenKey');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// §D · the wording that caused the ticket
// ─────────────────────────────────────────────────────────────────────────────────────────────────
type Dict = Record<string, unknown>;
const getPath = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);

const REWORDED = [
  'leave.errors.insufficientBalanceNoScheme',
  'leave.errors.insufficientBalanceNoSchemeOther',
  'leave.breakdown.statusNoEligibilityMatchBody',
  'leave.breakdown.eligibilityNoRules',
  'me.leaveBalanceTable.statusNoEligibilityMatchTip',
  'admin.entitlementTemplates.uncoveredHelp',
];
const MINTED = [
  'admin.entitlementTemplates.explainSentence',
  'admin.entitlementTemplates.explainSentenceDefault',
  'admin.entitlementTemplates.explainSentenceSole',
  'admin.entitlementTemplates.explainWhyChosenSpecific',
  'admin.entitlementTemplates.explainWhyChosenLater',
];

describe('§D · 65e4073a build 4 — a scheme is a description, and it is optional', () => {
  it('no screen asks anybody to be NAMED in a scheme, in the sense that caused the ticket', () => {
    for (const key of REWORDED) {
      const v = getPath(en, key) as string;
      expect(typeof v, key).toBe('string');
      expect(v, `${key} still asks to list a person by name`).not.toMatch(
        /name (you|them|us|this employee|these people) in a/i,
      );
      expect(v, `${key} still calls them "the people to name"`).not.toMatch(/people to name/i);
    }
  });

  it('each one says what a scheme IS and that it is optional, without overclaiming', () => {
    for (const key of REWORDED) {
      const v = getPath(en, key) as string;
      expect(v, `${key} must say a scheme is a description`).toMatch(/descri(ption|bes)/i);
      // "several entitlement tables" is the honest limit: a scheme genuinely IS how one of several is
      // chosen when no default is named, so no string may claim a scheme does nothing.
      expect(v, `${key} must not claim a scheme is never needed`).not.toMatch(/never needed|no use/i);
    }
    // Optionality is stated on the five surfaces an administrator or an employee actually meets it on.
    for (const key of REWORDED.filter((k) => !k.endsWith('uncoveredHelp'))) {
      expect(getPath(en, key) as string, `${key} must say a scheme is optional`).toMatch(/optional/i);
    }
  });

  it('every key this round minted or reworded exists in all six catalogues, and is translated', async () => {
    for (const key of [...MINTED, ...REWORDED]) {
      const enValue = getPath(en, key);
      expect(typeof enValue, key).toBe('string');
      for (const loc of LOCALES) {
        const cat = (await import(`../messages/${loc}.json`)).default;
        const v = getPath(cat, key);
        expect(typeof v, `${loc} ${key}`).toBe('string');
        expect((v as string).length, `${loc} ${key}`).toBeGreaterThan(0);
        if (loc !== 'en') expect(v, `${loc} ${key} left in English`).not.toBe(enValue);
      }
    }
  });

  it.each(LOCALES)('%s · the two why-chosen sentences format, in both tie-break arms', async (loc) => {
    const t = await translator(loc);
    for (const bag of [
      { key: 'explainWhyChosenSpecific', values: { other: 'GP1620', date: '2026-01-01', basis: 'start' } },
      { key: 'explainWhyChosenLater', values: { other: 'GP1620', date: '2026-01-01', basis: 'start' } },
      { key: 'explainWhyChosenLater', values: { other: 'GP1620', date: '2026-01-01', basis: 'created' } },
    ]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = (t as any)(bag.key, bag.values) as string;
      expect(out.trim().length, `${loc} ${bag.key}`).toBeGreaterThan(0);
      expect(out, `${loc} ${bag.key} left ICU unformatted`).not.toMatch(/\{[a-zA-Z]+,\s*select/);
      expect(out, `${loc} ${bag.key}`).toContain('GP1620');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// §E · the facts, and the win reason, against the database
// ─────────────────────────────────────────────────────────────────────────────────────────────────
let b: Base;
const uniqEmail = () => `r270_${randomUUID().slice(0, 8)}@t.local`;
const ASOF = '2026-08-20';

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

const makeGrade = async (name: string) => {
  const [g] = await owner.db
    .insert(schema.jobGrade)
    .values({ tenantId: b.tenantId, code: name.replace(/\s/g, ''), name, rank: 17 })
    .returning({ id: schema.jobGrade.id });
  return g.id;
};

const hire = (gradeId: string | null, hiredOn = '2019-03-01') =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Ahmad Ibrahim', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    gradeId,
    grantLeaveTypes: [],
  });

describe('§E · the facts reader and the win reason, against real rows', () => {
  it('reads the grade NAME, the service length, the winning band and its days — through the engine’s own helpers', async () => {
    const gradeId = await makeGrade('Grade 17');
    const emp = await hire(gradeId);
    const facts = await entitlementExplainFactsFor(adminCtx(b), {
      employmentId: emp.employmentId,
      asOf: ASOF,
      serviceBands: WON,
    });
    expect(facts.gradeName).toBe('Grade 17');
    // Hired 2019-03-01, read at 2026-08-20 ⇒ seven completed years. Derived, never stored.
    expect(facts.serviceYears).toBe(7);
    expect(facts.band).toEqual(WON[2]);
    expect(facts.daysAtService).toBe(20);
  });

  it('AND WITH NO GRADE ON THE RECORD it returns null rather than a blank — the 47-of-74 case', async () => {
    const emp = await hire(null);
    const facts = await entitlementExplainFactsFor(adminCtx(b), {
      employmentId: emp.employmentId,
      asOf: ASOF,
      serviceBands: WON,
    });
    expect(facts.gradeName).toBeNull();
    expect(facts.serviceYears).toBe(7);
    // …and the sentence composed from it never mentions a grade.
    const out = await say(
      notice({ ...facts, winningBand: facts.band }),
      { employee: 'Ahmad' },
    );
    expect(out).not.toMatch(/Grade/);
    expect(out).not.toMatch(/null|undefined/);
  });

  it('two schemes narrowing ONE axis each tie, the later start wins, and the panel can say so', async () => {
    const ctx = adminCtx(b);
    const early = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Early table',
      serviceBands: WON,
      validFrom: '2026-01-01',
    });
    const late = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Late table',
      serviceBands: WON,
      validFrom: '2026-01-01',
    });
    // ONE narrowed axis each — a real specificity tie, which is the whole point of the case.
    await createEligibilityRule(ctx, {
      name: 'By employment type',
      templateLineageId: early.lineageId,
      criteria: { employmentTypes: ['full_time'] },
      validFrom: '2026-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'By department',
      templateLineageId: late.lineageId,
      criteria: { departmentIds: [b.deptA] },
      validFrom: '2026-06-01',
    });
    const emp = await hire(null);

    const x = await withTenant(ctx, (tx) =>
      explainEntitlementEligibility(tx, {
        employmentId: emp.employmentId,
        leaveTypeId: b.annualLeaveTypeId,
        asOf: ASOF,
      }),
    );
    // BOTH reach this employee — otherwise there is no tie and this case proves nothing.
    expect(x.rules.filter((r) => r.matched).map((r) => r.ruleName).sort()).toEqual([
      'By department',
      'By employment type',
    ]);
    expect(x.winner?.ruleName).toBe('By department');
    expect(x.winner?.specificity).toBe(1);
    expect(x.winner?.alsoMatched.map((r) => r.ruleName)).toEqual(['By employment type']);
    // THE FACT THIS BUILD ADDS: the silent tie-break, named.
    expect(x.winner?.winReason).toBe('later_start');
    // The notice is unchanged in shape, so the employee's own panel keeps working off the same object.
    expect(eligibilityNoticeFrom(x).verdict).toBe('resolved');
  });

  it('a scheme that narrows MORE axes wins on specificity, and says that instead', async () => {
    const ctx = adminCtx(b);
    const broad = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Broad table',
      serviceBands: WON,
      validFrom: '2026-01-01',
    });
    const narrow = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Narrow table',
      serviceBands: WON,
      validFrom: '2026-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'Everyone full time',
      templateLineageId: broad.lineageId,
      criteria: { employmentTypes: ['full_time'] },
      // LATER start than the winner, deliberately: if specificity were not consulted first this rule
      // would win, so a green result here is evidence about the ORDER of the terms and not just the win.
      validFrom: '2026-06-01',
    });
    await createEligibilityRule(ctx, {
      name: 'Full time in Finance',
      templateLineageId: narrow.lineageId,
      criteria: { employmentTypes: ['full_time'], departmentIds: [b.deptA] },
      validFrom: '2026-01-01',
    });
    const emp = await hire(null);

    const x = await withTenant(ctx, (tx) =>
      explainEntitlementEligibility(tx, {
        employmentId: emp.employmentId,
        leaveTypeId: b.annualLeaveTypeId,
        asOf: ASOF,
      }),
    );
    expect(x.winner?.ruleName).toBe('Full time in Finance');
    expect(x.winner?.winReason).toBe('more_specific');
  });

  it('a sole table and a default table carry NO reason: no ranking happened', async () => {
    const ctx = adminCtx(b);
    // ONE table in force and no rule at all ⇒ r193 fault 3, the table applies and nothing was ranked.
    await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'The only table',
      serviceBands: WON,
      validFrom: '2026-01-01',
    });
    const emp = await hire(null);
    const x = await withTenant(ctx, (tx) =>
      explainEntitlementEligibility(tx, {
        employmentId: emp.employmentId,
        leaveTypeId: b.annualLeaveTypeId,
        asOf: ASOF,
      }),
    );
    expect(x.soleTableApplies).toBe(true);
    expect(x.winner?.winReason).toBeNull();
  });
});
