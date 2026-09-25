/**
 * Item 7da0a4e7 (r340) — ONE NAME PER LEAVE FIGURE, AND THE TWO THAT MUST KEEP DIFFERENT NAMES.
 *
 * The reporter read My Leave and the Employee Balances table side by side and found the same number
 * carrying different names: "You can apply for", "Accrued", "Available Balance". They asked for a shared
 * constant so the names cannot drift apart again.
 *
 * ── WHAT THIS FILE PINS, AND WHY EACH PART EARNS ITS PLACE ──────────────────────────────────────────
 * (a) the dictionary is INJECTIVE — two figures can never resolve to one name, which is the failure the
 *     reporter is asking to be protected from, running in the other direction;
 * (b) every locale carries every key, because `i18n/request.ts` deep-merges each locale over English and
 *     a missing key renders the English silently rather than failing;
 * (c) `available` and `balance` READ DIFFERENTLY IN ALL SIX — this is the plan's challenge, pinned.
 *     core/read.ts:3012 records that they answer different questions: `balance` is "what does this code
 *     hold" (nothing, for a borrower) and `available` is "how much can this person still book" (the
 *     pool's). The reporter's original request would have pointed one label at both, which is a
 *     correctness change wearing a label change's clothes. They approved the plan that declined it;
 * (d) no surface that prints one of these three figures reaches past the dictionary for its label.
 *
 * NO KEY IS DELETED BY THIS ITEM. `me.leaveBalanceTable.colAccrued` and `leave.myLeave.canApplyFor`
 * survive as retired keys: the deep merge means a key dropped from `en` but left in `ms` still renders,
 * so removing one safely means asserting its absence in all six, and the cheap, safe move is to leave
 * them alone.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEAVE_FIGURE_LABEL_KEY, LEAVE_FIGURE_NS, type LeaveFigure } from '../lib/leave-figure-labels';

const root = fileURLToPath(new URL('..', import.meta.url));
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

const catalogue = (loc: string) =>
  JSON.parse(readFileSync(new URL(`messages/${loc}.json`, `file://${root}`), 'utf8')) as Record<string, unknown>;

const labelOf = (loc: string, figure: LeaveFigure): string => {
  const ns = catalogue(loc)[LEAVE_FIGURE_NS] as Record<string, string> | undefined;
  return ns?.[LEAVE_FIGURE_LABEL_KEY[figure]] ?? '';
};

const src = (p: string) => readFileSync(new URL(p, `file://${root}`), 'utf8');

const FIGURES = Object.keys(LEAVE_FIGURE_LABEL_KEY) as LeaveFigure[];

// ─── (a) The dictionary itself ───────────────────────────────────────────────────────────────────────

describe('7da0a4e7 · (a) one figure, one name — and never one name for two figures', () => {
  it('every figure maps to exactly one key', () => {
    for (const f of FIGURES) expect(LEAVE_FIGURE_LABEL_KEY[f], f).toBeTruthy();
  });

  it('NO TWO FIGURES SHARE A KEY — a collision would silently merge two different numbers into one name', () => {
    const keys = FIGURES.map((f) => LEAVE_FIGURE_LABEL_KEY[f]);
    expect(new Set(keys).size, `keys: ${keys.join(', ')}`).toBe(keys.length);
  });
});

// ─── (b) Every locale carries every key ──────────────────────────────────────────────────────────────

describe('7da0a4e7 · (b) all six catalogues carry all three names', () => {
  for (const loc of LOCALES) {
    it(`${loc} carries every figure label, non-empty`, () => {
      for (const f of FIGURES) {
        expect(labelOf(loc, f), `${loc}.${LEAVE_FIGURE_NS}.${LEAVE_FIGURE_LABEL_KEY[f]}`).toBeTruthy();
      }
    });
  }

  it('the five non-English catalogues are TRANSLATED, not English copies — the labels they adopted already had words', () => {
    // Guards the mistake this item nearly shipped: seeding the shared namespace with English would have
    // replaced five locales' translated column headers with English on a screen that was already localised.
    for (const loc of LOCALES.filter((l) => l !== 'en')) {
      const sameAsEnglish = FIGURES.filter((f) => labelOf(loc, f) === labelOf('en', f));
      expect(sameAsEnglish, `${loc} still shows English for: ${sameAsEnglish.join(', ')}`).toHaveLength(0);
    }
  });
});

// ─── (c) THE CHALLENGE THE REPORTER APPROVED ─────────────────────────────────────────────────────────

describe('7da0a4e7 · (c) `available` and `balance` keep DIFFERENT names, in every locale', () => {
  for (const loc of LOCALES) {
    it(`${loc}: "how much can this person still book" is not the same words as "what does this code hold"`, () => {
      const available = labelOf(loc, 'available');
      const balance = labelOf(loc, 'balance');
      expect(
        available,
        'core/read.ts:3012 — these answer different questions; one label for both is a correctness change',
      ).not.toBe(balance);
    });
  }
});

// ─── (d) No surface reaches past the dictionary ──────────────────────────────────────────────────────

describe('7da0a4e7 · (d) the surfaces that print these figures resolve them through the dictionary', () => {
  const SURFACES = [
    'components/leave/leave-balance-table.tsx',
    'components/leave/my-leave-dashboard.tsx',
    'app/leave/employee-balances/page.tsx',
    'app/leave/employee-balances/export/route.ts',
  ];

  for (const f of SURFACES) {
    it(`${f} imports the dictionary`, () => {
      expect(src(f)).toContain('leave-figure-labels');
    });
  }

  it('My Leave no longer labels a figure with its own private words', () => {
    const s = src('components/leave/my-leave-dashboard.tsx');
    expect(s, '"You can apply for" was this screen\'s own name for `available`').not.toContain("t('canApplyFor')");
    expect(s, '"Earned so far" was this screen\'s own name for `ytdEntitled`').not.toContain("t('earnedSoFar')");
  });

  it('the balance table names its three standardised columns from the dictionary, not from its own labelKey', () => {
    const s = src('components/leave/leave-balance-table.tsx');
    for (const f of FIGURES) expect(s, `column ${f}`).toContain(`figure: '${f}'`);
  });

  it('the EXPORT uses the same names as the screen — the file exports the table that was on screen', () => {
    const s = src('app/leave/employee-balances/export/route.ts');
    expect(s).toContain('LEAVE_FIGURE_LABEL_KEY.ytdEntitled');
    expect(s).toContain('LEAVE_FIGURE_LABEL_KEY.balance');
  });
});
