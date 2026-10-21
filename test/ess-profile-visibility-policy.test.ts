import {describe,it,expect} from 'vitest';
import {essVisibleFields,resolveEssEditableIds,resolveEssPrimaryEditableIds} from '../lib/personnel-ess-contract';
import {resolveEssVisibleIds,projectEssVisible,projectOwnProfileProposal,ownProfileProposalIsIntact,linkedEssFieldIds} from '../lib/personnel-ess-visibility';
import {isProfileVisibilityPolicyValue,type ProfileVisibilityPolicyValue} from '../lib/profile-edit-policy-value';
const policy=():ProfileVisibilityPolicyValue=>({version:3,fields:Object.fromEntries(essVisibleFields().map(field=>[field.id,'viewOnly'])),primaryOnly:[]});
describe('ESS three-state disclosure authority',()=>{
 it('keeps the complete old visibility and finite emergency rights until an explicit new save',()=>{
  for(const raw of ['all',null,[],{version:2,fields:[]}])expect(resolveEssVisibleIds(raw).size).toBe(essVisibleFields().length);
  const legacy=resolveEssPrimaryEditableIds('all');expect(legacy.size).toBeGreaterThan(0);
  expect([...legacy].every(id=>essVisibleFields().some(field=>field.id===id&&field.ess.legacyPrimaryKey))).toBe(true);
  expect(resolveEssPrimaryEditableIds(policy()).size).toBe(0);
 });
 it('refuses malformed/newer policy generations instead of exposing legacy all',()=>{
  for(const raw of [{version:3,fields:[],primaryOnly:[]},{version:4,fields:{}},{version:3,fields:{a:'editable'},primaryOnly:[],extra:true}]){
   expect(isProfileVisibilityPolicyValue(raw)).toBe(false);expect(resolveEssVisibleIds(raw).size).toBe(0);
  }
 });
 it('removes a hidden source and its alternate current/history representation before serialization',()=>{
  const raw=policy(),company='employment.organisation_assignment.companyname',history='employment_history.before_changes_and_after_changes.companyname';
  const hidden={...raw,fields:{...raw.fields,[company]:'hide' as const}};
  const visible=resolveEssVisibleIds(hidden);
  expect(visible.has(company)).toBe(false);expect(visible.has(history)).toBe(false);
  const safe=projectEssVisible({[company]:'PRIVATE COMPANY',[history]:'PRIVATE COMPANY','profile.personal_details.fullname':'Allowed name'},visible);
  expect(JSON.stringify(safe)).not.toContain('PRIVATE COMPANY');expect(safe['profile.personal_details.fullname']).toBe('Allowed name');
 });
 it('hides age when its birthdate is hidden without hiding an unrelated person register',()=>{
  const raw=policy(),id='profile.personal_details.dateofbirth';
  const visible=resolveEssVisibleIds({...raw,fields:{...raw.fields,[id]:'hide'}});
  expect(visible.has('profile.personal_details.age')).toBe(false);
  expect(linkedEssFieldIds(id)).toContain('profile.personal_details.age');
  expect(linkedEssFieldIds(id)).not.toContain('family.family_and_dependents.dateofbirth');
  expect(visible.has('family.family_and_dependents.dateofbirth')).toBe(true);
 });
 it('never exposes hidden proposed values, CAS baselines or free-form reasons through own history',()=>{
  const raw=policy(),id='profile.personal_details.nationality',visible=resolveEssVisibleIds({...raw,fields:{...raw.fields,[id]:'hide'}});
  const request={v:2,fields:[{fieldId:id,before:'SECRET BASELINE',value:'PRIVATE NATIONALITY'},{fieldId:'profile.personal_details.firstname',before:'before',value:'Allowed'}],registers:[]};
  const safe=projectOwnProfileProposal(request,visible);
  expect(JSON.stringify(safe)).not.toContain('SECRET');expect(JSON.stringify(safe)).not.toContain('PRIVATE');expect(JSON.stringify(safe)).toContain('Allowed');
  expect(ownProfileProposalIsIntact(request,visible)).toBe(false);
  expect(ownProfileProposalIsIntact(request,resolveEssVisibleIds('all'))).toBe(true);
 });
 it('preserves a primary-only row capability without granting arbitrary emergency rows or creation',()=>{
  const raw=policy(),id=essVisibleFields().find(field=>field.ess.legacyPrimaryKey)!.id;
  const next={...raw,primaryOnly:[id]};
  expect(resolveEssPrimaryEditableIds(next).has(id)).toBe(true);expect(resolveEssEditableIds(next).has(id)).toBe(false);
  expect(resolveEssPrimaryEditableIds({...next,fields:{...next.fields,[id]:'hide'}}).has(id)).toBe(false);
 });
});
