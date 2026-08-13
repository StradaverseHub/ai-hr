/**
 * Replacement Leave's configurable COLUMNS (feedback 00307068) — a second closed key set, resolved by
 * leave-type code.
 *
 * WHAT THIS GUARDS. ed17a4f9 spent an entire item collapsing three overlapping key sets into ONE, so that
 * HR could never annotate an item the employee does not see and the configuration screen could never list a
 * row the summary does not render. This item adds a second set, and the only reason that is not a
 * regression of ed17a4f9 is that the sets are resolved BY TYPE and cannot leak into one another. If they
 * ever can, ed17a4f9's complaint comes straight back — HR ticking "Approval Date" on Annual Leave, where it
 * names nothing and renders as an unexplained blank.
 *
 * So the property asserted here is the two-way one, stated per type: every key configurable for a type is a
 * thing that type's panel renders, and every thing it renders is configurable — and a key from the other
 * type's set is REFUSED rather than silently stored.
 *
 * @see test/leave-ess-view-config.test.ts — the same property for the nine summary keys, which this file
 *      deliberately does not restate.
 */
import { describe, expect, it } from 'vitest';
import {
  ESS_VIEW_COMPONENT_KEYS,
  REPLACEMENT_COLUMN_KEYS,
  essViewKeysForCode,
  isEssViewComponentKey,
  isEssViewComponentKeyForCode,
  isReplacementLeaveCode,
  isReplacementLeaveType,
  resolveEssViewForCode,
} from '../core/ess-view';
import {
  LEAVE_EXPLANATION_KEYS,
  isLeaveExplanationKeyForCode,
  normalizeLeaveFormulaConfig,
  resolveLeaveFormulaForCode,
} from '../core/leave-formula';

describe('the Replacement Leave columns', () => {
  it('are exactly the reporter’s columns, in the table’s display order', () => {
    // 5ff7daff APPENDED `remaining` — "how much of THIS credit is still unused", the fourth column the
    // reporter listed and the only one that was missing. The other five keep their names and their order:
    // this case pins the ORDER, and the order is the table's own left-to-right reading order.
    expect([...REPLACEMENT_COLUMN_KEYS]).toEqual([
      'requestDate',
      'number',
      'unit',
      'approvalDate',
      'expiredDate',
      'remaining',
    ]);
  });

  it('name the unused-amount column `remaining`, NOT `available` — the sets must stay disjoint', () => {
    // `available` is one of the nine summary keys. Naming the new column that would collide the two sets
    // and re-open exactly what ed17a4f9 spent an item closing: HR ticking one thing and configuring another.
    expect((REPLACEMENT_COLUMN_KEYS as readonly string[])).toContain('remaining');
    expect((REPLACEMENT_COLUMN_KEYS as readonly string[])).not.toContain('available');
    expect((ESS_VIEW_COMPONENT_KEYS as readonly string[])).toContain('available');
  });

  it('do not overlap the nine Leave Summary keys in either direction', () => {
    const nine = new Set<string>(ESS_VIEW_COMPONENT_KEYS);
    for (const k of REPLACEMENT_COLUMN_KEYS) expect(nine.has(k), `${k} must not be a summary key`).toBe(false);
    const five = new Set<string>(REPLACEMENT_COLUMN_KEYS);
    for (const k of ESS_VIEW_COMPONENT_KEYS) expect(five.has(k), `${k} must not be a column key`).toBe(false);
  });

  it('leave the nine summary keys byte-identical — nothing was widened or removed', () => {
    expect([...ESS_VIEW_COMPONENT_KEYS]).toEqual([
      'eligible',
      'ytdEntitled',
      'broughtForward',
      'adjustment',
      'total',
      'taken',
      'pendingApproval',
      'forfeited',
      'available',
    ]);
    // ed17a4f9's identity survives: the explanation keys ARE the ess-view keys for a normal type.
    expect([...LEAVE_EXPLANATION_KEYS]).toEqual([...ESS_VIEW_COMPONENT_KEYS]);
    // …and the un-scoped predicate still answers about the nine, so every existing caller is unchanged.
    expect(isEssViewComponentKey('taken')).toBe(true);
    expect(isEssViewComponentKey('approvalDate')).toBe(false);
  });
});

