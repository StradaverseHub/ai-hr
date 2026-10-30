/** Pure native-source adoption/custody tests. Native report permissions, query/config and central AI
 * dispatch are explicit ports, not database or privacy-review proofs. No provider or DB is called. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext,Tx} from '../db/client';
import {prepareProviderAnalysis,inspectPreparedProviderAnalysis,retireProviderAnalysis,fingerprintProviderAnalysisSource} from '../lib/ai/provider-analysis-policy';
const h=vi.hoisted(()=>({tenant:vi.fn(),principal:vi.fn(),fields:vi.fn(),entitlements:vi.fn(),module:vi.fn(),allowed:vi.fn(),native:vi.fn(),configuration:vi.fn(),privateAnalysis:vi.fn(),
 today:'2026-10-30',issuedCtx:null as unknown,contexts:[] as unknown[],sources:[] as unknown[],admin:true,
 configTx:{tag:'configuration',execute:vi.fn()},preparedTx:{tag:'prepared',execute:vi.fn()},admittedTx:{tag:'admitted',execute:vi.fn()}}));
vi.mock('../db/client',()=>({withTenant:h.tenant}));
vi.mock('../core/employee-master-access',()=>({assertReportPrincipalTx:h.principal,masterReportFieldsTx:h.fields}));
vi.mock('../core/entitlements',()=>({resolveEntitlementsTx:h.entitlements,assertModuleEnabled:h.module}));
vi.mock('../core/read',()=>({allowedCompanies:h.allowed}));
vi.mock('../core/analytics',()=>({workforceHeadcountSourceTx:h.native}));
vi.mock('../core/ai-config',()=>({resolveActiveAiConfig:h.configuration}));
vi.mock('../core/ai-governance',()=>({generatePrivateAiAnalysis:h.privateAnalysis}));
vi.mock('../lib/hr-date',()=>({todayInKualaLumpur:()=>h.today}));
import {generateWorkforceAnalysis} from '../core/ai-workforce-analysis';
const companyA='10000000-0000-4000-8000-000000000001',companyB='10000000-0000-4000-8000-000000000002';
const ctx=():SessionContext=>({tenantId:'20000000-0000-4000-8000-000000000001',userId:'20000000-0000-4000-8000-000000000002',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:companyA}]});
const counts=()=>({previousHeadcount:30,currentHeadcount:33,previousPersons:30,currentPersons:31,unionPersons:32});
beforeEach(()=>{
 vi.clearAllMocks();h.today='2026-10-30';h.admin=true;h.sources=[];h.contexts=[];h.issuedCtx=null;
 for(const tx of [h.configTx,h.preparedTx,h.admittedTx])tx.execute.mockImplementation(async()=>[{allowed:h.admin}]);
 h.tenant.mockImplementation(async(current,read)=>{h.contexts.push(current);return read(h.configTx);});
 h.principal.mockResolvedValue(undefined);h.fields.mockResolvedValue([{owner:'employment',ownerField:'hiredOn',sensitivity:'personnel',report:{enabled:true}}]);
 h.entitlements.mockImplementation(async(tx)=>({fresh:true,source:tx.tag}));h.module.mockReturnValue(undefined);
 h.allowed.mockResolvedValue([{id:companyA},{id:companyB}]);h.native.mockImplementation(async()=>counts());
 h.configuration.mockImplementation(async(_tx,current)=>{h.issuedCtx=current;return Object.freeze({provider:'anthropic',model:'fictional-model',apiKey:'fictional-not-sent'});});
 h.privateAnalysis.mockImplementation(async(_configuration,read)=>{h.sources.push(await read(h.preparedTx,h.issuedCtx));h.sources.push(await read(h.admittedTx,h.issuedCtx));return 'Protected native workforce comparison';});
});
describe('real workforce analysis source adoption',()=>{
 it('uses each actual callback transaction and native headcount owner, yielding a useful protected comparison with no invented drivers',async()=>{
  await expect(generateWorkforceAnalysis(ctx(),{companyIds:[companyA]})).resolves.toBe('Protected native workforce comparison');
  expect(h.configuration).toHaveBeenCalledWith(h.configTx,expect.anything(),'report_insight');expect(h.privateAnalysis).toHaveBeenCalledOnce();
  expect(h.native.mock.calls.map(call=>call[0])).toEqual([h.preparedTx,h.admittedTx]);
  for(const [tx,scope,dates] of h.native.mock.calls){expect([h.preparedTx,h.admittedTx]).toContain(tx);expect(scope).toEqual([companyA]);expect(Object.isFrozen(scope)).toBe(true);expect(dates).toEqual({previousAsOf:'2026-08-31',currentAsOf:'2026-09-30'});}
  expect(h.sources).toEqual(Array(2).fill({version:1,domain:'workforce',window:'calendar_month',cohorts:[{cohort:'cohort_a',population:32,metrics:[{metric:'active_workforce',support:30,changeBand:'increase_5_to_10_percent',drivers:[],slices:[]}]}]}));
  const source=h.sources[0],binding={feature:'report_insight',operation:'draft',contractId:'aggregate_comparison_analysis_v1',principalDigest:'1'.repeat(64),scopeDigest:'2'.repeat(64),providerSnapshotDigest:'3'.repeat(64),sourceFingerprint:fingerprintProviderAnalysisSource(source),expiresAt:Date.now()+60000};
  const prepared=prepareProviderAnalysis(binding,source),review=inspectPreparedProviderAnalysis(prepared,binding);
  expect(review.json).toContain('increase_5_to_10_percent');expect(review.json).toContain('20_to_49');expect(review.json).not.toContain(companyA);expect(review.json).not.toMatch(/2026-|previousHeadcount|personId|companyIds|employeeName/);expect(review.reviewStatus).toBe('approved');retireProviderAnalysis(prepared);
  expect(h.principal.mock.calls.map(call=>call[0])).toEqual([h.configTx,h.preparedTx,h.admittedTx]);expect(h.fields.mock.calls.map(call=>call[0])).toEqual([h.configTx,h.preparedTx,h.admittedTx]);
  for(const [tx,fresh,scope] of h.fields.mock.calls){expect(scope).toEqual([companyA]);expect(fresh.entitlements).toEqual({fresh:true,source:tx.tag});}
  expect(h.module.mock.calls.map(call=>[call[1],call[2]])).toEqual(Array(3).fill(['employees',companyA]));
 });
 it.each([{previousHeadcount:40,currentHeadcount:38,band:'decrease_up_to_5_percent'},{previousHeadcount:20,currentHeadcount:30,band:'increase_over_25_percent'},{previousHeadcount:25,currentHeadcount:25,band:'unchanged'}])('uses native deterministic change coarsening for $band',async({previousHeadcount,currentHeadcount,band})=>{
  h.native.mockResolvedValue({previousHeadcount,currentHeadcount,previousPersons:20,currentPersons:20,unionPersons:20});await generateWorkforceAnalysis(ctx(),{companyIds:[companyA],currentPeriod:'2026-08'});
  expect(h.sources[0]).toMatchObject({cohorts:[{metrics:[{changeBand:band}]}]});expect(h.native.mock.calls[0][2]).toEqual({previousAsOf:'2026-07-31',currentAsOf:'2026-08-31'});
 });
 it('captures company scope, period and principal before an asynchronous lookup and never opens extra tenant transactions for replay',async()=>{
  let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(yes=>{entered=yes;}),held=new Promise<void>(yes=>{release=yes;});
  h.tenant.mockImplementationOnce(async(current,read)=>{h.contexts.push(current);entered();await held;return read(h.configTx);});
  const current=ctx(),options={companyIds:[companyA],currentPeriod:'2026-09'},pending=generateWorkforceAnalysis(current,options);await reached;
  options.companyIds[0]=companyB;options.currentPeriod='2026-10';current.roles![0]='employee';current.grants![0].companyId=companyB;release();await pending;
  for(const call of h.native.mock.calls)expect(call[1]).toEqual([companyA]);for(const [,fresh] of h.fields.mock.calls){expect(fresh.roles).toEqual(['hr_admin']);expect(fresh.grants).toEqual([{role:'hr_admin',companyId:companyA}]);}
  expect(h.tenant).toHaveBeenCalledOnce();expect(h.native).toHaveBeenCalledTimes(2);
 });
 it('refuses empty/unknown scopes and incomplete months before native data or provider configuration',async()=>{
  for(const options of [{companyIds:[]},{companyIds:['bad']},{companyIds:[companyA,companyA]},{companyIds:[companyA],currentPeriod:'2026-10'},{companyIds:[companyA],currentPeriod:'2026-11'},{companyIds:[companyA],currentPeriod:'2026-13'}])await expect(generateWorkforceAnalysis(ctx(),options)).rejects.toThrow('Workforce analysis');
  expect(h.configuration).not.toHaveBeenCalled();expect(h.native).not.toHaveBeenCalled();expect(h.privateAnalysis).not.toHaveBeenCalled();
  h.allowed.mockResolvedValue([{id:companyB}]);await expect(generateWorkforceAnalysis(ctx(),{companyIds:[companyA]})).rejects.toThrow();expect(h.configuration).not.toHaveBeenCalled();
 });
 it('requires current principal, administrator authority and native granular personnel access even for an admin-looking session',async()=>{
  h.principal.mockRejectedValueOnce(Error('Native current report principal refused'));await expect(generateWorkforceAnalysis(ctx(),{companyIds:[companyA]})).rejects.toThrow('principal');
  const employee={...ctx(),roles:['employee'],grants:[{role:'employee',companyId:companyA}]};await expect(generateWorkforceAnalysis(employee,{companyIds:[companyA]})).rejects.toThrow('Workforce analysis');
  h.admin=false;await expect(generateWorkforceAnalysis(ctx(),{companyIds:[companyA]})).rejects.toThrow();h.admin=true;
  h.fields.mockRejectedValueOnce(Error('Native report.read.personnel refused'));await expect(generateWorkforceAnalysis(ctx(),{companyIds:[companyA]})).rejects.toThrow('report.read.personnel');
  h.fields.mockResolvedValueOnce([]);await expect(generateWorkforceAnalysis(ctx(),{companyIds:[companyA]})).rejects.toThrow();
  expect(h.configuration).not.toHaveBeenCalled();expect(h.native).not.toHaveBeenCalled();
 });
 it('rechecks a removed company scope and revoked granular permission during actual source replay',async()=>{
  h.allowed.mockImplementation(async(_ctx,tx)=>tx===h.admittedTx?[]:[{id:companyA}]);await expect(generateWorkforceAnalysis(ctx(),{companyIds:[companyA]})).rejects.toThrow();expect(h.native).toHaveBeenCalledOnce();
  h.allowed.mockResolvedValue([{id:companyA}]);h.native.mockClear();h.fields.mockImplementation(async(tx)=>{if(tx===h.admittedTx)throw Error('Native personnel permission revoked');return [{owner:'employment',ownerField:'hiredOn',sensitivity:'personnel',report:{enabled:true}}];});
  await expect(generateWorkforceAnalysis(ctx(),{companyIds:[companyA]})).rejects.toThrow('revoked');expect(h.native).toHaveBeenCalledOnce();
 });
 it.each([{previousHeadcount:100,currentHeadcount:100,previousPersons:1,currentPersons:1,unionPersons:1},
  {previousHeadcount:40,currentHeadcount:40,previousPersons:19,currentPersons:25,unionPersons:30},
  {previousHeadcount:40,currentHeadcount:40,previousPersons:25,currentPersons:19,unionPersons:30},
  {previousHeadcount:40,currentHeadcount:40,previousPersons:25,currentPersons:25,unionPersons:19},
  {previousHeadcount:0,currentHeadcount:40,previousPersons:0,currentPersons:25,unionPersons:25}])('refuses rows/employments as a substitute for sufficient DISTINCT PERSON support: %o',async source=>{
  h.native.mockResolvedValue(source);await expect(generateWorkforceAnalysis(ctx(),{companyIds:[companyA]})).rejects.toThrow('Workforce analysis');expect(h.sources).toEqual([]);
 });
 it('uses completed HR calendar periods across the year boundary and never invents a provider fallback',async()=>{
  h.today='2027-01-01';await generateWorkforceAnalysis(ctx(),{companyIds:[companyA]});expect(h.native.mock.calls[0][2]).toEqual({previousAsOf:'2026-11-30',currentAsOf:'2026-12-31'});
  h.configuration.mockResolvedValueOnce(null);h.privateAnalysis.mockClear();await expect(generateWorkforceAnalysis(ctx(),{companyIds:[companyA]})).rejects.toThrow();expect(h.privateAnalysis).not.toHaveBeenCalled();
 });
 it('refuses changed native counts even when both versions share the same disclosed range',async()=>{
  h.native.mockResolvedValueOnce(counts()).mockResolvedValueOnce({...counts(),currentHeadcount:32});
  await expect(generateWorkforceAnalysis(ctx(),{companyIds:[companyA]})).rejects.toThrow('Workforce analysis');expect(h.native).toHaveBeenCalledTimes(2);
 });
 it('rejects proxy options and proxy company arrays without invoking their traps',async()=>{
  let invoked=0;const proxy=new Proxy({companyIds:[companyA]},{getPrototypeOf(){invoked++;return Object.prototype;}}),ids=new Proxy([companyA],{getPrototypeOf(){invoked++;return Array.prototype;}});
  await expect(generateWorkforceAnalysis(ctx(),proxy)).rejects.toThrow();await expect(generateWorkforceAnalysis(ctx(),{companyIds:ids})).rejects.toThrow();expect(invoked).toBe(0);
 });

});
