/**
 * Dev session resolution robustness. The dev shim resolves a `dev_user` cookie (or DEV_USER_ID) to a
 * SessionContext via `app.principal()`. An unknown/stale id makes `app.principal()` return zero rows;
 * the resolution must NOT dereference an undefined principal (which previously surfaced as an uncaught
 * `TypeError: Cannot read properties of undefined (reading 'grants')` during dev persona switches and
 * could 500 the request). These are pure unit tests — no DB, no request context — exercising the
 * unknown-id path via an injected `lookup`, plus the withTenant guard for an unresolved context.
 */
import { describe, expect, it } from 'vitest';
import { resolveDevPrincipal } from '../lib/session';
import { withTenant, type Grant, type SessionContext } from '../db/client';

const row = (grants: Grant[] | null) => ({ tenant_id: 'tnt-1', person_id: 'p-1', grants });

describe('resolveDevPrincipal — tolerant dev principal resolution', () => {
  it('resolves a valid cookie user', async () => {
    const s = await resolveDevPrincipal(
      async (id) => (id === 'u-cookie' ? [row([{ role: 'hr_admin', companyId: null }])] : []),
      'u-cookie',
      'u-fallback',
    );
    expect(s).toMatchObject({ tenantId: 'tnt-1', userId: 'u-cookie', personId: 'p-1', roles: ['hr_admin'] });
  });

  it('self-heals a stale/unknown cookie to the fallback identity', async () => {
    const s = await resolveDevPrincipal(
      async (id) => (id === 'u-fallback' ? [row([{ role: 'manager', companyId: null }])] : []),
      'stale-deleted-user',
      'u-fallback',
    );
    expect(s.userId).toBe('u-fallback');
    expect(s.roles).toEqual(['manager']);
  });

  it('throws a CLEAR error (never a TypeError) when no id resolves — the unknown-user-id path', async () => {
    const err = await resolveDevPrincipal(async () => [], 'unknown', 'also-unknown').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(/no valid dev principal/i);
  });

  it('throws when neither cookie nor fallback id is present', async () => {
    await expect(resolveDevPrincipal(async () => [], undefined, undefined)).rejects.toThrow(/No dev principal/i);
  });

  it('tolerates a null grants column without dereferencing undefined', async () => {
    const s = await resolveDevPrincipal(async () => [row(null)], 'u', undefined);
    expect(s.grants).toEqual([]);
    expect(s.roles).toEqual([]);
  });
});

describe('withTenant — guards an undefined session context', () => {
  it('rejects with a clear error, not a TypeError, on an undefined ctx', async () => {
    const err = await withTenant(undefined as unknown as SessionContext, async () => 1).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(/session context/i);
  });
});
