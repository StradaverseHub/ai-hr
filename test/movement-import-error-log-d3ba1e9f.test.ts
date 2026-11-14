/**
 * Board d3ba1e9f (stage f) — the Movement import's Error Log adapter and its Import History source: exact Excel rows,
 * field captions parsed from the issue code's detail, entered values (pay values hidden), translated problems and
 * corrections in every locale, the all-or-nothing results (refused, cancelled, stopped), whole-file lines, and
 * screen/file parity (the table's cells are the workbook's rows). The source's company scoping is checked here with
 * its reads mocked, and against the real database in movement-import-history.test.ts. Fictional data only.
 */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import * as XLSX from 'xlsx';
import {createTranslator} from 'next-intl';
import {HIDDEN_VALUE,importProblemCells,importProblemColumns,sortProblemLines,type ImportProblemLine} from '../lib/import-problem-lines';
import {importProblemSheetRows,importProblemWorkbook} from '../lib/import-problem-workbook';
import {
 MOVEMENT_CORRECTION_KEYS,movementFieldHidden,movementHistoryProblemLines,movementPreviewProblemLines,movementProblemResolver,movementRecordedProblemRows,movementResultProblemLines,
} from '../lib/movement-import-problems';
import type {MovementImportEmployee,MovementImportPreview,MovementImportResult,MovementImportRow} from '../lib/movement-import-contract';
import type {PersonnelLabelResolver} from '../lib/personnel-import-contract';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';

const h=vi.hoisted(()=>({attempt:vi.fn(),companies:vi.fn()}));
vi.mock('../core/import-history',()=>({getImportAttempt:h.attempt}));
vi.mock('../core/workforce-access',()=>({workforceCompanies:h.companies}));
const {movementErrorLogFor}=await import('../core/movement-error-log');

const LOCALES={en,ms,zh,ta,th,vi:vi_} as Record<string,typeof en>;
const resolverOf=(locale:string):PersonnelLabelResolver=>{const t=createTranslator({locale,messages:LOCALES[locale]}) as unknown as {(k:string):string;has(k:string):boolean};return (k,f)=>t.has(k)?t(k):f;};
const shared=(locale:string)=>createTranslator({locale,messages:LOCALES[locale],namespace:'importProblems'}) as unknown as (key:string)=>string;
const M=(locale:string)=>LOCALES[locale].people.import.movement;
const C=(locale:string)=>(LOCALES[locale] as unknown as {importErrorLogMovement:{correction:Record<string,string>}}).importErrorLogMovement.correction;

const row=(r:number,employeeCode:string,status:MovementImportRow['status'],errors:string[],extra:Partial<MovementImportRow>={}):MovementImportRow=>({row:r,employeeCode,eventType:'transfer',effectiveDate:'2026-11-01',status,errors,source:{sheet:'Movements',row:r},sourceRows:[r],companyCode:'EXT',...extra});
const employees:MovementImportEmployee[]=[
 {key:'a|BAD',companyId:'company-a',companyName:'EXT · Fictional A',employeeCode:'BAD',employmentId:'bad',name:'Fictional Aina',fingerprint:null,rows:[
  row(2,'BAD','invalid',['before_mismatch:departmentId']),
  row(3,'BAD','invalid',['employee_sequence_invalid']),
  row(5,'BAD','invalid',['required:positionId; invalid_effective_date'],{effectiveDate:'31-02-2026',sourceRows:[5,6]}),
 ]},
 {key:'a|PAY',companyId:'company-a',companyName:'EXT · Fictional A',employeeCode:'PAY',employmentId:'pay',name:'Fictional Bala',fingerprint:null,rows:[
  row(7,'PAY','invalid',['invalid_number:basicSalary','unknown_system_field:Salary Grade X','company_unknown','movement_before_current_record:2026-03-01'],{companyCode:'NOPE',proposed:{basicSalary:'9876.50'}}),
 ]},
 {key:'a|GOOD',companyId:'company-a',companyName:'EXT · Fictional A',employeeCode:'GOOD',employmentId:'good',name:'Fictional Chen',fingerprint:'fp',rows:[row(9,'GOOD','valid',[])]},
];
const preview:MovementImportPreview={inputHash:'h',selection:[2,3,5,7,9],fileErrors:[],employees,valid:1,excluded:4};

