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
  const form=document.querySelector('form[data-claim-form-ready="true"]');
  expect(form).not.toBeNull();
  fireEvent.submit(form!);await screen.findByText('Fictional refusal');
  await waitFor(()=>expect(action).toHaveBeenCalledOnce());expect((document.querySelector('input[name="employmentId"]') as HTMLInputElement).value).toBe(employmentId);expect(screen.getByDisplayValue('Fictional saved draft')).toBeTruthy();
 });
 it('leaves legacy forms without an explicit subject field',()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><ClaimForm types={[type]} submitAction={async()=>({error:null})} todayUtc={today}/></NextIntlClientProvider>);expect(document.querySelector('input[name="employmentId"]')).toBeNull();
 });
});

describe('the claim form\'s currency (AI v2 slice 3 follow-up)',()=>{
 const limited:ClaimFormType={...type,balance:{...type.balance,annualLimit:2000,usedThisYear:620,reservedThisYear:120,remainingThisYear:1260,perClaimCap:500}};
 const amounts=()=>[...document.querySelectorAll('.tabular-nums')].map(el=>el.textContent);
 it('labels every balance amount with the employing company\'s currency, never a hard-coded RM',()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><ClaimForm types={[limited]} submitAction={async()=>({error:null})} todayUtc={today} currency="SGD"/></NextIntlClientProvider>);
  expect(amounts()).toEqual(expect.arrayContaining(['SGD 2,000.00','SGD 620.00','SGD 120.00','SGD 1,260.00','SGD 500.00']));
  expect(screen.getByText('Amount (SGD)')).toBeTruthy();
  expect(document.body.textContent).not.toContain('RM');
 });
 it('shows the amounts unlabelled when the currency could not be read, rather than guessing one',()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><ClaimForm types={[limited]} submitAction={async()=>({error:null})} todayUtc={today} currency={null}/></NextIntlClientProvider>);
  expect(amounts()).toEqual(expect.arrayContaining(['2,000.00','1,260.00']));
  expect(screen.getByText('Amount')).toBeTruthy();
  expect(document.body.textContent).not.toContain('RM');
 });
});
