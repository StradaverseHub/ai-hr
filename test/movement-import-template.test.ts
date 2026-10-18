import {describe,it,expect} from 'vitest';
import {movementImportTemplate,movementImportWorkbook} from '../lib/movement-import-template';
import {workbookToCsvTexts} from '../lib/spreadsheet';
import {parseMovementImport,MOVEMENT_IMPORT_HEADERS} from '../lib/movement-import-contract';
import type {MovementImportCatalog} from '../core/movement-import';
const catalog:MovementImportCatalog={types:[{code:'transfer',label:null,behaviour:'transfer'},{code:'regional_assignment',label:'Regional Assignment',behaviour:'secondment'},{code:'termination',label:null,behaviour:'termination'}],companies:[{value:'company-a',label:'Fictional Company'}],fields:{companyId:[{value:'company-a',label:'Fictional Company'}],departmentId:[{value:'department-a',label:'Fictional Finance'}]}};
const resolve=(_key:string,fallback:string)=>fallback;
describe('live Movement workbook',()=>{
 it('derives event-specific guidance and reference values from shared New Event controls',()=>{
  const template=movementImportTemplate(catalog,resolve),eventColumn=MOVEMENT_IMPORT_HEADERS.indexOf('EventType'),companyColumn=MOVEMENT_IMPORT_HEADERS.indexOf('Company Id');
  expect(eventColumn).toBeGreaterThanOrEqual(0);expect(companyColumn).toBeGreaterThanOrEqual(0);expect(eventColumn).not.toBe(companyColumn);
  expect(template.lists.find(list=>list.column===eventColumn)?.values).toEqual(['transfer','regional_assignment · Regional Assignment','termination']);
  expect(template.lists.find(list=>list.column===companyColumn)?.values).toEqual(['company-a · Fictional Company']);
  const custom=template.instructions.find(row=>String(row[0]).startsWith('regional_assignment'));expect(custom).toBeDefined();expect(String(custom?.[3])).not.toContain('Basic salary');
  const termination=template.instructions.find(row=>String(row[0]).startsWith('termination ·'));expect(String(termination?.[2])).toContain('Last Working');
 });
 it('writes exactly Movements, Instructions and visible Lists with an EventType dropdown and stable leading-zero text cells',async()=>{
  const bytes=await movementImportWorkbook(catalog,resolve);const XLSX=await import('xlsx');const wb=XLSX.read(bytes,{type:'array'});
  expect(wb.SheetNames).toEqual(['Movements','Instructions','Lists']);expect(wb.Workbook?.Sheets?.every(sheet=>!sheet.Hidden)).toBe(true);
  expect(wb.Sheets.Movements.A2?.z??wb.Sheets.Movements.A2?.t).toBeDefined();
  const {default:JSZip}=await import('jszip');const zip=await JSZip.loadAsync(bytes);const sheet=await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  const eventColumn=MOVEMENT_IMPORT_HEADERS.indexOf('EventType'),companyColumn=MOVEMENT_IMPORT_HEADERS.indexOf('Company Id');
  expect(eventColumn).toBeGreaterThanOrEqual(0);expect(companyColumn).toBeGreaterThanOrEqual(0);expect(eventColumn).not.toBe(companyColumn);
  const eventLetter=XLSX.utils.encode_col(eventColumn),companyLetter=XLSX.utils.encode_col(companyColumn),name=`AIHR_Personnel_0_${eventColumn}`;
  const validations=[...sheet.matchAll(/<dataValidation\b[^>]*>[\s\S]*?<\/dataValidation>/g)].map(match=>match[0]);
  expect(validations).toHaveLength(1);expect(validations[0]).toContain(`sqref="${eventLetter}2:${eventLetter}201"`);expect(validations[0]).toContain(`<formula1>${name}</formula1>`);
  expect(validations[0]).not.toContain(`sqref="${companyLetter}2:${companyLetter}201"`);
  const workbook=await zip.file('xl/workbook.xml')!.async('string');
  expect(workbook).toContain(`<definedName name="${name}">&apos;Lists&apos;!$A$2:$A$${catalog.types.length+1}</definedName>`);
  expect(wb.Workbook?.Names?.find(item=>item.Name===name)?.Ref).toBe(`'Lists'!$A$2:$A$${catalog.types.length+1}`);
  const lists=XLSX.utils.sheet_to_json<(string|number)[]>(wb.Sheets.Lists,{header:1});
  expect(lists.flat()).toContain('company-a · Fictional Company');
  expect(lists.flat()).toContain('regional_assignment · Regional Assignment');
  expect(wb.Sheets.Movements[XLSX.utils.encode_cell({r:0,c:eventColumn})]?.v).toBe('EventType');
  expect(wb.Sheets.Movements[XLSX.utils.encode_cell({r:0,c:companyColumn})]?.v).toBe('Company Id');
  const decoded=await workbookToCsvTexts(bytes,[],false,['Instructions','Lists']);expect(parseMovementImport(decoded.first).fileErrors).toEqual(['no_data_rows']);
 });
});
