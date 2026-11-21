import { beforeEach, expect, it, vi } from 'vitest';
import {databaseReadSignal} from '../db/workload';
import { AuthRequiredError } from '../lib/auth-errors';

const fixtures = vi.hoisted(() => ({
  getSession: vi.fn(),
  companyContextForPage: vi.fn(),
  enabled: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('../lib/session', () => ({ getSession: fixtures.getSession }));
vi.mock('../lib/scope', () => ({ companyContextForPage: fixtures.companyContextForPage }));
vi.mock('../core/entitlements', () => ({ isModuleEnabledOrFalse: fixtures.enabled }));
vi.mock('../core/approvals-inbox', () => ({ pendingBellClaimPreview: fixtures.preview }));

import { GET } from '../app/api/notifications/claim-tasks/route';

const request = () => new Request('https://example.test/api/notifications/claim-tasks');

beforeEach(() => vi.resetAllMocks());

it('loads the private preview in the authenticated viewer’s server-selected company scope', async () => {
  const session = { tenantId: 'tenant', userId: 'actor', roles: ['employee'] };
  fixtures.getSession.mockResolvedValue(session);
  fixtures.enabled.mockReturnValue(true);
  fixtures.companyContextForPage.mockResolvedValue({ scopeIds: ['selected-company'] });
  const preview = { items: [], total: 0 };
  fixtures.preview.mockResolvedValue(preview);

  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(fixtures.enabled).toHaveBeenCalledWith(session, 'claims');
  expect(fixtures.companyContextForPage).toHaveBeenCalledWith(session);
  expect(fixtures.preview).toHaveBeenCalledWith(session, ['selected-company']);
  expect(await response.json()).toEqual(preview);
});

it('does not read Claims tasks without a session and an enabled module', async () => {
  fixtures.getSession.mockRejectedValueOnce(new AuthRequiredError());
  expect((await GET(request())).status).toBe(401);
  fixtures.getSession.mockResolvedValue({ tenantId: 'tenant', userId: 'actor' });
  fixtures.enabled.mockReturnValue(false);
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ items: [], total: 0 });
  expect(fixtures.companyContextForPage).not.toHaveBeenCalled();
  expect(fixtures.preview).not.toHaveBeenCalled();
});

it('stops before the preview when the caller disconnects during company scope resolution', async () => {
  const controller = new AbortController();
  const incoming = new Request(request(), { signal: controller.signal });
  fixtures.getSession.mockResolvedValue({ tenantId: 'tenant', userId: 'actor' });
  fixtures.enabled.mockReturnValue(true);
  fixtures.companyContextForPage.mockImplementation(async () => {
    expect(databaseReadSignal()).toBe(incoming.signal);
    controller.abort();
    return { scopeIds: ['selected-company'] };
  });
  expect((await GET(incoming)).status).toBe(503);
  expect(fixtures.companyContextForPage).toHaveBeenCalledOnce();
  expect(fixtures.preview).not.toHaveBeenCalled();
});
