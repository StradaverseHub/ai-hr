import {it,expect} from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import {buildXlsx} from '../lib/spreadsheet';
it('writes bounded dropdowns on employee and repeated sheets, preserving identifiers and header notes',async()=>{
 const bytes=await buildXlsx(['Employee ID','Choice'],[['000123','Named choice']],{sheetName:'Employees',textColumns:[0],columnWidths:[18,35],wrapText:true,headerNotes:['Required · text','Optional · Reference'],validationLists:[{column:1,values:['Named choice','CODE']}],extraSheets:[{name:'Family',rows:[['Employee ID','Relationship']],textColumns:[0],columnWidths:[18,35],wrapText:true,validationLists:[{column:1,values:['Child','Spouse']}]}]});
 const zip=await JSZip.loadAsync(bytes);
 const employeeXml=await zip.file('xl/worksheets/sheet1.xml')!.async('string');
 const familyXml=await zip.file('xl/worksheets/sheet2.xml')!.async('string');
 expect(employeeXml).toContain('sqref="B2:B501"');expect(employeeXml).toContain('<formula1>AIHR_Personnel_0_1</formula1>');
 expect(familyXml).toContain('<formula1>AIHR_Personnel_1_1</formula1>');
 const workbook=XLSX.read(bytes,{type:'array',cellNF:true});
 expect(workbook.Sheets.Employees.A2.v).toBe('000123');expect(workbook.Sheets.Employees.A2.z).toBe('@');
 expect(workbook.Sheets.Employees.A1.c?.[0].t).toBe('Required · text');
 expect(workbook.Workbook?.Names?.map(name=>name.Name)).toEqual(['AIHR_Personnel_0_1','AIHR_Personnel_1_1']);
 expect(workbook.Workbook?.Sheets?.find(sheet=>sheet.name==='__PersonnelLists')?.Hidden).toBe(2);
});
it('keeps oversized catalogs in the reference flow without creating unbounded dropdown ranges',async()=>{
 const bytes=await buildXlsx(['Choice'],[],{validationLists:[{column:0,values:Array.from({length:1001},(_,i)=>String(i))}]});
 const zip=await JSZip.loadAsync(bytes);expect(await zip.file('xl/worksheets/sheet1.xml')!.async('string')).not.toContain('<dataValidations');
});