/** Screen cells (ImportProblemTable) and file rows (the workbook) for the same lines. */
function parity(lines:readonly ImportProblemLine[],locale:string){
 const t=shared(locale),sorted=sortProblemLines(lines),columns=importProblemColumns(sorted);
 const screen=sorted.map(line=>importProblemCells(line,columns,t));
 const book=XLSX.read(importProblemWorkbook({lines,t}),{type:'array'});
 const file=(XLSX.utils.sheet_to_json<(string|number)[]>(book.Sheets.Errors,{header:1,raw:false,defval:''}) as string[][]).slice(1).map(r=>r.map(String));
 expect(screen.length).toBeGreaterThan(0);
 expect(file).toEqual(screen);
 expect(importProblemSheetRows({lines,t}).slice(1)).toEqual(screen);
 return{screen,columns};
}

describe('Movement Error Log adapter — the check screen',()=>{
 it('numbers rows as Excel does, takes the field from the issue detail and gives the common corrections',()=>{
  const r=resolverOf('en'),lines=movementPreviewProblemLines(preview,r);
  expect(lines.map(l=>[l.sheet,l.row,l.reference,l.employeeName,l.stage,l.result])).toEqual([
   ['Movements',2,'BAD','Fictional Aina','check','refused'],
   ['Movements',3,'BAD','Fictional Aina','check','cancelled'],
   ['Movements',5,'BAD','Fictional Aina','check','refused'],
   ['Movements',5,'BAD','Fictional Aina','check','refused'],
   ['Movements',7,'PAY','Fictional Bala','check','refused'],
   ['Movements',7,'PAY','Fictional Bala','check','refused'],
   ['Movements',7,'PAY','Fictional Bala','check','refused'],
   ['Movements',7,'PAY','Fictional Bala','check','refused'],
  ]);
  expect(lines[0]).toMatchObject({field:'Department',problem:en.people.import.movement.issues.before_mismatch,correction:'Enter the value now on the employee’s record as Before, or download a new template.'});
  expect(lines[0].value).toBeUndefined();
  expect(lines[1]).toMatchObject({problem:en.people.import.movement.issues.employee_sequence_invalid,correction:'Correct the other rows of this employee, then upload the whole file again.'});
  expect(lines[2]).toMatchObject({field:'Position',problem:'A value is required.',correction:'Fill in this field - this event type requires it.'});
  expect(lines[3]).toMatchObject({field:'Effective Date',value:'31-02-2026',problem:'Enter a valid effective date.',correction:'Enter the date as DD-MMM-YYYY (for example 06-Jan-2026) or as an Excel date.'});
  // A pay value is never repeated; the unknown System Field name and the Company ID entered are.
  expect(lines[4]).toMatchObject({field:'Basic salary',value:HIDDEN_VALUE,problem:'Enter a valid non-negative number.',correction:'Enter a number (digits only, no currency sign).'});
  expect(lines[5]).toMatchObject({field:'System Fields',value:'Salary Grade X',problem:en.people.import.movement.issues.unknown_system_field});
  expect(lines[6]).toMatchObject({field:'Company ID',value:'NOPE',correction:'Choose a Company ID from the Reference sheet.'});
  // %date% handling is movementImportIssueText's own: the date is shown as the template asks for it.
  expect(lines[7]).toMatchObject({field:'Effective Date',problem:en.people.import.movement.issues.movement_before_current_record.split('%date%').join('01-Mar-2026')});
  expect(JSON.stringify(lines)).not.toContain('9876');
  // The problem is the sentence the Movement screen shows today, without the field appended (the Field column has it).
  expect(lines.some(l=>l.problem.includes(' · '))).toBe(false);
 });

 it('puts file problems first as whole-file lines, naming an unsupported or missing column as the field',()=>{
  const r=resolverOf('en'),lines=movementPreviewProblemLines({fileErrors:['unknown_column:Grade','too_many_rows','workbook_old_layout'],employees:[]},r);
  expect(lines).toEqual([
   {row:null,field:'Grade',problem:'Unsupported column.',correction:'Download the current Movement template, copy your rows into it and upload it again.',stage:'file',result:'refused'},
   {row:null,problem:'More than 200 rows. Split the file.',correction:'Split the file into smaller files (at most 200 rows, 50 employees and 20 rows per employee) and upload each one.',stage:'file',result:'refused'},
   {row:null,problem:en.people.import.movement.issues.workbook_old_layout,correction:'Download the current Movement template, copy your rows into it and upload it again.',stage:'file',result:'refused'},
  ]);
  expect(parity(lines,'en').screen[0][0]).toBe(en.importProblems.wholeFile);
 });

 it('hides pay, bank, statutory and restricted field values only',()=>{
  expect(movementFieldHidden('basicSalary')).toBe(true);
  expect(movementFieldHidden('incrementAmount')).toBe(true);
  expect(movementFieldHidden('departmentId')).toBe(false);
  expect(movementFieldHidden('positionId')).toBe(false);
 });

 it.each(Object.keys(LOCALES))('translates the problem, the field and the correction (%s), and the screen equals the file',locale=>{
  const lines=movementPreviewProblemLines(preview,resolverOf(locale));
  const L=LOCALES[locale];
  expect(lines[0]).toMatchObject({field:L.people.detail.employmentInfo.department,problem:M(locale).issues.before_mismatch,correction:C(locale).before});
  expect(lines[3]).toMatchObject({field:M(locale).sheet.col.effectiveDate,problem:M(locale).issues.invalid_effective_date,correction:C(locale).date});
  const{screen,columns}=parity(lines,locale);
  expect(columns).toEqual(['sheet','row','reference','employeeName','field','value','problem','correction','stage','result']);
  expect(screen[0]).toEqual(['Movements','2','BAD','Fictional Aina',L.people.detail.employmentInfo.department,'',M(locale).issues.before_mismatch,C(locale).before,L.importProblems.stage.check,L.importProblems.result.refused]);
  expect(screen[4][5]).toBe(L.importProblems.hiddenValue);
  expect(screen[1][9]).toBe(L.importProblems.result.cancelled);
 });

 it('has every correction in every locale, translated outside English',()=>{
  for(const locale of Object.keys(LOCALES))for(const key of MOVEMENT_CORRECTION_KEYS){
   expect(C(locale)[key],`${locale}.${key}`).toBeTruthy();
   if(locale!=='en')expect(C(locale)[key],`${locale}.${key}`).not.toBe(C('en')[key]);
  }
 });
});

