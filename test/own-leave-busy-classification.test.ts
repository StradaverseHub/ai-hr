/** Busy classification across the canonical own-leave owners, without a database. A fake Tx raises the
 * driver error shape PostgreSQL produces when lock_timeout cuts a lock wait short (SQLSTATE 55P03,
 * lock_not_available), wrapped the way drizzle wraps it. Not live lock or effect proof. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tx } from '../db/client';
const owners = vi.hoisted(() => ({
  expire: vi.fn(), prepare: vi.fn(), confirm: vi.fn(), discard: vi.fn(), list: vi.fn(), reopen: vi.fn(),
  withTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({ fake: 'tx' })),
}));
vi.mock('server-only', () => ({}));
vi.mock('../db/client', async importOriginal => ({ ...(await importOriginal<typeof import('../db/client')>()), withTenant: owners.withTenant }));
vi.mock('../core/assistant-actions/own-leave-store', () => ({
  expireOwnLeaveReviewsForCallerTx: owners.expire, prepareOwnLeaveReviewTx: owners.prepare, confirmOwnLeaveReview: owners.confirm,
  discardOwnLeaveReviewTx: owners.discard, listOwnLeaveReviewsTx: owners.list, reopenOwnLeaveReviewTx: owners.reopen,
}));
import { createOwnLeaveBrowserCommandHandler } from '../core/assistant-actions/own-leave-browser';
import { OwnLeaveBusy } from '../lib/assistant-actions/own-leave-http';
import { LeaveDependencyUnavailable } from '../packs/leave/service';

const PUBLIC = 'https://hr.fixture.test';
const actionId = '11111111-1111-4111-8111-111111111111', employmentId = '22222222-2222-4222-8222-222222222222';
const leaveTypeId = '33333333-3333-4333-8333-333333333333', digest = 'a'.repeat(64);
const packets = {
  prepare: { operation: 'prepare', nomination: { action: 'leave.apply', contractVersion: 1, employmentId, leaveTypeId, date: '2030-06-10', durationType: 'full_day' },
    selection: { employmentId, leaveTypeId }, humanText: { reason: 'Human entered reason' } },
  confirm: { operation: 'confirm', confirmation: { actionId, contractVersion: 1, reviewedDigest: digest } },
  reopen: { operation: 'reopen', actionId },
  discard: { operation: 'discard', confirmation: { actionId, contractVersion: 1 } },
  list: { operation: 'list' },
} as const;
const lockTimeout = (code = '55P03') => Object.assign(Error('Failed query: select pg_advisory_xact_lock(PRIVATE_SQL) params: PRIVATE_PARAM'),
  { name: 'DrizzleQueryError', cause: Object.assign(Error('canceling statement due to lock timeout'), { code }) });
const handler = () => createOwnLeaveBrowserCommandHandler(async () => ({ ctx: { tenantId: 'fictional-tenant', userId: 'fictional-user' }, locale: 'en' }), { publicOrigin: PUBLIC });
const post = (body: unknown) => handler()(new Request(PUBLIC + '/api/assistant/own-leave', { method: 'POST',
  headers: { origin: PUBLIC, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) }));
async function expectBusy(response: Response) {
  expect(response.status).toBe(409);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ error: 'busy' });
  for (const hidden of ['PRIVATE', 'lock', 'Leave source']) expect(text).not.toContain(hidden);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
}

beforeEach(() => {
  vi.clearAllMocks();
  owners.expire.mockResolvedValue(0);
});

describe('own-leave preparation busy refusal', () => {
  it('reports a non-waiting leave dependency refusal inside preparation as busy', async () => {
    owners.prepare.mockRejectedValueOnce(new LeaveDependencyUnavailable('busy'));
    await expectBusy(await post(packets.prepare));
    expect(owners.prepare).toHaveBeenCalledOnce();
  });
  it('does not say "busy, try again" when the leave source changed between reads: a retry would be refused too', async () => {
    owners.prepare.mockRejectedValueOnce(new LeaveDependencyUnavailable());
    const response = await post(packets.prepare);
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'unavailable' });
  });
  it('reports an Access lock wait cut short by lock_timeout (55P03) inside preparation as busy', async () => {
    owners.prepare.mockRejectedValueOnce(lockTimeout());
    await expectBusy(await post(packets.prepare));
  });
  it('reports a busy cleanup before preparation as busy, and never starts preparation', async () => {
    owners.expire.mockRejectedValueOnce(new OwnLeaveBusy());
    await expectBusy(await post(packets.prepare));
    expect(owners.prepare).not.toHaveBeenCalled();
  });
  it.each([['unknown', Error('PRIVATE unknown failure')], ['statement timeout 57014', lockTimeout('57014')], ['serialization 40001', lockTimeout('40001')]] as const)
  ('keeps an %s failure of preparation at the unconfirmed 503', async (_label, error) => {
    owners.prepare.mockRejectedValueOnce(error);
    const response = await post(packets.prepare);
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'unavailable' });
  });
  it.each(['confirm', 'reopen', 'discard', 'list'] as const)('keeps %s at the unconfirmed 503 even when a lock was busy', async operation => {
    for (const error of [lockTimeout(), new LeaveDependencyUnavailable('busy'), new LeaveDependencyUnavailable(), new OwnLeaveBusy()]) {
      vi.clearAllMocks(); owners.expire.mockResolvedValue(0);
      if (operation === 'confirm') owners.confirm.mockRejectedValueOnce(error);
      else owners[operation].mockRejectedValueOnce(error);
      const response = await post(packets[operation]);
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'unavailable' });
    }
    vi.clearAllMocks(); owners.expire.mockRejectedValueOnce(new OwnLeaveBusy());
    expect((await post(packets[operation])).status).toBe(503);
  });
});

describe('own-leave cleanup refusal classification', () => {
  it('maps a lock_timeout refusal to the bounded busy error and every other failure to unavailable', async () => {
    const store = await vi.importActual<typeof import('../core/assistant-actions/own-leave-store')>('../core/assistant-actions/own-leave-store');
    const failing = (error: unknown) => ({ execute: vi.fn(async () => { throw error; }) }) as unknown as Tx;
    const busy = await store.expireOwnLeaveReviewsForCallerTx(failing(lockTimeout())).catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(OwnLeaveBusy); expect(String((busy as Error).message)).not.toContain('PRIVATE');
    for (const error of [Error('PRIVATE other'), lockTimeout('57014'), lockTimeout('42501')]) {
      const other = await store.expireOwnLeaveReviewsForCallerTx(failing(error)).catch((caught: unknown) => caught);
      expect(other).not.toBeInstanceOf(OwnLeaveBusy); expect((other as Error).message).toBe('Own-leave private review unavailable');
    }
  });
});
