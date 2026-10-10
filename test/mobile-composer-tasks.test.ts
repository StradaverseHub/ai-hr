import { beforeEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({ session: vi.fn(), tasks: vi.fn(), enabled: vi.fn() }));
vi.mock('../lib/session', () => ({ getMobileSession: ports.session }));
vi.mock('../core/approvals-inbox', () => ({ listPendingTasks: ports.tasks }));
vi.mock('../core/entitlements', () => ({ isModuleEnabled: ports.enabled }));
import { GET } from '../app/api/mobile/v1/tasks/route';
import { AuthRequiredError } from '../lib/auth-errors';
const principal = { tenantId: 'tenant-a', userId: 'user-a', personId: 'person-a', roles: ['manager'], grants: [] };
beforeEach(() => { vi.clearAllMocks(); ports.session.mockResolvedValue(principal); ports.enabled.mockImplementation((_, code) => code === 'attendance'); });
it('uses the authenticated approval inbox and strips every uncontracted field', async () => {
  ports.tasks.mockResolvedValue([{ id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', kind: 'leave', subjectName: 'Scoped colleague', linkPath: '/approvals', salary: '98765.43', tenantId: 'tenant-a' }]);
  const r = await GET(new Request('https://hr.test/api/mobile/v1/tasks?tenantId=foreign&companyId=foreign&personId=foreign'));
  expect(ports.tasks).toHaveBeenCalledWith(principal, undefined, { attendance: true, claims: false });
  expect(await r.json()).toEqual({ total: 1, items: [{ id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', kind: 'leave', subject: 'Scoped colleague' }] });
  expect(r.headers.get('cache-control')).toBe('no-store');
});
it('never invokes the inbox without a verified bearer session', async () => {
  ports.session.mockRejectedValue(new AuthRequiredError());
  expect((await GET(new Request('https://hr.test/api/mobile/v1/tasks'))).status).toBe(401); expect(ports.tasks).not.toHaveBeenCalled();
});
