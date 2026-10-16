import {describe,it,expect} from 'vitest';
import {PERSONNEL_FIELDS,personnelField} from '../lib/personnel-field-registry';
import {PROFILE_REQUESTABLE_KEYS} from '../lib/profile-requestable-fields';
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
 it('pins legacy all to the prior requests and finite immediate contacts, with new fields closed',()=>{
  const defaults=resolveEssEditableIds('all');
  expect(defaults.has(phone)).toBe(true);expect(defaults.has(address)).toBe(false);
  for(const field of essEditableFields())expect(defaults.has(field.id)).toBe(Boolean(field.ess.legacyImmediate||field.ess.binding?.legacyKey&&PROFILE_REQUESTABLE_KEYS.includes(field.ess.binding.legacyKey)));
  expect(resolveEssEditableIds([]).size).toBe(0);expect(resolveEssEditableIds({all:true}).size).toBe(0);
  expect(resolveEssEditableIds([address])).toEqual(new Set([address]));
 });
 it('keeps primary-only compatibility distinct from generic register permission and honors explicit View Only',()=>{
  const legacy=resolveEssPrimaryEditableIds('all');expect(legacy.has(primary)).toBe(true);expect(legacy.size).toBe(5);
  expect(resolveEssEditableIds('all').has(primary)).toBe(false);
  expect(resolveEssPrimaryEditableIds([]).size).toBe(0);
  expect(resolveEssPrimaryEditableIds(['legacyPrimaryEmergency.fullName'])).toEqual(new Set([primary]));
  expect(resolveEssEditableIds([primary])).toEqual(new Set([primary]));expect(resolveEssPrimaryEditableIds([primary]).size).toBe(0);
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