describe('Movement Error Log adapter — the result screen',()=>{
 const result:MovementImportResult={imported:1,failed:1,excluded:4,byEventType:[],attemptId:'attempt-1',employees:[
  {...employees[0],rows:employees[0].rows.map(r=>({...r,status:'excluded' as const,errors:[]}))},
  {key:'a|FAIL',companyId:'company-a',employeeCode:'FAIL',employmentId:'fail',name:'Fictional Devi',fingerprint:null,rows:[row(11,'FAIL','failed',['change_refused']),row(12,'FAIL','failed',['before_mismatch:gradeId'])]},
  {...employees[2],rows:[{...employees[2].rows[0],status:'imported'}]},
 ]};
 it('marks a refused save as stopped for the whole employee, keeps the check refusals, and never lists an imported row',()=>{
  const lines=movementResultProblemLines(result,preview,resolverOf('en'));
  expect(lines.map(l=>[l.row,l.reference,l.stage,l.result])).toEqual([
   [2,'BAD','check','refused'],[3,'BAD','check','cancelled'],[5,'BAD','check','refused'],[5,'BAD','check','refused'],
   [11,'FAIL','save','stopped'],[12,'FAIL','save','stopped'],
  ]);
  expect(lines[4]).toMatchObject({problem:en.people.import.movement.issues.change_refused,correction:'Nothing was saved for this employee. Correct the problem, then import this employee again.',employeeName:'Fictional Devi'});
  expect(lines[5]).toMatchObject({field:'Job Grade',correction:'Enter the value now on the employee’s record as Before, or download a new template.'});
  expect(lines.some(l=>l.reference==='GOOD')).toBe(false);
  parity(lines,'zh');
 });
 it('without the preview (a result rejoined after navigation) lists the save refusals only',()=>{
  expect(movementResultProblemLines(result,null,resolverOf('en')).map(l=>l.row)).toEqual([11,12]);
 });
});

