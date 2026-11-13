/**
 * Board d3ba1e9f (part 2) — Cost Center Allocations and Information-Only Correction get an Error Log: the check and
 * result screens list each problem (Excel row, field, value, what is wrong, how to fix it), and "Download Error Log"
 * builds the workbook in the browser from exactly the lines on screen. The rendered table's cells are compared with
 * the downloaded workbook's rows. Fictional data; actions and the upload transport are stubbed.
 */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import * as XLSX from 'xlsx';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import type {ImportProblemWorkbookInput} from '../lib/import-problem-workbook';

const captured=vi.hoisted(()=>({inputs:[] as unknown[]}));
vi.mock('../lib/import-problem-workbook',async importOriginal=>{
 const actual=await importOriginal<typeof import('../lib/import-problem-workbook')>();
 return{...actual,importProblemWorkbook:(input:ImportProblemWorkbookInput)=>{captured.inputs.push(input);return actual.importProblemWorkbook(input);}};
});
const actions=vi.hoisted(()=>({references:vi.fn(),confirmAllocation:vi.fn(),upload:vi.fn(),confirm:vi.fn()}));
vi.mock('../app/admin/personnel/import/cost-allocation-actions',()=>({allocationWorkbookReferencesAction:actions.references,confirmAllocationImportAction:actions.confirmAllocation,allocationImportReferencesAction:vi.fn()}));
vi.mock('../app/admin/personnel/information-correction-actions',()=>({informationContextAction:vi.fn(),previewInformationAction:vi.fn(),saveInformationAction:vi.fn(),previewInformationUploadAction:actions.upload,confirmInformationUploadAction:actions.confirm}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../components/derived-organisation-fields',()=>({useDerivedOrganisation:()=>({data:{status:'legacy'},loading:false,failed:false}),DerivedOrganisationFields:()=>null}));
const {CostAllocationImport}=await import('../app/admin/personnel/import/cost-allocation-import');
const {InformationCorrectionImport}=await import('../app/admin/personnel/import/information-correction-import');
const {importProblemWorkbook}=await vi.importActual<typeof import('../lib/import-problem-workbook')>('../lib/import-problem-workbook');

afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();vi.clearAllMocks();captured.inputs.length=0;});
const catalogues={en,ms} as Record<string,typeof en>;

/** The problem table's header and body cells as rendered. */
function tableCells(){
 const table=document.querySelector('[data-import-problems] table') as HTMLTableElement;
 expect(table).not.toBeNull();
 return [within(table).getAllByRole('columnheader').map(h=>h.textContent??''),...within(table).getAllByRole('row').slice(1).map(r=>within(r).getAllByRole('cell').map(c=>c.textContent??''))];
}
/** Click "Download Error Log" and read the workbook that the browser was given. */
async function downloaded(locale:string){
 Object.assign(URL,{createObjectURL:()=>'blob:error-log',revokeObjectURL:()=>{}});
 vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
 fireEvent.click(screen.getByRole('button',{name:catalogues[locale].importProblems.downloadLog}));
 await waitFor(()=>expect(captured.inputs.length).toBe(1));
 const bytes=importProblemWorkbook(captured.inputs[0] as ImportProblemWorkbookInput);
 return (XLSX.utils.sheet_to_json<(string|number)[]>(XLSX.read(bytes,{type:'array'}).Sheets.Errors,{header:1,raw:false,defval:''}) as string[][]).map(r=>r.map(String));
}

