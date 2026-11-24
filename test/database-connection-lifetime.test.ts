/** How long the application pool keeps a database connection (db/capacity.ts, ADR 0181 Phase 1). */
import {describe, expect, it} from 'vitest';
import {databaseConnectionLifetime} from '../db/capacity';

describe('the application connection lifetime', () => {
  it('defaults to six hours, spread up to a quarter longer per connection', () => {
    expect(databaseConnectionLifetime({}, () => 0)()).toBe(21_600);
    expect(databaseConnectionLifetime({}, () => 0.5)()).toBe(24_300);
    expect(databaseConnectionLifetime({}, () => 0.999999)()).toBeLessThanOrEqual(27_000);
  });
  it('draws a new lifetime for every connection', () => {
    const draws = [0, 1];
    const lifetime = databaseConnectionLifetime({}, () => draws.shift() ?? 0);
    expect([lifetime(), lifetime()]).toEqual([21_600, 27_000]);
  });
  it('keeps a misbehaving random source inside the spread', () => {
    expect(databaseConnectionLifetime({}, () => -3)()).toBe(21_600);
    expect(databaseConnectionLifetime({}, () => 7)()).toBe(27_000);
  });
  it('takes an operator base from 5 minutes to 24 hours', () => {
    expect(databaseConnectionLifetime({AIHR_DB_CONNECTION_LIFETIME_SECONDS: '300'}, () => 0)()).toBe(300);
    expect(databaseConnectionLifetime({AIHR_DB_CONNECTION_LIFETIME_SECONDS: '86400'}, () => 0)()).toBe(86_400);
    for (const raw of ['299', '86401', '0', '1e4', '3600.5', ' 3600', 'six hours'])
      expect(() => databaseConnectionLifetime({AIHR_DB_CONNECTION_LIFETIME_SECONDS: raw})).toThrow('AIHR_DB_CONNECTION_LIFETIME_SECONDS must be an integer from 300 to 86400');
  });
  it('is evaluated by the driver per connection, as postgres.js accepts a function for max_lifetime', () => {
    expect(typeof databaseConnectionLifetime({})).toBe('function');
  });
});
