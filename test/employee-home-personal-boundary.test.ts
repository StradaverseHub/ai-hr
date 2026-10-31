import {readFileSync} from 'node:fs';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {defaultEmployeeHomePreferences} from '../lib/employee-home';
const m=vi.hoisted(()=>({identity:vi.fn(),cards:vi.fn(),preferences:vi.fn(),missing:vi.fn()}));
vi.mock('@/core/employee-home',()=>({readEmployeeHomeIdentity:m.identity,HomeAccessError:class extends Error{constructor(readonly code:string){super('Private Home context');}}}));
vi.mock('@/core/dashboard-card-config',()=>({listEmployeeHomeCards:m.cards}));
vi.mock('@/core/dashboard-prefs',()=>({getEmployeeHomePreferences:m.preferences}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>(key:string)=>key}));
vi.mock('next/navigation',()=>({notFound:m.missing}));
import {HomeAccessError} from '@/core/employee-home';
import {EmployeePersonalHome} from '../components/employee-home/personal-home';
const ctx={tenantId:'fictional-tenant',userId:'fictional-login',personId:'fictional-person',roles:['employee'],entitlements:{tenantId:'fictional-tenant',tenantStatus:'active',enabledModules:[],scopedModules:{},settings:{}}};
beforeEach(()=>{vi.resetAllMocks();m.cards.mockResolvedValue([]);m.missing.mockImplementation(()=>{throw Error('fixture-not-found');});});
describe('personal Home selection refusal',()=>{
 it('keeps the optional greeting entitlement at the page boundary so its resolution failure cannot take down Home cards',async()=>{
  const page=readFileSync('app/(app)/page.tsx','utf8');
  expect(page).toContain("greetingsEnabled={isModuleEnabledOrFalse(s,'notifications')}");
  m.preferences.mockResolvedValue(defaultEmployeeHomePreferences());
  m.identity.mockResolvedValue({version:1,role:'employee',employmentState:'selected',selectedEmploymentId:'own',companyEstablished:true,employments:[{employmentId:'own',employeeCode:'A',company:'Fictional A'}]});
  const {entitlements,...unresolved}=ctx;
  await expect(EmployeePersonalHome({session:{...unresolved,entitlementsError:'Fictional snapshot outage'},employmentId:'own',greetingsEnabled:false})).resolves.toBeTruthy();
 });
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
 it('derives the workbench link from the selected salary-free identity and retains its employment',async()=>{
  m.preferences.mockResolvedValue(defaultEmployeeHomePreferences());
  m.identity.mockResolvedValue({version:1,role:'manager',employmentState:'selected',selectedEmploymentId:'own-second',companyEstablished:true,
   employments:[{employmentId:'own-first',employeeCode:'A',company:'Fictional A'},{employmentId:'own-second',employeeCode:'B',company:'Fictional B'}]});
  const html=renderToStaticMarkup(await EmployeePersonalHome({session:ctx,employmentId:'own-second'}));
  expect(html).toContain('workspace=team&amp;employmentId=own-second');
  m.identity.mockResolvedValue({version:1,role:'employee',employmentState:'selected',selectedEmploymentId:'own-second',companyEstablished:true,
   employments:[{employmentId:'own-second',employeeCode:'B',company:'Fictional B'}]});
  const employeeHtml=renderToStaticMarkup(await EmployeePersonalHome({session:{...ctx,roles:['manager']},employmentId:'own-second'}));
  expect(employeeHtml).not.toContain('workspace=team');
 });
});
