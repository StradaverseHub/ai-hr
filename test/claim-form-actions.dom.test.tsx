// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {ClaimForm,type ClaimFormType} from '../components/claim-form';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';
afterEach(cleanup);
const type:ClaimFormType={id:'10000000-0000-4000-8000-000000000001',code:'FIXTURE',name:'Fictional claim type',requiresReceipt:false,rateConfig:null,isMileage:false,items:[],minDate:'2026-10-01',balance:{items:[],annualLimit:null,usedThisYear:0,reservedThisYear:0,remainingThisYear:null,monthlyLimit:null,remainingThisMonth:null,perClaimCap:null,claimsUsedThisYear:0,maxClaimsPerYear:null,blockLimit:null,remainingThisBlock:null,blockEndsOn:null}};
for(const [locale,messages] of Object.entries({en,ms,ta,th,vi,zh})){
 it(`renders independent native Save and Submit controls in ${locale}`,()=>{
  const tree=(allowSave:boolean,allowSubmit:boolean)=><NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Kuala_Lumpur"><ClaimForm types={[type]} todayUtc="2026-11-03" submitAction={async()=>({error:null})} allowSave={allowSave} allowSubmit={allowSubmit}/></NextIntlClientProvider>;
  const view=render(tree(false,true));
  const buttons=()=>Array.from(view.container.querySelectorAll<HTMLButtonElement>('button[type="submit"]'));
  expect(buttons()).toHaveLength(2);
  expect(buttons().find(button=>button.name==='intent')?.disabled).toBe(true);
  expect(buttons().find(button=>button.name!=='intent')?.disabled).toBe(false);
  view.rerender(tree(true,false));
  expect(buttons().find(button=>button.name==='intent')?.disabled).toBe(false);
  expect(buttons().find(button=>button.name!=='intent')?.disabled).toBe(true);
  expect(buttons().every(button=>button.textContent?.trim())).toBe(true);
 });
}
