import {describe,expect,it} from 'vitest';
import {parsePersonnelImportCsv} from '../lib/personnel-import-contract';
import {IMPORT_COLUMNS} from '../lib/import-schema';
const columns=[...IMPORT_COLUMNS.required,...IMPORT_COLUMNS.optional];
describe('bounded whole-file legacy Personnel technical header grammar',()=>{
 it('keeps permanent and correspondence postcodes on their distinct owners in an exact technical file',()=>{
  const parsed=parsePersonnelImportCsv('full_name,postcode,correspondence_postcode\nFictional Person,00123,00456',{columns,generation:2});
  expect(parsed.headers).toEqual(['full_name','postcode','correspondence_postcode']);
  expect(parsed.records).toEqual([{full_name:'Fictional Person',postcode:'00123',correspondence_postcode:'00456'}]);
  expect(parsed.warnings.some(warning=>warning.includes('Older header “postcode”'))).toBe(true);
 });
 it.each(['postcode','Postcode','full_name,Postcode','full_name,Home phone','home_phone,Home phone'])('refuses ambiguous standalone or mixed display headings: %s',header=>{
  expect(()=>parsePersonnelImportCsv(header+'\n'+header.split(',').map(()=>'00123').join(','),{columns,generation:2})).toThrow(/Ambiguous column/);
 });
 it('retains duplicate refusal inside the technical file grammar',()=>{
  expect(()=>parsePersonnelImportCsv('full_name,postcode,postcode\nPerson,00123,00456',{columns,generation:2})).toThrow(/repeats/);
 });
 it('expires the entire technical file grammar in generation3',()=>{
  expect(()=>parsePersonnelImportCsv('full_name,postcode,correspondence_postcode\nPerson,00123,00456',{columns,generation:3})).toThrow(/Unrecognized or removed/);
 });
 it('never accepts an unknown technical column alongside otherwise valid keys',()=>{
  expect(()=>parsePersonnelImportCsv('full_name,unknown_person_fact\nPerson,Important',{columns,generation:2})).toThrow(/Unrecognized or removed/);
 });
});
