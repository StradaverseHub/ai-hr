import * as React from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {ClaimForm,type ClaimFormType} from '../components/claim-form';
import {todayInKualaLumpur} from '../lib/hr-date';
afterEach(cleanup);
const today=todayInKualaLumpur(),employmentId='5b9c9f7f-bd09-4d8d-a34d-201b1abf79e2';
const type:ClaimFormType={id:'type',code:'FICT',name:'Fictional claim',requiresReceipt:false,rateConfig:null,isMileage:false,items:[],minDate:today,balance:{items:[],annualLimit:null,usedThisYear:0,reservedThisYear:0,remainingThisYear:null,monthlyLimit:null,remainingThisMonth:null,perClaimCap:null,claimsUsedThisYear:0,maxClaimsPerYear:null,blockLimit:null,remainingThisBlock:null,blockEndsOn:null}};
describe('selected own claim form context',()=>{
 it('posts the selected subject with an existing draft and retains it on a refusal',async()=>{
  const action=vi.fn(async(_state:{error:string|null},data:FormData)=>{expect(data.get('employmentId')).toBe(employmentId);expect(data.get('draftId')).toBe('draft');return {error:'Fictional refusal'};});
  render(<NextIntlClientProvider locale="en" messages={en}><ClaimForm types={[type]} submitAction={action} todayUtc={today} employmentId={employmentId} draft={{id:'draft',claimTypeId:'type',claimItemId:null,amount:10,quantityKm:null,incurredOn:today,description:'Fictional saved draft'}}/></NextIntlClientProvider>);
  fireEvent.submit(document.querySelector('form')!);await screen.findByText('Fictional refusal');
  await waitFor(()=>expect(action).toHaveBeenCalledOnce());expect((document.querySelector('input[name="employmentId"]') as HTMLInputElement).value).toBe(employmentId);expect(screen.getByDisplayValue('Fictional saved draft')).toBeTruthy();
 });
 it('leaves legacy forms without an explicit subject field',()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><ClaimForm types={[type]} submitAction={async()=>({error:null})} todayUtc={today}/></NextIntlClientProvider>);expect(document.querySelector('input[name="employmentId"]')).toBeNull();
 });
});
