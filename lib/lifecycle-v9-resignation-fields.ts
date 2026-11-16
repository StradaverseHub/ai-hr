/** Offboarding-only picker additions. Existing module pickers keep their original groups and keys. */
import {OFFBOARDING_AUTOMATION_CATALOGUE} from './automation/catalogues/offboarding';
import {personnelMergeGroups} from './lifecycle-v9-personnel-merge-fields';
import {lifecycleEmailFieldGroups} from './lifecycle-v9-email-fields';
export type LifecycleMergeField = {key:string;label:string;type?:'phone'|'email'|'date'};
export type LifecycleMergeFieldGroup = {label:string;fields:readonly LifecycleMergeField[]};
function withResignationFields(base:readonly LifecycleMergeFieldGroup[],email:boolean):LifecycleMergeFieldGroup[]{
 const groups=base.map(group=>({label:group.label,fields:[...group.fields]})),seen=new Set(groups.flatMap(group=>group.fields.map(field=>field.key)));
 for(const field of OFFBOARDING_AUTOMATION_CATALOGUE.mergeFields){
  if(seen.has(field.key)||email&&field.key==='employee.salary')continue;
  seen.add(field.key);
  let group=groups.find(group=>group.label===field.group);
  if(!group){group={label:field.group,fields:[]};groups.push(group);}
  const date=field.key==='today'||['resignation.submittedDate','resignation.lastDay','retention.effectiveDate','retention.replyBy'].includes(field.key);
  group.fields.push({key:field.key,label:field.label,...(date?{type:'date' as const}:{})});
 }
 return groups;
}
export const offboardingDocumentFieldGroups=withResignationFields(personnelMergeGroups,false);
export const offboardingEmailFieldGroups=withResignationFields(lifecycleEmailFieldGroups,true);
export const offboardingMergeLabels=new Map(offboardingDocumentFieldGroups.flatMap(group=>group.fields.map(field=>[field.key,field.label] as const)));
