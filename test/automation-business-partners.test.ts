import {describe,expect,it} from 'vitest';
import {businessPartnerRulesSchema,businessPartnerWorkspaceSchema,saveBusinessPartnersSchema} from '../lib/automation/business-partners';

const id='10000000-0000-4000-8000-000000000001';
const rule={userId:id,rules:{businessGroup:[id],company:[id],department:[id]}};
describe('shared business responsibility input boundary',()=>{
 it('preserves the old empty, catch-all and multidimension shapes without changing order or duplicate semantics',()=>{
  const rules=[{userId:id,rules:{}},rule,{userId:id,rules:{businessGroup:Array.from({length:501},()=>id)}}];
  expect(businessPartnerRulesSchema.parse([])).toEqual([]);
  expect(businessPartnerRulesSchema.parse(rules)).toEqual(rules);
 });
 it('refuses recipient routings, authority fields and unknown nested dimensions rather than silently stripping them',()=>{
  for(const value of [[{...rule,name:'Signer route'}],[{...rule,permissions:['view']}],[{...rule,rules:{jobTitle:[id]}}],[{...rule,rules:{company:['not-an-id']}}],[{...rule,userId:'person-label'}],[{...rule,rules:{company:id}}]])expect(businessPartnerRulesSchema.safeParse(value).success).toBe(false);
  expect(businessPartnerRulesSchema.safeParse(Array.from({length:501},()=>rule)).success).toBe(false);
 });
 it('requires a native nonnegative CAS revision and an explicit bounded explanation',()=>{
  const valid={expectedRevision:0,rules:[rule],reason:'Reviewed actual Business Partner responsibilities'};
  expect(saveBusinessPartnersSchema.parse(valid)).toEqual(valid);
  for(const change of [{expectedRevision:-1},{expectedRevision:1.5},{reason:'short'},{reason:'x'.repeat(5001)},{ready:true},{companyId:id}])expect(saveBusinessPartnersSchema.safeParse({...valid,...change}).success).toBe(false);
 });
 it('keeps unavailable saved rules while requiring explicit actual label collections in the native workspace',()=>{
  const workspace={revision:1,rules:[rule],people:[],scopeLabels:{businessGroup:[],company:[],department:[]}};
  expect(businessPartnerWorkspaceSchema.parse(workspace)).toEqual(workspace);
  expect(businessPartnerWorkspaceSchema.safeParse({revision:1,rules:[rule]}).success).toBe(false);
  expect(businessPartnerWorkspaceSchema.safeParse({...workspace,scopeLabels:{...workspace.scopeLabels,jobTitle:[]}}).success).toBe(false);
 });
});
