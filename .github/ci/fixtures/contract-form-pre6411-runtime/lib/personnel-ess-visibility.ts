/** Server projection policy. Hiding a fact also hides its repeated representations. */
import {PROFILE_PHOTO_FIELD,isProfilePhotoProposal} from './profile-photo-proposal';
import {PERSONNEL_FIELDS,personnelField} from './personnel-field-registry';
import {isLegacyProfileEditPolicy,isProfileEditPolicyValue,isProfileVisibilityPolicyValue,effectiveProfileFieldPermission} from './profile-edit-policy-value';
const explicitAliases:readonly (readonly string[])[]=[
 ['person.fullName','person.firstName','person.lastName'],
 // Birth date is written by the compliance owner; age is a derived Person projection.
 ['compliance.dateOfBirth','person.dateOfBirth','person.age'],
 ['dependent.dateOfBirth','dependent.age'],
 ['employment.hiredOn','employment.groupService','employment.yearOfService'],
 ['employment.joinDate','employment.companyService'],
 ['employment.confirmationDate','employment.finalConfirmationDate'],
 ['assignment.companyName','movementComparison.companyName'],
 ['assignment.businessUnitName','movementComparison.businessUnitName'],
 ['assignment.departmentName','movementComparison.departmentName'],
 ['assignment.positionName','movementComparison.positionName'],
 ['assignment.gradeName','movementComparison.gradeName','benefitScheme.gradeName'],
 ['assignment.employmentType','movementComparison.employmentType'],
 ['assignment.locationName','movementComparison.locationName'],
 ...['orgDivision','orgBranch','orgRegion','orgTeam','orgSection','orgLine','orgBase','employmentCategory'].map(key=>[`employment.${key}`,`movementComparison.${key}`]),
];
const identity=(field:typeof PERSONNEL_FIELDS[number])=>`${field.ess.binding?.owner??field.owner}.${field.ess.binding?.field??field.ownerField}`;
export function resolveEssVisibleIds(raw:unknown):ReadonlySet<string>{
 const fields=PERSONNEL_FIELDS.filter(field=>field.ess.visibility==='visible');
 if(isLegacyProfileEditPolicy(raw)||isProfileEditPolicyValue(raw))return new Set(fields.map(field=>field.id));
 if(!isProfileVisibilityPolicyValue(raw))return new Set();
 const hidden=new Set(fields.filter(field=>effectiveProfileFieldPermission(raw,field)==='hide').map(identity));
 // Transitive closure is deliberate: a derived alias cannot restore its source through a third view.
 let changed=true;while(changed){changed=false;for(const group of explicitAliases){if(!group.some(key=>hidden.has(key)))continue;for(const key of group)if(!hidden.has(key)){hidden.add(key);changed=true;}}}
 return new Set(fields.filter(field=>!hidden.has(identity(field))).map(field=>field.id));
}
export function projectEssVisible<T>(values:Readonly<Record<string,T>>,visible:ReadonlySet<string>):Record<string,T>{
 return Object.fromEntries(Object.entries(values).filter(([id])=>visible.has(id)));
}
/** Strip both proposed values and CAS baselines from own history before serialization. */
export function projectOwnProfileProposal(raw:unknown,visible:ReadonlySet<string>):unknown{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return {};
 const value=raw as Record<string,unknown>;
 if(isProfilePhotoProposal(raw))return visible.has(PROFILE_PHOTO_FIELD)?{v:3,kind:'photo',fieldId:PROFILE_PHOTO_FIELD}:{};
 if(value.v===2){
  const filter=(fields:unknown)=>Array.isArray(fields)?fields.filter(item=>item&&typeof item==='object'&&!Array.isArray(item)&&typeof item.fieldId==='string'&&visible.has(item.fieldId)):[];
  return {v:2,fields:filter(value.fields),registers:Array.isArray(value.registers)?value.registers.flatMap(row=>{
   if(!row||typeof row!=='object'||Array.isArray(row))return [];
   const fields=filter(row.fields);return fields.length?[{...row,fields}]:[];
  }):[]};
 }
 return Object.fromEntries(Object.entries(value).filter(([key])=>PERSONNEL_FIELDS.some(field=>field.ess.binding?.legacyKey===key&&visible.has(field.id))));
}
/** Exactly one descriptor-backed fact, including callers whose property names differ. */
export function essFactVisible(visible:ReadonlySet<string>,owner:string,field:string):boolean{
 return PERSONNEL_FIELDS.some(item=>visible.has(item.id)&&identity(item)===`${owner}.${field}`);
}
export function essFieldVisible(visible:ReadonlySet<string>,id:string){return Boolean(personnelField(id)&&visible.has(id));}

/** Text reasons can repeat any original line; only an entirely visible request may disclose them. */
export function ownProfileProposalIsIntact(raw:unknown,visible:ReadonlySet<string>):boolean{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
 if(isProfilePhotoProposal(raw))return visible.has(PROFILE_PHOTO_FIELD);
 const value=raw as Record<string,unknown>;
 if(value.v===2){
  if(!Array.isArray(value.fields)||!Array.isArray(value.registers))return false;
  const rows=value.registers.flatMap(row=>row&&typeof row==='object'&&!Array.isArray(row)&&Array.isArray(row.fields)?row.fields:[null]);
  return [...value.fields,...rows].every(item=>item&&typeof item==='object'&&!Array.isArray(item)&&typeof item.fieldId==='string'&&visible.has(item.fieldId));
 }
 return Object.keys(value).every(key=>PERSONNEL_FIELDS.some(field=>field.ess.binding?.legacyKey===key&&visible.has(field.id)));
}

/** Same explicit fact closure for the settings draft; no hidden browser facts are inspected. */
export function linkedEssFieldIds(id:string):string[]{
 const field=personnelField(id);if(!field)return [];
 const linked=new Set([identity(field)]);let changed=true;
 while(changed){changed=false;for(const group of explicitAliases){if(!group.some(key=>linked.has(key)))continue;for(const key of group)if(!linked.has(key)){linked.add(key);changed=true;}}}
 return PERSONNEL_FIELDS.filter(item=>item.ess.visibility==='visible'&&linked.has(identity(item))).map(item=>item.id);
}