describe('Cost Center Allocations Error Log',()=>{
 it.each(['en','ms'])('lists every problem with its Excel row and downloads the same lines (%s)',async locale=>{
  const m=catalogues[locale],data=m.importErrorLogDataBankCostInfo;
  const plan={version:1,kind:'cost_allocations',token:'t',previewHash:'h',issues:[],counts:{total:2,valid:1,invalid:1},groups:[
   {key:'ZZ|E1|2026-01-01',companyCode:'ZZ',companyId:'',employeeCode:'E1',effectiveDate:'2026-01-01',operation:'replace',rows:[],rowNums:[2,3],errors:['Rows 2, 3: Company Code "ZZ" does not match a company you can import for.'],expectedRevision:0},
   {key:'ACME|E2|2026-01-01',companyCode:'ACME',companyId:'c1',employeeCode:'E2',effectiveDate:'2026-01-01',operation:'replace',rows:[],rowNums:[4],displayRows:[{code:'CC-1',percentage:'100'}],errors:[],expectedRevision:0},
  ]};
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,json:async()=>({attemptId:'0f0e0d0c-0000-4000-8000-000000000001',plan})})));
  const {container}=render(<NextIntlClientProvider locale={locale} messages={m}><CostAllocationImport/></NextIntlClientProvider>);
  fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[new File(['x'],'allocations.xlsx')]}});
  const problem=data.allocation.companyUnknown.replace('{code}','ZZ');
  await waitFor(()=>expect(screen.getAllByText(problem)).toHaveLength(2));
  const cells=tableCells(),h=m.importProblems.headers;
  expect(cells[0]).toEqual([h.row,h.reference,h.field,h.value,h.problem,h.correction,h.stage,h.result]);
  expect(cells.slice(1).map(r=>r[0])).toEqual(['2','3']);
  expect(cells[1]).toEqual(['2','E1','Company Code','ZZ',problem,data.corrections.chooseCompany,m.importProblems.stage.check,m.importProblems.result.refused]);
  // The group table says the set was not imported; the reason is told once, in the problem list.
  expect(screen.getAllByText(m.importProblems.result.refused).length).toBeGreaterThan(2);
  expect(await downloaded(locale)).toEqual(cells);
 });

 it('after saving, adds the sets the save refused and keeps the check problems',async()=>{
  const plan={version:1,kind:'cost_allocations',token:'t',previewHash:'h',issues:[],counts:{total:2,valid:1,invalid:1},groups:[
   {key:'ZZ|E1|2026-01-01',companyCode:'ZZ',companyId:'',employeeCode:'E1',effectiveDate:'2026-01-01',operation:'replace',rows:[],rowNums:[2],errors:['Row 2: Company Code is required.'],expectedRevision:0},
   {key:'ACME|E2|2026-01-01',companyCode:'ACME',companyId:'c1',employeeCode:'E2',effectiveDate:'2026-01-01',operation:'replace',rows:[],rowNums:[3],errors:[],expectedRevision:0},
  ]};
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,json:async()=>({attemptId:'0f0e0d0c-0000-4000-8000-000000000002',plan})})));
  actions.confirmAllocation.mockResolvedValue({ok:true,result:{attemptId:'0f0e0d0c-0000-4000-8000-000000000002',succeeded:0,failed:2,alreadyCommitted:false,results:[
   {key:'ZZ|E1|2026-01-01',employeeCode:'E1',effectiveDate:'2026-01-01',rowNums:[2],saved:false,errors:['Row 2: Company Code is required.']},
   {key:'ACME|E2|2026-01-01',employeeCode:'E2',effectiveDate:'2026-01-01',rowNums:[3],saved:false,errors:['Allocations changed. Reload and preview again.']}]}});
  const {container}=render(<NextIntlClientProvider locale="en" messages={en}><CostAllocationImport/></NextIntlClientProvider>);
  fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[new File(['x'],'allocations.csv')]}});
  const save=await screen.findByRole('button',{name:'Save 1 valid sets'});
  await waitFor(()=>expect(save).not.toBeDisabled());
  fireEvent.click(save);
  await waitFor(()=>expect(actions.confirmAllocation).toHaveBeenCalledWith('0f0e0d0c-0000-4000-8000-000000000002','h'));
  expect(await screen.findByText(en.importErrorLogDataBankCostInfo.allocation.errors.changed,{},{timeout:5000})).toBeVisible();
  const cells=tableCells();
  expect(cells.slice(1).map(r=>[r[0],r[1]])).toEqual([['2','E1'],['3','E2']]);
  expect(cells[2]).toContain(en.importProblems.stage.save);
  expect(cells[2]).toContain(en.importProblems.result.not_saved);
  expect(await downloaded('en')).toEqual(cells);
 });

 it('shows an unexpected upload failure as a plain sentence with its reference',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:500,json:async()=>({error:'This change could not be completed because of a system error. If it keeps happening, report reference DB-S-1A2B3C.'})})));
  const {container}=render(<NextIntlClientProvider locale="ms" messages={ms}><CostAllocationImport/></NextIntlClientProvider>);
  fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[new File(['x'],'allocations.csv')]}});
  expect(await screen.findByRole('alert')).toHaveTextContent(ms.common.databaseError.system.replace('{ref}','DB-S-1A2B3C'));
 });
});

