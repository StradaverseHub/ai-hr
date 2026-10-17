import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {personnelImportExclusions,personnelImportExclusionReasonKey} from '../lib/personnel-import-exclusions';

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
});
