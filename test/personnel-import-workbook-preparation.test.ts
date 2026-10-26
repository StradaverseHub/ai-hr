/** Authored UNRUN: explicit bounded browser intake and sheet scope, not all-workbook import proof. */
import {describe,expect,it} from 'vitest';
import {readImportFile} from '../lib/import-file';
import {decodePersonnelCsvRows,PERSONNEL_CSV_FRAME} from '../lib/personnel-csv';
import {buildXlsx} from '../lib/spreadsheet';
import {personnelWorksheetMatrixRows,reviewPersonnelWorkbookRoles} from '../lib/personnel-import-assistance-source';
async function file(){const bytes=await buildXlsx(['Name'],[['PRIVATE Employee']],{sheetName:'Messy employee sheet',extraSheets:[{name:'Unassigned HR table',rows:[['Other'],['PRIVATE Other']]},{name:'Family',rows:[['employee_code','dependent_name'],['E1','PRIVATE Family']]}]});const copied=new Uint8Array(bytes.length);copied.set(bytes);return new File([copied.buffer],'PRIVATE workbook.xlsx');}
describe('opt-in messy workbook intake',()=>{
 it('retains strict default unknown-sheet rejection and includes every bounded nonempty sheet only when preparation is explicit',async()=>{
  const source=await file(),options={extraSheets:['Family'],allowedSheets:['Family'],captureSource:true};await expect(readImportFile(source,options)).rejects.toMatchObject({code:'UNEXPECTED_SHEET'});
  const captured=await readImportFile(source,{...options,preparePersonnel:true});expect(captured.preparation?.sheets.map(sheet=>sheet.sheetName)).toEqual(['Messy employee sheet','Unassigned HR table','Family']);expect(captured.dependentsText).toContain('PRIVATE Family');
  expect(captured.preparation?.sheets[0].source.rows[1]).toMatchObject({row:2,cells:[{column:1,raw:'PRIVATE Employee',decoded:'PRIVATE Employee'}]});
 });
 it('requires exactly one employee role, unique companion roles and explicit acknowledgement of every omitted nonempty sheet',async()=>{
  const workbook=(await readImportFile(await file(),{preparePersonnel:true})).preparation!;
  expect(()=>reviewPersonnelWorkbookRoles(workbook,{},false)).toThrow();expect(()=>reviewPersonnelWorkbookRoles(workbook,{'Messy employee sheet':'employee','Family':'family'},false)).toThrow();
  const reviewed=reviewPersonnelWorkbookRoles(workbook,{'Messy employee sheet':'employee','Family':'family'},true);
  expect(reviewed.employee.sheetName).toBe('Messy employee sheet');expect(reviewed.companions.family).toContain('PRIVATE Family');expect(reviewed.excluded).toEqual(['Unassigned HR table']);expect(reviewed.roles['Unassigned HR table']).toBe('unassigned');expect(reviewed.original).toBe(workbook);
  expect(()=>reviewPersonnelWorkbookRoles(workbook,{'Messy employee sheet':'employee','Unassigned HR table':'employee','Family':'family'},true)).toThrow();
  expect(()=>reviewPersonnelWorkbookRoles(workbook,{'Messy employee sheet':'employee','Unassigned HR table':'family','Family':'family'},true)).toThrow();
 });
 it('decodes canonical frame cells without dropping physical evidence rows or explicit blank values',()=>{
  const cell=(column:number,decoded:string,raw:string|null=decoded)=>({column,decoded,raw,display:decoded,kind:raw===null?'blank' as const:'string' as const});
  const source={sheetName:'Employee',rows:[{row:2,cells:[cell(1,PERSONNEL_CSV_FRAME),cell(2,'1'),cell(3,'employee'),cell(4,'Keep'),cell(5,'',null)]},{row:5,cells:[cell(1,'name'),cell(2,'remark'),cell(3,'',null)]},{row:9,cells:[cell(1,'Fictional'),cell(2,'~p1~=literal'),cell(3,'')]},{row:12,cells:[cell(1,'  '),cell(2,'',null)]}]};
  const matrix=decodePersonnelCsvRows(personnelWorksheetMatrixRows(source),'employee');
  expect(matrix).toEqual([['name','remark'],['Fictional','=literal',''],['  ']]);expect(source.rows.map(row=>row.row)).toEqual([2,5,9,12]);expect(source.rows[2].cells[1].decoded).toBe('~p1~=literal');
 });
 it('rejects excess sheets without returning a truncated source or changing the legacy decoder',async()=>{
  const bytes=await buildXlsx(['Name'],[['Fictional']],{extraSheets:Array.from({length:32},(_,i)=>({name:`Other ${i}`,rows:[['Fictional']]}))});const copied=new Uint8Array(bytes.length);copied.set(bytes);
  await expect(readImportFile(new File([copied.buffer],'fictional.xlsx'),{preparePersonnel:true})).rejects.toMatchObject({code:'FILE_TOO_LARGE'});
 });
});
