import {describe,expect,it} from 'vitest';
import {createTranslator} from 'next-intl';
import {readFileSync} from 'node:fs';
import {payrollComparisonRemarks} from '../lib/payroll-comparison-presentation';
import * as XLSX from 'xlsx';
import {PDFDocument} from 'pdf-lib';
import {serializePayrollComparison} from '../lib/payroll-comparison-export';
import {comparePayrollResults,type ComparisonIdentity,type ComparisonSource} from '../lib/payroll-comparison-result';
import {DEFAULT_PAYROLL_COMPARISON,payrollComparisonFilters} from '../lib/payroll-period-comparison';
import {extractedText} from './helpers/pcb-pdf-text';
type Run=Parameters<typeof serializePayrollComparison>[0];
const companyId='00000000-0000-0000-0000-000000000001';
function fixture(count=1):Run{
 const definition=structuredClone(DEFAULT_PAYROLL_COMPARISON),filters=payrollComparisonFilters({currentPeriod:'2026-10'},definition);
 const runs=[{id:'previous',companyId,period:'2026-09',runType:'regular' as const,status:'closed' as const,stale:false},
  {id:'current',companyId,period:'2026-10',runType:'regular' as const,status:'processed' as const,stale:false}];
 const identities:ComparisonIdentity[]=Array.from({length:count},(_,index)=>({employmentId:'e'+index,companyId,employeeCode:String(index).padStart(6,'0'),employeeName:'=王小明 ไทย தமிழ் Nguyễn '+index,
  departmentId:null,department:'Fictional Department',grade:'G1',company:'Fictional Employer',costCentre:'001',hireDate:'2025-01-01',exitDate:null,movements:[],verifiedTransferIds:[]}));
 const sources:ComparisonSource[]=identities.flatMap(identity=>[{id:'p-'+identity.employmentId,employmentId:identity.employmentId,runId:'previous',companyId,currency:'MYR',amount:'100.00',version:1,coverage:{from:'2026-09-01',to:'2026-09-30'}},
  {id:'c-'+identity.employmentId,employmentId:identity.employmentId,runId:'current',companyId,currency:'MYR',amount:'100.01',version:2,coverage:{from:'2026-10-01',to:'2026-10-31'}}]);
 const result=comparePayrollResults({definition,filters,companyIds:[companyId],runs,sources,identities,previousFrom:'2026-09-01',currentFrom:'2026-10-01',currentTo:'2026-10-31',paginate:false});
 return {definition,filters,result,companyIds:[companyId],sourceRevisions:sources.map(({id,version,runId})=>({id,version,runId})),contextUnavailable:false,
  canEdit:true,canExport:true,reportId:'00000000-0000-0000-0000-000000000002',version:1,spec:{datasetId:'payroll_period_comparison',payrollComparison:definition,columns:[...definition.columns,'previous','current','variance','reason','currency']},
  name:'Payroll Basic Variance',description:'Fictional sign-off example',generatedAt:'2026-10-20T10:00:00.000Z',generatedBy:'Fictional preparer'};
}
describe('native payroll comparison outputs',()=>{
 it.each(['en','zh','ms','ta','th','vi'])('keeps %s screen notes and exported headings, explanations and warnings in the same locale',async(locale)=>{
  const messages=JSON.parse(readFileSync(new URL(`../messages/${locale}.json`,import.meta.url),'utf8'));
  const t=createTranslator({locale,messages,namespace:'payrollComparison',onError:error=>{throw error;}});
  const run=fixture(2),row=run.result.rows[0];
  row.currency=null;row.reason.prorated=true;row.reason.multipleChanges=true;row.reason.evidenceIds=['retained-movement'];
  const notes=payrollComparisonRemarks(row,t);
  for(const key of ['unexplained','prorated','multipleChanges','currencyUnknown'])expect(notes).toContain(t('remarks.'+key));
  expect(notes).toContain(t('remarks.evidence',{references:'retained-movement'}));
  const file=await serializePayrollComparison(run,'xlsx',t),book=XLSX.read(file.bytes,{type:'array'});
  const details=XLSX.utils.sheet_to_json<Record<string,unknown>>(book.Sheets.Details);
  expect(details).toHaveLength(2);
  const first=details.find(item=>item[t('columns.employeeCode')]===row.employeeCode)!;
  expect(first[t('columns.employeeName')]).toBe(row.employeeName);
  expect(first[t('columns.current')]).toBe(100.01);
  expect(first[t('columns.remarks')]).toBe(notes);
  expect(first[t('columns.reason')]).toBe(t('reasons.unexplained'));
  const summary=XLSX.utils.sheet_to_json(book.Sheets.Summary,{header:1});
  expect(summary).toContainEqual([t('exports.generatedBy'),'Fictional preparer']);
  expect(summary).toContainEqual([t('exports.provisional'),t('provisional')]);
  expect(summary).toContainEqual([t('exports.basis'),t('basis')]);
  const sourceRows=summary.filter((value)=>Array.isArray(value)&&value[0]===t('exports.sourceRun')) as string[][];
  expect(sourceRows).toHaveLength(2);
  expect(sourceRows.some(value=>value[1].includes(t('runTypes.regular'))&&value[1].includes(t('runStates.processed')))).toBe(true);
  row.reason.reason='unclassified';expect(payrollComparisonRemarks(row,t)).toBe(t('remarks.disabled'));
 });
 it('renders translated Chinese PDF labels, caveats and glyphs through the real serializer',async()=>{
  const messages=JSON.parse(readFileSync(new URL('../messages/zh.json',import.meta.url),'utf8'));
  const t=createTranslator({locale:'zh',messages,namespace:'payrollComparison',onError:error=>{throw error;}});
  const run=fixture(5),file=await serializePayrollComparison(run,'pdf',t),text=(await extractedText(file.bytes)).replace(/\s/g,'');
  for(const phrase of [t('columns.employeeName'),t('remarks.unexplained'),t('exports.provisionalPayroll'),t('exports.generatedBy')])expect(text).toContain(phrase.replace(/\s/g,''));
  expect(text).toContain('100.01');expect(text).toContain('Fictionalpreparer');
  for(const row of run.result.rows)expect(text).toContain(row.employeeCode!);
 });

 it('writes complete native Summary/Details sheets with exact cents, text IDs and formula-looking multilingual names',async()=>{
  const run=fixture(65),file=await serializePayrollComparison(run,'xlsx');
  expect(Buffer.from(file.bytes).subarray(0,2).toString()).toBe('PK');
  const book=XLSX.read(file.bytes,{type:'array',cellNF:true});expect(book.SheetNames).toEqual(['Summary','Details']);
  const rows=XLSX.utils.sheet_to_json<Record<string,unknown>>(book.Sheets.Details);
  expect(rows).toHaveLength(65);expect(rows[0]['Emp no.']).toBe('000000');expect(rows[0].Employee).toBe(run.result.rows[0].employeeName);
  expect(rows[0]['Previous amount']).toBe(100);expect(rows[0]['Current amount']).toBe(100.01);expect(rows[0].Variance).toBe(0.01);
  const range=XLSX.utils.decode_range(book.Sheets.Details['!ref']!);
  for(let r=1;r<=range.e.r;r++)for(let c=0;c<=range.e.c;c++){const cell=book.Sheets.Details[XLSX.utils.encode_cell({r,c})];expect(cell?.f).toBeUndefined();}
  const numeric=Object.values(book.Sheets.Details).filter(value=>value&&typeof value==='object'&&'t'in value&&value.t==='n');
  expect(numeric.some(value=>value.z==='"RM" #,##0.00')).toBe(true);
  const summary=XLSX.utils.sheet_to_json(book.Sheets.Summary,{header:1});
  expect(summary).toContainEqual(['Generated by','Fictional preparer']);expect(summary).toContainEqual(['Prorated',0]);
  expect(summary).toContainEqual(['Provisional','Current payroll is processed, not closed. Figures may change.']);
 });
 it('refuses partial pages, unsupported numeric precision and excessive cell text instead of truncating',async()=>{
  const partial=fixture(60);partial.result.rows=partial.result.rows.slice(0,50);
  await expect(serializePayrollComparison(partial,'xlsx')).rejects.toThrow('complete filtered');
  const large=fixture();large.result.rows[0].current='10000000000000.01';await expect(serializePayrollComparison(large,'xlsx')).rejects.toThrow('15-digit');
  const text=fixture();text.result.rows[0].employeeName='字'.repeat(32768);await expect(serializePayrollComparison(text,'xlsx')).rejects.toThrow('32,767');
 });
 it('embeds glyphs needed by fixed captions even when every recorded value is ASCII',async()=>{
  const run=fixture();run.result.rows[0].employeeName='Fictional employee';
  const file=await serializePayrollComparison(run,'pdf'),text=await extractedText(file.bytes);
  expect(text.replace(/\s/g,'')).toContain('2026-09→2026-10');
  expect(text).toContain('100.01');expect(text).toContain('0.01');
 });
 it('renders landscape A4 with complete multilingual rows, repeated bands/headers and preparer/page footers',async()=>{
  const run=fixture(70),file=await serializePayrollComparison(run,'pdf'),doc=await PDFDocument.load(file.bytes);
  expect(doc.getPageCount()).toBeGreaterThan(3);
  for(const page of doc.getPages()){expect(page.getWidth()).toBeCloseTo(841.89,1);expect(page.getHeight()).toBeCloseTo(595.28,1);}
  const text=await extractedText(file.bytes),compact=text.replace(/\s/g,'');
  for(const name of ['王小明','ไทย','தமிழ்','Nguyễn'])expect(compact).toContain(name);
  for(const row of run.result.rows)expect(compact).toContain(row.employeeCode);
  expect(text).toContain('Provisional');expect(text).toContain('Generated by Fictional preparer');
  expect(compact).toContain(`${doc.getPageCount()}/${doc.getPageCount()}`);
 });
});
