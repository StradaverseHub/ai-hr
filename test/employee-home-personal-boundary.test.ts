import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({identity:vi.fn(),cards:vi.fn(),preferences:vi.fn(),missing:vi.fn()}));
vi.mock('@/core/employee-home',()=>({readEmployeeHomeIdentity:m.identity,HomeAccessError:class extends Error{constructor(readonly code:string){super('Private Home context');}}}));
vi.mock('@/core/dashboard-card-config',()=>({listEmployeeHomeCards:m.cards}));
vi.mock('@/core/dashboard-prefs',()=>({getEmployeeHomePreferences:m.preferences}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>(key:string)=>key}));
vi.mock('next/navigation',()=>({notFound:m.missing}));
import {HomeAccessError} from '@/core/employee-home';
import {EmployeePersonalHome} from '../components/employee-home/personal-home';
const ctx={tenantId:'fictional-tenant',userId:'fictional-login',personId:'fictional-person',roles:['employee']};
beforeEach(()=>{vi.resetAllMocks();m.cards.mockResolvedValue([]);m.missing.mockImplementation(()=>{throw Error('fixture-not-found');});});
describe('personal Home selection refusal',()=>{
 it('maps an explicitly unavailable own selection to the not-found boundary instead of a server error',async()=>{
  m.identity.mockRejectedValueOnce(new HomeAccessError('employmentUnavailable'));
  await expect(EmployeePersonalHome({session:ctx,employmentId:'foreign'})).rejects.toThrow('fixture-not-found');
  expect(m.identity).toHaveBeenCalledWith(ctx,'foreign');expect(m.missing).toHaveBeenCalledOnce();expect(m.preferences).not.toHaveBeenCalled();
 });
 it('preserves a genuine service failure instead of disguising it as a missing employment',async()=>{
  const failure=new Error('Fictional service outage');m.identity.mockRejectedValueOnce(failure);
  await expect(EmployeePersonalHome({session:ctx,employmentId:'own'})).rejects.toBe(failure);
  expect(m.missing).not.toHaveBeenCalled();expect(m.preferences).not.toHaveBeenCalled();
 });
});
