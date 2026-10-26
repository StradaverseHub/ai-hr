import {describe, expect, it} from 'vitest';
import {DrizzleQueryError} from 'drizzle-orm';
import {isFixtureResetLockError} from './harness-reset-errors';

const wrapped = (code: string) => new DrizzleQueryError('TRUNCATE fixture', [], Object.assign(new Error('PostgreSQL refusal'), {code}));
describe('fixture reset conflict classification', () => {
  it.each(['40P01', '55P03'])('recognizes actual SQLSTATE %s under the ORM wrapper', code => {
    const error = wrapped(code);
    expect(error.message).not.toMatch(/deadlock detected|lock_timeout/);
    expect(isFixtureResetLockError(error)).toBe(true);
  });
  it.each(['23505', '23503', '42501', '57014'])('never retries unrelated SQLSTATE %s', code => {
    expect(isFixtureResetLockError(wrapped(code))).toBe(false);
  });
  it('does not turn SQL words or a test timeout into a recoverable lock error', () => {
    expect(isFixtureResetLockError(Object.assign(new Error('deadlock detected'), {code: '23505'}))).toBe(false);
    expect(isFixtureResetLockError(new Error('Hook timed out in 30000ms'))).toBe(false);
  });
  it('refuses unknown and cyclic causes', () => {
    const error: {cause?: unknown} = {}; error.cause = error;
    expect(isFixtureResetLockError(error)).toBe(false);
    expect(isFixtureResetLockError(null)).toBe(false);
  });
});
