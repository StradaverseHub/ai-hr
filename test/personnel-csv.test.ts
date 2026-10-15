import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {parseCsv,toCsv} from '../lib/csv';
import {buildPersonnelCsv,parsePersonnelCsv,parseStrictPersonnelCsv,PERSONNEL_CSV_FRAME,PERSONNEL_CSV_CELL_PREFIX} from '../lib/personnel-csv';
import {parsePersonnelImportCsv,personnelColumnLabel} from '../lib/personnel-import-contract';
import {buildPersonnelRegisterCsv,personnelRegisterColumns} from '../lib/personnel-register-import';
import {buildTemplateCsv,employeeTemplate} from '../lib/import-template';
import {IMPORT_COLUMNS} from '../lib/import-schema';
const values=['+601234','-0012','−0012','@Name','=literal',"'genuine",PERSONNEL_CSV_CELL_PREFIX+'literal','\t=literal','line1\r\nline2','one,"two"'];
describe('Personnel versioned safe CSV transport',()=>{
 it('preserves protected prefixes, genuine apostrophes and embedded bytes with one explicit decode',()=>{
  const text=buildPersonnelCsv('emergency',[['Value'],...values.map(value=>[value])]);
  expect(parsePersonnelCsv(text,'emergency')).toEqual([['Value'],...values.map(value=>[value])]);
  const encoded=parseStrictPersonnelCsv(text).slice(2).map(row=>row[0]);
  for(const [index,value] of values.entries())if(/^[+\-@='\t]/.test(value))expect(encoded[index].startsWith(PERSONNEL_CSV_CELL_PREFIX)).toBe(true);
  expect(parseCsv(text)[0][0]).toBe(PERSONNEL_CSV_FRAME);
 });
 it('never strips apostrophes from unframed files or guesses their encoder',()=>{
  expect(parsePersonnelCsv("Value\n'+601234\n'~p1~literal\n",'emergency')).toEqual([['Value'],["'+601234"],["'~p1~literal"]]);
  expect(toCsv([['+601234']])).toBe("'+601234\r\n"); // Other consumers retain generic CSV behavior.
 });
 it('refuses unsupported frame versions and wrong worksheets before any header/record projection',()=>{
  expect(()=>parsePersonnelCsv(buildPersonnelCsv('emergency',[['Value']]),'qualification')).toThrow(/another worksheet/);
  expect(()=>parsePersonnelCsv(`${PERSONNEL_CSV_FRAME},99,emergency\nValue\nX`,'emergency')).toThrow(/version/);
  expect(()=>parsePersonnelCsv(`${PERSONNEL_CSV_FRAME},1,unsupported\nValue\nX`,'emergency')).toThrow(/another worksheet/);
 });
 it.each(['employee_code,first_name\nE001,"Alice\nE002,Bob','employee_code,first_name\nE001,Al"ice','employee_code,first_name\nE001,"Alice"tail'])('refuses malformed CSV without silently merging or rewriting rows: %s',text=>{
  expect(()=>parsePersonnelImportCsv(text,{columns:['employee_code','first_name']})).toThrow(/Malformed CSV/);
 });
 it('accepts doubled quotes, quoted commas, multiline cells, CRLF and a BOM',()=>{
  expect(parseStrictPersonnelCsv('\uFEFFName,Note\r\n"A ""quoted"" name","line1\r\nline2,tail"\r\n')).toEqual([['Name','Note'],['A "quoted" name','line1\r\nline2,tail']]);
  const parsed=parsePersonnelImportCsv('employee_code,first_name\nE001,"Alice\nExample"\nE002,"Bob ""B"""',{columns:['employee_code','first_name']});
  expect(parsed.records).toEqual([{employee_code:'E001',first_name:'Alice\nExample'},{employee_code:'E002',first_name:'Bob "B"'}]);
 });
 it.each(['en','ms','ta','th','vi','zh'])('round-trips actual current-register adapter with %s headings and exact protected values',locale=>{
  const messages=JSON.parse(readFileSync(new URL(`../messages/${locale}.json`,import.meta.url),'utf8'));
  const resolve=(key:string,fallback:string)=>{let value:unknown=messages;for(const part of key.split('.'))value=value&&typeof value==='object'?(value as Record<string,unknown>)[part]:undefined;return typeof value==='string'?value:fallback;};
  const record={employee_code:'E001',record_id:'00000000-0000-0000-0000-000000000001',full_name:'@Name',mobile_phone:'+601234',home_phone:'-0012',address:'=literal',remarks:"'genuine",priority:'other',relationship:''};
  const parsed=parsePersonnelImportCsv(buildPersonnelRegisterCsv('emergency',[record],resolve),{columns:personnelRegisterColumns('emergency'),sheet:'emergency',resolvers:[resolve]});
  expect(parsed.records[0]).toEqual(record);expect(parsed.warnings).toEqual([]);
 });
 it('full employee CSV producer preserves its +phone sample and still uses the current template contract',()=>{
  const columns=employeeTemplate.columns.map(column=>column.key),text=buildTemplateCsv(employeeTemplate);
  const parsed=parsePersonnelImportCsv(text,{columns});expect(parsed.headers).toEqual(columns);
  expect(parsed.records[0].phone).toBe('+60 12-345 6789');
  expect(parsed.records[0].full_name).toBe('Aisyah Binti Rahman');
 });
 it('qualifies a generated emergency Home phone heading without choosing between ambiguous stale aliases',()=>{
  const columns=[...IMPORT_COLUMNS.required,...IMPORT_COLUMNS.optional];
  const heading=personnelColumnLabel('emergency_contact_home_phone');
  expect(heading).toBe('Home phone (Emergency contact)');
  const current=parsePersonnelImportCsv(buildPersonnelCsv('employee',[[heading],['+601234']]),{columns});
  expect(current.headers).toEqual(['emergency_contact_home_phone']);expect(current.records[0].emergency_contact_home_phone).toBe('+601234');
  expect(()=>parsePersonnelImportCsv('Home phone\n+601234',{columns,generation:2})).toThrow(/Ambiguous column/);
  expect(()=>parsePersonnelImportCsv('home_phone,Home phone\n+601234,+609999',{columns,generation:2})).toThrow(/Ambiguous column/);
  expect(()=>parsePersonnelImportCsv('Home phone\n+601234',{columns,generation:3})).toThrow(/Unrecognized or removed/);
 });
 it('old aliases remain bounded by template generation, independently of transport framing',()=>{
  const text=buildPersonnelCsv('employee',[['employee_code','first_name'],['E001',"'Literal"]]);
  expect(parsePersonnelImportCsv(text,{columns:['employee_code','first_name'],generation:2}).records[0].first_name).toBe("'Literal");
  expect(()=>parsePersonnelImportCsv(text,{columns:['employee_code','first_name'],generation:3})).toThrow(/removed/);
  expect(personnelColumnLabel('employee_code')).not.toBe('employee_code');
 });
});
