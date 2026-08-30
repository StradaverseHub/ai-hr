/**
 * ADR-0076 §2.6 — THE ONE PROPERTY THAT LETS AN LLM NEAR A PAYROLL SCREEN.
 *
 * §2.6 promises that "every number in the prose is interpolated from `facts`" and that "no ringgit figure
 * is ever produced by the model". A prompt asking for that is a hope. `narrationIsFaithful` is the check
 * that makes it true, and this file is that check's guard.
 *
 * IT IS TESTED WITHOUT A PROVIDER ON PURPOSE. The interesting failure is not "the model was unavailable",
 * it is "the model wrote a plausible sentence containing a figure nobody can trace". That is a pure
 * function of (prose, facts) and needs no network, so it can be exercised over every shape that matters —
 * which is what makes it worth trusting on a screen where the numbers are somebody's pay.
 *
 * THE ASYMMETRY IS DELIBERATE AND IS ASSERTED IN BOTH DIRECTIONS. A false rejection costs the operator a
 * sentence they never had; a false acceptance puts an untraceable figure in front of them. So the guard
 * leans towards rejecting, and the cases below pin that it still accepts the ordinary honest sentence —
 * a guard that rejected everything would satisfy the safety half while making the feature pointless.
 */
import { describe, expect, it } from 'vitest';
import { narrationIsFaithful } from '../core/payroll-anomaly-narrate';

describe('ADR-0076 §2.6 — a narrative may not contain a figure the facts do not support', () => {
  const OT = { delta: 820, hours: 14, priorHours: 0 };

  it('accepts the ADR’s own worked example', () => {
    // The sentence §2.6 prints as the target output. If the guard rejected this, the feature could not
    // ship its own specification.
    expect(
      narrationIsFaithful(
        'Overtime is RM820 higher than last month; 14 approved OT hours were recorded this cycle versus none last cycle.',
        OT,
      ),
    ).toBe(true);
  });

  it('REJECTS an invented figure, which is the whole point', () => {
    // 15% appears nowhere in the facts. This is the exact failure the guard exists for: a fluent,
    // confident, entirely unsupported number on a payroll screen.
    expect(narrationIsFaithful('Overtime rose by about 15% this cycle.', OT)).toBe(false);
  });

  it('REJECTS a total the model worked out for itself', () => {
    // Arithmetic is the seductive case — 820 + 14 is "derived from the facts" in a sense a reader would
    // never accept. The kernel computes money; the narrator does not, not even by addition.
    expect(narrationIsFaithful('The combined effect is RM834.', OT)).toBe(false);
  });

  it('accepts the same figure written differently', () => {
    // 820.00 and 1,234 are the SAME number to a reader and must be to the guard, or honest prose gets
    // discarded over formatting.
    expect(narrationIsFaithful('The difference is RM820.00.', OT)).toBe(true);
    expect(narrationIsFaithful('Net pay is RM1,234 this cycle.', { net: 1234 })).toBe(true);
    expect(narrationIsFaithful('Net pay is RM1234 this cycle.', { net: '1,234' })).toBe(true);
  });

  it('accepts a part of a compound fact, such as the year in a period', () => {
    // A fact of '2026-08' must license "2026" and "08", or any narrative naming the month is thrown away
    // for being unfaithful when it is precisely faithful.
    expect(narrationIsFaithful('This is the run for August 2026.', { period: '2026-08' })).toBe(true);
  });

  it('accepts prose with no numbers at all', () => {
    // The degenerate honest case: a detector whose facts are categorical.
    expect(narrationIsFaithful('No bank account is recorded for this employee.', { hasBank: 'false' })).toBe(true);
  });

  it('REJECTS a figure that is close to a real one but is not it', () => {
    // The most dangerous shape, because it survives a skim: right order of magnitude, wrong number.
    expect(narrationIsFaithful('Overtime is RM830 higher than last month.', OT)).toBe(false);
  });

  it('is not fooled by a number appearing only in the SENTENCE about another fact', () => {
    // 8 is a digit inside 820, but 8 on its own is not a supported figure — a substring check would let
    // this through, which is why the guard compares whole numeric tokens.
    expect(narrationIsFaithful('There were 8 occurrences this cycle.', OT)).toBe(false);
  });
});
