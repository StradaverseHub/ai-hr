import {describe,it,expect} from 'vitest';
import {movementImportTemplate,movementImportWorkbook} from '../lib/movement-import-template';
import {workbookToCsvTexts} from '../lib/spreadsheet';
import {parseMovementImport} from '../lib/movement-import-contract';
import type {MovementImportCatalog} from '../core/movement-import';
const catalog:MovementImportCatalog={types:[{code:'transfer',label:null,behaviour:'transfer'},{code:'regional_assignment',label:'Regional Assignment',behaviour:'secondment'},{code:'termination',label:null,behaviour:'termination'}],companies:[{value:'company-a',label:'Fictional Company'}],fields:{departmentId:[{value:'department-a',label:'Fictional Finance'}]}};
const resolve=(_key:string,fallback:string)=>fallback;
describe('live Movement workbook',()=>{
 it('derives event-specific guidance and reference values from shared New Event controls',()=>{
  const template=movementImportTemplate(catalog,resolve);expect(template.lists.find(list=>list.column===1)?.values).toEqual(['transfer','regional_assignment · Regional Assignment','termination']);
  const custom=template.instructions.find(row=>String(row[0]).startsWith('regional_assignment'));expect(custom).toBeDefined();expect(String(custom?.[3])).not.toContain('Basic salary');
  const termination=template.instructions.find(row=>String(row[0]).startsWith('termination ·'));expect(String(termination?.[2])).toContain('Last Working');
 });
 it('writes exactly Movements, Instructions and visible Lists with an EventType dropdown and stable leading-zero text cells',async()=>{
  const bytes=await movementImportWorkbook(catalog,resolve);const XLSX=await import('xlsx');const wb=XLSX.read(bytes,{type:'array'});
  expect(wb.SheetNames).toEqual(['Movements','Instructions','Lists']);expect(wb.Workbook?.Sheets?.every(sheet=>!sheet.Hidden)).toBe(true);
  expect(wb.Sheets.Movements.A2?.z??wb.Sheets.Movements.A2?.t).toBeDefined();
  const {default:JSZip}=await import('jszip');const zip=await JSZip.loadAsync(bytes);const sheet=await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  expect(sheet).toContain('sqref="B2:B201"');expect(sheet).toContain('AIHR_Personnel_0_1');
  const workbook=await zip.file('xl/workbook.xml')!.async('string');expect(workbook).toMatch(/(?:&apos;|')Lists(?:&apos;|')/);
  const decoded=await workbookToCsvTexts(bytes,[],false,['Instructions','Lists']);expect(parseMovementImport(decoded.first).fileErrors).toEqual(['no_data_rows']);
 });
});
