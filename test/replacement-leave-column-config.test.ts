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
  resolveEssViewForCode,
} from '../core/ess-view';
import {
  LEAVE_EXPLANATION_KEYS,
  isLeaveExplanationKeyForCode,
  normalizeLeaveFormulaConfig,
  resolveLeaveFormulaForCode,
} from '../core/leave-formula';

describe('the five Replacement Leave columns', () => {
  it('are exactly the reporter’s columns, in the table’s display order', () => {
    expect([...REPLACEMENT_COLUMN_KEYS]).toEqual(['requestDate', 'number', 'unit', 'approvalDate', 'expiredDate']);
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
