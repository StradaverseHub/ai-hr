import {createHash} from 'node:crypto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Tx,SessionContext} from '../db/client';
import {attendance,attendanceOvertimeSource} from '../db/schema';
import type {OvertimeInput,OvertimePattern,OvertimeFact} from '../lib/overtime-pattern-model';
import {evaluateOvertimePattern} from '../lib/overtime-pattern-evaluate';
import {overtimeDurationProofInput} from '../lib/overtime-duration-input';
const mocks=vi.hoisted(()=>({existing:vi.fn(),stored:vi.fn(),canonical:vi.fn()}));
vi.mock('../packs/attendance/overtime-patterns',()=>({readOvertimeSettlementForDayTx:mocks.existing,readOvertimeDurationDefinitionTx:mocks.stored}));
vi.mock('../packs/attendance/overtime-input',()=>({canonicalOvertimeToilInputTx:mocks.canonical}));
import {resolveOvertimeToilDurationTx,OvertimeToilEligibilityError} from '../packs/attendance/overtime-toil';
const id='00000000-0000-4000-8000-000000000001',date='2026-10-01';
const fact=(value:string):OvertimeFact<string>=>({state:'known',value,provenance:{owner:'attendance',reference:'recorded',asOf:date,basis:'recorded'}});
function fixture(){
 const definition:OvertimePattern={v:1,currency:{code:'MYR',minorScale:2},definitions:[],eligibilityBasis:'day',durationAllocation:'latest',eligibility:{id:'eligible',type:'constant',value:true},eligibleMinutes:null,durationCap:null,durationRounding:null,deductions:[],rates:[{id:'rate',name:'Synthetic rate',description:'Fictional policy',priority:0,when:{id:'rate-when',type:'constant',value:true},timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[{id:'tier',from:'0',to:null,mapping:{earningItemId:id,currency:'MYR'},payment:{method:'hourly',rate:{id:'price',type:'hourlyRate',unit:'moneyPerHour',base:{id:'salary-price',type:'field',field:'basicSalary',unit:'money'},divisorMinutes:{id:'divisor',type:'literal',unit:'minutes',value:'9600'}},multiplier:{id:'multiplier',type:'literal',unit:'scalar',value:'1'}}}]}],paymentCap:null,moneyRounding:{stage:'dayMapping',mode:'halfUp'}};
 const input:OvertimeInput={mode:'actual',layer:'raw',sessionGranularity:'dayAggregate',source:{tenantId:id,employmentId:id,attendanceId:id,date,inputDigest:'a'.repeat(64),approvalDigest:'b'.repeat(64)},patternVersionId:id,assignmentId:id,currency:definition.currency,facts:{companyId:fact(id),basicSalary:{state:'unknown',reason:'not_visible'}},resources:[],approval:{status:'approved',minutes:fact('60'),provenance:{owner:'approval',reference:id,asOf:date,basis:'recorded'}},segments:[{id:'segment',sessionId:'aggregate',rawMinutes:fact('120'),approvedMinutes:fact('120'),dayType:fact('rest_day'),clock:{state:'unknown',reason:'aggregate'}}]};
 const source={id,companyId:id,attendanceId:id,currentCalculationId:id,revision:4};
 const calculation={id,versionId:id,assignmentId:id,durationOutcome:'ready',durationInputDigest:createHash('sha256').update(JSON.stringify(overtimeDurationProofInput(definition,input))).digest('hex'),payableNumerator:'60',payableDenominator:'1'};
 return {definition,input,source,calculation};
}
function transaction(trace:unknown=null,dayType='rest_day',source:unknown=fixture().source,country:unknown='MY'){
 const tx={execute:vi.fn().mockResolvedValue([]),select:vi.fn()};
 tx.select.mockImplementation(()=>({from:(table:unknown)=>({where:()=>({limit:()=>{const rows=table===attendance?[{calcTrace:trace,dayType}]:table===attendanceOvertimeSource?(source?[source]:[]):[{country}];return Object.assign(Promise.resolve(rows),{for:()=>Promise.resolve(rows)});}})})}));
 return tx as unknown as Tx;
}
const ctx={tenantId:id,userId:id} as SessionContext;
const request={employmentId:id,date};
beforeEach(()=>{vi.clearAllMocks();});
function install(f=fixture()){mocks.existing.mockResolvedValue({source:f.source,settlement:null});mocks.stored.mockResolvedValue({...f,companyIds:[id]});mocks.canonical.mockResolvedValue({input:f.input,resolvedLegacyRuleId:null,referenceDigest:'c'.repeat(64)});return f;}
describe('actual TOIL uses fresh independent formula duration',()=>{
 it('allows clock-free rest-day duration without salary access or a cash evaluation',async()=>{
  const f=install();expect(evaluateOvertimePattern(f.definition,f.input).status).toBe('refused');const result=await resolveOvertimeToilDurationTx(transaction(),ctx,request);
  expect(result).toMatchObject({kind:'formula',companyId:id,minutes:60,afterShiftMinutes:null});expect(JSON.stringify(result)).not.toContain('basicSalary');
 });
 it('does not treat missing recorded shift placement as after-shift work',async()=>{
  install();const result=await resolveOvertimeToilDurationTx(transaction({v:1,schedule:{dayType:'workday',source:'policy',scheduledMinutes:480,normalMinutesOverride:null,endAbs:1080}},'workday'),ctx,request);
  expect(result).toMatchObject({kind:'formula',minutes:60,afterShiftMinutes:null});
 });
 it('uses the same allocation stage for post-shift and claimed-window intersections',async()=>{
  const f=fixture();f.input.sessionGranularity='recorded';f.input.approval.minutes=fact('120');
  f.input.segments[0].clock={state:'known',value:{startEpochSeconds:String(Date.parse(date+'T18:00:00+08:00')/1000),localDate:date,localStartSecond:18*3600,elapsedSeconds:4*3600},provenance:{owner:'attendance',reference:'recorded',asOf:date,basis:'recorded'}};
  if(f.input.layer==='raw'){f.input.segments[0].rawMinutes=fact('240');f.input.segments[0].approvedMinutes=fact('240');}
  f.calculation.payableNumerator='120';f.calculation.durationInputDigest=createHash('sha256').update(JSON.stringify(overtimeDurationProofInput(f.definition,f.input))).digest('hex');install(f);
  const trace={v:1,schedule:{dayType:'workday',source:'policy',scheduledMinutes:480,normalMinutesOverride:null,endAbs:18*60}};
  expect(await resolveOvertimeToilDurationTx(transaction(trace,'workday'),ctx,request)).toMatchObject({kind:'formula',minutes:120,afterShiftMinutes:120});
  expect(await resolveOvertimeToilDurationTx(transaction(trace,'workday'),ctx,{...request,claimWindow:{start:'18:00',end:'19:00'}})).toMatchObject({afterShiftMinutes:0});
  expect(await resolveOvertimeToilDurationTx(transaction(trace,'workday'),ctx,{...request,claimWindow:{start:'20:00',end:'21:00'}})).toMatchObject({afterShiftMinutes:60,audit:{recordedShiftEndAbs:1080,claimWindow:{start:'20:00',end:'21:00'},qualifyingMinutes:60,calculationId:id,sourceRevision:4,durationInputDigest:f.calculation.durationInputDigest}});
 });
 it.each(['off','unknown'] as const)('requires recorded evidence to distinguish %s workday classification',async kind=>{
  install();const trace=kind==='off'?{v:1,schedule:{source:'default-shift-rest',dayType:'workday',scheduledMinutes:0,normalMinutesOverride:null,endAbs:null}}:null;
  const result=resolveOvertimeToilDurationTx(transaction(trace,'workday'),ctx,request);
  if(kind==='off')expect(await result).toMatchObject({recordedWorkedDayKind:'off_day'});else await expect(result).rejects.toBeInstanceOf(OvertimeToilEligibilityError);
 });
 it('reads source/current calculation and Attendance after taking the existing source row lock',async()=>{
  install();const calls:string[]=[];const tx=transaction();
  const select=tx.select.bind(tx);vi.spyOn(tx,'select').mockImplementation((...args:any[])=>{const query=(select as any)(...args);const from=query.from.bind(query);query.from=(table:unknown)=>{calls.push(table===attendanceOvertimeSource?'source':table===attendance?'attendance':'company');const next=from(table);if(table===attendanceOvertimeSource){const where=next.where.bind(next);next.where=(...parts:any[])=>{const limit=where(...parts);const oldLimit=limit.limit.bind(limit);limit.limit=(n:number)=>{const result=oldLimit(n);const oldFor=result.for.bind(result);result.for=(...lock:any[])=>{calls.push('source-lock');return oldFor(...lock);};return result;};return limit;};}return next;};return query;});
  await resolveOvertimeToilDurationTx(tx,ctx,request);expect(calls.indexOf('source-lock')).toBeGreaterThan(calls.indexOf('source'));expect(calls.indexOf('attendance')).toBeGreaterThan(calls.indexOf('source-lock'));
 });
 it.each(['stale','ineligible','refused','fractional','wrongCompany'] as const)('refuses %s formula evidence without legacy fallback',async kind=>{
  const f=fixture();
  if(kind==='stale')f.input.approval.minutes=fact('59');
  if(kind==='ineligible'||kind==='refused')f.calculation.durationOutcome=kind;
  if(kind==='fractional'){f.input.approval.minutes=fact('0.5');f.calculation.payableNumerator='1';f.calculation.payableDenominator='2';f.calculation.durationInputDigest=createHash('sha256').update(JSON.stringify(overtimeDurationProofInput(f.definition,f.input))).digest('hex');}
  if(kind==='wrongCompany')f.input.facts.companyId=fact('00000000-0000-4000-8000-000000000002');
  install(f);await expect(resolveOvertimeToilDurationTx(transaction(),ctx,request)).rejects.toBeInstanceOf(OvertimeToilEligibilityError);
 });
 it('refuses an unknown source-company jurisdiction rather than substituting the current employment country',async()=>{
  install();await expect(resolveOvertimeToilDurationTx(transaction(null,'rest_day',fixture().source,null),ctx,request)).rejects.toBeInstanceOf(OvertimeToilEligibilityError);
 });
 it('refuses a cash-first claim before any duration read',async()=>{
  install();mocks.existing.mockResolvedValue({source:fixture().source,settlement:{mode:'cash'}});
  await expect(resolveOvertimeToilDurationTx(transaction(),ctx,request)).rejects.toThrow('already reserved for cash');expect(mocks.canonical).not.toHaveBeenCalled();
 });
 it('refuses a raw sourceUnavailable fragment even when there is no v1 trace',async()=>{
  mocks.existing.mockResolvedValue(null);await expect(resolveOvertimeToilDurationTx(transaction({overtimePattern:{status:'refused',reason:'sourceUnavailable'}}),ctx,request)).rejects.toBeInstanceOf(OvertimeToilEligibilityError);
 });
 it('preserves no-attendance self-declared legacy without creating a source',async()=>{
  mocks.existing.mockResolvedValue(null);expect(await resolveOvertimeToilDurationTx(transaction(null,'rest_day',null),ctx,request)).toEqual({kind:'legacy'});expect(mocks.stored).not.toHaveBeenCalled();expect(mocks.canonical).not.toHaveBeenCalled();
 });
});
