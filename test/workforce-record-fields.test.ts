import {describe,expect,it} from 'vitest';
import {WORKFORCE_PROFILE_FIELDS} from '../lib/workforce-record-fields';
import {personnelField} from '../lib/personnel-field-registry';

describe('bounded Workforce profile contract',()=>{
 it('names only real single-person profile fields, excluding private links, finances and byte payloads',()=>{
  expect(WORKFORCE_PROFILE_FIELDS.length).toBeGreaterThan(0);
  expect(new Set(WORKFORCE_PROFILE_FIELDS.map(field=>field.key)).size).toBe(WORKFORCE_PROFILE_FIELDS.length);
  for(const {key,fieldId}of WORKFORCE_PROFILE_FIELDS){
   const field=personnelField(fieldId);
   expect(field).toBeDefined();
   expect(field).toMatchObject({owner:'person',ownerField:key,grain:'single',tab:'Profile'});
   expect(field!.type).not.toBe('file');
   expect(['payroll','bank','statutory','restricted','documents']).not.toContain(field!.sensitivity);
   expect(['personId','designatedPaymasterEmploymentId','maritalStatusSourceRequestId','salary','content','photo']).not.toContain(key);
  }
 });
});
