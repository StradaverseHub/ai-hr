import {describe,it,expect} from 'vitest';
import {MOVEMENT_FORM_IDS,movementFormFields,movementFormRequired} from '../lib/movement-form-contract';
import {MOVEMENT_IMPORT_COLUMNS,MOVEMENT_IMPORT_HEADERS,MOVEMENT_IMPORT_LIMITS,parseMovementImport,movementImportDate,movementTemplateDate,movementImportCellIssues} from '../lib/movement-import-contract';
import {MOVEMENT_KINDS,COMPARISON_KINDS} from '../core/movement-kinds';
import {toCsv} from '../lib/csv';
describe('Movement file is the New Event transport',()=>{
 it('accounts for every create field once and carries neither internal typeCode nor correction reason',()=>{
  expect(MOVEMENT_IMPORT_COLUMNS.length).toBe(Object.keys(MOVEMENT_FORM_IDS).length);
  expect(new Set(MOVEMENT_IMPORT_COLUMNS).size).toBe(MOVEMENT_IMPORT_COLUMNS.length);
  expect(MOVEMENT_IMPORT_COLUMNS).not.toContain('type_code');expect(MOVEMENT_IMPORT_COLUMNS).not.toContain('reason');
  expect(MOVEMENT_IMPORT_COLUMNS).toContain('termination_notice_days');expect(MOVEMENT_IMPORT_COLUMNS).toContain('manager_employment_id');
 });
 it.each(MOVEMENT_KINDS)('%s derives applicability and requirements from the shared New Event fields',kind=>{
  const fields=movementFormFields(kind,'resignation');expect(fields).toContain('kind');expect(fields).toContain('remarks');
  expect(fields.includes('companyId')).toBe(kind==='entityTransfer');
  expect(fields.includes('basicSalary')).toBe((COMPARISON_KINDS as readonly string[]).includes(kind));
  expect(fields.includes('blacklisted')).toBe(kind==='blacklist');
  expect(fields.includes('resignationDate')).toBe(kind==='termination');
  expect(movementFormRequired('kind',kind)).toBe(true);
 });
 it.each([['29-Feb-2024','2024-02-29'],['01-jan-2026','2026-01-01'],['2026-10-18','2026-10-18'],['29-Feb-2025',null],['31-Apr-2026',null],['01/02/2026',null],['0000-01-01',null]])('parses %s without locale ambiguity', (raw,expected)=>expect(movementImportDate(raw!)).toBe(expected));
 it('renders DD-MMM-YYYY and accepts its exact transport headers, quoted remarks and leading-zero IDs',()=>{
  const values=MOVEMENT_IMPORT_COLUMNS.map(column=>({employee_code:'0007',event_type:'secondment',effective_date:'18-Oct-2026',remarks:'Fictional, quoted\nremark'}[column]??''));
  const parsed=parseMovementImport(toCsv([MOVEMENT_IMPORT_HEADERS,values]));expect(parsed.fileErrors).toEqual([]);
  expect(parsed.records).toEqual([{row:2,employeeCode:'0007',errors:[],cells:{kind:'secondment',effectiveDate:'18-Oct-2026',remarks:'Fictional, quoted\nremark'}}]);
  expect(movementTemplateDate('2026-10-18')).toBe('18-Oct-2026');
 });
 it.each(['Employee ID,EventType,EffectiveDate,Unknown\nEMP-1,transfer,18-Oct-2026,x','employee_code,event_type,effective_date,event_type\nE,transfer,2026-10-18,transfer','employee_code,event_type\nE,transfer','employee_code,event_type,effective_date\nE,secondment,"2026-10-18'])('refuses unknown, duplicate, missing and malformed columns: %s',csv=>expect(parseMovementImport(csv).fileErrors.length).toBeGreaterThan(0));
 it('rejects a populated ignored field instead of claiming a secondment changed salary',()=>{
  const row=parseMovementImport('employee_code,event_type,effective_date,basic_salary\nEMP-1,secondment,18-Oct-2026,3500').records[0];
  expect(movementImportCellIssues(row,'secondment')).toContain('not_applicable:basicSalary');
 });
 it('does not treat legacy CSV/Paste identity, kind and date as a blacklist instruction at authoritative import validation',()=>{
  const csv='employee_code,event_type,effective_date,blacklisted,remarks\nEMP-1,blacklist,18-Oct-2026,,';
  const row=parseMovementImport(csv).records[0];expect(row.errors).toEqual([]);expect(movementImportCellIssues(row,'blacklist')).toContain('blacklist_input_required');
  for(const cells of [{blacklisted:'true'},{blacklisted:'false'},{remarks:'Deliberate fictional blacklist instruction'}])expect(movementImportCellIssues({...row,cells:{...row.cells,...cells}},'blacklist')).not.toContain('blacklist_input_required');
  expect(movementImportCellIssues({...row,cells:{...row.cells,remarks:'  '}},'blacklist')).toContain('blacklist_input_required');
 });
 it('bounds bytes, total rows and per-employee sequence length before opening any transaction',()=>{
  expect(parseMovementImport('x'.repeat(MOVEMENT_IMPORT_LIMITS.bytes+1)).fileErrors).toContain('file_too_large');
  const head='employee_code,event_type,effective_date\n';
  expect(parseMovementImport(head+Array.from({length:201},(_,index)=>`E${index},secondment,18-Oct-2026`).join('\n')).fileErrors).toContain('too_many_rows');
  expect(parseMovementImport(head+Array(21).fill('EMP-1,secondment,18-Oct-2026').join('\n')).records.every(row=>row.errors.includes('too_many_employee_rows'))).toBe(true);
 });
});

