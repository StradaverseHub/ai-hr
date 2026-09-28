/**
 * r351, item 04b88724 — THE QUALIFYING FIGURE DESCRIBES THE FAMILY REGISTER, AND THE PROSE AROUND IT
 * DESCRIBES THE KERNEL.
 *
 * ═══ WHAT WAS WRONG ═══
 *
 * `qualifyingChildReliefFor` priced BOTH of its branches from stored columns — the head-count branch from
 * `num_children`, the grid branch from `child_relief_table`. Both are written by one function,
 * `syncChildReliefFromFamily`, which fires on a family add / materialise / update / archive and on a
 * backfill script, and on NOTHING ELSE. Nothing fires on the passage of time. So:
 *
 *   · a child who turned 18 and is not in further education stayed in the tax figure indefinitely;
 *   · the Family tab, which recomputes eligibility on every render, said "No" about the same child the
 *     Bank & Statutory tab was still counting — and did so against a DIFFERENT calendar date, because the
 *     column used the `new Date()` parameter default while the card resolves `todayInKualaLumpur()`;
 *   · "How the qualifying count was reached" could print one row worth 1 under a stated total of 2;
 *   · and the sentence offered when there was nothing to itemise opened "No children are recorded in the
 *     Family register" — told to a reporter who was looking at their children on the next tab.
 *
 * ═══ WHAT THIS FILE PINS, AND WHAT IT DELIBERATELY DOES NOT ═══
 *
 * The arithmetic is pinned against the database in test/qualifying-child-relief-04b88724.test.ts and the
 * render in test/identity-tax-qualifying-children-04b88724.dom.test.tsx. THIS file pins the two things
 * only a whole-repo read can see: that the catalogue retired the false sentences rather than deleting
 * them, in all six locales; and that the structural decisions — one date, one completeness gate, the
 * register and not the column — are still in the source that a later round would have to change on purpose.
 *
 * ⚠️ RETIRED, NOT DELETED. `i18n/request.ts` deep-merges each locale over English, so dropping a key from
 * en.json alone leaves the old sentence rendering for a Malay reader — the worst possible half-fix, and the
 * one this convention exists to stop. Every retired key keeps its slot in every locale with a
 * `[retired rNNN — …]` value, and the screen must reference none of them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = (p: string) => readFileSync(`${root}${p}`, 'utf8');
const detailOf = (loc: string) =>
  (JSON.parse(src(`messages/${loc}.json`)) as Record<string, any>).people.detail as Record<string, any>;

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
/** The sentences this round found to be false, and the key that replaced each. */
const RETIRED = ['childQualifyingBreakdownUnsupported', 'childQualifyingStaleFamily'] as const;
/** What the card renders instead. Every one carries a statement that is true of every case reaching it. */
const NEW_KEYS = [
  'childQualifyingBreakdownUnitemised',
  'childQualifyingPayrollBehind',
  'childQualifyingNoneEligible',
  'childQualifyingNoDob',
] as const;

const CARD = 'components/identity-tax-card.tsx';
const PAGE = 'app/admin/personnel/[employmentId]/page.tsx';
const DEPS = 'core/dependents.ts';

