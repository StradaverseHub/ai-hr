/** Board 4604dccc r4 — the review names the earlier corrections the new one replaces (information only, never a
 * block), and the "Future processing uses these corrected details from {date}" caption is gone in all six locales.
 * Actual components with fictional preview data; the database owner is proven in information-correction-latest-saved. */
vi.mock('../components/derived-organisation-fields',()=>({useDerivedOrganisation:()=>({data:{status:'legacy'},loading:false,failed:false}),DerivedOrganisationFields:()=>null}));
const actions=vi.hoisted(()=>({context:vi.fn(),preview:vi.fn(),save:vi.fn(),upload:vi.fn(),confirm:vi.fn()}));
vi.mock('../app/admin/personnel/information-correction-actions',()=>({informationContextAction:actions.context,previewInformationAction:actions.preview,saveInformationAction:actions.save,previewInformationUploadAction:actions.upload,confirmInformationUploadAction:actions.confirm}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
import {INFORMATION_EXTENDED_FIELDS,type InformationPreview} from '../lib/information-correction';
import {HireCorrectionModes,InformationChangesTable,InformationCorrectionAudit,InformationReplacedCorrections} from '../app/admin/personnel/information-correction-form';
import {InformationCorrectionImport} from '../app/admin/personnel/import/information-correction-import';

const values={...Object.fromEntries(INFORMATION_EXTENDED_FIELDS.map(field=>[field,null])) as Record<typeof INFORMATION_EXTENDED_FIELDS[number],null>,companyId:'co-gamma',hiredOn:'2025-01-02',joinDate:'2025-01-02',gradeId:null,employmentType:'full_time',contractEndDate:null,internshipEndDate:null};
const preview:InformationPreview={effectiveOn:'2025-03-01',employmentId:'fictional-employee',employeeCode:'LS-UI',name:'Fictional Reviewer',fingerprint:'fictional-fingerprint',
 before:values,after:{...values,companyId:'co-alpha'},beforeLabels:{...values,companyId:'Gamma Fictional Sdn Bhd'},afterLabels:{...values,companyId:'Alpha Fictional Sdn Bhd'},reason:'Fictional correction',changed:['companyId'],
 replacedCorrections:[{sequence:41,effectiveOn:'2025-11-01',savedAt:'2026-11-01T02:00:00.000Z',fields:['companyId'],actor:'Fictional Administrator'}]};
const locales={en,ms,zh,ta,th,vi:viMessages};
afterEach(()=>{cleanup();vi.clearAllMocks();});

describe('the review of a correction that replaces earlier ones',()=>{
 it('drops the "effective" caption key from every locale and shows no processing-date sentence',()=>{
  for(const [locale,messages] of Object.entries(locales)){
   expect(messages.people.informationCorrection,locale).not.toHaveProperty('effective');
   const {container,unmount}=render(<NextIntlClientProvider locale={locale} messages={messages}><InformationChangesTable preview={preview}/></NextIntlClientProvider>);
   expect(container.querySelector('caption'),locale).toBeNull();
   expect(container.textContent,locale).not.toContain('2025-03-01');
   expect(container.textContent,locale).toContain(messages.people.informationCorrection.fields.companyId);
   unmount();
  }
  expect(document.body.textContent).not.toMatch(/Future processing/);
 });
 it('lists each replaced correction with its Effective Date, fields, saved time and actor in all six locales',()=>{
  for(const [locale,messages] of Object.entries(locales)){
   const {unmount}=render(<NextIntlClientProvider locale={locale} messages={messages}><InformationReplacedCorrections preview={preview}/></NextIntlClientProvider>);
   const section=screen.getByRole('region',{name:messages.people.informationCorrection.replaced.title});
   const item=within(section).getByRole('listitem');
   expect(item,locale).toHaveAttribute('data-replaced-correction','2025-11-01');
   expect(item.textContent,locale).toContain('2025-11-01');
   expect(item.textContent,locale).toContain(messages.people.informationCorrection.fields.companyId);
   expect(item.textContent,locale).toContain('Fictional Administrator');
   expect(section.textContent,locale).toContain('2025-03-01');
   unmount();
  }
 });
 it('renders nothing when the correction replaces no earlier correction',()=>{
  const {container}=render(<NextIntlClientProvider locale="en" messages={en}><InformationReplacedCorrections preview={{...preview,replacedCorrections:undefined}}/></NextIntlClientProvider>);
  expect(container.textContent).toBe('');
 });
 it('keeps the replaced list informational on the screen review: confirming still saves',async()=>{
  const context={preview:{...preview,changed:[],after:values,today:'2026-11-16',earliestEffectiveOn:'2025-01-02'},options:{companies:[{id:'co-gamma',code:'GAMMA',name:'Gamma Fictional Sdn Bhd'},{id:'co-alpha',code:'ALPHA',name:'Alpha Fictional Sdn Bhd'}],grades:[],employmentTypes:['full_time']},history:[]};
  actions.context.mockResolvedValue(context);actions.preview.mockResolvedValue(preview);actions.save.mockResolvedValue({changed:true});
  render(<NextIntlClientProvider locale="en" messages={en}><HireCorrectionModes employmentId={preview.employmentId}><p>Existing correction form</p></HireCorrectionModes></NextIntlClientProvider>);
  fireEvent.click(screen.getByRole('radio',{name:en.people.informationCorrection.title}));
  fireEvent.change(await screen.findByLabelText(en.people.informationCorrection.fields.companyId),{target:{value:'co-alpha'}});
  fireEvent.change(screen.getByLabelText(en.people.informationCorrection.reason),{target:{value:preview.reason}});
  fireEvent.click(screen.getByRole('button',{name:en.people.informationCorrection.review}));
  expect(await screen.findByRole('region',{name:en.people.informationCorrection.replaced.title})).toBeInTheDocument();
  expect(screen.queryByText(/Future processing/)).toBeNull();
  const confirm=screen.getByRole('button',{name:en.people.informationCorrection.confirm});
  expect(confirm).toBeEnabled();
  fireEvent.click(confirm);
  await vi.waitFor(()=>expect(actions.save).toHaveBeenCalledTimes(1));
 });
 it('shows the replaced corrections on each Excel row review',async()=>{
  actions.upload.mockResolvedValue({attemptId:'fictional-attempt',plan:{version:1,previewHash:'checked',counts:{total:1,valid:1,invalid:0},issues:[],rows:[{row:2,companyCode:'GAMMA',employeeCode:'LS-UI',values:{},errors:[],preview}]}});
  render(<NextIntlClientProvider locale="en" messages={en}><InformationCorrectionImport onCommitPendingChange={()=>{}}/></NextIntlClientProvider>);
  fireEvent.change(screen.getByLabelText(en.people.informationCorrection.file),{target:{files:[new File(['fixture'],'corrections.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})]}});
  fireEvent.submit(screen.getByRole('button',{name:'Validate file'}).closest('form')!);
  const section=await screen.findByRole('region',{name:en.people.informationCorrection.replaced.title});
  expect(within(section).getByRole('listitem')).toHaveAttribute('data-replaced-correction','2025-11-01');
 });
 it('keeps the Effective Date in the correction history without the caption',()=>{
  const history=[{id:'fictional-event',at:new Date('2026-11-01T02:00:00Z'),actorId:'fictional-actor',actorName:'Fictional Administrator',payload:{beforeLabels:preview.beforeLabels,afterLabels:preview.afterLabels,fields:['companyId'],reason:'Fictional correction',method:'manual',effectiveOn:'2025-11-01'}}];
  const {container}=render(<NextIntlClientProvider locale="en" messages={en}><InformationCorrectionAudit history={history as Parameters<typeof InformationCorrectionAudit>[0]['history']}/></NextIntlClientProvider>);
  expect(container.querySelector('caption')).toBeNull();
  expect(container.textContent).toContain(`${en.people.informationCorrection.effectiveDate}: 2025-11-01`);
 });
});

describe('correction audit payload compatibility',()=>{
 it('renders an unlabeled legacy correction without crashing and never substitutes undefined values',()=>{
  const history=[{id:'legacy-hire',at:new Date('2026-11-17T02:00:00Z'),actorId:'actor',actorName:'Fictional Administrator',payload:{source:'original-hire',fields:['companyId','hiredOn'],before:{companyId:'hidden-id',hiredOn:'2026-01-01'},after:{companyId:'hidden-id-2',hiredOn:'2025-12-01'},reason:'Original hire correction',method:'manual',effectiveOn:'2025-12-01'}}];
  const {container}=render(<NextIntlClientProvider locale="en" messages={en}><InformationCorrectionAudit history={history as Parameters<typeof InformationCorrectionAudit>[0]['history']}/></NextIntlClientProvider>);
  expect(container.textContent).toContain('Original hire correction');
  expect(container.textContent).not.toContain('hidden-id');
  expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
 });
 it('renders original-hire scalar fields with their existing translated labels',()=>{
  const history=[{id:'original-scalars',at:new Date('2026-11-17T02:00:00Z'),actorId:'actor',actorName:null,payload:{fields:['contractStartDate','extendedConfirmationDate','lastWorkingDate'],beforeLabels:{contractStartDate:null,extendedConfirmationDate:null,lastWorkingDate:null},afterLabels:{contractStartDate:'2026-01-01',extendedConfirmationDate:'2026-04-01',lastWorkingDate:null},reason:'Fictional original dates',method:'manual',effectiveOn:'2026-01-01'}}];
  render(<NextIntlClientProvider locale="en" messages={en}><InformationCorrectionAudit history={history as Parameters<typeof InformationCorrectionAudit>[0]['history']}/></NextIntlClientProvider>);
  fireEvent.click(screen.getByText(en.people.informationCorrection.history));
  expect(screen.getByRole('rowheader',{name:'Contract Start Date'})).toBeInTheDocument();
  expect(screen.getByRole('rowheader',{name:'Extended confirmation date'})).toBeInTheDocument();
  expect(screen.getByRole('rowheader',{name:'Last Working Date'})).toBeInTheDocument();
 });
});
