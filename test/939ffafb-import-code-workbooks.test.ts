import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';
import { buildXlsx, MAX_TEMPLATE_LIST_VALUES } from '../lib/spreadsheet';
import { buildReferenceRows, EMPLOYEE_XLSX_COLUMNS } from '../lib/import-template-xlsx';
import { personnelCatalogReferenceValues } from '../lib/personnel-import-catalog';
import { personnelReferenceOptions, personnelTemplateReferenceLists } from '../lib/personnel-template-reference';
import { personnelImportFields, personnelColumnLabel, type PersonnelImportSheet } from '../lib/personnel-import-contract';
import { sectionTemplateColumns, type ImportSection } from '../lib/import-sections';

const categories = ['division','branch','region','line','section','team','base','category','state','country','nationality','relationship','dependentRelationship','qualificationLevel'];
const options = Object.fromEntries(categories.map(category => [category, [
  { value: `${category}-001`, label: 'Shared display label' },
  { value: `${category}-002`, label: 'Shared display label' },
]]));
const reference = {
  catalogs: Object.fromEntries(Object.entries(options).map(([category,rows]) => [category, rows.map(row => row.value)])),
  catalogOptions: options, nationalities: options.nationality.map(row => row.value), familyRelationships: options.dependentRelationship.map(row => row.value),
};
const caption = (column:string) => column;
const label = (key:string,fallback:string) => `Readable ${fallback}`;

