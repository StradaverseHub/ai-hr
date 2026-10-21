import {describe,it,expect} from 'vitest';
import {resolveAllowedRequestKeys} from '../lib/profile-requestable-fields';
import {essVisibleFields,resolveEssEditableIds,resolveEssPrimaryEditableIds} from '../lib/personnel-ess-contract';
import {resolveEssVisibleIds,projectEssVisible,projectOwnProfileProposal,ownProfileProposalIsIntact,linkedEssFieldIds} from '../lib/personnel-ess-visibility';
import {isProfileVisibilityPolicyValue,type ProfileVisibilityPolicyValue,profileTabPolicyKey,profileSectionPolicyKey} from '../lib/profile-edit-policy-value';
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

describe('ESS group policy upper bounds',()=>{
 const full=()=>({...policy(),version:4 as const,groups:{},fields:Object.fromEntries(essVisibleFields().map(field=>[field.id,field.ess.binding&&['immediate','approval'].includes(field.ess.edit)?'editable' as const:'viewOnly' as const]))});
 it('preserves v3 access when upgrading shape without a group restriction',()=>{
  const before=policy(),after={...before,version:4 as const,groups:{}};
  expect(isProfileVisibilityPolicyValue(after)).toBe(true);expect([...resolveEssVisibleIds(after)]).toEqual([...resolveEssVisibleIds(before)]);
 });
 it('tab View Only caps writable fields and finite emergency compatibility without losing readable values',()=>{
  const raw=full(),field=essVisibleFields().find(field=>field.ess.legacyPrimaryKey)!;
  const next={...raw,primaryOnly:[field.id],fields:{...raw.fields,[field.id]:'viewOnly' as const},groups:{[profileTabPolicyKey(field.tab)]:'viewOnly' as const}};
  expect(resolveEssVisibleIds(next).has(field.id)).toBe(true);expect(resolveEssPrimaryEditableIds(next).has(field.id)).toBe(false);
  for(const candidate of essVisibleFields().filter(item=>item.tab===field.tab)){expect(resolveEssEditableIds(next).has(candidate.id)).toBe(false);expect(resolveAllowedRequestKeys(next).has(candidate.id)).toBe(false);}
 });
 it('hiding an entire section strips its alternate facts, pending values and baselines',()=>{
  const field=essVisibleFields().find(field=>field.id==='profile.personal_details.dateofbirth')!;
  const raw={...full(),groups:{[profileSectionPolicyKey(field.tab,field.section)]:'hide' as const}};
  const visible=resolveEssVisibleIds(raw);expect(visible.has(field.id)).toBe(false);expect(visible.has('profile.personal_details.age')).toBe(false);
  const proposal={v:2,fields:[{fieldId:field.id,before:'SECRET BASELINE',value:'PRIVATE DATE'}],registers:[]};
  expect(JSON.stringify(projectOwnProfileProposal(proposal,visible))).not.toMatch(/SECRET|PRIVATE/);
  expect(ownProfileProposalIsIntact(proposal,visible)).toBe(false);
 });
 it('group Editable never overrides hidden/read-only fields or invents a specialist write',()=>{
  const raw=full(),photo='profile.personal_details.photo',name='profile.personal_details.fullname';
  const next={...raw,fields:{...raw.fields,[name]:'hide' as const}};
  expect(resolveEssVisibleIds(next).has(name)).toBe(false);expect(resolveEssEditableIds(next).has(photo)).toBe(false);
 });
 it('does not expose a pending photo baseline in the employee projection',()=>{
  const proposal={v:3,kind:'photo',fieldId:'profile.personal_details.photo',baselineHash:'a'.repeat(64)};
  expect(projectOwnProfileProposal(proposal,resolveEssVisibleIds('all'))).toEqual({v:3,kind:'photo',fieldId:'profile.personal_details.photo'});
  const visible=new Set(resolveEssVisibleIds('all'));visible.delete('profile.personal_details.photo');
  expect(projectOwnProfileProposal(proposal,visible)).toEqual({});expect(ownProfileProposalIsIntact(proposal,visible)).toBe(false);
 });
 it('rejects malformed group caps instead of falling back to default disclosure',()=>{
  for(const groups of [[],null,{'tab:Profile':'all'},Object.fromEntries(Array.from({length:129},(_,i)=>['group:'+i,'hide']))]){
   const raw={...full(),groups};expect(isProfileVisibilityPolicyValue(raw)).toBe(false);expect(resolveEssVisibleIds(raw).size).toBe(0);
  }
 });
});
