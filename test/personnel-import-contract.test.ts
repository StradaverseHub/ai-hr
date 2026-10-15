import { describe,it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePersonnelImportCsv, personnelColumnLabel, personnelImportField, personnelScalarIssue } from '../lib/personnel-import-contract';
import { IMPORT_COLUMNS, DEPENDENT_IMPORT_COLUMNS } from '../lib/import-schema';
import { buildTemplateCsv,employeeTemplate } from '../lib/import-template';
import { sectionColumns } from '../lib/import-sections';
import { PERSONNEL_FIELDS } from '../lib/personnel-field-registry';
const columns=[...IMPORT_COLUMNS.required,...IMPORT_COLUMNS.optional];
const resolve=(locale:string)=>(key:string,fallback:string)=>{
  let value:unknown=JSON.parse(readFileSync(new URL(`../messages/${locale}.json`,import.meta.url),'utf8'));
  for(const part of key.split('.'))value=value && typeof value==='object' ? (value as Record<string,unknown>)[part] : undefined;
  return typeof value==='string'?value:fallback;
};
describe('Personnel forms and file contract',()=>{
  it('round-trips every generated column and existing sample value after required-order changes',()=>{
    const parsed=parsePersonnelImportCsv(buildTemplateCsv(employeeTemplate),{columns});
    expect(parsed.headers).toEqual(employeeTemplate.columns.map(column=>column.key));
    expect(parsed.records[0]).toMatchObject({full_name:'Aisyah Binti Rahman',email:'aisyah.template@example.com',ic_number:'770214086521',basic_salary:'5000',employee_code:'TMPL0001',direct_superior:'TMPL0002'});
    expect(parsed.warnings).toEqual([]);
  });
  it.each(['en','ms','ta','th','vi','zh'])('accepts downloaded %s headings without technical normalization guesses',locale=>{
    const resolver=resolve(locale);const text=buildTemplateCsv(employeeTemplate,resolver);
    const parsed=parsePersonnelImportCsv(text,{columns,resolvers:[resolver]});
    expect(parsed.records[0].employee_code).toBe('TMPL0001');
    expect(parsed.headers).toEqual(employeeTemplate.columns.map(column=>column.key));
    expect(parsed.warnings).toEqual([]);
  });
  it('refuses repeated old/new headings before either cell can overwrite the other',()=>{
    expect(()=>parsePersonnelImportCsv(`employee_code,${personnelColumnLabel('employee_code')}\nA001,A002`,{columns})).toThrow(/repeats/);
    expect(()=>parsePersonnelImportCsv('employee_code,employee_code\nA001,A002',{columns})).toThrow(/repeats/);
  });
  it('warns for one generation then expires technical aliases explicitly',()=>{
    expect(parsePersonnelImportCsv('full_name\nExample Person',{columns,generation:2}).warnings[0]).toContain('Older header');
    expect(()=>parsePersonnelImportCsv('full_name\nExample Person',{columns,generation:3})).toThrow(/Unrecognized or removed/);
  });
  it('refuses removed or unknown headers instead of silently discarding populated cells',()=>{
    expect(()=>parsePersonnelImportCsv('removed_employee_fact\nimportant',{columns})).toThrow(/cannot be applied/);
  });
  it('qualifies repeated address labels and keeps Family names on the dependent grain',()=>{
    expect(personnelColumnLabel('address_line_1')).not.toBe(personnelColumnLabel('correspondence_address_line_1'));
    expect(personnelImportField('full_name','family')?.owner).toBe('dependent');
    const family=[...DEPENDENT_IMPORT_COLUMNS.required,...DEPENDENT_IMPORT_COLUMNS.optional];
    const result=parsePersonnelImportCsv('employee_code,full_name,relationship\nA001,Child One,child\nA001,Child Two,child',{columns:family,sheet:'family'});
    expect(result.records.map(row=>row.employee_code)).toEqual(['A001','A001']);
  });
  it('adds ordinary Profile fields to both full and section templates from the declaration',()=>{
    for(const field of PERSONNEL_FIELDS.filter(field=>field.import.writer)) {
      expect(columns).toContain(field.import.column);
      expect(sectionColumns('profile')).toContain(field.import.column);
    }
    expect(IMPORT_COLUMNS.required).not.toContain('ic_number');
    expect(IMPORT_COLUMNS.required).not.toContain('basic_salary');
  });
  it('uses the same date and choice refusal as Personnel, including impossible leap dates',()=>{
    const birth=personnelImportField('date_of_birth')!;
    expect(personnelScalarIssue(birth,'2024-02-29')).toBeNull();
    expect(personnelScalarIssue(birth,'2025-02-29')).toBe('date');
    expect(personnelScalarIssue(birth,'2025-04-31')).toBe('date');
    expect(personnelScalarIssue(personnelImportField('gender')!,'invented')).toBe('choice');
  });
  it('resolves localized choice names using the same option labels as the Personnel select',()=>{
    const resolver=resolve('ms');
    const heading=personnelColumnLabel('gender','employee',resolver);
    const parsed=parsePersonnelImportCsv(`${heading}\n${resolver('people.detail.genderFemale','female')}`,{columns,resolvers:[resolver]});
    expect(parsed.records[0].gender).toBe('female');
  });
});
