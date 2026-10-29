import {describe,it,expect} from 'vitest';
import {profileFieldApproval,isProfileVisibilityPolicyValue} from '../lib/profile-edit-policy-value';
import {personnelField} from '../lib/personnel-field-registry';
import {splitProfileSubmission} from '../lib/profile-submission-policy';
import type {EssProfileProposal} from '../lib/personnel-ess-model';
const phone='profile.contact_and_permanent_address.phone',name='profile.personal_details.firstname',familyName='family.family_and_dependents.fullname',relationship='family.family_and_dependents.relationship';
const policy=(approvals:Record<string,{required:boolean;attachmentRequired:boolean}>)=>({version:5,fields:{[phone]:'editable',[name]:'editable',[familyName]:'editable',[relationship]:'editable'},primaryOnly:[],groups:{},approvals});
describe('versioned field approvals and submission partitioning',()=>{
 it('preserves descriptor defaults until an explicit valid rule is saved',()=>{expect(profileFieldApproval(policy({}),personnelField(phone)!)).toEqual({required:false,attachmentRequired:false});expect(profileFieldApproval(policy({}),personnelField(name)!)).toEqual({required:true,attachmentRequired:false});expect(profileFieldApproval(policy({[phone]:{required:true,attachmentRequired:true}}),personnelField(phone)!)).toEqual({required:true,attachmentRequired:true});});
 it('refuses malformed rules and an attachment requirement without approval',()=>{for(const approval of [{required:false,attachmentRequired:true},{required:'true',attachmentRequired:false},{required:true},{required:true,attachmentRequired:false,extra:true}])expect(isProfileVisibilityPolicyValue(policy({[name]:approval as never}))).toBe(false);});
 it('partitions the exact submitted values by field without early-applying an atomic new row',()=>{
  const raw=policy({[name]:{required:false,attachmentRequired:false},[phone]:{required:true,attachmentRequired:false},[familyName]:{required:false,attachmentRequired:false}});
  const proposal:EssProfileProposal={v:2,fields:[{fieldId:name,before:null,value:'Direct'},{fieldId:phone,before:null,value:'Pending'}],registers:[{kind:'dependent',id:null,clientId:'new',fields:[{fieldId:familyName,before:null,value:'New dependent'},{fieldId:relationship,before:null,value:'child'}]}]};
  const result=splitProfileSubmission(raw,proposal);expect(result.immediate.fields).toEqual([proposal.fields[0]]);expect(result.waiting.fields).toEqual([proposal.fields[1]]);expect(result.immediate.registers).toEqual([]);expect(result.waiting.registers).toEqual(proposal.registers);
 });
});