it('keeps rejected row explanations in a narrower preview and final row download without granting write authority',async()=>{
 const {retainMovementExclusionReasons}=await import('../lib/movement-import-contract');
 const previous=[{employeeCode:'EMP-1',employmentId:'e',name:'Fictional',fingerprint:'old',rows:[{row:2,employeeCode:'EMP-1',eventType:'bad',effectiveDate:'2026-10-18',status:'invalid' as const,errors:['unknown_reference:event_type']}]}];
 const next=[{...previous[0],fingerprint:'new',rows:[{...previous[0].rows[0],status:'excluded' as const,errors:[]}]}];
 expect(retainMovementExclusionReasons(next,previous)[0].rows[0]).toMatchObject({status:'excluded',errors:['unknown_reference:event_type']});
 const different=[{...next[0],rows:[{...next[0].rows[0],employeeCode:'OTHER'}]}];expect(retainMovementExclusionReasons(different,previous)[0].rows[0].errors).toEqual([]);
});


it('retains only the visible preview name for an exactly matching entirely unselected sequence',async()=>{
 const {retainMovementExclusionReasons}=await import('../lib/movement-import-contract');
 const row={row:2,employeeCode:'EMP-1',eventType:'salary',effectiveDate:'2026-10-18',status:'invalid' as const,errors:['salary_refused'],source:{sheet:'Salary',row:17}};
 const previous=[{employeeCode:'EMP-1',employmentId:'known-id',name:'Fictional Known',fingerprint:'preview-only',rows:[row]}];
 const excluded={employeeCode:'EMP-1',employmentId:null,name:null,fingerprint:null,rows:[{...row,status:'excluded' as const,errors:[]}]};
 const [result]=retainMovementExclusionReasons([excluded],previous);
 expect(result).toMatchObject({name:'Fictional Known',employmentId:null,fingerprint:null});
 expect(result.rows[0].errors).toEqual(['salary_refused']);
 expect(excluded.name).toBeNull();expect(excluded.rows[0].errors).toEqual([]);
 const refused={...excluded,rows:[{...excluded.rows[0],errors:['employee_unavailable']}]};
 expect(retainMovementExclusionReasons([refused],previous)[0].name).toBeNull();
 for(const changed of [{effectiveDate:'2026-10-19'},{eventType:'promotion'},{employeeCode:'EMP-2'},{source:{sheet:'Other',row:17}},{status:'failed' as const}]){
  expect(retainMovementExclusionReasons([{...excluded,rows:[{...excluded.rows[0],...changed}]}],previous)[0].name).toBeNull();
 }
 expect(retainMovementExclusionReasons([excluded],[{...previous[0],employmentId:null}])[0].name).toBeNull();
 expect(retainMovementExclusionReasons([excluded],[previous[0],previous[0]])[0].name).toBeNull();
 expect(retainMovementExclusionReasons([{...excluded,name:'Current server name'}],previous)[0].name).toBe('Current server name');
 expect(retainMovementExclusionReasons([{...excluded,employeeCode:'EMP-2'}],previous)[0].name).toBeNull();
});
