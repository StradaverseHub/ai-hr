import {personnelField} from './personnel-field-registry';
import {profileFieldApproval} from './profile-edit-policy-value';
import type {EssProfileProposal,EssRegisterChange} from './personnel-ess-model';
/** New register rows are atomic: creating half of a new dependent is never an immediate edit. */
export function splitProfileSubmission(policy:unknown,proposal:EssProfileProposal){
 const required=(id:string)=>{const field=personnelField(id);return !field||profileFieldApproval(policy,field).required;};
 const immediate:EssProfileProposal={v:2,fields:[],registers:[]},waiting:EssProfileProposal={v:2,fields:[],registers:[]};
 for(const field of proposal.fields)(required(field.fieldId)?waiting:immediate).fields.push(field);
 for(const row of proposal.registers){
  if(row.id===null){(row.fields.some(field=>required(field.fieldId))?waiting:immediate).registers.push(row);continue;}
  for(const [target,needsApproval]of [[immediate,false],[waiting,true]] as const){const fields=row.fields.filter(field=>required(field.fieldId)===needsApproval);if(fields.length)target.registers.push({...row,fields} satisfies EssRegisterChange);}
 }
 return {immediate,waiting};
}
