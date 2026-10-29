/** Actual components and CSS; command authorization and database integrity live in the native companion suite. */
import {afterEach,describe,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {page} from 'vitest/browser';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
import type {InformationPreview} from '../lib/information-correction';
import '../app/globals.css';
import '../app/atelier.css';
const actions=vi.hoisted(()=>({context:vi.fn(),preview:vi.fn(),save:vi.fn(),upload:vi.fn(),confirm:vi.fn(),refresh:vi.fn()}));
vi.mock('../app/admin/personnel/information-correction-actions',()=>({informationContextAction:actions.context,previewInformationAction:actions.preview,saveInformationAction:actions.save,previewInformationUploadAction:actions.upload,confirmInformationUploadAction:actions.confirm}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:actions.refresh})}));
const {HireCorrectionModes,InformationChangesTable}=await import('../app/admin/personnel/information-correction-form');
const {InformationCorrectionImport}=await import('../app/admin/personnel/import/information-correction-import');
const values={companyId:'co-a',hiredOn:'2025-01-15',joinDate:'2025-01-15',gradeId:null,employmentType:'full_time'};
const preview:InformationPreview={effectiveOn:'2026-10-30',employmentId:'synthetic-employee',employeeCode:'EMP-001',name:'Aisha Fixture',fingerprint:'review-fingerprint',before:values,after:{...values,hiredOn:'2025-01-01'},beforeLabels:{...values,companyId:'DEMO · Demo Company'},afterLabels:{...values,companyId:'DEMO · Demo Company',hiredOn:'2025-01-01'},reason:'Correct signed employment record',changed:['hiredOn']};
const context=()=>({preview:{...preview,changed:[],after:values},options:{companies:[{id:'co-a',code:'DEMO',name:'Demo Company'}],grades:[],employmentTypes:['full_time','part_time']},history:[]});
afterEach(()=>{cleanup();vi.clearAllMocks();document.documentElement.removeAttribute('data-ui-theme');document.documentElement.classList.remove('dark');});
it('requires a reason and an explicit before/after confirmation before saving the manual correction',async()=>{
 await page.viewport(1280,900);
 actions.context.mockResolvedValue(context());actions.preview.mockResolvedValue(preview);actions.save.mockImplementation(async()=>{actions.context.mockResolvedValue({...context(),preview:{...context().preview,before:preview.after}});return{changed:true};});
 render(<NextIntlClientProvider locale="en" messages={en}><HireCorrectionModes employmentId={preview.employmentId}><p>Existing correction form</p></HireCorrectionModes></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('radio',{name:en.people.informationCorrection.title}));
 const field=await screen.findByLabelText('Group Join Date');fireEvent.change(field,{target:{value:'2025-01-01'}});
 expect(screen.getByRole('button',{name:'Review corrections'})).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Correction reason'),{target:{value:preview.reason}});
 fireEvent.click(screen.getByRole('button',{name:'Review corrections'}));
 expect(await screen.findByText('2025-01-15')).toBeVisible();expect(screen.getByText('2025-01-01')).toBeVisible();expect(actions.save).not.toHaveBeenCalled();
 console.info('Manual review:',await page.screenshot({path:'../.vitest-attachments/information-only-manual-review.png'}));
 fireEvent.click(screen.getByRole('button',{name:'Confirm information-only correction'}));
 await waitFor(()=>expect(actions.save).toHaveBeenCalledWith({employmentId:preview.employmentId,changes:{hiredOn:'2025-01-01'},reason:preview.reason,fingerprint:preview.fingerprint}));
 expect(await screen.findByText(en.people.informationCorrection.saved)).toBeVisible();
});
it('shows Excel row errors before confirmation and displays durable batch results',async()=>{
 actions.upload.mockResolvedValue({attemptId:'attempt-fixture',plan:{version:1,previewHash:'checked',counts:{total:2,valid:1,invalid:1},issues:[],rows:[{row:2,companyCode:'DEMO',employeeCode:'EMP-001',values:{},errors:[],preview},{row:3,companyCode:'DEMO',employeeCode:'MISSING',values:{},errors:['Employee ID is unavailable.']}]}});
 actions.confirm.mockResolvedValue({attemptId:'attempt-fixture',succeeded:1,failed:1,unchanged:0,rows:[{row:2,status:'applied',errors:[]},{row:3,status:'failed',errors:['Employee ID is unavailable.']}]});
 render(<NextIntlClientProvider locale="en" messages={en}><InformationCorrectionImport onCommitPendingChange={()=>{}}/></NextIntlClientProvider>);
 const file=new File(['fixture'],'corrections.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
 fireEvent.change(screen.getByLabelText(en.people.informationCorrection.file),{target:{files:[file]}});
 fireEvent.submit(screen.getByRole('button',{name:'Validate file'}).closest('form')!);
 expect(await screen.findByText('Employee ID is unavailable.')).toBeVisible();expect(actions.confirm).not.toHaveBeenCalled();
 console.info('Excel review:',await page.screenshot({path:'../.vitest-attachments/information-only-excel-review.png'}));
 fireEvent.click(screen.getByRole('button',{name:'Confirm 1 valid correction'}));
 expect(await screen.findByText('1 successful · 1 failed · 0 unchanged')).toBeVisible();expect(screen.getByRole('link',{name:'View import batch history'})).toHaveAttribute('href','/admin/personnel/import/history/attempt-fixture');
});
describe('correction review layout in the six locales and three themes',()=>{
 for(const [locale,messages] of Object.entries({en,ms,zh,ta,th,vi:viMessages}))for(const theme of ['classic','monolith','atelier'])for(const dark of [false,true])it(`${locale} ${theme} ${dark?'dark':'light'} contains its table at mobile width`,async()=>{
  await page.viewport(390,844);document.documentElement.setAttribute('data-ui-theme',theme);document.documentElement.classList.toggle('dark',dark);
  render(<NextIntlClientProvider locale={locale} messages={messages}><main className="max-w-full bg-background p-4 text-foreground"><h1 className="mb-4 text-xl font-semibold">{messages.people.informationCorrection.title}</h1><InformationChangesTable preview={preview}/><p className="mt-4 text-sm">{messages.people.informationCorrection.protection}</p></main></NextIntlClientProvider>);
  expect(screen.getByText(messages.people.informationCorrection.fields.hiredOn)).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  if(locale==='en')console.info('Correction layout:',await page.screenshot({path:`../.vitest-attachments/information-correction-${theme}-${dark?'dark':'light'}.png`}));
 });
});
