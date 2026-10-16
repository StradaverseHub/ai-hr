import {describe,it,expect} from 'vitest';
import {PERSONNEL_FIELDS,personnelField} from '../lib/personnel-field-registry';
import {resolveAllowedRequestKeys,PROFILE_REQUESTABLE_KEYS} from '../lib/profile-requestable-fields';
import {essEditableFields,parseEssProfileProposal,resolveEssEditableIds,resolveEssPrimaryEditableIds} from '../lib/personnel-ess-contract';
import {ESS_PROFILE_TABS} from '../lib/personnel-ess-model';
const phone='profile.contact_and_permanent_address.phone';
const address='profile.contact_and_permanent_address.permanentaddressline1';
const primary='profile.emergency_contact.fullname';
describe('explicit shared Personnel ESS contract',()=>{
 it('inventories every actual descriptor without deriving employee rights from import/report metadata',()=>{
  for(const field of PERSONNEL_FIELDS){expect(field.ess,field.id).toBeDefined();expect(field.ess.reason,field.id).toBeTruthy();if(field.ess.binding)expect(field.ess.visibility,field.id).toBe('visible');}
  expect(new Set(PERSONNEL_FIELDS.map(field=>field.tab))).toEqual(new Set(ESS_PROFILE_TABS));
  expect(personnelField('others.change_history.previousvalue')?.ess.visibility).toBe('protected');
  expect(personnelField('profile.personal_details.employeecode')?.ess.edit).toBe('viewOnly');
 });
 it('keeps legacy all and request-only lists compatible without granting new fields',()=>{
  const defaults=resolveEssEditableIds('all');
  for(const raw of ['all',undefined,null])expect(resolveEssEditableIds(raw)).toEqual(defaults);
  for(const field of essEditableFields())expect(defaults.has(field.id)).toBe(Boolean(field.ess.legacyImmediate||field.ess.binding?.legacyKey&&PROFILE_REQUESTABLE_KEYS.includes(field.ess.binding.legacyKey)));
  const direct=essEditableFields().filter(field=>field.ess.legacyImmediate).map(field=>field.id);
  expect(resolveEssEditableIds([])).toEqual(new Set(direct));expect(resolveAllowedRequestKeys([]).size).toBe(0);
  expect(resolveEssEditableIds(['fullName'])).toEqual(new Set([...direct,'profile.personal_details.fullname']));
  expect(resolveAllowedRequestKeys(['fullName','not-a-field'])).toEqual(new Set(['fullName']));
  expect(resolveEssEditableIds([address])).toEqual(new Set(direct));expect(defaults.has(address)).toBe(false);
  expect(defaults.has('family.family_and_dependents.fullname')).toBe(false);expect(defaults.has('family.family_and_dependents.gender')).toBe(false);expect(defaults.has('family.family_and_dependents.dateofbirth')).toBe(false);
  for(const raw of ['all',[],['fullName']])expect(resolveEssPrimaryEditableIds(raw).size).toBe(5);
 });
 it('makes a complete v2 policy explicit: empty and View Only close legacy rights; each grant stays finite',()=>{
  const policy=(fields:string[])=>({version:2,fields});
  expect(resolveEssEditableIds(policy([])).size).toBe(0);expect(resolveEssPrimaryEditableIds(policy([])).size).toBe(0);expect(resolveAllowedRequestKeys(policy([])).size).toBe(0);
  expect(resolveEssEditableIds(policy([address,phone]))).toEqual(new Set([address,phone]));
  expect(resolveAllowedRequestKeys(policy([phone])).size).toBe(0);
  expect(resolveEssPrimaryEditableIds(policy(['legacyPrimaryEmergency.fullName']))).toEqual(new Set([primary]));
  expect(resolveEssEditableIds(policy(['legacyPrimaryEmergency.fullName'])).size).toBe(0);
  expect(resolveEssEditableIds(policy([primary]))).toEqual(new Set([primary]));expect(resolveEssPrimaryEditableIds(policy([primary])).size).toBe(0);
  expect(resolveAllowedRequestKeys(policy(['profile.personal_details.fullname']))).toEqual(new Set(['profile.personal_details.fullname','fullName']));
  for(const raw of [{all:true},{version:2,fields:null},{version:2,fields:[phone],extra:true},{version:3,fields:[phone]},{version:2,fields:[phone,phone]}]){
   expect(resolveEssEditableIds(raw).size).toBe(0);expect(resolveEssPrimaryEditableIds(raw).size).toBe(0);expect(resolveAllowedRequestKeys(raw).size).toBe(0);
  }
 });
 it('preserves touched clearing and rejects hidden fields, forged owner placement and duplicate changes',()=>{
  const valid={v:2,fields:[{fieldId:phone,before:'0123',value:null}],registers:[]};expect(parseEssProfileProposal(valid)).toEqual(valid);
  expect(()=>parseEssProfileProposal({...valid,fields:[...valid.fields,...valid.fields]})).toThrow();
  expect(()=>parseEssProfileProposal({...valid,fields:[{fieldId:'others.change_history.previousvalue',before:null,value:'forged'}]})).toThrow();
  expect(()=>parseEssProfileProposal({...valid,fields:[{fieldId:primary,before:null,value:'forged scalar'}]})).toThrow();
  expect(()=>parseEssProfileProposal({...valid,registers:[{kind:'emergency',id:null,clientId:'new',fields:valid.fields}]})).toThrow();
  expect(()=>parseEssProfileProposal({...valid,admin:true})).toThrow();
 });
});