describe('Information-Only Correction Error Log',()=>{
 it('lists the check problems on the Corrections sheet rows and downloads the same lines',async()=>{
  actions.upload.mockResolvedValue({attemptId:'1a1b1c1d-0000-4000-8000-000000000003',plan:{version:1,templateVersion:2,previewHash:'checked',counts:{total:2,valid:0,invalid:2},issues:[],rows:[
   {row:2,companyCode:'DEMO',employeeCode:'EMP-001',values:{'Employee Name':'Fictional Farah','Job Grade':'G9'},errors:['Job Grade is not an active system code.']},
   {row:4,companyCode:'DEMO',employeeCode:'EMP-003',values:{},errors:['Join Date: use YYYY-MM-DD or an Excel date.']}]}});
  render(<NextIntlClientProvider locale="en" messages={en}><InformationCorrectionImport onCommitPendingChange={()=>{}}/></NextIntlClientProvider>);
  fireEvent.change(screen.getByLabelText(en.people.informationCorrection.file),{target:{files:[new File(['x'],'corrections.xlsx')]}});
  fireEvent.submit(screen.getByRole('button',{name:'Validate file'}).closest('form')!);
  expect(await screen.findByText(en.importErrorLogDataBankCostInfo.correction.gradeInactive)).toBeVisible();
  const cells=tableCells(),h=en.importProblems.headers;
  expect(cells[0]).toEqual([h.sheet,h.row,h.reference,h.employeeName,h.field,h.value,h.problem,h.correction,h.stage,h.result]);
  expect(cells[1]).toEqual(['Corrections','2','EMP-001','Fictional Farah','Job Grade','G9',en.importErrorLogDataBankCostInfo.correction.gradeInactive,en.importErrorLogDataBankCostInfo.corrections.chooseReference,en.importProblems.stage.check,en.importProblems.result.refused]);
  expect(cells[2].slice(0,2)).toEqual(['Corrections','4']);
  expect(screen.getAllByText(en.importErrorLogDataBankCostInfo.correction.date)).toHaveLength(1);
  expect(await downloaded('en')).toEqual(cells);
 });

 it('offers the Error Log for a refused file as one whole-file line',async()=>{
  actions.upload.mockResolvedValue({correctionError:'Use the Corrections sheet from the Information-Only Correction template.'});
  render(<NextIntlClientProvider locale="en" messages={en}><InformationCorrectionImport onCommitPendingChange={()=>{}}/></NextIntlClientProvider>);
  fireEvent.change(screen.getByLabelText(en.people.informationCorrection.file),{target:{files:[new File(['x'],'wrong.xlsx')]}});
  fireEvent.submit(screen.getByRole('button',{name:'Validate file'}).closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent('Use the Corrections sheet from the Information-Only Correction template.');
  const rows=await downloaded('en');
  expect(rows.slice(1)).toEqual([[en.importProblems.wholeFile,'Use the Corrections sheet from the Information-Only Correction template.',en.importProblems.stage.file,en.importProblems.result.not_saved]]);
 });
});