describe('Movement Error Log adapter — Import History',()=>{
 const checked=movementRecordedProblemRows(employees[0].rows);
 it('records only rows with problems and only what the log needs',()=>{
  expect(checked.map(r=>r.row)).toEqual([2,3,5]);
  expect(Object.keys(checked[2]).sort()).toEqual(['companyCode','effectiveDate','employeeCode','errors','eventType','row','source','status']);
  expect(movementRecordedProblemRows([row(4,'X','valid',[])])).toEqual([]);
 });
 it('rebuilds the check lines in the viewer’s language, keeps older entries’ sentences, and lists save refusals',()=>{
  const lines=movementHistoryProblemLines({
   fileErrors:[],fileIssues:[],
   employees:[
    {employeeCode:'BAD',name:'Fictional Aina',rows:[2,3,5],valid:false,errors:['recorded sentence'],checked},
    {employeeCode:'OLD',name:null,rows:[14,13],valid:false,errors:['Ayat lama yang direkodkan.']},
    {employeeCode:'GOOD',name:'Fictional Chen',rows:[9],valid:true,errors:[]},
   ],
   saveFailures:[{ordinal:11,employeeCode:'FAIL',name:'Fictional Devi',errors:['The change was refused. No changes from this employee were saved.']}],
  },resolverOf('ms'));
  expect(lines.map(l=>[l.row,l.reference,l.stage,l.result])).toEqual([[2,'BAD','check','refused'],[3,'BAD','check','cancelled'],[5,'BAD','check','refused'],[5,'BAD','check','refused'],[13,'OLD','check','refused'],[11,'FAIL','save','stopped']]);
  expect(lines[0]).toMatchObject({problem:ms.people.import.movement.issues.before_mismatch,correction:C('ms').before});
  expect(lines[4]).toEqual({row:13,reference:'OLD',problem:'Ayat lama yang direkodkan.',stage:'check',result:'refused'});
  expect(lines[5]).toMatchObject({problem:'The change was refused. No changes from this employee were saved.',correction:C('ms').saveStopped});
  parity(lines,'ms');
 });
 it('lists file problems from their codes, or as recorded, and the confirmation’s own refusal with its support reference',()=>{
  const r=resolverOf('en');
  expect(movementHistoryProblemLines({fileErrors:['missing_column:employee_code'],fileIssues:[{reason:'old'}],employees:[],saveFailures:[]},r)).toEqual([
   {row:null,field:'employee_code',problem:'Required column is missing.',correction:'Download the current Movement template, copy your rows into it and upload it again.',stage:'file',result:'refused'}]);
  expect(movementHistoryProblemLines({fileIssues:[{reason:'This file uses the old Movement template.'}],employees:[],saveFailures:[]},r)).toEqual([
   {row:null,problem:'This file uses the old Movement template.',stage:'file',result:'refused'}]);
  expect(movementHistoryProblemLines({fileIssues:[],employees:[],saveFailures:[],failure:'Something failed. Reference DB-S-7F3A2C.'},r)).toEqual([
   {row:null,problem:'Something failed. Reference DB-S-7F3A2C.',correction:'Upload the file again so it is checked against the current records.',stage:'system',result:'not_saved',errorReference:'DB-S-7F3A2C'}]);
 });
 it('reads a ROOT translator without `has` (the Import History registry’s) and falls back on missing keys',()=>{
  const root=createTranslator({locale:'th',messages:LOCALES.th,onError:()=>undefined}) as unknown as (k:string)=>string;
  const resolve=movementProblemResolver(k=>root(k));
  expect(resolve('people.import.movement.issues.required','')).toBe(th.people.import.movement.issues.required);
  expect(resolve('people.import.movement.issues.no_such_code','fallback')).toBe('fallback');
  expect(resolve('x','y')).toBe('y');
 });
});

