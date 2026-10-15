import {PersonnelImportCatalog,normalizePersonnelCatalogRecord,personnelCatalogReferenceValues} from '../lib/personnel-import-catalog';
import {it,expect} from 'vitest';
import {PersonnelImportLookup,addUniqueImportAlias} from '../lib/personnel-import-lookup';
import {dependentImportMatch} from '../lib/dependent-identity';
it('refuses shared human labels regardless of query order but accepts exact IDs and codes',()=>{
 for(const reversed of [false,true]) {
  const rows=[{id:'company-a',code:'REG-A',name:'Shared'},{id:'company-b',code:'REG-B',name:'Shared'}];
  const lookup=new PersonnelImportLookup<string>();
  for(const row of reversed?rows.reverse():rows)lookup.add(row.id,row.id,{codes:[row.code],names:[row.name]});
  expect(lookup.get('Shared')).toBeUndefined();expect(lookup.isAmbiguous('SHARED')).toBe(true);
  expect(lookup.get('REG-A')).toBe('company-a');expect(lookup.get('company-b')).toBe('company-b');
 }
});
it('treats labels matching another legal name as ambiguous and deduplicates one record aliases',()=>{
 const lookup=new PersonnelImportLookup<string>();lookup.add('a','a',{names:['One','Shared','Shared']});lookup.add('b','b',{names:['Shared']});
 expect(lookup.get('One')).toBe('a');expect(lookup.get('Shared')).toBeUndefined();
 const email=new Map<string,string|null>();addUniqueImportAlias(email,'same@fixture.test','employment-a');addUniqueImportAlias(email,'same@fixture.test','employment-b');
 expect(email.get('same@fixture.test')).toBeNull();
});
it('retains distinct same-name children and refuses uncertain identity instead of skipping',()=>{
 const first={fullName:'Same Child',relationship:'child',dateOfBirth:'2015-01-01',icOrPassport:'ID-A'};
 expect(dependentImportMatch([first],{...first,dateOfBirth:'2017-01-01'})).toBe('new');
 expect(dependentImportMatch([first],{...first,icOrPassport:'ID-B'})).toBe('new');
 expect(dependentImportMatch([first],{...first,icOrPassport:''})).toBe('ambiguous');
 expect(dependentImportMatch([first],{...first})).toBe('existing');
 expect(dependentImportMatch([first],{...first,icOrPassport:'',passportNumber:'OTHER'})).toBe('ambiguous');
});

it('resolves fresh catalog display names to saved values and refuses ambiguous labels',()=>{
 const options=[{category:'religion',value:'CODE-A',label:'Shared faith'},{category:'religion',value:'CODE-B',label:'Shared faith'},{category:'religion',value:'CODE-C',label:'Distinct faith'}];
 const catalog=new PersonnelImportCatalog();for(const option of options)catalog.addOption(option);
 expect(normalizePersonnelCatalogRecord({religion:'Distinct faith'},'employee',catalog)).toEqual({record:{religion:'CODE-C'},errors:[]});
 expect(normalizePersonnelCatalogRecord({religion:'Shared faith'},'employee',catalog).errors[0]).toContain('ambiguous');
 expect(normalizePersonnelCatalogRecord({religion:'CODE-A'},'employee',catalog).record.religion).toBe('CODE-A');
 expect(personnelCatalogReferenceValues(options)).toEqual(['CODE-A','CODE-B','CODE-C','Distinct faith']);
});
