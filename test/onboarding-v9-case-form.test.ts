import { expect, it } from 'vitest';
import { defaultConfig, blankCase, saveCase, missingCaseFields, type Actor, type Environment } from '../lib/onboarding-model';
import { defaultV9CaseFields } from '../lib/lifecycle-v9-case-form';
function fixture(){const config=defaultConfig('hr');config.v9CaseFields=defaultV9CaseFields('onb');const env:Environment={today:'2026-10-30',now:'2026-10-30T00:00:00Z',id:()=>crypto.randomUUID(),nextNumber:()=>'',leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:['hr']};const actor:Actor={id:'hr',name:'HR',module:true,hr:true,master:true};const c=blankCase('case','OB-FICTIONAL','draft',{fullName:'Fictional employee',joinDate:'2026-11-02',company:'company'},env);return{config,env,actor,c};}
it('locks even an unsupplied Personnel field while retaining a previously stored case value',()=>{const{config,env,actor,c}=fixture();expect(()=>saveCase(config,c,{local:{employeeId:'FORGED'}},actor,env)).toThrow('Personnel Management');c.local.supervisor='retained-manager';expect(()=>saveCase(config,c,{local:{supervisor:'retained-manager'}},actor,env)).not.toThrow();expect(()=>saveCase(config,c,{local:{supervisor:'different-manager'}},actor,env)).toThrow('Personnel Management');});
it('applies visibility and HR-only requirements without granting ordinary editors HR answers',()=>{const{config,env,actor,c}=fixture();config.v9CaseFields!.push({key:'privateNote',label:'Private HR note',type:'text',show:true,required:true,hrOnly:true,rules:{},options:[],help:''});c.hiring='new_hire';expect(missingCaseFields(c,config,true)).toEqual(['privateNote']);expect(missingCaseFields(c,config,false)).toEqual([]);expect(()=>saveCase(config,c,{caseValues:{privateNote:'Unauthorized'}},{...actor,hr:false},env)).toThrow('HR access');});

it.each([['hiring','hireType'],['replacedEmployee','replacing'],['floor','floor'],['notes','notes']])('protects configured HR-only scalar %s from group and module writers',(key,fieldKey)=>{
 const {config,env,actor,c}=fixture();const field=config.v9CaseFields!.find(field=>field.key===fieldKey)!;field.hrOnly=true;
 expect(()=>saveCase(config,c,{[key]:'FORGED'},{...actor,hr:false},env)).toThrow('Company HR access');
 expect((c as unknown as Record<string,unknown>)[key]).not.toBe('FORGED');
});

it('stores a selected active TA as a case-owned UUID while leaving legacy typed names unlinked', async () => {
 const { config, env, actor, c } = fixture();
 const { nativeV9Facts } = await import('../lib/lifecycle-v9-native');
 c.source.gbsTa = 'A typed name, never an account binding';
 expect(nativeV9Facts(c).taUserId).toBeNull();
 expect(() => saveCase(config,c,{local:{taUserId:'not-active'}},actor,env)).toThrow('current active user');
 expect(c.local.taUserId).toBeUndefined();
 saveCase(config,c,{local:{taUserId:'hr'}},actor,env);
 expect(nativeV9Facts(c).taUserId).toBe('hr');
 expect(c.source.gbsTa).toBe('A typed name, never an account binding');
 saveCase(config,c,{local:{taUserId:''}},actor,env);
 expect(nativeV9Facts(c).taUserId).toBeNull();
});
it('requires case editing and configured TA field visibility to change the selected TA', () => {
 const { config, env, actor, c } = fixture();
 expect(() => saveCase(config,c,{local:{taUserId:'hr'}},{...actor,module:false,caseActions:false},env)).toThrow('Case actions');
 config.v9CaseFields!.find(field=>field.key==='ta')!.hrOnly=true;
 expect(() => saveCase(config,c,{local:{taUserId:'hr'}},{...actor,hr:false},env)).toThrow('Company HR access');
 expect(c.local.taUserId).toBeUndefined();
});
it('accepts only a UUID or an explicit clear for a selected TA at the server schema boundary', async () => {
 const { onboardingPatchSchema } = await import('../lib/onboarding-validation');
 expect(onboardingPatchSchema.safeParse({local:{taUserId:'11111111-1111-4111-8111-111111111111'}}).success).toBe(true);
 expect(onboardingPatchSchema.safeParse({local:{taUserId:''}}).success).toBe(true);
 expect(onboardingPatchSchema.safeParse({local:{taUserId:'Some typed name'}}).success).toBe(false);
});

it('hides a configured HR-only TA account and old typed name before serializing a non-HR case', async () => {
 const { config, actor, c }=fixture();const { projectJoinerPage }=await import('../lib/onboarding-page-projection');
 config.v9CaseFields!.find(field=>field.key==='ta')!.hrOnly=true;c.local.taUserId='private-account';c.source.gbsTa='Private legacy name';
 const visible=projectJoinerPage(c,config,{...actor,hr:false});
 expect(visible.local.taUserId).toBeUndefined();expect(visible.source.gbsTa).toBeUndefined();expect(JSON.stringify(visible)).not.toContain('private-account');
});
