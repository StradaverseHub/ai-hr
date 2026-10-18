import {describe,it,expect} from 'vitest';
import {profileProposalLines,profileProposalReviewLines} from '../lib/profile-proposal-display';
const resolve=(key:string,fallback:string)=>({
 'essProfile.register.emergency':'Emergency contact',
 'essProfile.missingRecord':'Original record unavailable',
 'essProfile.newRecord':'New record',
 'people.detail.emergency.name':'Contact name',
 'people.detail.genderMale':'Male',
} as Record<string,string>)[key]??fallback;
const fieldId='profile.emergency_contact.fullname',id='00000000-0000-4000-8000-000000000001';
describe('shared proposal presentation and exact review context',()=>{
 it('masks government IDs and bank values for the employee, including retained legacy requests',()=>{
  const raw={icNumber:'900101015555',passportNumber:'A123456789',bankAccountNo:'1234567890'};
  expect(profileProposalLines(raw,resolve,{mask:true}).map(line=>line.value)).toEqual(['•••• 5555','•••• 6789','•••• 7890']);
  expect(profileProposalLines(raw,resolve,{mask:false}).map(line=>line.value)).toEqual(Object.values(raw));
 });
 it('shows the original exact register current name beside the proposed value, never substituting another primary record',()=>{
  const raw={v:2,fields:[],registers:[{kind:'emergency',id,clientId:id,fields:[{fieldId,before:'captured-proof',value:'Requested name'}]}]};
  const key=`emergency:${id}:${fieldId}`;
  const lines=profileProposalReviewLines(raw,{[key]:{value:'Current exact name',recordName:'Current exact name',state:'existing'}},resolve,{mask:false});
  expect(lines).toHaveLength(1);expect(lines[0]).toMatchObject({key,label:'Contact name',value:'Requested name',currentValue:'Current exact name',recordLabel:'Emergency contact: Current exact name'});
  expect(profileProposalReviewLines(raw,{[key]:{value:undefined,recordName:null,state:'missing'}},resolve,{mask:false})[0]).toMatchObject({recordLabel:'Original record unavailable',currentValue:'Unavailable'});
 });
 it('never prints an arbitrary object or malformed versioned payload as a raw proposed value',()=>{
  expect(profileProposalLines({fullName:{private:'sensitive'}},resolve,{mask:false})).toEqual([]);
  expect(profileProposalLines({v:2,fields:'forged',private:'sensitive'},resolve,{mask:false})).toEqual([]);
 });
});
