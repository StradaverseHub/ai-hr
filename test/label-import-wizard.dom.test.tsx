import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viLocale from '../messages/vi.json';
import {SystemLabelImport} from '../components/system-label-import';
const mocks=vi.hoisted(()=>({fetch:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh})}));
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('fetch',mocks.fetch);});
const rows=[{sheet:'division',row:2,values:{Code:'NEW',Label:'New label'},after:{Code:'NEW',Label:'New label'},before:null,outcome:'add',selected:true,message:'Valid new code.'},{sheet:'department',row:3,values:{Code:'EXISTING'},after:{Code:'EXISTING'},before:null,outcome:'error',selected:false,reason:'existing',message:'This code already exists.'}];
const response=(data:unknown)=>({headers:new Headers({'Content-Type':'application/json'}),json:async()=>data});
const locales=[['en',en],['ms',ms],['zh',zh],['ta',ta],['th',th],['vi',viLocale]] as const;
function mount(locale:string='en',messages:Record<string,unknown>=en){return render(<NextIntlClientProvider locale={locale} messages={messages} onError={error=>{throw error;}}><SystemLabelImport/></NextIntlClientProvider>);}
async function upload(user:ReturnType<typeof userEvent.setup>,name='fictional.xls'){
 await user.click(screen.getByRole('button',{name:en.admin.systemLabels.excel.import}));
 await user.upload(screen.getByLabelText(en.labelsImportWizard.upload),new File(['fictional workbook'],name));
}
describe('three-step new-code import wizard',()=>{
 it.each(locales)('renders Upload, mixed Check and Done with real translations in %s',async(locale,messages)=>{
  const user=userEvent.setup();mount(locale,messages);const w=messages.labelsImportWizard;
  await user.click(screen.getByRole('button',{name:messages.admin.systemLabels.excel.import}));
  const dialog=screen.getByRole('dialog',{name:w.title});expect(within(dialog).getByText(w.warning)).toBeVisible();expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
  expect(within(dialog).getByRole('link',{name:messages.labelExcelRoundTrip.blank})).toHaveAttribute('href','/admin/settings/system-labels/template');
  await user.upload(within(dialog).getByLabelText(w.upload),new File(['fictional'],'fictional.xls'));
  mocks.fetch.mockResolvedValueOnce(response({ok:true,preview:{token:'source-bound-token',mode:'add',valid:true,rows}}));
  await user.click(within(dialog).getByRole('button',{name:w.check}));
  expect(await within(dialog).findByText(w.existing)).toBeVisible();expect(within(dialog).getByText(w.ready.replace('{count}','1'))).toBeVisible();
  expect(within(dialog).queryByText('Current values')).not.toBeInTheDocument();
  mocks.fetch.mockResolvedValueOnce(response({ok:true,summary:{imported:1,updated:0,skipped:1,failed:0}}));
  await user.click(within(dialog).getByRole('button',{name:w.importCount.replace('{count}','1')}));
  expect(await within(dialog).findByText(w.summary.replace('{created}','1').replace('{skipped}','1'))).toBeVisible();expect(mocks.refresh).toHaveBeenCalledOnce();
  const body=mocks.fetch.mock.calls[1][1].body as FormData;expect(body.get('operation')).toBe('apply');expect(body.get('token')).toBe('source-bound-token');expect(body.has('mode')).toBe(false);expect(body.has('confirmUpdates')).toBe(false);
 });
 it.each(locales)('localizes ordinary validation refusals in %s without displaying server English',async(locale,messages)=>{
  const user=userEvent.setup();mount(locale,messages);const w=messages.labelsImportWizard;
  await user.click(screen.getByRole('button',{name:messages.admin.systemLabels.excel.import}));await user.upload(screen.getByLabelText(w.upload),new File(['fictional'],'invalid.xlsx'));
  const reasons=['unsupportedCategory','invalidCompany','invalidCriteria','invalidCriteriaCompany','globalAdminRequired','criteriaCompaniesRequired','invalidHeadEmployee','wholeNumber','invalidGradeCode','gradeLabelExists','invalidGradeReferences','gradeAlreadyGrouped','invalidRow'] as const;
  const invalid=[...reasons.map((reason,index)=>({...rows[1],row:index+2,reason,message:'SERVER_ENGLISH_MUST_NOT_RENDER'})),...(['Code','Company','Description','Label','Name'] as const).map((reasonField,index)=>({...rows[1],row:index+30,reason:'required',reasonField,message:'SERVER_ENGLISH_MUST_NOT_RENDER'}))];
  mocks.fetch.mockResolvedValueOnce(response({ok:true,preview:{token:'invalid-locales',valid:false,rows:invalid}}));await user.click(screen.getByRole('button',{name:w.check}));
  expect(await screen.findByText(w.invalidCompany)).toBeVisible();for(const reason of reasons)expect(screen.getByText(w[reason])).toBeVisible();
  for(const field of ['Code','Company','Description','Label','Name'] as const)expect(screen.getByText(w.required.replace('{field}',w.fields[field]))).toBeVisible();
  expect(screen.queryByText('SERVER_ENGLISH_MUST_NOT_RENDER')).not.toBeInTheDocument();expect(screen.getByRole('button',{name:w.importCount.replace('{count}','0')})).toBeDisabled();
 });
 it('keeps all-blocked rows read-only and disables import; Escape closes and restores the trigger',async()=>{
  const user=userEvent.setup();mount();await upload(user);
  mocks.fetch.mockResolvedValueOnce(response({ok:true,preview:{token:'blocked',valid:false,rows:[rows[1]]}}));
  await user.click(screen.getByRole('button',{name:en.labelsImportWizard.check}));
  expect(await screen.findByText(en.labelsImportWizard.allBlocked)).toBeVisible();expect(screen.getByRole('button',{name:'Import 0 new codes'})).toBeDisabled();
  expect(screen.getByRole('button',{name:en.labelsImportWizard.errorReport})).toBeEnabled();
  await user.keyboard('{Escape}');expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(screen.getByRole('button',{name:en.admin.systemLabels.excel.import})).toHaveFocus();expect(mocks.fetch).toHaveBeenCalledOnce();
 });
 it('preserves the file after a failed confirmation and requires a fresh preview before retry',async()=>{
  const user=userEvent.setup();mount();await upload(user,'preserved.xlsx');
  mocks.fetch.mockResolvedValueOnce(response({ok:true,preview:{token:'t',valid:true,rows}}));await user.click(screen.getByRole('button',{name:en.labelsImportWizard.check}));await screen.findByText(en.labelsImportWizard.existing);
  mocks.fetch.mockResolvedValueOnce(response({ok:false,message:'Fixture writer failure; no additions saved.'}));await user.click(screen.getByRole('button',{name:'Import 1 new codes'}));
  expect(await screen.findByText('Fixture writer failure; no additions saved.')).toBeVisible();expect(screen.getByRole('button',{name:en.labelsImportWizard.checkAgain})).toBeEnabled();expect(screen.queryByText('1 new codes created · 1 rows skipped')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:en.labelsImportWizard.back}));expect(screen.getByText(/preserved.xlsx/)).toBeVisible();
 });
 it('refuses unsupported and oversized files immediately without contacting the server',async()=>{
  const user=userEvent.setup();mount();await user.click(screen.getByRole('button',{name:en.admin.systemLabels.excel.import}));
  for(const file of [new File(['x'],'bad.csv'),new File([new Uint8Array(5_000_001)],'large.xlsx')]){
   fireEvent.change(screen.getByLabelText(en.labelsImportWizard.upload),{target:{files:[file]}});
   expect(screen.getByText(en.labelsImportWizard.fileError)).toBeVisible();expect(screen.getByRole('button',{name:en.labelsImportWizard.check})).toBeDisabled();
  }
  expect(mocks.fetch).not.toHaveBeenCalled();
 });
});
