vi.mock('../app/(app)/admin/personnel/import/movement-actions',()=>({movementCatalogAction:vi.fn(),previewMovementAction:vi.fn(),commitMovementAction:vi.fn()}));
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import messages from '../messages/en.json';
import {EmployeeImport,type ImportReference} from '../app/(app)/admin/personnel/import/employee-import';
import {SectionImport} from '../app/(app)/admin/personnel/import/section-import';
import {ImportWorkbench} from '../app/(app)/admin/personnel/import/import-workbench';
import type {ImportPreview} from '../lib/import-schema';
import type {SectionImportPreview} from '../lib/import-sections';

const mocks=vi.hoisted(()=>({read:vi.fn(),validate:vi.fn(),commit:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../lib/import-file',async original=>({...await original<typeof import('../lib/import-file')>(),readImportFile:mocks.read}));
vi.mock('../app/(app)/admin/personnel/import/actions',()=>({validateImportAction:mocks.validate,commitImportAction:mocks.commit}));
vi.mock('../app/(app)/admin/personnel/import/section-actions',()=>({validateSectionAction:mocks.validate,commitSectionAction:mocks.commit,registerRecordsAction:vi.fn()}));
const reference:ImportReference={departments:[],positions:[],costCenters:[],states:[],countries:[],nationalities:[],relationships:[],familyRelationships:[]};
const sectionPreview:SectionImportPreview={section:'qualification',total:1,updateCount:1,skipCount:0,createCount:0,missingColumns:[],fileErrors:[],rows:[{rowNum:1,employeeCode:'FIX-1',employeeName:'Fictional Employee',verdict:'update',ok:true,errors:[],warnings:[],changes:['from_ym','is_highest'],proposed:[{column:'from_ym',value:'2018-02'},{column:'is_highest',value:'true'}]}]};
const employeePreview:ImportPreview={companyId:'c1',total:1,validCount:1,missingColumns:[],fileErrors:[],rows:[{rowNum:1,fullName:'Fictional Employee',email:'fictional@demo.test',ok:true,errors:[],warnings:[],company:'Fixture'}],dependents:{total:0,validCount:0,missingColumns:[],rows:[]}};
function deferred<T>(){let resolve!:(v:T)=>void;let reject!:(e:Error)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j});return{promise,resolve,reject};}
function pick(name:string){fireEvent.change(document.querySelector('input[type="file"]')!,{target:{files:[new File(['fixture'],name,{type:'text/csv'})]}});}
function mount(kind:'section'|'employee') {render(<NextIntlClientProvider locale="en" messages={messages}>{kind==='section'?<SectionImport section="qualification" reference={reference}/>:<EmployeeImport companies={[{id:'c1',name:'Fixture'}]} defaultCompanyId="c1" reference={reference}/>}</NextIntlClientProvider>);}
beforeEach(()=>{vi.resetAllMocks();mocks.read.mockImplementation(async(file:File)=>({name:file.name,text:file.name,dependentsText:'',extraTexts:{}}));
  // 524303d9 — an employee file upload posts its original bytes to the Import History upload route; the
  // fixture answers that route with the same commit mock, so success and failure stay the commit's own.
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(await mocks.commit()),{status:200})));});
describe.each(['section','employee'] as const)('%s import input ownership',kind=>{
  const preview=kind==='section'?sectionPreview:employeePreview;
  it('removes an old ready preview while reading a replacement and after its server validation refuses',async()=>{
    mocks.validate.mockResolvedValueOnce(preview).mockRejectedValueOnce(new Error('At most 500 rows.'));
    mount(kind);pick('valid.csv');expect(await screen.findByRole('button',{name:'Import 1 valid'})).toBeEnabled();
    const reading=deferred<{name:string;text:string;dependentsText:string;extraTexts:Record<string,string>}>();mocks.read.mockReturnValueOnce(reading.promise);
    pick('oversized.csv');expect(screen.queryByRole('button',{name:'Import 1 valid'})).toBeNull();
    await act(async()=>reading.resolve({name:'oversized.csv',text:'501 rows',dependentsText:'',extraTexts:{}}));
    await screen.findByText('At most 500 rows.');expect(screen.queryByRole('heading',{name:/Preview/})).toBeNull();expect(screen.queryByRole('button',{name:/Import .* valid/})).toBeNull();expect(mocks.commit).not.toHaveBeenCalled();
  });
  it('cannot restore a ready preview from a response for data edited during validation',async()=>{
    const validation=deferred<typeof preview>();mocks.validate.mockReturnValue(validation.promise);
    mount(kind);pick('first.csv');await waitFor(()=>expect(mocks.validate).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByText('Or paste CSV instead'));
    fireEvent.change(screen.getByLabelText('CSV data'),{target:{value:'new unvalidated input'}});
    await act(async()=>validation.resolve(preview));
    expect(screen.getByLabelText('CSV data')).toHaveValue('new unvalidated input');expect(screen.queryByRole('heading',{name:/Preview/})).toBeNull();expect(screen.queryByRole('button',{name:/Import .* valid/})).toBeNull();
  });
  it('ignores a slower file read after a newer selected file has been validated',async()=>{
    const oldRead=deferred<{name:string;text:string;dependentsText:string;extraTexts:Record<string,string>}>();mocks.read.mockReturnValueOnce(oldRead.promise);mocks.validate.mockResolvedValue(preview);
    mount(kind);pick('old.csv');pick('new.csv');await screen.findByText('new.csv loaded');await screen.findByRole('button',{name:'Import 1 valid'});
    await act(async()=>oldRead.resolve({name:'old.csv',text:'old bytes',dependentsText:'',extraTexts:{}}));
    expect(screen.getByText('new.csv loaded')).toBeInTheDocument();expect(screen.queryByText('old.csv loaded')).toBeNull();expect(mocks.validate).toHaveBeenCalledOnce();
  });
  it.each(['success','failure'] as const)('keeps submitted input fixed until Apply reports its real %s',async outcome=>{
    const saving=deferred<unknown>();mocks.validate.mockResolvedValue(preview);mocks.commit.mockReturnValue(saving.promise);
    render(<NextIntlClientProvider locale="en" messages={messages}><ImportWorkbench companies={[{id:'c1',name:'Fixture'}]} defaultCompanyId="c1" reference={reference}/></NextIntlClientProvider>);
    if(kind==='section')fireEvent.click(screen.getByRole('radio',{name:/^Qualifications /}));
    pick('submitted.csv');const apply=await screen.findByRole('button',{name:'Import 1 valid'});await waitFor(()=>expect(apply).toBeEnabled());fireEvent.click(apply);await waitFor(()=>expect(mocks.commit).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('CSV data')).toBeDisabled();expect(document.querySelector('input[type="file"]')).toBeDisabled();for(const radio of screen.getAllByRole('radio'))expect(radio).toBeDisabled();
    if(kind==='employee')expect(screen.getByRole('combobox',{name:'Target company'})).toBeDisabled();
    pick('replacement.csv');fireEvent.change(screen.getByLabelText('CSV data'),{target:{value:'replacement bytes'}});fireEvent.drop(screen.getByRole('button',{name:/Drop a file here or click to browse/}),{dataTransfer:{files:[new File(['other'],'dropped.csv')]}});fireEvent.click(screen.getByRole('radio',{name:/^Family /}));
    expect(mocks.read).toHaveBeenCalledOnce();expect(mocks.validate).toHaveBeenCalledOnce();expect(screen.getByText('submitted.csv loaded')).toBeInTheDocument();expect(screen.getByLabelText('CSV data')).toHaveValue('submitted.csv');
    if(outcome==='success'){
      const result=kind==='section'?{section:'qualification',updated:1,skipped:0,failed:[],fileErrors:[],runId:null}:{companyId:'c1',imported:1,failed:[],skipped:0,dependentsImported:0,superiorFailed:[],fileErrors:[],runId:null};
      await act(async()=>saving.resolve(result));await screen.findByText(kind==='section'?'1 register record saved':'Imported 1 employee');
    }else{await act(async()=>saving.reject(new Error('Fixture save failed.')));await screen.findByText('Fixture save failed.');expect(screen.queryByText(/register record saved|Imported 1 employee/)).toBeNull();}
    expect(screen.getByText('submitted.csv loaded')).toBeInTheDocument();expect(screen.queryByText('replacement.csv loaded')).toBeNull();expect(screen.getByLabelText('CSV data')).toBeEnabled();for(const radio of screen.getAllByRole('radio'))expect(radio).toBeEnabled();
  });
});

it('uses the register descriptor labels for the changed fields',async()=>{
  mocks.validate.mockResolvedValue(sectionPreview);mount('section');pick('valid.csv');await screen.findByRole('button',{name:'Import 1 valid'});
  expect(screen.getByText('From (year & month), Highest qualification')).toBeInTheDocument();expect(screen.queryByText('From Ym, Is Highest')).toBeNull();
});
