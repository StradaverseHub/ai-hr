/**
 * Employee Status — System-Controlled Lifecycle Management (R43 c26c3ce5). Unit tests for the PURE deriver
 * deriveEmploymentStatus: it computes the displayed status from the lifecycle dates + today with no stored
 * column, so it can never drift. Covers each bucket, the priority order, and boundary dates.
 */
import { describe, expect, it } from 'vitest';
import { deriveEmploymentStatus, EMPLOYMENT_STATUSES } from '../core/employment-status';

const TODAY = '2026-07-15';

describe('deriveEmploymentStatus', () => {
  it('probation — today is before the confirmation date', () => {
    expect(deriveEmploymentStatus({ confirmationDate: '2026-09-01' }, TODAY)).toBe('probation');
  });

  it('probation — uses finalConfirmationDate (extended) over the normal confirmation date', () => {
    // Normal confirmation already passed, but the extended (final) one is still in the future ⇒ still probation.
    expect(
      deriveEmploymentStatus({ confirmationDate: '2026-06-01', finalConfirmationDate: '2026-09-01' }, TODAY),
    ).toBe('probation');
  });

  it('active — past the confirmation date with no resignation recorded', () => {
    expect(deriveEmploymentStatus({ confirmationDate: '2026-03-01' }, TODAY)).toBe('active');
  });

  it('active — no confirmation date recorded at all', () => {
    expect(deriveEmploymentStatus({}, TODAY)).toBe('active');
  });

  it('active_serving_notice — a resignation date is set and today is before it', () => {
    expect(
      deriveEmploymentStatus({ confirmationDate: '2026-03-01', resignationDate: '2026-08-31' }, TODAY),
    ).toBe('active_serving_notice');
  });

  it('active_serving_notice — a future last-working / terminatedOn also counts', () => {
    expect(deriveEmploymentStatus({ lastWorkingDate: '2026-08-01' }, TODAY)).toBe('active_serving_notice');
    expect(deriveEmploymentStatus({ terminatedOn: '2026-08-01' }, TODAY)).toBe('active_serving_notice');
  });

  it('resigned — today is on or after the resignation date', () => {
    expect(deriveEmploymentStatus({ resignationDate: '2026-07-01' }, TODAY)).toBe('resigned');
  });

  it('resigned — today equals the resignation date (boundary is inclusive)', () => {
    expect(deriveEmploymentStatus({ resignationDate: TODAY }, TODAY)).toBe('resigned');
  });

  it('resigned — a past last-working or terminatedOn ends the lifecycle', () => {
    expect(deriveEmploymentStatus({ lastWorkingDate: '2026-01-01' }, TODAY)).toBe('resigned');
    expect(deriveEmploymentStatus({ terminatedOn: '2026-01-01' }, TODAY)).toBe('resigned');
  });

  it('resigned — earliest of the end dates decides (one past date resigns even if another is future)', () => {
    expect(
      deriveEmploymentStatus({ resignationDate: '2026-12-01', lastWorkingDate: '2026-01-01' }, TODAY),
    ).toBe('resigned');
  });

  it('blacklisted — overrides every date-derived bucket', () => {
    // Would be probation by dates, but blacklist wins.
    expect(
      deriveEmploymentStatus({ confirmationDate: '2026-09-01', blacklistedAt: '2026-05-01' }, TODAY),
    ).toBe('blacklisted');
    // Would be resigned by dates, but blacklist still wins.
    expect(
      deriveEmploymentStatus({ resignationDate: '2026-01-01', blacklistedAt: '2026-05-01' }, TODAY),
    ).toBe('blacklisted');
  });

  it('confirmation boundary — on the confirmation date itself the employee is no longer on probation', () => {
    expect(deriveEmploymentStatus({ confirmationDate: TODAY }, TODAY)).toBe('active');
  });

  it('exposes the canonical bucket order for pickers/legends', () => {
    expect(EMPLOYMENT_STATUSES).toEqual(['probation', 'active', 'active_serving_notice', 'resigned', 'blacklisted', 'withhold']);
  });
});
