/** AI v2 slice 3 follow-up — the seed a profile change prepared in chat opens the profile form on
 * (core/own-profile-edit-seed.ts). The pure filter over fictional proposals, and the reopen guard over a stand-in for
 * the review custody (the custody itself is proved on the database by test/proposal-own-profile-chat.test.ts). */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const custody=vi.hoisted(()=>({reopen:vi.fn()}));
vi.mock('../core/assistant-actions/module-action-review-store',()=>({reopenProfileModuleActionReview:custody.reopen}));
import {isWithheldFromSeed,ownProfileEditSeed,profileEditSeed} from '../core/own-profile-edit-seed';
import type {EssWorkspace} from '../core/profile-edit';

const LINE1='profile.contact_and_permanent_address.permanentaddressline1',CITY='profile.contact_and_permanent_address.permanentcity';
const BANK='bank_statutory.bank_information.bankname',ACCOUNT='bank_statutory.bank_information.bankaccountno',IC='profile.identity_and_passport.icnumber';
const CONTACT='profile.emergency_contact.fullname',DEPENDANT='family.family_and_dependents.fullname',DEPENDANT_IC='family.family_and_dependents.icorpassport';
const EMPLOYMENT='7c000000-0000-4000-8000-000000000001',CONTACT_ID='7c000000-0000-4000-8000-0000000000e1',REVIEW='7c000000-0000-4000-8000-0000000000a1';
const workspace=(over:Partial<EssWorkspace>={}):EssWorkspace=>({employmentId:EMPLOYMENT,personId:'p',country:'MY',values:{},baselines:{},
 registers:[{kind:'emergency',id:CONTACT_ID,primary:true,values:{},baselines:{}}],editable:[LINE1,BANK,ACCOUNT,IC,CONTACT,DEPENDANT,DEPENDANT_IC],legacyPrimaryEditable:[],
 addressReview:false,legacyAddress:{},statutoryAvailable:true,...over});
beforeEach(()=>custody.reopen.mockReset());

describe('the pure seed',()=>{
 it('seeds the requestable fields, existing and new records, and never a bank account or identity number',()=>{
  expect([ACCOUNT,IC,DEPENDANT_IC].map(isWithheldFromSeed)).toEqual([true,true,true]);
  expect([LINE1,BANK,CONTACT,DEPENDANT].map(isWithheldFromSeed)).toEqual([false,false,false,false]);
  const seed=profileEditSeed({v:2,fields:[{fieldId:LINE1,before:'b',value:'12 Jalan Fiksyen'},{fieldId:CITY,before:'b',value:'Not requestable'},{fieldId:BANK,before:'b',value:'Maybank'},
   {fieldId:ACCOUNT,before:'b',value:'514012345678'},{fieldId:IC,before:'b',value:'900101015555'}],
   registers:[{kind:'emergency',id:CONTACT_ID,clientId:'chat-emergency',fields:[{fieldId:CONTACT,before:'b',value:'Fictional Aisha'}]},
    {kind:'dependent',id:null,clientId:'chat-dependant',fields:[{fieldId:DEPENDANT,before:null,value:'Fictional Child'},{fieldId:DEPENDANT_IC,before:null,value:'200501145555'}]},
    {kind:'emergency',id:'7c000000-0000-4000-8000-0000000000e9',clientId:'gone',fields:[{fieldId:CONTACT,before:'b',value:'A record the page no longer holds'}]}]},workspace());
  expect(seed).toEqual({fields:{[LINE1]:'12 Jalan Fiksyen',[BANK]:'Maybank'},
   registers:[{kind:'emergency',id:CONTACT_ID,clientId:CONTACT_ID,values:{[CONTACT]:'Fictional Aisha'}},{kind:'dependent',id:null,clientId:'chat-dependant',values:{[DEPENDANT]:'Fictional Child'}}],
   withheld:[ACCOUNT,IC,DEPENDANT_IC]});
  expect(JSON.stringify(seed)).not.toMatch(/514012345678|900101015555|200501145555/);
 });
 it('a bank-only change seeds nothing but says which number was left empty; nothing requestable is no seed',()=>{
  expect(profileEditSeed({v:2,fields:[{fieldId:ACCOUNT,before:'b',value:'514012345678'}],registers:[]},workspace())).toEqual({fields:{},registers:[],withheld:[ACCOUNT]});
  expect(profileEditSeed({v:2,fields:[{fieldId:CITY,before:'b',value:'x'}],registers:[]},workspace())).toBeNull();
  expect(profileEditSeed({v:2,fields:[{fieldId:LINE1,before:'b',value:'x'}],registers:[]},workspace({editable:[]}))).toBeNull();
 });
});

describe('the reopen guard',()=>{
 const ctx={tenantId:'t',userId:'u',personId:'p'} as never;
 const prepared=(employmentId=EMPLOYMENT)=>({kind:'prepared',review:{content:{employmentId,proposal:{v:2,fields:[{fieldId:LINE1,before:'b',value:'12 Jalan Fiksyen'}],registers:[]}}}});
 it('seeds only the caller\'s own review still awaiting Confirm, for the employment on the page',async()=>{
  custody.reopen.mockResolvedValueOnce(prepared());
  expect(await ownProfileEditSeed(ctx,REVIEW,workspace())).toEqual({fields:{[LINE1]:'12 Jalan Fiksyen'},registers:[],withheld:[]});
  expect(custody.reopen).toHaveBeenCalledExactlyOnceWith(ctx,REVIEW);
  custody.reopen.mockResolvedValueOnce(prepared('7c000000-0000-4000-8000-000000000099'));
  expect(await ownProfileEditSeed(ctx,REVIEW,workspace())).toBeNull();
  custody.reopen.mockResolvedValueOnce({kind:'completed',receipt:{}});
  expect(await ownProfileEditSeed(ctx,REVIEW,workspace())).toBeNull();
  custody.reopen.mockRejectedValueOnce(new Error('Fictional custody refusal'));
  expect(await ownProfileEditSeed(ctx,REVIEW,workspace())).toBeNull();
 });
 it('never queries a malformed handle',async()=>{
  for(const bad of [undefined,'',REVIEW.toUpperCase(),'not-a-review',42,[REVIEW]])expect(await ownProfileEditSeed(ctx,bad,workspace())).toBeNull();
  expect(custody.reopen).not.toHaveBeenCalled();
 });
});
