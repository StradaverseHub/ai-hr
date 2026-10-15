/** Stage-only freshness proof. Money/rate evidence is never needed merely to bank duration. */
import {OVERTIME_LIMITS,OvertimePatternError,type OvertimePattern,type OvertimeInput,type OvertimeExpression,type OvertimeCondition,type OvertimeField} from './overtime-pattern-model';
import {validateOvertimePattern} from './overtime-pattern-schema';
import {validateOvertimeInput} from './overtime-pattern-evaluate';

/** The server hashes JSON.stringify of this exact projection; no caller-supplied authority/digest. */
export function overtimeDurationProofInput(definition:OvertimePattern,canonicalInput:OvertimeInput) {
  const pattern=validateOvertimePattern(definition),input=validateOvertimeInput(canonicalInput);
  const fields=new Set<OvertimeField>(),used=new Set<string>(),visiting=new Set<string>();
  const definitions=new Map(pattern.definitions.map(item=>[item.id,item.expression]));
  let operations=0;
  const refuse=(path:string):never=>{throw new OvertimePatternError({code:'limit',path,severity:'error',detail:'Duration dependency proof exceeds its bounded graph.'});};
  function tick(depth:number) {if(++operations>OVERTIME_LIMITS.operations||depth>OVERTIME_LIMITS.depth)refuse('duration.dependencies');}
  function expression(node:OvertimeExpression,depth=0):void {
    tick(depth);
    switch(node.type) {
      case 'literal':return;
      case 'field':fields.add(node.field);return;
      case 'ref':{
        if(visiting.has(node.definitionId))refuse('duration.dependencies.cycle');
        if(used.has(node.definitionId))return;
        const nested=definitions.get(node.definitionId);
        if(!nested)throw new OvertimePatternError({code:'invalid',path:'duration.dependencies.reference',severity:'error',detail:'Duration definition reference is unavailable.'});
        visiting.add(node.definitionId);expression(nested,depth+1);visiting.delete(node.definitionId);used.add(node.definitionId);return;
      }
      case 'if':condition(node.when,depth+1);expression(node.then,depth+1);expression(node.else,depth+1);return;
      case 'cap':expression(node.value,depth+1);expression(node.ceiling,depth+1);return;
      case 'hourlyRate':expression(node.base,depth+1);expression(node.divisorMinutes,depth+1);return;
      case 'hourlyAmount':expression(node.rate,depth+1);expression(node.minutes,depth+1);return;
      default:expression(node.left,depth+1);expression(node.right,depth+1);
    }
  }
  function condition(node:OvertimeCondition,depth=0):void {
    tick(depth);
    switch(node.type) {
      case 'constant':case 'clock':return;
      case 'selection':case 'null':fields.add(node.field);return;
      case 'group':for(const child of node.children)condition(child,depth+1);return;
      case 'compare':expression(node.left,depth+1);expression(node.right,depth+1);if(node.upper)expression(node.upper,depth+1);return;
    }
  }
  condition(pattern.eligibility);
  if(pattern.eligibleMinutes)expression(pattern.eligibleMinutes);
  if(pattern.durationCap)expression(pattern.durationCap);
  const deductions=pattern.deductions.filter(item=>item.unit==='minutes');
  for(const deduction of deductions){condition(deduction.when);expression(deduction.amount);}
  const facts=Object.fromEntries([...fields].sort().filter(field=>Object.hasOwn(input.facts,field)).map(field=>[field,input.facts[field]]));
  const {tenantId,employmentId,attendanceId,date,approvalDigest}=input.source;
  return {
    v:1 as const,
    source:{tenantId,employmentId,attendanceId,date,approvalDigest},
    patternVersionId:input.patternVersionId,assignmentId:input.assignmentId,
    currency:input.currency,mode:input.mode,sessionGranularity:input.sessionGranularity,layer:input.layer,
    stages:{eligibilityBasis:pattern.eligibilityBasis,durationAllocation:pattern.durationAllocation,eligibility:pattern.eligibility,eligibleMinutes:pattern.eligibleMinutes,durationCap:pattern.durationCap,durationRounding:pattern.durationRounding,deductions,definitions:[...used].sort().map(id=>({id,expression:definitions.get(id)!}))},
    facts,segments:input.segments,approval:input.approval,
    resources:input.resources.filter(item=>item.measure.unit==='minutes').slice().sort((a,b)=>a.id.localeCompare(b.id)),
  };
}
