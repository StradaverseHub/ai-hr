import { beforeEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({ session: vi.fn(), tasks: vi.fn(), enabled: vi.fn(), budget: vi.fn() }));
vi.mock('../lib/request-budget',async(importOriginal)=>({...await importOriginal<typeof import('../lib/request-budget')>(),takeRequestBudget:ports.budget}));
// Partial mocks (the original module plus the one injected export): the v2 route below loads the real composition
// (core/mobile-approvals), whose import graph reads other exports of these modules.
vi.mock('../lib/session', async (importOriginal) => ({ ...await importOriginal<typeof import('../lib/session')>(), getMobileSession: ports.session }));
vi.mock('../core/approvals-inbox', async (importOriginal) => ({ ...await importOriginal<typeof import('../core/approvals-inbox')>(), listPendingTasks: ports.tasks }));
vi.mock('../core/entitlements', async (importOriginal) => ({ ...await importOriginal<typeof import('../core/entitlements')>(), isModuleEnabled: ports.enabled }));
import { GET } from '../app/api/mobile/v1/tasks/route';
import { GET as GETv2 } from '../app/api/mobile/v2/tasks/route';
import { AuthRequiredError } from '../lib/auth-errors';
import { RequestBudgetExceeded } from '../lib/request-budget';
const principal = { tenantId: 'tenant-a', userId: 'user-a', personId: 'person-a', roles: ['manager'], grants: [] };
beforeEach(() => { vi.clearAllMocks(); ports.budget.mockResolvedValue(undefined); ports.session.mockResolvedValue(principal); ports.enabled.mockImplementation((_, code) => code === 'attendance'); });
it('uses the authenticated approval inbox and strips every uncontracted field', async () => {
  ports.tasks.mockResolvedValue([{ id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', kind: 'leave', subjectName: 'Scoped colleague', linkPath: '/approvals', salary: '98765.43', tenantId: 'tenant-a' }]);
  const r = await GET(new Request('https://hr.test/api/mobile/v1/tasks?tenantId=foreign&companyId=foreign&personId=foreign'));
  expect(ports.tasks).toHaveBeenCalledWith(principal, undefined, { attendance: true, claims: false, performance: false, rewards: false }, {noticeAcknowledgements:false});
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

// M14 — the composed Tasks widget now reads v2 (mobile/lib/composed-page.tsx); v1 above stays for installed clients.
const pending = (kind: string, id: string, linkPath = '/approvals') => ({ id, kind, subjectName: 'Scoped colleague', createdAt: '2026-10-28T01:00:00.000Z', linkPath });
it('the composer\'s v2 source lists every kind the approvals screen does, replacement leave and notice acknowledgements included', async () => {
  ports.tasks.mockResolvedValue([
    pending('leave', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'),
    pending('replacementLeave', 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', '/approvals?task=replacementLeave'),
    pending('noticeAcknowledgement', 'notice:cccccccc-cccc-4ccc-cccc-cccccccccccc:1', '/notices/cccccccc-cccc-4ccc-cccc-cccccccccccc'),
  ]);
  const r = await GETv2(new Request('https://hr.test/api/mobile/v2/tasks?limit=20&tenantId=foreign'));
  expect(r.status).toBe(200);
  // No {noticeAcknowledgements:false}: the same population as the approvals screen and Home's count.
  expect(ports.tasks).toHaveBeenCalledWith(principal, undefined, { attendance: true, claims: false });
  const body = await r.json();
  expect(body.items.map((t: { kind: string }) => t.kind)).toEqual(['leave', 'replacementLeave', 'noticeAcknowledgement']);
  expect(body.items[0]).toEqual({ id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', kind: 'leave', subject: { name: 'Scoped colleague', code: null }, createdAt: '2026-10-28T01:00:00.000Z', nativeDecision: true, webPath: null });
  expect(body.nextCursor).toBeNull();
  expect(r.headers.get('cache-control')).toBe('no-store');
});
it('a failed v2 task read is an error, never an empty list the widget could call "nothing needs you"', async () => {
  ports.tasks.mockRejectedValue(new Error('inbox owner failed'));
  const r = await GETv2(new Request('https://hr.test/api/mobile/v2/tasks?limit=4'));
  expect(r.status).toBe(500);
  const text = await r.text();
  expect(JSON.parse(text)).toEqual({ error: 'internal' });
  expect(text).not.toContain('items');
});
