import {beforeEach,describe,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({session:vi.fn(),allowed:vi.fn(),scope:vi.fn(),workforce:vi.fn(),payroll:vi.fn(),domain:vi.fn(),spec:vi.fn(),Gate:class extends Error{}}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:h.session}));vi.mock('../lib/scope',()=>({getScopeIds:h.scope}));
vi.mock('../core/read',()=>({allowedCompanies:h.allowed}));vi.mock('../core/ai-workforce-analysis',()=>({generateWorkforceAnalysis:h.workforce}));
vi.mock('../core/ai-payroll-comparison-analysis',()=>({generatePrivatePayrollComparisonAnalysis:h.payroll}));vi.mock('../core/report-payroll-comparison',()=>({payrollComparisonSpec:h.spec}));
vi.mock('../core/ai-domain-analysis',()=>({generateDomainAnalysis:h.domain}));vi.mock('../lib/ai/provider-privacy-request',()=>({AiPrivacyGateError:h.Gate}));
vi.mock('../lib/hr-date',()=>({todayInKualaLumpur:()=> '2026-10-30'}));
import {protectedAnalysisAction} from '../app/analytics/ai-actions';
const session={tenantId:'tenant',userId:'user'},spec={datasetId:'owned-canonical-payroll-report'};
beforeEach(()=>{vi.clearAllMocks();h.session.mockResolvedValue(session);h.allowed.mockResolvedValue([{id:'company-b'},{id:'company-a'}]);h.scope.mockResolvedValue(['company-b','company-a']);h.workforce.mockResolvedValue('Source explanation');h.payroll.mockResolvedValue('Source explanation');h.domain.mockResolvedValue('Source explanation');h.spec.mockReturnValue(spec);});
describe('read-only protected analysis action',()=>{
 it('uses a fresh command session and server-selected scope for workforce without accepting page filters',async()=>{
  expect(await protectedAnalysisAction({domain:'workforce'})).toEqual({ok:true,text:'Source explanation',scopeKey:'["company-a","company-b"]'});
  expect(h.session).toHaveBeenCalledOnce();expect(h.allowed).toHaveBeenCalledWith(session);expect(h.scope).toHaveBeenCalledWith(['company-b','company-a']);
  expect(h.workforce).toHaveBeenCalledWith(session,{companyIds:['company-a','company-b'],currentPeriod:'2026-09'});expect(h.domain).not.toHaveBeenCalled();
 });
 it('uses the canonical native payroll spec and retains native export authorization',async()=>{
  await protectedAnalysisAction({domain:'payroll',month:'2026-08'});expect(h.spec).toHaveBeenCalledOnce();
  expect(h.payroll).toHaveBeenCalledWith(session,spec,['company-a','company-b'],{currentPeriod:'2026-08'});
 });
 for(const domain of ['attendance','leave','claims','performance','rewards','organisation'])it(`routes ${domain} to the real native-backed source`,async()=>{
  await protectedAnalysisAction({domain});expect(h.domain).toHaveBeenCalledWith(session,{domain,companyIds:['company-a','company-b'],...(domain==='attendance'?{month:'2026-09'}:{})});
 });
 it('rejects posted scope, report, arbitrary domain and unfinished/history-on-snapshot input before source admission',async()=>{
  for(const value of [{domain:'claims',companyIds:['foreign']},{domain:'payroll',spec:{}},{domain:'other'},{domain:'workforce',month:'2026-10'},{domain:'workforce',month:'bad'},{domain:'claims',month:'2026-09'}])expect(await protectedAnalysisAction(value)).toEqual({ok:false,notice:'invalid_request'});
  expect(h.session).not.toHaveBeenCalled();expect(h.payroll).not.toHaveBeenCalled();expect(h.domain).not.toHaveBeenCalled();
 });
 it('refuses empty and unknown derived company selections',async()=>{
  h.scope.mockResolvedValueOnce([]).mockResolvedValueOnce(['foreign']);
  expect(await protectedAnalysisAction({domain:'claims'})).toEqual({ok:false,notice:'unavailable'});expect(await protectedAnalysisAction({domain:'claims'})).toEqual({ok:false,notice:'unavailable'});expect(h.domain).not.toHaveBeenCalled();
 });
 it('returns a closed privacy notice and never exposes raw source/provider errors',async()=>{
  h.domain.mockRejectedValueOnce(new h.Gate('PRIVATE_DETAIL')).mockRejectedValueOnce(Error('PRIVATE_DATABASE_DETAIL'));
  expect(await protectedAnalysisAction({domain:'claims'})).toEqual({ok:false,notice:'privacy_unavailable'});expect(await protectedAnalysisAction({domain:'claims'})).toEqual({ok:false,notice:'failed'});
 });
});
