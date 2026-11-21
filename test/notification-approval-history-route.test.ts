import { beforeEach, expect, it, vi } from 'vitest';
import { AuthRequiredError } from '../lib/auth-errors';

const fixtures = vi.hoisted(() => ({ getSession: vi.fn(), listHistory: vi.fn() }));
vi.mock('../lib/session', () => ({ getSession: fixtures.getSession }));
vi.mock('../core/read', () => ({ listApprovalHistory: fixtures.listHistory }));

import { GET } from '../app/api/notifications/approval-history/route';

beforeEach(() => vi.resetAllMocks());

it('opens only the authenticated manager or admin history with a bounded private response', async () => {
  const now = new Date();
  fixtures.listHistory.mockResolvedValue([{
    id: 'decision', aggregateType: 'leave-request', eventType: 'leave-request.approved',
    occurredAt: now, subjectName: 'Fictional employee', deciderName: null,
    isAuto: false, onBehalfOfName: null, payload: { privateReason: 'hidden' },
  }]);
  for (const role of ['manager', 'hr_admin']) {
    const session = { tenantId: 'tenant', userId: 'actor', roles: [role] };
    fixtures.getSession.mockResolvedValue(session);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(fixtures.listHistory).toHaveBeenLastCalledWith(session, {
      from: expect.any(String), limit: 10,
    });
    const rows = await response.json();
    expect(rows).toMatchObject([{ id: 'decision', occurredAt: now.toISOString() }]);
    expect(rows[0]).not.toHaveProperty('payload');
  }
});

it('refuses unauthenticated and employee callers without reading history', async () => {
  fixtures.getSession.mockRejectedValueOnce(new AuthRequiredError());
  expect((await GET()).status).toBe(401);
  fixtures.getSession.mockResolvedValue({ tenantId: 'tenant', userId: 'actor', roles: ['employee'] });
  expect((await GET()).status).toBe(403);
  expect(fixtures.listHistory).not.toHaveBeenCalled();
});
