import {beforeEach,describe,expect,it,vi} from 'vitest';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {OvertimeSampleDraft} from '../lib/overtime-pattern-ui';
const mocks=vi.hoisted(()=>({scope:vi.fn(),sample:vi.fn(),employee:vi.fn(),calculate:vi.fn(),read:vi.fn(),options:vi.fn(),transfer:vi.fn(),revalidate:vi.fn(),log:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('../lib/scope',()=>({scopedAdmin:mocks.scope}));
vi.mock('../packs/attendance/service',()=>({
 OvertimeOwnerError:class extends Error {constructor(readonly code:string,message:string){super(message);}},
 saveOvertimePatternDraft:vi.fn(),forkOvertimePatternDraft:vi.fn(),validateOvertimePatternActivation:vi.fn(),activateOvertimePattern:vi.fn(),stopOvertimePatternVersion:vi.fn(),archiveOvertimePattern:vi.fn(),saveOvertimePatternAssignment:vi.fn(),closeOvertimePatternAssignment:vi.fn(),overtimePatternSetup:vi.fn(),previewOvertimePatternEmployee:mocks.employee,previewOvertimePatternSample:mocks.sample,calculateOvertimePatternDay:mocks.calculate,readOvertimePatternCalculation:mocks.read,
}));
vi.mock('../packs/payroll/service',()=>({overtimePatternTransferOptions:mocks.options,transferOvertimePatternToPayroll:mocks.transfer}));
import {previewOvertimeSampleAction,previewOvertimeEmployeeAction,transferOvertimePayrollAction,readOvertimeTransferAction} from '../app/admin/attendance/settings/overtime-patterns/actions';
const tenantId='00000000-0000-4000-8000-000000000001',versionId='00000000-0000-4000-8000-000000000002';
const date=todayInKualaLumpur();
function sample():OvertimeSampleDraft {return {date,currency:{code:'MYR',minorScale:2},facts:{basicSalary:'4000'},sessionGranularity:'recorded',approvalStatus:'approved',approvalMinutes:'240',segments:[{id:'sample-clock',sessionId:'one-session',date,rawMinutes:'999',dayType:'workday',endDayType:'rest_day',clockKnown:true,from:'22:00',to:'02:00',endDayOffset:1}],resources:[]};}
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
  expect(input.sample.segments.every((row:any)=>row.approvedMinutes.state==='unknown')).toBe(true);
  expect(mocks.calculate).not.toHaveBeenCalled();expect(mocks.transfer).not.toHaveBeenCalled();expect(mocks.revalidate).not.toHaveBeenCalled();
 });
 it('retains Unknown quantity and placement for a scalar sample instead of fabricating zero or punches',async()=>{
  const entered=sample();entered.sessionGranularity='dayAggregate';entered.approvalMinutes='';entered.segments[0].clockKnown=false;entered.segments[0].rawMinutes='';
  await previewOvertimeSampleAction({patternId:tenantId,versionId,sample:entered});
  const input=mocks.sample.mock.calls[0][1].sample;expect(input.segments[0].clock.state).toBe('unknown');expect(input.segments[0].rawMinutes.state).toBe('unknown');expect(input.approval.minutes.state).toBe('unknown');
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
});
