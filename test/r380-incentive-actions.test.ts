/** UI contract only: the scoped country-pack service owns permission, eligibility and audit writes. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(), packFor: vi.fn(), save: vi.fn(), revoke: vi.fn(),
  revalidate: vi.fn(), redirect: vi.fn(),
}));
vi.mock('../lib/authz', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../localization/registry', () => ({ packFor: mocks.packFor }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { saveIncentiveDeclarationAction, revokeIncentiveDeclarationAction }
  from '../app/admin/personnel/[employmentId]/incentive-actions';

const employmentId = '11111111-1111-4111-8111-111111111111';
const expectedCompanyId = '22222222-2222-4222-8222-222222222222';
const declarationId = '33333333-3333-4333-8333-333333333333';
const session = { tenantId: '44444444-4444-4444-8444-444444444444', userId: 'hr-user', roles: ['hr_admin'] };
const codes = ['invalid_scheme', 'invalid_period', 'approval_required', 'missing_reference', 'not_found',
  'not_resident', 'citizenship_unknown', 'overlap', 'missing_declaration', 'declaration_revoked', 'declaration_outside_period', 'stale_context'];

function form(overrides: Record<string, string | null> = {}) {
  const values: Record<string, string | null> = { employmentId, expectedCompanyId, id: declarationId,
    scheme: 'c_suite', validFrom: '2027-01', validTo: '2027-12', approvalReference: '  APPROVAL-REF  ',
    eligibilityConfirmed: 'confirmed', ...overrides };
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) if (value !== null) fd.set(key, value);
  return fd;
}
function serviceError(code: string) {
  return Object.assign(new Error(code), { name: 'TaxSchemeDeclarationError', code });
}
async function submitted(action: (fd: FormData) => Promise<unknown>, fd: FormData) {
  await expect(action(fd)).rejects.toThrow('NEXT_REDIRECT');
  expect(mocks.redirect).toHaveBeenCalledTimes(1);
  return String(mocks.redirect.mock.calls[0][0]);
}
function expectRefusal(url: string, code: string) {
  const parsed = new URL(url, 'http://localhost');
  expect(parsed.pathname).toBe(`/admin/personnel/${employmentId}`);
  expect(parsed.searchParams.get('tab')).toBe('bankStatutory');
  expect(parsed.searchParams.get('incentiveError')).toBe(code);
  expect(parsed.searchParams.has('toast')).toBe(false);
  expect(mocks.revalidate).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue(session);
  mocks.packFor.mockReturnValue({ statutory: { saveTaxSchemeDeclaration: mocks.save, revokeTaxSchemeDeclaration: mocks.revoke } });
  mocks.save.mockResolvedValue(declarationId);
  mocks.revoke.mockResolvedValue(undefined);
  mocks.redirect.mockImplementation(() => { throw new Error('NEXT_REDIRECT'); });
});

describe('r380 incentive declaration action form contract', () => {
  it('forwards payroll context and server-reviewed employer/period preconditions without changing current-personnel navigation',async()=>{
    const payrollBatchId='55555555-5555-4555-8555-555555555555';
    const url=await submitted(saveIncentiveDeclarationAction,form({payrollBatchId,expectedPayPeriod:'2027-01'}));
    expect(mocks.save.mock.calls[0][1]).toMatchObject({payrollBatchId,expectedPayPeriod:'2027-01',expectedCompanyId});
    expect(new URL(url,'http://localhost').pathname).toBe(`/payroll/${payrollBatchId}/tax-configuration/${employmentId}`);
  });
  it('carries payroll-list filters and a job identifier through configuration save and revoke using the shared whitelist',async()=>{
    const payrollBatchId='55555555-5555-4555-8555-555555555555';
    const payrollJob='66666666-6666-4666-8666-666666666666';
    const payrollFrom='/payroll?year=2027&m=1&company=selected';
    for(const action of [saveIncentiveDeclarationAction,revokeIncentiveDeclarationAction]){
      mocks.redirect.mockClear();
      const url=await submitted(action,form({payrollBatchId,expectedPayPeriod:'2027-01',payrollFrom,payrollJob}));
      const q=new URL(url,'http://localhost').searchParams;
      expect(q.get('from')).toBe(payrollFrom);expect(q.get('job')).toBe(payrollJob);
    }
  });
  it.each(['https://attacker.example','//attacker.example/payroll','/payrollevil','/admin/personnel'])('does not echo hostile payroll navigation %s',async payrollFrom=>{
    const url=await submitted(saveIncentiveDeclarationAction,form({payrollBatchId:'55555555-5555-4555-8555-555555555555',expectedPayPeriod:'2027-01',payrollFrom,payrollJob:'../another'}));
    const q=new URL(url,'http://localhost').searchParams;
    expect(q.has('from')).toBe(false);expect(q.has('job')).toBe(false);
  });
  it.each(['rep', 'knowledge_worker', 'c_suite'])('forwards explicit %s approval and reviewed-employer precondition', async scheme => {
    const url = await submitted(saveIncentiveDeclarationAction, form({ scheme, companyId: 'attacker-company', personId: 'ignored-person' }));
    expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.packFor).toHaveBeenCalledWith('MY');
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(session, { employmentId, expectedCompanyId, scheme,
      validFrom: '2027-01', validTo: '2027-12', approvalReference: 'APPROVAL-REF', eligibilityConfirmed: true });
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.revalidate).toHaveBeenCalledExactlyOnceWith(`/admin/personnel/${employmentId}`);
    expect(new URL(url, 'http://localhost').searchParams.get('toast')).toBe('Saved');
  });

  it.each([null, '', 'on', 'true', 'false', '1'])('does not treat arbitrary checkbox presence (%s) as HR confirmation', async value => {
    expectRefusal(await submitted(saveIncentiveDeclarationAction, form({ eligibilityConfirmed: value })), 'approval_required');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each(['../other', 'https://attacker.example', '', 'not-a-uuid'])('refuses malformed employment ID %s without a service call', async value => {
    expect(await submitted(saveIncentiveDeclarationAction, form({ employmentId: value }))).toBe('/admin/personnel');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it.each(['', 'not-a-uuid', '../other'])('refuses malformed reviewed employer %s', async value => {
    expectRefusal(await submitted(saveIncentiveDeclarationAction, form({ expectedCompanyId: value })), 'stale_context');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([
    ['scheme', 'unknown', 'invalid_scheme'], ['validFrom', '0000-01', 'invalid_period'],
    ['validTo', '0000-12', 'invalid_period'], ['validFrom', '2027-00', 'invalid_period'],
    ['validTo', '2027-13', 'invalid_period'], ['validFrom', '2027-01-01', 'invalid_period'],
    ['validFrom', '2028-01', 'invalid_period'], ['validTo', '', 'invalid_period'],
    ['approvalReference', '   ', 'missing_reference'], ['approvalReference', 'X'.repeat(301), 'missing_reference'],
  ])('rejects invalid %s input before the service', async (field, value, code) => {
    expectRefusal(await submitted(saveIncentiveDeclarationAction, form({ [field]: value })), code);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('allows an inclusive single month and the exact reference boundary', async () => {
    await submitted(saveIncentiveDeclarationAction, form({ validTo: '2027-01', approvalReference: 'X'.repeat(300) }));
    expect(mocks.save.mock.calls[0][1]).toMatchObject({ validFrom: '2027-01', validTo: '2027-01', approvalReference: 'X'.repeat(300) });
  });

  it.each(codes)('maps known service refusal %s without publishing its raw message', async code => {
    const error = serviceError(code); error.message = 'sensitive database details';
    mocks.save.mockRejectedValue(error);
    const url = await submitted(saveIncentiveDeclarationAction, form());
    expectRefusal(url, code);
    expect(url).not.toContain('sensitive');
  });

  it.each([
    new Error('private SQL / tenant / permission detail'),
    Object.assign(new Error('unexpected'), { code: 'overlap' }),
    serviceError('unrecognized_secret_code'),
  ])('keeps arbitrary service/infrastructure errors generic', async error => {
    mocks.save.mockRejectedValue(error);
    const url = await submitted(saveIncentiveDeclarationAction, form());
    expectRefusal(url, 'saveFailed');
    expect(url).not.toContain(error.message);
  });

  it('preserves only fixed tab and approved navigation context', async () => {
    const url = new URL(await submitted(saveIncentiveDeclarationAction, form({ tab: '../../evil',
      from: 'org', asOf: '2027-01-15', returnTo: 'https://attacker.example' })), 'http://localhost');
    expect(url.pathname).toBe(`/admin/personnel/${employmentId}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ tab: 'bankStatutory', from: 'org', asOf: '2027-01-15', toast: 'Saved' });
  });

  it('drops untrusted navigation context on refusal too', async () => {
    const url = new URL(await submitted(saveIncentiveDeclarationAction, form({ eligibilityConfirmed: null,
      from: 'https://attacker.example', asOf: 'x&tab=evil' })), 'http://localhost');
    expect(Object.fromEntries(url.searchParams)).toEqual({ tab: 'bankStatutory', incentiveError: 'approval_required' });
  });

  it('does not reach any declaration service after the admin guard refuses', async () => {
    mocks.requireAdmin.mockRejectedValue(new Error('ACCESS_REFUSED'));
    await expect(saveIncentiveDeclarationAction(form())).rejects.toThrow('ACCESS_REFUSED');
    expect(mocks.packFor).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it('refuses an unavailable service without treating it as a saved declaration', async () => {
    mocks.packFor.mockReturnValue({ statutory: {} });
    expectRefusal(await submitted(saveIncentiveDeclarationAction, form()), 'unavailable');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('forwards revoke identifiers to the scoped owner and revalidates once', async () => {
    const url = await submitted(revokeIncentiveDeclarationAction, form());
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(session, { employmentId, id: declarationId });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.revalidate).toHaveBeenCalledExactlyOnceWith(`/admin/personnel/${employmentId}`);
    expect(new URL(url, 'http://localhost').searchParams.get('toast')).toBe('Saved');
  });

  it.each(['', '../other', 'not-a-uuid'])('refuses malformed revoke ID %s without a service call', async id => {
    expectRefusal(await submitted(revokeIncentiveDeclarationAction, form({ id })), 'invalid');
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it('maps a stale/unauthorized revoke refusal safely', async () => {
    mocks.revoke.mockRejectedValue(serviceError('not_found'));
    expectRefusal(await submitted(revokeIncentiveDeclarationAction, form()), 'not_found');
  });

  it('does not expose an arbitrary revoke failure', async () => {
    mocks.revoke.mockRejectedValue(new Error('private database payload'));
    expectRefusal(await submitted(revokeIncentiveDeclarationAction, form()), 'revokeFailed');
  });
});
