import {describe,it,expect} from 'vitest';
import {PersonnelImportLookup} from '../lib/personnel-import-lookup';
import {PersonnelImportCatalog,normalizePersonnelCatalogRecord} from '../lib/personnel-import-catalog';
import {employeeTemplate} from '../lib/import-template';
import {EMPLOYEE_XLSX_COLUMNS} from '../lib/import-template-xlsx';
import {personnelImportField} from '../lib/personnel-import-contract';
import {personnelOrganisationRepairInventory} from '../lib/personnel-organisation-repair-inventory';

describe('full hire organisation contract',()=>{
 it('prefers trimmed case-insensitive labels over a different record code, without changing the default contract',()=>{
  for(const reversed of [false,true]){
   const rows=[{id:'label-owner',code:'DP0001',label:'Green integrated base stabiliser'},{id:'code-owner',code:'GREEN INTEGRATED BASE STABILISER',label:'Other'}];
   const explicit=new PersonnelImportLookup<string>('label-first');const unchanged=new PersonnelImportLookup<string>();
   for(const row of reversed?[...rows].reverse():rows)for(const lookup of [explicit,unchanged])lookup.add(row.id,row.id,{codes:[row.code],names:[row.label]});
   expect(explicit.get('  GREEN INTEGRATED BASE STABILISER  ')).toBe('label-owner');
   expect(explicit.get(' dp0001 ')).toBe('label-owner');
   expect(unchanged.get('Green integrated base stabiliser')).toBe('code-owner');
  }
 });
 it('refuses ambiguous labels even where the submitted text matches an exact code',()=>{
  const lookup=new PersonnelImportLookup<string>('label-first');
  lookup.add('a','a',{codes:['SHARED'],names:['Shared']}).add('b','b',{codes:['B'],names:[' shared ']});
  expect(lookup.get('SHARED')).toBeUndefined();expect(lookup.isAmbiguous('Shared')).toBe(true);
  const blank=new PersonnelImportLookup<string>('label-first');blank.add('c','c',{codes:['Customer Service'],names:['  ']});
  expect(blank.get(' customer service ')).toBe('c');
 });
 it('keeps organisation profile values as canonical codes and only opts the full-import categories into label-first',()=>{
  const catalog=new PersonnelImportCatalog(new Set(['division']));
  catalog.addOption({category:'division',value:'DIV-A',label:'Shared'});catalog.addOption({category:'division',value:'Shared',label:'Other'});
  catalog.addOption({category:'division',value:'OLD',label:'Retired',isActive:false});
  expect(normalizePersonnelCatalogRecord({org_division:' shared '},'employee',catalog).record.org_division).toBe('DIV-A');
  expect(catalog.resolve('division','Retired').value).toBeUndefined();
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
