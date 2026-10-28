/** Authored UNRUN: client-local source/header revision semantics, no provider or canonical commit. */
import {describe,expect,it} from 'vitest';
import {capturePersonnelImportSource,applyPersonnelHeaderMapping,personnelHeaderSuggestions} from '../lib/personnel-import-assistance-source';
import {buildPersonnelCsv,parsePersonnelCsv,parseStrictPersonnelCsv,parseStrictPersonnelCsvWithSource} from '../lib/personnel-csv';
import {parsePersonnelImportCsv,personnelColumnLabel,personnelImportHeaderCandidates} from '../lib/personnel-import-contract';
import {readImportFile} from '../lib/import-file';
import {buildXlsx} from '../lib/spreadsheet';
const columns=['full_name','email','hired_on','basic_salary'] as const;
describe('client-local reviewed Personnel headers',()=>{
 it('shares the same whole-file technical grammar and aliases as the strict parser',()=>{
  const text='full_name,email,hired_on,basic_salary\r\nNadia,nadia@fixture.test,2026-01-02,5200\r\n';
  const source=capturePersonnelImportSource({text,format:'csv'},'local-1');
  expect(personnelHeaderSuggestions(source,{columns}).map(row=>row.matches)).toEqual(columns.map(key=>[key]));
  expect(parsePersonnelImportCsv(text,{columns}).headers).toEqual([...columns]);
  const labels=columns.map(key=>personnelColumnLabel(key,'employee'));
  expect(personnelImportHeaderCandidates(labels,{columns}).map(row=>row.matches)).toEqual(columns.map(key=>[key]));
  expect(personnelImportHeaderCandidates(['Unknown heading'],{columns})[0].matches).toEqual([]);
 });
 it('tracks CSV logical record positions while preserving quoted newlines and default parser rows',()=>{
  const text='Name,Note\r\n\r\n"A\r\nB","quote ""here"""\r\n';const source=parseStrictPersonnelCsvWithSource(text);
  expect(source.rows).toEqual(parseStrictPersonnelCsv(text));expect(source.rowNumbers).toEqual([1,3]);expect(source.rows[1]).toEqual(['A\r\nB','quote "here"']);
 });
 it('changes only reviewed headings, retains exact decoded values and original source across revisions, and refuses stale/colliding mappings',()=>{
  const rows=[['Unfamiliar name','Unfamiliar salary'],['  Nadia  ','005200.00'],['=NOT_A_FORMULA_HERE','+001.00'],['line1\nline2','']];
  const text=buildPersonnelCsv('employee',rows),source=capturePersonnelImportSource({text,format:'csv',fileName:'PRIVATE local.csv'},'local-1');
  const accepted=applyPersonnelHeaderMapping(source,'local-1',['full_name','basic_salary'],columns,'local-2');
  expect(parsePersonnelCsv(accepted.text,'employee').slice(1)).toEqual(rows.slice(1));expect(accepted.source.originalText).toBe(text);expect(accepted.source.currentText).toBe(accepted.text);expect(source.matrix).toEqual(rows);
  expect(accepted.mapping).toEqual([{columnIndex:0,field:'full_name'},{columnIndex:1,field:'basic_salary'}]);
  expect(()=>applyPersonnelHeaderMapping(accepted.source,'local-1',['full_name','basic_salary'],columns,'local-3')).toThrow();
  expect(()=>applyPersonnelHeaderMapping(source,'local-1',['full_name','full_name'],columns,'local-2')).toThrow();
  expect(()=>applyPersonnelHeaderMapping(source,'local-1',['full_name','invented_field'],columns,'local-2')).toThrow();
 });
 it('does not alter legacy workbook projections and captures original sheet/row/column/display metadata only on request',async()=>{
  const bytes=await buildXlsx(['Unfamiliar name','Unfamiliar salary'],[['Nadia','005200.00']],{sheetName:'PRIVATE local sheet'});
  const copied=new Uint8Array(bytes.length);copied.set(bytes);
  const file=new File([copied.buffer],'PRIVATE local.xlsx');const legacy=await readImportFile(file),captured=await readImportFile(file,{captureSource:true});
  expect(legacy).not.toHaveProperty('source');const{source,...projection}=captured;expect(projection).toEqual(legacy);
  expect(source?.sheetName).toBe('PRIVATE local sheet');expect(source?.rows[0]).toMatchObject({row:1,cells:[{column:1,decoded:'Unfamiliar name'},{column:2,decoded:'Unfamiliar salary'}]});
  const local=capturePersonnelImportSource({text:captured.text,format:captured.format,source},'local-workbook');expect(local.coordinateKind).toBe('worksheet_row');expect(local.rowNumbers).toEqual([1,2]);
 });
});
