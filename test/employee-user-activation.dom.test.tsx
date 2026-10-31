import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import {Children,isValidElement,type ReactNode} from 'react';
import {UsersDirectory} from '../app/(app)/admin/users/users-directory';
const m = vi.hoisted(() => ({ users: vi.fn(), candidates: vi.fn(), invitations: vi.fn(), enrollments: vi.fn(), group: vi.fn(), enabled: vi.fn(), manual: vi.fn(), locale: vi.fn(async()=> 'en') }));
vi.mock('next-intl/server', () => ({ getLocale:m.locale, getTranslations: async (namespace?: string) => {
  const t = (key: string) => `${namespace ? namespace + '.' : ''}${key}`.split('.').reduce((v: any, k) => v?.[k], en) ?? key;
  return Object.assign(t, { rich: t });
} }));
vi.mock('../app/(app)/admin/users/security-page',()=>({SecurityPageHeader:()=>null}));
vi.mock('../app/(app)/admin/users/legacy-navigation',()=>({LegacySecurityNavigation:()=>null}));
vi.mock('../lib/security-center-authz',()=>({requireGroupAdministration:async()=>({tenantId:'tenant'})}));
vi.mock('../lib/authz', () => ({ requireAdmin: async () => ({ tenantId: 'tenant' }), isGroupAdmin: m.group }));
vi.mock('../lib/identity/config', () => ({ keycloakSelected: m.enabled }));
vi.mock('../core/admin', () => ({ listUsers: m.users }));
vi.mock('../core/employee-user-activation', () => ({ listEmployeeActivationCandidates: m.candidates }));
vi.mock('../core/auth', () => ({ listPendingInvitations: m.invitations }));
vi.mock('../core/manual-identity', () => ({ listManualIdentityEnrollments: m.enrollments }));
vi.mock('../core/assistant-grant', () => ({ listAssistantGrants: async () => [] }));
vi.mock('../core/read', () => ({ listCompanies: async () => [], adminCompanies: async () => [], listEmployees: async () => [] }));
vi.mock('../components/function-access-grid', () => ({ FunctionAccessGrid: () => null }));
vi.mock('../app/(app)/admin/actions', () => ({ archiveUserAction: vi.fn(), assignRoleAction: vi.fn(), inviteUserAction: vi.fn(), revokeInvitationAction: vi.fn(), revokeRoleAction: vi.fn(), setAssistantGrantAction: vi.fn() }));
vi.mock('../app/(app)/admin/users/manual-actions', () => ({ createManualAccountAction: vi.fn(), resumeManualAccountAction: vi.fn(), cancelManualAccountAction: vi.fn() }));
vi.mock('../app/(app)/admin/users/manual-setup', () => ({ ManualAccountSetup: (props: unknown) => { m.manual(props); return null; } }));
import UsersPage from '../app/(app)/admin/users/page';
import CreatePage from '../app/(app)/admin/users/create/page';
import InvitePage from '../app/(app)/admin/users/invite/page';
const person = { id: 'person-a', name: 'Employee A', email: 'same@example.test', code: 'A-001' };
const show = async (params = {}) => render(<NextIntlClientProvider locale="en" messages={en}>{await UsersPage({ searchParams: Promise.resolve(params) })}</NextIntlClientProvider>);
const directory = () => (document.querySelector('[data-tour="admin-users"] table') ?? document.querySelector('[data-tour="admin-users"]')) as HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();m.locale.mockResolvedValue('en'); m.group.mockReturnValue(true); m.enabled.mockReturnValue(true);
  m.users.mockResolvedValue({ users: [], hiddenCount: 0 }); m.candidates.mockResolvedValue([person]);
  m.invitations.mockResolvedValue([]); m.enrollments.mockResolvedValue([]);
});
afterEach(cleanup);
describe('employee activation actions and lifecycle display', () => {
  it('shows pending activation without access-management actions and links both methods by person ID', async () => {
    await show(); const d = within(directory());
    expect(d.getByText('Pending activation')).toBeTruthy();
    fireEvent.click(d.getByRole('button', {name:'Activate'}));
    expect(d.getByRole('link', { name: 'Set username and password' }).getAttribute('href')).toBe('/admin/users/create?activate=person-a');
    expect(d.getByRole('link', { name: 'Send invitation' }).getAttribute('href')).toBe('/admin/users/invite?activate=person-a');
    expect(d.queryByRole('button',{name:'Add role'})).toBeNull();
    expect(d.queryByRole('button',{name:'Archive'})).toBeNull();
  });
  it('preselects the exact pending person, prefills email, and keeps employee access as default', async () => {
    render(<NextIntlClientProvider locale="en" messages={en}>{await CreatePage({searchParams:Promise.resolve({activate:person.id})})}{await InvitePage({searchParams:Promise.resolve({activate:person.id})})}</NextIntlClientProvider>);
    expect(m.manual).toHaveBeenCalledWith(expect.objectContaining({ selectedPerson: person }));
    expect(document.querySelector<HTMLInputElement>('input[name="personId"]')?.value).toBe(person.id);
    expect(screen.getByRole('textbox', { name: 'Email' }).getAttribute('value')).toBe(person.email);
    expect(document.querySelector<HTMLSelectElement>('select[name="role"]')?.value).toBe('employee');
  });
  it('the manual form keeps the preselected person fixed and requires a temporary password and ownership attestation', async () => {
    const { ManualAccountSetup } = await vi.importActual<typeof import('../app/(app)/admin/users/manual-setup')>('../app/(app)/admin/users/manual-setup');
    render(<NextIntlClientProvider locale="en" messages={en}>{await ManualAccountSetup({ available: true, people: [], companies: [], roles: [{ value: 'employee', label: 'Employee' }], pending: [], selectedPerson: person })}</NextIntlClientProvider>);
    expect(document.querySelector<HTMLInputElement>('input[name="personId"]')?.value).toBe(person.id);
    expect(document.querySelector('select[name="personId"]')).toBeNull();
    expect(document.querySelector<HTMLInputElement>('input[name="email"]')?.value).toBe(person.email);
    expect(document.querySelector<HTMLSelectElement>('select[name="role"]')?.value).toBe('employee');
    expect(document.querySelector<HTMLInputElement>('input[name="password"]')?.minLength).toBe(14);
    expect(document.querySelector<HTMLInputElement>('input[name="ownershipAttested"]')?.required).toBe(true);
  });
  it('defaults invitation language to the current locale and keeps all six explicit choices',async()=>{
    m.locale.mockResolvedValue('ms');render(<NextIntlClientProvider locale="en" messages={en}>{await InvitePage({searchParams:Promise.resolve({activate:person.id})})}</NextIntlClientProvider>);
    const language=screen.getByRole<HTMLSelectElement>('combobox',{name:en.emailDesign.language});expect(language.name).toBe('emailLocale');expect(language.value).toBe('ms');expect(Array.from(language.options,option=>option.value)).toEqual(['en','ms','zh','vi','ta','th']);
  });
  it('does not trust a forged or stale activation target from the URL', async () => {
    render(<NextIntlClientProvider locale="en" messages={en}>{await CreatePage({searchParams:Promise.resolve({activate:'foreign-or-archived-person'})})}{await InvitePage({searchParams:Promise.resolve({activate:'foreign-or-archived-person'})})}</NextIntlClientProvider>);
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
    fireEvent.click(d.getByRole('button',{name:'Activate'}));
    expect(d.getByRole('link', { name: 'Set username and password' }).getAttribute('href')).toContain('person-b');
  });
  it('shows unfinished manual setup once and offers resume instead of a second activation', async () => {
    m.enrollments.mockResolvedValue([{ id: 'setup', person_id: person.id, status: 'prepared', app_user_id: null }]);
    await show({ activate: person.id }); const d = within(directory());
    expect(d.getByText('Setup pending')).toBeTruthy(); expect(d.getByRole('link', { name: 'Resume setup' })).toBeTruthy();
    expect(d.queryByText('Pending activation')).toBeNull();
    const data=await import('../app/(app)/admin/users/data');expect((await data.loadUsersData({tenantId:'tenant'} as never)).pendingEmployees).toEqual([]);
  });
  it('hidden archived logins cannot reappear through an invitation or a concurrent pending read', async () => {
    m.users.mockResolvedValue({ users: [{ id: 'archived', personId: person.id, name: person.name, email: person.email, archivedAt: new Date(), roles: [] }], hiddenCount: 0 });
    m.invitations.mockResolvedValue([{ id: 'stale-invite', personId: person.id, email: person.email }]);
    await show({ activate: person.id });
    expect(within(directory()).queryByText(person.name)).toBeNull();
    expect(m.users).toHaveBeenCalledWith(expect.anything(), { includeArchived: true });
    const data=await import('../app/(app)/admin/users/data');expect((await data.loadUsersData({tenantId:'tenant'} as never)).pendingEmployees).toEqual([]);
  });
  it('labels a named standalone login and retains its normal archive and role controls',async()=>{
    m.users.mockResolvedValue({users:[{id:'external-user',personId:'external-person',name:'External admin',email:'external@example.test',hasEmployment:false,roles:[{id:'grant',role:'hr_admin',companyId:null}]}],hiddenCount:0});
    m.candidates.mockResolvedValue([]);await show();const d=within(directory());
    expect(d.getByText('External admin')).toBeTruthy();expect(d.queryByText('No employee record')).toBeNull();
    fireEvent.click(d.getByRole('button',{name:'Manage'}));
    expect(d.getByText('No employee record')).toBeTruthy();
    expect(d.getByRole('button',{name:'Archive'})).toBeTruthy();expect(d.getByRole('button',{name:'Add role'})).toBeTruthy();
  });
  it('sends display fields to the client directory without full provider identity subjects',async()=>{
    const subject='provider-private-subject-abcdef123456';
    m.users.mockResolvedValue({users:[{id:'named',personId:'named-person',name:'Named account',email:'named@example.test',workosUserId:subject,roles:[]}],hiddenCount:0});m.candidates.mockResolvedValue([]);
    const tree=await UsersPage({searchParams:Promise.resolve({})});
    function find(node:ReactNode):Record<string,unknown>|undefined{
      if(!isValidElement<{children?:ReactNode}>(node))return;
      if(node.type===UsersDirectory)return node.props as Record<string,unknown>;
      for(const child of Children.toArray(node.props.children)){const found=find(child);if(found)return found;}
    }
    const props=find(tree);expect(props).toBeDefined();expect(JSON.stringify(props)).not.toContain(subject);
    expect(props?.rows).toEqual([expect.objectContaining({name:'Named account',loginSuffix:null})]);
  });
  it('delegated admins receive no pending roster or activation controls', async () => {
    m.group.mockReturnValue(false); await show();
    expect(m.candidates).not.toHaveBeenCalled(); expect(m.manual).not.toHaveBeenCalled();
    expect(screen.queryByText('Pending activation')).toBeNull();
  });
});
