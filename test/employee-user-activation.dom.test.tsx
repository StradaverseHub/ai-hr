import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
const m = vi.hoisted(() => ({ users: vi.fn(), candidates: vi.fn(), invitations: vi.fn(), enrollments: vi.fn(), group: vi.fn(), enabled: vi.fn(), manual: vi.fn() }));
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace?: string) => {
  const t = (key: string) => `${namespace ? namespace + '.' : ''}${key}`.split('.').reduce((v: any, k) => v?.[k], en) ?? key;
  return Object.assign(t, { rich: t });
} }));
vi.mock('../lib/authz', () => ({ requireAdmin: async () => ({ tenantId: 'tenant' }), isGroupAdmin: m.group }));
vi.mock('../lib/identity/config', () => ({ keycloakSelected: m.enabled }));
vi.mock('../core/admin', () => ({ listUsers: m.users }));
vi.mock('../core/employee-user-activation', () => ({ listEmployeeActivationCandidates: m.candidates }));
vi.mock('../core/auth', () => ({ listPendingInvitations: m.invitations }));
vi.mock('../core/manual-identity', () => ({ listManualIdentityEnrollments: m.enrollments }));
vi.mock('../core/assistant-grant', () => ({ listAssistantGrants: async () => [] }));
vi.mock('../core/read', () => ({ listCompanies: async () => [], adminCompanies: async () => [], listEmployees: async () => [] }));
vi.mock('../components/function-access-grid', () => ({ FunctionAccessGrid: () => null }));
vi.mock('../app/admin/actions', () => ({ archiveUserAction: vi.fn(), assignRoleAction: vi.fn(), inviteUserAction: vi.fn(), revokeInvitationAction: vi.fn(), revokeRoleAction: vi.fn(), setAssistantGrantAction: vi.fn() }));
vi.mock('../app/admin/users/manual-actions', () => ({ createManualAccountAction: vi.fn(), resumeManualAccountAction: vi.fn(), cancelManualAccountAction: vi.fn() }));
vi.mock('../app/admin/users/manual-setup', () => ({ ManualAccountSetup: (props: unknown) => { m.manual(props); return null; } }));
import UsersPage from '../app/admin/users/page';
const person = { id: 'person-a', name: 'Employee A', email: 'same@example.test', code: 'A-001' };
const show = async (params = {}) => render(<NextIntlClientProvider locale="en" messages={en}>{await UsersPage({ searchParams: Promise.resolve(params) })}</NextIntlClientProvider>);
const directory = () => document.querySelector('[data-tour="admin-users"]') as HTMLElement;
beforeEach(() => {
  vi.clearAllMocks(); m.group.mockReturnValue(true); m.enabled.mockReturnValue(true);
  m.users.mockResolvedValue({ users: [], hiddenCount: 0 }); m.candidates.mockResolvedValue([person]);
  m.invitations.mockResolvedValue([]); m.enrollments.mockResolvedValue([]);
});
afterEach(cleanup);
describe('employee activation actions and lifecycle display', () => {
  it('shows pending activation without access-management actions and links both methods by person ID', async () => {
    await show(); const d = within(directory());
    expect(d.getByText('Pending activation')).toBeTruthy();
    expect(d.getByRole('link', { name: 'Set username and password' }).getAttribute('href')).toBe('/admin/users?activate=person-a#manual-account-setup');
    expect(d.getByRole('link', { name: 'Send invitation' }).getAttribute('href')).toBe('/admin/users?activate=person-a#invite-user');
    expect(d.queryByRole('button')).toBeNull();
  });
  it('preselects the exact pending person, prefills email, and keeps employee access as default', async () => {
    await show({ activate: person.id });
    expect(m.manual).toHaveBeenCalledWith(expect.objectContaining({ selectedPerson: person }));
    expect(document.querySelector<HTMLInputElement>('input[name="personId"]')?.value).toBe(person.id);
    expect(screen.getByRole('textbox', { name: 'Email' }).getAttribute('value')).toBe(person.email);
    expect(document.querySelector<HTMLSelectElement>('select[name="role"]')?.value).toBe('employee');
  });
  it('the manual form keeps the preselected person fixed and requires a temporary password and ownership attestation', async () => {
    const { ManualAccountSetup } = await vi.importActual<typeof import('../app/admin/users/manual-setup')>('../app/admin/users/manual-setup');
    render(<NextIntlClientProvider locale="en" messages={en}>{await ManualAccountSetup({ available: true, people: [], companies: [], roles: [{ value: 'employee', label: 'Employee' }], pending: [], selectedPerson: person })}</NextIntlClientProvider>);
    expect(document.querySelector<HTMLInputElement>('input[name="personId"]')?.value).toBe(person.id);
    expect(document.querySelector('select[name="personId"]')).toBeNull();
    expect(document.querySelector<HTMLInputElement>('input[name="email"]')?.value).toBe(person.email);
    expect(document.querySelector<HTMLSelectElement>('select[name="role"]')?.value).toBe('employee');
    expect(document.querySelector<HTMLInputElement>('input[name="password"]')?.minLength).toBe(14);
    expect(document.querySelector<HTMLInputElement>('input[name="ownershipAttested"]')?.required).toBe(true);
  });
  it('does not trust a forged or stale activation target from the URL', async () => {
    await show({ activate: 'foreign-or-archived-person' });
    expect(m.manual).toHaveBeenCalledWith(expect.objectContaining({ selectedPerson: undefined }));
    expect(document.querySelector('input[name="personId"]')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Email' }).getAttribute('value')).toBe('');
  });
  it('uses invitation person IDs instead of shared email addresses to suppress a pending row', async () => {
    m.candidates.mockResolvedValue([person, { ...person, id: 'person-b', name: 'Employee B' }]);
    m.invitations.mockResolvedValue([{ id: 'invite-a', personId: person.id, email: person.email, role: 'employee', companyId: null }]);
    await show(); const d = within(directory());
    expect(d.getAllByText('Employee A')).toHaveLength(1); expect(d.getAllByText('Employee B')).toHaveLength(1);
    expect(d.getAllByText('Pending activation')).toHaveLength(1); expect(d.getAllByText('Invited')).toHaveLength(1);
    expect(d.getByRole('link', { name: 'Set username and password' }).getAttribute('href')).toContain('person-b');
  });
  it('shows unfinished manual setup once and offers resume instead of a second activation', async () => {
    m.enrollments.mockResolvedValue([{ id: 'setup', person_id: person.id, status: 'prepared', app_user_id: null }]);
    await show({ activate: person.id }); const d = within(directory());
    expect(d.getByText('Setup pending')).toBeTruthy(); expect(d.getByRole('link', { name: 'Resume setup' })).toBeTruthy();
    expect(d.queryByText('Pending activation')).toBeNull();
    expect(m.manual).toHaveBeenCalledWith(expect.objectContaining({ selectedPerson: undefined }));
  });
  it('hidden archived logins cannot reappear through an invitation or a concurrent pending read', async () => {
    m.users.mockResolvedValue({ users: [{ id: 'archived', personId: person.id, name: person.name, email: person.email, archivedAt: new Date(), roles: [] }], hiddenCount: 0 });
    m.invitations.mockResolvedValue([{ id: 'stale-invite', personId: person.id, email: person.email }]);
    await show({ activate: person.id });
    expect(within(directory()).queryByText(person.name)).toBeNull();
    expect(m.users).toHaveBeenCalledWith(expect.anything(), { includeArchived: true });
    expect(m.manual).toHaveBeenCalledWith(expect.objectContaining({ selectedPerson: undefined }));
  });
  it('delegated admins receive no pending roster or activation controls', async () => {
    m.group.mockReturnValue(false); await show();
    expect(m.candidates).not.toHaveBeenCalled(); expect(m.manual).not.toHaveBeenCalled();
    expect(screen.queryByText('Pending activation')).toBeNull();
  });
});
