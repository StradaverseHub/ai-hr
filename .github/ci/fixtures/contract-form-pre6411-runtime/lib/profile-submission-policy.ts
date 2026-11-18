import {personnelField} from './personnel-field-registry';
import {profileFieldApproval} from './profile-edit-policy-value';
import type {EssProfileProposal} from './personnel-ess-model';
/** Coupled facts must survive their canonical owner's validation as one change.
 * Holding an approval-off companion for review is safer than applying half a bank account,
 * passport, identity replacement or dated register row before its approved companion. */
export function splitProfileSubmission(policy:unknown,proposal:EssProfileProposal){
 const required=(id:string)=>{const field=personnelField(id);return !field||profileFieldApproval(policy,field).required;};
 const group=(id:string)=>{
  const binding=personnelField(id)?.ess.binding;
  if(binding?.owner==='bank'||binding?.owner==='identity')return binding.owner;
  if(binding?.owner==='passport'||binding?.owner==='person'&&binding.field==='nationality')return 'passport';
  return null;
 };
 const waitingGroups=new Set(proposal.fields.filter(field=>required(field.fieldId)).map(field=>group(field.fieldId)).filter(value=>value!==null));
 const immediate:EssProfileProposal={v:2,fields:[],registers:[]},waiting:EssProfileProposal={v:2,fields:[],registers:[]};
 for(const field of proposal.fields){const owner=group(field.fieldId);(required(field.fieldId)||owner!==null&&waitingGroups.has(owner)?waiting:immediate).fields.push(field);}
 for(const row of proposal.registers)(row.fields.some(field=>required(field.fieldId))?waiting:immediate).registers.push(row);
 return {immediate,waiting};
}
