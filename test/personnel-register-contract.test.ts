import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe,expect,it} from 'vitest';
import {personnelImportFields,personnelColumnLabel,parsePersonnelImportCsv} from '../lib/personnel-import-contract';
import {PERSONNEL_REGISTER_KINDS,PERSONNEL_REGISTER_SHEETS,personnelRegisterColumns,personnelRegisterInput} from '../lib/personnel-register-import';
import {SECTION_TEMPLATE_FILENAMES,sectionTemplateColumns,foreignColumns} from '../lib/import-sections';
import {readImportFile} from '../lib/import-file';
import {buildXlsx} from '../lib/spreadsheet';
import {toCsv} from '../lib/csv';
const source=(file:string)=>readFileSync(path.join(process.cwd(),file),'utf8');

describe('Personnel repeated-register file contract',()=>{
  it('projects all nine Qualification and seven Emergency fields without flattening existing Profile columns',()=>{
    expect(personnelImportFields('qualification')).toHaveLength(9);expect(personnelImportFields('emergency')).toHaveLength(7);
    for(const kind of PERSONNEL_REGISTER_KINDS) {
      expect(personnelRegisterColumns(kind).slice(0,2)).toEqual(['employee_code','record_id']);
      expect(sectionTemplateColumns(kind)).toEqual(personnelRegisterColumns(kind));
      expect(SECTION_TEMPLATE_FILENAMES[kind]).toMatch(/update-template.xlsx$/);
    }
    expect(personnelImportFields('employee').find(field=>field.import.column==='emergency_contact_phone')?.import.writerField).toBe('emergencyContactPhone');
    expect(foreignColumns('profile',['qualification'])).toEqual(['qualification']);
  });
  it('parses all six localized headings, preserves month precision and distinguishes explicit create/update',()=>{
    for(const locale of ['en','ms','zh','ta','th','vi']) {
      const messages=JSON.parse(source(`messages/${locale}.json`));
      const resolve=(key:string,fallback:string)=>key.split('.').reduce((value,part)=>value?.[part],messages)??fallback;
      const columns=personnelRegisterColumns('qualification');
      const cells:Record<string,string>={employee_code:'REG001',qualification:'Bachelor',from_ym:'2020-03',to_ym:'2023-12',is_highest:messages.people.import.registerYes};
      const text=toCsv([columns.map(column=>personnelColumnLabel(column,'qualification',resolve)),columns.map(column=>cells[column]??'')]);
      const parsed=parsePersonnelImportCsv(text,{columns,sheet:'qualification',resolvers:[resolve]});
      expect(parsed.records[0]).toMatchObject({employee_code:'REG001',record_id:'',from_ym:'2020-03',is_highest:'true'});
      expect(personnelRegisterInput('qualification',parsed.records[0])).toMatchObject({recordId:'',input:{fromYm:'2020-03',isHighest:true},errors:[]});
      expect(messages.people.import.registerInstructions).toContain('YYYY-MM');
      expect(messages.people.import.unexpectedSheet.length).toBeGreaterThan(10);
    }
  });
  it('refuses duplicate old/current headers and malformed record IDs instead of matching names or positions',()=>{
    const columns=personnelRegisterColumns('emergency');
    expect(()=>parsePersonnelImportCsv('employee_code,record_id,Record ID (existing records only),full_name\nREG001,,,Contact',{columns,sheet:'emergency'})).toThrow(/repeat/);
    expect(personnelRegisterInput('emergency',{employee_code:'REG001',record_id:'Contact number 1',full_name:'Name'}).errors.join(' ')).toContain('canonical');
  });
  it('reads Family plus both register sheets from one actual workbook and keeps YYYY-MM strings intact',async()=>{
    const bytes=await buildXlsx(['employee_code'],[['REG001']],{sheetName:'Employee Import',extraSheets:[
      {name:'Family',rows:[['employee_code','full_name'],['REG001','Child']]},
      {name:PERSONNEL_REGISTER_SHEETS.qualification,rows:[['employee_code','from_ym'],['REG001','2020-03']],textColumns:[0,1]},
      {name:PERSONNEL_REGISTER_SHEETS.emergency,rows:[['employee_code','full_name'],['REG001','Contact']]},
      {name:'Instructions',rows:[['Guidance']]},
    ]});
    const file=new File([bytes as BlobPart],'registers.xlsx');
    const decoded=await readImportFile(file,{extraSheets:['Family',...Object.values(PERSONNEL_REGISTER_SHEETS)],allowedSheets:['Family',...Object.values(PERSONNEL_REGISTER_SHEETS),'Instructions']});
    expect(decoded.dependentsText).toContain('Child');expect(decoded.extraTexts?.Qualifications).toContain('2020-03');expect(decoded.extraTexts?.['Emergency Contacts']).toContain('Contact');
  });
  it('refuses unknown nonempty or duplicate-normalized tables rather than silently losing their rows',async()=>{
    for(const names of [['Renamed Qualifications'],['Qualifications',' qualifications ']]) {
      const bytes=await buildXlsx(['employee_code'],[['REG001']],{extraSheets:names.map(name=>({name,rows:[['employee_code','qualification'],['REG001','Bachelor']]}))});
      await expect(readImportFile(new File([bytes as BlobPart],'unexpected.xlsx'),{extraSheets:['Qualifications'],allowedSheets:['Qualifications']})).rejects.toMatchObject({code:'UNEXPECTED_SHEET'});
    }
  });
  it('binds full register writes to the employee transaction and preserves real domain writers',()=>{
    const full=source('core/import.ts');const begin=full.indexOf('await withTenant(ctx,async tx=>{',full.indexOf('export async function commitEmployeeImport'));
    const end=full.indexOf('} catch(error)',begin);expect(begin).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(begin);
    const body=full.slice(begin,end);expect(body.length).toBeGreaterThan(1000);expect(body).toContain('writeRegisterRowsTx(tx,ctx,register.preview.kind,register.resolved,registerSubjects)');
    const registers=source('core/personnel-register-import.ts');expect(registers).toContain('app.is_admin_for');expect(registers).toContain(".for('update')");
    for(const writer of ['addQualification','updateQualification','addEmergencyContact','updateEmergencyContact'])expect(registers).toContain(`${writer}(ctx,`);
    expect(registers).not.toMatch(/\.insert\(|\.update\(/);
    expect(source('app/(app)/admin/personnel/import/employee-import.tsx')).toContain('registerTexts');
  });
});