describe('r351 · the false sentences are retired in all six locales, not deleted', () => {
  it.each(LOCALES)('%s marks both retired keys rather than dropping them', (loc) => {
    const d = detailOf(loc);
    for (const k of RETIRED) {
      expect(Object.keys(d), `${loc} dropped ${k} instead of marking it`).toContain(k);
      expect(d[k], `${loc}.${k} must be retired, not live`).toMatch(/^\[retired r351/);
    }
  });

  it('the retirement notes say what replaced each key and why, so the next reader need not dig', () => {
    const d = detailOf('en');
    expect(d.childQualifyingBreakdownUnsupported).toContain('childQualifyingBreakdownUnitemised');
    expect(
      d.childQualifyingBreakdownUnsupported,
      'the reason is the point: it rendered on a row count, not on whether children exist',
    ).toMatch(/row count/i);
    expect(d.childQualifyingStaleFamily).toContain('childQualifyingPayrollBehind');
    expect(d.childQualifyingStaleFamily, 'and this one missed the grid entirely').toMatch(/grid/i);
  });

  it('no screen references a retired key — a marked key still renders if something asks for it', () => {
    for (const f of [CARD, PAGE]) {
      for (const k of RETIRED) {
        expect(src(f), `${f} still renders the retired ${k}`).not.toContain(`'${k}'`);
      }
    }
  });
});

describe('r351 · the replacement sentences exist, and are translated rather than copied', () => {
  it.each(LOCALES)('%s carries every new key, non-empty and not itself retired', (loc) => {
    const d = detailOf(loc);
    for (const k of NEW_KEYS) {
      expect(typeof d[k], `${loc}.${k} missing`).toBe('string');
      expect((d[k] as string).trim(), `${loc}.${k} is blank`).not.toBe('');
      expect(d[k], `${loc}.${k} must not be a retirement marker`).not.toMatch(/^\[retired/);
    }
  });

  it.each(LOCALES.filter((l) => l !== 'en'))('%s is a real translation, not the English string', (loc) => {
    const en = detailOf('en');
    const d = detailOf(loc);
    for (const k of NEW_KEYS) {
      expect(d[k], `${loc}.${k} is an untranslated copy of English`).not.toBe(en[k]);
    }
  });

  it.each(LOCALES)('%s keeps every ICU placeholder the card supplies, and invents none', (loc) => {
    // A dropped placeholder silently loses a figure; an invented one renders as literal braces on screen.
    const EXPECTED: Record<string, string[]> = {
      childQualifyingBreakdownUnitemised: ['amount'],
      childQualifyingPayrollBehind: ['storedAmount', 'storedCount', 'amount', 'count', 'date'],
      childQualifyingNoneEligible: ['count', 'date'],
      childQualifyingNoDob: ['count', 'names'],
    };
    const d = detailOf(loc);
    for (const [k, want] of Object.entries(EXPECTED)) {
      const got = [...new Set([...(d[k] as string).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
      expect(got, `${loc}.${k} placeholders`).toEqual([...want].sort());
    }
  });

  it('the replacement for the false sentence no longer claims the register is empty', () => {
    // The whole defect in one assertion: the reporter was told there were no children on a record that had
    // two. Whatever the wording becomes, it may not make a claim about the register it cannot know.
    expect(detailOf('en').childQualifyingBreakdownUnitemised).not.toMatch(/no children are recorded/i);
  });
});

describe('r351 · the figure is taken from the register, at one date, through one gate', () => {
  it('the auto modes price from the REGISTER, not from the stored columns', () => {
    const s = src(DEPS);
    expect(s, 'the grid is derived from the family rows, not read back out of the column').toContain(
      'const derivedGrid = derivedChildReliefGrid(family, asOfDate)',
    );
    expect(s, "'auto' prices the derived grid; the other modes keep the stored one").toContain(
      "const pricingTable = mode === 'auto' ? derivedGrid : statutory.childReliefTable",
    );
    expect(s, "'auto' counts the eligible children; the other modes keep num_children").toContain(
      "const pricingHeadCount = mode === 'auto' ? eligible.length : physicalChildren",
    );
  });

  it('…and the figure the payslip deducts is STILL returned, so the card can never print one alone', () => {
    // r340's rule, kept through the reversal. The card shows the register's figure; it must name this one
    // in the same fieldset, or the round has simply swapped which of the two numbers is hidden.
    const s = src(DEPS);
    expect(s).toContain('storedQualifyingChildren: stored.units');
    expect(s).toContain('storedReliefRM: stored.amountRM');
    expect(s, 'and it is the kernel expression over the STORED columns').toContain(
      'childReliefTable: statutory.childReliefTable,',
    );
    expect(src(CARD), 'the amber line is keyed on the money, not on head counts').toContain(
      'Math.abs(childRelief.storedReliefRM - childRelief.reliefRM)',
    );
  });

  it('num_children is NOT repurposed — the three annual readers still take it as a head count', () => {
    // The r343 decision. This round makes the column a projection; it does not change what it means, and
    // the warning block that explains why must survive with it.
    const s = src(DEPS);
    expect(s).toContain('numChildren: state.derived');
    expect(s, 'the warning naming the three readers is still on eligibleChildReliefCount').toMatch(
      /THIS STAYS A HEAD COUNT ON PURPOSE/,
    );
    expect(s).toMatch(/Form E \/ CP8D/);
  });

  it('one completeness gate, shared by the sync and the screen', () => {
    const s = src(DEPS);
    expect(s, 'the gate is a function now, not an expression copied into the sync').toContain(
      'export function derivedChildReliefGrid(',
    );
    expect(s, 'and it is what the sync stores').toContain('const grid = derivedChildReliefGrid(rows, asOf)');
    // Unchanged from r344, and not loosened by this round: a partial grid relieves fewer children than the
    // employee has, so an unclassifiable register falls back to the head count rather than pricing badly.
    expect(s).toContain('built.categorised === built.eligible');
    expect(s).toContain('? built.grid : null');
  });

  it('every date is the tenant’s calendar day — the sync included, which it was not', () => {
    const s = src(DEPS);
    expect(s, 'the sync takes its own KL date instead of the new Date() default').toContain(
      'const asOf = new Date(`${todayInKualaLumpur()}T00:00:00Z`)',
    );
    expect(s, 'and both derivations are taken against it').toContain('eligibleChildReliefCount(rows, asOf)');
    // The Family tab was the other half of the same defect: its Age and relief columns took real UTC now
    // while the card beside them took KL today, so the two tabs disagreed for eight hours a day.
    const page = src(PAGE);
    expect(page).toContain('const familyAsOf = new Date(`${today}T00:00:00Z`)');
    expect(page, 'no bare eligibility call may come back').not.toContain('isChildReliefEligible(d)');
    expect(page, 'nor a bare age call').not.toContain('childAgeYears(d.dateOfBirth)');
  });

  it('a save in auto mode posts the DERIVED grid, so the amber line’s promise is true for both branches', () => {
    // It used to re-post the stored grid verbatim out of hidden inputs, which made "saving brings the tax
    // figure back in step" true for the head count and false for anyone priced from a grid.
    expect(src(CARD)).toContain("mode === 'auto' && childRelief");
    expect(src(CARD)).toContain('childRelief.derivedGrid?.[key]');
  });
});

describe('r351 · the prose that outlived the kernel is corrected where it sat', () => {
  it('localization/my/statutory.ts no longer says auto applies children × perChild', () => {
    // False since a5f21891 (r344) widened the three money paths to price a derived grid on 'auto' — and
    // core/dependents.ts cited THIS sentence as its authority, so one stale comment propped up another.
    const s = src('localization/my/statutory.ts');
    expect(s).not.toContain('payroll still applies children × perChild');
    expect(s).not.toContain('Payroll always reads num_children as the head count regardless of mode.');
    expect(s, 'what survives is the claim that is still true, about the ANNUAL readers').toMatch(
      /the three ANNUAL readers[\s\S]{0,120}read num_children as a plain head count/,
    );
    expect(s, "and 'auto' is now described as pricing the derived grid").toMatch(
      /Payroll prices the DERIVED GRID/,
    );
  });

  it('core/payroll.ts no longer describes the gate it replaced', () => {
    const s = src('core/payroll.ts');
    // ⚠️ THE OLD SENTENCE IS STILL IN THE FILE ON PURPOSE, INSIDE QUOTATION MARKS, as the record of what it
    // used to say — CLAUDE.md's rule for a guard that greps a corrected comment: reword the quoted
    // specifier, never assert its absence, or the correction itself trips the guard. So what is pinned is
    // the correction: the block must carry the r351 marker and must describe the predicate the line below
    // it actually reads, and it must not make the old claim OUTSIDE the quotation.
    expect(s, 'the comment records that it was corrected and when').toMatch(
      /r351 — THIS COMMENT CONTRADICTED THE LINE DIRECTLY BELOW IT/,
    );
    expect(s, 'and it names the predicate the gate reads').toMatch(
      /supplies a worked-out amount when\s*\n?\s*\/\/ `pricesChildReliefFromGrid`/,
    );
    // The gate itself is the shared predicate, in this file and in the other two money paths.
    for (const f of ['core/payroll.ts', 'core/payroll-view.ts', 'localization/my/multicycle-worksheet.ts']) {
      expect(src(f), `${f} reads the one predicate`).toContain('pricesChildReliefFromGrid');
    }
  });

  it('the auto-sync note no longer calls the eligible count the figure that feeds PCB', () => {
    // `num_children` (and, since r344, `child_relief_table`) is what feeds PCB; this count is what the next
    // write puts there. And "updates on its own" was only ever true of a family edit.
    const d = detailOf('en');
    expect(d.childReliefAutoSyncNote).not.toMatch(/This figure feeds PCB/i);
    expect(d.childReliefAutoSyncNote, 'it names the trigger it really has').toMatch(/added, edited or removed/i);
    expect(d.childReliefAutoSyncNote, 'and says what does NOT move it').toMatch(/18/);
  });
});