describe('939ffafb workbook cells use codes while Reference explains labels', () => {
  it('never offers a label alias, including a unique label or one that matches another code', () => {
    expect(personnelCatalogReferenceValues([
      {category:'base',value:'001',label:'Head office'}, {category:'base',value:'002',label:'001'},
    ])).toEqual(['001','002']);
    expect(personnelReferenceOptions([{value:'001',label:' '},{value:'A<&"1',label:'Readable & safe'}])).toEqual([
      {value:'001',label:'001'}, {value:'A<&"1',label:'Readable & safe'},
    ]);
  });
  it('covers every full import configured organisation dimension and the fixed employment type', () => {
    const lists=personnelTemplateReferenceLists('employee',EMPLOYEE_XLSX_COLUMNS,reference,caption,label);
    for(const category of categories.slice(0,8)) {
      const field=personnelImportFields('employee').find(field=>field.import.catalog===category)!;
      expect(field,category).toBeDefined();
      expect(lists.find(list=>list.column===field.import.column)?.values).toEqual(options[category].map(row=>row.value));
    }
    expect(lists.find(list=>list.column==='employment_type')?.values).toEqual(['full_time','part_time','contract','intern']);
    expect(lists.find(list=>list.column==='passport_issuing_country')?.values).toEqual(reference.nationalities);
  });
  it.each(['profile','bank_statutory','family','qualification','emergency'] as const)('%s update lists use the same exact codes as full and related sheets', section => {
    const sheet:PersonnelImportSheet=section==='family'||section==='qualification'||section==='emergency'?section:'employee';
    const columns=sectionTemplateColumns(section as ImportSection);
    const lists=personnelTemplateReferenceLists(sheet,columns,reference,caption,label);
    expect(lists.length).toBeGreaterThan(0);
    for(const list of lists) {
      expect(list.values).toEqual([...new Set(list.entries!.map(entry=>entry.value))]);
      expect(list.values).not.toContain('Shared display label');
      expect(columns).toContain(list.column);
    }
  });
  it.each(['en','ms','zh','ta','th','vi'])('%s keeps system values independent of translated captions', locale => {
    const messages=JSON.parse(readFileSync(new URL(`../messages/${locale}.json`,import.meta.url),'utf8'));
    const resolve=(key:string,fallback:string)=>key.split('.').reduce((row,part)=>row?.[part],messages)??fallback;
    const lists=personnelTemplateReferenceLists('employee',EMPLOYEE_XLSX_COLUMNS,reference,column=>personnelColumnLabel(column,'employee',resolve),resolve);
    expect(lists.find(list=>list.column==='employment_type')?.values).toEqual(['full_time','part_time','contract','intern']);
    expect(lists.find(list=>list.column==='org_base')?.values).toEqual(['base-001','base-002']);
    expect(messages.people.import.instructionImportCodes).toBeTruthy();
    expect(messages.people.import.instructionLargeLists).toBeTruthy();
  });
  it('writes named code-only ranges, Reference pairs, text identifiers and escaped XML on every repeated sheet', async () => {
    const values=['001','A<&"1'];
    const refs={...reference,catalogOptions:{...options,base:values.map(value=>({value,label:'Shared label'})),qualificationLevel:values.map(value=>({value,label:'Shared qualification'})),relationship:values.map(value=>({value,label:'Shared relationship'}))},catalogs:{...reference.catalogs,base:values,qualificationLevel:values,relationship:values}};
    const sheets=(['employee','family','qualification','emergency'] as const).map(sheet=>{
      const columns=sheet==='employee'?['employee_code','org_base']:sheet==='family'?['employee_code','relationship']:sheet==='qualification'?['employee_code','qualification']:['employee_code','relationship'];
      const lists=personnelTemplateReferenceLists(sheet,columns,refs,caption,label);
      return {sheet,columns,lists};
    });
    const first=sheets[0];
    const bytes=await buildXlsx(first.columns,[['000123','001']],{sheetName:'Employee Import',textColumns:[0],validationLists:first.lists.map(list=>({column:first.columns.indexOf(list.column),values:list.values})),extraSheets:[
      ...sheets.slice(1).map(({sheet,columns,lists})=>({name:sheet,rows:[columns],textColumns:[0],validationLists:lists.map(list=>({column:columns.indexOf(list.column),values:list.values}))})),
      {name:'Reference',rows:buildReferenceRows('Codes',sheets.flatMap(sheet=>sheet.lists),{code:'Code',label:'Label'})},
    ]});
    const zip=await JSZip.loadAsync(bytes),book=XLSX.read(bytes,{type:'array',cellNF:true});
    expect(book.Workbook?.Names).toHaveLength(4);
    for(const name of book.Workbook!.Names!) {
      const resolved=XLSX.utils.decode_range(name.Ref.split('!')[1].replaceAll('$',''));
      const values=XLSX.utils.sheet_to_json<string[]>(book.Sheets.__PersonnelLists,{header:1,raw:true}).slice(resolved.s.r,resolved.e.r+1).map(row=>row[resolved.s.c]);
      const sheetIndex=Number(name.Name.split('_')[2]);
      expect(values).toEqual(sheets[sheetIndex].lists[0].values);
      const xml=await zip.file(`xl/worksheets/sheet${sheetIndex+1}.xml`)!.async('string');
      expect(xml).toContain(`<formula1>${name.Name}</formula1>`);
      expect(xml).toContain('sqref="B2:B501"');
      expect(book.Sheets[book.SheetNames[sheetIndex]].B501.z).toBe('@');
    }
    const listXml=await zip.file(`xl/worksheets/sheet${book.SheetNames.indexOf('__PersonnelLists')+1}.xml`)!.async('string');
    expect(listXml).not.toContain('Shared label');
    expect(listXml).toContain('&amp;'); expect(listXml).toContain('&lt;');
    expect(book.Sheets['Employee Import'].A2.v).toBe('000123');
    const rows=XLSX.utils.sheet_to_json<string[]>(book.Sheets.Reference,{header:1});
    expect(rows).toContainEqual(['001','Shared label']);
    expect(rows).toContainEqual(['A<&"1','Shared label']);
  });
  it('retains every oversized code on Reference and explains the bounded dropdown fallback on the data header', async () => {
    const values=Array.from({length:MAX_TEMPLATE_LIST_VALUES+1},(_,i)=>String(i).padStart(5,'0'));
    const note='Copy the exact code from Reference. The complete list is too large for a dropdown.';
    const bytes=await buildXlsx(['Base'],[],{validationLists:[{column:0,values}],validationListFallbackNote:note,extraSheets:[{name:'Reference',rows:buildReferenceRows('Codes',[{label:'Base',values,entries:values.map(value=>({value,label:`Office ${value}`}))}],{code:'Code',label:'Label'})}]});
    const zip=await JSZip.loadAsync(bytes),book=XLSX.read(bytes,{type:'array',cellNF:true});
    expect(await zip.file('xl/worksheets/sheet1.xml')!.async('string')).not.toContain('<dataValidations');
    expect(book.Sheets['Leave Import'].A1.c?.some(comment=>comment.t===note)).toBe(true);
    expect(book.Sheets['Leave Import'].A501.z).toBe('@');
    const rows=XLSX.utils.sheet_to_json<string[]>(book.Sheets.Reference,{header:1});
    for(const value of values)expect(rows).toContainEqual([value,`Office ${value}`]);
  });
});
