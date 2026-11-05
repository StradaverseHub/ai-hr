import {organisationBusinessUnit} from '../core/organisation-write-policy';
import {describe,it,expect} from 'vitest';
import * as XLSX from 'xlsx';
import {parsePersonnelImportCsv} from '../lib/personnel-import-contract';
import {movementRowsToRecords} from '../lib/movement-import-rows';
import {parseInformationWorkbook} from '../lib/information-correction-workbook';
import {INFORMATION_HEADERS} from '../lib/information-correction';
describe('derived organisation import transport',()=>{
 it('separates global manual-authority activation from the retained historic date',()=>{
  const legacy={status:'legacy',businessUnitId:null};expect(organisationBusinessUnit(legacy,false,'submitted','stored')).toBe('submitted');expect(organisationBusinessUnit(legacy,false,undefined,'stored')).toBe('stored');expect(organisationBusinessUnit(legacy,false,null,'stored')).toBeNull();expect(organisationBusinessUnit(legacy,true,'submitted','stored')).toBe('stored');expect(organisationBusinessUnit(legacy,true,'submitted')).toBeNull();expect(organisationBusinessUnit({status:'ready',businessUnitId:'canonical'},true,'submitted','stored')).toBe('canonical');
 });
 it('retains optional parent company only as ignored review input in the full hire parser',()=>{
  const parsed=parsePersonnelImportCsv('business_unit,Parent company\nManual BU,Manual Parent',{columns:['business_unit']});
  expect(parsed.records).toEqual([{business_unit:'Manual BU',parent_company:'Manual Parent'}]);
  expect(()=>parsePersonnelImportCsv('business_unit,Parent company,parent_company\nManual BU,A,B',{columns:['business_unit']})).toThrow('repeats');
 });
 it('keeps Movement parent values outside writable field cells and preserves the original source row',()=>{
  const parsed=movementRowsToRecords([{row:2,values:['DEMO','EMP001','Fictional Employee','2026-11-04','Transfer','Parent company','','Untrusted Parent']}],[{code:'transfer',label:'Transfer',behaviour:'transfer'}],[(_key,fallback)=>fallback]);
  expect(parsed.fileErrors).toEqual([]);expect(parsed.records).toHaveLength(1);expect(parsed.records[0]).toMatchObject({sourceRows:[2],ignoredOrganisation:{parentCompany:'Untrusted Parent'},errors:[]});
  expect(parsed.records[0].cells).not.toHaveProperty('parentCompanyId');
 });
 it('accepts only the two explicit ignored optional Information columns and refuses duplicate or arbitrary columns',()=>{
  const workbook=(headers:string[])=>{const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([headers,['DEMO','EMP001','Fictional Employee','','','','','','Reviewed correction','Manual BU','Manual Parent']]),'Corrections');return Buffer.from(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));};
  const rows=parseInformationWorkbook(workbook([...INFORMATION_HEADERS,'Business Unit','Parent company']));expect(rows[0]).toMatchObject({ignoredOrganisation:{businessUnit:'Manual BU',parentCompany:'Manual Parent'},errors:[]});expect(rows[0].values).not.toHaveProperty('Business Unit');
  expect(()=>parseInformationWorkbook(workbook([...INFORMATION_HEADERS,'Business Unit','Business Unit']))).toThrow('repeats');expect(()=>parseInformationWorkbook(workbook([...INFORMATION_HEADERS,'Arbitrary field']))).toThrow('columns changed');
 });
});
