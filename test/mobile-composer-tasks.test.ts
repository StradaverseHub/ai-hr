import { beforeEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({ session: vi.fn(), tasks: vi.fn(), enabled: vi.fn(), budget: vi.fn() }));
vi.mock('../lib/request-budget',async(importOriginal)=>({...await importOriginal<typeof import('../lib/request-budget')>(),takeRequestBudget:ports.budget}));
vi.mock('../lib/session', () => ({ getMobileSession: ports.session }));
vi.mock('../core/approvals-inbox', () => ({ listPendingTasks: ports.tasks }));
vi.mock('../core/entitlements', () => ({ isModuleEnabled: ports.enabled }));
import { GET } from '../app/api/mobile/v1/tasks/route';
import { AuthRequiredError } from '../lib/auth-errors';
import { RequestBudgetExceeded } from '../lib/request-budget';
const principal = { tenantId: 'tenant-a', userId: 'user-a', personId: 'person-a', roles: ['manager'], grants: [] };
beforeEach(() => { vi.clearAllMocks(); ports.budget.mockResolvedValue(undefined); ports.session.mockResolvedValue(principal); ports.enabled.mockImplementation((_, code) => code === 'attendance'); });
it('uses the authenticated approval inbox and strips every uncontracted field', async () => {
  ports.tasks.mockResolvedValue([{ id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', kind: 'leave', subjectName: 'Scoped colleague', linkPath: '/approvals', salary: '98765.43', tenantId: 'tenant-a' }]);
  const r = await GET(new Request('https://hr.test/api/mobile/v1/tasks?tenantId=foreign&companyId=foreign&personId=foreign'));
  expect(ports.tasks).toHaveBeenCalledWith(principal, undefined, { attendance: true, claims: false }, {noticeAcknowledgements:false});
  expect(await r.json()).toEqual({ total: 1, items: [{ id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', kind: 'leave', subject: 'Scoped colleague' }] });
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(ports.budget).toHaveBeenCalledWith(['mobile-actor','tenant-a','user-a','read'],180,60);
});
it('preserves the published v1 vocabulary when the web inbox gains replacement-leave tasks', async () => {
  ports.tasks.mockResolvedValue([
    { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', kind: 'leave', subjectName: 'Scoped colleague' },
    { id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', kind: 'replacementLeave', subjectName: 'Replacement colleague' },
  ]);
  const r = await GET(new Request('https://hr.test/api/mobile/v1/tasks'));
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ total: 1, items: [{ id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', kind: 'leave', subject: 'Scoped colleague' }] });
});
it('never invokes the inbox without a verified bearer session', async () => {
  ports.session.mockRejectedValue(new AuthRequiredError());
  expect((await GET(new Request('https://hr.test/api/mobile/v1/tasks'))).status).toBe(401); expect(ports.tasks).not.toHaveBeenCalled();
});
it('does not invoke the inbox when actor admission refuses the request',async()=>{
  ports.budget.mockRejectedValueOnce(new RequestBudgetExceeded(20));
  const response=await GET(new Request('https://hr.test/api/mobile/v1/tasks'));
  expect(response.status).toBe(429);expect(response.headers.get('retry-after')).toBe('20');
  expect(ports.tasks).not.toHaveBeenCalled();
});
