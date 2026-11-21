import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/admin/locations/route';
import type { SessionContext } from '../db/client';
import { AuthRequiredError } from '../lib/auth-errors';
import { requireAdmin } from '@/lib/authz';

const ports = vi.hoisted(() => ({
  getSession: vi.fn(),
  isDemoDeployment: vi.fn(),
  isModuleEnabled: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ getSession: ports.getSession }));
vi.mock('@/lib/demo-mode', () => ({ isDemoDeployment: ports.isDemoDeployment }));
vi.mock('@/core/entitlements', () => ({ isModuleEnabled: ports.isModuleEnabled }));
vi.mock('@/core/payroll-audit/reader-grant', () => ({ hasAuditReaderGrant: vi.fn() }));
vi.mock('@/lib/authz', async importOriginal => {
  const authz = await importOriginal<typeof import('@/lib/authz')>();
  return { ...authz, requireAdmin: vi.fn(authz.requireAdmin) };
});
vi.mock('next/navigation', () => ({
  redirect: (location: string) => { throw new Error(`redirect:${location}`); },
}));

const companyAdmin: SessionContext = {
  tenantId: 'fictional-tenant',
  roles: ['hr_admin'],
  grants: [{ role: 'hr_admin', companyId: 'fictional-company' }],
  entitlements: {
    tenantId: 'fictional-tenant', tenantStatus: 'active', enabledModules: [], scopedModules: {}, settings: {},
  },
};
const target = '/admin/work-locations/clocking';
const get = (query = '') => GET(new Request(`https://example.invalid/admin/locations${query}`));

describe('the legacy Locations bookmark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ports.getSession.mockReset().mockResolvedValue(companyAdmin);
    ports.isDemoDeployment.mockReset().mockReturnValue(false);
    ports.isModuleEnabled.mockReset().mockReturnValue(false);
  });

  it('returns a private 307 for an admitted company admin even without Attendance', async () => {
    const response = await get();
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(target);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toBe('');
    expect(ports.getSession).toHaveBeenCalledTimes(1);
    expect(requireAdmin).toHaveBeenCalledExactlyOnceWith(companyAdmin);
    expect(ports.isModuleEnabled).not.toHaveBeenCalled();
  });

  it('keeps saved values and the first repeated value in the fixed target query', async () => {
    const response = await get('?saved=1&focus=abc&focus=ignored&typedName=Front%20Gate&empty=&returnTo=https%3A%2F%2Foutside.invalid');
    expect(response.headers.get('location')).toBe(
      `${target}?saved=1&focus=abc&typedName=Front+Gate&empty=&returnTo=https%3A%2F%2Foutside.invalid`,
    );
  });

  it('keeps unauthenticated and non-admin callers away from the destination', async () => {
    ports.getSession.mockRejectedValueOnce(new AuthRequiredError('Fictional missing session'));
    await expect(get('?focus=abc')).rejects.toThrow('redirect:/login');
    expect(requireAdmin).not.toHaveBeenCalled();
    ports.getSession.mockResolvedValueOnce({
      ...companyAdmin, roles: ['employee'], grants: [{ role: 'employee', companyId: 'fictional-company' }],
    });
    await expect(get('?focus=abc')).rejects.toThrow('redirect:/');
  });

  it('preserves the operator detour except where the existing demo rule permits the admin guard', async () => {
    const operator: SessionContext = {
      ...companyAdmin, grants: [...companyAdmin.grants!, { role: 'operator', companyId: null }],
    };
    ports.getSession.mockResolvedValue(operator);
    await expect(get()).rejects.toThrow('redirect:/operator');
    expect(requireAdmin).not.toHaveBeenCalled();
    ports.isDemoDeployment.mockReturnValue(true);
    expect((await get()).headers.get('location')).toBe(target);
    expect(requireAdmin).toHaveBeenCalledExactlyOnceWith(operator);
  });

  it('lets an unrelated session failure propagate', async () => {
    const failure = new Error('Fictional auth storage failure');
    ports.getSession.mockRejectedValueOnce(failure);
    await expect(get()).rejects.toBe(failure);
  });
});
