/** AI v2 Phase 1, slice 3 — the rendered screens of employee letter requests, in each role they serve, with the real
 * English catalogue: the employee's My Letters (their requests, "Request a letter" and its form); HR's
 * requests list on the generate page, "Prepare letter" opening the generate flow fixed to the employee, and "Employees may
 * request" in letter settings. The owner services are stubbed with fictional results; their rules are proved on the
 * database by test/letter-requests.test.ts. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';

const svc=vi.hoisted(()=>({mine:vi.fn(),requestable:vi.fn(),staff:vi.fn(),one:vi.fn(),options:vi.fn(),letters:vi.fn(),access:vi.fn(),templates:vi.fn(),batches:vi.fn(),
 template:vi.fn(),policies:vi.fn(),assets:vi.fn(),session:{current:{} as Record<string,unknown>,scope:null as string[]|null}}));
vi.mock('next/link',()=>({default:({children,prefetch:_prefetch,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('NOT_FOUND');},redirect:(url:string)=>{throw new Error('REDIRECT:'+url);},usePathname:()=>'/me/letters',
 useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async(namespace:any)=>createTranslator({locale:'en',messages:en as never,namespace})}));
vi.mock('../lib/authz',()=>({requireModule:async()=>({})}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:svc.session.current,scopeIds:svc.session.scope??[COMPANY],allowedCount:1})}));
vi.mock('../core/letters',()=>({listMyLetters:svc.letters,letterCompanyAccess:svc.access,listLetterTemplates:svc.templates,listLetterGenerationBatches:svc.batches,
 getLetterTemplate:svc.template,getStaffLetter:vi.fn(),listLetterPolicies:svc.policies,listLetterSettingAssets:svc.assets}));
vi.mock('../core/letter-requests',()=>({LETTER_REQUEST_LIMITS:{purposeChars:300,reasonChars:500,list:50,options:200},listMyLetterRequests:svc.mine,
 listRequestableLetterTypes:svc.requestable,listLetterRequestsForStaff:svc.staff,getLetterRequestForStaff:svc.one,listLetterRequestOptions:svc.options}));
vi.mock('../app/me/letters/actions',()=>({openMyLetter:vi.fn(),confirmMyLetter:vi.fn(),requestLetterAction:vi.fn()}));
vi.mock('../app/letters/generate/actions',()=>({createGeneration:vi.fn(),updateGeneration:vi.fn(),declineLetterRequestAction:vi.fn()}));
vi.mock('../app/letters/settings/actions',()=>({savePolicySettings:vi.fn(),uploadLetterAsset:vi.fn()}));
vi.mock('../app/letters/settings/request-actions',()=>({saveLetterRequestOptionsAction:vi.fn()}));
import MyLettersPage from '../app/me/letters/page';
import GeneratePage from '../app/letters/generate/page';
import NewGenerationPage from '../app/letters/generate/new/page';
import SettingsPage from '../app/letters/settings/page';

const COMPANY='00000000-0000-4000-8000-00000000c0aa',TEMPLATE='00000000-0000-4000-8000-0000000000e1',SALARY='00000000-0000-4000-8000-0000000000e2';
const VERSION='00000000-0000-4000-8000-0000000000f1',EMPLOYMENT='00000000-0000-4000-8000-0000000000a1',REQUEST='00000000-0000-4000-8000-0000000000b1';
const LETTER='00000000-0000-4000-8000-0000000000d1',SECOND='00000000-0000-4000-8000-0000000000b2';
const employee={tenantId:'00000000-0000-4000-8000-0000000000aa',userId:'00000000-0000-4000-8000-0000000000bb',roles:['employee'],grants:[{role:'employee',companyId:null}]};
const hrAdmin={...employee,userId:'00000000-0000-4000-8000-0000000000ad',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:COMPANY}]};
const copy=en.letters.mine.requests,staffCopy=en.letters.generate.requests,settingsCopy=en.letters.settings.requests;
const ASKED=new Date('2026-11-02T02:00:00Z');
const type=(over:Record<string,unknown>={})=>({employmentId:EMPLOYMENT,companyId:COMPANY,companyName:'Fictional Sdn Bhd',templateId:TEMPLATE,name:'Employment Confirmation Letter',...over});
const own=(over:Record<string,unknown>={})=>({id:REQUEST,letterTypeName:'Employment Confirmation Letter',purpose:null,status:'requested',createdAt:ASKED,statusChangedAt:ASKED,letterId:null,...over});
const staff=(over:Record<string,unknown>={})=>({id:REQUEST,companyId:COMPANY,employmentId:EMPLOYMENT,templateId:TEMPLATE,letterTypeName:'Employment Confirmation Letter',
 purpose:'Fictional housing loan',status:'requested',createdAt:ASKED,statusChangedAt:ASKED,letterId:null,declineReason:null,version:1,employeeName:'Aina Fictional',
 employeeCode:'LR-0001',publishedVersionId:VERSION,...over});

beforeEach(()=>{
 vi.clearAllMocks();svc.session.current=employee;svc.session.scope=null;
 svc.letters.mockResolvedValue({rows:[],nextCursor:null});svc.mine.mockResolvedValue([]);svc.requestable.mockResolvedValue([]);
 svc.access.mockResolvedValue([{id:COMPANY,name:'Fictional Sdn Bhd',read:true,generate:true,settings:true,approve:false}]);
 svc.templates.mockResolvedValue({rows:[],nextCursor:null});svc.batches.mockResolvedValue({rows:[],nextCursor:null});svc.staff.mockResolvedValue([]);
 svc.policies.mockResolvedValue({rows:[],nextCursor:null});svc.assets.mockResolvedValue({rows:[],nextCursor:null});svc.options.mockResolvedValue([]);
 svc.template.mockResolvedValue({root:{id:TEMPLATE,companyId:COMPANY,code:'EMPCONF',deactivated:false},version:{id:VERSION,name:'Employment Confirmation Letter',category:'confirmation',ordinal:1},
  fields:[],appearance:{letterhead_name:null,signatory_name:null}});
});
afterEach(cleanup);

describe('My Letters (employee)',()=>{
 it('shows the person\'s own requests with their status, opens an issued one, and offers "Request a letter" only when a type is open',async()=>{
  svc.mine.mockResolvedValue([own(),own({id:SECOND,letterTypeName:'Salary Confirmation Letter',status:'issued',letterId:LETTER})]);
  svc.requestable.mockResolvedValue([type()]);
  render(await MyLettersPage({searchParams:Promise.resolve({notice:'requested'})}));
  expect(screen.getByRole('status').textContent).toBe(copy.sent);
  const request=screen.getByRole('link',{name:copy.request});
  expect(request.getAttribute('href')).toBe('/me/letters?request=1#request-letter');expect(request.className).toContain('min-h-11');
  // The form opens only when asked for.
  expect(screen.queryByRole('region',{name:copy.formTitle})).toBeNull();
  const section=screen.getByRole('region',{name:copy.title});
  const cards=[...section.querySelectorAll<HTMLElement>('[data-letter-request]')];
  expect(cards.map(card=>[card.getAttribute('data-letter-request'),card.querySelector('p')?.textContent])).toEqual([['requested','Employment Confirmation Letter'],['issued','Salary Confirmation Letter']]);
  expect(within(cards[0]).getByText(copy.status.requested)).toBeTruthy();
  expect(within(cards[0]).queryByRole('link')).toBeNull();
  expect(within(cards[1]).getByRole('link',{name:copy.openLetter}).getAttribute('href')).toBe('/me/letters/'+LETTER);
  expect(svc.mine).toHaveBeenCalledExactlyOnceWith(employee);
 });
 it('offers no request button when the company opened no letter type, and keeps the letters list when requests fail',async()=>{
  svc.mine.mockRejectedValue(new Error('Fictional outage'));
  render(await MyLettersPage({searchParams:Promise.resolve({})}));
  expect(screen.queryByRole('link',{name:copy.request})).toBeNull();
  expect(screen.getByRole('note').textContent).toBe(copy.unavailable);
  expect(screen.getByText(en.letters.mine.empty)).toBeTruthy();
 });
});

describe('Request a letter (employee)',()=>{
 it('lists only the letter types the person may request, preselects the chat card\'s type, and takes an optional purpose',async()=>{
  svc.requestable.mockResolvedValue([type(),type({templateId:SALARY,name:'Salary Confirmation Letter'})]);
  render(await MyLettersPage({searchParams:Promise.resolve({request:'1',template:SALARY})}));
  const form=screen.getByRole('region',{name:copy.formTitle});
  expect(within(form).getByText(copy.formDescription)).toBeTruthy();
  const select=within(form).getByLabelText(copy.type) as HTMLSelectElement;
  expect([...select.options].map(option=>[option.value,option.textContent])).toEqual([['',copy.choose],[EMPLOYMENT+'.'+TEMPLATE,'Employment Confirmation Letter'],[EMPLOYMENT+'.'+SALARY,'Salary Confirmation Letter']]);
  expect(select.value).toBe(EMPLOYMENT+'.'+SALARY);expect(select.required).toBe(true);
  const purpose=within(form).getByLabelText(copy.purpose) as HTMLTextAreaElement;
  expect(purpose.required).toBe(false);expect(purpose.maxLength).toBe(300);
  expect(within(form).getByText(copy.purposeHelp)).toBeTruthy();
  const send=within(form).getByRole('button',{name:copy.submit});expect(send.className).toContain('pointer-coarse:min-h-11');
  expect(send.closest('form')).toBe(select.closest('form'));
  expect(within(form).getByRole('link',{name:copy.cancel}).getAttribute('href')).toBe('/me/letters');
  // While the form is open the header button is not repeated.
  expect(screen.queryByRole('link',{name:copy.request})).toBeNull();
 });
 it('names the company when the person has employments in two, ignores an unknown preselection, and shows the error it was sent back with',async()=>{
  svc.requestable.mockResolvedValue([type(),type({employmentId:'00000000-0000-4000-8000-0000000000a2',companyId:'00000000-0000-4000-8000-00000000c0bb',companyName:'Fictional Bhd Two'})]);
  render(await MyLettersPage({searchParams:Promise.resolve({request:'1',template:'not-a-template',requestError:'duplicate'})}));
  const select=screen.getByLabelText(copy.type) as HTMLSelectElement;
  expect([...select.options].slice(1).map(option=>option.textContent)).toEqual(['Employment Confirmation Letter (Fictional Sdn Bhd)','Employment Confirmation Letter (Fictional Bhd Two)']);
  expect(select.value).toBe('');
  expect(screen.getByRole('alert').textContent).toBe(copy.errors.duplicate);
 });
 it('has no form when the company opened no letter type',async()=>{
  render(await MyLettersPage({searchParams:Promise.resolve({request:'1'})}));
  expect(screen.getByRole('note').textContent).toBe(copy.none);
  expect(screen.queryByRole('button',{name:copy.submit})).toBeNull();
 });
});

describe('Letter requests on the generate page (HR holding generate)',()=>{
 beforeEach(()=>{svc.session.current=hrAdmin;});
 it('lists the company\'s open requests with who asked and why, "Prepare letter" into the generate flow and "Decline" with a reason',async()=>{
  svc.staff.mockResolvedValue([staff(),staff({id:SECOND,status:'in_progress',letterId:LETTER,purpose:null,publishedVersionId:null,employeeName:'Badrul Fictional',employeeCode:null})]);
  render(await GeneratePage({searchParams:Promise.resolve({companyId:COMPANY})}));
  const section=screen.getByRole('region',{name:staffCopy.title});
  const [first,second]=[...section.querySelectorAll<HTMLElement>('[data-letter-request]')];
  expect(within(first).getByRole('heading',{name:'Employment Confirmation Letter'})).toBeTruthy();
  expect(first.textContent).toContain(staffCopy.employee+': Aina Fictional · LR-0001');
  expect(first.textContent).toContain(staffCopy.purpose+': Fictional housing loan');
  expect(within(first).getByRole('link',{name:staffCopy.prepare}).getAttribute('href')).toBe(`/letters/generate/new?versionId=${VERSION}&requestId=${REQUEST}`);
  const reason=within(first).getByLabelText(staffCopy.declineReason) as HTMLTextAreaElement;
  expect(reason.required).toBe(true);expect(reason.maxLength).toBe(500);
  const form=reason.closest('form')!;
  expect(Object.fromEntries([...form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map(input=>[input.name,input.value]))).toEqual({companyId:COMPANY,requestId:REQUEST,expectedVersion:'1'});
  expect(within(first).getByRole('button',{name:staffCopy.declineSubmit,hidden:true})).toBeTruthy();
  expect(within(first).getByText(staffCopy.declineHelp)).toBeTruthy();
  // In preparation, with the template no longer published: no Prepare link, still declinable.
  expect(within(second).getByText(staffCopy.status.in_progress)).toBeTruthy();expect(within(second).getByText(staffCopy.inProgress)).toBeTruthy();
  expect(within(second).queryByRole('link',{name:staffCopy.prepare})).toBeNull();expect(within(second).getByText(staffCopy.prepareUnavailable)).toBeTruthy();
  expect(second.textContent).toContain(staffCopy.employee+': Badrul Fictional');
  expect(svc.staff).toHaveBeenCalledExactlyOnceWith(hrAdmin,{companyId:COMPANY});
 });
 it('from Today (requests=all): the waiting requests of every company the user handles, each naming its company, oldest first',async()=>{
  const OTHER='00000000-0000-4000-8000-00000000c0bb',THIRD='00000000-0000-4000-8000-0000000000b3';
  svc.session.scope=[COMPANY,OTHER];
  svc.access.mockResolvedValue([{id:COMPANY,name:'Fictional Sdn Bhd',read:true,generate:true,settings:true,approve:false},
   {id:OTHER,name:'Fictional Other Sdn Bhd',read:true,generate:true,settings:false,approve:false}]);
  svc.staff.mockImplementation(async(_s:unknown,input:{companyId:string})=>input.companyId===COMPANY?[staff()]
   :[staff({id:THIRD,companyId:OTHER,createdAt:new Date('2026-11-01T02:00:00Z'),employeeName:'Chong Fictional',employeeCode:null,purpose:null})]);
  render(await GeneratePage({searchParams:Promise.resolve({requests:'all'})}));
  expect(svc.staff.mock.calls.map(call=>call[1])).toEqual([{companyId:COMPANY},{companyId:OTHER}]);
  const rows=[...screen.getByRole('region',{name:staffCopy.title}).querySelectorAll<HTMLElement>('[data-letter-request]')];
  expect(rows.map(row=>row.querySelector('[data-letter-request-company]')?.textContent)).toEqual(['Company: Fictional Other Sdn Bhd','Company: Fictional Sdn Bhd']);
  expect(rows[0].textContent).toContain(staffCopy.employee+': Chong Fictional');
  // Decline names the request's own company and returns to the same list.
  const hidden=(row:HTMLElement)=>Object.fromEntries([...row.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map(input=>[input.name,input.value]));
  expect(hidden(rows[0])).toEqual({companyId:OTHER,requestId:THIRD,expectedVersion:'1',requests:'all'});
  expect(hidden(rows[1])).toEqual({companyId:COMPANY,requestId:REQUEST,expectedVersion:'1',requests:'all'});
  cleanup();
  // Without it, the page keeps the one company's list and names no company.
  svc.staff.mockClear();
  render(await GeneratePage({searchParams:Promise.resolve({companyId:OTHER})}));
  expect(svc.staff.mock.calls.map(call=>call[1])).toEqual([{companyId:OTHER}]);
  expect(screen.getByRole('region',{name:staffCopy.title}).querySelector('[data-letter-request-company]')).toBeNull();
 });
 it('says when nothing is waiting, when the list is unavailable, and what a decline did',async()=>{
  render(await GeneratePage({searchParams:Promise.resolve({companyId:COMPANY,requestNotice:'declined'})}));
  expect(within(screen.getByRole('region',{name:staffCopy.title})).getByText(staffCopy.empty)).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe(staffCopy.declined);
  cleanup();svc.staff.mockRejectedValue(new Error('Fictional outage'));
  render(await GeneratePage({searchParams:Promise.resolve({companyId:COMPANY,requestError:'stale'})}));
  expect(within(screen.getByRole('region',{name:staffCopy.title})).getByRole('note').textContent).toBe(staffCopy.unavailable);
  expect(screen.getByRole('alert').textContent).toBe(staffCopy.errors.stale);
 });
 it('"Prepare letter" opens the generate flow fixed to the request\'s employee and carries the request; another template or a handled request is not found',async()=>{
  svc.one.mockResolvedValue(staff());
  render(await NewGenerationPage({searchParams:Promise.resolve({versionId:VERSION,requestId:REQUEST})}));
  expect(screen.getByText(staffCopy.preparing.replace('{type}','Employment Confirmation Letter'))).toBeTruthy();
  expect(screen.getByText('Aina Fictional · LR-0001')).toBeTruthy();
  expect(document.querySelector<HTMLInputElement>('input[name="employmentId"]')!.value).toBe(EMPLOYMENT);
  expect(document.querySelector<HTMLInputElement>('input[name="requestId"]')!.value).toBe(REQUEST);
  expect(screen.queryByRole('button',{name:'Find'})).toBeNull();
  cleanup();svc.one.mockResolvedValue(staff({templateId:SALARY}));
  await expect(NewGenerationPage({searchParams:Promise.resolve({versionId:VERSION,requestId:REQUEST})})).rejects.toThrow('NOT_FOUND');
  svc.one.mockResolvedValue(staff({status:'declined'}));
  await expect(NewGenerationPage({searchParams:Promise.resolve({versionId:VERSION,requestId:REQUEST})})).rejects.toThrow('NOT_FOUND');
  svc.one.mockResolvedValue(null);
  await expect(NewGenerationPage({searchParams:Promise.resolve({versionId:VERSION,requestId:REQUEST})})).rejects.toThrow('NOT_FOUND');
 });
});

describe('Employees may request, in letter settings (HR holding settings)',()=>{
 beforeEach(()=>{svc.session.current=hrAdmin;});
 it('lists every published template with its own box, ticked only where it is on, in one form',async()=>{
  svc.options.mockResolvedValue([{templateId:TEMPLATE,code:'EMPCONF',name:'Employment Confirmation Letter',requestable:true},{templateId:SALARY,code:'SALARY',name:'Salary Confirmation Letter',requestable:false}]);
  render(await SettingsPage({searchParams:Promise.resolve({companyId:COMPANY,requestOptions:'saved'})}));
  const allow=screen.getByRole('checkbox',{name:new RegExp(settingsCopy.allow.replace('{name}','Employment Confirmation Letter'))}) as HTMLInputElement;
  const salary=screen.getByRole('checkbox',{name:new RegExp(settingsCopy.allow.replace('{name}','Salary Confirmation Letter'))}) as HTMLInputElement;
  expect([allow.checked,salary.checked]).toEqual([true,false]);expect([allow.value,salary.value]).toEqual([TEMPLATE,SALARY]);
  const form=allow.closest('form')!;expect(salary.closest('form')).toBe(form);
  expect([...form.querySelectorAll<HTMLInputElement>('input[name="templateId"]')].map(input=>input.value)).toEqual([TEMPLATE,SALARY]);
  expect(within(form).getByRole('button',{name:settingsCopy.save})).toBeTruthy();
  expect(screen.getByText(settingsCopy.saved)).toBeTruthy();
  expect(svc.options).toHaveBeenCalledExactlyOnceWith(hrAdmin,COMPANY);
 });
 it('is not shown to a user who only manages their own signature',async()=>{
  svc.access.mockResolvedValue([{id:COMPANY,name:'Fictional Sdn Bhd',read:false,generate:false,settings:false,approve:true}]);
  render(await SettingsPage({searchParams:Promise.resolve({companyId:COMPANY})}));
  expect(screen.queryByRole('heading',{name:settingsCopy.title})).toBeNull();expect(svc.options).not.toHaveBeenCalled();
 });
});