describe('Movement Import History source',()=>{
 const ID='7c41e2a9-0000-4000-8000-000000000000';
 const t={problems:(()=>{const root=createTranslator({locale:'en',messages:en,onError:()=>undefined});return (k:string,v?:Record<string,unknown>)=>root(k as never,v as never);})(),shared:shared('en')};
 const checkedRows=movementRecordedProblemRows(employees[0].rows);
 const plan={version:1,kind:'movement',previewHash:'p',counts:{total:5,valid:1,invalid:4},issues:[],employees:[
  {key:'a|BAD',employeeCode:'BAD',companyId:'company-a',name:'Fictional Aina',rows:[2,3,5],valid:false,errors:['x'],checked:checkedRows},
  {key:'b|BETA',employeeCode:'BETA',companyId:'company-b',name:'Fictional Beta',rows:[8],valid:false,errors:['y'],checked:movementRecordedProblemRows([row(8,'BETA','invalid',['company_unknown'],{companyCode:'BETA'})])},
  {key:'?|NONE',employeeCode:'NONE',companyId:null,name:null,rows:[10],valid:false,errors:['z']},
  {key:'a|FAIL',employeeCode:'FAIL',companyId:'company-a',name:'Fictional Devi',rows:[11],valid:true,errors:[]},
  {key:'b|FAILB',employeeCode:'FAILB',companyId:'company-b',name:'Fictional Eko',rows:[12],valid:true,errors:[]},
 ]};
 const item=(createdBy:string)=>({id:ID,kind:'movement',createdBy,plan,events:[{kind:'previewed',detail:{}},{kind:'confirmed',detail:{succeeded:0,failed:2}}],items:[
  {itemKey:'failed|a|FAIL',companyId:'company-a',status:'failed',ordinal:11,errors:['Refused A.']},
  {itemKey:'failed|b|FAILB',companyId:'company-b',status:'failed',ordinal:12,errors:['Refused B.']},
  {itemKey:'invalid|a|BAD',companyId:'company-a',status:'failed',ordinal:2,errors:['x']},
 ]});
 beforeEach(()=>{vi.resetAllMocks();});
 it('gives the uploader every line, and another viewer only the employees of companies they can view',async()=>{
  h.attempt.mockResolvedValue(item('uploader'));
  const own=await movementErrorLogFor({tenantId:'t',userId:'uploader'} as never,ID,t);
  expect(own!.lines.map(l=>l.reference)).toEqual(['BAD','BAD','BAD','BAD','BETA','NONE','FAIL','FAILB']);
  expect(own!.total).toBe(8);expect(own!.truncated).toBe(false);
  expect(h.companies).not.toHaveBeenCalled();
  h.companies.mockResolvedValue(['company-a']);
  const scoped=await movementErrorLogFor({tenantId:'t',userId:'colleague'} as never,ID,t);
  expect(scoped!.lines.map(l=>[l.row,l.reference,l.result])).toEqual([[2,'BAD','refused'],[3,'BAD','cancelled'],[5,'BAD','refused'],[5,'BAD','refused'],[11,'FAIL','stopped']]);
  expect(JSON.stringify(scoped)).not.toMatch(/BETA|NONE|FAILB|Refused B/);
  expect(h.companies).toHaveBeenCalledWith({tenantId:'t',userId:'colleague'},'view');
  h.companies.mockResolvedValue([]);
  expect((await movementErrorLogFor({tenantId:'t',userId:'colleague'} as never,ID,t))!.lines).toEqual([]);
 });
 it('answers null for an attempt the viewer cannot see or of another kind',async()=>{
  h.attempt.mockResolvedValue(null);
  expect(await movementErrorLogFor({tenantId:'t',userId:'u'} as never,ID,t)).toBeNull();
  h.attempt.mockResolvedValue({...item('u'),kind:'cost_allocations'});
  expect(await movementErrorLogFor({tenantId:'t',userId:'u'} as never,ID,t)).toBeNull();
 });
 it('names a confirmation that stopped before any employee as a whole-file line',async()=>{
  h.attempt.mockResolvedValue({...item('u'),plan:{...plan,employees:[]},items:[],events:[{kind:'previewed',detail:{}},{kind:'failed',detail:{message:'Correct the file and upload it again before saving.'}}]});
  const log=await movementErrorLogFor({tenantId:'t',userId:'u'} as never,ID,t);
  expect(log!.lines).toEqual([{row:null,problem:'Correct the file and upload it again before saving.',correction:'Upload the file again so it is checked against the current records.',stage:'save',result:'not_saved'}]);
 });
});
