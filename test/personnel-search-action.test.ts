import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), search: vi.fn() }));
vi.mock('../lib/scope', () => ({ scopedAdmin: mocks.scope }));
vi.mock('../core/employee-search', () => ({ searchEmployeeOptions: mocks.search }));
import { searchPersonnelEmployeesAction } from '../app/admin/personnel/search-actions';

beforeEach(() => { vi.resetAllMocks(); });
describe('Personnel search action authorization and response boundary', () => {
  it('resolves current server scope on each call and sends only switcher fields to the browser', async () => {
    const session = { tenantId: 'server-tenant', userId: 'server-user' };
    mocks.scope.mockResolvedValueOnce({ s: session, scopeIds: ['company-one'] })
      .mockResolvedValueOnce({ s: session, scopeIds: ['company-two'] });
    mocks.search.mockResolvedValue([{ employmentId: 'employee', name: 'Name', employeeCode: 'CODE', company: 'Company', department: null,
      companyId: 'private-internal-id', terminatedOn: null, unexpectedSecret: 'never-serialize' }]);
    expect(await searchPersonnelEmployeesAction('Name')).toEqual([{ employmentId: 'employee', name: 'Name', employeeCode: 'CODE', company: 'Company', department: null }]);
    await searchPersonnelEmployeesAction('CODE');
    expect(mocks.search).toHaveBeenNthCalledWith(1, session, { companyIds: ['company-one'], query: 'Name' });
    expect(mocks.search).toHaveBeenNthCalledWith(2, session, { companyIds: ['company-two'], query: 'CODE' });
  });
  it('does not search when the admin guard rejects, even with a valid query', async () => {
    mocks.scope.mockRejectedValue(new Error('permission refused'));
    await expect(searchPersonnelEmployeesAction('known-code')).rejects.toThrow('permission refused');
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it('rejects malformed browser input after the authorization check', async () => {
    mocks.scope.mockResolvedValue({ s: {}, scopeIds: ['company'] });
    expect(await searchPersonnelEmployeesAction({ query: 'Name', companyIds: ['forged'] } as unknown as string)).toEqual([]);
    expect(mocks.scope).toHaveBeenCalledTimes(1);
    expect(mocks.search).not.toHaveBeenCalled();
  });
});
