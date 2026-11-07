import { expect, it } from 'vitest';
import { defaultV9CaseFields, resolveV9CaseFields, missingV9CaseFields, v9CaseFieldShown, validateV9CaseFields } from '../lib/lifecycle-v9-case-form';
import { parseV9Config } from '../lib/lifecycle-v9-validation';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
it('retains Personnel ownership and the required fixed revocation condition', () => {
  const fields=defaultV9CaseFields('off'); const date=fields.find(field=>field.key==='lastDay')!;date.type='text';date.required=true;date.show=false;date.rules={company:['other']};
  const resolved=resolveV9CaseFields('off',fields),last=resolved.find(field=>field.key==='lastDay')!;
  expect(last).toMatchObject({source:'personnel',system:true,type:'date',show:false,required:false,rules:{}});
  const revoke=resolved.find(field=>field.key==='revokeDate')!;
  expect(v9CaseFieldShown(revoke,{}, {revokeMode:'lastday'},true)).toBe(false);
  expect(v9CaseFieldShown(revoke,{}, {revokeMode:'date'},true)).toBe(true);
  expect(missingV9CaseFields(resolved,{}, {type:'Resignation',notice:'2026-10-01',revokeMode:'date',revokeDate:'2026-02-30'},true).map(field=>field.key)).toEqual(['revokeDate']);
});
it('requires only matching visible conditional custom answers and enforces the HR-only view', () => {
  const fields=defaultV9CaseFields('onb'); fields.push({key:'clearance',label:'Clearance detail',type:'long',show:true,required:true,hrOnly:true,rules:{company:['company-one'],department:['dept-one','dept-two']},options:[],help:'',when:{field:'hireType',value:'replacement'}});
  const resolved=validateV9CaseFields('onb',fields),values={hireType:'replacement',replacing:'Actual employee'};
  expect(missingV9CaseFields(resolved,{company:'company-one',department:'dept-two'},values,true).map(field=>field.key)).toEqual(['clearance']);
  expect(missingV9CaseFields(resolved,{company:'company-two',department:'dept-two'},values,true)).toEqual([]);
  expect(missingV9CaseFields(resolved,{company:'company-one',department:'dept-two'},values,false)).toEqual([]);
  expect(missingV9CaseFields(resolved,{company:'company-one',department:'dept-two'},{hireType:'new_hire'},true)).toEqual([]);
});
it('rejects duplicate keys and dangling conditions while allowing display removal', () => {
  const config=v9Defaults();config.caseForms={onb:defaultV9CaseFields('onb')};
  config.caseForms.onb!.push({...config.caseForms.onb![0]});expect(()=>parseV9Config(config)).toThrow('distinct');config.caseForms.onb!.pop();
  config.caseForms.onb!.shift();expect(()=>parseV9Config(config)).not.toThrow();
  const fields=defaultV9CaseFields('onb');fields.push({key:'custom',label:'Custom',type:'text',show:true,required:false,hrOnly:false,rules:{},options:[],help:'',when:{field:'removed',value:'yes'}});
  expect(()=>validateV9CaseFields('onb',fields)).toThrow('dropdown');
});

it('preserves removed field settings and operational values independently from display membership', () => {
  const fields=defaultV9CaseFields('onb');fields.find(field=>field.key==='group')!.removed=true;
  fields.find(field=>field.key==='name')!.show=false;
  expect(validateV9CaseFields('onb',fields).find(field=>field.key==='group')).toMatchObject({source:'personnel',removed:true});
  expect(resolveV9CaseFields('onb',fields).some(field=>field.key==='group')).toBe(false);
  expect(resolveV9CaseFields('onb',fields).find(field=>field.key==='name')!.show).toBe(false);
  delete fields.find(field=>field.key==='group')!.removed;
  expect(resolveV9CaseFields('onb',fields).find(field=>field.key==='group')!.source).toBe('personnel');
});
