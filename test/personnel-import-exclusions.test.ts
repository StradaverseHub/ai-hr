import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {personnelImportExclusions,personnelImportExclusionReasonKey,personnelImportExclusionEntries,personnelImportExclusionRows} from '../lib/personnel-import-exclusions';

describe('registry-owned import exclusions',()=>{
  it('accounts for every actual exclusion with a localized explanation, never an unknown fallback',()=>{
    const exclusions=personnelImportExclusions('full');
    expect(exclusions.length).toBeGreaterThan(50);
    for(const field of exclusions){
      expect(field.import.column,field.id).toBeUndefined();
      expect(field.import.register,field.id).toBeUndefined();
      expect(field.import.disabledReason,field.id).toBeTruthy();
      const key=personnelImportExclusionReasonKey(field);
      expect(key,field.id+': '+field.import.disabledReason).toBeTruthy();
      for(const locale of ['en','ms','zh','ta','th','vi']){
        const messages=JSON.parse(readFileSync(new URL(`../messages/${locale}.json`,import.meta.url),'utf8'));
        expect(messages.people.import.exclusionReasons[key!],locale+': '+field.id).toBeTruthy();
      }
    }
  });
  it('does not mistake full-only fields or an alternate caption for an exclusion',()=>{
    const ids=personnelImportExclusions('full').map(field=>field.id);
    expect(ids).toContain('profile.personal_details.age');
    expect(ids).toContain('documents.employee_documents.content');
    expect(ids).not.toContain('employment.organisation_assignment.companyname');
    expect(ids).not.toContain('family.family_and_dependents.icorpassport_8');
    const unsupported=PERSONNEL_FIELDS.find(field=>field.id==='profile.personal_details.age')!;
    expect(personnelImportExclusionReasonKey({...unsupported,import:{...unsupported.import,disabledReason:'A new owner restriction needs translation.'}})).toBeUndefined();
  });
  it('guides all three dated-calendar inputs to their authorized editor in the page and workbook, in every locale',()=>{
    const ids=['attendance.dated_holiday_calendar.calendar','attendance.dated_holiday_calendar.startdate','attendance.dated_holiday_calendar.enddate'];
    const fields=personnelImportExclusions('full').filter(field=>field.id.startsWith('attendance.dated_holiday_calendar.'));
    expect(fields.map(field=>field.id)).toEqual(ids);
    for(const field of fields)expect(personnelImportExclusionReasonKey(field),field.id).toBe('datedCalendar');
    for(const locale of ['en','ms','zh','ta','th','vi']){
      const messages=JSON.parse(readFileSync(new URL(`../messages/${locale}.json`,import.meta.url),'utf8'));
      const resolve=(key:string,fallback:string):string=>{
        const value=key.split('.').reduce((node,part)=>node?.[part],messages);
        return typeof value==='string'?value:fallback;
      };
      const reason=messages.people.import.exclusionReasons.datedCalendar;
      expect(reason,locale).toContain(messages.people.detail.tabs.attendance);
      expect(reason,locale).toContain(messages.holidayCalendarAssignments.title);
      const entries=personnelImportExclusionEntries('full',resolve).filter(entry=>ids.includes(entry.id));
      expect(entries.map(entry=>entry.id),locale).toEqual(ids);
      const rows=personnelImportExclusionRows('full',resolve);
      for(const entry of entries){
        expect(entry.tab,locale+': '+entry.id).toBe(messages.people.detail.tabs.attendance);
        expect(entry.reason,locale+': '+entry.id).toBe(reason);
        expect(rows,locale+': '+entry.id).toContainEqual([entry.tab,entry.label,reason]);
      }
    }
  });
});
