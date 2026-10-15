import {describe,expect,it} from 'vitest';
import {overtimeDurationProofInput} from '../lib/overtime-duration-input';
import type {OvertimePattern,OvertimeInput,OvertimeFact} from '../lib/overtime-pattern-model';
const id='00000000-0000-4000-8000-000000000001',date='2026-10-01';
const known=(value:string):OvertimeFact<string>=>({state:'known',value,provenance:{owner:'attendance',reference:'recorded',asOf:date,basis:'recorded'}});
function fixture():{definition:OvertimePattern;input:OvertimeInput}{return {
 definition:{v:1,currency:{code:'MYR',minorScale:2},definitions:[],eligibilityBasis:'day',durationAllocation:'earliest',eligibility:{id:'eligible',type:'constant',value:true},eligibleMinutes:null,durationCap:null,durationRounding:null,deductions:[],rates:[{id:'rate',name:'Synthetic rate',description:'Fictional policy',priority:0,when:{id:'rate-condition',type:'constant',value:true},timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[{id:'tier',from:'0',to:null,mapping:{earningItemId:id,currency:'MYR'},payment:{method:'hourly',rate:{id:'price',type:'hourlyRate',unit:'moneyPerHour',base:{id:'salary-price',type:'field',field:'basicSalary',unit:'money'},divisorMinutes:{id:'divisor',type:'literal',unit:'minutes',value:'9600'}},multiplier:{id:'multiplier',type:'literal',unit:'scalar',value:'1'}}}]}],paymentCap:null,moneyRounding:{stage:'dayMapping',mode:'halfUp'}},
 input:{mode:'actual',layer:'raw',sessionGranularity:'dayAggregate',source:{tenantId:id,employmentId:id,attendanceId:id,date,inputDigest:'a'.repeat(64),approvalDigest:'b'.repeat(64)},patternVersionId:id,assignmentId:id,currency:{code:'MYR',minorScale:2},facts:{basicSalary:known('4000'),lateMinutes:known('0')},resources:[],approval:{status:'approved',minutes:known('60'),provenance:{owner:'approval',reference:id,asOf:date,basis:'recorded'}},segments:[{id:'segment',sessionId:'aggregate',rawMinutes:known('120'),approvedMinutes:known('120'),dayType:known('workday'),clock:{state:'unknown',reason:'aggregate'}}]},
};}
const proof=(f:ReturnType<typeof fixture>)=>JSON.stringify(overtimeDurationProofInput(f.definition,f.input));
describe('duration freshness excludes price-only private data',()=>{
 it('keeps duration proof unchanged when salary/full-input digest or a price-only rate changes',()=>{
  const a=fixture(),before=overtimeDurationProofInput(a.definition,a.input);
  // UUIDs legitimately contain "4000": assert the actual dependency owners, not serialized substrings.
  expect(before.facts).toEqual({});expect(before.source).toEqual({tenantId:id,employmentId:id,attendanceId:id,date,approvalDigest:'b'.repeat(64)});
  expect(Object.keys(before.stages).sort()).toEqual(['deductions','definitions','durationAllocation','durationCap','durationRounding','eligibility','eligibilityBasis','eligibleMinutes']);expect(before.stages.definitions).toEqual([]);
  a.input.facts.basicSalary={state:'unknown',reason:'not_visible'};a.input.source.inputDigest='c'.repeat(64);a.definition.rates[0].name='Different price label';
  const payment=a.definition.rates[0].tiers[0].payment;if(payment.method!=='hourly'||payment.multiplier.type!=='literal')throw new Error('Expected the fixture hourly multiplier');payment.multiplier.value='2';
  expect(overtimeDurationProofInput(a.definition,a.input)).toEqual(before);
 });
 it('traverses referenced definitions and all nested IF branches used by duration',()=>{
  const a=fixture();a.definition.definitions=[{id:'duration-ref',expression:{id:'duration-if',unit:'minutes',type:'if',when:{id:'department-check',type:'selection',field:'departmentId',operator:'in',values:[id]},then:{id:'actual',unit:'minutes',type:'field',field:'actualWorkingMinutes'},else:{id:'required',unit:'minutes',type:'field',field:'requiredWorkingMinutes'}}}];a.definition.eligibleMinutes={id:'duration-root',type:'ref',unit:'minutes',definitionId:'duration-ref'};
  a.input.facts.departmentId=known(id);a.input.facts.actualWorkingMinutes=known('600');a.input.facts.requiredWorkingMinutes=known('480');const before=proof(a);a.input.facts.requiredWorkingMinutes=known('450');
  expect(proof(a)).not.toBe(before);expect(overtimeDurationProofInput(a.definition,a.input).facts).toHaveProperty('departmentId');
 });
 it('includes a salary fact only when HR explicitly made it a duration dependency',()=>{
  const a=fixture();a.definition.eligibility={id:'salary-condition',type:'compare',operator:'gt',left:{id:'salary-eligibility',type:'field',unit:'money',field:'basicSalary'},right:{id:'salary-floor',type:'literal',unit:'money',currency:'MYR',value:'0'}};
  const before=overtimeDurationProofInput(a.definition,a.input);expect(before.facts).toEqual({basicSalary:known('4000')});
  a.input.facts.basicSalary={state:'unknown',reason:'not_visible'};const after=overtimeDurationProofInput(a.definition,a.input);expect(after.facts).toEqual({basicSalary:{state:'unknown',reason:'not_visible'}});expect(after).not.toEqual(before);
 });
 it.each(['approval','raw','assignment','company','allocation'] as const)('invalidates the exact %s duration dependency',kind=>{
  const a=fixture(),before=proof(a);
  if(kind==='approval')a.input.source.approvalDigest='d'.repeat(64);
  if(kind==='raw'&&a.input.layer==='raw')a.input.segments[0].rawMinutes=known('119');
  if(kind==='assignment')a.input.assignmentId='00000000-0000-4000-8000-000000000002';
  if(kind==='company')a.input.source.tenantId='00000000-0000-4000-8000-000000000002';
  if(kind==='allocation')a.definition.durationAllocation='latest';
  expect(proof(a)).not.toBe(before);
 });
 it('rejects malformed or cyclic duration references instead of fabricating a digest',()=>{
  const a=fixture();a.definition.definitions=[{id:'loop',expression:{id:'loop-body',type:'ref',unit:'minutes',definitionId:'loop'}}];a.definition.eligibleMinutes={id:'duration-root',type:'ref',unit:'minutes',definitionId:'loop'};
  expect(()=>proof(a)).toThrow();expect(()=>overtimeDurationProofInput({} as OvertimePattern,a.input)).toThrow();
 });
});
