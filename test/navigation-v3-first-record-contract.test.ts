import {expect,it} from 'vitest';
import {missingToCreate,missingForCreation} from '../lib/employee-draft-schema';
import {navigationV3DraftInput,navigationV3ExistingPersonInputs,assertNavigationV3DraftInputEquality,NAVIGATION_V3_FIRST_NATIVE_REQUIREMENTS} from '../scripts/performance/navigation-v3-first-record-contract';
const companyId='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002';
function sample(){const input=navigationV3DraftInput(42400000000,1,companyId);const created={id,employeeCode:input.employeeCode};const row={id,companyId,currentStep:1,reservedEmployeeCode:input.employeeCode,data:{profile:{fullName:input.fullName,primaryEmail:input.primaryEmail,employeeCode:input.employeeCode,employeeIdMode:input.employeeIdMode},employment:{companyId}}};return{input,created,row};}
it('makes independent fictional draft inputs through the canonical code and creation rules without making another employee',()=>{
 const {input}=sample();expect(input.employeeCode).toBe('NAVD-42400000000-1');expect(input.primaryEmail).toBe('v3-draft-42400000000-1@example.invalid');
 const data={profile:{fullName:input.fullName,primaryEmail:input.primaryEmail,employeeIdMode:input.employeeIdMode,employeeCode:input.employeeCode},employment:{companyId:input.companyId}};
 expect(missingToCreate(data,{employeeIdRule:null})).toEqual([]);expect(missingForCreation(data).length).toBeGreaterThan(0);
 expect(Object.isFrozen(input)).toBe(true);expect(navigationV3DraftInput(42400000000,2,companyId).employeeCode).not.toBe(input.employeeCode);
 for(const args of [[0,1,companyId],[Number.NaN,1,companyId],[1,-1,companyId],[1,500,companyId],[1,1,'not-native-uuid']]as const)expect(()=>navigationV3DraftInput(args[0],args[1],args[2])).toThrow();
});
it('requires exact returned reservation identity, company, input name/mail/code and initial stored step without authorizing the rows',()=>{
 const {input,created,row}=sample();expect(assertNavigationV3DraftInputEquality(input,created,row)).toBeUndefined();
 for(const changed of [{...row,id:companyId},{...row,companyId:id},{...row,currentStep:2},{...row,data:{...row.data,employment:{companyId:id}}},{...row,reservedEmployeeCode:'OTHER'},{...row,data:{...row.data,profile:{...row.data.profile,fullName:'Different actor'}}},{...row,data:{...row.data,profile:{...row.data.profile,primaryEmail:'other@example.invalid'}}},{...row,data:{...row.data,profile:{...row.data.profile,employeeCode:'OTHER'}}}])expect(()=>assertNavigationV3DraftInputEquality(input,created,changed)).toThrow();
 expect(()=>assertNavigationV3DraftInputEquality(input,{...created,employeeCode:'OTHER'},row)).toThrow();
 expect(()=>assertNavigationV3DraftInputEquality(input,{...created,verified:true},row)).toThrow();
 // Complete but forged JSON can satisfy DATA equality; no native handle, returned
 // grant or authenticated verdict exists. Only real native commissioning can bind.
 const cloned=JSON.parse(JSON.stringify({input,created,row}));expect(assertNavigationV3DraftInputEquality(cloned.input,cloned.created,cloned.row)).toBeUndefined();
});
it('retains all500 existing independent name/code input facts without requiring or accepting principal permission claims',()=>{
 for(const index of [0,1,2,4,249,250,251,254,499])expect(navigationV3ExistingPersonInputs(index)).toEqual({actorIndex:index,fullName:'PERF Person '+String(index).padStart(4,'0'),employeeCode:'PERF'+String(index).padStart(4,'0')});
 for(const index of [-1,500,1.5,Number.NaN])expect(()=>navigationV3ExistingPersonInputs(index)).toThrow();
 expect(navigationV3ExistingPersonInputs(4)).not.toHaveProperty('role');expect(navigationV3ExistingPersonInputs(4)).not.toHaveProperty('tenantId');
});
it('keeps every native authority, field/permission and lease gap explicit instead of claiming a fixture probe',()=>{
 expect(NAVIGATION_V3_FIRST_NATIVE_REQUIREMENTS.map(row=>row.family)).toEqual(['personnel-record','self-profile','personnel-draft']);
 expect(NAVIGATION_V3_FIRST_NATIVE_REQUIREMENTS.every(row=>row.missing.length>0&&row.nativeOwners.length>0)).toBe(true);
 expect(NAVIGATION_V3_FIRST_NATIVE_REQUIREMENTS[1].missing.join(' ')).toContain('independent singleton transactions');
 expect(NAVIGATION_V3_FIRST_NATIVE_REQUIREMENTS[2].missing.join(' ')).toContain('manual not permitted');
 expect(Object.isFrozen(NAVIGATION_V3_FIRST_NATIVE_REQUIREMENTS[0].nativeOwners)).toBe(true);
});
