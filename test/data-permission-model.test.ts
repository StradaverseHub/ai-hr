import {describe,it,expect} from 'vitest';
import {DATA_PERMISSION_FIELDS,canonicalDataPermissionRules} from '../lib/data-permission-model';
describe('closed data permission input language',()=>{
 it('accepts explicit legacy-company preset and canonical AND/OR fields without expressions',()=>{
  expect(DATA_PERMISSION_FIELDS).toHaveLength(17);
  expect(canonicalDataPermissionRules({legacyCompany:true,predicates:[]})).toEqual({legacyCompany:true,predicates:[]});
  expect(canonicalDataPermissionRules({legacyCompany:false,predicates:[{field:'gender',values:['male','female']},{field:'category',values:['Executive']}]}).predicates).toEqual([{field:'category',values:['Executive']},{field:'gender',values:['female','male']}]);
 });
 it('rejects empty rules, duplicate fields/values, caller SQL and ambiguous typed references',()=>{
  for(const value of [
   {legacyCompany:false,predicates:[]},{legacyCompany:true,predicates:[{field:'gender',values:['female']}]},
   {legacyCompany:false,predicates:[{field:'grade',values:['Grade A']}]},
   {legacyCompany:false,predicates:[{field:'gender',values:['female','female']}]},
   {legacyCompany:false,predicates:[{field:'gender',values:['female']},{field:'gender',values:['male']}]},
   {legacyCompany:false,predicates:[{field:'gender',values:['female'],sql:'true'}]},
   {legacyCompany:false,predicates:[{field:'password',values:['anything']}]},
  ])expect(()=>canonicalDataPermissionRules(value)).toThrow('invalid');
 });
});
