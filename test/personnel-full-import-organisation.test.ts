import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {PersonnelImportLookup} from '../lib/personnel-import-lookup';
import {PersonnelImportCatalog,normalizePersonnelCatalogRecord} from '../lib/personnel-import-catalog';
import {employeeTemplate} from '../lib/import-template';
import {EMPLOYEE_XLSX_COLUMNS} from '../lib/import-template-xlsx';
import {personnelImportField} from '../lib/personnel-import-contract';
import {personnelOrganisationRepairInventory} from '../lib/personnel-organisation-repair-inventory';

describe('full hire organisation contract',()=>{
 it('prefers canonical codes over another record label regardless of catalogue order',()=>{
  for(const reversed of [false,true]){
   const rows=[{id:'label-owner',code:'DP0001',label:'Green integrated base stabiliser'},{id:'code-owner',code:'GREEN INTEGRATED BASE STABILISER',label:'Other'}];
   const lookup=new PersonnelImportLookup<string>();
   for(const row of reversed?[...rows].reverse():rows)lookup.add(row.id,row.id,{codes:[row.code],names:[row.label]});
   expect(lookup.get('  GREEN INTEGRATED BASE STABILISER  ')).toBe('code-owner');
   expect(lookup.get(' dp0001 ')).toBe('label-owner');
  }
 });
 it('accepts an exact code despite ambiguous legacy labels but refuses duplicate codes',()=>{
  const lookup=new PersonnelImportLookup<string>();
  lookup.add('a','a',{codes:['SHARED'],names:['Shared']}).add('b','b',{codes:['B'],names:[' shared ']});
  expect(lookup.get('SHARED')).toBe('a');expect(lookup.isAmbiguous('Shared')).toBe(false);
  lookup.add('c','c',{codes:[' shared '],names:['Distinct']});
  expect(lookup.get('SHARED')).toBeUndefined();expect(lookup.isAmbiguous('Shared')).toBe(true);
  const blank=new PersonnelImportLookup<string>();blank.add('c','c',{codes:['Customer Service'],names:['  ']});
  expect(blank.get(' customer service ')).toBe('c');
 });
 it('keeps organisation profile values as canonical codes with unambiguous label fallback',()=>{
  const catalog=new PersonnelImportCatalog();
  catalog.addOption({category:'division',value:'DIV-A',label:'Shared'});catalog.addOption({category:'division',value:'Shared',label:'Other'});
  catalog.addOption({category:'division',value:'OLD',label:'Retired',isActive:false});
  expect(normalizePersonnelCatalogRecord({org_division:' shared '},'employee',catalog).record.org_division).toBe('Shared');
  expect(normalizePersonnelCatalogRecord({org_division:'Other'},'employee',catalog).record.org_division).toBe('Shared');
  expect(catalog.resolve('division','Retired').value).toBeUndefined();
  expect(catalog.display('division','DIV-A')).toBe('Shared (DIV-A)');
 });
 it('binds Personnel Category display to its live owner label, retaining the canonical code as fallback',()=>{
  const page=readFileSync(new URL('../app/(app)/admin/personnel/[employmentId]/page.tsx',import.meta.url),'utf8');
  const start=page.indexOf('<PersonnelField fieldId="employment.additional_organisation_labels.employmentcategory"');
  expect(start).toBeGreaterThanOrEqual(0);
  const end=page.indexOf('</PersonnelField>',start);expect(end).toBeGreaterThan(start);
  const field=page.slice(start,end);expect(field.length).toBeGreaterThan(200);
  expect(field).toContain('profileOptions.category.find(option=>option.value===emp.employmentCategory)?.label?.trim() || emp.employmentCategory');
 });
 it('keeps the default category catalogue identifier-first for unrelated import consumers',()=>{
  const catalog=new PersonnelImportCatalog();
  catalog.addOption({category:'category',value:'CAT-A',label:'Shared'});catalog.addOption({category:'category',value:'Shared',label:'Other'});
  expect(normalizePersonnelCatalogRecord({employment_category:'Shared'},'employee',catalog).record.employment_category).toBe('Shared');
 });
 it('includes creation-only BU and grade in both formats using their existing Personnel labels',()=>{
  for(const column of ['business_unit','job_grade']){
   expect(employeeTemplate.columns.map(column=>column.key)).toContain(column);
   expect(EMPLOYEE_XLSX_COLUMNS).toContain(column);
   expect(personnelImportField(column)?.import.disabledReason).toContain('later changes require Movement');
  }
  expect(personnelImportField('business_unit')?.label).toBe('Business Unit');
  expect(personnelImportField('job_grade')?.label).toBe('Job Grade');
 });
 it('inventory preserves valid UUIDs and refuses foreign, inactive, ambiguous and absent references without a writer',()=>{
  const choices=[{id:'id-a',tenantId:'t',companyIds:['a'],active:true,code:'DP1',label:'Same'},{id:'id-b',tenantId:'t',companyIds:['a'],active:true,code:'DP2',label:'Same'},{id:'id-x',tenantId:'t',companyIds:['b'],active:true,code:'Foreign',label:'Foreign'}];
  const rows=['id-a','DP1','Same','Foreign','00000000-0000-0000-0000-000000000001'].map((reference,index)=>({assignmentId:String(index),tenantId:'t',companyId:'a',reference}));
  const result=personnelOrganisationRepairInventory({tenantId:'t',companyIds:['a']},[...rows,{...rows[0],assignmentId:'foreign-row',companyId:'b'}],choices);
  expect(result.map(row=>row.status)).toEqual(['valid-reference','unique-text-candidate','ambiguous','unmatched','missing-reference']);
  expect(result).toHaveLength(5);expect(result[1]).toMatchObject({candidateId:'id-a'});
  expect(rows[0].reference).toBe('id-a');
 });
});
