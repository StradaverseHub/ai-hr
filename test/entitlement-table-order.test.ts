/**
 * 3214cb11 / 813fd22a — THE ORDER ENTITLEMENT TABLES ARE LISTED IN.
 *
 * Pure and DB-free: `lib/entitlement-table-order.ts` derives the order from the name alone, which is the
 * whole point of it (a hardcoded list of the sixteen strings would not generalise to the TEN other leave
 * types that have tables, and would drop a renamed table to the bottom in silence).
 *
 * EVERY NAME IN §1–§3 IS A REAL PRODUCTION NAME, read from `entitlement_template` on 2026-08-13. That
 * matters: the two rules with a trap in them — the (SPECIAL) / bare-SPECIAL split and "GRADE H - 18" —
 * are only exercised by shapes that actually exist, and both were found on production rather than
 * imagined. The inputs are shuffled on the way in so a comparator that happened to preserve the input
 * order could not pass.
 */
import { describe, expect, it } from 'vitest';

import {
  compareEntitlementTableNames,
  compareEntitlementTables,
  entitlementTableSortKey,
} from '../lib/entitlement-table-order';

/** Deterministic shuffle — a fixed reversal-and-interleave, so a failure is always reproducible. */
const shuffled = <T>(xs: readonly T[]): T[] => {
  const out: T[] = [];
  const rest = [...xs];
  while (rest.length) {
    out.push(rest.pop()!);
    if (rest.length) out.push(rest.shift()!);
  }
  return out;
};

const sortNames = (names: readonly string[]) => [...names].sort(compareEntitlementTableNames);

describe('§1 3214cb11 · the reporter’s sixteen Annual Leave tables, in the order they asked for', () => {
  // Verified against production 2026-08-13: these are the 16 running templates on Annual Leave, and the
  // order below is the reporter's list position for position. Their list wrote the last one as
  // "PART TIME"; the stored name is "PART TIMER" and nothing here renames it.
  const EXPECTED = [
    'PERMANENT - GRADE H',
    'PERMANENT - GRADE 12 - 15',
    'PERMANENT - GRADE 16 - 19',
    'PERMANENT - GRADE 20 - 23',
    'CONTRACT - GRADE H',
    'CONTRACT - GRADE 12 - 18',
    'CONTRACT - GRADE >= 19',
    'CONTRACT - SPECIAL (40 AL)',
    'CONTRACT - GRADE H (SPECIAL)',
    'CONTRACT - GRADE 12 - 18 (SPECIAL)',
    'CONTRACT - GRADE >= 19 (SPECIAL)',
    'CONTRACT - GRADE H (RETIREE)',
    'CONTRACT - GRADE 12 - 15 (RETIREE)',
    'CONTRACT - GRADE 16 - 19 (RETIREE)',
    'CONTRACT - GRADE 20 - 23 (RETIREE)',
    'PART TIMER',
  ];

  it('sorts all sixteen into the requested order from a shuffled input', () => {
    expect(sortNames(shuffled(EXPECTED))).toEqual(EXPECTED);
  });

  it('the four families come out as four blocks, not interleaved — the actual complaint', () => {
    // Before this fix the A-to-Z order opened with CONTRACT - GRADE 12 - 15 (RETIREE) and closed with
    // the four PERMANENT tables. Assert the blocks rather than only the full list, so a future change
    // that breaks the grouping fails with a message that says which group moved.
    const sorted = sortNames(shuffled(EXPECTED));
    const familyOf = (n: string) => entitlementTableSortKey(n).family;
    expect(sorted.slice(0, 4).every((n) => familyOf(n) === 1)).toBe(true);
    expect(sorted.slice(4, 15).every((n) => familyOf(n) === 2)).toBe(true);
    expect(sorted[15]).toBe('PART TIMER');
  });

  it('GRADE H LEADS every block — "H sorts after 2" is the other half of the report', () => {
    const sorted = sortNames(shuffled(EXPECTED));
    for (const [block, first] of [
      [sorted.slice(0, 4), 'PERMANENT - GRADE H'],
      [sorted.slice(4, 8), 'CONTRACT - GRADE H'],
      [sorted.slice(8, 11), 'CONTRACT - GRADE H (SPECIAL)'],
      [sorted.slice(11, 15), 'CONTRACT - GRADE H (RETIREE)'],
    ] as const) {
      expect((block as string[])[0]).toBe(first);
    }
  });

  it('"CONTRACT - SPECIAL (40 AL)" stays with the PLAIN contract tables, at position 8', () => {
    // The reporter put it there deliberately. A rule that read a bare "SPECIAL" anywhere in the name
    // would move it into the (SPECIAL) block — this is the case that pins the trailing-marker rule.
    const sorted = sortNames(shuffled(EXPECTED));
    expect(sorted[7]).toBe('CONTRACT - SPECIAL (40 AL)');
    expect(entitlementTableSortKey('CONTRACT - SPECIAL (40 AL)').variant).toBe(0);
    expect(entitlementTableSortKey('CONTRACT - GRADE H (SPECIAL)').variant).toBe(1);
  });
});

