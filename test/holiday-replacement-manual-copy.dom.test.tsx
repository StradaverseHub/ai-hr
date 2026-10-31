import {render,screen,within} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import {describe,expect,it,vi} from 'vitest';
import type {ButtonHTMLAttributes,FormHTMLAttributes} from 'react';
import messages from '../messages/en.json';
import ReplacementHolidayPage from '../app/(app)/admin/holidays/replacements/page';
import {todayInKualaLumpur} from '../lib/hr-date';
const mocks=vi.hoisted(()=>({review:vi.fn()}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>createTranslator({locale:'en',messages,namespace:'replacementHoliday'})}));
vi.mock('../lib/scope',()=>({scopedAdmin:async()=>({s:{},scopeIds:['fixture-company']})}));
vi.mock('../core/read',()=>({allowedCompanies:async()=>[{id:'fixture-company',name:'Fictional company'}]}));
vi.mock('../core/holiday-replacements',()=>({listReplacementHolidayPolicies:async()=>[]}));
vi.mock('../core/holiday-replacement-read',()=>({replacementHolidayReviewRows:mocks.review,replacementHolidayHistory:async()=>[]}));
vi.mock('../app/(app)/admin/holidays/replacements/actions',()=>({adjustReplacementAction:vi.fn(),saveReplacementPolicyAction:vi.fn()}));
vi.mock('../components/attendance-settings-navigation',()=>({AttendanceSettingsNavigation:()=>null}));
vi.mock('../components/attendance-settings-action-form',()=>({
  AttendanceSettingsActionForm:({submitAction:_,...props}:FormHTMLAttributes<HTMLFormElement>&{submitAction:unknown})=><form {...props}/>,
  AttendanceSettingsSaveButton:(props:ButtonHTMLAttributes<HTMLButtonElement>)=><button {...props}/>,
}));
async function resultCopy(reason:string,manual:boolean,coverageReason:string|null=null){
  const date=todayInKualaLumpur();
  mocks.review.mockResolvedValue({failures:[],rows:[{name:'Fixture holiday employee',employeeCode:'FIX-HOLIDAY',currentSourceDate:date,coverageReason,allocation:{
    id:'fixture-allocation',sourceDate:date,sourceName:'Fictional original holiday',replacementDate:date,proposedDate:null,policyId:null,status:'allocated',reason,manual,
  }}]});
  const page=await ReplacementHolidayPage({searchParams:Promise.resolve({company:'fixture-company'})});
  render(<NextIntlClientProvider locale="en" messages={messages}>{page}</NextIntlClientProvider>);
  const row=screen.getByRole('row',{name:/Fixture holiday employee/});
  const status=coverageReason?messages.replacementHoliday.review:messages.replacementHoliday.allocated;
  const cell=within(row).getByRole('cell',{name:new RegExp('^'+status)});
  const explanation=cell.querySelector('p');expect(explanation).not.toBeNull();
  return explanation!.textContent;
}
describe('replacement holiday manual result copy',()=>{
  it.each(['manual_adjustment','manual_retained'])('%s names the manual decision once',async reason=>{
    expect(await resultCopy(reason,true)).toBe(messages.replacementHoliday.manual);
  });
  it('keeps the specific review reason and one manual marker when coverage needs review',async()=>{
    expect(await resultCopy('manual_adjustment',true,'outside_tenure')).toBe(messages.replacementHoliday.reasonTenure+' · '+messages.replacementHoliday.manual);
  });
  it('keeps the automatic reason without adding a manual marker',async()=>{
    expect(await resultCopy('public_holiday_on_rest',false)).toBe(messages.replacementHoliday.reasonRest);
  });
});
