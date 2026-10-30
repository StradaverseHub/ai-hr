import {describe,it,expect} from 'vitest';
import {WorkforceProfileMaintenance as C,workforceProfileSectionValues,PROFILE_SECTIONS} from '../lib/assistant-actions/workforce-profile-maintenance-contract';
import {workforceMaintenanceFields} from '../lib/workforce-maintenance-fields';
import {assistantActionActors} from '../core/assistant-action-catalogue';
const employmentId='11111111-1111-4111-8111-111111111111';
const values=(section:typeof PROFILE_SECTIONS[number])=>Object.fromEntries(workforceMaintenanceFields('person',section).map(({key})=>[key,key==='fullName'?'Human name':null]));
const input={action:C.action,contractVersion:1,employmentId,subjectId:employmentId,section:'personal',expectedVersion:'1042',values:values('personal')};
describe('Finite positive Workforce profile contract',()=>{
 it.each(PROFILE_SECTIONS)('keeps exact %s keys and forbids cross-section or hidden monetary/authority fields',section=>{const human={...input,section,values:values(section)};expect(C.Human.parse(human)).toEqual(human);for(const candidate of [{...human,actor:'hr_admin'},{...human,subjectId:'22222222-2222-4222-8222-222222222222'},{...human,values:{...human.values,salary:'1000'}},{...human,section:'bank'}])expect(C.Human.safeParse(candidate).success).toBe(false);expect(workforceProfileSectionValues(section).safeParse({...human.values,hidden:'x'}).success).toBe(false);});
 it('does not infer positive authority from cached role strings',()=>{expect(assistantActionActors({tenantId:employmentId,userId:employmentId,personId:employmentId,roles:['employee'],grants:[{role:'employee',companyId:null}]})).not.toContain('workforce_maintainer');});
 it('bounds actual serialized Unicode before custody',()=>{expect(C.Human.safeParse({...input,values:{...input.values,preferredName:'漢'.repeat(2000)}}).success).toBe(true);expect(C.Human.safeParse({...input,values:{...input.values,preferredName:'漢'.repeat(4000),firstName:'漢'.repeat(4000)}}).success).toBe(false);});
});
