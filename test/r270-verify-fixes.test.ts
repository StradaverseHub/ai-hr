import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { beatsEligibility, winReasonFor, type EligibilityRuleRow } from '@/core/entitlement-template';

/**
 * r270 FIX PASS — the four defects the adversarial verify found after both build agents reported green.
 *
 * Each one passed every guard the builders wrote, and three of them put a FALSE STATEMENT on a screen.
 * The lesson worth keeping is in what the original guards measured: they all pinned that a thing was
 * rendered, and none pinned that what it said was true.
 */

const BLOCK = 'app/admin/leave/entitlements/templates/entitlement-tables-block.tsx';
const PANEL = 'app/admin/leave/entitlements/templates/eligibility-explain.tsx';
const CORE = 'core/entitlement-template.ts';
const read = (p: string) => readFileSync(p, 'utf8');

const ruleRow = (over: Partial<EligibilityRuleRow>): EligibilityRuleRow =>
  ({
    id: 'r1',
    lineageId: 'l1',
    name: 'A scheme',
    templateLineageId: 't1',
    criteria: {},
    validFrom: '2026-01-01',
    validTo: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  }) as EligibilityRuleRow;

describe('D1 · a tie on every term is not a reason, and must not be reported as one', () => {
  it('two rules that tie on ALL THREE terms separate NOTHING, and the reason says so', () => {
    const a = ruleRow({ id: 'a', criteria: { departmentIds: ['d1'] } });
    const b = ruleRow({ id: 'b', criteria: { employmentTypes: ['full_time'] } });
    // The coupling that was missing. Same narrowed-axis count, same start date, same creation instant:
    // `beatsEligibility` is false in BOTH directions, so the comparator returned 0 and the winner was
    // whatever the query yielded first. Nothing ranked anything.
    expect(beatsEligibility(a, b), 'a must not beat b').toBe(false);
    expect(beatsEligibility(b, a), 'and b must not beat a').toBe(false);
    // The first cut fell through to 'later_created' here, and the screen printed "the one set up most
    // recently wins" over two schemes created in the same instant.
    expect(winReasonFor(a, b)).toBe('arbitrary');
  });

  it('and a REAL difference in creation time is still reported as one', () => {
    const a = ruleRow({ id: 'a', criteria: { departmentIds: ['d1'] }, createdAt: new Date('2026-02-02T00:00:00Z') });
    const b = ruleRow({ id: 'b', criteria: { employmentTypes: ['full_time'] } });
    expect(beatsEligibility(a, b)).toBe(true);
    expect(winReasonFor(a, b)).toBe('later_created');
  });

  it('the arbitrary case gets its OWN string — sharing one would reintroduce the false claim', () => {
    const panel = read(PANEL);
    expect(panel).toContain("arbitrary: 'explainWhyChosenArbitrary'");
    // `later_created` may keep sharing with `later_start`; `arbitrary` may not share with either.
    expect(panel).not.toMatch(/arbitrary: 'explainWhyChosenLater'/);
  });

  it('the rule query is ORDERED, so the undecided case is at least the same answer twice', () => {
    const core = read(CORE);
    // Anchored inside the RESOLVER's query — `.from(entitlementEligibilityRule)` appears a dozen times
    // in this file, so a bare indexOf pins whichever one happens to come first.
    const resolver = core.indexOf('buildTemplateEntitlementResolver');
    expect(resolver, 'the resolver must exist').toBeGreaterThan(-1);
    const orderBy = core.indexOf('.orderBy(entitlementEligibilityRule.createdAt, entitlementEligibilityRule.id)');
    expect(orderBy, 'the rule query must be ordered').toBeGreaterThan(resolver);
  });
});

describe('D2 · the grid shows what is in force TODAY, not what is merely unsuperseded', () => {
  it('the grid reads a date-filtered set, and it is not the open-version set', () => {
    const block = read(BLOCK);
    // The defect: `running` is `validTo == null`, which for a future-dated supersede is NEXT year's
    // version. The grid printed it as today's entitlement and hid the one actually deciding pay.
    expect(block).toMatch(/const inForceTemplates = templates\.filter\(/);
    expect(block).toContain('x.validFrom <= today && (x.validTo == null || x.validTo > today)');
    const call = block.indexOf('entitlementGridRows({');
    expect(call).toBeGreaterThan(-1);
    const args = block.slice(call, call + 400);
    expect(args, 'the grid must be fed the in-force set').toContain('running: [...inForceTemplates]');
    expect(args, 'and not the open-version set').not.toContain('running: [...running]');
  });
});

describe('D3 · one table, described one way', () => {
  it('the Covers cell consults the sole-table set instead of claiming nothing reaches it', () => {
    const block = read(BLOCK);
    // With one table in force and no scheme, the resolver hands it to EVERYBODY. The cell used to print
    // "No benefit scheme names this table" — read as nobody — while the grid said "Everyone".
    const cell = block.indexOf("t('coversDefaultTable')");
    expect(cell).toBeGreaterThan(-1);
    const region = block.slice(cell, cell + 1800);
    expect(region).toContain('soleTableTypeIds.has(x.leaveTypeId)');
    // Same string as the grid's own everyone-state, so the two cannot drift into two vocabularies.
    expect(region).toContain("t('criteriaEveryone')");
    expect(region).toContain("t('ruleNonePointsHere')");
  });
});

describe('D4 · the grid says what it cannot show', () => {
  it('an overlap note is rendered with the grid, not left for the reader to infer', () => {
    const block = read(BLOCK);
    const title = block.indexOf("t('gridTitle')");
    expect(title).toBeGreaterThan(-1);
    // Immediately under the heading, before the table — a caveat below the rows is a caveat nobody reads.
    expect(block.slice(title, title + 1600)).toContain("t('gridOverlapNote')");
  });
});
