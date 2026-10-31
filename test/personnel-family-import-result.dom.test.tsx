/** Family's count is saved dependent rows, not distinct employees. Only actions/file IO are stubbed;
 * the actual two-child owner journey is separately evidenced by the parent browser and DB readback.
 */
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
import {SectionImport} from '../app/(app)/admin/personnel/import/section-import';
import type {ImportReference} from '../app/(app)/admin/personnel/import/employee-import';
import type {SectionImportPreview,SectionImportResult} from '../lib/import-sections';
const mocks=vi.hoisted(()=>({read:vi.fn(),validate:vi.fn(),commit:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../lib/import-file',async original=>({...await original<typeof import('../lib/import-file')>(),readImportFile:mocks.read}));
vi.mock('../app/(app)/admin/personnel/import/section-actions',()=>({validateSectionAction:mocks.validate,commitSectionAction:mocks.commit,registerRecordsAction:vi.fn()}));
const reference:ImportReference={departments:[],positions:[],costCenters:[],states:[],countries:[],nationalities:[],relationships:[],familyRelationships:[]};
const catalogs={en,ms,zh,ta,th,vi:viMessages};type Locale=keyof typeof catalogs;
const familyCsv='employee_code,full_name,relationship,date_of_birth\nPR15-EMPLOYEE,Fictional same child,child,2016-02-03\nPR15-EMPLOYEE,Fictional same child,child,2018-04-05\n';
const familyPreview:SectionImportPreview={section:'family',total:2,updateCount:2,skipCount:0,createCount:0,missingColumns:[],fileErrors:[],rows:['2016-02-03','2018-04-05'].map((date,row)=>({rowNum:row+1,employeeCode:'PR15-EMPLOYEE',employeeName:'Fictional Employee',verdict:'update',ok:true,errors:[],warnings:[],changes:['family_member'],proposed:[{column:'full_name',value:'Fictional same child'},{column:'date_of_birth',value:date}]}))};
async function apply(locale:Locale,preview:SectionImportPreview,text=familyCsv){
 mocks.read.mockResolvedValue({name:'records.csv',text,dependentsText:'',extraTexts:{}});mocks.validate.mockResolvedValue(preview);
 const result:SectionImportResult={section:preview.section,updated:preview.updateCount,skipped:0,failed:[],fileErrors:[],runId:null};mocks.commit.mockResolvedValue(result);
 const t=createTranslator({locale,messages:{people:{import:catalogs[locale].people.import}},namespace:'people.import'});
 render(<NextIntlClientProvider locale={locale} messages={catalogs[locale]}><SectionImport section={preview.section} reference={reference}/></NextIntlClientProvider>);
 const file=document.querySelector('input[type="file"]');expect(file).not.toBeNull();fireEvent.change(file!,{target:{files:[new File([text],'records.csv',{type:'text/csv'})]}});
 const button=await screen.findByRole('button',{name:t('sectionImportButton',{count:preview.updateCount})});await waitFor(()=>expect(button).toBeEnabled());fireEvent.click(button);
 await waitFor(()=>expect(mocks.commit).toHaveBeenCalledTimes(1));expect(mocks.commit.mock.calls[0][0]).toBe(preview.section);expect(mocks.commit.mock.calls[0][1]).toBe(text);
}
beforeEach(()=>vi.resetAllMocks());
describe('Family import result cardinality',()=>{
 const expected:{locale:Locale;text:string}[]=[
  {locale:'en',text:'2 family records saved'},{locale:'ms',text:'2 rekod keluarga disimpan'},{locale:'zh',text:'已保存 2 条家庭记录'},
  {locale:'ta',text:'2 குடும்பப் பதிவுகள் சேமிக்கப்பட்டன'},{locale:'th',text:'บันทึกข้อมูลครอบครัวแล้ว 2 รายการ'},{locale:'vi',text:'Đã lưu 2 bản ghi gia đình'},
 ];
 it.each(expected)('$locale names two saved Family records for one employee/name with distinct birth dates',async({locale,text})=>{
  await apply(locale,familyPreview);expect(await screen.findByRole('heading',{name:text})).toBeInTheDocument();
  const t=createTranslator({locale,messages:{people:{import:catalogs[locale].people.import}},namespace:'people.import'});expect(screen.queryByRole('heading',{name:t('sectionUpdatedCount',{count:2})})).toBeNull();
 });
 it('retains ordinary Profile wording for one updated employee',async()=>{
  const profile:SectionImportPreview={...familyPreview,section:'profile',total:1,updateCount:1,rows:[{...familyPreview.rows[0],changes:['phone'],proposed:[{column:'phone',value:'000123'}]}]};
  await apply('en',profile,'employee_code,phone\nPR15-EMPLOYEE,000123\n');expect(await screen.findByRole('heading',{name:'1 employee updated'})).toBeInTheDocument();expect(screen.queryByRole('heading',{name:/family record/})).toBeNull();
 });
});
