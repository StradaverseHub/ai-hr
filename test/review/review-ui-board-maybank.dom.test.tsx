/** Real company/payee components with fictional data. This is rendered fixture evidence, not bank acceptance. */
import {describe,it,expect,vi,afterEach} from 'vitest';
import {render,cleanup} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {CompanyPanel,type PanelCompany,type PanelBankProfile} from '../../components/company-panel';
import {BankInfoCard} from '../../components/bank-info-card';
import {captureAiReviewScreenshots} from '../helpers/ai-review-screenshots';
import en from '../../messages/en.json';import ms from '../../messages/ms.json';import zh from '../../messages/zh.json';import viLocale from '../../messages/vi.json';import ta from '../../messages/ta.json';import th from '../../messages/th.json';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh(){},push(){},replace(){}}),usePathname:()=>'/admin/organization/fictional',useSearchParams:()=>new URLSearchParams()}));
const company:PanelCompany={id:'fictional-company',name:'Fictional Manufacturing Sdn Bhd',country:'MY',currency:'MYR',registrationNo:null,companyLabel:'FICT',industry:null,website:null,businessType:null,addressLine1:null,addressLine2:null,addressLine3:null,city:null,state:null,addressCountry:null,postcode:null,phone:null,fax:null,archivedAt:null,deleteBlockedBy:null,canDelete:true,parentId:null,hasLogo:false,defaultPayrollCycle:'Monthly'};
const profile:PanelBankProfile={id:'fictional-bank',bank:'maybank',corporateId:'FICTIONAL',debitAccountNo:'512345678901',orgName:company.name,txnType:'IBG',accountLabel:'Fictional payroll account',accountName:company.name,accountType:null,branch:null,swiftCode:null,currency:'MYR',isPrimary:true,maybankPaymentSettings:null};
const noop=async()=>{};
const actions={saveGeneralTab:async()=>({ok:true,saved:[]}),updateCompany:noop,archiveCompany:noop,deleteCompany:noop,setParent:noop,setStatutory:noop,setStatutoryAuthority:noop,removeStatutoryAuthority:noop,setCompanyLogo:noop,removeCompanyLogo:noop,updateCompanyDefaultCycle:noop,setBankProfile:noop,removeBankProfile:noop};
afterEach(cleanup);
describe('Maybank initial blank arrangement in six locales',()=>{
 for(const [locale,messages]of Object.entries({en,ms,zh,vi:viLocale,ta,th}))it(locale+' renders the approved blank default and separate payee residency',async()=>{
  const errors:unknown[]=[];const {container}=render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Kuala_Lumpur" onError={error=>errors.push(error)}><CompanyPanel company={company} companies={[{id:company.id,name:company.name}]} statutory={null} bankProfiles={[profile]} initialTab="bank" actions={actions as never}/><BankInfoCard action={noop} employmentId="fictional-employment" personId="fictional-person" defaults={{bankName:'Maybank',bankAccountNo:'512345678901',enableCustomHolderName:false,customHolderName:null,enableCustomHolderId:false,customHolderId:null,bankPayeeResidency:null}}/></NextIntlClientProvider>);
  const arrangement=container.querySelector<HTMLSelectElement>('select[name="maybankHashMode"]');expect(arrangement).not.toBeNull();expect(arrangement!.value).toBe('not-required');expect(container.querySelector<HTMLSelectElement>('select[name="maybankVersion"]')?.value).toBe('7.4');expect(container.textContent).toContain(messages.maybankPayment.hashHelp);expect(container.querySelector<HTMLSelectElement>('select[name="bankPayeeResidency"]')?.value).toBe('');expect(errors).toEqual([]);
  await captureAiReviewScreenshots(container.innerHTML,locale,'maybank-settings','Real company and payee components; fictional values; initial blank hash; no bank upload or installed journey');
 },120000);
});
