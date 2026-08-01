/**
 * Feedback 956cec85 — when a monthly statutory submission is due, and where that leaves you today.
 *
 * The forms themselves were ALREADY BUILT (localization/my/reports.ts registers EPF, SOCSO+EIS, CP39/PCB
 * and Form E/CP8D, and they render on Payroll > Reports). What did not exist was the deadline the
 * reporter emphasised in their own answer: "by the 15th of the following month" for all four.
 *
 * Pure — no DB, no pack lookup — so the boundaries are testable directly, and INJECTING `today` is what
 * makes these assertions mean anything: a test that reads the real clock passes all month and proves
 * nothing about the day the status flips.
 */
import { describe, expect, it } from 'vitest';
import { submissionDueFor } from '../core/reporting';

describe('submissionDueFor', () => {
  it('falls on the stated day of the FOLLOWING month', () => {
    expect(submissionDueFor('2026-06', 15, '2026-06-20').dueBy).toBe('2026-07-15');
  });

  it('rolls the year at a December period', () => {
    expect(submissionDueFor('2026-12', 15, '2026-12-31').dueBy).toBe('2027-01-15');
  });

  // Filing ON the deadline is on time. This is the assertion that catches an off-by-one in the
  // comparison, and the one a `>=` would break.
  it('is due, not overdue, ON the deadline itself', () => {
    expect(submissionDueFor('2026-06', 15, '2026-07-15').status).toBe('due_soon');
  });

  it('is overdue the day after', () => {
    expect(submissionDueFor('2026-06', 15, '2026-07-16').status).toBe('overdue');
  });

  it('warns inside the last week, and not before it', () => {
    expect(submissionDueFor('2026-06', 15, '2026-07-08').status).toBe('due_soon');
    expect(submissionDueFor('2026-06', 15, '2026-07-07').status).toBe('upcoming');
  });

  // The annual Form E deadline was never stated to us. An invented statutory date is worse than an
  // absent one — somebody would file against it.
  it('reports unknown rather than guessing when no deadline is established', () => {
    expect(submissionDueFor('2026', null, '2027-01-01')).toEqual({ dueBy: null, status: 'unknown' });
  });

  it('reports unknown for a period that is not a month', () => {
    expect(submissionDueFor('2026', 15, '2026-07-01').status).toBe('unknown');
  });
});
