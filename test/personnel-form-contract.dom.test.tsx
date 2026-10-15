import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {PersonContactExtraFields} from '../components/person-name-fields';
import {PersonDetailsFields} from '../components/person-details-fields';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {GENDERS} from '../lib/person-vocabulary';
import {buildTemplateCsv,employeeTemplate} from '../lib/import-template';
import {sectionTemplateColumns} from '../lib/import-sections';
import {personnelColumnLabel,personnelColumnGuidance,personnelFieldChoices,personnelScalarIssue} from '../lib/personnel-import-contract';
import {personnelFormRequired} from '../lib/personnel-form-contract';
import {parsePersonnelCsv} from '../lib/personnel-csv';
const resolve=(key:string,fallback:string)=>{let value:unknown=messages;for(const part of key.split('.'))value=value&&typeof value==='object'?(value as Record<string,unknown>)[part]:undefined;return typeof value==='string'?value:fallback;};
const words={required:'Required',optional:'Optional',reference:'Reference',blankRetains:'Blank retains'};
const contact=()=>render(<NextIntlClientProvider locale="en" messages={messages}><PersonContactExtraFields mode="controlled" value={{}} onChange={()=>{}} /></NextIntlClientProvider>);
afterEach(cleanup);
describe('Actual Personnel widget consumers follow the shared file contract',()=>{
  it('a changed label/type/required-create declaration reaches the real widget, full CSV and section guidance',()=>{
    const field=PERSONNEL_FIELDS.find(field=>field.id==='profile.contact_and_permanent_address.homephone')!;
    const before=structuredClone(field);
    try {
      field.labelKey='people.detail.firstName';field.type='date';field.import.requiredCreate=true;
      contact();
      const input=screen.getByLabelText(new RegExp(`^${messages.people.detail.firstName}`)) as HTMLInputElement;
      expect(input.type).toBe('date');
      expect(input.name).toBe('');expect(input.required).toBe(false); // Partial draft Save remains possible.
      expect(personnelFormRequired(field.id,'draft')).toBe(true); // Activation/advisory rule remains canonical.
      const heading=personnelColumnLabel('home_phone','employee',resolve);
      expect(parsePersonnelCsv(buildTemplateCsv(employeeTemplate,resolve),'employee')[0]).toContain(heading);
      expect(sectionTemplateColumns('profile')).toContain('home_phone');
      expect(personnelColumnGuidance('home_phone','employee','create',words)).toContain('Required');
      expect(personnelColumnGuidance('home_phone','employee','create',words)).toContain('YYYY-MM-DD');
      expect(personnelScalarIssue(field,'invalid-day')).toBe('date');
    } finally {Object.assign(field,before);}
  });
  it('a changed canonical allowed-value list reaches real select options and import refusal together',()=>{
    const values=GENDERS as unknown as string[];const before=[...values];
    const field=PERSONNEL_FIELDS.find(field=>field.id==='profile.personal_details.gender')!;
    try {
      values.splice(values.indexOf('female'),1);
      render(<NextIntlClientProvider locale="en" messages={messages}><PersonDetailsFields mode="form" gender="male" maritalStatus="" /></NextIntlClientProvider>);
      const select=screen.getByLabelText(messages.people.detail.gender) as HTMLSelectElement;
      expect([...select.options].map(option=>option.value)).not.toContain('female');
      expect(personnelFieldChoices(field).map(option=>option.value)).not.toContain('female');
      expect(personnelScalarIssue(field,'female')).toBe('choice');
    } finally {values.splice(0,values.length,...before);}
  });
});
