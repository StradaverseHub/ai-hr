/** @vitest-environment jsdom */
/** Actual IdentityFields DOM: only the passport controls follow native metadata, never IC/wizard. */
import React from 'react';
import {readFileSync} from 'node:fs';
import {cleanup,render} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {IdentityFields,IdentityProvider} from '../components/personnel-identity';
import en from '../messages/en.json';
vi.mock('next-intl',()=>({useTranslations:(namespace?:string)=>Object.assign((key:string)=>namespace?namespace+'.'+key:key,{has:()=>false})}));
afterEach(cleanup);
const props={employmentId:'86000000-0000-4000-8000-000000000001',personId:'86000000-0000-4000-8000-000000000002',icDefault:'900101123456',oldIcNumber:'OLD-IC',passportNumber:'Fictional Passport',passportIssueDate:'2020-01-01',passportExpiryDate:'2030-01-01',passportIssuingCountry:'Malaysia',passportIssuingCountryCode:'MY',passportRemark:'Fictional note',countryOptions:[{value:'Malaysia',label:'Malaysia'}],setIcAction:vi.fn(),setPassportAction:vi.fn()};
function show(extra:Partial<React.ComponentProps<typeof IdentityFields>>={}){return render(<IdentityProvider initialNationality="Malaysian"><IdentityFields {...props} {...extra}/></IdentityProvider>);}
it('disables only passport controls and omits that section from form serialization while leaving IC enabled',()=>{
 const text=en.accessConfiguration.workforceReadOnly,view=show({passportDisabled:true,passportReadOnlyMessage:text}),passport=view.container.querySelector('form[data-save-section="passport"]') as HTMLFormElement,ic=view.container.querySelector('form[data-save-section="ic"]') as HTMLFormElement;
 expect(passport).not.toBeNull();expect(ic).not.toBeNull();expect(passport.querySelector('fieldset')?.disabled).toBe(true);expect(passport.textContent).toContain(text);expect(new FormData(passport).has('passportNumber')).toBe(false);expect(new FormData(passport).has('personId')).toBe(false);expect(new FormData(ic).get('personId')).toBe(props.personId);expect((ic.querySelector('input[name="icNumber"]') as HTMLInputElement).matches(':disabled')).toBe(false);
});
it('keeps default and positively admitted passport controls enabled with exact employment/person nomination',()=>{
 const view=show(),passport=view.container.querySelector('form[data-save-section="passport"]') as HTMLFormElement,fd=new FormData(passport);expect(passport.querySelector('fieldset')?.disabled).toBe(false);expect(fd.get('employmentId')).toBe(props.employmentId);expect(fd.get('personId')).toBe(props.personId);expect(fd.get('passportNumber')).toBe(props.passportNumber);
});
it('binds the real Personnel page and both real action paths to the same native passport gate, without changing wizard fields',()=>{
 const page=readFileSync('app/admin/personnel/[employmentId]/page.tsx','utf8'),actions=readFileSync('app/admin/personnel/[employmentId]/actions.ts','utf8'),country=readFileSync('localization/country-pack.ts','utf8'),identity=readFileSync('components/personnel-identity.tsx','utf8'),shared=readFileSync('components/passport-fields.tsx','utf8');
 expect(page).toContain('countryPack?.statutory.passportEditAccess?.(s,{personId:emp.personId,employmentId:emp.employmentId})');expect(page).toContain('passportDisabled={!canEditPassport}');expect(page).toContain("passportReadOnlyMessage={tAccess('workforceReadOnly')}");const start=actions.indexOf('async function applyPassportSection('),end=actions.indexOf('export async function setPassportAction',start),apply=actions.slice(start,end);expect(apply).toMatch(/employmentId:\s*String\(formData.get\('employmentId'\)\)/);expect(actions).toContain('passport: applyPassportSection');expect(country).toContain('passportEditAccess?');expect(identity).toContain('passportDisabled=false');expect(shared).not.toContain('passportDisabled');
});