describe('resolution BY LEAVE TYPE CODE', () => {
  it('recognises the replacement code case-insensitively and nothing else', () => {
    expect(isReplacementLeaveCode('REPLACEMENT')).toBe(true);
    expect(isReplacementLeaveCode('replacement')).toBe(true);
    expect(isReplacementLeaveCode(' Replacement ')).toBe(true);
    expect(isReplacementLeaveCode('ANNUAL')).toBe(false);
    expect(isReplacementLeaveCode('REPLACEMENT_LEAVE')).toBe(false); // a different type, not a prefix match
    expect(isReplacementLeaveCode(null)).toBe(false);
    expect(isReplacementLeaveCode(undefined)).toBe(false);
  });

  it('hands each type its own key set', () => {
    expect([...essViewKeysForCode('REPLACEMENT')]).toEqual([...REPLACEMENT_COLUMN_KEYS]);
    expect([...essViewKeysForCode('ANNUAL')]).toEqual([...ESS_VIEW_COMPONENT_KEYS]);
    // An unconfigured / unknown code gets the nine — the default every type had before this item.
    expect([...essViewKeysForCode(null)]).toEqual([...ESS_VIEW_COMPONENT_KEYS]);
  });

  // ── 5ff7daff — the ROLE marker, and why the code alone was never enough ──────────────────────────────
  it('resolves by ROLE first, so a tenant whose replacement type is coded RL still gets its columns', () => {
    // This is production. The customer's own type is `RL`, marked `role = 'replacement'`; every comparison
    // in this module was silently false for it, which is how the tenant ended up with TWO Replacement Leave
    // cards — theirs (matching nothing) and an auto-created one (matching, and holding every credit).
    const rl = { role: 'replacement', code: 'RL' };
    expect(isReplacementLeaveType(rl)).toBe(true);
    expect([...essViewKeysForCode(rl)]).toEqual([...REPLACEMENT_COLUMN_KEYS]);
    expect(isEssViewComponentKeyForCode(rl, 'expiredDate')).toBe(true);
    expect(isEssViewComponentKeyForCode(rl, 'ytdEntitled')).toBe(false);
    expect(Object.keys(resolveEssViewForCode(rl, null)).sort()).toEqual([...REPLACEMENT_COLUMN_KEYS].sort());
  });

  it('a ROLE that is not replacement wins over a code that looks like one', () => {
    // Role wins outright when set — the same precedence as leaveTypeIs. A type someone classified as annual
    // is annual, whatever its code says.
    expect(isReplacementLeaveType({ role: 'annual', code: 'REPLACEMENT' })).toBe(false);
    expect([...essViewKeysForCode({ role: 'annual', code: 'REPLACEMENT' })]).toEqual([...ESS_VIEW_COMPONENT_KEYS]);
  });

  it('an UNCLASSIFIED row falls back to the seeded code — nothing changed for tenants nobody classified', () => {
    expect(isReplacementLeaveType({ role: null, code: 'REPLACEMENT' })).toBe(true);
    expect(isReplacementLeaveType({ role: '', code: 'REPLACEMENT' })).toBe(true);
    expect(isReplacementLeaveType({ role: null, code: 'RL' })).toBe(false);
    // …and the bare-string form (every pre-5ff7daff caller) is byte-identical to the code-only predicate.
    expect(isReplacementLeaveType('REPLACEMENT')).toBe(isReplacementLeaveCode('REPLACEMENT'));
    expect(isReplacementLeaveType('ANNUAL')).toBe(isReplacementLeaveCode('ANNUAL'));
    expect(isReplacementLeaveType(null)).toBe(false);
  });

  it('REFUSES a key from the other type’s set — the anti-leak guard', () => {
    // A replacement column on a normal type would name nothing on its summary.
    expect(isEssViewComponentKeyForCode('ANNUAL', 'approvalDate')).toBe(false);
    expect(isLeaveExplanationKeyForCode('ANNUAL', 'expiredDate')).toBe(false);
    // A summary row on Replacement Leave would name nothing on its table.
    expect(isEssViewComponentKeyForCode('REPLACEMENT', 'ytdEntitled')).toBe(false);
    expect(isLeaveExplanationKeyForCode('REPLACEMENT', 'forfeited')).toBe(false);
    // Each set is accepted for its OWN type.
    expect(isEssViewComponentKeyForCode('REPLACEMENT', 'requestDate')).toBe(true);
    expect(isEssViewComponentKeyForCode('ANNUAL', 'available')).toBe(true);
  });
});