describe('§2 3214cb11 · the other leave types inherit the same rule', () => {
  it('the three-name set used by eight leave types orders PERMANENT, SPECIAL, RETIREE', () => {
    // Caregiver, Compassionate, Examination, Graduation, Marriage, Maternity, Paternity and Study all
    // carry exactly these three. Note there is NO parenthetical here — the variant is a bare trailing
    // token. Reading only a trailing parenthetical (as first specified) would tie SPECIAL and RETIREE
    // and the alphabetical fallback would put RETIREE FIRST, which is the wrong way round.
    expect(sortNames(['CONTRACT - RETIREE', 'CONTRACT - SPECIAL', 'PERMANENT'])).toEqual([
      'PERMANENT',
      'CONTRACT - SPECIAL',
      'CONTRACT - RETIREE',
    ]);
  });

  it('Medical Leave’s six tables, including "GRADE H - 18", order sensibly', () => {
    // Production has SIX here, not the three the other types carry. "CONTRACT - GRADE H - 18" is a
    // grade RANGE starting at H, so it leads its block exactly as a bare "GRADE H" does.
    expect(
      sortNames([
        'CONTRACT - SPECIAL (40 AL)',
        'CONTRACT - GRADE >= 19',
        'PERMANENT',
        'CONTRACT - RETIREE',
        'CONTRACT - GRADE H - 18',
        'CONTRACT - SPECIAL',
      ]),
    ).toEqual([
      'PERMANENT',
      'CONTRACT - GRADE H - 18',
      'CONTRACT - GRADE >= 19',
      'CONTRACT - SPECIAL (40 AL)',
      'CONTRACT - SPECIAL',
      'CONTRACT - RETIREE',
    ]);
    expect(entitlementTableSortKey('CONTRACT - GRADE H - 18').grade).toBe(0);
  });
});

describe('§3 3214cb11 · names the rule does not recognise, and names typed loosely', () => {
  it('an unrecognised name sorts AFTER everything recognised, alphabetically among its own', () => {
    // "ALL" is real — it is Hospitalization Leave's only table. The other two are invented to prove the
    // fallback is alphabetical rather than input-ordered.
    expect(sortNames(['ZZZ TABLE', 'PERMANENT', 'Executive', 'ALL', 'CONTRACT - RETIREE'])).toEqual([
      'PERMANENT',
      'CONTRACT - RETIREE',
      'ALL',
      'Executive',
      'ZZZ TABLE',
    ]);
  });

  it('matching is case-insensitive and tolerant of spacing — these names are free text', () => {
    // HR types them. "permanent  -  grade   h" must rank identically to "PERMANENT - GRADE H".
    const loose = entitlementTableSortKey('permanent  -  grade   h');
    const tidy = entitlementTableSortKey('PERMANENT - GRADE H');
    expect(loose).toEqual(tidy);
    expect(sortNames(['contract - grade 20 - 23 (retiree)', 'Permanent - Grade H'])).toEqual([
      'Permanent - Grade H',
      'contract - grade 20 - 23 (retiree)',
    ]);
  });

  it('"PART TIME" and "PART TIMER" rank the same — we are not renaming anything', () => {
    expect(entitlementTableSortKey('PART TIME').family).toBe(3);
    expect(entitlementTableSortKey('PART TIMER').family).toBe(3);
  });
});

describe('§4 3214cb11 · versions of ONE lineage stay in date order under their shared name', () => {
  it('validFrom ascending breaks the tie between two versions of the same table', () => {
    // The dated-supersede model means one name legitimately appears more than once. Ordering by name
    // alone would leave those two in whatever order the query returned.
    const rows = [
      { name: 'PERMANENT - GRADE H', validFrom: '2026-08-01' },
      { name: 'CONTRACT - GRADE H', validFrom: '2026-01-01' },
      { name: 'PERMANENT - GRADE H', validFrom: '2025-01-01' },
    ];
    expect([...rows].sort(compareEntitlementTables)).toEqual([
      { name: 'PERMANENT - GRADE H', validFrom: '2025-01-01' },
      { name: 'PERMANENT - GRADE H', validFrom: '2026-08-01' },
      { name: 'CONTRACT - GRADE H', validFrom: '2026-01-01' },
    ]);
  });
});
