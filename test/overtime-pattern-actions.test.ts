import {beforeEach,describe,expect,it,vi} from 'vitest';
import {todayInKualaLumpur} from '../lib/hr-date';
import {evaluateOvertimePattern} from '../lib/overtime-pattern-evaluate';
import type {OvertimePattern,OvertimeInput} from '../lib/overtime-pattern-model';
import type {OvertimeSampleDraft} from '../lib/overtime-pattern-ui';
const mocks=vi.hoisted(()=>({scope:vi.fn(),sample:vi.fn(),employee:vi.fn(),calculate:vi.fn(),read:vi.fn(),options:vi.fn(),transfer:vi.fn(),revalidate:vi.fn(),log:vi.fn(),saveDraft:vi.fn(),detail:vi.fn(),companies:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('../lib/scope',()=>({scopedAdmin:mocks.scope}));
vi.mock('../packs/attendance/service',()=>({
 OvertimeOwnerError:class extends Error {constructor(readonly code:string,message:string){super(message);}},
 saveOvertimePatternDraft:mocks.saveDraft,getOvertimePattern:mocks.detail,overtimePatternWorkspaceCompanies:mocks.companies,saveOvertimePatternAssignment:vi.fn(),closeOvertimePatternAssignment:vi.fn(),overtimePatternSetup:vi.fn(),previewOvertimePatternEmployee:mocks.employee,previewOvertimePatternSample:mocks.sample,calculateOvertimePatternDay:mocks.calculate,readOvertimePatternCalculation:mocks.read,
}));
vi.mock('../packs/payroll/service',()=>({overtimePatternTransferOptions:mocks.options,transferOvertimePatternToPayroll:mocks.transfer,OvertimePayrollError:class extends Error {constructor(readonly code:string){super('Finite financial refusal');}}}));
import {OvertimePayrollError} from '../packs/payroll/service';
import {OvertimeOwnerError} from '../packs/attendance/service';
import {prepareOvertimeStarter,overtimeStarterSeed} from '../lib/overtime-pattern-starters';
import {previewOvertimeSampleAction,previewOvertimeEmployeeAction,transferOvertimePayrollAction,readOvertimeTransferAction,saveOvertimeDraftAction} from '../app/admin/attendance/settings/overtime-patterns/actions';
const tenantId='00000000-0000-4000-8000-000000000001',versionId='00000000-0000-4000-8000-000000000002';
const date=todayInKualaLumpur();
function sample():OvertimeSampleDraft {return {date,currency:{code:'MYR',minorScale:2},facts:{basicSalary:'4000'},sessionGranularity:'recorded',approvalStatus:'approved',approvalMinutes:'240',segments:[{id:'sample-clock',sessionId:'one-session',date,rawMinutes:'999',dayType:'workday',endDayType:'rest_day',clockKnown:true,from:'22:00',to:'02:00',endDayOffset:1}],resources:[]};}

/** Explicit fictional policy for exercising the real sample-input → evaluator boundary. */
function fictionalPattern():OvertimePattern {
 return {v:1,currency:{code:'MYR',minorScale:2},definitions:[],eligibilityBasis:'day',durationAllocation:'earliest',eligibility:{id:'eligible',type:'constant',value:true},eligibleMinutes:null,durationCap:null,durationRounding:null,deductions:[],rates:[{id:'rate',name:'Fictional rate',description:'Synthetic regression policy',priority:0,when:{id:'rate-condition',type:'constant',value:true},timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[{id:'tier',from:'0',to:null,mapping:{earningItemId:tenantId,currency:'MYR'},payment:{method:'hourly',rate:{id:'rate-value',type:'literal',unit:'moneyPerHour',value:'12',currency:'MYR'},multiplier:{id:'rate-multiplier',type:'literal',unit:'scalar',value:'1'}}}]}],paymentCap:null,moneyRounding:{stage:'dayMapping',mode:'halfUp'}};
}

beforeEach(()=>{vi.clearAllMocks();mocks.scope.mockResolvedValue({s:{tenantId,userId:'verified-user'},scopeIds:[tenantId]});mocks.sample.mockResolvedValue({status:'ready',transferable:false});mocks.employee.mockResolvedValue({status:'ready',transferable:false});mocks.transfer.mockResolvedValue({status:'unchanged'});mocks.read.mockResolvedValue(null);mocks.options.mockResolvedValue({calculation:null,runs:[]});vi.spyOn(console,'error').mockImplementation(mocks.log);});

describe('Overtime UI server entry points',()=>{
 it('constructs nontransferable sample provenance and exact +08:00 midnight segments without trusting sample authorization',async()=>{
  const result=await previewOvertimeSampleAction({patternId:tenantId,versionId,sample:sample()});expect(result.ok).toBe(true);
  const [ctx,input]=mocks.sample.mock.calls[0];expect(ctx).toEqual({tenantId,userId:'verified-user'});
  expect(input.sample.mode).toBe('preview');expect(input.sample.source.tenantId).toBe(tenantId);
  expect(input.sample.segments).toHaveLength(2);
  expect(input.sample.segments.map((row:any)=>row.rawMinutes.value)).toEqual(['120','120']);
  expect(input.sample.segments.map((row:any)=>row.sessionId)).toEqual(['one-session','one-session']);
  expect(input.sample.segments[0].clock.value.startEpochSeconds).toBe(String(Date.parse(`${date}T22:00:00+08:00`)/1000));
  expect(input.sample.segments[0].clock.value.localStartSecond).toBe(22*3600);
  expect(input.sample.segments[1].clock.value.localStartSecond).toBe(0);
  expect(input.sample.segments[0].rawMinutes.provenance.owner).toBe('sample');expect(input.sample.facts.basicSalary.provenance.basis).toBe('sample');
  expect(input.sample.segments.map((row:any)=>row.approvedMinutes.value)).toEqual(['120','120']);
  expect(input.sample.approval.minutes.value).toBe('240');
  expect(mocks.calculate).not.toHaveBeenCalled();expect(mocks.transfer).not.toHaveBeenCalled();expect(mocks.revalidate).not.toHaveBeenCalled();
 });
 it('retains Unknown quantity and placement for a scalar sample instead of fabricating zero or punches',async()=>{
  const entered=sample();entered.sessionGranularity='dayAggregate';entered.approvalMinutes='';entered.segments[0].clockKnown=false;entered.segments[0].rawMinutes='';
  await previewOvertimeSampleAction({patternId:tenantId,versionId,sample:entered});
  const input=mocks.sample.mock.calls[0][1].sample;expect(input.segments[0].clock.state).toBe('unknown');expect(input.segments[0].rawMinutes.state).toBe('unknown');expect(input.approval.minutes.state).toBe('unknown');
 });
 it.each(['quantity','overnight'] as const)('evaluates real %s sample capacity with the independent day approval bound only once',async kind=>{
  mocks.sample.mockImplementation(async(_ctx:unknown,input:{sample:OvertimeInput})=>evaluateOvertimePattern(fictionalPattern(),input.sample));
  const entered=sample();entered.approvalMinutes='60';
  if(kind==='quantity'){entered.sessionGranularity='dayAggregate';entered.segments[0].clockKnown=false;entered.segments[0].rawMinutes='120';}
  const result=await previewOvertimeSampleAction({patternId:tenantId,versionId,sample:entered});
  expect(result.ok).toBe(true);if(!result.ok)throw new Error('Expected sample evaluation');
  expect(result.value.status).toBe('ready');if(result.value.status==='refused')throw new Error(JSON.stringify(result.value.issues));
  expect(result.value.payableMinutes).toMatchObject({numerator:'60',denominator:'1'});expect(result.value.amountMinorUnits).toBe('1200');expect(result.value.transferable).toBe(false);
  const input=mocks.sample.mock.calls[0][1].sample;
  expect(input.approval.minutes.value).toBe('60');expect(input.segments.map((row:any)=>row.approvedMinutes.value)).toEqual(kind==='overnight'?['120','120']:['120']);
  expect(mocks.calculate).not.toHaveBeenCalled();expect(mocks.transfer).not.toHaveBeenCalled();
 });
 it.each(['selected','null','unknown','absent'] as const)('preserves %s manual employee facts through the action and real evaluator',async kind=>{
  const p=fictionalPattern();
  p.eligibleMinutes={id:'worked_less_required',type:'subtract',unit:'minutes',left:{id:'sample_actual',type:'field',unit:'minutes',field:'actualWorkingMinutes'},right:{id:'sample_required',type:'field',unit:'minutes',field:'requiredWorkingMinutes'}};
  p.eligibility=kind==='null'?{id:'employee_missing',type:'null',field:'employmentId',isNull:true}:{id:'employee_selected',type:'selection',field:'employmentId',operator:'in',values:[tenantId]};
  mocks.sample.mockImplementation(async(_ctx:unknown,input:{sample:OvertimeInput})=>evaluateOvertimePattern(p,input.sample));
  const entered=sample();entered.sessionGranularity='dayAggregate';entered.approvalMinutes='61';entered.segments[0].clockKnown=false;entered.segments[0].rawMinutes='541';
  entered.facts={companyId:tenantId,actualWorkingMinutes:'541',requiredWorkingMinutes:'480',...(kind==='selected'?{employmentId:tenantId}:kind==='null'?{employmentId:null}:kind==='unknown'?{employmentId:''}:{})};
  const result=await previewOvertimeSampleAction({patternId:tenantId,versionId,sample:entered});expect(result.ok).toBe(true);if(!result.ok)throw new Error('Expected evaluated sample');
  expect(result.value.transferable).toBe(false);
  if(kind==='selected'||kind==='null'){expect(result.value.status).toBe('ready');if(result.value.status==='refused')throw new Error('Expected known employee eligibility');expect(result.value.payableMinutes).toMatchObject({numerator:'61',denominator:'1'});}
  else{expect(result.value.status).toBe('refused');if(result.value.status!=='refused')throw new Error('Expected missing employee fact refusal');expect(result.value.issues.some(issue=>issue.code==='unknown'&&issue.path==='employmentId')).toBe(true);}
  const passed=mocks.sample.mock.calls[0][1].sample;
  if(kind==='null')expect(passed.facts.employmentId).toMatchObject({state:'known',value:null});if(kind==='unknown')expect(passed.facts.employmentId.state).toBe('unknown');if(kind==='absent')expect(passed.facts.employmentId).toBeUndefined();
  expect(mocks.calculate).not.toHaveBeenCalled();expect(mocks.transfer).not.toHaveBeenCalled();expect(mocks.revalidate).not.toHaveBeenCalled();
 });
 it('refuses a real sample evaluation when raw quantity is blank despite a known day approval bound',async()=>{
  mocks.sample.mockImplementation(async(_ctx:unknown,input:{sample:OvertimeInput})=>evaluateOvertimePattern(fictionalPattern(),input.sample));
  const entered=sample();entered.sessionGranularity='dayAggregate';entered.approvalMinutes='60';entered.segments[0].clockKnown=false;entered.segments[0].rawMinutes='';
  const result=await previewOvertimeSampleAction({patternId:tenantId,versionId,sample:entered});
  expect(result.ok).toBe(true);if(!result.ok)throw new Error('Expected sample evaluation');
  expect(result.value.status).toBe('refused');if(result.value.status!=='refused')throw new Error('Expected Unknown raw quantity refusal');
  expect(result.value.issues.some(issue=>issue.code==='unknown')).toBe(true);expect(result.value.transferable).toBe(false);
  const input=mocks.sample.mock.calls[0][1].sample;expect(input.segments[0].rawMinutes.state).toBe('unknown');expect(input.segments[0].approvedMinutes.state).toBe('unknown');
 });
 it('refuses invalid or nonpositive sample intervals before invoking the domain owner',async()=>{
  const entered=sample();entered.segments[0].from='10:00';entered.segments[0].to='09:00';entered.segments[0].endDayOffset=0;
  expect(await previewOvertimeSampleAction({patternId:tenantId,versionId,sample:entered})).toEqual({ok:false,code:'invalid'});expect(mocks.sample).not.toHaveBeenCalled();
 });
 it('does not catch or downgrade a server authentication refusal',async()=>{
  mocks.scope.mockRejectedValue(new Error('authorization-refused'));
  await expect(previewOvertimeEmployeeAction({patternId:tenantId,versionId,employmentId:tenantId,date})).rejects.toThrow('authorization-refused');expect(mocks.employee).not.toHaveBeenCalled();
 });
 it('passes exact source/revision references to Payroll without supplying a computed amount',async()=>{
  const input={employmentId:tenantId,date,expectedCalculationId:versionId,expectedSourceRevision:7,batchId:tenantId,reason:'Reviewed fictional source'};
  const result=await transferOvertimePayrollAction(input);expect(result.ok).toBe(true);expect(mocks.transfer).toHaveBeenCalledExactlyOnceWith({tenantId,userId:'verified-user'},input);expect(mocks.calculate).not.toHaveBeenCalled();
 });
 it('projects unknown failures as safe support references and retains raw errors only in private logging',async()=>{
  mocks.options.mockRejectedValue(new Error('PRIVATE SQL payroll amount'));
  const result=await readOvertimeTransferAction({employmentId:tenantId,date});expect(result.ok).toBe(false);
  if(!result.ok){expect(result.code).toBe('system');expect(result.reference).toMatch(/^OT-[A-F0-9]{8}$/);}
  expect(JSON.stringify(result)).not.toContain('PRIVATE');expect(mocks.log).toHaveBeenCalledOnce();
 });
 it.each(['stale','currency','mapping','statutoryFloor','coverage','unknownHours'] as const)('keeps a finite Payroll %s refusal actionable without exposing raw text or logging an incident',async code=>{
  mocks.transfer.mockRejectedValue(new OvertimePayrollError(code));
  expect(await transferOvertimePayrollAction({employmentId:tenantId,date,expectedCalculationId:versionId,expectedSourceRevision:1,batchId:tenantId,reason:'Reviewed source'})).toEqual({ok:false,code});
  expect(mocks.log).not.toHaveBeenCalled();
 });
});

/** b31981c0: the simplified editor hides companies, currency, duration policies, rates and lifecycle. The action must
 * derive every hidden value on the server, so a browser that still posts them (or tampers with them) changes nothing. */
describe('Overtime editor save derives every hidden value on the server',()=>{
 const owning='00000000-0000-4000-8000-0000000000a1',second='00000000-0000-4000-8000-0000000000a2',patternId='00000000-0000-4000-8000-0000000000b1',draftVersionId='00000000-0000-4000-8000-0000000000b2';
 function saved():OvertimePattern {const p=fictionalPattern();return {...p,currency:{code:'SGD',minorScale:2},eligibilityBasis:'session',durationAllocation:'latest',rates:p.rates.map(rate=>({...rate,accumulation:'session' as const,tiers:rate.tiers.map(tier=>({...tier,mapping:{...tier.mapping,currency:'SGD'}}))})),durationRounding:{mode:'down',step:'15'},moneyRounding:{stage:'line',mode:'halfEven'}};}
 function detail(definition:unknown=saved(),overrides:Record<string,unknown>={}) {return {pattern:{id:patternId,tenantId,kind:'formula',code:'SAVED-CODE',creationCompanyId:owning,archivedAt:null,revision:4},versions:[{id:draftVersionId,patternId,revision:6,activatedAt:null,companyIds:[owning,second],definition,name:'Saved name',description:'Saved',...overrides}],assignments:[],writable:true};}
 const companies=[{id:owning,name:'Owning fictional company',currency:'MYR',minorScale:2},{id:second,name:'Second fictional company',currency:'MYR',minorScale:2}];
 function tampered() {
  const definition={...fictionalPattern(),currency:{code:'MYR',minorScale:2},eligibilityBasis:'day',durationAllocation:'earliest',rates:[],paymentCap:{id:'cap',type:'literal',unit:'money',currency:'MYR',value:'1'},eligibility:{id:'edited',type:'selection',field:'dayType',operator:'in',values:['workday']}};
  return {code:'BROWSER-CODE',name:'Edited name',description:'Edited description',definition,creationCompanyId:second,companyIds:[second]} as never;
 }
 beforeEach(()=>{mocks.scope.mockResolvedValue({s:{tenantId,userId:'verified-user'},scopeIds:[owning]});mocks.detail.mockResolvedValue(detail());mocks.companies.mockResolvedValue(companies);mocks.saveDraft.mockResolvedValue({patternId,versionId:draftVersionId,revision:7});});
 it('keeps saved companies, currency, duration policies, rates and advanced fields on an existing draft and ignores posted ones',async()=>{
  const before=structuredClone(saved());
  const result=await saveOvertimeDraftAction({patternId,versionId:draftVersionId,expectedRevision:6,draft:tampered()});
  expect(result).toEqual({ok:true,value:{patternId,versionId:draftVersionId,revision:7}});
  expect(mocks.saveDraft).toHaveBeenCalledOnce();const [ctx,input]=mocks.saveDraft.mock.calls[0];
  expect(ctx).toEqual({tenantId,userId:'verified-user'});
  expect(input).toMatchObject({patternId,versionId:draftVersionId,expectedRevision:6});
  expect(input.draft.creationCompanyId).toBe(owning);expect(input.draft.companyIds).toEqual([owning,second]);expect(input.draft.code).toBe('SAVED-CODE');
  expect(input.draft.name).toBe('Edited name');expect(input.draft.description).toBe('Edited description');
  const {eligibility,...hidden}=input.draft.definition,{eligibility:_savedEligibility,...savedHidden}=before;
  expect(JSON.stringify(hidden)).toBe(JSON.stringify(savedHidden));
  expect(eligibility).toEqual({id:'edited',type:'selection',field:'dayType',operator:'in',values:['workday']});
  expect(mocks.revalidate).toHaveBeenCalledOnce();
 });
 it('expands a saved starter seed server-side and fills only its blank currency from the owning company',async()=>{
  mocks.detail.mockResolvedValue(detail(overtimeStarterSeed('ot20')));
  await saveOvertimeDraftAction({patternId,versionId:draftVersionId,expectedRevision:6,draft:tampered()});
  const definition=mocks.saveDraft.mock.calls[0][1].draft.definition,expected=prepareOvertimeStarter('ot20','day','earliest');
  expect(definition.currency).toEqual({code:'MYR',minorScale:2});expect(definition.rates).toEqual(expected.rates);
  expect(definition.paymentCap).toBeNull();expect(definition).toMatchObject({eligibilityBasis:'day',durationAllocation:'earliest'});
 });
 it('derives the company and its currency for a new pattern from the single server-selected company',async()=>{
  mocks.scope.mockResolvedValue({s:{tenantId,userId:'verified-user'},scopeIds:[second]});
  await saveOvertimeDraftAction({starterKey:'ot15',draft:tampered()});
  const input=mocks.saveDraft.mock.calls[0][1];expect(input.patternId).toBeUndefined();expect(input.versionId).toBeUndefined();
  expect(input.draft).toMatchObject({code:'BROWSER-CODE',creationCompanyId:second,companyIds:[second],name:'Edited name'});
  expect(input.draft.definition).toMatchObject({currency:{code:'MYR',minorScale:2},eligibilityBasis:'day',durationAllocation:'earliest',paymentCap:null});
  expect(input.draft.definition.rates).toEqual(prepareOvertimeStarter('ot15','day','earliest').rates);
  await saveOvertimeDraftAction({draft:tampered()});expect(mocks.saveDraft.mock.calls[1][1].draft.definition.rates).toEqual([]);
 });
 it.each([['several selected',[owning,second]],['none administrable',['00000000-0000-4000-8000-0000000000ff']]] as const)('refuses a new pattern with %s companies and writes nothing',async(_label,scopeIds)=>{
  mocks.scope.mockResolvedValue({s:{tenantId,userId:'verified-user'},scopeIds:[...scopeIds]});
  expect(await saveOvertimeDraftAction({draft:tampered()})).toEqual({ok:false,code:'invalid',notice:'chooseOneCompany'});
  expect(mocks.saveDraft).not.toHaveBeenCalled();expect(mocks.revalidate).not.toHaveBeenCalled();
 });
 it.each([
  ['a changed revision','stale',{},{expectedRevision:5}],
  ['an activated version','invalid',{activatedAt:new Date()},{}],
  ['an unknown version','unavailable',{id:'00000000-0000-4000-8000-0000000000c9'},{}],
  ['a new version on an existing pattern','invalid',{},{versionId:undefined}],
  ['an unsupported starter','invalid',{},{patternId:undefined,versionId:undefined,starterKey:'ot99'}],
 ] as const)('refuses %s before any write',async(_label,code,version,input)=>{
  mocks.detail.mockResolvedValue(detail(saved(),version));
  const result=await saveOvertimeDraftAction({patternId,versionId:draftVersionId,expectedRevision:6,draft:tampered(),...input} as never);
  expect(result).toMatchObject({ok:false,code});expect(mocks.saveDraft).not.toHaveBeenCalled();expect(mocks.revalidate).not.toHaveBeenCalled();
 });
 it('treats an invisible or foreign pattern as unavailable and keeps the owner permission refusal',async()=>{
  mocks.detail.mockResolvedValue(null);
  expect(await saveOvertimeDraftAction({patternId,versionId:draftVersionId,expectedRevision:6,draft:tampered()})).toEqual({ok:false,code:'unavailable'});expect(mocks.saveDraft).not.toHaveBeenCalled();
  mocks.detail.mockResolvedValue(detail());mocks.saveDraft.mockRejectedValue(new OvertimeOwnerError('permission','Outside administrator scope'));
  expect(await saveOvertimeDraftAction({patternId,versionId:draftVersionId,expectedRevision:6,draft:tampered()})).toEqual({ok:false,code:'permission'});
  expect(mocks.revalidate).not.toHaveBeenCalled();
 });
 it('refuses an unauthenticated or non-administrator caller before reading or writing anything',async()=>{
  mocks.scope.mockRejectedValue(new Error('authorization-refused'));
  await expect(saveOvertimeDraftAction({patternId,versionId:draftVersionId,expectedRevision:6,draft:tampered()})).rejects.toThrow('authorization-refused');
  expect(mocks.detail).not.toHaveBeenCalled();expect(mocks.companies).not.toHaveBeenCalled();expect(mocks.saveDraft).not.toHaveBeenCalled();
 });
});