describe('write-time validation cannot store a mismatched key', () => {
  it('accepts a column explanation for REPLACEMENT', () => {
    const out = normalizeLeaveFormulaConfig({ expiredDate: { description: '  Counted from approval.  ' } } as never, 'REPLACEMENT');
    expect(out).toEqual({ expiredDate: { description: 'Counted from approval.' } });
  });

  it('throws for the same key on any other type — and with no code at all', () => {
    expect(() => normalizeLeaveFormulaConfig({ expiredDate: { description: 'x' } } as never, 'ANNUAL')).toThrow(
      /Unknown leave-formula component key: expiredDate/,
    );
    // Omitting `code` keeps the pre-00307068 behaviour exactly: the nine, and nothing else.
    expect(() => normalizeLeaveFormulaConfig({ expiredDate: { description: 'x' } } as never)).toThrow(
      /Unknown leave-formula component key/,
    );
  });

  it('throws for a summary key on REPLACEMENT', () => {
    expect(() => normalizeLeaveFormulaConfig({ taken: { description: 'x' } }, 'REPLACEMENT')).toThrow(
      /Unknown leave-formula component key: taken/,
    );
  });

  it('still normalises exactly as before for a normal type (trim, drop blanks, empty ⇒ null)', () => {
    expect(normalizeLeaveFormulaConfig({ taken: { description: '  used  ', formula: '   ' } }, 'ANNUAL')).toEqual({
      taken: { description: 'used' },
    });
    expect(normalizeLeaveFormulaConfig({ taken: { description: '   ' } }, 'ANNUAL')).toBeNull();
  });
});

describe('read-time resolution never throws on the other set’s stored data', () => {
  it('resolves exactly the five columns for REPLACEMENT and ignores stored summary keys', () => {
    const resolved = resolveLeaveFormulaForCode('REPLACEMENT', {
      requestDate: { description: 'When you asked.' },
      taken: { description: 'legacy content under a summary key' },
    });
    expect(Object.keys(resolved).sort()).toEqual([...REPLACEMENT_COLUMN_KEYS].sort());
    expect(resolved.requestDate).toEqual({ description: 'When you asked.' });
    expect(resolved.number).toBeNull();
  });

  it('resolves exactly the nine summary items for any other type and ignores stored column keys', () => {
    const resolved = resolveLeaveFormulaForCode('ANNUAL', {
      taken: { description: 'Days used.' },
      expiredDate: { description: 'a column key that must not surface here' },
    });
    expect(Object.keys(resolved).sort()).toEqual([...ESS_VIEW_COMPONENT_KEYS].sort());
    expect(resolved.taken).toEqual({ description: 'Days used.' });
  });

  it('visibility resolves per type with the same missing-⇒-visible default', () => {
    const rl = resolveEssViewForCode('REPLACEMENT', { approvalDate: false });
    expect(Object.keys(rl).sort()).toEqual([...REPLACEMENT_COLUMN_KEYS].sort());
    expect(rl.approvalDate).toBe(false);
    expect(rl.requestDate).toBe(true); // missing ⇒ visible
    const annual = resolveEssViewForCode('ANNUAL', null);
    expect(Object.keys(annual).sort()).toEqual([...ESS_VIEW_COMPONENT_KEYS].sort());
    for (const k of ESS_VIEW_COMPONENT_KEYS) expect(annual[k]).toBe(true);
  });
});
