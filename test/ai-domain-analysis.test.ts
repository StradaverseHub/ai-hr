import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
const h=vi.hoisted(()=>({tenant:vi.fn(),principal:vi.fn(),fields:vi.fn(),entitlements:vi.fn(),module:vi.fn(),allowed:vi.fn(),native:vi.fn(),configuration:vi.fn(),privateAnalysis:vi.fn(),
 configTx:{tag:'configuration',execute:vi.fn()},preparedTx:{tag:'prepared',execute:vi.fn()},admittedTx:{tag:'admitted',execute:vi.fn()},issuedCtx:null as unknown,sources:[] as unknown[],admin:true}));
vi.mock('../db/client',()=>({withTenant:h.tenant}));
vi.mock('../core/employee-master-access',()=>({assertReportPrincipalTx:h.principal,masterReportFieldsTx:h.fields}));
vi.mock('../core/entitlements',()=>({resolveEntitlementsTx:h.entitlements,assertModuleEnabled:h.module}));
vi.mock('../core/read',()=>({allowedCompanies:h.allowed,leaveAnalysisSourceTx:h.native}));
vi.mock('../packs/attendance/service',()=>({attendanceAnalysisSourceTx:h.native}));
vi.mock('../packs/claims/service',()=>({claimsAnalysisSourceTx:h.native}));
vi.mock('../packs/performance/service',()=>({performanceAnalysisSourceTx:h.native}));
vi.mock('../packs/rewards/service',()=>({rewardsAnalysisSourceTx:h.native}));
vi.mock('../core/hr-orchestrator',()=>({organisationAnalysisSourceTx:h.native}));
vi.mock('../core/ai-config',()=>({resolveActiveAiConfig:h.configuration}));
vi.mock('../core/ai-governance',()=>({generatePrivateAiTaskAnalysis:h.privateAnalysis}));
vi.mock('../lib/hr-date',()=>({todayInKualaLumpur:()=> '2026-10-30'}));
import {domainAnalysisProjection,generateDomainAnalysis,type AnalysisDomain} from '../core/ai-domain-analysis';
const company='10000000-0000-4000-8000-000000000001';
const ctx=():SessionContext=>({tenantId:'20000000-0000-4000-8000-000000000001',userId:'20000000-0000-4000-8000-000000000002',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:company}]});
const person=(n:number)=>`30000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const metrics:Record<AnalysisDomain,string[]>={attendance:['lateness_prevalence','absence_prevalence'],leave:['pending_request_share'],claims:['pending_claim_share'],performance:['review_completion'],rewards:['facts_verification_share'],organisation:['open_workload']};
function source(domain:AnalysisDomain,numerator=10,population=30){return {selection:'private-native-source',rows:Array.from({length:population},(_,i)=>({personId:person(i),conditions:Object.fromEntries(metrics[domain].map(metric=>[metric,i<numerator]))}))};}
beforeEach(()=>{
 vi.clearAllMocks();h.admin=true;h.sources=[];
 for(const tx of [h.configTx,h.preparedTx,h.admittedTx])tx.execute.mockImplementation(async()=>[{allowed:h.admin}]);
 h.tenant.mockImplementation(async(current,read)=>read(h.configTx));h.principal.mockResolvedValue(undefined);
 h.fields.mockResolvedValue([{owner:'employment',ownerField:'hiredOn',sensitivity:'personnel',report:{enabled:true}}]);
 h.entitlements.mockResolvedValue({fresh:true});h.module.mockReturnValue(undefined);h.allowed.mockResolvedValue([{id:company}]);
 h.configuration.mockImplementation(async(_tx,current)=>{h.issuedCtx=current;return {provider:'synthetic-only'};});
 h.privateAnalysis.mockImplementation(async(_config,contract,read)=>{expect(contract).toBe('aggregate_snapshot_analysis_v1');h.sources.push(await read(h.preparedTx,h.issuedCtx));h.sources.push(await read(h.admittedTx,h.issuedCtx));return 'Protected source explanation';});
});
describe('native source adoption across six domains',()=>{
 for(const domain of Object.keys(metrics) as AnalysisDomain[])it(`uses actual admission transactions and useful ${domain} counts`,async()=>{
  h.native.mockResolvedValue(source(domain));
  await expect(generateDomainAnalysis(ctx(),{domain,companyIds:[company]})).resolves.toBe('Protected source explanation');
  expect(h.configuration).toHaveBeenCalledWith(h.configTx,expect.anything(),'report_insight');
  expect(h.native.mock.calls.map(call=>call[0])).toEqual([h.preparedTx,h.admittedTx]);
  for(const call of h.native.mock.calls){expect(call[2]).toEqual([company]);expect(Object.isFrozen(call[2])).toBe(true);}
  expect(h.principal).toHaveBeenCalledTimes(3);expect(h.fields).toHaveBeenCalledTimes(3);
  const expected={version:1,domain,window:'current_snapshot',cohorts:[{cohort:'cohort_a',population:30,metrics:metrics[domain].map(metric=>({metric,support:30,numeratorPeople:10,slices:[]}))}]};
  expect(h.sources).toEqual([expected,expected]);expect(JSON.stringify(h.sources)).not.toMatch(/private-native-source|30000000|10000000|2026-|personId|companyIds/);
  if(domain==='attendance')expect(h.native.mock.calls[0][3]).toBe('2026-09');
 });
 it('refuses a same-band person-condition source change at replay',async()=>{
  const first=source('claims'),changed=source('claims');changed.rows[0].conditions.pending_claim_share=false;changed.rows[20].conditions.pending_claim_share=true;
  h.native.mockResolvedValueOnce(first).mockResolvedValueOnce(changed);
  await expect(generateDomainAnalysis(ctx(),{domain:'claims',companyIds:[company]})).rejects.toThrow('unavailable');
 });
 it('counts persons rather than repeat requests/employments and uses ANY pending condition',()=>{
  const input=source('claims');input.rows.push({personId:person(20),conditions:{pending_claim_share:true}});
  const metric=domainAnalysisProjection('claims',input).cohorts[0].metrics[0];expect(metric).toEqual({metric:'pending_claim_share',support:30,numeratorPeople:11,slices:[]});
 });
 for(const domain of ['performance','rewards'] as const)it(`${domain} completion requires every entry for the same person`,()=>{
  const input=source(domain);input.rows.push({personId:person(0),conditions:{[metrics[domain][0]]:false}});
  expect(domainAnalysisProjection(domain,input).cohorts[0].metrics[0].numeratorPeople).toBe(9);
 });
 it('rejects a tiny complement even in a large cohort, and a tiny nonzero numerator',()=>{
  expect(()=>domainAnalysisProjection('leave',source('leave',29,30))).toThrow('unavailable');
  expect(()=>domainAnalysisProjection('leave',source('leave',4,30))).toThrow('unavailable');
  expect(()=>domainAnalysisProjection('leave',source('leave',10,19))).toThrow('unavailable');
 });
 it('allows genuine none/all shares without inventing tiny categories',()=>{
  expect(domainAnalysisProjection('organisation',source('organisation',0)).cohorts[0].metrics[0].numeratorPeople).toBe(0);
  expect(domainAnalysisProjection('organisation',source('organisation',30)).cohorts[0].metrics[0].numeratorPeople).toBe(30);
 });
 it('refuses unknown metric fields and malformed person support',()=>{
  const input=source('claims');input.rows[0].conditions.rawNarrative=true;
  expect(()=>domainAnalysisProjection('claims',input)).toThrow('unavailable');
  expect(()=>domainAnalysisProjection('claims',{selection:'x',rows:[...source('claims').rows,{personId:'invalid',conditions:{pending_claim_share:false}}]})).toThrow('unavailable');
 });
 it('refuses stale/native principal, denied granular personnel, disabled module and selected-scope mismatch before provider',async()=>{
  h.principal.mockRejectedValueOnce(Error('stale principal'));
  await expect(generateDomainAnalysis(ctx(),{domain:'claims',companyIds:[company]})).rejects.toThrow('stale principal');
  h.fields.mockResolvedValueOnce([]);await expect(generateDomainAnalysis(ctx(),{domain:'claims',companyIds:[company]})).rejects.toThrow('unavailable');
  h.module.mockImplementationOnce(()=>{throw Error('module disabled');});await expect(generateDomainAnalysis(ctx(),{domain:'claims',companyIds:[company]})).rejects.toThrow('module disabled');
  h.allowed.mockResolvedValueOnce([]);await expect(generateDomainAnalysis(ctx(),{domain:'claims',companyIds:[company]})).rejects.toThrow('unavailable');
  expect(h.privateAnalysis).not.toHaveBeenCalled();expect(h.native).not.toHaveBeenCalled();
 });
 it('rechecks company admin authority during actual admission',async()=>{
  h.native.mockResolvedValue(source('claims'));h.admittedTx.execute.mockResolvedValueOnce([{allowed:false}]);
  await expect(generateDomainAnalysis(ctx(),{domain:'claims',companyIds:[company]})).rejects.toThrow('unavailable');
  expect(h.native).toHaveBeenCalledOnce();
 });
 it('captures scope before await and does not inherit later caller mutation',async()=>{
  h.native.mockResolvedValue(source('claims'));const companyIds=[company],options={domain:'claims' as const,companyIds};
  const pending=generateDomainAnalysis(ctx(),options);companyIds.splice(0,1,'10000000-0000-4000-8000-000000000099');await pending;
  expect(h.native.mock.calls[0][2]).toEqual([company]);
 });
 it('refuses empty/unknown/duplicate scopes, proxies/getters and unfinished month',async()=>{
  for(const value of [{domain:'claims',companyIds:[]},{domain:'claims',companyIds:[company,company]},{domain:'unknown',companyIds:[company]},
   {domain:'attendance',companyIds:[company],month:'2026-10'},{domain:'claims',companyIds:[company],cycleId:company},
   {domain:'claims',get companyIds(){throw Error('getter ran');}},new Proxy({domain:'claims',companyIds:[company]}, {})]){
   await expect(generateDomainAnalysis(ctx(),value as never)).rejects.toThrow('unavailable');
  }
  expect(h.tenant).not.toHaveBeenCalled();
 });
});
