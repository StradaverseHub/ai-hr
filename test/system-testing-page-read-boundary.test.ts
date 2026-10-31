/** Real page functions with service ABAC refusals; no database/browser acceptance claim. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestingRefusal } from '../lib/system-testing/model';
const m = vi.hoisted(() => ({
  scoped: vi.fn(), admin: vi.fn(), module: vi.fn(), execution: vi.fn(), library: vi.fn(), testers: vi.fn(), version: vi.fn(),
  notFound: vi.fn(), notFoundSignal: new Error('NEXT_HTTP_ERROR_FALLBACK;404'),
}));
vi.mock('next/navigation', () => ({ notFound: m.notFound }));
vi.mock('../lib/scope', () => ({ scopedSession: m.scoped }));
vi.mock('../lib/authz', () => ({ requireAdmin: m.admin, requireModule: m.module }));
vi.mock('../core/system-testing', () => ({ getTestingExecution: m.execution, getTestingLibraryCase: m.library, listTestingTesterOptions: m.testers, getTestingInstructionVersion: m.version, listTestableModules: () => [] }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key, getLocale: async () => 'en' }));
vi.mock('../components/system-testing/execution-review', () => ({ TestingExecutionReview: () => null }));
vi.mock('../components/system-testing/instruction-editor', () => ({ TestingInstructionEditor: () => null }));
vi.mock('../components/system-testing/action-form', () => ({ TestingActionForm: () => null }));
vi.mock('../components/system-testing/guide', () => ({ TestingGuide: () => null }));
vi.mock('../app/(app)/admin/system-testing/workspace-actions', () => ({ assignTestingCaseAction: vi.fn(), raiseLegacyTestingFeedbackAction: vi.fn() }));
vi.mock('../lib/permissions', () => ({ SCREENS: [] }));
vi.mock('../app/(app)/feedback/board', () => ({ feedbackBoardOpen: () => true }));
vi.mock('../components/ui', () => ({ Card: () => null, PageHeader: () => null, inputCls: '', pageWideCls: '' }));
import PersonalPage from '../app/(app)/system-testing/executions/[id]/page';
import TeamPage from '../app/(app)/admin/system-testing/executions/[id]/page';
import MasterPage from '../app/(app)/admin/system-testing/[id]/page';

const id = '7777ff7e-86ab-4f55-a7cd-912531170d84', versionId = '35bcda35-407d-401f-968d-fe566c7a5d48';
const testerB = { userId: '82faac81-d98d-4d3a-8ae7-700af1c57781', tenantId: '646bb364-bbfe-49a2-9761-d4a92d926e94', roles: ['employee'] };
const props = () => ({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ beforeRevision: '7' }) });
const masterProps = (version = false) => ({ params: Promise.resolve({ id }), searchParams: Promise.resolve(version ? { versionId } : {}) });
beforeEach(() => {
  vi.clearAllMocks();
  m.notFound.mockImplementation((): never => { throw m.notFoundSignal; });
  m.scoped.mockResolvedValue({ s: testerB, scopeIds: [] }); m.admin.mockResolvedValue(testerB); m.module.mockResolvedValue(testerB);
  m.execution.mockResolvedValue({ marker: 'authorized execution' });
  m.library.mockResolvedValue({ testCase: { id }, assignments: [] });
  m.testers.mockResolvedValue({ rows: [], total: 0, page: 1 }); m.version.mockResolvedValue(null);
});

describe('Testing GET denial presentation without changing read authority', () => {
  it('maps the foreign-tester execution not_found refusal to safe404 while retaining the actual current user and requested ID', async () => {
    m.execution.mockRejectedValue(new TestingRefusal('not_found'));
    await expect(PersonalPage(props())).rejects.toBe(m.notFoundSignal);
    expect(m.execution).toHaveBeenCalledWith(testerB, id, { beforeRevision: 7 });
    expect(m.scoped).toHaveBeenCalledOnce(); expect(m.module).toHaveBeenCalledWith('system_testing');
    expect(m.notFound).toHaveBeenCalledOnce();
  });

  it.each(['not_found', 'not_assigned'] as const)('uses safe404 for recognized %s on the administrative execution read', async code => {
    m.execution.mockRejectedValue(new TestingRefusal(code));
    await expect(TeamPage(props())).rejects.toBe(m.notFoundSignal);
    expect(m.admin).toHaveBeenCalledOnce(); expect(m.execution).toHaveBeenCalledWith(testerB, id, { team: true, beforeRevision: 7 });
    expect(m.notFound).toHaveBeenCalledOnce();
  });

  it('handles invisible master and unauthorized tester-option reads through the same narrow boundary', async () => {
    m.library.mockRejectedValueOnce(new TestingRefusal('not_found'));
    await expect(MasterPage(masterProps())).rejects.toBe(m.notFoundSignal);
    m.testers.mockRejectedValueOnce(new TestingRefusal('not_assigned'));
    await expect(MasterPage(masterProps())).rejects.toBe(m.notFoundSignal);
    expect(m.version).not.toHaveBeenCalled(); expect(m.notFound).toHaveBeenCalledTimes(2);
  });

  it('maps only a refused historical version read after the authorized master read to safe404', async () => {
    m.version.mockRejectedValue(new TestingRefusal('not_found'));
    await expect(MasterPage(masterProps(true))).rejects.toBe(m.notFoundSignal);
    expect(m.library).toHaveBeenCalledOnce(); expect(m.version).toHaveBeenCalledWith(testerB, { caseId: id, versionId });
    expect(m.notFound).toHaveBeenCalledOnce();
  });

  it('retains authorized personal/admin read results and their distinct service options', async () => {
    const visible = { marker: 'current authorized record' }; m.execution.mockResolvedValue(visible);
    const personal = await PersonalPage(props()), team = await TeamPage(props());
    expect(personal.props.data).toBe(visible); expect(team.props.data).toBe(visible); expect(team.props.team).toBe(true);
    expect(m.execution.mock.calls.map(call => call[2])).toEqual([{ beforeRevision: 7 }, { team: true, beforeRevision: 7 }]);
    expect(m.notFound).not.toHaveBeenCalled();
  });

  it('propagates unknown failures from all three page reads rather than mislabeling an outage as404', async () => {
    const fault = new Error('unrecognized private infrastructure failure');
    m.execution.mockRejectedValue(fault); m.library.mockRejectedValue(fault);
    for (const call of [() => PersonalPage(props()), () => TeamPage(props()), () => MasterPage(masterProps())]) await expect(call()).rejects.toBe(fault);
    expect(m.notFound).not.toHaveBeenCalled();
  });

  it('does not convert unrelated typed refusals or code-shaped unknown objects into unavailable pages', async () => {
    for (const fault of [new TestingRefusal('invalid'), new TestingRefusal('stale_execution'), { code: 'not_found' }]) {
      m.execution.mockRejectedValue(fault); await expect(PersonalPage(props())).rejects.toBe(fault);
    }
    expect(m.notFound).not.toHaveBeenCalled();
  });

  it('leaves authentication/admin/module guard errors outside the read boundary', async () => {
    const guard = new Error('existing authorization redirect'); m.module.mockRejectedValue(guard);
    await expect(PersonalPage(props())).rejects.toBe(guard);
    m.module.mockResolvedValue(testerB); m.admin.mockRejectedValue(guard);
    await expect(TeamPage(props())).rejects.toBe(guard);
    expect(m.execution).not.toHaveBeenCalled(); expect(m.notFound).not.toHaveBeenCalled();
  });
});
